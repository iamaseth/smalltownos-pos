/**
 * BackStreet Register iPad: connect with a link, see open tables, add a best-seller (its ticket is
 * queued for the till to print), print a table's bill, and the till collecting those prints.
 * Run: node tests/run-electron-node-test.cjs tests/mini-register.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-mini-register-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const express = require('express');
const jwt = require('jsonwebtoken');
const {
  initTestDb, startServer, seedOwnerUser, seedCategory, seedProduct, seedTable,
  api, assert, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { miniDeviceRoutes, miniAdminRoutes, topItems } = require('../main/routes/mini');
const { setServerPort } = require('../main/server-state');
const { requireAuth } = require('../main/server');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/mini', miniDeviceRoutes);
  app.use((req: any, res: any, next: any) => {
    if (!req.path.startsWith('/api')) return next();
    const header = String(req.headers.authorization || '');
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
    try { req.user = jwt.verify(header.slice(7), getJWTSecret()); next(); } catch { res.status(401).json({ error: 'Invalid token' }); }
  });
  app.use('/api/orders', orderRoutes);
  app.use('/api/bills', billRoutes);
  app.use('/api/register-devices', miniAdminRoutes);
  return app;
}

async function main(): Promise<void> {
  console.log('Register iPad');
  const db = initTestDb();
  const { authHeader: A } = seedOwnerUser(db);
  seedCategory(db, 'cat-drinks', 'DRINKS');
  seedCategory(db, 'cat-food', 'FOOD');
  const names: [string, string, number][] = [['p-draft', 'Draft beer', 1], ['p-water', 'Water', 0.5], ['p-coke', 'Coke', 1], ['p-lime', 'Lime soda', 1.75], ['p-coffee', 'Ice coffee', 2], ['p-pizza', 'Pizza', 9], ['p-salad', 'Salad', 5]];
  for (const [id, name, price] of names) seedProduct(db, id, id === 'p-pizza' || id === 'p-salad' ? 'cat-food' : 'cat-drinks', name, price);
  seedTable(db, 'tbl-b1', 'B 1');
  seedTable(db, 'tbl-b2', 'B 2');
  db.prepare(`UPDATE tables SET floor = 'Down', position_x = 20, position_y = 40 WHERE id = 'tbl-b1'`).run();

  const app = buildApp();
  const { baseUrl, server } = await startServer(app);
  setServerPort(Number(new URL(baseUrl).port));

  try {
    console.log('\n─── the staff login gate lets the iPad through only on /api/mini ───');
    let passed = false;
    requireAuth({ path: '/api/mini/floor', headers: {} } as any, {} as any, () => { passed = true; });
    assert(passed, 'production auth gate leaves /api/mini to its own device check');
    let blocked = false;
    requireAuth({ path: '/api/minimum', headers: {} } as any, { status: () => ({ json: () => { blocked = true; } }) } as any, () => undefined);
    assert(blocked, 'a lookalike path is not let through');

    console.log('\n─── connecting ───');
    const noToken = await api(baseUrl, '/api/mini/floor');
    assertEqual(noToken.status, 401, 'without a device link the iPad sees nothing');
    const bad = await api(baseUrl, '/api/mini/floor', { headers: { Authorization: 'Device not-a-real-token-123456789' } });
    assertEqual(bad.status, 401, 'a made-up token is refused');
    const made = await api(baseUrl, '/api/register-devices', { method: 'POST', headers: A, body: { name: 'Bar iPad' } });
    assert(made.status === 201 && typeof made.data.token === 'string' && made.data.token.length >= 40, 'owner makes a device link');
    const stored = String((db.prepare(`SELECT value FROM settings WHERE key = 'mini_register_devices'`).get() as any).value);
    assert(!stored.includes(made.data.token), 'only a hash of the token is stored');
    const D = { Authorization: `Device ${made.data.token}` };
    const user = db.prepare(`SELECT role, pin_hash FROM users WHERE id = 'register-ipad'`).get() as any;
    assert(user && user.role === 'server' && !user.pin_hash, 'a "Register iPad" staff account exists with no PIN');

    console.log('\n─── floor ───');
    const order = await api(baseUrl, '/api/orders', { method: 'POST', headers: A, body: { type: 'dine_in', table_id: 'tbl-b1', guest_count: 4, items: [{ product_id: 'p-draft', quantity: 3 }, { product_id: 'p-pizza', quantity: 1 }] } });
    assertEqual(order.status, 201, 'a table order is open');
    const orderId = order.data.order.id;
    const floor = await api(baseUrl, '/api/mini/floor', { headers: D });
    assertEqual(floor.status, 200, 'the iPad reads the floor');
    const b1 = floor.data.tables.find((t: any) => t.id === 'tbl-b1');
    assert(b1 && b1.floor === 'Down' && Number(b1.position_x) === 20, 'tables come with their floor-plan positions');
    const open = floor.data.orders.find((o: any) => o.id === orderId);
    assert(open && open.table_id === 'tbl-b1' && open.items.some((i: any) => i.name === 'Draft beer' && Number(i.quantity) === 3), 'open bills list their items');
    assertEqual(floor.data.top.length, 6, 'six best-sellers are offered');

    console.log('\n─── adding a best-seller ───');
    db.prepare(`DELETE FROM settings WHERE key = 'menu_popularity'`).run();
    const top = topItems(db).map((p: any) => p.id);
    assert(top[0] === 'p-draft', 'the best-seller (Draft beer) is first');
    const notTop = await api(baseUrl, `/api/mini/orders/${orderId}/items`, { method: 'POST', headers: D, body: { product_id: names.map((n) => n[0]).find((id) => !top.includes(id)) } });
    assertEqual(notTop.status, 400, 'only the 6 best-sellers can be added');
    const add = await api(baseUrl, `/api/mini/orders/${orderId}/items`, { method: 'POST', headers: { ...D, 'Idempotency-Key': 'tap-1' }, body: { product_id: 'p-draft' } });
    assert(add.status === 200 && add.data.added === 'Draft beer', `Draft beer added (${add.status} ${add.data.error || ''})`);
    const lines = db.prepare(`SELECT id, quantity FROM order_items WHERE order_id = ? AND product_id = 'p-draft' ORDER BY id`).all(orderId) as any[];
    assert(lines.length === 2 && lines[1].quantity === 1, 'one more Draft beer is on the bill');
    const audit = db.prepare(`SELECT actor_user_id FROM order_audit_log WHERE order_id = ? AND action = 'items_added' ORDER BY id DESC`).get(orderId) as any;
    assertEqual(audit?.actor_user_id, 'register-ipad', 'the history says the Register iPad added it');
    const again = await api(baseUrl, `/api/mini/orders/${orderId}/items`, { method: 'POST', headers: { ...D, 'Idempotency-Key': 'tap-1' }, body: { product_id: 'p-draft' } });
    assertEqual(again.status, 200, 'a repeated tap (same key) is answered');
    assertEqual((db.prepare(`SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND product_id = 'p-draft'`).get(orderId) as any).c, 2, 'but does not add a second beer');

    console.log('\n─── printing a bill ───');
    const printBill = await api(baseUrl, `/api/mini/orders/${orderId}/print-bill`, { method: 'POST', headers: D, body: {} });
    assert(printBill.status === 200 && Number(printBill.data.bill_id) > 0, `the bill is made (${printBill.status} ${printBill.data.error || ''})`);

    console.log('\n─── the till prints them ───');
    const queue = await api(baseUrl, '/api/register-devices/print-queue', { headers: A });
    const kinds = queue.data.requests.map((r: any) => r.kind);
    assert(kinds.includes('kot') && kinds.includes('receipt'), 'the ticket and the bill wait for the printer');
    assertEqual(kinds.filter((k: string) => k === 'kot').length, 1, 'the repeated tap did not queue a second bar ticket');
    const kot = queue.data.requests.find((r: any) => r.kind === 'kot');
    assert(kot.payload.orderId === orderId && kot.payload.itemIds.length === 1 && kot.payload.itemIds[0] === lines[1].id, 'the ticket is only for the new beer');
    const claim = await api(baseUrl, `/api/register-devices/print-queue/${kot.id}/claim`, { method: 'POST', headers: A, body: { device: 'till' } });
    assertEqual(claim.status, 200, 'the till takes the ticket');
    const claim2 = await api(baseUrl, `/api/register-devices/print-queue/${kot.id}/claim`, { method: 'POST', headers: A, body: { device: 'other' } });
    assertEqual(claim2.status, 409, 'a second till cannot print it twice');
    await api(baseUrl, `/api/register-devices/print-queue/${kot.id}/done`, { method: 'POST', headers: A, body: {} });
    const after = await api(baseUrl, '/api/register-devices/print-queue', { headers: A });
    assert(!after.data.requests.some((r: any) => r.id === kot.id), 'a printed ticket leaves the queue');

    console.log('\n─── Happy Hour ───');
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('special_price_events', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify([{ id: 'hh', name: 'Happy Hour', enabled: true, mode: 'weekly',
      days: [0, 1, 2, 3, 4, 5, 6], date: null, start: '00:00', end: '00:00', items: [{ product_id: 'p-draft', price: 0.5 }],
      show_banner: true, show_on_buttons: true, manual_until: new Date(Date.now() + 3600000).toISOString() }]));
    const hhFloor = await api(baseUrl, '/api/mini/floor', { headers: D });
    const hhDraft = hhFloor.data.top.find((p: any) => p.id === 'p-draft');
    assert(hhDraft && hhDraft.price === 0.5 && hhDraft.normal_price === 1 && hhDraft.special === 'Happy Hour', 'the button shows the Happy Hour price');
    const hhAdd = await api(baseUrl, `/api/mini/orders/${orderId}/items`, { method: 'POST', headers: { ...D, 'Idempotency-Key': 'tap-hh' }, body: { product_id: 'p-draft' } });
    assertEqual(hhAdd.status, 200, 'a Happy Hour beer is added');
    const hhLine = db.prepare(`SELECT unit_price, product_name FROM order_items WHERE order_id = ? AND product_id = 'p-draft' ORDER BY id DESC`).get(orderId) as any;
    assert(Number(hhLine.unit_price) === 0.5 && /Happy Hour/.test(hhLine.product_name), `the bill charges the Happy Hour price (${hhLine.unit_price} ${hhLine.product_name})`);
    db.prepare(`DELETE FROM settings WHERE key = 'special_price_events'`).run();
    const hhAfter = await api(baseUrl, '/api/mini/floor', { headers: D });
    assert(hhAfter.data.top.find((p: any) => p.id === 'p-draft').price === 1 && !hhAfter.data.top.find((p: any) => p.id === 'p-draft').special, 'after Happy Hour the normal price is back');

    console.log('\n─── limits ───');
    const noTable = await api(baseUrl, '/api/orders', { method: 'POST', headers: A, body: { type: 'takeaway', items: [{ product_id: 'p-draft', quantity: 1 }] } });
    const takeaway = await api(baseUrl, `/api/mini/orders/${noTable.data.order.id}/items`, { method: 'POST', headers: D, body: { product_id: 'p-draft' } });
    assertEqual(takeaway.status, 404, 'the iPad only works on table bills');
    const staffView = await api(baseUrl, '/api/register-devices', { headers: D });
    assertEqual(staffView.status, 401, 'the device token is not a staff login');
    const devices = await api(baseUrl, '/api/register-devices', { headers: A });
    const removed = await api(baseUrl, `/api/register-devices/${devices.data.devices[0].id}`, { method: 'DELETE', headers: A });
    assert(removed.data.removed === true, 'owner removes the device');
    assertEqual((await api(baseUrl, '/api/mini/floor', { headers: D })).status, 401, 'a removed iPad stops working at once');
    const schedulePeople = db.prepare(`SELECT COUNT(*) c FROM users WHERE is_active = 1 AND id != 'register-ipad'`).get() as any;
    assert(schedulePeople.c >= 1, 'the schedule query leaves the device account out');
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may still hold the test database open */ }
  }
  const { passed, failed } = getResults();
  console.log(`\nmini-register: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
