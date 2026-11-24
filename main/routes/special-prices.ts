import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requirePermission } from '../services/authorization';
import { tenantTimezone } from './cash-closures';
import {
  activeSpecialPrices, isEventActive, normalizeSpecialPriceEvents, readSpecialPriceEvents, saveSpecialPriceEvents,
} from '../services/special-prices';

const router = Router();

function fail(res: Response, error: unknown) {
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (!statusCode) console.error('[SpecialPrices]', error);
  res.status(statusCode || 500).json({ error: statusCode ? (error as Error).message : 'Internal server error' });
}

function snapshot() {
  const db = getDatabase();
  const events = readSpecialPriceEvents();
  const now = new Date();
  const tz = tenantTimezone();
  const priceOf = db.prepare('SELECT price FROM products WHERE id = ?');
  const prices = activeSpecialPrices(events, now, tz, (id) => {
    const row = priceOf.get(id) as { price: number } | undefined;
    return row ? Number(row.price) : null;
  });
  const active = events.filter((e) => isEventActive(e, now, tz))
    .map((e) => ({ id: e.id, name: e.name, show_banner: e.show_banner, show_on_buttons: e.show_on_buttons, manual_until: e.manual_until }));
  return { events, active, prices: Object.fromEntries(prices), timezone: tz, now: now.toISOString() };
}

router.get('/', requirePermission('orders.read'), (_req: Request, res: Response) => {
  try { res.json(snapshot()); } catch (error) { fail(res, error); }
});

router.put('/', requirePermission('settings.manage'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const exists = db.prepare('SELECT 1 FROM products WHERE id = ?');
    const events = normalizeSpecialPriceEvents(req.body?.events, (id) => Boolean(exists.get(id)));
    saveSpecialPriceEvents(events);
    res.json(snapshot());
  } catch (error) { fail(res, error); }
});

function setManual(req: Request, res: Response, until: string | null) {
  try {
    const events = readSpecialPriceEvents();
    const event = events.find((e) => e.id === req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    event.manual_until = until;
    if (until) event.enabled = true;
    saveSpecialPriceEvents(events);
    const actor = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
    console.log(`[SpecialPrices] ${event.name} ${until ? `started until ${until}` : 'stopped'} by ${actor}`);
    res.json(snapshot());
  } catch (error) { fail(res, error); }
}

router.post('/:id/start', requirePermission('settings.manage'), (req: Request, res: Response) => {
  const hours = Number(req.body?.hours ?? 2);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 12) return res.status(400).json({ error: 'Choose between 1 and 12 hours' });
  setManual(req, res, new Date(Date.now() + hours * 3_600_000).toISOString());
});

router.post('/:id/stop', requirePermission('settings.manage'), (req: Request, res: Response) => {
  setManual(req, res, null);
});


export { router as specialPriceRoutes };
