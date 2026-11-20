import { dayBoundsInTimezone, getDatabase, getSettingValue, now, tenantBusinessDayStartTime } from '../db';
import { tenantTimezone } from '../routes/cash-closures';
import { exchangeRate, expectedByCurrency, MATCH_TOLERANCE_USD_CENTS } from '../routes/cash-handover';
import type {
  DailyReportData, ReportOrderRow, ReportPaymentRow, ReportQtyRow, ReportSales, ReportShiftRow, ReportSpentRow, ReportTableRow, ShiftReportData,
} from '../../shared/print/shift-report-text';

type Db = ReturnType<typeof getDatabase>;

interface SessionRow {
  id: number; opened_by: string; opened_by_name: string; opened_at: string; status: string; closed_at: string | null;
  opening_float_cents: number; opening_khr_riel: number; opening_count_id: number | null;
}
interface Window { start: string; end: string; sessionId: number | null }

/** Window ends are exclusive, so a shift's own last second is included by ending one second later. */
const secondAfter = (stamp: string) => new Date(Date.parse(`${stamp.replace(' ', 'T')}Z`) + 1000).toISOString().replace('T', ' ').replace(/\..*$/, '');
const cents = (n: unknown) => Math.round(Number(n || 0) * 100);
const PAID = `('paid', 'partially_refunded', 'refunded')`;

