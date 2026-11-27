/**
 * BackStreet: "Popular first" menu order — quantity sold per item in the last 30 days,
 * worked out once a week. Run: node tests/run-electron-node-test.cjs tests/menu-popularity.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-popularity-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const assert = require('node:assert/strict');
const { initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct, api, closeDatabase } = require('./helpers/test-setup');
const { getSettingValue } = require('../main/db');
const { weekStart, soldInLastDays, getMenuPopularity } = require('../main/services/menu-popularity');
const { productRoutes } = require('../main/routes/products');

let passed = 0;
const ok = (cond: boolean, msg: string) => { assert.ok(cond, msg); passed += 1; console.log(`  ✓ ${msg}`); };
const sql = (d: Date) => d.toISOString().replace('T', ' ').replace(/\..*$/, '');

async function main() {
  const db = initTestDb();
  const { authHeader: A, userId: ownerId } = seedOwnerUser(db);
  seedCategory(db, 'cat-bar', 'Bar');
  seedProduct(db, 'beer', 'cat-bar', 'Angkor Beer', 2);
  seedProduct(db, 'mojito', 'cat-bar', 'Mojito', 4);
  seedProduct(db, 'absolut', 'cat-bar', 'Absolut Vodka', 3);

  const at = new Date('2026-11-26T07:00:00Z'); // Thursday 14:00 in Vientiane
  let n = 0;
  const sale = (productId: string, qty: number, when: Date, opts: { orderStatus?: string; itemStatus?: string } = {}) => {
    n += 1;
    const t = sql(when);
    const orderId = Number(db.prepare(`INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at) VALUES (?, ?, 'dine_in', ?, 0, 0, ?, ?)`)
      .run(`T-${n}`, ownerId, opts.orderStatus || 'completed', t, t).lastInsertRowid);
    db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at) VALUES (?, ?, ?, 1, ?, 1, 1, ?, ?)`)
      .run(orderId, productId, productId, qty, opts.itemStatus || 'served', t);
  };
  const daysAgo = (d: number) => new Date(at.getTime() - d * 86_400_000);
  sale('beer', 10, daysAgo(2));
  sale('beer', 5, daysAgo(20));
  sale('mojito', 7, daysAgo(1));
  sale('mojito', 50, daysAgo(40));                        // older than 30 days: not counted
  sale('absolut', 30, daysAgo(3), { orderStatus: 'cancelled' }); // cancelled order: not counted
  sale('absolut', 1, daysAgo(3), { itemStatus: 'voided' });       // voided item: not counted

  console.log('ranking');
  ok(weekStart(at, 'Asia/Vientiane') === '2026-11-23', 'the week starts on Monday, restaurant time');
  ok(weekStart(new Date('2026-11-22T18:30:00Z'), 'Asia/Vientiane') === '2026-11-23', 'Sunday 18:30 UTC is already Monday in Vientiane');
  const sold = soldInLastDays(db, at);
  ok(sold.beer === 15, `beer: both sales in the last 30 days count (${sold.beer})`);
  ok(sold.mojito === 7, `mojito: a sale older than 30 days is left out (${sold.mojito})`);
  ok(sold.absolut === undefined, 'cancelled orders and voided items are not counted');

  console.log('weekly, not live');
  const first = getMenuPopularity(db, at, 'Asia/Vientiane');
  ok(first.week === '2026-11-23' && first.sold.beer === 15, 'the ranking is worked out and kept for this week');
  sale('mojito', 100, daysAgo(0));
  const sameWeek = getMenuPopularity(db, new Date('2026-11-28T07:00:00Z'), 'Asia/Vientiane');
  ok(sameWeek.sold.mojito === 7, 'buttons do not move during the week, even after big sales');
  const nextWeek = getMenuPopularity(db, new Date('2026-11-30T03:00:00Z'), 'Asia/Vientiane');
  ok(nextWeek.week === '2026-11-30' && nextWeek.sold.mojito === 107, 'on Monday the ranking is worked out again');
  ok(JSON.parse(getSettingValue('menu_popularity')).week === '2026-11-30', 'the new ranking is saved');

  console.log('route');
  const app = createApp({ '/api/products': productRoutes });
  const { baseUrl, server } = await startServer(app);
  try {
    const res = await api(baseUrl, '/api/products/popularity', { headers: A });
    ok(res.status === 200 && typeof res.data.sold === 'object' && res.data.days === 30, 'GET /api/products/popularity answers the ranking');
    const noLogin = await api(baseUrl, '/api/products/popularity', {});
    ok(noLogin.status === 401 || noLogin.status === 403, 'it needs a login');
    const product = await api(baseUrl, '/api/products/beer', { headers: A });
    ok(product.status === 200, 'single products still load (route order unchanged)');
  } finally {
    server.close();
  }

  console.log(`menu-popularity: ${passed} passed`);
  closeDatabase();
  try { fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may still hold the test database open; leave the temp folder */ }
}

main().catch((error) => { console.error(error); process.exit(1); });
