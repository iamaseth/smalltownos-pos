/**
 * Coupons: manager sets them up in Settings; at checkout only live coupons that give
 * something off the bill are offered; one discount per bill; paper coupon confirmed;
 * coupons listed on the shift report.
 * Run: node tests/run-electron-node-test.cjs tests/coupons.test.ts
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-coupons-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct,
  api, assert, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { couponRoutes } = require('../main/routes/coupons');
const { isCouponLive } = require('../main/services/coupons');

function setSetting(db: any, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

async function main(): Promise<void> {
  console.log('Coupons');
  const db = initTestDb();
  setSetting(db, 'discount_mode', 'both');
  setSetting(db, 'timezone', 'Asia/Phnom_Penh');

  const { authHeader: A, userId: ownerId } = seedOwnerUser(db);
  seedCategory(db, 'cat-breakfast', 'Breakfast');
  seedCategory(db, 'cat-drinks', 'Drinks');
  seedProduct(db, 'prod-eggs', 'cat-breakfast', 'Eggs', 10);
  seedProduct(db, 'prod-cola', 'cat-drinks', 'Cola', 4);

  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes, '/api/coupons': couponRoutes });
  const { baseUrl, server } = await startServer(app);

  const newBill = async (items: { product_id: string; quantity: number }[]) => {
    const create = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'takeaway', items }, headers: A });
    assertEqual(create.status, 201, 'order created');
    const gen = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: create.data.order.id }, headers: A });
    assertEqual(gen.status, 201, 'bill generated');
    return { orderId: create.data.order.id, billId: gen.data.bill.id };
  };
  const forBill = (billId: any) => api(baseUrl, `/api/coupons/for-bill/${billId}`, { headers: A });
  const apply = (billId: any, body: any) => api(baseUrl, `/api/coupons/for-bill/${billId}/apply`, { method: 'POST', body, headers: A });

  try {
    console.log('\n─── settings ───');
    const bad = await api(baseUrl, '/api/coupons', { method: 'PUT', headers: A, body: { coupons: [{ code: 'x', name: 'Bad', kind: 'percent_bill', value: 10 }] } });
    assertEqual(bad.status, 400, 'a code must be 2-20 letters or numbers');
    const noCat = await api(baseUrl, '/api/coupons', { method: 'PUT', headers: A, body: { coupons: [{ code: 'BREAKFAST10', name: 'Breakfast', kind: 'percent_category', value: 10 }] } });
    assertEqual(noCat.status, 400, 'a category coupon needs a category');
    const saved = await api(baseUrl, '/api/coupons', {
      method: 'PUT', headers: A, body: {
        coupons: [
          { code: 'brkspecial15', name: 'Special Riverside promotion', kind: 'percent_bill', value: 15 },
          { code: 'BREAKFAST10', name: 'Breakfast only', kind: 'percent_category', value: 10, category_id: 'cat-breakfast' },
          { code: 'BIG5', name: '$5 off over $50', kind: 'amount_bill', value: 5, min_spend: 50 },
          { code: 'OLD', name: 'Expired', kind: 'percent_bill', value: 50, end_date: '2020-01-01' },
          { code: 'OFF', name: 'Switched off', kind: 'percent_bill', value: 50, enabled: false },
        ],
      },
    });
    assertEqual(saved.status, 200, 'manager saves coupons');
    assertEqual(saved.data.coupons[0].code, 'BRKSPECIAL15', 'codes are stored in capitals');

    console.log('\n─── checkout list ───');
    const drinksOnly = await newBill([{ product_id: 'prod-cola', quantity: 2 }]);
    const list1 = await forBill(drinksOnly.billId);
    const codes1 = list1.data.coupons.map((c: any) => c.code);
    assert(codes1.includes('BRKSPECIAL15'), 'a live whole-bill coupon is offered');
    assert(!codes1.includes('BREAKFAST10'), 'a category coupon is hidden when no item is from that category');
    assert(!codes1.includes('BIG5'), 'a coupon is hidden when the bill is under its minimum spend');
    assert(!codes1.includes('OLD') && !codes1.includes('OFF'), 'expired and switched-off coupons are hidden');

    const mixed = await newBill([{ product_id: 'prod-eggs', quantity: 2 }, { product_id: 'prod-cola', quantity: 1 }]);
    const list2 = await forBill(mixed.billId);
    const breakfast = list2.data.coupons.find((c: any) => c.code === 'BREAKFAST10');
    assert(!!breakfast && Math.abs(breakfast.amount - 2) < 0.001, `category coupon takes 10% of breakfast items only (got ${breakfast?.amount})`);

    console.log('\n─── apply ───');
    const noPaper = await apply(mixed.billId, { coupon_id: breakfast.id });
    assertEqual(noPaper.status, 400, 'the cashier must confirm the paper coupon is in the drawer');
    const applied = await apply(mixed.billId, { coupon_id: breakfast.id, paper_confirmed: true });
    assertEqual(applied.status, 200, 'coupon applied');
    assert(Math.abs(Number(applied.data.bill.discount_amount) - 2) < 0.001, 'bill discount is the coupon amount');
    assert(String(applied.data.bill.discount_reason).startsWith('Coupon BREAKFAST10'), 'the bill shows the coupon');
    const audit = db.prepare(`SELECT 1 FROM order_audit_log WHERE order_id = ? AND action = 'coupon_applied'`).get(mixed.orderId);
    assert(!!audit, 'using a coupon is in the order history');

    console.log('\n─── one discount per bill ───');
    const second = await apply(mixed.billId, { coupon_id: list2.data.coupons.find((c: any) => c.code === 'BRKSPECIAL15').id, paper_confirmed: true });
    assertEqual(second.status, 409, 'a second coupon is refused');
    const manual = await api(baseUrl, `/api/bills/${mixed.billId}/applyDiscount`, { method: 'POST', headers: A, body: { type: 'percentage', value: 5 } });
    assertEqual(manual.status, 409, 'a manual discount is refused while a coupon is on the bill');
    const orderDisc = await api(baseUrl, `/api/orders/${mixed.orderId}/discount`, { method: 'PATCH', headers: A, body: { discount_type: 'percentage', discount_value: 5 } });
    assertEqual(orderDisc.status, 409, 'an order discount is refused while a coupon is on the bill');
    const list3 = await forBill(mixed.billId);
    assert(list3.data.applied && list3.data.coupons.length === 0, 'checkout shows the applied coupon and no others');

    const removed = await api(baseUrl, `/api/coupons/for-bill/${mixed.billId}/remove`, { method: 'POST', headers: A, body: {} });
    assertEqual(removed.status, 200, 'coupon removed');
    assertEqual(Number(removed.data.bill.discount_amount), 0, 'discount is gone after removing the coupon');

    const manualBill = await newBill([{ product_id: 'prod-eggs', quantity: 1 }]);
    const manualOk = await api(baseUrl, `/api/bills/${manualBill.billId}/applyDiscount`, { method: 'POST', headers: A, body: { type: 'percentage', value: 5 } });
    assertEqual(manualOk.status, 200, 'manual discount on another bill');
    const list4 = await forBill(manualBill.billId);
    assert(!!list4.data.blocked && list4.data.coupons.length === 0, 'no coupons are offered on a bill that already has a discount');
    const blocked = await apply(manualBill.billId, { coupon_id: breakfast.id, paper_confirmed: true });
    assertEqual(blocked.status, 409, 'a coupon is refused when the bill already has a discount');

    console.log('\n─── shift report ───');
    const big = await newBill([{ product_id: 'prod-eggs', quantity: 6 }]);
    const bigList = await forBill(big.billId);
    const big5 = bigList.data.coupons.find((c: any) => c.code === 'BIG5');
    assert(!!big5 && big5.amount === 5, 'the $5 coupon shows once the bill is over the minimum');
    const bigApplied = await apply(big.billId, { coupon_id: big5.id, paper_confirmed: true });
    assertEqual(bigApplied.status, 200, '$5 coupon applied');
    const total = Number(bigApplied.data.bill.total);
    const paid = await api(baseUrl, `/api/bills/${big.billId}/payment`, { method: 'POST', headers: A, body: { method: 'cash', amount: total } });
    assert(paid.status >= 200 && paid.status < 300, `bill with coupon is paid (${paid.status} ${JSON.stringify(paid.data?.error ?? '')})`);
    const t = now();
    const sessionId = Number(db.prepare(`INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status) VALUES (?, 'Tester', datetime(?, '-1 hour'), 0, 'open')`).run(ownerId, t).lastInsertRowid);
    const report = require('../main/services/shift-report').buildShiftReport(sessionId);
    const row = (report.coupons || []).find((c: any) => c.code === 'BIG5');
    assert(!!row && row.count === 1 && row.totalCents === 500, 'the shift report lists the coupon used, to match the paper coupons');

    console.log('\n─── whose PIN approved the discount ───');
    const jwt = require('jsonwebtoken');
    const bcrypt = require('bcryptjs');
    const { getJWTSecret } = require('../main/routes/auth');
    db.prepare(`INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at) VALUES ('ly-1', 'Ly', 'ly@test.local', 'x', 'cashier', ?, 1, ?, ?)`)
      .run(bcrypt.hashSync('7894', 4), now(), now());
    const LY = { Authorization: `Bearer ${jwt.sign({ userId: 'ly-1', email: 'ly@test.local', role: 'cashier' }, getJWTSecret(), { expiresIn: '1h' })}` };
    setSetting(db, 'discount_requires_approval', 'true');
    const cashierCoupons = await api(baseUrl, `/api/coupons/for-bill/${drinksOnly.billId}`, { headers: LY });
    assertEqual(cashierCoupons.status, 200, 'a cashier can see coupons at checkout');

    const d1 = await newBill([{ product_id: 'prod-eggs', quantity: 1 }]);
    const noRight = await api(baseUrl, `/api/bills/${d1.billId}/applyDiscount`, { method: 'POST', headers: A, body: { type: 'percentage', value: 10, override_pin: '7894' } });
    assertEqual(noRight.status, 403, "a cashier's PIN can't approve a discount by default");
    db.prepare(`INSERT INTO user_permission_overrides (user_id, permission_id, effect, updated_by) VALUES ('ly-1', 'discounts.approve', 'allow', ?)`).run(ownerId);
    require('../main/services/authorization').invalidateAuthorizationCache?.();
    const lyOk = await api(baseUrl, `/api/bills/${d1.billId}/applyDiscount`, { method: 'POST', headers: A, body: { type: 'percentage', value: 10, reason: 'Regular', override_pin: '7894' } });
    assertEqual(lyOk.status, 200, `with the approve-discounts permission, Ly's own PIN approves (${lyOk.status} ${JSON.stringify(lyOk.data?.error ?? '')})`);
    const billAudit = db.prepare(`SELECT details_json FROM order_audit_log WHERE order_id = ? AND action = 'bill_discount_applied'`).get(d1.orderId) as { details_json: string };
    assert(!!billAudit && JSON.parse(billAudit.details_json).approved_by === 'ly-1', 'a payment-screen discount records whose PIN approved it');

    const d2 = await newBill([{ product_id: 'prod-eggs', quantity: 1 }]);
    const selfDisc = await api(baseUrl, `/api/orders/${d2.orderId}/discount`, { method: 'PATCH', headers: LY, body: { discount_type: 'percentage', discount_value: 5, override_pin: '7894' } });
    assertEqual(selfDisc.status, 200, `Ly can approve a discount on her own sale (${selfDisc.status} ${JSON.stringify(selfDisc.data?.error ?? '')})`);
    const sess2 = Number(db.prepare(`INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status) VALUES (?, 'Tester', datetime(?, '-1 hour'), 0, 'closed')`).run(ownerId, now()).lastInsertRowid);
    db.prepare(`UPDATE cash_sessions SET closed_at = datetime(?, '+1 hour') WHERE id = ?`).run(now(), sess2);
    const rep2 = require('../main/services/shift-report').buildShiftReport(sess2);
    const lyRow = (rep2.discounts || []).find((x: any) => x.kind === 'bill' && x.approvedBy === 'Ly');
    assert(!!lyRow && lyRow.amountCents === 100 && !lyRow.self, 'the report shows the $1.00 discount approved with Ly\'s PIN');
    const selfRow = (rep2.discounts || []).find((x: any) => x.kind === 'order' && x.approvedBy === 'Ly');
    assert(!!selfRow && selfRow.self, 'the report flags a discount Ly approved on her own sale');
    const couponRow = (rep2.discounts || []).find((x: any) => x.kind === 'coupon');
    assert(!!couponRow && couponRow.approvedBy === 'coupon', 'coupons show as approved by the coupon');
    const { cashierShiftRows } = require('../shared/print/cashier-receipt');
    const printed = JSON.stringify(cashierShiftRows(rep2, 'Asia/Phnom_Penh'));
    assert(printed.includes('DISCOUNTS - WHO APPROVED') && printed.includes('PIN Ly (own sale)'), 'the shift printout shows whose PIN approved each discount');

    console.log('\n─── hours ───');
    const breakfastHours = { id: 'h', code: 'AM', name: 'Morning', kind: 'percent_bill', value: 10, category_id: null, min_spend: 0, start_date: null, end_date: null, days: [], start_time: '07:00', end_time: '11:00', enabled: true };
    assert(isCouponLive(breakfastHours, new Date('2026-11-25T02:00:00Z'), 'Asia/Phnom_Penh'), '09:00 local is inside 07:00-11:00');
    assert(!isCouponLive(breakfastHours, new Date('2026-11-25T06:00:00Z'), 'Asia/Phnom_Penh'), '13:00 local is outside 07:00-11:00');
    const weekend = { ...breakfastHours, start_time: null, end_time: null, days: [0, 6] };
    assert(!isCouponLive(weekend, new Date('2026-11-25T06:00:00Z'), 'Asia/Phnom_Penh'), 'a weekend coupon is off on a Wednesday');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const { passed, failed, total } = getResults();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('FAILED');
    process.exit(1);
  } else {
    console.log('ALL PASSED');
  }
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