function businessName(db: Db): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'business_name'`).get() as { value?: string } | undefined;
  return row?.value?.trim() || 'BackStreet Riverside';
}
function registerName(): string {
  return getSettingValue('register_name')?.trim() || 'Front bar';
}

/** Bills whose payment falls in the window (or carries the session id on a payment line). */
function paidBillIds(db: Db, w: Window): number[] {
  const rows = db.prepare(`
    SELECT DISTINCT b.id FROM bills b
    LEFT JOIN json_each(CASE WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array' THEN b.payment_details ELSE '[]' END) je
    WHERE b.payment_status IN ${PAID}
      AND (
        (? IS NOT NULL AND CAST(json_extract(je.value, '$.cash_session_id') AS INTEGER) = ?)
        OR (datetime(COALESCE(NULLIF(b.paid_at, ''), b.created_at)) >= datetime(?) AND datetime(COALESCE(NULLIF(b.paid_at, ''), b.created_at)) < datetime(?))
      )
  `).all(w.sessionId, w.sessionId, w.start, w.end) as { id: number }[];
  return rows.map((r) => r.id);
}

function inList(ids: number[]): string {
  return ids.length ? ids.map((id) => Number(id)).join(',') : 'NULL';
}

function salesFor(db: Db, w: Window, billIds: number[]): ReportSales {
  const bills = db.prepare(`
    SELECT b.subtotal, b.discount_amount, b.total, b.round_off FROM bills b WHERE b.id IN (${inList(billIds)})
  `).all() as { subtotal: number; discount_amount: number; total: number; round_off: number }[];
  let gross = 0; let discount = 0; let net = 0; let compCount = 0; let compCents = 0;
  for (const b of bills) {
    const sub = cents(b.subtotal) + cents(b.round_off);
    gross += sub;
    discount += Math.min(cents(b.discount_amount), sub);
    net += cents(b.total);
    if (sub > 0 && cents(b.total) === 0) { compCount += 1; compCents += sub; }
  }
  const refunds = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS c FROM refunds
    WHERE ${w.sessionId != null ? '(cash_session_id = ? OR (cash_session_id IS NULL AND created_at >= ? AND created_at < ?))' : '(created_at >= ? AND created_at < ?)'}
  `).get(...(w.sessionId != null ? [w.sessionId, w.start, w.end] : [w.start, w.end])) as { n: number; c: number };
  const voids = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS t FROM order_items
    WHERE status = 'voided' AND datetime(COALESCE(voided_at, updated_at)) >= datetime(?) AND datetime(COALESCE(voided_at, updated_at)) < datetime(?)
  `).get(w.start, w.end) as { n: number; t: number };
  const netAfterRefunds = net - Number(refunds.c || 0);
  const orders = bills.length;
  return {
    grossCents: gross, discountCents: discount, refundCents: Number(refunds.c || 0), refundCount: Number(refunds.n || 0),
    voidCount: Number(voids.n || 0), voidCents: cents(voids.t), compCount, compCents,
    netCents: netAfterRefunds, orders, averageCents: orders ? Math.round(net / orders) : 0,
  };
}

function paymentsFor(db: Db, w: Window): ReportPaymentRow[] {
  const lines = db.prepare(`
    WITH lines AS (
      SELECT je.value AS line,
        COALESCE(datetime(NULLIF(json_extract(je.value, '$.timestamp'), '')), datetime(NULLIF(b.paid_at, '')), datetime(b.created_at)) AS t
      FROM bills b
      JOIN json_each(CASE WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array' THEN b.payment_details ELSE '[]' END) je
      WHERE json_type(je.value) = 'object' AND b.payment_status IN ${PAID}
    )
    SELECT lower(COALESCE(json_extract(l.line, '$.method'), '')) AS method, pm.name AS custom_name,
      CAST(json_extract(l.line, '$.amount') AS REAL) AS amount,
      json_extract(l.line, '$.cash_usd_in') AS usd_in, json_extract(l.line, '$.cash_khr_in') AS khr_in,
      json_extract(l.line, '$.change_usd_out') AS usd_out, json_extract(l.line, '$.change_khr_out') AS khr_out
    FROM lines l
    LEFT JOIN payment_methods pm ON pm.id = CAST(json_extract(l.line, '$.payment_method_id') AS INTEGER)
    WHERE (? IS NOT NULL AND CAST(json_extract(l.line, '$.cash_session_id') AS INTEGER) = ?)
       OR ((? IS NULL OR json_extract(l.line, '$.cash_session_id') IS NULL) AND l.t >= datetime(?) AND l.t < datetime(?))
  `).all(w.sessionId, w.sessionId, w.sessionId, w.start, w.end) as {
    method: string; custom_name: string | null; amount: number; usd_in: unknown; khr_in: unknown; usd_out: unknown; khr_out: unknown;
  }[];
  const rows = new Map<string, ReportPaymentRow>();
  const add = (label: string, usdCents: number, khrRiel: number) => {
    const row = rows.get(label) ?? { label, count: 0, usdCents: 0, khrRiel: 0 };
    row.count += 1; row.usdCents += usdCents; row.khrRiel += khrRiel;
    rows.set(label, row);
  };
  for (const l of lines) {
    if (l.method === 'cash' || (l.custom_name || '').toLowerCase() === 'cash') {
      const split = l.usd_in != null || l.khr_in != null;
      if (!split) { add('Cash USD', cents(l.amount), 0); continue; }
      const usdNet = cents(l.usd_in) - cents(l.usd_out);
      const khrNet = Math.round(Number(l.khr_in || 0)) - Math.round(Number(l.khr_out || 0));
      if (usdNet !== 0 || khrNet === 0) add('Cash USD', usdNet, 0);
      if (khrNet !== 0) add('Cash KHR', 0, khrNet);
    } else if (l.method === 'card') {
      add('Card', cents(l.amount), 0);
    } else if (l.custom_name) {
      const name = l.custom_name.replace(/\s*\(manual\)\s*$/i, '').trim();
      add(/^(aba|acleda)/i.test(name) ? `${name} QR` : name, cents(l.amount), 0);
    } else {
      add(l.method ? l.method.charAt(0).toUpperCase() + l.method.slice(1) : 'Other', cents(l.amount), 0);
    }
  }
  const order = ['Cash USD', 'Cash KHR'];
  return Array.from(rows.values()).sort((a, b) => {
    const ia = order.indexOf(a.label); const ib = order.indexOf(b.label);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 9 : ia) - (ib === -1 ? 9 : ib);
    return b.usdCents - a.usdCents;
  });
}

interface OrderRow { id: number; order_number: string; table_number: string | null; tab_name: string | null; type: string; created_at: string; status: string; bill_status: string | null; total: number; paid_at: string | null; cashier: string | null; payment_details: string | null }

function ordersInWindow(db: Db, w: Window, extraOpen: boolean): OrderRow[] {
  return db.prepare(`
    SELECT o.id, o.order_number, t.number AS table_number, o.tab_name, o.type, o.created_at, o.status,
      b.payment_status AS bill_status, COALESCE(b.total, o.total) AS total, b.paid_at, u.name AS cashier, b.payment_details
    FROM orders o
    LEFT JOIN tables t ON t.id = o.table_id
    LEFT JOIN bills b ON b.order_id = o.id
    LEFT JOIN users u ON u.id = o.user_id
    WHERE o.status != 'cancelled' AND o.order_number NOT LIKE 'IB4-%'
      AND ((datetime(o.created_at) >= datetime(?) AND datetime(o.created_at) < datetime(?))
        OR (? = 1 AND COALESCE(b.payment_status, 'unpaid') NOT IN ${PAID}))
    ORDER BY o.created_at
  `).all(w.start, w.end, extraOpen ? 1 : 0) as OrderRow[];
}

function tableKey(o: OrderRow): string {
  if (o.table_number) { const n = String(o.table_number).trim(); return /^\d+$/.test(n) ? `T${n}` : n; }
  if (o.tab_name) return `Tab ${o.tab_name}`;
  if (o.type === 'takeaway') return 'To Go';
  return 'Walk-in';
}

function tableRows(orders: OrderRow[], whoFor: (o: OrderRow) => string): ReportTableRow[] {
  const map = new Map<string, ReportTableRow & { paidCount: number }>();
  for (const o of orders) {
    const key = tableKey(o);
    const paid = o.bill_status != null && ['paid', 'partially_refunded', 'refunded'].includes(o.bill_status);
    const row = map.get(key) ?? { label: key, who: whoFor(o), openedAt: o.created_at, closedAt: null, bills: 0, totalCents: 0, status: 'paid' as const, paidCount: 0 };
    row.bills += 1;
    row.totalCents += cents(o.total);
    if (paid) { row.paidCount += 1; if (!row.closedAt || (o.paid_at && o.paid_at > row.closedAt)) row.closedAt = o.paid_at; }
    if (!row.openedAt || o.created_at < row.openedAt) row.openedAt = o.created_at;
    map.set(key, row);
  }
  return Array.from(map.values()).map(({ paidCount, ...row }) => ({
    ...row,
    closedAt: paidCount === row.bills ? row.closedAt : null,
    status: paidCount === row.bills ? 'paid' : paidCount === 0 ? 'unpaid' : 'open',
  }));
}

function unpaidSummary(orders: OrderRow[]): { count: number; totalCents: number; labels: string[] } {
  const open = orders.filter((o) => !o.bill_status || !['paid', 'partially_refunded', 'refunded'].includes(o.bill_status));
  return {
    count: open.length,
    totalCents: open.reduce((s, o) => s + cents(o.total), 0),
    labels: open.map((o) => `${tableKey(o)} #${o.order_number} ${(cents(o.total) / 100).toFixed(2)}`),
  };
}

