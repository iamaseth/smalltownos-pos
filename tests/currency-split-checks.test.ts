const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-currency-split-'));
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments);
};

const { initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct, installAndActivateTestTaxPack, api, assertOrThrow, assertEqualOrThrow, now } = require('./helpers/test-setup');
const dualRatePackData = require('./fixtures/synthetic-dual-rate-pack.json');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes, allocateMinorUnits, allocateTaxSnapshots, projectOrderItems } = require('../main/routes/bills');
const { settingsRoutes } = require('../main/routes/settings');
const { getCurrencyFractionDigits, getCurrencyMinorUnitFactor, getCurrencyUnitAdapter } = require('../main/countries');

async function main() {
  console.log('--- Currency Split Checks & Minor-Unit Math Test Suite ---');

  // ── 1. Unit Tests: Currency Fraction & Minor Unit Factors ─────────
  console.log('\n1. Currency Fraction & Minor Unit Factors:');
  assertEqualOrThrow(getCurrencyFractionDigits('JPY'), 0, 'JPY fraction digits is 0');
  assertEqualOrThrow(getCurrencyMinorUnitFactor('JPY'), 1, 'JPY minor unit factor is 1');

  assertEqualOrThrow(getCurrencyFractionDigits('KRW'), 0, 'KRW fraction digits is 0');
  assertEqualOrThrow(getCurrencyMinorUnitFactor('KRW'), 1, 'KRW minor unit factor is 1');

  assertEqualOrThrow(getCurrencyFractionDigits('USD'), 2, 'USD fraction digits is 2');
  assertEqualOrThrow(getCurrencyMinorUnitFactor('USD'), 100, 'USD minor unit factor is 100');

  assertEqualOrThrow(getCurrencyFractionDigits('EUR'), 2, 'EUR fraction digits is 2');
  assertEqualOrThrow(getCurrencyMinorUnitFactor('EUR'), 100, 'EUR minor unit factor is 100');

  assertEqualOrThrow(getCurrencyFractionDigits('KWD'), 3, 'KWD fraction digits is 3');
  assertEqualOrThrow(getCurrencyMinorUnitFactor('KWD'), 1000, 'KWD minor unit factor is 1000');

  // Invariance check: IRR with Rial display
  const rialAdapter = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'rial' });
  assertEqualOrThrow(rialAdapter.step, '0.01', 'IRR rial adapter preserves step 0.01');
  assertEqualOrThrow(rialAdapter.maxDecimals, 2, 'IRR rial adapter preserves maxDecimals 2');

  // Invariance check: IRR with Toman display
  const tomanAdapter = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'toman' });
  assertEqualOrThrow(tomanAdapter.scale, 0.1, 'IRR toman adapter preserves scale 0.1');
  assertEqualOrThrow(tomanAdapter.step, '0.001', 'IRR toman adapter preserves step 0.001');
  assertEqualOrThrow(tomanAdapter.maxDecimals, 3, 'IRR toman adapter preserves maxDecimals 3');

  // ── 2. Mathematical Allocation: JPY vs USD ───────────────────────
  console.log('\n2. Mathematical Allocation:');
  // JPY 1000 split 3 ways with minorFactor = 1:
  const jpyFactor = getCurrencyMinorUnitFactor('JPY');
  const jpyTotalMinor = Math.round(1000 * jpyFactor);
  const jpyAllocated = allocateMinorUnits(jpyTotalMinor, [1, 1, 1]).map((m) => m / jpyFactor);
  assertEqualOrThrow(JSON.stringify(jpyAllocated), JSON.stringify([334, 333, 333]), '1000 JPY split 3 ways allocates whole yen [334, 333, 333]');
  assertOrThrow(jpyAllocated.every((val) => Number.isInteger(val)), 'Every JPY allocated check is an integer');
  assertEqualOrThrow(jpyAllocated.reduce((a, b) => a + b, 0), 1000, 'Sum of JPY split checks equals 1000 JPY');

  // USD 10.00 split 3 ways with minorFactor = 100:
  const usdFactor = getCurrencyMinorUnitFactor('USD');
  const usdTotalMinor = Math.round(10.00 * usdFactor);
  const usdAllocated = allocateMinorUnits(usdTotalMinor, [1, 1, 1]).map((m) => m / usdFactor);
  assertEqualOrThrow(JSON.stringify(usdAllocated), JSON.stringify([3.34, 3.33, 3.33]), '$10.00 USD split 3 ways allocates [3.34, 3.33, 3.33]');
  assertEqualOrThrow(Number((usdAllocated.reduce((a, b) => a + b, 0)).toFixed(2)), 10.00, 'Sum of USD split checks equals $10.00');

  const jpySnapshot = JSON.stringify({
    lines: [{
      grossAmount: 1000,
      taxableBase: 1000,
      components: [{ amount: 1, rate: 10 }],
    }],
  });
  const jpySnapshots = allocateTaxSnapshots(jpySnapshot, [1, 1], undefined, jpyFactor)
    .map((raw) => JSON.parse(raw));
  assertEqualOrThrow(jpySnapshots[0].lines[0].components[0].amount, 1, 'JPY snapshot keeps one-yen tax on first child');
  assertEqualOrThrow(jpySnapshots[1].lines[0].components[0].amount, 0, 'JPY snapshot allocates zero tax to second child');
  assertEqualOrThrow(jpySnapshots[0].lines[0].taxAmount, 1, 'JPY snapshot taxAmount uses whole-yen units');

  const projectedJpy = projectOrderItems(
    { subtotal: 1000, discount_amount: 0 },
    [{ id: 1, quantity: 1, subtotal: 1000, tax_amount: 1, total: 1001, tax_breakdown: JSON.stringify([{ amount: 1 }]), tax_snapshot: null }],
    [{ order_item_id: 1, quantity: 1 }],
    new Map(),
    jpyFactor,
  )[0];
  assertEqualOrThrow(projectedJpy.tax_amount, 1, 'Projected JPY item tax keeps whole-yen precision');

  // ── 3. End-to-End API Split Check: JPY Store ─────────────────────
  console.log('\n3. End-to-End JPY Split Check via API:');
  const db = initTestDb();
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('telemetry_enabled', 'false', ?)").run(now());
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('split_checks_enabled', 'true', ?)").run(now());
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'JP', ?)").run(now());
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('currency', 'JPY', ?)").run(now());

  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'jpy-cat', 'Tokyo Kitchen');
  seedProduct(db, 'jpy-ramen', 'jpy-cat', 'Miso Ramen', 950);
  seedProduct(db, 'jpy-gyoza', 'jpy-cat', 'Gyoza', 450);

  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes, '/api/settings': settingsRoutes });
  const { registerRoutes } = require('../main/routes/index');
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  try {
    // Create an order in JPY: 1 Ramen (950) + 1 Gyoza (450) = 1400 JPY
    const orderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        guest_count: 2,
        items: [
          { product_id: 'jpy-ramen', quantity: 1 },
          { product_id: 'jpy-gyoza', quantity: 1 },
        ],
      },
      headers: authHeader,
    });
    assertEqualOrThrow(orderRes.status, 201, 'JPY order created');
    const order = orderRes.data.order;
    const ramen = order.items.find((i) => i.product_id === 'jpy-ramen');
    const gyoza = order.items.find((i) => i.product_id === 'jpy-gyoza');

    const billRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: order.id },
      headers: authHeader,
    });
    assertEqualOrThrow(billRes.status, 201, 'JPY bill generated');
    assertEqualOrThrow(billRes.data.bill.total, 1400, 'JPY bill total is 1400');

    // Split check: Guest 1 takes Ramen (950), Guest 2 takes Gyoza (450)
    const splitRes = await api(baseUrl, `/api/bills/${billRes.data.bill.id}/split-check`, {
      method: 'POST',
      body: {
        checks: [
          { label: 'Guest 1', items: [{ order_item_id: ramen.id, quantity: 1 }] },
          { label: 'Guest 2', items: [{ order_item_id: gyoza.id, quantity: 1 }] },
        ],
      },
      headers: authHeader,
    });
    assertEqualOrThrow(splitRes.status, 201, 'JPY check split successfully');
    assertEqualOrThrow(splitRes.data.bills.length, 2, 'Two split bills created');
    assertEqualOrThrow(splitRes.data.bills[0].total, 950, 'Guest 1 bill total is exactly 950 JPY');
    assertEqualOrThrow(splitRes.data.bills[1].total, 450, 'Guest 2 bill total is exactly 450 JPY');
    assertOrThrow(Number.isInteger(splitRes.data.bills[0].total), 'Guest 1 bill total is an integer');
    assertOrThrow(Number.isInteger(splitRes.data.bills[1].total), 'Guest 2 bill total is an integer');

    // Verify DB persistence
    const dbBills = db.prepare('SELECT id, total, subtotal, balance FROM bills WHERE split_group_id = ?').all(splitRes.data.bills[0].split_group_id);
    assertEqualOrThrow(dbBills.length, 2, 'Two bills in split group in DB');
    for (const b of dbBills) {
      assertOrThrow(Number.isInteger(b.total), `Persisted bill ${b.id} total is integer: ${b.total}`);
      assertOrThrow(Number.isInteger(b.subtotal), `Persisted bill ${b.id} subtotal is integer: ${b.subtotal}`);
      assertOrThrow(Number.isInteger(b.balance), `Persisted bill ${b.id} balance is integer: ${b.balance}`);
    }

    // ── 4. Uneven Split in JPY: 3-Way Split on Shared Item ────────────
    console.log('\n4. Uneven 3-Way JPY Split on 1,000 JPY Order:');
    seedProduct(db, 'jpy-platter', 'jpy-cat', 'Shared Platter', 1000);
    const orderPlatterRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        guest_count: 3,
        items: [{ product_id: 'jpy-platter', quantity: 3 }],
      },
      headers: authHeader,
    });
    const platterOrder = orderPlatterRes.data.order;
    const platterItem = platterOrder.items[0];
    const billPlatterRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: platterOrder.id },
      headers: authHeader,
    });
    assertEqualOrThrow(billPlatterRes.data.bill.total, 3000, 'Platter bill total is 3000 JPY');

    const splitPlatterRes = await api(baseUrl, `/api/bills/${billPlatterRes.data.bill.id}/split-check`, {
      method: 'POST',
      body: {
        checks: [
          { label: 'Guest A', items: [{ order_item_id: platterItem.id, quantity: 1 }] },
          { label: 'Guest B', items: [{ order_item_id: platterItem.id, quantity: 1 }] },
          { label: 'Guest C', items: [{ order_item_id: platterItem.id, quantity: 1 }] },
        ],
      },
      headers: authHeader,
    });
    assertEqualOrThrow(splitPlatterRes.status, 201, '3-way JPY platter split succeeded');
    assertEqualOrThrow(splitPlatterRes.data.bills.length, 3, 'Three bills created');
    for (const b of splitPlatterRes.data.bills) {
      assertEqualOrThrow(b.total, 1000, `Child check ${b.split_label} has total 1000 JPY`);
      assertOrThrow(Number.isInteger(b.total), `Child check ${b.split_label} is integer`);
    }

    // ── 5. End-to-End USD Split Check Regression ─────────────────────
    console.log('\n5. End-to-End USD Split Check Regression:');
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'US', ?)").run(now());
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('currency', 'USD', ?)").run(now());

    seedCategory(db, 'usd-cat', 'US Diner');
    seedProduct(db, 'usd-burger', 'usd-cat', 'Cheeseburger', 10.00);

    const usdOrderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        guest_count: 2,
        items: [{ product_id: 'usd-burger', quantity: 2 }],
      },
      headers: authHeader,
    });
    const usdOrder = usdOrderRes.data.order;
    const usdBurgers = usdOrder.items[0];

    const usdBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: usdOrder.id },
      headers: authHeader,
    });
    assertEqualOrThrow(usdBillRes.data.bill.total, 20.00, 'USD bill total is $20.00');

    const usdSplitRes = await api(baseUrl, `/api/bills/${usdBillRes.data.bill.id}/split-check`, {
      method: 'POST',
      body: {
        checks: [
          { label: 'Seat 1', items: [{ order_item_id: usdBurgers.id, quantity: 1 }] },
          { label: 'Seat 2', items: [{ order_item_id: usdBurgers.id, quantity: 1 }] },
        ],
      },
      headers: authHeader,
    });
    assertEqualOrThrow(usdSplitRes.status, 201, 'USD check split succeeded');
    assertEqualOrThrow(usdSplitRes.data.bills[0].total, 10.00, 'Seat 1 bill is $10.00');
    assertEqualOrThrow(usdSplitRes.data.bills[1].total, 10.00, 'Seat 2 bill is $10.00');

    // ── 6. Guest splits: shared items, totals reconcile, undo split ──
    console.log('\n6. Guest Splits (2/4/8 guests, shared items, undo):');
    const setRegion = (country, currency) => {
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', ?, ?)").run(country, now());
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('currency', ?, ?)").run(currency, now());
    };
    const FIELDS = ['subtotal', 'tax_amount', 'discount_amount', 'service_charge', 'round_off', 'total'];
    const openBill = async ({ items, guest_count = 2, service_charge, discount }) => {
      const res = await api(baseUrl, '/api/orders', { method: 'POST', body: { type: 'dine_in', guest_count, items, ...(service_charge ? { service_charge } : {}) }, headers: authHeader });
      assertEqualOrThrow(res.status, 201, 'guest-split order created');
      if (discount) {
        const d = await api(baseUrl, `/api/orders/${res.data.order.id}/discount`, { method: 'PATCH', body: { discount_type: 'percentage', discount_value: discount, discount_reason: 'test' }, headers: authHeader });
        assertEqualOrThrow(d.status, 200, 'discount applied before split');
      }
      const bill = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: res.data.order.id }, headers: authHeader });
      assertEqualOrThrow(bill.status, 201, 'guest-split bill generated');
      const order = (await api(baseUrl, `/api/orders/${res.data.order.id}`, { headers: authHeader })).data.order || res.data.order;
      return { order, bill: bill.data.bill };
    };
    const split = (billId, checks) => api(baseUrl, `/api/bills/${billId}/split-check`, { method: 'POST', body: { checks }, headers: authHeader });
    const assertReconciles = (name, source, bills, factor) => {
      for (const field of FIELDS) {
        const sum = bills.reduce((acc, b) => acc + Math.round(Number(b[field] || 0) * factor), 0);
        assertEqualOrThrow(sum, Math.round(Number(source[field] || 0) * factor), `${name}: ${field} adds up exactly`);
      }
      for (const b of bills) assertEqualOrThrow(b.balance, b.total, `${name}: ${b.split_label} balance equals total`);
    };
    const roundRobin = (items, guests) => Array.from({ length: guests }, (_, g) => ({
      label: `Guest ${g + 1}`,
      items: items.flatMap((item) => {
        const qty = Array.from({ length: item.quantity }, (_, u) => u % guests).filter((slot) => slot === g).length;
        return qty > 0 ? [{ order_item_id: item.id, quantity: qty }] : [];
      }),
    }));

    setRegion('US', 'USD');
    seedProduct(db, 'g-beer', 'usd-cat', 'Beer', 2.5);
    seedProduct(db, 'g-coffee', 'usd-cat', 'Coffee', 1.75);
    seedProduct(db, 'g-platter', 'usd-cat', 'Platter', 10);
    seedProduct(db, 'g-wings', 'usd-cat', 'Wings', 6.35);

    // 2 guests, split evenly, with service charge and discount
    {
      const { order, bill } = await openBill({ items: [{ product_id: 'g-beer', quantity: 3 }, { product_id: 'g-wings', quantity: 1 }], service_charge: 1.5, discount: 10 });
      const res = await split(bill.id, roundRobin(order.items, 2).map((c, i) => (c.items.length ? c : { ...c, items: [{ order_item_id: order.items[0].id, quantity: 1 }] })));
      assertEqualOrThrow(res.status, 201, '2 guests split evenly');
      assertReconciles('2 guests even', bill, res.data.bills, 100);
    }

    // 4 guests, each pays own
    {
      const { order, bill } = await openBill({ guest_count: 4, items: [{ product_id: 'g-beer', quantity: 1 }, { product_id: 'g-coffee', quantity: 1 }, { product_id: 'g-platter', quantity: 1 }, { product_id: 'g-wings', quantity: 1 }], service_charge: 2 });
      const res = await split(bill.id, order.items.map((item, i) => ({ label: `Guest ${i + 1}`, items: [{ order_item_id: item.id, quantity: 1 }] })));
      assertEqualOrThrow(res.status, 201, '4 guests each pay own');
      assertReconciles('4 guests own', bill, res.data.bills, 100);
    }

    // 8 guests, split evenly plus one platter shared by all 8
    {
      const { order, bill } = await openBill({ guest_count: 8, items: [{ product_id: 'g-beer', quantity: 8 }, { product_id: 'g-coffee', quantity: 9 }, { product_id: 'g-platter', quantity: 1 }], discount: 15, service_charge: 3.33 });
      const platter = order.items.find((i) => i.product_id === 'g-platter');
      const others = order.items.filter((i) => i.id !== platter.id);
      const checks = roundRobin(others, 8).map((c) => ({ ...c, items: [...c.items, { order_item_id: platter.id, share: { of: 8 } }] }));
      const res = await split(bill.id, checks);
      assertEqualOrThrow(res.status, 201, '8 guests with shared platter');
      assertReconciles('8 guests shared', bill, res.data.bills, 100);
      const shareRows = db.prepare('SELECT share_of, quantity FROM bill_items WHERE order_item_id = ?').all(platter.id);
      assertEqualOrThrow(shareRows.length, 8, 'shared platter recorded on all 8 bills');
      assertOrThrow(shareRows.every((r) => r.share_of === 8 && r.quantity === 1), 'shared rows store share_of 8');
    }

    // Shared item: price divided evenly, leftover cent to first guest
    {
      const { order, bill } = await openBill({ guest_count: 3, items: [{ product_id: 'g-platter', quantity: 1 }] });
      const platter = order.items[0];
      const res = await split(bill.id, [1, 2, 3].map((g) => ({ label: `Guest ${g}`, items: [{ order_item_id: platter.id, share: { of: 3 } }] })));
      assertEqualOrThrow(res.status, 201, 'platter shared by 3');
      assertEqualOrThrow(JSON.stringify(res.data.bills.map((b) => b.total)), JSON.stringify([3.34, 3.33, 3.33]), 'shared $10 platter: leftover cent goes to first guest');
      const lineTotals = [];
      for (const b of res.data.bills) {
        const detail = await api(baseUrl, `/api/bills/${b.id}`, { headers: authHeader });
        const line = (detail.data.bill?.order?.items || detail.data.order?.items || detail.data.items || []).find((i) => i.id === platter.id);
        assertOrThrow(line && line.share_of === 3, `${b.split_label} bill shows the shared platter (1/3)`);
        lineTotals.push(line.total);
      }
      assertEqualOrThrow(JSON.stringify(lineTotals), JSON.stringify([3.34, 3.33, 3.33]), 'shared line amounts on each bill add up to the item price');
    }

    // Invalid shares are refused
    {
      const { order, bill } = await openBill({ items: [{ product_id: 'g-platter', quantity: 1 }, { product_id: 'g-beer', quantity: 1 }] });
      const [p, b] = [order.items.find((i) => i.product_id === 'g-platter'), order.items.find((i) => i.product_id === 'g-beer')];
      const bad1 = await split(bill.id, [{ label: 'A', items: [{ order_item_id: p.id, share: { of: 3 } }, { order_item_id: b.id, quantity: 1 }] }, { label: 'B', items: [{ order_item_id: p.id, share: { of: 3 } }] }]);
      assertEqualOrThrow(bad1.status, 400, 'share of more guests than checks is refused');
      const bad2 = await split(bill.id, [{ label: 'A', items: [{ order_item_id: p.id, share: { of: 2 } }, { order_item_id: b.id, quantity: 1 }] }, { label: 'B', items: [{ order_item_id: p.id, quantity: 1 }] }]);
      assertEqualOrThrow(bad2.status, 400, 'mixing a share with a quantity is refused');
      assertEqualOrThrow(db.prepare('SELECT COUNT(*) AS n FROM bills WHERE order_id = ?').get(order.id).n, 1, 'refused splits leave one bill');
    }

    // Undo split: allowed before payment, refused after
    {
      const { order, bill } = await openBill({ guest_count: 3, items: [{ product_id: 'g-beer', quantity: 2 }, { product_id: 'g-platter', quantity: 1 }, { product_id: 'g-coffee', quantity: 1 }], service_charge: 1, discount: 5 });
      const platter = order.items.find((i) => i.product_id === 'g-platter');
      const beer = order.items.find((i) => i.product_id === 'g-beer');
      const coffee = order.items.find((i) => i.product_id === 'g-coffee');
      const checks = [
        { label: 'Sok', items: [{ order_item_id: beer.id, quantity: 1 }, { order_item_id: platter.id, share: { of: 3 } }] },
        { label: 'Guest 2', items: [{ order_item_id: beer.id, quantity: 1 }, { order_item_id: platter.id, share: { of: 3 } }] },
        { label: 'Guest 3', items: [{ order_item_id: coffee.id, quantity: 1 }, { order_item_id: platter.id, share: { of: 3 } }] },
      ];
      const first = await split(bill.id, checks);
      assertEqualOrThrow(first.status, 201, 'split before undo');
      const undo = await api(baseUrl, `/api/bills/${first.data.bills[1].id}/unsplit`, { method: 'POST', headers: authHeader });
      assertEqualOrThrow(undo.status, 200, 'undo split allowed before any payment');
      const remaining = db.prepare('SELECT * FROM bills WHERE order_id = ?').all(order.id);
      assertEqualOrThrow(remaining.length, 1, 'undo merges back into one bill');
      assertEqualOrThrow(remaining[0].id, bill.id, 'the original bill is kept');
      assertEqualOrThrow(remaining[0].split_group_id, null, 'kept bill is no longer split');
      for (const field of FIELDS) assertEqualOrThrow(Math.round(Number(remaining[0][field] || 0) * 100), Math.round(Number(bill[field] || 0) * 100), `undo restores ${field}`);
      assertEqualOrThrow(db.prepare('SELECT COUNT(*) AS n FROM bill_items WHERE bill_id = ?').get(bill.id).n, 0, 'undo clears split allocations');
      assertOrThrow(db.prepare("SELECT 1 FROM order_audit_log WHERE order_id = ? AND action = 'split_undone'").get(order.id), 'undo is recorded in the order audit log');

      const again = await split(bill.id, checks);
      assertEqualOrThrow(again.status, 201, 'bill can be split again after undo');
      const pay = await api(baseUrl, `/api/bills/${again.data.bills[0].id}/payment`, { method: 'POST', body: { method: 'cash', amount: again.data.bills[0].total }, headers: authHeader });
      assertOrThrow(pay.status === 200 || pay.status === 201, 'one split bill paid');
      const refused = await api(baseUrl, `/api/bills/${again.data.bills[1].id}/unsplit`, { method: 'POST', headers: authHeader });
      assertEqualOrThrow(refused.status, 409, 'undo split refused once a split bill has a payment');
      assertOrThrow(/payment/i.test(refused.data.error || ''), 'refusal explains a payment exists');
      assertEqualOrThrow(db.prepare('SELECT COUNT(*) AS n FROM bills WHERE order_id = ?').get(order.id).n, 3, 'refused undo leaves the split bills');
      const orderRow = db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id);
      assertOrThrow(orderRow.status !== 'completed', 'order stays open until every split bill is paid');
    }

    // Tax (exclusive 5%) with discount and service charge, shared item
    {
      const pack = {
        ...dualRatePackData,
        id: 'test-guest-split-pack',
        country: 'IN',
        currency: 'INR',
        categories: dualRatePackData.categories.map((category) => ({ ...category, ruleIds: category.id === 'standard' ? ['item-tax'] : [] })),
        rules: [{ ...dualRatePackData.rules[0], id: 'item-tax', label: 'Item Tax', categoryIds: ['standard'], rate: '5' }],
      };
      setRegion('IN', 'INR');
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_type', 'restaurant', ?), ('state_code', '27', ?)").run(now(), now());
      installAndActivateTestTaxPack(db, pack);
      seedCategory(db, 'g-tax-cat', 'Taxed');
      seedProduct(db, 'g-tax-curry', 'g-tax-cat', 'Curry', 237.5, { tax_category_id: 'standard', tax_behavior: 'exclusive' });
      seedProduct(db, 'g-tax-naan', 'g-tax-cat', 'Naan', 41.25, { tax_category_id: 'standard', tax_behavior: 'exclusive' });
      const { order, bill } = await openBill({ guest_count: 3, items: [{ product_id: 'g-tax-curry', quantity: 1 }, { product_id: 'g-tax-naan', quantity: 5 }], service_charge: 20, discount: 10 });
      assertOrThrow(Number(bill.tax_amount) > 0, 'taxed bill has tax');
      const curry = order.items.find((i) => i.product_id === 'g-tax-curry');
      const naan = order.items.find((i) => i.product_id === 'g-tax-naan');
      const res = await split(bill.id, [
        { label: 'A', items: [{ order_item_id: curry.id, share: { of: 3 } }, { order_item_id: naan.id, quantity: 2 }] },
        { label: 'B', items: [{ order_item_id: curry.id, share: { of: 3 } }, { order_item_id: naan.id, quantity: 2 }] },
        { label: 'C', items: [{ order_item_id: curry.id, share: { of: 3 } }, { order_item_id: naan.id, quantity: 1 }] },
      ]);
      assertEqualOrThrow(res.status, 201, 'taxed split with shared item');
      assertReconciles('taxed shared', bill, res.data.bills, 100);
    }

    // KHR rounding with a shared item
    {
      setRegion('KH', 'KHR');
      seedCategory(db, 'g-khr-cat', 'Riel menu');
      seedProduct(db, 'g-khr-fish', 'g-khr-cat', 'Fish amok', 10050);
      seedProduct(db, 'g-khr-tea', 'g-khr-cat', 'Iced tea', 2350);
      const { order, bill } = await openBill({ guest_count: 3, items: [{ product_id: 'g-khr-fish', quantity: 1 }, { product_id: 'g-khr-tea', quantity: 2 }], service_charge: 1500 });
      const fish = order.items.find((i) => i.product_id === 'g-khr-fish');
      const tea = order.items.find((i) => i.product_id === 'g-khr-tea');
      const res = await split(bill.id, [
        { label: 'A', items: [{ order_item_id: fish.id, share: { of: 3 } }, { order_item_id: tea.id, quantity: 1 }] },
        { label: 'B', items: [{ order_item_id: fish.id, share: { of: 3 } }, { order_item_id: tea.id, quantity: 1 }] },
        { label: 'C', items: [{ order_item_id: fish.id, share: { of: 3 } }] },
      ]);
      assertEqualOrThrow(res.status, 201, 'KHR split with shared item');
      assertReconciles('KHR shared', bill, res.data.bills, getCurrencyMinorUnitFactor('KHR'));
    }

    console.log('\n✅ All currency split-check and precision tests passed successfully!');
  } finally {
    server.close();
    db.close();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
