import { Router, Request, Response } from 'express';
import { requirePermission } from '../services/authorization';
import {
  createLinkCode, listDeliveries, listRecipients, refreshStatus, removeRecipient, saveSchedule, sendTest, setEnabled, updateRecipient,
} from '../services/telegram';

const router = Router();
const manage = [requirePermission('settings.manage'), requirePermission('reports.financial.view')];

function actorId(req: Request): string {
  return String((req as Request & { user?: { userId?: string } }).user?.userId || '');
}

function fail(res: Response, error: unknown): void {
  const { statusCode, message } = error as { statusCode?: number; message?: string };
  if (!statusCode) console.error('[Telegram] route error:', message);
  res.status(statusCode || 500).json({ error: statusCode ? message : 'Internal server error' });
}

router.get('/status', ...manage, async (_req: Request, res: Response) => {
  try { res.json({ status: await refreshStatus(), recipients: listRecipients(), deliveries: listDeliveries() }); } catch (error) { fail(res, error); }
});

router.post('/connect', ...manage, async (_req: Request, res: Response) => {
  try { res.json({ status: await setEnabled(true) }); } catch (error) { fail(res, error); }
});

router.post('/disconnect', ...manage, async (_req: Request, res: Response) => {
  try { res.json({ status: await setEnabled(false) }); } catch (error) { fail(res, error); }
});

router.post('/link-code', ...manage, (req: Request, res: Response) => {
  try { res.json(createLinkCode(actorId(req))); } catch (error) { fail(res, error); }
});

router.put('/recipients/:id', ...manage, (req: Request, res: Response) => {
  try { res.json({ recipient: updateRecipient(Number(req.params.id), req.body || {}) }); } catch (error) { fail(res, error); }
});

router.delete('/recipients/:id', ...manage, (req: Request, res: Response) => {
  try { removeRecipient(Number(req.params.id)); res.json({ ok: true }); } catch (error) { fail(res, error); }
});

router.put('/schedule', ...manage, (req: Request, res: Response) => {
  try { res.json({ schedule: saveSchedule(req.body || {}) }); } catch (error) { fail(res, error); }
});

router.post('/test', ...manage, async (req: Request, res: Response) => {
  try {
    const id = req.body?.recipient_id === undefined || req.body?.recipient_id === null ? null : Number(req.body.recipient_id);
    const count = await sendTest(id);
    res.json({ queued: count, deliveries: listDeliveries() });
  } catch (error) { fail(res, error); }
});

router.get('/deliveries', ...manage, (_req: Request, res: Response) => {
  try { res.json({ deliveries: listDeliveries(50) }); } catch (error) { fail(res, error); }
});

export const telegramRoutes = router;
