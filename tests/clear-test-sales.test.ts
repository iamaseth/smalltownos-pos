/**
 * Clear test sales: removes orders, bills, payments and cash sessions after a
 * backup, and leaves the menu, tables, staff, customers and settings untouched.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/clear-test-sales.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-clear-test-sales-'));
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
const { clearTestSalesWithBackup, getTestSalesCounts, now } = require('../main/db');

async function main() {
  const db = initTestDb();
  const { authHeader, userId } = seedOwnerUser(db);
  seedCategory(db, 'cat-clear', 'Drinks');
  seedProduct(db, 'prod-clear', 'cat-clear', 'Beer', 300);
  db.prepare("INSERT INTO tables (id, number, capacity, status, created_at, updated_at) VALUES ('t-clear', 'T1', 4, 'occupied', ?, ?)").run(now(), now());
  db.prepare("INSERT INTO customers (id, name, phone, created_at, updated_at) VALUES ('c-clear', 'Test Customer', '+85512345678', ?, ?)").run(now(), now());

  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes });
  const { baseUrl, server } = await startServer(app);
  try {
    const paid = await api(baseUrl, '/api/orders', { method: 'POST', headers: authHeader, body: { type: 'takeaway', items: [{ product_id: 'prod-clear', quantity: 2 }] } });
    assertEqualOrThrow(paid.status, 201, 'paid order created');
    const bill = await api(baseUrl, '/api/bills/generate', { method: 'POST', headers: authHeader, body: { order_id: paid.data.order.id } });
    assertEqualOrThrow(bill.status, 201, 'bill generated');
    const pay = await api(baseUrl, `/api/bills/${bill.data.bill.id}/payment`, { method: 'POST', headers: authHeader, body: { method: 'cash', amount: bill.data.bill.total } });
    assertEqualOrThrow(pay.status, 200, 'bill paid');
    const tab = await api(baseUrl, '/api/orders', { method: 'POST', headers: authHeader, body: { type: 'dine_in', tab_name: 'Tom', items: [{ product_id: 'prod-clear', quantity: 1 }] } });
    assertEqualOrThrow(tab.status, 201, 'open tab created');
    db.prepare("INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status) VALUES (?, 'Owner', ?, 10000, 'open')").run(userId, now());

    const before = getTestSalesCounts(db);
    assertOrThrow(before.orders === 2 && before.bills === 1 && before.cash_sessions === 1, `counts before clearing: ${JSON.stringify(before)}`);
    const settingsBefore = (db.prepare('SELECT COUNT(*) AS n FROM settings').get() as any).n;

    const result = await clearTestSalesWithBackup();
    assertOrThrow(fs.existsSync(result.backupPath), 'a backup file was written before deleting');
    assertEqualOrThrow(result.deleted.orders, 2, 'both orders deleted');

    const after = getTestSalesCounts(db);
    for (const [table, count] of Object.entries(after)) assertEqualOrThrow(count, 0, `${table} is empty after clearing`);
    assertEqualOrThrow((db.prepare('SELECT COUNT(*) AS n FROM customers').get() as any).n, 1, 'customers are kept');
    assertEqualOrThrow((db.prepare('SELECT COUNT(*) AS n FROM products').get() as any).n, 1, 'menu products are kept');
    assertEqualOrThrow((db.prepare('SELECT COUNT(*) AS n FROM categories').get() as any).n, 1, 'categories are kept');
    assertEqualOrThrow((db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n, 1, 'staff accounts are kept');
    assertEqualOrThrow((db.prepare('SELECT COUNT(*) AS n FROM settings').get() as any).n, settingsBefore, 'settings are kept');
    assertEqualOrThrow((db.prepare("SELECT status FROM tables WHERE id = 't-clear'").get() as any).status, 'available', 'tables are freed');

    const fresh = await api(baseUrl, '/api/orders', { method: 'POST', headers: authHeader, body: { type: 'takeaway', items: [{ product_id: 'prod-clear', quantity: 1 }] } });
    assertEqualOrThrow(fresh.status, 201, 'new orders still work after clearing');
    console.log('clear-test-sales: all checks passed');
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* temp dir cleanup */ }
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
