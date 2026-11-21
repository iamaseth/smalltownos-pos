import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requirePermission } from '../services/authorization';
import {
  COMP_REASONS, VOID_REASONS, cancelRequest, createRequest, entertainerAllowance, entertainerCompsToday, getRequest, removalRequiresApproval,
} from '../services/item-approvals';
import { approverCount, closeApprovalMessages, sendApprovalRequest } from '../services/telegram';

const router = Router();

function fail(res: Response, error: unknown) {
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (!statusCode) console.error('[ItemApprovals]', error);
  res.status(statusCode || 500).json({ error: statusCode ? (error as Error).message : 'Internal server error' });
}

router.get('/config', requirePermission('orders.read'), (_req: Request, res: Response) => {
  try {
    const db = getDatabase();
    res.json({
      removalRequiresApproval: removalRequiresApproval(),
      entertainerAllowance: entertainerAllowance(),
      entertainerUsedToday: entertainerCompsToday(db),
      telegramApprovers: { void: approverCount('void', db), comp: approverCount('comp', db) },
      compReasons: COMP_REASONS, voidReasons: VOID_REASONS,
    });
  } catch (error) { fail(res, error); }
});

router.post('/', requirePermission('orders.read'), async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const { order_id, item_id, action, reason, note } = req.body || {};
    if (action !== 'void' && action !== 'comp') return res.status(400).json({ error: 'action must be void or comp' });
    const reasons: readonly string[] = action === 'comp' ? COMP_REASONS : VOID_REASONS;
    if (!reasons.includes(reason)) return res.status(400).json({ error: 'Choose a reason' });
    if (!approverCount(action, db)) return res.status(409).json({ error: 'No manager is set up to approve on Telegram. Use a manager PIN.' });
    const row = createRequest(db, {
      orderId: Number(order_id), itemId: Number(item_id), action, reason,
      note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 200) : null,
      requestedBy: String((req as any).user.userId),
    });
    const sent = await sendApprovalRequest(row.id, db);
    if (!sent) {
      cancelRequest(db, row.id);
      return res.status(502).json({ error: 'Could not reach Telegram. Use a manager PIN.' });
    }
    res.status(201).json({ id: row.id, status: 'pending', sentTo: sent });
  } catch (error) { fail(res, error); }
});

router.get('/:id', requirePermission('orders.read'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const row = getRequest(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Request not found' });
    const decider = row.decided_by ? (db.prepare('SELECT name FROM users WHERE id = ?').get(row.decided_by) as { name?: string } | undefined)?.name : null;
    res.json({ id: row.id, status: row.status, action: row.action, decidedBy: decider ?? null, decidedAt: row.decided_at });
  } catch (error) { fail(res, error); }
});

router.delete('/:id', requirePermission('orders.read'), async (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const id = Number(req.params.id);
    const row = getRequest(db, id);
    if (!row) return res.status(404).json({ error: 'Request not found' });
    if (row.status === 'pending') {
      cancelRequest(db, id);
      void closeApprovalMessages(id, '↩︎ Cancelled at the till', db).catch(() => undefined);
    }
    res.json({ id, status: getRequest(db, id)?.status });
  } catch (error) { fail(res, error); }
});

export const itemApprovalRoutes = router;