function spentFor(db: Db, sessionId: number): ReportSpentRow[] {
  return (db.prepare(`
    SELECT m.reason, m.amount_cents, m.amount_khr_riel,
      EXISTS (SELECT 1 FROM purchase_receipts r WHERE r.session_id = m.cash_session_id AND r.notes = 'drawer-movement:' || m.id) AS photo
    FROM cash_drawer_movements m WHERE m.cash_session_id = ? AND m.movement_type = 'pay_out' AND m.voided_at IS NULL ORDER BY m.id
  `).all(sessionId) as { reason: string | null; amount_cents: number; amount_khr_riel: number; photo: number }[])
    .map((r) => ({ label: r.reason || 'Cash spent', usdCents: Number(r.amount_cents || 0), khrRiel: Number(r.amount_khr_riel || 0), hasPhoto: Boolean(r.photo) }));
}

function movementTotals(db: Db, sessionId: number) {
  const rows = db.prepare(`
    SELECT movement_type, COALESCE(SUM(amount_cents), 0) AS usd, COALESCE(SUM(amount_khr_riel), 0) AS khr
    FROM cash_drawer_movements WHERE cash_session_id = ? AND voided_at IS NULL GROUP BY movement_type
  `).all(sessionId) as { movement_type: string; usd: number; khr: number }[];
  const get = (t: string) => rows.find((r) => r.movement_type === t) ?? { usd: 0, khr: 0 };
  const out = { payInUsd: get('pay_in').usd, payInKhr: get('pay_in').khr, payOutUsd: 0, payOutKhr: 0 };
  for (const r of rows) if (r.movement_type === 'pay_out' || r.movement_type === 'safe_drop') { out.payOutUsd += Number(r.usd); out.payOutKhr += Number(r.khr); }
  return out;
}

