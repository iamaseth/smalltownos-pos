/**
 * Print job ledger: de-duplicates prints across double taps, retries and
 * transport switches (WebUSB ↔ Chrome dialog ↔ desktop), records failures with
 * a stable error code, and lets a terminal retry a failed kitchen ticket or
 * receipt. The printing itself stays on the terminal that owns the printer.
 *
 * Duplicate rule: the same job_key is not printed again while it is printing
 * (lease) or within DUPLICATE_WINDOW after it printed. After that window a
 * deliberate reprint goes through (manual "print again" later in the day).
 */
import { Router, Request, Response } from 'express';
import { getDatabase, now } from '../db';
import { requirePermission } from '../services/authorization';

const router = Router();

export const PRINT_LEASE_SECONDS = 90;
export const DUPLICATE_WINDOW_SECONDS = 120;
const KINDS = new Set(['receipt', 'kot', 'test', 'other']);
const TRANSPORTS = new Set(['webusb', 'browser', 'native', 'unknown']);
export const PRINT_ERROR_CODES = new Set([
  'not_connected', 'device_busy', 'permission_denied', 'driver_conflict', 'popup_blocked',
  'not_configured', 'offline', 'timeout', 'cancelled', 'refused', 'unknown',
]);

interface JobRow {
  id: number; job_key: string; kind: string; label: string; transport: string; status: string; attempts: number;
  payload_json: string; last_error_code: string | null; last_error: string | null; device_id: string | null;
  requested_by: string | null; created_at: string; updated_at: string; printed_at: string | null;
}

function userId(req: Request): string | null {
  return (req as Request & { user?: { userId?: string } }).user?.userId ?? null;
}

function secondsSince(ts: string | null): number {
  if (!ts) return Number.POSITIVE_INFINITY;
  return (Date.now() - new Date(`${ts.replace(' ', 'T')}Z`).getTime()) / 1000;
}

function text(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t ? t.slice(0, max) : null;
}

function shape(row: JobRow) {
  let payload: unknown = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = {}; }
  return { ...row, payload, payload_json: undefined };
}

/**
 * Decides whether a terminal may print a job now.
 * Returns { action: 'print', job } or { action: 'skip', reason, job }.
 */
export function claimPrintJob(input: {
  jobKey: string; kind: string; label?: string | null; transport?: string | null; payload?: unknown;
  deviceId?: string | null; userId?: string | null;
}): { action: 'print' | 'skip'; reason?: string; job: ReturnType<typeof shape> } {
  const db = getDatabase();
  const kind = KINDS.has(input.kind) ? input.kind : 'other';
  const transport = input.transport && TRANSPORTS.has(input.transport) ? input.transport : 'unknown';
  const payloadJson = JSON.stringify(input.payload ?? {}).slice(0, 20000);
  return db.transaction(() => {
    const at = now();
    const existing = db.prepare(`SELECT * FROM print_jobs WHERE job_key = ?`).get(input.jobKey) as JobRow | undefined;
    if (!existing) {
      db.prepare(`
        INSERT INTO print_jobs (job_key, kind, label, transport, status, attempts, payload_json, device_id, requested_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'printing', 1, ?, ?, ?, ?, ?)
      `).run(input.jobKey, kind, input.label ?? '', transport, payloadJson, input.deviceId ?? null, input.userId ?? null, at, at);
      return { action: 'print' as const, job: shape(db.prepare(`SELECT * FROM print_jobs WHERE job_key = ?`).get(input.jobKey) as JobRow) };
    }
    if (existing.status === 'printing' && secondsSince(existing.updated_at) < PRINT_LEASE_SECONDS) {
      return { action: 'skip' as const, reason: 'in_progress', job: shape(existing) };
    }
    if ((existing.status === 'printed' || existing.status === 'printed_unconfirmed')
      && secondsSince(existing.printed_at) < DUPLICATE_WINDOW_SECONDS) {
      return { action: 'skip' as const, reason: 'already_printed', job: shape(existing) };
    }
    db.prepare(`
      UPDATE print_jobs SET status = 'printing', attempts = attempts + 1, transport = ?, device_id = COALESCE(?, device_id),
        payload_json = CASE WHEN ? = '{}' THEN payload_json ELSE ? END, updated_at = ?
      WHERE id = ?
    `).run(transport, input.deviceId ?? null, payloadJson, payloadJson, at, existing.id);
    return { action: 'print' as const, job: shape(db.prepare(`SELECT * FROM print_jobs WHERE id = ?`).get(existing.id) as JobRow) };
  })();
}

router.post('/claim', requirePermission('printing.execute'), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const jobKey = text(body.job_key, 200);
    if (!jobKey) return res.status(400).json({ error: 'job_key is required' });
    res.json(claimPrintJob({
      jobKey, kind: String(body.kind || 'other'), label: text(body.label, 120), transport: text(body.transport, 20),
      payload: body.payload, deviceId: text(body.device_id, 80), userId: userId(req),
    }));
  } catch (error) {
    console.error('[PrintJobs] claim failed:', error);
    res.status(500).json({ error: 'Failed to register print job' });
  }
});

router.post('/:id/result', requirePermission('printing.execute'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'Invalid job id' });
    const status = req.body?.status;
    if (!['printed', 'printed_unconfirmed', 'failed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const code = text(req.body?.error_code, 40);
    const errorCode = status === 'failed' ? (code && PRINT_ERROR_CODES.has(code) ? code : 'unknown') : null;
    const at = now();
    const result = db.prepare(`
      UPDATE print_jobs SET status = ?, last_error_code = COALESCE(?, last_error_code), last_error = CASE WHEN ? = 'failed' THEN ? ELSE last_error END,
        transport = COALESCE(?, transport), printed_at = CASE WHEN ? IN ('printed', 'printed_unconfirmed') THEN ? ELSE printed_at END, updated_at = ?
      WHERE id = ?
    `).run(status, errorCode, status, text(req.body?.error, 500), text(req.body?.transport, 20), status, at, at, id);
    if (result.changes === 0) return res.status(404).json({ error: 'Print job not found' });
    res.json({ job: shape(db.prepare(`SELECT * FROM print_jobs WHERE id = ?`).get(id) as JobRow) });
  } catch (error) {
    console.error('[PrintJobs] result failed:', error);
    res.status(500).json({ error: 'Failed to record print result' });
  }
});

/** Failed jobs still needing attention (kitchen tickets first), newest first. */
router.get('/failed', requirePermission('printing.execute'), (_req: Request, res: Response) => {
  const rows = getDatabase().prepare(`
    SELECT * FROM print_jobs WHERE status = 'failed' ORDER BY CASE kind WHEN 'kot' THEN 0 ELSE 1 END, updated_at DESC LIMIT 50
  `).all() as JobRow[];
  res.json({ jobs: rows.map(shape) });
});

/** Recent jobs for diagnostics. */
router.get('/recent', requirePermission('printing.execute'), (_req: Request, res: Response) => {
  const rows = getDatabase().prepare(`SELECT * FROM print_jobs ORDER BY updated_at DESC, id DESC LIMIT 30`).all() as JobRow[];
  res.json({ jobs: rows.map(shape) });
});

router.post('/:id/dismiss', requirePermission('printing.execute'), (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'Invalid job id' });
  const result = getDatabase().prepare(`UPDATE print_jobs SET status = 'dismissed', updated_at = ? WHERE id = ? AND status = 'failed'`).run(now(), id);
  res.json({ dismissed: result.changes > 0 });
});

export const printJobRoutes = router;
