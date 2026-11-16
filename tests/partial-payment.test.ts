/**
 * Partial payments: a bill paid in parts stays open until the balance is zero.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/partial-payment.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-partial-payment-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct,
  api, assertOrThrow, assertEqualOrThrow, closeDatabase,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');

async function main() {
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-part', 'Drinks');
  seedProduct(db, 'prod-part', 'cat-part', 'Beer', 300);
  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes });
  const { baseUrl, server } = await startServer(app);
  try {
    const order = await api(baseUrl, '/api/orders', { method: 'POST', headers: authHeader, body: { type: 'dine_in', tab_name: 'Group', items: [{ product_id: 'prod-part', quantity: 3 }] } });
    assertEqualOrThrow(order.status, 201, 'order created');
    const orderId = order.data.order.id;
    const bill = await api(baseUrl, '/api/bills/generate', { method: 'POST', headers: authHeader, body: { order_id: orderId } });
    assertEqualOrThrow(bill.status, 201, 'bill generated');
    const billId = bill.data.bill.id;
    const total = Number(bill.data.bill.total);
    const share = Math.ceil(total / 3);

    const first = await api(baseUrl, `/api/bills/${billId}/payments`, { method: 'POST', headers: authHeader, body: { payments: [{ method: 'cash', amount: share }] } });
    assertEqualOrThrow(first.status, 200, 'first part accepted');
    assertEqualOrThrow(first.data.bill.payment_status, 'partial', 'bill is partial after the first part');
    assertEqualOrThrow(Number(first.data.bill.balance), total - share, 'balance shrinks by the first part');
    const mid = await api(baseUrl, `/api/orders/${orderId}`, { headers: authHeader });
    assertOrThrow(mid.data.order.status !== 'completed', 'order is not completed while a balance is left');

    const second = await api(baseUrl, `/api/bills/${billId}/payments`, { method: 'POST', headers: authHeader, body: { payments: [{ method: 'card', amount: share }] } });
    assertEqualOrThrow(second.data.bill.payment_status, 'partial', 'still partial after the second part');

    const last = await api(baseUrl, `/api/bills/${billId}/payments`, { method: 'POST', headers: authHeader, body: { payments: [{ method: 'cash', amount: Number(second.data.bill.balance) }] } });
    assertEqualOrThrow(last.data.bill.payment_status, 'paid', 'bill is paid after the last part');
    assertEqualOrThrow(Number(last.data.bill.balance), 0, 'balance is zero');
    const lines = Array.isArray(last.data.bill.payment_details) ? last.data.bill.payment_details : JSON.parse(last.data.bill.payment_details);
    assertEqualOrThrow(lines.length, 3, 'three payment lines are kept');
    const done = await api(baseUrl, `/api/orders/${orderId}`, { headers: authHeader });
    assertEqualOrThrow(done.data.order.status, 'completed', 'order completes once fully paid');
    console.log('partial-payment: all checks passed');
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err: any) => { console.error(err); process.exit(1); });
