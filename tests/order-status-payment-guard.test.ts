/**
 * Cancelling an order with collected payment, or completing an unsettled order, needs a manager PIN.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/order-status-payment-guard.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-status-guard-'));
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

const PIN = '4821';

async function main() {
  const db = initTestDb();
  const { userId, authHeader } = seedOwnerUser(db);
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(bcrypt.hashSync(PIN, 10), userId);
  seedCategory(db, 'cat-guard', 'Drinks');
  seedProduct(db, 'prod-guard', 'cat-guard', 'Beer', 300);
  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes });
  const { baseUrl, server } = await startServer(app);
  const post = (p: string, body: any) => api(baseUrl, p, { method: 'POST', headers: authHeader, body });
  const patchStatus = (id: number, body: any) => api(baseUrl, `/api/orders/${id}/status`, { method: 'PATCH', headers: authHeader, body });
  const makeOrder = async (tab: string) => (await post('/api/orders', { type: 'takeaway', tab_name: tab, items: [{ product_id: 'prod-guard', quantity: 2 }] })).data.order;
  try {
    const unpaid = await makeOrder('unpaid');
    const cancelUnpaid = await patchStatus(unpaid.id, { status: 'cancelled' });
    assertEqualOrThrow(cancelUnpaid.status, 200, 'cancelling an untouched unpaid order needs no PIN');

    const toComplete = await makeOrder('complete-unpaid');
    const noPin = await patchStatus(toComplete.id, { status: 'completed' });
    assertEqualOrThrow(noPin.status, 400, 'completing an unpaid order without a PIN is refused');
    const badPin = await patchStatus(toComplete.id, { status: 'completed', override_pin: '0000' });
    assertEqualOrThrow(badPin.status, 403, 'completing an unpaid order with a wrong PIN is refused');
    const goodPin = await patchStatus(toComplete.id, { status: 'completed', override_pin: PIN });
    assertEqualOrThrow(goodPin.status, 200, 'completing an unpaid order with the manager PIN works');

    const partPaid = await makeOrder('part-paid');
    const bill = (await post('/api/bills/generate', { order_id: partPaid.id })).data.bill;
    const part = await post(`/api/bills/${bill.id}/payments`, { payments: [{ method: 'card', amount: 200 }] });
    assertEqualOrThrow(part.data.bill.payment_status, 'partial', 'bill is part paid');
    const cancelNoPin = await patchStatus(partPaid.id, { status: 'cancelled' });
    assertEqualOrThrow(cancelNoPin.status, 400, 'cancelling an order with collected payment without a PIN is refused');
    const stillOpen = await api(baseUrl, `/api/orders/${partPaid.id}`, { headers: authHeader });
    assertOrThrow(stillOpen.data.order.status !== 'cancelled', 'the refused cancel leaves the order open');
    const completePartNoPin = await patchStatus(partPaid.id, { status: 'completed' });
    assertEqualOrThrow(completePartNoPin.status, 400, 'completing a part-paid order without a PIN is refused');
    const cancelPin = await patchStatus(partPaid.id, { status: 'cancelled', override_pin: PIN });
    assertEqualOrThrow(cancelPin.status, 200, 'cancelling an order with collected payment works with the manager PIN');

    const paid = await makeOrder('paid');
    const paidBill = (await post('/api/bills/generate', { order_id: paid.id })).data.bill;
    await post(`/api/bills/${paidBill.id}/payments`, { payments: [{ method: 'card', amount: Number(paidBill.total) }] });
    const afterPay = await api(baseUrl, `/api/orders/${paid.id}`, { headers: authHeader });
    assertEqualOrThrow(afterPay.data.order.status, 'completed', 'a fully paid order still completes by itself');
    console.log('order-status-payment-guard: all checks passed');
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err: any) => { console.error(err); process.exit(1); });
