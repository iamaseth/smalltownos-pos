/**
 * Shift X/Z and daily sales printouts: figures from a dual-currency shift,
 * 42/32-column layout, REPRINT marking, read-only, and the report endpoints.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/shift-report.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-shift-report-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-shift-report';

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { initDatabase, getDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const { assertOrThrow, assertEqualOrThrow, assertIncludesOrThrow } = require('./helpers/test-setup');
const text = require('../shared/print/shift-report-text');
const { displayCellWidth } = require('../shared/print/width');

async function main() {
  console.log('Shift X/Z and daily sales printouts');
  console.log('='.repeat(50));
  try {
    initDatabase();
  } catch (error: any) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && String(error?.message || '').includes('NODE_MODULE_VERSION')) {
      console.log('  ⚠ Skipping: better-sqlite3 ABI mismatch (run via Electron)');
      process.exit(77);
    }
    throw error;
  }
  const db = getDatabase();
  for (const [key, value] of [['country', 'KH'], ['currency', 'USD'], ['timezone', 'Asia/Phnom_Penh'], ['business_name', 'BackStreet Riverside'], ['usd_khr_exchange_rate', '4100']]) {
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value, now());
  }
  for (const [id, name, role] of [['owner-r', 'Owner', 'owner'], ['cashier-r', 'Thida', 'cashier']]) {
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, name, `${id}@test.local`, bcrypt.hashSync('pw', 4), role, now(), now());
  }
  db.prepare(`INSERT OR IGNORE INTO payment_methods (id, name, is_active, sort_order, created_at, updated_at) VALUES (2, 'ACLEDA', 1, 2, ?, ?)`).run(now(), now());
  db.prepare(`UPDATE payment_methods SET name = 'ACLEDA', is_active = 1 WHERE id = 2`).run();
  db.prepare(`INSERT INTO categories (id, name, created_at, updated_at) VALUES ('cat-beer', 'Beer', ?, ?)`).run(now(), now());
  db.prepare(`INSERT INTO products (id, name, price, category_id, created_at, updated_at) VALUES ('p-angkor', 'Angkor Beer', 2, 'cat-beer', ?, ?)`).run(now(), now());
  const productId = 'p-angkor';
  db.prepare(`INSERT INTO tables (id, number, capacity, status, is_active, created_at, updated_at) VALUES ('t7', '7', 4, 'available', 1, ?, ?)`).run(now(), now());
  const tableId = 't7';

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'auth' });
    req.user = jwt.verify(h.split(' ')[1], getJWTSecret());
    next();
  });
  app.use('/api/cash-handover', require('../main/routes/cash-handover').cashHandoverRoutes);
  app.use('/api/reports', require('../main/routes/reports').reportRoutes);
  const tok = (id: string, role: string) => `Bearer ${jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' })}`;
  const C = tok('cashier-r', 'cashier');

  const open = await request(app).post('/api/cash-handover/open').set('Authorization', C)
    .send({ count: { method: 'manual', usd_cents: 5000, khr_riel: 41000 }, device: 'pos' });
  assertEqualOrThrow(open.status, 200, 'cashier opens a shift with $50 + 41,000 riel');
  const sid = open.body.session.id;

  let seq = 0;
  const addBill = (opts: { lines: object[]; subtotal: number; discount?: number; total: number; status?: string; table?: string | null; type?: string }) => {
    seq += 1;
    const t = now();
    const paid = (opts.status ?? 'paid') === 'paid';
    const order = db.prepare(`INSERT INTO orders (order_number, user_id, table_id, type, status, subtotal, total, created_at, updated_at) VALUES (?, 'cashier-r', ?, ?, ?, ?, ?, ?, ?)`)
      .run(`R-${seq}`, opts.table ?? null, opts.type ?? 'dine_in', paid ? 'completed' : 'pending', opts.subtotal, opts.total, t, t);
    const orderId = Number(order.lastInsertRowid);
    db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, total, status, created_at, updated_at) VALUES (?, ?, 'Angkor Beer', ?, 2, ?, ?, 'served', ?, ?)`)
      .run(orderId, productId, Math.max(1, Math.round(opts.subtotal / 2)), opts.subtotal, opts.subtotal, t, t);
    db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, discount_amount, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`RB-${seq}`, orderId, opts.subtotal, opts.discount ?? 0, opts.total, paid ? opts.total : 0, paid ? 0 : opts.total, opts.status ?? 'paid',
        JSON.stringify(opts.lines), paid ? t : null, t, t);
    return orderId;
  };
  addBill({ table: tableId, subtotal: 18, total: 18, lines: [{ method: 'cash', amount: 18, cash_session_id: sid, cash_usd_in: 20, cash_khr_in: 0, change_usd_out: 2, change_khr_out: 0, timestamp: now() }] });
  addBill({ subtotal: 10, total: 10, type: 'takeaway', lines: [{ method: 'cash', amount: 10, cash_session_id: sid, cash_usd_in: 0, cash_khr_in: 41000, change_usd_out: 0, change_khr_out: 0, timestamp: now() }] });
  addBill({ subtotal: 30, discount: 5, total: 25, lines: [{ method: 'custom', payment_method_id: 2, amount: 25, cash_session_id: sid, timestamp: now() }] });
  addBill({ subtotal: 6, discount: 6, total: 0, lines: [] });
  addBill({ table: tableId, subtotal: 12, total: 12, status: 'unpaid', lines: [] });
  const voidOrder = addBill({ subtotal: 4, total: 4, lines: [{ method: 'card', amount: 4, cash_session_id: sid, timestamp: now() }] });
  db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, total, status, voided_at, created_at, updated_at) VALUES (?, ?, 'Mojito', 1, 5, 5, 5, 'voided', ?, ?, ?)`).run(voidOrder, productId, now(), now(), now());
  const ice = await request(app).post(`/api/cash-handover/sessions/${sid}/cash-spent`).set('Authorization', C).send({ currency: 'USD', amount_minor: 300, what: 'Ice' });
  assertEqualOrThrow(ice.status, 201, 'cash spent recorded');

  console.log('Section 1: X-report (open shift)');
  const x = await request(app).get(`/api/reports/shift-report?session_id=${sid}`).set('Authorization', C);
  assertEqualOrThrow(x.status, 200, `cashier can read the shift report (${x.body.error || ''})`);
  const xr = x.body;
  assertEqualOrThrow(xr.kind, 'X', 'open shift gives an X-report');
  assertEqualOrThrow(xr.register, 'Front bar', 'register defaults to Front bar');
  assertEqualOrThrow(xr.sales.grossCents, 6800, 'gross = $68 (all paid bills before discount)');
  assertEqualOrThrow(xr.sales.discountCents, 1100, 'discounts = $11');
  assertEqualOrThrow(xr.sales.netCents, 5700, 'net = $57');
  assertEqualOrThrow(xr.sales.compCount, 1, 'a 100% discount bill counts as complimentary');
  assertEqualOrThrow(xr.sales.voidCount, 1, 'voided item counted');
  const pay = Object.fromEntries(xr.payments.map((p: any) => [p.label, p]));
  assertEqualOrThrow(pay['Cash USD']?.usdCents, 1800, 'Cash USD $18 net of change');
  assertEqualOrThrow(pay['Cash KHR']?.khrRiel, 41000, 'Cash KHR 41,000 riel separately');
  assertEqualOrThrow(pay['ACLEDA QR']?.usdCents, 2500, 'ACLEDA $25');
  assertEqualOrThrow(pay['Card']?.usdCents, 400, 'card payments on one line (brand not recorded)');
  assertEqualOrThrow(xr.unpaid.count, 1, 'one unpaid ticket');
  assertOrThrow(xr.tables.rows.some((t: any) => t.label === 'T7' && t.status === 'open'), 'table 7 still open (one paid, one unpaid bill)');
  assertOrThrow(xr.tables.rows.some((t: any) => t.label === 'To Go'), 'to-go orders grouped');
  assertEqualOrThrow(xr.cash.expectedUsdCents, 5000 + 1800 - 300, 'expected USD = float + cash sales − spent');
  assertEqualOrThrow(xr.cash.expectedKhrRiel, 82000, 'expected KHR = float + riel sales');
  assertEqualOrThrow(xr.cash.countedUsdCents, null, 'X-report has no count yet');
  assertEqualOrThrow(xr.spent[0]?.label, 'Ice', 'cash spent listed');
  assertEqualOrThrow(xr.orders.length, 6, 'X-report lists every order of the shift on its own line');
  const togo = xr.orders.find((o: any) => o.label === 'To Go');
  assertOrThrow(togo?.cashier === 'Thida' && togo.paidWith === 'Cash KHR' && togo.shiftId === sid, 'order line carries cashier, payment and shift');
  const unpaidLine = xr.orders.find((o: any) => o.status === 'unpaid');
  const detail = await request(app).get(`/api/reports/order-detail?order_id=${unpaidLine.id}`).set('Authorization', C);
  assertEqualOrThrow(detail.status, 200, 'cashier can open an order\'s details');
  assertOrThrow(detail.body.items.length === 1 && detail.body.payments.length === 0 && detail.body.history.length >= 1, 'details show items, no payment yet, and history');

  const before = JSON.stringify(db.prepare(`SELECT COUNT(*) a, (SELECT COUNT(*) FROM cash_reconciliations) b, (SELECT status FROM cash_sessions WHERE id = ?) c FROM bills`).get(sid));
  await request(app).get(`/api/reports/shift-report?session_id=${sid}`).set('Authorization', C);
  const after = JSON.stringify(db.prepare(`SELECT COUNT(*) a, (SELECT COUNT(*) FROM cash_reconciliations) b, (SELECT status FROM cash_sessions WHERE id = ?) c FROM bills`).get(sid));
  assertEqualOrThrow(after, before, 'printing an X-report changes no data and keeps the shift open');

  console.log('Section 2: layout');
  for (const width of [42, 32]) {
    const lines: string[] = text.renderShiftReport(xr, width, 'Asia/Phnom_Penh');
    const widest = Math.max(...lines.map((l) => displayCellWidth(l)));
    assertOrThrow(widest <= width, `X-report fits ${width} columns (widest ${widest})`);
  }
  const xLines = text.renderShiftReport(xr, 42, 'Asia/Phnom_Penh').join('\n');
  assertIncludesOrThrow(xLines, 'X-REPORT', 'title printed');
  assertIncludesOrThrow(xLines, 'Cash KHR', 'riel payments on their own line');
  assertOrThrow(!xLines.includes('REPRINT'), 'first print is not marked REPRINT');
  assertIncludesOrThrow(text.renderShiftReport(xr, 42, 'Asia/Phnom_Penh', true).join('\n'), 'REPRINT', 'reprint marked REPRINT');

  console.log('Section 3: Z-report (closed shift)');
  db.prepare(`UPDATE bills SET payment_status = 'paid', paid_amount = total, balance = 0, paid_at = ?, payment_details = ? WHERE payment_status = 'unpaid'`)
    .run(now(), JSON.stringify([{ method: 'card', amount: 12, cash_session_id: sid, timestamp: now() }]));
  const close = await request(app).post(`/api/cash-handover/sessions/${sid}/closing-count`).set('Authorization', C)
    .send({ count: { method: 'manual', usd_cents: 1500, khr_riel: 41000 }, float_out: { usd_cents: 5000, khr_riel: 41000 }, device: 'pos' });
  assertEqualOrThrow(close.status, 200, `close register (${close.body.error || ''})`);
  const z = (await request(app).get(`/api/reports/shift-report?session_id=${sid}`).set('Authorization', C)).body;
  assertEqualOrThrow(z.kind, 'Z', 'closed shift gives a Z-report');
  assertEqualOrThrow(z.cash.countedUsdCents, 6500, 'counted USD includes the float');
  assertEqualOrThrow(z.cash.varianceUsdCents, 0, 'USD matches');
  assertEqualOrThrow(z.cash.floatKeptUsdCents, 5000, 'float kept shown');
  const zLines = text.renderShiftReport(z, 42, 'Asia/Phnom_Penh');
  assertOrThrow(Math.max(...zLines.map((l: string) => displayCellWidth(l))) <= 42, 'Z-report fits 42 columns');
  assertIncludesOrThrow(zLines.join('\n'), 'Z-REPORT', 'Z title printed');
  assertEqualOrThrow(z.closedBy, 'Thida', 'Z-report records who closed the shift');
  assertOrThrow(zLines.some((l: string) => l.startsWith('Closed by') && l.includes('Thida')), 'Closed by line printed');
  assertOrThrow(zLines.length <= 65, `normal Z-report stays compact (${zLines.length} lines)`);
  assertOrThrow(!zLines.some((l: string) => l.startsWith('Refunds (0)')), 'zero refunds are hidden');
  assertOrThrow(!zLines.some((l: string) => l.startsWith('Voided items (0)')), 'zero voids are hidden');
  if (process.env.SHIFT_REPORT_PRINT) console.log(`${zLines.join('\n')}\n`);

  console.log('Section 4: daily sales report');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Phnom_Penh' }).format(new Date());
  const dayCashier = await request(app).get(`/api/reports/daily-report?date=${today}`).set('Authorization', C);
  assertEqualOrThrow(dayCashier.status, 200, 'cashier can open the daily report for printing');
  const day = await request(app).get(`/api/reports/daily-report?date=${today}`).set('Authorization', tok('owner-r', 'owner'));
  assertEqualOrThrow(day.status, 200, `owner reads the daily report (${day.body.error || ''})`);
  assertEqualOrThrow(day.body.shifts.length, 1, 'shift listed in the day');
  assertEqualOrThrow(day.body.sales.netCents, z.sales.netCents, 'day net matches the closed shift');
  assertEqualOrThrow(z.sales.netCents, 6900, 'Z net includes the bill paid before closing');
  assertOrThrow(day.body.categories.some((c: any) => c.label === 'Beer'), 'sales grouped by menu category');
  assertOrThrow(day.body.orders.length === 6 && day.body.orders.every((o: any) => o.shiftId === sid), 'daily orders are tagged with their shift');
  const dLines = text.renderDailyReport(day.body, 42, 'Asia/Phnom_Penh');
  assertOrThrow(Math.max(...dLines.map((l: string) => displayCellWidth(l))) <= 42, 'daily report fits 42 columns');
  assertOrThrow(dLines.length <= 65, `normal daily report stays compact (${dLines.length} lines)`);
  const bad = await request(app).get(`/api/reports/daily-report?date=nope`).set('Authorization', tok('owner-r', 'owner'));
  assertEqualOrThrow(bad.status, 400, 'bad date rejected');
  const missing = await request(app).get(`/api/reports/shift-report?session_id=99999`).set('Authorization', C);
  assertEqualOrThrow(missing.status, 404, 'unknown shift is 404');

  console.log('Section 5: cashier reports page data');
  const cDay = await request(app).get(`/api/reports/cashier?start_date=${today}&end_date=${today}`).set('Authorization', C);
  assertEqualOrThrow(cDay.status, 200, `cashier reads the day (${cDay.body.error || ''})`);
  assertEqualOrThrow(cDay.body.sales.netCents, day.body.sales.netCents, 'cashier day total matches the daily report');
  assertEqualOrThrow(cDay.body.shifts.length, 1, 'the day lists its shift');
  assertOrThrow(['day', 'night'].includes(cDay.body.shifts[0].part) && cDay.body.shifts[0].cashier === 'Thida', 'shift has a day/night label and cashier');
  assertEqualOrThrow(cDay.body.tickets.length, 6, 'all tickets listed');
  assertOrThrow(cDay.body.items.some((i: any) => i.label === 'Angkor Beer' && i.qty > 0), 'items sold listed with quantities');
  assertEqualOrThrow(cDay.body.cash.openingUsdCents, 5000, 'opening float from the shift');
  assertEqualOrThrow(cDay.body.cash.differenceUsdCents, 0, 'cash difference from the count');
  assertOrThrow(!('canViewFinancials' in cDay.body) && JSON.stringify(cDay.body).indexOf('profit') === -1, 'no profit or cost in the cashier data');
  const cShift = await request(app).get(`/api/reports/cashier?start_date=${today}&end_date=${today}&session_id=${sid}`).set('Authorization', C);
  assertEqualOrThrow(cShift.body.sales.netCents, z.sales.netCents, 'one shift matches its Z-report');
  assertEqualOrThrow(cShift.body.cash.countedUsdCents, z.cash.countedUsdCents, 'shift counted cash matches the Z-report');
  const weekStart = new Date(`${today}T12:00:00Z`); weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  const cWeek = await request(app).get(`/api/reports/cashier?start_date=${weekStart.toISOString().slice(0, 10)}&end_date=${today}`).set('Authorization', C);
  assertEqualOrThrow(cWeek.body.days.length, 7, 'a week lists 7 days');
  assertEqualOrThrow(cWeek.body.sales.netCents, day.body.sales.netCents, 'week total equals the only trading day (no double counting)');
  assertEqualOrThrow(cWeek.body.days.reduce((n: number, d: any) => n + d.netCents, 0), cWeek.body.sales.netCents, 'day rows add up to the week total');
  const cBad = await request(app).get(`/api/reports/cashier?start_date=${today}&end_date=2000-01-01`).set('Authorization', C);
  assertEqualOrThrow(cBad.status, 400, 'end before start rejected');

  console.log('='.repeat(50));
  console.log('All shift report checks passed');
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
