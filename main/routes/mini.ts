/**
 * BackStreet: the Register iPad. Two routers:
 *
 * - miniDeviceRoutes (/api/mini): used by the iPad page (/mini.html). Skips the normal staff login
 *   (see requireAuth in server.ts) and checks the device token on every request instead. It can
 *   only: read the floor (tables, open bills, the 6 best-sellers), add one best-seller to an open
 *   order (prints a kitchen/bar ticket) and print a table's bill. The work itself goes through the
 *   normal order and bill routes as the "Register iPad" staff account, so prices, taxes, shift
 *   rules and the order history are exactly the same as on the till.
 * - miniAdminRoutes (/api/register-devices): staff login as normal. The owner adds/removes devices;
 *   the till on the printer computer collects and prints the iPad's print requests.
 */
import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { getDatabase } from '../db';
import { requirePermission } from '../services/authorization';
import { getJWTSecret } from '../security/jwt-secret';
import { getServerPort } from '../server-state';
import { tenantTimezone } from './cash-closures';
import { getMenuPopularity } from '../services/menu-popularity';
import { isSpecialItemProduct } from '../services/special-items';
import {
  MINI_DEVICE_USER_ID, authenticateDevice, claimPrint, createDevice, enqueuePrint, ensureDeviceUser,
  finishPrint, listDevices, removeDevice, waitingPrints,
} from '../services/mini-register';

const REMOVED_ITEM = ['cancelled', 'voided', 'void_adjustment', 'refunded'];
const TOP_COUNT = 6;

function fail(res: Response, error: unknown) {
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (!statusCode) console.error('[Mini]', error);
  res.status(statusCode || 500).json({ error: statusCode ? (error as Error).message : 'Something went wrong' });
}

// ── The iPad ───────────────────────────────────────────────────────────────

const device = Router();

device.use((req: Request, res: Response, next: NextFunction) => {
  const header = String(req.headers.authorization || '');
  const found = header.startsWith('Device ') ? authenticateDevice(header.slice(7).trim()) : null;
  if (!found) {
    res.status(401).json({ error: 'This device is not connected. Open the link from Settings → Register iPad.', code: 'device_unknown' });
    return;
  }
  (req as Request & { miniDevice?: typeof found }).miniDevice = found;
  next();
});

/** The 6 best-selling items of the last 30 days that are on the menu now (menu order if nothing sold yet). */
export function topItems(db: ReturnType<typeof getDatabase> = getDatabase()): { id: string; name: string; price: number; has_image: boolean; v: string }[] {
  const products = db.prepare(`
    SELECT p.id, p.name, p.price, p.tags, p.sort_order, p.updated_at,
      CASE WHEN p.image_url IS NULL OR p.image_url = '' THEN 0 ELSE 1 END AS has_image
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.is_active = 1 AND p.deleted_at IS NULL AND (c.id IS NULL OR (c.is_active = 1 AND c.deleted_at IS NULL))
  `).all() as { id: string; name: string; price: number; tags: string | null; sort_order: number; updated_at: string | null; has_image: number }[];
  const sellable = products.filter((p) => !isSpecialItemProduct(p));
  let sold: Record<string, number> = {};
  try { sold = getMenuPopularity(db, new Date(), tenantTimezone()).sold || {}; } catch { /* menu order below */ }
  return sellable
    .sort((a, b) => (sold[b.id] || 0) - (sold[a.id] || 0) || (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name))
    .slice(0, TOP_COUNT)
    .map((p) => ({ id: p.id, name: p.name, price: Number(p.price), has_image: p.has_image === 1, v: p.updated_at || '' }));
}

function floor() {
  const db = getDatabase();
  const tables = db.prepare(`
    SELECT id, number, capacity, floor, section, position_x, position_y FROM tables
    WHERE is_active = 1 ORDER BY floor, number
  `).all() as { id: string }[];
  const orders = db.prepare(`
    SELECT o.id, o.order_number, o.table_id, o.guest_count, o.total, o.tab_name, o.created_at
    FROM orders o WHERE o.table_id IS NOT NULL AND o.status NOT IN ('completed', 'cancelled')
    ORDER BY o.created_at
  `).all() as { id: number; table_id: string }[];
  const itemsOf = db.prepare(`
    SELECT product_name AS name, SUM(quantity) AS quantity, SUM(total) AS total FROM order_items
    WHERE order_id = ? AND COALESCE(status, 'pending') NOT IN (${REMOVED_ITEM.map(() => '?').join(',')})
    GROUP BY product_name, unit_price ORDER BY MIN(id)
  `);
  const open = orders.map((o) => ({ ...o, items: itemsOf.all(o.id, ...REMOVED_ITEM) }));
  return { tables, orders: open, top: topItems(db), at: new Date().toISOString() };
}

