/**
 * GET /api/reports/period — Reports page data (weekly/monthly/custom periods).
 *
 * Fixtures use Asia/Phnom_Penh (UTC+7, no DST) and a midnight business-day
 * start, with fixed UTC timestamps so the expected local dates and hours are
 * known: 11:30Z = 18:30 local, 16:30Z = 23:30 local, 17:30Z = 00:30 next day.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/reports-period.test.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-reports-period-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-reports-period';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { assertOrThrow, assertEqualOrThrow, isNativeAbiMismatch } = require('./helpers/test-setup');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { reportRoutes } = require('../main/routes/reports');

const close = (actual: number, expected: number) => Math.abs(actual - expected) < 0.0001;

async function main() {
  console.log('GET /api/reports/period');
  console.log('='.repeat(50));
  try {
    initDatabase();
  } catch (error: any) {
    if (isNativeAbiMismatch(error)) {
      console.log('  ⚠ Skipping: better-sqlite3 ABI mismatch (run via Electron)');
      process.exit(77);
    }
    throw error;
  }

  const db = getDatabase();
  const setSetting = db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
  setSetting.run('country', 'KH', now());
  setSetting.run('currency', 'USD', now());
  setSetting.run('timezone', 'Asia/Phnom_Penh', now());

  const ownerId = 'owner-period';
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 'owner', 1, ?, ?)`)
    .run(ownerId, 'Owner', 'owner-period@test.local', bcrypt.hashSync('pw', 10), now(), now());

  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('cat-beer', 'Beer', 1)`).run();
  db.prepare(`INSERT INTO categories (id, name, sort_order, parent_id) VALUES ('cat-draft', 'Draft', 2, 'cat-beer')`).run();
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('cat-food', 'Food', 3)`).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, is_active, sort_order) VALUES ('prod-draft', 'cat-draft', 'Draft Beer', 1.5, 0.5, 1, 1)`).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, cost, is_active, sort_order) VALUES ('prod-burger', 'cat-food', 'Burger', 12, 0, 1, 2)`).run();

  const insertOrder = db.prepare(`INSERT INTO orders (id, order_number, user_id, type, status, subtotal, discount_amount, total, created_at, updated_at)
    VALUES (?, ?, ?, 'dine_in', ?, ?, ?, ?, ?, ?)`);
  const insertItem = db.prepare(`INSERT INTO order_items (id, order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, voided_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'served', ?, ?, ?)`);
  const insertBill = db.prepare(`INSERT INTO bills (id, bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'paid', ?, ?, ?, ?)`);

  const order = (id: number, status: string, subtotal: number, discount: number, total: number, at: string) => {
    insertOrder.run(id, `N-${id}`, ownerId, status, subtotal, discount, total, at, at);
  };
  const item = (id: number, orderId: number, productId: string, name: string, price: number, qty: number, at: string, voidedAt: string | null = null) => {
    insertItem.run(id, orderId, productId, name, price, qty, price * qty, price * qty, voidedAt, at, at);
  };

  order(1, 'completed', 3, 0, 3, '2026-11-10 11:30:00');
  item(11, 1, 'prod-draft', 'Draft Beer', 1.5, 2, '2026-11-10 11:30:00');
  item(12, 1, 'prod-burger', 'Burger', 12, 1, '2026-11-10 11:30:00', '2026-11-10 11:35:00');
  insertBill.run(1, 'B-1', 1, 3, 3, 3, JSON.stringify([{ method: 'cash', amount: 3 }]), '2026-11-10 11:40:00', '2026-11-10 11:40:00', '2026-11-10 11:40:00');

  order(2, 'completed', 12, 2, 10, '2026-11-10 16:30:00');
  item(21, 2, 'prod-burger', 'Burger', 12, 1, '2026-11-10 16:30:00');

  order(3, 'completed', 4, 0, 4, '2026-11-10 17:30:00');
  item(31, 3, 'ib4-9', 'Old iB4 Wine', 4, 1, '2026-11-10 17:30:00');

  order(4, 'cancelled', 50, 0, 50, '2026-11-10 12:00:00');
  item(41, 4, 'prod-burger', 'Burger', 12, 4, '2026-11-10 12:00:00');

  order(5, 'completed', 5, 0, 5, '2026-11-09 05:00:00');
  item(51, 5, 'prod-draft', 'Draft Beer', 1.5, 2, '2026-11-09 05:00:00');

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
    try {
      req.user = jwt.verify(authHeader.split(' ')[1], getJWTSecret());
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });
  app.use('/api/reports', reportRoutes);
  const token = jwt.sign({ userId: ownerId, email: 'owner-period@test.local', role: 'owner' }, getJWTSecret(), { expiresIn: '1h' });
  const get = (query: string) => request(app).get(`/api/reports/period?${query}`).set('Authorization', `Bearer ${token}`);

  try {
    console.log('\n1. Summary and previous period');
    const res = await get('start_date=2026-11-10&end_date=2026-11-11');
    assertEqualOrThrow(res.status, 200, 'returns 200');
    const r = res.body;
    assertEqualOrThrow(r.summary.orders, 3, 'counts non-cancelled orders in the period');
    assertOrThrow(close(r.summary.netSales, 17), 'net sales sums order totals (3 + 10 + 4)');
    assertOrThrow(close(r.summary.discounts, 2), 'discounts sum order discounts');
    assertEqualOrThrow(r.summary.discountedOrders, 1, 'counts discounted orders');
    assertEqualOrThrow(r.period.previousStartDate, '2026-11-08', 'previous period starts the same length earlier');
    assertEqualOrThrow(r.period.previousEndDate, '2026-11-09', 'previous period ends the day before');
    assertEqualOrThrow(r.previous.orders, 1, 'previous period counts its own orders');
    assertOrThrow(close(r.previous.netSales, 5), 'previous period net sales');

    console.log('\n2. Business days and hours');
    assertEqualOrThrow(r.daily.length, 2, 'one row per day in the period');
    assertEqualOrThrow(r.daily[0].orders, 2, '18:30 and 23:30 local land on 10 Nov');
    assertOrThrow(close(r.daily[0].sales, 13), '10 Nov sales');
    assertEqualOrThrow(r.daily[1].orders, 1, '00:30 local lands on 11 Nov');
    assertOrThrow(close(r.hourly[18].sales, 3) && close(r.hourly[23].sales, 10) && close(r.hourly[0].sales, 4), 'hours bucket in store local time');

    console.log('\n3. Items, categories and profit');
    const draft = r.items.find((i: any) => i.productId === 'prod-draft');
    const burger = r.items.find((i: any) => i.productId === 'prod-burger');
    const old = r.items.find((i: any) => i.productId === 'ib4-9');
    assertEqualOrThrow(draft.quantity, 2, 'voided and cancelled lines are excluded from quantities');
    assertOrThrow(close(draft.cost, 1) && close(draft.profit, 2), 'cost and profit use the menu item cost');
    assertEqualOrThrow(burger.quantity, 1, 'cancelled order items are excluded');
    assertEqualOrThrow(burger.cost, null, 'items without a cost show no profit');
    assertEqualOrThrow(old.onMenu, false, 'items no longer on the menu are flagged');
    const beer = r.categories.find((c: any) => c.name === 'Beer');
    assertOrThrow(beer && close(beer.net, 3), 'sub-categories roll up to their top-level category');
    const offMenu = r.categories.find((c: any) => c.name === null);
    assertOrThrow(offMenu && close(offMenu.net, 4), 'items not on the menu group together');
    assertEqualOrThrow(r.canViewFinancials, true, 'owners see cost and profit');

    console.log('\n4. Payments and validation');
    const cash = r.paymentMethods.find((p: any) => p.method === 'cash');
    assertOrThrow(cash && close(cash.total, 3), 'payment methods come from paid bills');
    assertEqualOrThrow((await get('start_date=2026-11-12&end_date=2026-11-10')).status, 400, 'rejects a reversed range');
    assertEqualOrThrow((await get('start_date=2025-01-01&end_date=2026-11-10')).status, 400, 'rejects periods over a year');
    console.log('\nAll reports-period checks passed');
  } finally {
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