const isPaid = (o: OrderRow) => o.bill_status != null && ['paid', 'partially_refunded', 'refunded'].includes(o.bill_status);

function methodNames(db: Db): Map<number, string> {
  const rows = db.prepare(`SELECT id, name FROM payment_methods`).all() as { id: number; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name.replace(/\s*\(manual\)\s*$/i, '').trim()]));
}

function paymentLabel(line: Record<string, unknown>, names: Map<number, string>): string {
  const method = String(line.method || '').toLowerCase();
  if (method === 'cash') return Number(line.cash_khr_in || 0) > 0 && !Number(line.cash_usd_in || 0) ? 'Cash KHR' : 'Cash';
  if (method === 'card') return 'Card';
  const custom = names.get(Number(line.payment_method_id));
  return custom || (method ? method.charAt(0).toUpperCase() + method.slice(1) : 'Other');
}

function parseLines(json: string | null): Record<string, unknown>[] {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v.filter((l) => l && typeof l === 'object') : []; } catch { return []; }
}

function orderRows(db: Db, orders: OrderRow[], shiftFor: (o: OrderRow) => number | null): ReportOrderRow[] {
  const names = methodNames(db);
  return orders.map((o) => ({
    id: o.id, orderNumber: o.order_number, label: tableKey(o), cashier: o.cashier ?? '',
    openedAt: o.created_at, closedAt: isPaid(o) ? o.paid_at : null, totalCents: cents(o.total),
    status: isPaid(o) ? 'paid' : 'unpaid',
    paidWith: isPaid(o) ? [...new Set(parseLines(o.payment_details).map((l) => paymentLabel(l, names)))].join(' + ') : '',
    shiftId: shiftFor(o),
  }));
}

export interface OrderDetail {
  id: number; orderNumber: string; label: string; status: string; paymentStatus: string; cashier: string; createdAt: string; paidAt: string | null;
  totalCents: number; discountCents: number; timezone: string;
  items: { name: string; qty: number; status: string; totalCents: number; note: string | null }[];
  payments: { label: string; amountCents: number; at: string | null }[];
  history: { at: string; text: string }[];
}