device.get('/floor', (_req: Request, res: Response) => {
  try { res.json(floor()); } catch (error) { fail(res, error); }
});

/** Run a normal POS route as the Register iPad account (same rules as the till). */
async function asRegister(method: 'POST', path: string, body: unknown, idempotencyKey?: string): Promise<{ status: number; data: any }> {
  ensureDeviceUser();
  const token = jwt.sign({ userId: MINI_DEVICE_USER_ID, email: 'register-ipad@device.local', role: 'server' }, getJWTSecret(), { expiresIn: '2m' });
  const response = await fetch(`http://127.0.0.1:${getServerPort()}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
  return { status: response.status, data };
}

function openTableOrder(orderId: unknown): { id: number; table_id: string; table_number: string } {
  const order = getDatabase().prepare(`
    SELECT o.id, o.table_id, t.number AS table_number FROM orders o JOIN tables t ON t.id = o.table_id
    WHERE o.id = ? AND o.status NOT IN ('completed', 'cancelled')
  `).get(Number(orderId)) as { id: number; table_id: string; table_number: string } | undefined;
  if (!order) throw Object.assign(new Error('That table has no open bill'), { statusCode: 404 });
  return order;
}

// Add one best-seller to a table's open bill, then send its kitchen/bar ticket to the printer.
device.post('/orders/:orderId/items', async (req: Request, res: Response) => {
  try {
    const order = openTableOrder(req.params.orderId);
    const productId = String(req.body?.product_id ?? '');
    const top = topItems();
    const item = top.find((p) => String(p.id) === productId);
    if (!item) throw Object.assign(new Error('Only the 6 best-sellers can be added here'), { statusCode: 400 });
    const key = String(req.get('Idempotency-Key') || '').slice(0, 100) || randomUUID();
    const result = await asRegister('POST', `/orders/${order.id}/items`, { items: [{ product_id: item.id, quantity: 1 }] }, `mini:${key}`);
    if (result.status >= 400) {
      return res.status(result.status).json({ error: result.data?.error || 'Could not add the item' });
    }
    const after = (result.data?.order?.items || []) as { id: number; product_id: string }[];
    const added = after.filter((i) => String(i.product_id) === String(item.id)).map((i) => Number(i.id));
    const newest = added.length ? [Math.max(...added)] : [];
    if (newest.length) enqueuePrint('kot', `${order.table_number}: ${item.name}`, { orderId: order.id, itemIds: newest });
    res.json({ ok: true, added: item.name, floor: floor() });
  } catch (error) { fail(res, error); }
});

// Make (or refresh) the table's bill and send it to the printer.
device.post('/orders/:orderId/print-bill', async (req: Request, res: Response) => {
  try {
    const order = openTableOrder(req.params.orderId);
    const result = await asRegister('POST', '/bills/generate', { order_id: order.id });
    if (result.status >= 400) {
      return res.status(result.status).json({ error: result.data?.error || 'Could not make the bill' });
    }
    const billId = Number(result.data?.bill?.id);
    if (!billId) throw Object.assign(new Error('The bill was not made'), { statusCode: 500 });
    enqueuePrint('receipt', `Bill ${order.table_number}`, { billId, orderId: order.id });
    res.json({ ok: true, bill_id: billId });
  } catch (error) { fail(res, error); }
});

// ── Staff side ─────────────────────────────────────────────────────────────

const admin = Router();

admin.get('/', requirePermission('settings.manage'), (_req: Request, res: Response) => {
  res.json({ devices: listDevices() });
});

admin.post('/', requirePermission('settings.manage'), (req: Request, res: Response) => {
  try { res.status(201).json(createDevice(req.body?.name)); } catch (error) { fail(res, error); }
});

admin.delete('/:id', requirePermission('settings.manage'), (req: Request, res: Response) => {
  res.json({ removed: removeDevice(String(req.params.id)), devices: listDevices() });
});

// The till on the printer computer asks for the iPad's print requests every few seconds.
admin.get('/print-queue', requirePermission('pos.use'), (_req: Request, res: Response) => {
  res.json({ requests: waitingPrints() });
});

admin.post('/print-queue/:id/claim', requirePermission('pos.use'), (req: Request, res: Response) => {
  const userId = String((req as any).user?.userId ?? '');
  const claimed = claimPrint(String(req.params.id), String(req.body?.device ?? userId));
  if (!claimed) return res.status(409).json({ error: 'Already taken by another till' });
  res.json({ request: claimed });
});

admin.post('/print-queue/:id/done', requirePermission('pos.use'), (req: Request, res: Response) => {
  res.json({ done: finishPrint(String(req.params.id)) });
});

export { device as miniDeviceRoutes, admin as miniAdminRoutes };
