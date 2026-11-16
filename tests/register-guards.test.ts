/**
 * Register guards: orders refuse products that are switched off or deleted, and
 * the owner can turn on the open-shift requirement for cash from settings.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/register-guards.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-register-guards-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct,
  api, assertOrThrow, assertEqualOrThrow, closeDatabase, now,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { settingsRoutes } = require('../main/routes/settings');

async function main() {
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-guard', 'Drinks');
  seedProduct(db, 'prod-live', 'cat-guard', 'Beer', 300);
  seedProduct(db, 'prod-off', 'cat-guard', 'Old cocktail', 500);
  seedProduct(db, 'prod-gone', 'cat-guard', 'Deleted wine', 700);
  db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run('prod-off');
  db.prepare('UPDATE products SET deleted_at = ? WHERE id = ?').run(now(), 'prod-gone');

  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes, '/api/settings': settingsRoutes });
  const { baseUrl, server } = await startServer(app);
  const orderCount = () => (db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
  try {
    const before = orderCount();
    for (const [productId, label] of [['prod-off', 'switched-off'], ['prod-gone', 'deleted'], ['prod-missing', 'unknown']]) {
      const res = await api(baseUrl, '/api/orders', { method: 'POST', headers: authHeader, body: { type: 'takeaway', items: [{ product_id: productId, quantity: 1 }] } });
      assertEqualOrThrow(res.status, 400, `new order with a ${label} product is refused`);
    }
    assertEqualOrThrow(orderCount(), before, 'refused orders leave nothing behind');

    const order = await api(baseUrl, '/api/orders', { method: 'POST', headers: authHeader, body: { type: 'takeaway', items: [{ product_id: 'prod-live', quantity: 1 }] } });
    assertEqualOrThrow(order.status, 201, 'order with an active product is accepted');
    const orderId = order.data.order.id;
    const addOff = await api(baseUrl, `/api/orders/${orderId}/items`, { method: 'POST', headers: authHeader, body: { items: [{ product_id: 'prod-off', quantity: 1 }] } });
    assertEqualOrThrow(addOff.status, 400, 'adding a switched-off product to an open order is refused');
    assertOrThrow(String(addOff.data.error).includes('Old cocktail'), 'the refusal names the product');
    const itemCount = (db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?').get(orderId) as { n: number }).n;
    assertEqualOrThrow(itemCount, 1, 'the open order keeps only its original line');

    const badSetting = await api(baseUrl, '/api/settings/require_open_shift', { method: 'PUT', headers: authHeader, body: { value: 'maybe' } });
    assertEqualOrThrow(badSetting.status, 400, 'open-shift setting accepts only true or false');
    const turnOn = await api(baseUrl, '/api/settings/require_open_shift', { method: 'PUT', headers: authHeader, body: { value: 'true' } });
    assertEqualOrThrow(turnOn.status, 200, 'owner can turn on the open-shift requirement');
    const readBack = await api(baseUrl, '/api/settings/require_open_shift', { headers: authHeader });
    assertEqualOrThrow(readBack.data.setting.value, 'true', 'open-shift setting is saved');

    const bill = await api(baseUrl, '/api/bills/generate', { method: 'POST', headers: authHeader, body: { order_id: orderId } });
    assertEqualOrThrow(bill.status, 201, 'bill generated');
    const billId = bill.data.bill.id;
    const total = Number(bill.data.bill.total);
    const cash = await api(baseUrl, `/api/bills/${billId}/payments`, { method: 'POST', headers: authHeader, body: { payments: [{ method: 'cash', amount: total }] } });
    assertEqualOrThrow(cash.status, 409, 'cash is refused with no open shift once the setting is on');
    const card = await api(baseUrl, `/api/bills/${billId}/payments`, { method: 'POST', headers: authHeader, body: { payments: [{ method: 'card', amount: total }] } });
    assertEqualOrThrow(card.status, 200, 'card payments are not affected');

    const turnOff = await api(baseUrl, '/api/settings/require_open_shift', { method: 'PUT', headers: authHeader, body: { value: 'false' } });
    assertEqualOrThrow(turnOff.status, 200, 'owner can turn the requirement off again');
    console.log('register-guards: all checks passed');
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err: any) => { console.error(err); process.exit(1); });