/** Read-only details for one order (Reports → Tables panel). */
export function buildOrderDetail(orderId: number): OrderDetail {
  const db = getDatabase();
  const o = db.prepare(`
    SELECT o.id, o.order_number, t.number AS table_number, o.tab_name, o.type, o.created_at, o.status,
      b.payment_status AS bill_status, COALESCE(b.total, o.total) AS total, b.paid_at, u.name AS cashier, b.payment_details,
      COALESCE(b.discount_amount, 0) AS discount
    FROM orders o LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN bills b ON b.order_id = o.id LEFT JOIN users u ON u.id = o.user_id
    WHERE o.id = ?
  `).get(orderId) as (OrderRow & { discount: number }) | undefined;
  if (!o) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
  const names = methodNames(db);
  const items = (db.prepare(`
    SELECT product_name, quantity, status, total, special_instructions FROM order_items WHERE order_id = ? ORDER BY id
  `).all(orderId) as { product_name: string; quantity: number; status: string; total: number; special_instructions: string | null }[])
    .map((i) => ({ name: i.product_name, qty: Number(i.quantity), status: i.status, totalCents: cents(i.total), note: i.special_instructions || null }));
  const payments = parseLines(o.payment_details).map((l) => ({
    label: paymentLabel(l, names), amountCents: cents(l.amount), at: typeof l.timestamp === 'string' ? l.timestamp : null,
  }));
  const history = (db.prepare(`
    SELECT a.action, a.created_at, u.name FROM order_audit_log a LEFT JOIN users u ON u.id = a.actor_user_id WHERE a.order_id = ? ORDER BY a.id
  `).all(orderId) as { action: string; created_at: string; name: string | null }[])
    .map((h) => ({ at: h.created_at, text: `${h.action.replace(/[_.]/g, ' ')}${h.name ? ` · ${h.name}` : ''}` }));
  if (!history.length) history.push({ at: o.created_at, text: `order placed${o.cashier ? ` · ${o.cashier}` : ''}` });
  if (isPaid(o) && o.paid_at && !history.some((h) => /paid|payment/i.test(h.text))) history.push({ at: o.paid_at, text: 'paid' });
  return {
    id: o.id, orderNumber: o.order_number, label: tableKey(o), status: o.status, paymentStatus: o.bill_status ?? 'unpaid',
    cashier: o.cashier ?? '', createdAt: o.created_at, paidAt: isPaid(o) ? o.paid_at : null,
    totalCents: cents(o.total), discountCents: cents(o.discount), timezone: tenantTimezone(), items, payments, history,
  };
}

