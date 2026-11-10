/**
 * Orders list date range: today / yesterday / week follow the tenant business day,
 * and include_open keeps still-open orders visible whatever their date.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/orders-date-range.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-orders-range-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct,
  api, assertOrThrow, assertEqualOrThrow, closeDatabase,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');

const fmt = (d: Date) => d.toISOString().replace('T', ' ').replace(/\..*$/, '');

async function main() {
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-range', 'Drinks');
  seedProduct(db, 'prod-range', 'cat-range', 'Beer', 300);
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('timezone', 'Asia/Phnom_Penh', datetime('now'))").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_day_start_time', '00:00', datetime('now'))").run();
  const app = createApp({ '/api/orders': orderRoutes });
  const { baseUrl, server } = await startServer(app);
  try {
    const make = async () => {
      const res = await api(baseUrl, '/api/orders', { method: 'POST', headers: authHeader, body: { type: 'takeaway', items: [{ product_id: 'prod-range', quantity: 1 }] } });
      assertEqualOrThrow(res.status, 201, 'order created');
      return res.data.order.id as number;
    };
    const todayId = await make();
    const oldOpenId = await make();
    const oldDoneId = await make();
    const threeDaysAgo = fmt(new Date(Date.now() - 3 * 24 * 3600 * 1000));
    db.prepare("UPDATE orders SET created_at = ?, status = 'pending' WHERE id = ?").run(threeDaysAgo, oldOpenId);
    db.prepare("UPDATE orders SET created_at = ?, status = 'completed' WHERE id = ?").run(threeDaysAgo, oldDoneId);

    const ids = async (query: string) => {
      const res = await api(baseUrl, `/api/orders?per_page=100&${query}`, { headers: authHeader });
      assertEqualOrThrow(res.status, 200, `orders list ok for ${query}`);
      return (res.data.orders as any[]).map((o) => o.id).sort();
    };

    assertEqualOrThrow(JSON.stringify(await ids('range=today')), JSON.stringify([todayId]), 'today shows only today');
    assertEqualOrThrow(JSON.stringify(await ids('range=today&include_open=1')), JSON.stringify([todayId, oldOpenId].sort()), 'include_open adds the old open order, not the old completed one');
    assertEqualOrThrow(JSON.stringify(await ids('range=yesterday')), JSON.stringify([]), 'yesterday is empty');
    assertEqualOrThrow(JSON.stringify(await ids('range=week')), JSON.stringify([todayId, oldOpenId, oldDoneId].sort()), 'week covers all three');
    assertOrThrow((await ids('')).length === 3, 'no range keeps the old behaviour');
    console.log('orders-date-range: all checks passed');
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err: any) => { console.error(err); process.exit(1); });
