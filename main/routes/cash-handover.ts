/**
 * BackStreet cash management: dual-currency Cash Counter counts, blind
 * closing with role-based reveal, busy-time handover ("count out the float,
 * take the rest, finish the count on the phone"), incoming independent float
 * count, append-only reconciliation notes, envelope evidence and purchase
 * receipt photos.
 *
 * Builds on cash-sessions.ts (one selling session at a time) and
 * cash-closures.ts (expected-cash math). Legacy USD-equivalent columns on
 * cash_sessions / cash_closures keep being written so day close, Z reports
 * and existing reports are unchanged.
 *
 * Amounts: USD integer cents, KHR integer riel. Combined USD equivalent is a
 * reporting value only.
 */
import { Router, Request, Response } from 'express';
import { app } from 'electron';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDatabase, getSettingValue, now, withTxn } from '../db';
import { requirePermission, hasPermission } from '../services/authorization';
import { notifyTelegram } from '../services/telegram';
import { getOpenSession, type CashSessionRow } from '../services/shift-session-gate';
import { closeSessionTxn, openSessionTxn } from './cash-sessions';
import { listCashDrawerMovementsForSession, sessionExpectedCash } from './cash-closures';
import {
  normalizeCashCount, combinedUsdCents, CashCountError, type CashCountTotals,
} from '../../shared/cash-counter';

type Db = ReturnType<typeof getDatabase>;

interface AuthedRequest extends Request { user?: { userId: string; role: string } }

interface SessionRow extends CashSessionRow {
  handover_state: 'pending_count' | 'counted' | null;
  cutoff_at: string | null;
  opening_count_id: number | null;
  opening_khr_riel: number;
  review_required: number;
}

interface CountRow {
  id: number; session_id: number; kind: string; method: string;
  usd_cents: number; khr_riel: number; rate_khr_per_usd: number; combined_usd_cents: number;
  denominations_json: string | null; counted_by: string; created_at: string;
}

interface ReconciliationRow {
  id: number; session_id: number; cutoff_at: string; rate_khr_per_usd: number;
  expected_usd_cents: number; expected_khr_riel: number; expected_combined_usd_cents: number;
  untracked_cash_lines: number;
  actual_usd_cents: number | null; actual_khr_riel: number | null;
  variance_usd_cents: number | null; variance_khr_riel: number | null; variance_combined_usd_cents: number | null;
  float_retained_usd_cents: number | null; float_retained_khr_riel: number | null;
  envelope_usd_cents: number | null; envelope_khr_riel: number | null;
  other_removals_json: string; status: string;
  submitted_by: string | null; submitted_at: string | null; resolved_by: string | null; resolved_at: string | null;
  closure_id: number | null; created_at: string;
}

interface HandoverRow {
  id: number; from_session_id: number; to_session_id: number | null; mode: string; cutoff_at: string;
  declared_count_id: number | null; verified_count_id: number | null;
  diff_usd_cents: number | null; diff_khr_riel: number | null; status: string;
  initiated_by: string; accepted_by: string | null; accepted_at: string | null; comment: string | null; created_at: string;
}

const router = Router();

/* ── small helpers ────────────────────────────────────────────────────── */

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

function sendError(res: Response, error: unknown, fallback: string): void {
  const statusCode = error instanceof CashCountError ? 400
    : (typeof error === 'object' && error && 'statusCode' in error && typeof (error as { statusCode: unknown }).statusCode === 'number')
      ? (error as { statusCode: number }).statusCode : 500;
  const message = statusCode >= 500 ? fallback : (error instanceof Error ? error.message : fallback);
  if (statusCode >= 500) console.error(`[cash-handover] ${fallback}:`, error);
  res.status(statusCode).json({ error: message });
}

function actor(req: AuthedRequest): { id: string; role: string } {
  const id = String(req.user?.userId || '');
  if (!id) throw httpError('Authentication required', 401);
  return { id, role: String(req.user?.role || '') };
}

function canResolve(userId: string): boolean {
  return hasPermission(userId, 'cash.reconciliation.resolve');
}

