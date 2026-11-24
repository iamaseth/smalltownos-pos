/**
 * Special prices (happy hour and other events): schedule rules in store time, lowest price wins,
 * prices applied by the server when items are ordered, and who may change the events.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/special-prices.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-special-prices-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-special-prices';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initTestDb, createApp, startServer, api, assertOrThrow, assertEqualOrThrow, closeDatabase, now } = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes } = require('../main/routes/orders');
const { registerRoutes } = require('../main/routes/index');
const sp = require('../main/services/special-prices');

function seedUser(db: any, id: string, role: string) {
  const email = `${id}@test.local`;
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(id, id, email, bcrypt.hashSync('pw', 4), role, now(), now());
  return { Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}` };
}

const TZ = 'Asia/Phnom_Penh';
const at = (local: string) => new Date(`${local}+07:00`);
const ev = (over: Record<string, unknown>) => ({
  id: 'e1', name: 'Happy hour', enabled: true, mode: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], date: null, start: '17:00', end: '19:00',
  items: [{ product_id: 'p-beer', price: 1 }], show_banner: true, show_on_buttons: true, manual_until: null, ...over,
});

async function main() {
  console.log('Special prices');
  console.log('='.repeat(50));

  console.log('Section 1: schedule rules');
  assertOrThrow(sp.isEventActive(ev({}), at('2026-11-24T17:30:00'), TZ), 'weekly event runs inside its hours');
  assertOrThrow(!sp.isEventActive(ev({}), at('2026-11-24T19:00:00'), TZ), 'it ends at the end time');
  assertOrThrow(!sp.isEventActive(ev({}), at('2026-11-24T16:59:00'), TZ), 'not before the start');
  assertOrThrow(!sp.isEventActive(ev({ days: [1] }), at('2026-11-24T17:30:00'), TZ), 'only on chosen days (24 Nov 2026 is a Tuesday)');
  assertOrThrow(!sp.isEventActive(ev({ enabled: false }), at('2026-11-24T17:30:00'), TZ), 'switched-off event never runs');
  const late = ev({ days: [5], start: '20:00', end: '02:00' });
  assertOrThrow(sp.isEventActive(late, at('2026-11-27T23:00:00'), TZ), 'overnight Friday event runs Friday 11 pm');
  assertOrThrow(sp.isEventActive(late, at('2026-11-28T01:30:00'), TZ), 'and carries into Saturday 1:30 am');
  assertOrThrow(!sp.isEventActive(late, at('2026-11-28T21:00:00'), TZ), 'but not Saturday evening');
  const party = ev({ mode: 'date', date: '2026-12-31', days: [], start: '21:00', end: '03:00' });
  assertOrThrow(sp.isEventActive(party, at('2026-12-31T22:00:00'), TZ) && sp.isEventActive(party, at('2027-01-01T02:00:00'), TZ), 'one-date party runs past midnight');
  assertOrThrow(!sp.isEventActive(party, at('2026-12-30T22:00:00'), TZ), 'one-date party only on its date');
  const manual = ev({ days: [1], manual_until: new Date(at('2026-11-24T12:00:00').getTime() + 3_600_000).toISOString() });
  assertOrThrow(sp.isEventActive(manual, at('2026-11-24T12:30:00'), TZ), 'Start now runs outside the schedule');

  console.log('Section 2: lowest price wins, never above normal');
  const both = [ev({}), ev({ id: 'e2', name: 'Live music', items: [{ product_id: 'p-beer', price: 0.75 }, { product_id: 'p-wine', price: 9 }] })];
  const prices = sp.activeSpecialPrices(both, at('2026-11-24T18:00:00'), TZ, (id: string) => (id === 'p-beer' ? 1.5 : id === 'p-wine' ? 6 : null));
  assertEqualOrThrow(prices.get('p-beer')?.price, 0.75, 'lowest event price wins');
  assertEqualOrThrow(prices.get('p-beer')?.eventName, 'Live music', 'winning event name is kept');
  assertOrThrow(!prices.has('p-wine'), 'an event price above the normal price is ignored');

  console.log('Section 3: validation');
  const exists = (id: string) => id === 'p-beer';
  let threw = '';
  try { sp.normalizeSpecialPriceEvents([ev({ name: '' })], exists); } catch (e: any) { threw = e.message; }
  assertOrThrow(threw.includes('needs a name'), 'event needs a name');
  threw = '';
  try { sp.normalizeSpecialPriceEvents([ev({ items: [{ product_id: 'nope', price: 1 }] })], exists); } catch (e: any) { threw = e.message; }
  assertOrThrow(threw.includes('no longer exists'), 'unknown drink rejected');
  threw = '';
  try { sp.normalizeSpecialPriceEvents([ev({ items: [{ product_id: 'p-beer', price: -1 }] })], exists); } catch (e: any) { threw = e.message; }
  assertOrThrow(threw.includes('valid price'), 'negative price rejected');
  threw = '';
  try { sp.normalizeSpecialPriceEvents([ev({ start: '17:00', end: '17:00' })], exists); } catch (e: any) { threw = e.message; }
  assertOrThrow(threw.includes('start and end'), 'start and end must differ');

  console.log('Section 4: orders get the event price from the server');
  const db = initTestDb();
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('timezone', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(TZ, now());
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('c-bar', 'Bar', 1)`).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, created_at, updated_at) VALUES ('p-beer', 'c-bar', 'Angkor Draft', 1.5, 'none', 1, 1, ?, ?), ('p-water', 'c-bar', 'Water', 1, 'none', 1, 2, ?, ?)`).run(now(), now(), now(), now());
  const owner = seedUser(db, 'own', 'owner');
  const cashier = seedUser(db, 'csh', 'cashier');
  const app = createApp({ '/api/orders': orderRoutes });
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);
  const call = (p: string, method: string, body: any, headers: any) => api(baseUrl, p, { method, body, headers });
  try {
    const allDay = { ...ev({ start: '00:00', end: '23:59' }), items: [{ product_id: 'p-beer', price: 1 }] };
    const denied = await call('/api/special-prices', 'PUT', { events: [allDay] }, cashier);
    assertEqualOrThrow(denied.status, 403, 'cashier cannot change special prices');
    const saved = await call('/api/special-prices', 'PUT', { events: [allDay] }, owner);
    assertEqualOrThrow(saved.status, 200, `owner saves an event (${saved.data?.error || ''})`);
    const seen = await call('/api/special-prices', 'GET', undefined, cashier);
    assertEqualOrThrow(seen.status, 200, 'cashier can read what is on now');
    assertEqualOrThrow(seen.data.prices['p-beer']?.price, 1, 'active price is listed for the POS');
    const created = await call('/api/orders', 'POST', { type: 'takeaway', items: [{ product_id: 'p-beer', quantity: 2 }, { product_id: 'p-water', quantity: 1 }] }, cashier);
    assertEqualOrThrow(created.status, 201, `order created (${created.data?.error || ''})`);
    const items = db.prepare('SELECT product_name, unit_price FROM order_items WHERE order_id = ? ORDER BY id').all(created.data.order.id) as any[];
    assertEqualOrThrow(Number(items[0].unit_price), 1, 'beer charged at the event price');
    assertEqualOrThrow(items[0].product_name, 'Angkor Draft · Happy hour', 'item name shows the event');
    assertEqualOrThrow(Number(items[1].unit_price), 1, 'water keeps its normal price');
    assertEqualOrThrow(Number(created.data.order.total), 3, 'order total uses the event price');
    const added = await call(`/api/orders/${created.data.order.id}/items`, 'POST', { items: [{ product_id: 'p-beer', quantity: 1 }] }, cashier);
    assertEqualOrThrow(added.status, 200, 'items added to an open order');
    const last = db.prepare('SELECT unit_price FROM order_items WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(created.data.order.id) as any;
    assertEqualOrThrow(Number(last.unit_price), 1, 'added beer also gets the event price');
    const off = await call('/api/special-prices', 'PUT', { events: [{ ...allDay, enabled: false }] }, owner);
    assertEqualOrThrow(off.status, 200, 'owner switches the event off');
    const normal = await call('/api/orders', 'POST', { type: 'takeaway', items: [{ product_id: 'p-beer', quantity: 1 }] }, cashier);
    const normalItem = db.prepare('SELECT product_name, unit_price FROM order_items WHERE order_id = ?').get(normal.data.order.id) as any;
    assertOrThrow(Number(normalItem.unit_price) === 1.5 && normalItem.product_name === 'Angkor Draft', 'switched off: normal price and name');
    const start = await call('/api/special-prices/e1/start', 'POST', { hours: 2 }, owner);
    assertOrThrow(start.status === 200 && start.data.active.length === 1, 'Start now turns it on');
    const stop = await call('/api/special-prices/e1/stop', 'POST', {}, owner);
    assertEqualOrThrow(stop.status, 200, 'Stop works');
    console.log('='.repeat(50));
    console.log('All special price checks passed');
  } finally {
    server.close();
    closeDatabase();
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