export function buildShiftReport(sessionId: number): ShiftReportData {
  const db = getDatabase();
  const session = db.prepare(`SELECT * FROM cash_sessions WHERE id = ?`).get(sessionId) as SessionRow | undefined;
  if (!session) throw Object.assign(new Error('Shift not found'), { statusCode: 404 });
  const closing = session.status === 'closed';
  const end = closing && session.closed_at ? session.closed_at : now();
  const w: Window = { start: session.opened_at, end: secondAfter(end), sessionId: session.id };
  const billIds = paidBillIds(db, w);
  const orders = ordersInWindow(db, w, !closing);
  const tables = tableRows(orders, (o) => o.cashier ?? '');
  const dineTables = tables.filter((t) => t.label !== 'To Go' && t.label !== 'Walk-in');
  const occupiedNow = closing ? dineTables.filter((t) => t.status !== 'paid').length
    : Number((db.prepare(`SELECT COUNT(*) AS n FROM tables WHERE is_active = 1 AND status IN ('occupied', 'held')`).get() as { n: number }).n || 0);

  const rec = db.prepare(`SELECT * FROM cash_reconciliations WHERE session_id = ?`).get(session.id) as Record<string, number | string | null> | undefined;
  const expected = closing && rec?.expected_usd_cents != null
    ? { expected_usd_cents: Number(rec.expected_usd_cents), expected_khr_riel: Number(rec.expected_khr_riel || 0), untracked_cash_lines: Number(rec.untracked_cash_lines || 0) }
    : expectedByCurrency(db, session as never, end);
  const rate = rec?.rate_khr_per_usd ? Number(rec.rate_khr_per_usd) : exchangeRate();
  const movements = movementTotals(db, session.id);
  const opening = session.opening_count_id
    ? db.prepare(`SELECT usd_cents, khr_riel FROM cash_counts WHERE id = ?`).get(session.opening_count_id) as { usd_cents: number; khr_riel: number } | undefined
    : undefined;
  const openingUsd = opening ? Number(opening.usd_cents) : Number(session.opening_float_cents || 0);
  const openingKhr = opening ? Number(opening.khr_riel) : Number(session.opening_khr_riel || 0);
  const cashRefund = Number((db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS c FROM refunds WHERE lower(method) = 'cash' AND (cash_session_id = ? OR (cash_session_id IS NULL AND created_at >= ? AND created_at < ?))`)
    .get(session.id, w.start, w.end) as { c: number }).c || 0);
  const cashSalesUsd = expected.expected_usd_cents - openingUsd - movements.payInUsd + movements.payOutUsd + cashRefund;
  const cashSalesKhr = expected.expected_khr_riel - openingKhr - movements.payInKhr + movements.payOutKhr;
  const counted = closing && rec?.actual_usd_cents != null;

  const notes = rec?.id ? (db.prepare(`
    SELECT n.kind, n.body, u.name FROM cash_reconciliation_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.reconciliation_id = ? ORDER BY n.id
  `).all(rec.id) as { kind: string; body: string; name: string | null }[]).map((n) => `${n.kind === 'cashier_explanation' ? 'Cashier' : 'Manager'} (${n.name ?? '—'}): ${n.body}`) : [];
  if (closing && rec?.status === 'pending_review') notes.push('Manager review: pending');

  const deliveries = db.prepare(`SELECT status FROM telegram_deliveries WHERE dedupe_key LIKE ?`).all(`shift|${session.id}|close|%`) as { status: string }[];
  const tgCount = (st: string) => deliveries.filter((d) => d.status === st).length;
  const telegram = deliveries.length
    ? [tgCount('sent') && `sent to ${tgCount('sent')}`, tgCount('pending') && `${tgCount('pending')} waiting`, tgCount('failed') && `${tgCount('failed')} failed`].filter(Boolean).join(', ')
    : null;

  return {
    kind: closing ? 'Z' : 'X',
    businessName: businessName(db), register: registerName(), shiftNumber: session.id, timezone: tenantTimezone(),
    cashier: session.opened_by_name || '—', openedAt: session.opened_at, closedAt: closing ? session.closed_at : null, printedAt: now(),
    sales: salesFor(db, w, billIds),
    payments: paymentsFor(db, w),
    unpaid: unpaidSummary(orders),
    tables: { served: dineTables.length, completed: dineTables.filter((t) => t.status === 'paid').length, occupied: occupiedNow, awaiting: tables.filter((t) => t.status !== 'paid'), rows: tables },
    cash: {
      rate,
      openingUsdCents: openingUsd, openingKhrRiel: openingKhr,
      cashSalesUsdCents: cashSalesUsd, cashSalesKhrRiel: cashSalesKhr, cashRefundUsdCents: cashRefund,
      payInUsdCents: Number(movements.payInUsd), payInKhrRiel: Number(movements.payInKhr),
      payOutUsdCents: Number(movements.payOutUsd), payOutKhrRiel: Number(movements.payOutKhr),
      expectedUsdCents: expected.expected_usd_cents, expectedKhrRiel: expected.expected_khr_riel,
      countedUsdCents: counted ? Number(rec!.actual_usd_cents) : null, countedKhrRiel: counted ? Number(rec!.actual_khr_riel || 0) : null,
      varianceUsdCents: counted ? Number(rec!.variance_usd_cents || 0) : null, varianceKhrRiel: counted ? Number(rec!.variance_khr_riel || 0) : null,
      varianceCombinedCents: counted ? Number(rec!.variance_combined_usd_cents || 0) : null,
      matches: counted ? rec!.status === 'balanced' || rec!.status === 'resolved' : null,
      toleranceCents: MATCH_TOLERANCE_USD_CENTS,
      floatKeptUsdCents: closing && rec?.float_retained_usd_cents != null ? Number(rec.float_retained_usd_cents) : null,
      floatKeptKhrRiel: closing && rec?.float_retained_khr_riel != null ? Number(rec.float_retained_khr_riel) : null,
      untrackedCashLines: expected.untracked_cash_lines,
    },
    spent: spentFor(db, session.id),
    orders: orderRows(db, orders, () => session.id),
    notes,
    telegram,
  };
}

export function buildDailyReport(businessDate: string): DailyReportData {
  const db = getDatabase();
  const [start, end] = dayBoundsInTimezone(businessDate, tenantTimezone(), tenantBusinessDayStartTime(db));
  const w: Window = { start, end, sessionId: null };
  const billIds = paidBillIds(db, w);
  const sessions = db.prepare(`
    SELECT s.*, r.variance_usd_cents, r.variance_khr_riel, r.actual_usd_cents FROM cash_sessions s
    LEFT JOIN cash_reconciliations r ON r.session_id = s.id
    WHERE datetime(s.opened_at) >= datetime(?) AND datetime(s.opened_at) < datetime(?) ORDER BY s.opened_at
  `).all(start, end) as (SessionRow & { variance_usd_cents: number | null; variance_khr_riel: number | null; actual_usd_cents: number | null })[];
  const shifts: ReportShiftRow[] = sessions.map((s) => {
    const sw: Window = { start: s.opened_at, end: secondAfter(s.closed_at ?? now()), sessionId: s.id };
    const sales = salesFor(db, sw, paidBillIds(db, sw));
    return {
      id: s.id, cashier: s.opened_by_name || '—', openedAt: s.opened_at, closedAt: s.closed_at, orders: sales.orders, netCents: sales.netCents,
      varianceUsdCents: s.actual_usd_cents != null ? Number(s.variance_usd_cents || 0) : null,
      varianceKhrRiel: s.actual_usd_cents != null ? Number(s.variance_khr_riel || 0) : null,
    };
  });
  const items = db.prepare(`
    SELECT COALESCE(c.name, 'Not on menu') AS category, oi.product_name AS product, SUM(oi.quantity) AS qty, SUM(oi.total) AS total
    FROM order_items oi
    JOIN bills b ON b.order_id = oi.order_id
    LEFT JOIN products p ON p.id = oi.product_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE b.id IN (${inList(billIds)}) AND oi.status NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded')
    GROUP BY category, product
  `).all() as { category: string; product: string; qty: number; total: number }[];
  const byCategory = new Map<string, ReportQtyRow>();
  for (const i of items) {
    const row = byCategory.get(i.category) ?? { label: i.category, qty: 0, netCents: 0 };
    row.qty += Number(i.qty || 0); row.netCents += cents(i.total);
    byCategory.set(i.category, row);
  }
  const orders = ordersInWindow(db, w, false);
  return {
    businessName: businessName(db), timezone: tenantTimezone(), businessDate, dayStart: start, dayEnd: end, printedAt: now(),
    sales: salesFor(db, w, billIds),
    shifts,
    payments: paymentsFor(db, w),
    categories: Array.from(byCategory.values()).sort((a, b) => b.netCents - a.netCents),
    products: items.map((i) => ({ label: i.product, qty: Number(i.qty || 0), netCents: cents(i.total) })).sort((a, b) => b.netCents - a.netCents).slice(0, 10),
    tables: tableRows(orders, (o) => o.cashier ?? ''),
    orders: orderRows(db, orders, (o) => sessions.find((x) => o.created_at >= x.opened_at && (!x.closed_at || o.created_at <= x.closed_at))?.id ?? null),
    unpaid: unpaidSummary(orders),
  };
}