function intSetting(key: string, fallback: number): number {
  const parsed = parseInt(getSettingValue(key) ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function exchangeRate(): number {
  return intSetting('usd_khr_exchange_rate', 4100);
}

function parseId(raw: unknown, label: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw httpError(`Invalid ${label}`, 400);
  return id;
}

function optionalText(raw: unknown, max = 1000): string | null {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') throw httpError('Text fields must be strings', 400);
  const trimmed = raw.trim();
  if (trimmed.length > max) throw httpError(`Text must be at most ${max} characters`, 400);
  return trimmed || null;
}

function loadSession(db: Db, id: number): SessionRow {
  const row = db.prepare(`SELECT * FROM cash_sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  if (!row) throw httpError('Shift not found', 404);
  return row;
}

function loadCount(db: Db, id: number | null): CountRow | null {
  if (!id) return null;
  return (db.prepare(`SELECT * FROM cash_counts WHERE id = ?`).get(id) as CountRow | undefined) ?? null;
}

export function insertCount(db: Db, sessionId: number, kind: string, totals: CashCountTotals, userId: string, device: string | null): number {
  const result = db.prepare(`
    INSERT INTO cash_counts (session_id, kind, method, usd_cents, khr_riel, rate_khr_per_usd, combined_usd_cents,
      denominations_json, counted_by, device, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, kind, totals.method, totals.usd_cents, totals.khr_riel, totals.rate_khr_per_usd,
    totals.combined_usd_cents, totals.denominations ? JSON.stringify(totals.denominations) : null,
    userId, device, now());
  return Number(result.lastInsertRowid);
}

function deviceOf(req: Request): string | null {
  const raw = (req.body || {}).device;
  return raw === 'phone' || raw === 'pos' || raw === 'desktop' ? raw : null;
}

/* ── expected cash per currency ───────────────────────────────────────── */

export interface ExpectedByCurrency {
  expected_usd_cents: number;
  expected_khr_riel: number;
  expected_combined_usd_cents: number;
  /** Cash payment lines without a USD/KHR split (taken before this feature); counted as USD. */
  untracked_cash_lines: number;
  /** Legacy single-currency expectation from cash-closures.ts, for cross-checking. */
  legacy_expected_cents: number;
}

/**
 * Per-currency expected drawer cash for a session up to `end`.
 * USD: opening USD + Σ(cash USD received − USD change given) + untracked cash lines
 *      + pay-ins − pay-outs − safe drops − cash refunds.
 * KHR: opening KHR + Σ(KHR received − KHR change given) + KHR movements.
 * Card, ABA, Acleda and other non-cash methods never touch the drawer.
 */
export function expectedByCurrency(db: Db, session: SessionRow, end: string): ExpectedByCurrency {
  const rate = exchangeRate();
  const start = session.opened_at;
  const lines = db.prepare(`
    WITH payment_lines AS (
      SELECT
        je.value AS line,
        COALESCE(NULLIF(json_extract(je.value, '$.method'), ''), '') AS method,
        CAST(json_extract(je.value, '$.payment_method_id') AS INTEGER) AS payment_method_id,
        CAST(json_extract(je.value, '$.cash_session_id') AS INTEGER) AS line_session,
        COALESCE(
          datetime(NULLIF(json_extract(je.value, '$.timestamp'), '')),
          datetime(NULLIF(b.paid_at, '')),
          datetime(NULLIF(b.created_at, ''))
        ) AS line_time
      FROM bills b
      JOIN json_each(
        CASE
          WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array' THEN b.payment_details
          WHEN json_valid(b.payment_details) THEN json_array(b.payment_details)
          ELSE '[]'
        END
      ) je
      WHERE json_type(je.value) = 'object'
    )
    SELECT
      CAST(json_extract(pl.line, '$.amount') AS REAL) AS amount,
      json_extract(pl.line, '$.cash_usd_in') AS usd_in,
      json_extract(pl.line, '$.cash_khr_in') AS khr_in,
      json_extract(pl.line, '$.change_usd_out') AS usd_out,
      json_extract(pl.line, '$.change_khr_out') AS khr_out
    FROM payment_lines pl
    LEFT JOIN payment_methods pm ON pm.id = pl.payment_method_id AND lower(pm.name) = 'cash'
    WHERE (
        pl.line_session = ?
        OR (pl.line_session IS NULL AND pl.line_time >= datetime(?) AND pl.line_time < datetime(?))
      )
      AND (lower(pl.method) = 'cash' OR pm.id IS NOT NULL)
  `).all(session.id, start, end) as { amount: number; usd_in: unknown; khr_in: unknown; usd_out: unknown; khr_out: unknown }[];

  let usd = 0;
  let khr = 0;
  let untracked = 0;
  for (const line of lines) {
    const hasSplit = line.usd_in != null || line.khr_in != null;
    if (!hasSplit) {
      untracked += 1;
      usd += Math.round(Number(line.amount || 0) * 100);
      continue;
    }
    usd += Math.round(Number(line.usd_in || 0) * 100) - Math.round(Number(line.usd_out || 0) * 100);
    khr += Math.round(Number(line.khr_in || 0)) - Math.round(Number(line.khr_out || 0));
  }

  const movements = listCashDrawerMovementsForSession(db, session.id, start, end, false) as Array<{
    movement_type: string; amount_cents: number; amount_khr_riel?: number;
  }>;
  for (const movement of movements) {
    if (movement.movement_type === 'opening_float') continue;
    const sign = movement.movement_type === 'pay_in' ? 1 : -1;
    usd += sign * Number(movement.amount_cents || 0);
    khr += sign * Number(movement.amount_khr_riel || 0);
  }

  const refunds = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS c FROM refunds
    WHERE lower(method) = 'cash'
      AND (cash_session_id = ? OR (cash_session_id IS NULL AND created_at >= ? AND created_at < ?))
  `).get(session.id, start, end) as { c: number };
  usd -= Number(refunds.c || 0);

  const opening = loadCount(db, session.opening_count_id);
  const openingUsd = opening ? opening.usd_cents : Number(session.opening_float_cents || 0);
  const openingKhr = opening ? opening.khr_riel : Number(session.opening_khr_riel || 0);
  usd += openingUsd;
  khr += openingKhr;

  return {
    expected_usd_cents: usd,
    expected_khr_riel: khr,
    expected_combined_usd_cents: combinedUsdCents(usd, khr, rate),
    untracked_cash_lines: untracked,
    legacy_expected_cents: sessionExpectedCash(db, session, end),
  };
}

/* ── shaping responses (blind-count reveal rules) ─────────────────────── */

function shapeReconciliation(rec: ReconciliationRow | undefined, viewerCanResolve: boolean) {
  if (!rec) return null;
  const counted = rec.actual_usd_cents != null;
  const reveal = counted || viewerCanResolve;
  return {
    id: rec.id,
    session_id: rec.session_id,
    status: rec.status,
    cutoff_at: rec.cutoff_at,
    rate_khr_per_usd: rec.rate_khr_per_usd,
    counted,
    expected: reveal ? {
      usd_cents: rec.expected_usd_cents,
      khr_riel: rec.expected_khr_riel,
      combined_usd_cents: rec.expected_combined_usd_cents,
      untracked_cash_lines: rec.untracked_cash_lines,
    } : null,
    actual: counted ? { usd_cents: rec.actual_usd_cents, khr_riel: rec.actual_khr_riel } : null,
    variance: counted ? {
      usd_cents: rec.variance_usd_cents, khr_riel: rec.variance_khr_riel, combined_usd_cents: rec.variance_combined_usd_cents,
    } : null,
    float_retained: rec.float_retained_usd_cents != null
      ? { usd_cents: rec.float_retained_usd_cents, khr_riel: rec.float_retained_khr_riel } : null,
    envelope: rec.envelope_usd_cents != null ? { usd_cents: rec.envelope_usd_cents, khr_riel: rec.envelope_khr_riel } : null,
    other_removals: JSON.parse(rec.other_removals_json || '[]'),
    submitted_by: rec.submitted_by,
    submitted_at: rec.submitted_at,
    resolved_by: rec.resolved_by,
    resolved_at: rec.resolved_at,
  };
}

function notesFor(db: Db, reconciliationId: number) {
  return db.prepare(`
    SELECT n.id, n.kind, n.body, n.author_id, u.name AS author_name, n.author_role, n.created_at
    FROM cash_reconciliation_notes n LEFT JOIN users u ON u.id = n.author_id
    WHERE n.reconciliation_id = ? ORDER BY n.id
  `).all(reconciliationId);
}

function standardFloat() {
  return {
    usd_cents: Math.max(0, intSetting('cash_standard_float_usd_cents', 10000)),
    khr_riel: Math.max(0, intSetting('cash_standard_float_khr_riel', 0)),
  };
}

/* ── reconciliation core ──────────────────────────────────────────────── */

function createReconciliation(db: Db, session: SessionRow, cutoff: string): ReconciliationRow {
  const existing = db.prepare(`SELECT * FROM cash_reconciliations WHERE session_id = ?`).get(session.id) as ReconciliationRow | undefined;
  if (existing) return existing;
  const expected = expectedByCurrency(db, session, cutoff);
  db.prepare(`
    INSERT INTO cash_reconciliations (session_id, cutoff_at, rate_khr_per_usd, expected_usd_cents, expected_khr_riel,
      expected_combined_usd_cents, untracked_cash_lines, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_count', ?)
  `).run(session.id, cutoff, exchangeRate(), expected.expected_usd_cents, expected.expected_khr_riel,
    expected.expected_combined_usd_cents, expected.untracked_cash_lines, now());
  return db.prepare(`SELECT * FROM cash_reconciliations WHERE session_id = ?`).get(session.id) as ReconciliationRow;
}

/**
 * Records the actual drawer cash for a reconciliation and writes the legacy
 * cash_closures row (USD equivalent) for the cutoff window.
 */
function completeReconciliation(
  db: Db,
  session: SessionRow,
  rec: ReconciliationRow,
  actual: { usd_cents: number; khr_riel: number },
  split: { float_usd: number; float_khr: number; envelope_usd: number; envelope_khr: number },
  actorId: string,
  actorCanResolve: boolean,
  alreadyClosed: boolean,
): ReconciliationRow {
  const varianceUsd = actual.usd_cents - rec.expected_usd_cents;
  const varianceKhr = actual.khr_riel - rec.expected_khr_riel;
  const varianceCombined = combinedUsdCents(actual.usd_cents, actual.khr_riel, rec.rate_khr_per_usd)
    - rec.expected_combined_usd_cents;
  // Currencies are reconciled separately: a USD surplus never hides a KHR shortage.
  const balanced = varianceUsd === 0 && varianceKhr === 0;
  const status = balanced ? 'balanced' : 'pending_review';
  const actualCombined = combinedUsdCents(actual.usd_cents, actual.khr_riel, rec.rate_khr_per_usd);
  const closure = closeSessionTxn(db, session, actualCombined, actorId,
    balanced ? null : 'Cash variance — see reconciliation', true,
    { periodEnd: rec.cutoff_at, alreadyClosed });
  db.prepare(`
    UPDATE cash_reconciliations SET actual_usd_cents = ?, actual_khr_riel = ?, variance_usd_cents = ?, variance_khr_riel = ?,
      variance_combined_usd_cents = ?, float_retained_usd_cents = ?, float_retained_khr_riel = ?,
      envelope_usd_cents = ?, envelope_khr_riel = ?, status = ?, submitted_by = ?, submitted_at = ?, closure_id = ?
    WHERE id = ?
  `).run(actual.usd_cents, actual.khr_riel, varianceUsd, varianceKhr, varianceCombined,
    split.float_usd, split.float_khr, split.envelope_usd, split.envelope_khr, status, actorId, now(), closure.closure_id, rec.id);
  db.prepare(`UPDATE cash_sessions SET review_required = ? WHERE id = ?`).run(balanced ? 0 : 1, session.id);
  void actorCanResolve; // resolution happens through notes (manager acknowledgement), never implicitly
  return db.prepare(`SELECT * FROM cash_reconciliations WHERE id = ?`).get(rec.id) as ReconciliationRow;
}

function parseAmountPair(raw: unknown, label: string): { usd_cents: number; khr_riel: number } {
  if (raw == null) return { usd_cents: 0, khr_riel: 0 };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw httpError(`${label} must be an object`, 400);
  const usd = (raw as Record<string, unknown>).usd_cents ?? 0;
  const khr = (raw as Record<string, unknown>).khr_riel ?? 0;
  if (typeof usd !== 'number' || !Number.isSafeInteger(usd) || usd < 0) throw httpError(`${label}.usd_cents must be whole cents >= 0`, 400);
  if (typeof khr !== 'number' || !Number.isSafeInteger(khr) || khr < 0) throw httpError(`${label}.khr_riel must be whole riel >= 0`, 400);
  return { usd_cents: usd, khr_riel: khr };
}

/* ── ticket handover snapshot ─────────────────────────────────────────── */

function openTickets(db: Db) {
  return db.prepare(`
    SELECT o.id AS order_id, o.order_number, COALESCE(t.number, o.tab_name) AS table_label, o.total, o.status AS order_status,
      o.user_id AS original_user_id, u.name AS original_user_name,
      COALESCE(b.balance, o.total) AS balance, COALESCE(b.paid_amount, 0) AS paid_amount
    FROM orders o
    LEFT JOIN bills b ON b.order_id = o.id
    LEFT JOIN tables t ON t.id = o.table_id
    LEFT JOIN users u ON u.id = o.user_id
    WHERE o.status NOT IN ('completed', 'cancelled')
      AND (b.id IS NULL OR b.payment_status NOT IN ('paid', 'refunded', 'partially_refunded'))
    ORDER BY o.created_at
  `).all() as Array<Record<string, unknown>>;
}

function snapshotTickets(db: Db, sessionId: number, cashHandoverId: number | null, userId: string): number | null {
  const tickets = openTickets(db);
  const at = now();
  const header = db.prepare(`
    INSERT INTO ticket_handovers (cash_handover_id, from_session_id, initiated_by, initiated_at, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(cashHandoverId, sessionId, userId, at);
  const id = Number(header.lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO ticket_handover_items (ticket_handover_id, order_id, order_number, table_label, total, balance, order_status, original_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const t of tickets) {
    insert.run(id, t.order_id, t.order_number, t.table_label ?? null, Number(t.total || 0), Number(t.balance || 0),
      t.order_status ?? null, t.original_user_id ?? null);
  }
  db.prepare(`UPDATE cash_sessions SET tickets_transferred_at = ? WHERE id = ?`).run(at, sessionId);
  return id;
}

/* ── routes ───────────────────────────────────────────────────────────── */

/** Everything a Cash screen needs, without leaking expected cash before a blind count. */
router.get('/status', requirePermission('cash.shifts.view'), (req: AuthedRequest, res: Response) => {
  try {
    const db = getDatabase();
    const me = actor(req);
    const open = getOpenSession(db) as SessionRow | undefined;
    const pendingCounts = db.prepare(`
      SELECT s.id, s.opened_by, s.opened_by_name, s.opened_at, s.cutoff_at
      FROM cash_sessions s WHERE s.handover_state = 'pending_count' ORDER BY s.cutoff_at
    `).all();
    const awaitingIncoming = db.prepare(`
      SELECT h.id, h.from_session_id, h.cutoff_at, s.opened_by_name AS from_cashier
      FROM cash_handovers h JOIN cash_sessions s ON s.id = h.from_session_id
      WHERE h.status = 'awaiting_incoming' ORDER BY h.id
    `).all() as { id: number }[];
    const ticketsFor = db.prepare(`
      SELECT i.order_id, i.order_number, i.table_label, i.total, i.balance
      FROM ticket_handover_items i JOIN ticket_handovers th ON th.id = i.ticket_handover_id
      WHERE th.cash_handover_id = ? ORDER BY i.order_number
    `);
    const awaitingWithTickets = awaitingIncoming.map((h) => ({ ...h, tickets: ticketsFor.all(h.id) }));
    res.json({
      rate_khr_per_usd: exchangeRate(),
      standard_float: standardFloat(),
      pending_count_alert_hours: intSetting('cash_pending_count_alert_hours', 4),
      can_resolve: canResolve(me.id),
      open_session: open ? {
        id: open.id, opened_by: open.opened_by, opened_by_name: open.opened_by_name, opened_at: open.opened_at,
        is_mine: open.opened_by === me.id,
      } : null,
      pending_counts: pendingCounts,
      awaiting_incoming: awaitingWithTickets,
    });
  } catch (error) { sendError(res, error, 'Failed to read cash status'); }
});

/** Open a shift with a Cash Counter count (USD + KHR). */
router.post('/open', requirePermission('cash.shifts.open'), (req: AuthedRequest, res: Response) => {
  try {
    const db = getDatabase();
    const me = actor(req);
    const totals = normalizeCashCount((req.body || {}).count, exchangeRate());
    const session = withTxn(() => {
      const opened = openSessionTxn(db, me.id, totals.combined_usd_cents) as SessionRow;
      const countId = insertCount(db, opened.id, 'opening', totals, me.id, deviceOf(req));
      db.prepare(`UPDATE cash_sessions SET opening_count_id = ?, opening_khr_riel = ? WHERE id = ?`)
        .run(countId, totals.khr_riel, opened.id);
      return loadSession(db, opened.id);
    });
    res.json({ session, count: totals });
    notifyTelegram('shift_open', { sessionId: session.id });
  } catch (error) { sendError(res, error, 'Failed to open shift'); }
});

/**
 * Normal (quiet-time) close, step 1: blind count of the whole drawer. Stops
 * selling at this moment, then reveals expected vs actual per the viewer's role.
 */
router.post('/sessions/:id/closing-count', requirePermission('cash.shifts.close'), (req: AuthedRequest, res: Response) => {
  try {
    const db = getDatabase();
    const me = actor(req);
    const sessionId = parseId(req.params.id, 'session id');
    const totals = normalizeCashCount((req.body || {}).count, exchangeRate());
    const floatRetained = parseAmountPair((req.body || {}).float_retained, 'float_retained');
    const explanation = optionalText((req.body || {}).explanation);
    const result = withTxn(() => {
      const session = loadSession(db, sessionId);
      if (session.status !== 'open') throw httpError('Shift is already closed', 409);
      if (me.role === 'cashier' && session.opened_by !== me.id) throw httpError('Cashiers can only close their own shift', 403);
      if (floatRetained.usd_cents > totals.usd_cents || floatRetained.khr_riel > totals.khr_riel) {
        throw httpError('Float retained cannot be more than the cash counted', 400);
      }
      // Existing guard: a normal close needs every bill settled or handed over (busy handover path).
      const unpaid = db.prepare(`
        SELECT COUNT(*) AS c FROM bills b JOIN orders o ON o.id = b.order_id
        WHERE b.payment_status NOT IN ('paid', 'refunded', 'partially_refunded') AND o.status != 'cancelled'
          AND COALESCE(b.balance, b.total, 0) > 0 AND b.created_at >= ?
      `).get(session.opened_at) as { c: number };
      if (Number(unpaid.c) > 0) {
        throw httpError(`Cannot close: ${unpaid.c} unpaid bill(s). Use "Hand over now" to pass open tickets to the next cashier.`, 409);
      }
      const cutoff = now();
      insertCount(db, session.id, 'closing', totals, me.id, deviceOf(req));
      const rec = createReconciliation(db, session, cutoff);
      const done = completeReconciliation(db, session, rec, { usd_cents: totals.usd_cents, khr_riel: totals.khr_riel }, {
        float_usd: floatRetained.usd_cents, float_khr: floatRetained.khr_riel,
        envelope_usd: totals.usd_cents - floatRetained.usd_cents, envelope_khr: totals.khr_riel - floatRetained.khr_riel,
      }, me.id, canResolve(me.id), false);
      if (explanation) {
        db.prepare(`INSERT INTO cash_reconciliation_notes (reconciliation_id, kind, body, author_id, author_role, created_at) VALUES (?, 'cashier_explanation', ?, ?, ?, ?)`)
          .run(done.id, explanation, me.id, me.role, now());
      }
      return done;
    });
    res.json({ reconciliation: shapeReconciliation(result, true), notes: notesFor(db, result.id), needs_explanation: result.status === 'pending_review' && !explanation });
    notifyTelegram('shift_close', { sessionId });
  } catch (error) { sendError(res, error, 'Failed to submit closing count'); }
});

/**
 * Busy-time handover: freeze the shift now, count out the float left in the
 * drawer, take the rest; the takings are counted later from a phone.
 */
router.post('/sessions/:id/handover-now', requirePermission('cash.shifts.close'), (req: AuthedRequest, res: Response) => {
  try {
    const db = getDatabase();
    const me = actor(req);
    const sessionId = parseId(req.params.id, 'session id');
    const declared = normalizeCashCount((req.body || {}).float_left, exchangeRate());
    const result = withTxn(() => {
      const session = loadSession(db, sessionId);
      if (session.status !== 'open') throw httpError('Shift is already closed', 409);
      if (me.role === 'cashier' && session.opened_by !== me.id) throw httpError('Cashiers can only hand over their own shift', 403);
      const cutoff = now();
      const declaredId = insertCount(db, session.id, 'handover_float_declared', declared, me.id, deviceOf(req));
      createReconciliation(db, session, cutoff);
      db.prepare(`
        UPDATE cash_sessions SET status = 'closed', closed_at = ?, closed_by = ?, handover_state = 'pending_count', cutoff_at = ?
        WHERE id = ?
      `).run(cutoff, me.id, cutoff, session.id);
      const handover = db.prepare(`
        INSERT INTO cash_handovers (from_session_id, mode, cutoff_at, declared_count_id, status, initiated_by, created_at)
        VALUES (?, 'busy', ?, ?, 'awaiting_incoming', ?, ?)
      `).run(session.id, cutoff, declaredId, me.id, cutoff);
      const handoverId = Number(handover.lastInsertRowid);
      const ticketHandoverId = snapshotTickets(db, session.id, handoverId, me.id);
      return { handover_id: handoverId, ticket_handover_id: ticketHandoverId, cutoff_at: cutoff };
    });
    res.json(result);
  } catch (error) { sendError(res, error, 'Failed to hand over'); }
});

/**
 * Incoming cashier: independent count of the float in the drawer. Their count
 * becomes their opening float; the declared figure is only revealed after.
 */
router.post('/handovers/:id/receive', requirePermission('cash.shifts.open'), (req: AuthedRequest, res: Response) => {
  try {
    const db = getDatabase();
    const me = actor(req);
    const handoverId = parseId(req.params.id, 'handover id');
    const totals = normalizeCashCount((req.body || {}).count, exchangeRate());
    const comment = optionalText((req.body || {}).comment);
    const disputes = Array.isArray((req.body || {}).disputed_orders) ? (req.body.disputed_orders as unknown[]) : [];
    const result = withTxn(() => {
      const handover = db.prepare(`SELECT * FROM cash_handovers WHERE id = ?`).get(handoverId) as HandoverRow | undefined;
      if (!handover) throw httpError('Handover not found', 404);
      if (handover.status !== 'awaiting_incoming') throw httpError('This handover was already received', 409);
      const opened = openSessionTxn(db, me.id, totals.combined_usd_cents) as SessionRow;
      const openingId = insertCount(db, opened.id, 'opening', totals, me.id, deviceOf(req));
      const verifiedId = insertCount(db, handover.from_session_id, 'handover_float_verified', totals, me.id, deviceOf(req));
      db.prepare(`UPDATE cash_sessions SET opening_count_id = ?, opening_khr_riel = ? WHERE id = ?`).run(openingId, totals.khr_riel, opened.id);
      const declared = loadCount(db, handover.declared_count_id);
      const diffUsd = totals.usd_cents - (declared?.usd_cents ?? 0);
      const diffKhr = totals.khr_riel - (declared?.khr_riel ?? 0);
      const status = diffUsd === 0 && diffKhr === 0 ? 'clean' : 'flagged';
      db.prepare(`
        UPDATE cash_handovers SET to_session_id = ?, verified_count_id = ?, diff_usd_cents = ?, diff_khr_riel = ?, status = ?,
          accepted_by = ?, accepted_at = ?, comment = ? WHERE id = ?
      `).run(opened.id, verifiedId, diffUsd, diffKhr, status, me.id, now(), comment, handoverId);
      // Ticket responsibility moves to the incoming cashier; orders themselves are untouched.
      const ticketHandover = db.prepare(`SELECT id FROM ticket_handovers WHERE cash_handover_id = ?`).get(handoverId) as { id: number } | undefined;
      if (ticketHandover) {
        const disputeStmt = db.prepare(`UPDATE ticket_handover_items SET item_status = 'disputed', dispute_reason = ? WHERE ticket_handover_id = ? AND order_id = ?`);
        let disputed = 0;
        for (const d of disputes) {
          const orderId = Number((d as { order_id?: unknown })?.order_id);
          const reason = optionalText((d as { reason?: unknown })?.reason, 300) ?? 'Disputed at handover';
          if (Number.isSafeInteger(orderId)) disputed += disputeStmt.run(reason, ticketHandover.id, orderId).changes;
        }
        db.prepare(`UPDATE ticket_handover_items SET item_status = 'accepted' WHERE ticket_handover_id = ? AND item_status = 'pending'`).run(ticketHandover.id);
        db.prepare(`UPDATE ticket_handovers SET status = ?, accepted_by = ?, accepted_at = ? WHERE id = ?`)
          .run(disputed > 0 ? 'disputed' : 'accepted', me.id, now(), ticketHandover.id);
      }
      return {
        session: loadSession(db, opened.id),
        handover: { id: handoverId, status, declared: declared ? { usd_cents: declared.usd_cents, khr_riel: declared.khr_riel } : null,
          counted: { usd_cents: totals.usd_cents, khr_riel: totals.khr_riel }, diff: { usd_cents: diffUsd, khr_riel: diffKhr } },
      };
    });
    res.json(result);
    notifyTelegram('shift_open', { sessionId: result.session.id });
  } catch (error) { sendError(res, error, 'Failed to receive drawer'); }
});

/**
 * Outgoing cashier (usually on the phone): blind count of the takings bag
 * after a busy handover. Actual = verified float left + takings.
 */
router.post('/sessions/:id/takings-count', requirePermission('cash.shifts.close'), (req: AuthedRequest, res: Response) => {
  try {
    const db = getDatabase();
    const me = actor(req);
    const sessionId = parseId(req.params.id, 'session id');
    const totals = normalizeCashCount((req.body || {}).count, exchangeRate());
    const explanation = optionalText((req.body || {}).explanation);
    const result = withTxn(() => {
      const session = loadSession(db, sessionId);
      if (session.handover_state !== 'pending_count') throw httpError('This shift is not waiting for a takings count', 409);
      if (session.opened_by !== me.id && !canResolve(me.id)) throw httpError('Only the outgoing cashier or a manager can count these takings', 403);
      const handover = db.prepare(`SELECT * FROM cash_handovers WHERE from_session_id = ?`).get(session.id) as HandoverRow | undefined;
      if (!handover) throw httpError('Handover record missing', 500);
      insertCount(db, session.id, 'handover_takings', totals, me.id, deviceOf(req));
      // Float left: the incoming cashier's verified count when available, else the declared amount (flagged).
      const verified = loadCount(db, handover.verified_count_id);
      const declared = loadCount(db, handover.declared_count_id);
      const floatLeft = verified ?? declared;
      const rec = db.prepare(`SELECT * FROM cash_reconciliations WHERE session_id = ?`).get(session.id) as ReconciliationRow;
      const done = completeReconciliation(db, session, rec, {
        usd_cents: (floatLeft?.usd_cents ?? 0) + totals.usd_cents,
        khr_riel: (floatLeft?.khr_riel ?? 0) + totals.khr_riel,
      }, {
        float_usd: floatLeft?.usd_cents ?? 0, float_khr: floatLeft?.khr_riel ?? 0,
        envelope_usd: totals.usd_cents, envelope_khr: totals.khr_riel,
      }, me.id, canResolve(me.id), true);
      if (!verified) {
        db.prepare(`UPDATE cash_reconciliations SET status = 'pending_review' WHERE id = ?`).run(done.id);
        db.prepare(`INSERT INTO cash_reconciliation_notes (reconciliation_id, kind, body, author_id, author_role, created_at) VALUES (?, 'correction', ?, ?, 'system', ?)`)
          .run(done.id, 'Float left not yet verified by the incoming cashier; declared float used.', me.id, now());
      }
      if (explanation) {
        db.prepare(`INSERT INTO cash_reconciliation_notes (reconciliation_id, kind, body, author_id, author_role, created_at) VALUES (?, 'cashier_explanation', ?, ?, ?, ?)`)
          .run(done.id, explanation, me.id, me.role, now());
      }
      db.prepare(`UPDATE cash_sessions SET handover_state = 'counted' WHERE id = ?`).run(session.id);
      return db.prepare(`SELECT * FROM cash_reconciliations WHERE id = ?`).get(done.id) as ReconciliationRow;
    });
    res.json({ reconciliation: shapeReconciliation(result, true), notes: notesFor(db, result.id), needs_explanation: result.status === 'pending_review' && !explanation });
    notifyTelegram('shift_close', { sessionId });
  } catch (error) { sendError(res, error, 'Failed to submit takings count'); }
});

/** Reconciliation for a session, with reveal rules applied. */
router.get('/sessions/:id/reconciliation', requirePermission('cash.shifts.view'), (req: AuthedRequest, res: Response) => {
  try {
    const db = getDatabase();
    const me = actor(req);
    const sessionId = parseId(req.params.id, 'session id');
    const session = loadSession(db, sessionId);
    const mayView = session.opened_by === me.id || canResolve(me.id) || hasPermission(me.id, 'cash.history.view');
    if (!mayView) throw httpError('Not allowed to view this shift', 403);
    const rec = db.prepare(`SELECT * FROM cash_reconciliations WHERE session_id = ?`).get(sessionId) as ReconciliationRow | undefined;
    const handover = db.prepare(`SELECT * FROM cash_handovers WHERE from_session_id = ?`).get(sessionId) as HandoverRow | undefined;
    const envelopes = db.prepare(`SELECT id, usd_cents, khr_riel, media_id, created_by, created_at FROM cash_envelopes WHERE session_id = ? ORDER BY id`).all(sessionId);
    res.json({
      session: { id: session.id, opened_by_name: session.opened_by_name, opened_at: session.opened_at, cutoff_at: session.cutoff_at,
        handover_state: session.handover_state, status: session.status },
      reconciliation: shapeReconciliation(rec, canResolve(me.id)),
      notes: rec ? notesFor(db, rec.id) : [],
      handover: handover ? { id: handover.id, status: handover.status, diff_usd_cents: handover.diff_usd_cents, diff_khr_riel: handover.diff_khr_riel } : null,
      envelopes,
      envelope_photo_missing: envelopes.every((e) => !(e as { media_id: number | null }).media_id),
    });
  } catch (error) { sendError(res, error, 'Failed to read reconciliation'); }
});

/**
 * Append-only notes. A manager_acknowledgement from a user holding
 * cash.reconciliation.resolve resolves the discrepancy (no second PIN).
 */
router.post('/reconciliations/:id/notes', requirePermission('cash.shifts.view'), (req: AuthedRequest, res: Response) => {
  try {
    const db = getDatabase();
    const me = actor(req);
    const recId = parseId(req.params.id, 'reconciliation id');
    const kind = (req.body || {}).kind;
    const body = optionalText((req.body || {}).body, 2000);
    if (!body) throw httpError('A note is required', 400);
    if (!['cashier_explanation', 'manager_explanation', 'manager_acknowledgement', 'correction'].includes(kind)) {
      throw httpError('Unknown note kind', 400);
    }
    const managerKind = kind === 'manager_explanation' || kind === 'manager_acknowledgement' || kind === 'correction';
    if (managerKind && !canResolve(me.id)) throw httpError('Only a manager can add this note', 403);
    const result = withTxn(() => {
      const rec = db.prepare(`SELECT * FROM cash_reconciliations WHERE id = ?`).get(recId) as ReconciliationRow | undefined;
      if (!rec) throw httpError('Reconciliation not found', 404);
      const session = loadSession(db, rec.session_id);
      if (kind === 'cashier_explanation' && session.opened_by !== me.id && !canResolve(me.id)) {
        throw httpError('Only the cashier of this shift can explain it', 403);
      }
      const at = now();
      db.prepare(`INSERT INTO cash_reconciliation_notes (reconciliation_id, kind, body, author_id, author_role, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(recId, kind, body, me.id, me.role, at);
      if (kind === 'manager_acknowledgement') {
        if (rec.actual_usd_cents == null) throw httpError('Cannot acknowledge before the cash is counted', 409);
        // Acknowledging does not erase the discrepancy: variance columns stay as recorded.
        db.prepare(`UPDATE cash_reconciliations SET status = 'resolved', resolved_by = ?, resolved_at = ? WHERE id = ?`).run(me.id, at, recId);
        db.prepare(`UPDATE cash_sessions SET review_required = 0 WHERE id = ?`).run(rec.session_id);
        db.prepare(`UPDATE cash_handovers SET status = 'resolved' WHERE from_session_id = ? AND status = 'flagged'`).run(rec.session_id);
      }
      return db.prepare(`SELECT * FROM cash_reconciliations WHERE id = ?`).get(recId) as ReconciliationRow;
    });
    res.json({ reconciliation: shapeReconciliation(result, canResolve(me.id)), notes: notesFor(db, recId) });
  } catch (error) { sendError(res, error, 'Failed to add note'); }
});

/* ── media: envelope + purchase receipt photos ───────────────────────── */

const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const PHOTO_MIME = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/heic', 'heic']]);

function uploadsDir(): string {
  return path.join(app.getPath('userData'), 'uploads', 'cash');
}

/** Stores an original photo on the data volume (never in SQLite). Idempotent per key. */
router.post('/media', requirePermission('cash.shifts.view'), (req: AuthedRequest, res: Response) => {
  try {
    const db = getDatabase();
    const me = actor(req);
    const body = req.body || {};
    const kind = body.kind;
    if (kind !== 'envelope' && kind !== 'purchase_receipt') throw httpError("kind must be 'envelope' or 'purchase_receipt'", 400);
    const idempotencyKey = optionalText(req.header('Idempotency-Key') ?? body.idempotency_key, 120);
    if (idempotencyKey) {
      const existing = db.prepare(`SELECT id, kind, mime, bytes, sha256, session_id, created_at FROM media_uploads WHERE idempotency_key = ?`).get(idempotencyKey);
      if (existing) return res.json({ media: existing, duplicate: true });
    }
    const dataUri = typeof body.data === 'string' ? body.data : '';
    const match = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUri);
    if (!match) throw httpError('data must be a base64 image data URI', 400);
    const mime = match[1].toLowerCase();
    const ext = PHOTO_MIME.get(mime);
    if (!ext) throw httpError('Photo must be JPEG, PNG, WebP or HEIC', 400);
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) throw httpError('Photo is empty or larger than 12 MB', 400);
    const sessionId = body.session_id == null ? null : parseId(body.session_id, 'session id');
    if (sessionId) loadSession(db, sessionId);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const dir = path.join(uploadsDir(), new Date().toISOString().slice(0, 7));
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${kind}-${Date.now()}-${sha256.slice(0, 12)}.${ext}`);
    fs.writeFileSync(filePath, bytes, { flag: 'wx' });
    const inserted = db.prepare(`
      INSERT INTO media_uploads (kind, idempotency_key, file_path, mime, bytes, sha256, session_id, uploaded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(kind, idempotencyKey, filePath, mime, bytes.length, sha256, sessionId, me.id, now());
    res.json({ media: { id: Number(inserted.lastInsertRowid), kind, mime, bytes: bytes.length, sha256, session_id: sessionId } });
  } catch (error) { sendError(res, error, 'Failed to store photo'); }
});

/** Streams a stored photo to managers/owners or to the uploader. */
router.get('/media/:id', requirePermission('cash.shifts.view'), (req: AuthedRequest, res: Response) => {
  try {
    const db = getDatabase();
    const me = actor(req);
    const row = db.prepare(`SELECT * FROM media_uploads WHERE id = ?`).get(parseId(req.params.id, 'media id')) as
      { file_path: string; mime: string; uploaded_by: string } | undefined;
    if (!row) throw httpError('Photo not found', 404);
    if (row.uploaded_by !== me.id && !canResolve(me.id) && !hasPermission(me.id, 'cash.history.view')) throw httpError('Not allowed', 403);
    if (!fs.existsSync(row.file_path)) throw httpError('Photo file is missing on the server', 410);
    res.type(row.mime).send(fs.readFileSync(row.file_path));
  } catch (error) { sendError(res, error, 'Failed to read photo'); }
});

/** Sealed cash envelope: amount + photo, attached to the closing shift. */
router.post('/sessions/:id/envelope', requirePermission('cash.shifts.close'), (req: AuthedRequest, res: Response) => {
  try {
    const db = getDatabase();
    const me = actor(req);
    const sessionId = parseId(req.params.id, 'session id');
    const amount = parseAmountPair(req.body || {}, 'envelope');
    const mediaId = (req.body || {}).media_id == null ? null : parseId(req.body.media_id, 'media id');
    const session = loadSession(db, sessionId);
    if (session.opened_by !== me.id && !canResolve(me.id)) throw httpError('Only the shift cashier or a manager can record this envelope', 403);
    if (mediaId) {
      const media = db.prepare(`SELECT kind FROM media_uploads WHERE id = ?`).get(mediaId) as { kind: string } | undefined;
      if (!media || media.kind !== 'envelope') throw httpError('Envelope photo not found', 400);
    }
    const inserted = db.prepare(`
      INSERT INTO cash_envelopes (session_id, usd_cents, khr_riel, media_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, amount.usd_cents, amount.khr_riel, mediaId, me.id, now());
    res.json({ envelope: { id: Number(inserted.lastInsertRowid), session_id: sessionId, ...amount, media_id: mediaId } });
    if (mediaId) notifyTelegram('shift_envelope', { sessionId });
  } catch (error) { sendError(res, error, 'Failed to record envelope'); }
});

/** Supplier receipt photo. Never creates deliveries or changes stock. */
router.post('/purchase-receipts', requirePermission('cash.shifts.view'), (req: AuthedRequest, res: Response) => {
  try {
    const db = getDatabase();
    const me = actor(req);
    const body = req.body || {};
    const mediaId = parseId(body.media_id, 'media id');
    const media = db.prepare(`SELECT kind FROM media_uploads WHERE id = ?`).get(mediaId) as { kind: string } | undefined;
    if (!media || media.kind !== 'purchase_receipt') throw httpError('Receipt photo not found', 400);
    const purchaseDate = typeof body.purchase_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.purchase_date) ? body.purchase_date : null;
    if (!purchaseDate) throw httpError('purchase_date must be YYYY-MM-DD', 400);
    const currency = body.currency === 'KHR' ? 'KHR' : body.currency === 'USD' ? 'USD' : null;
    if (!currency) throw httpError("currency must be 'USD' or 'KHR'", 400);
    const total = body.total_minor;
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) throw httpError('total_minor must be whole cents/riel >= 0', 400);
    const vendorId = body.vendor_id == null ? null : parseId(body.vendor_id, 'vendor id');
    const sessionId = body.session_id == null ? (getOpenSession(db)?.id ?? null) : parseId(body.session_id, 'session id');
    const inserted = db.prepare(`
      INSERT INTO purchase_receipts (media_id, vendor_id, vendor_name, purchase_date, total_minor, currency, notes, session_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(mediaId, vendorId, optionalText(body.vendor_name, 120), purchaseDate, total, currency,
      optionalText(body.notes, 1000), sessionId, me.id, now());
    res.json({ receipt: { id: Number(inserted.lastInsertRowid) } });
  } catch (error) { sendError(res, error, 'Failed to save receipt'); }
});

/** Owner/manager review list: unresolved discrepancies, pending counts, flagged handovers. */
router.get('/review', requirePermission('cash.reconciliation.resolve'), (_req: AuthedRequest, res: Response) => {
  try {
    const db = getDatabase();
    const alertHours = intSetting('cash_pending_count_alert_hours', 4);
    res.json({
      pending_review: db.prepare(`
        SELECT r.id, r.session_id, s.opened_by_name, r.cutoff_at, r.variance_usd_cents, r.variance_khr_riel, r.variance_combined_usd_cents
        FROM cash_reconciliations r JOIN cash_sessions s ON s.id = r.session_id
        WHERE r.status = 'pending_review' ORDER BY r.cutoff_at DESC
      `).all(),
      pending_counts: db.prepare(`
        SELECT s.id, s.opened_by_name, s.cutoff_at,
          (julianday('now') - julianday(s.cutoff_at)) * 24 >= ? AS overdue
        FROM cash_sessions s WHERE s.handover_state = 'pending_count' ORDER BY s.cutoff_at
      `).all(alertHours),
      flagged_handovers: db.prepare(`
        SELECT h.id, h.from_session_id, h.to_session_id, h.diff_usd_cents, h.diff_khr_riel, h.cutoff_at
        FROM cash_handovers h WHERE h.status = 'flagged' ORDER BY h.id DESC
      `).all(),
      disputed_tickets: db.prepare(`
        SELECT i.order_id, i.order_number, i.table_label, i.balance, i.dispute_reason, th.from_session_id
        FROM ticket_handover_items i JOIN ticket_handovers th ON th.id = i.ticket_handover_id
        WHERE i.item_status = 'disputed' ORDER BY i.id DESC
      `).all(),
    });
  } catch (error) { sendError(res, error, 'Failed to read review list'); }
});

/** Open tickets the outgoing cashier hands over (same list the handover snapshots). */
router.get('/open-tickets', requirePermission('cash.shifts.view'), (_req: AuthedRequest, res: Response) => {
  try {
    res.json({ tickets: openTickets(getDatabase()) });
  } catch (error) { sendError(res, error, 'Failed to read open tickets'); }
});

export const cashHandoverRoutes = router;
