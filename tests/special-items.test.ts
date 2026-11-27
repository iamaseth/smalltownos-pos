/**
 * BackStreet: Special items. The owner picks a kitchen and a bar category; the cashier taps
 * Special, types what it is and the price. Only the hidden Special items accept a typed price,
 * only staff with orders.special-item may add one, and each one is in the order history.
 * Run: node tests/run-electron-node-test.cjs tests/special-items.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-special-items-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const jwt = require('jsonwebtoken');
const {
  initTestDb, createApp, startServer, seedOwnerUser, seedCategory, seedProduct,
  api, assert, assertEqual, getResults, closeDatabase, now,
} = require('./helpers/test-setup');
const { orderRoutes } = require('../main/routes/orders');
const { specialItemRoutes } = require('../main/routes/special-items');
const { getJWTSecret } = require('../main/routes/auth');
const { calculateTaxPreview } = require('../main/services/tax');
const { defaultPermissionIdsForRole } = require('../shared/permissions');

function seedRoleUser(db: any, id: string, role: string) {
  db.prepare(`INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, 'x', ?, 1, ?, ?)`)
    .run(id, id, `${id}@test.local`, role, now(), now());
  return { Authorization: `Bearer ${jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' })}` };
}

async function main(): Promise<void> {
  console.log('Special items');
  const db = initTestDb();
  const { authHeader: A } = seedOwnerUser(db);
  const S = seedRoleUser(db, 'server-1', 'server');
  const C = seedRoleUser(db, 'cashier-1', 'cashier');
  seedCategory(db, 'cat-western', 'WESTERN');
  seedCategory(db, 'cat-drinks', 'DRINKS');
  seedProduct(db, 'prod-burger', 'cat-western', 'Burger', 6);

  const app = createApp({ '/api/orders': orderRoutes, '/api/special-items': specialItemRoutes });
  app.post('/api/tax/preview', (req: any, res: any) => calculateTaxPreview(req, res));
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── setup ───');
    const off = await api(baseUrl, '/api/special-items', { headers: A });
    assert(off.status === 200 && off.data.enabled === false, 'the Special button is off until set up');
    const notOwner = await api(baseUrl, '/api/special-items', { method: 'PUT', headers: C, body: { kitchen_category_id: 'cat-western' } });
    assert(notOwner.status === 403, 'a cashier cannot change the setup');
    const badCat = await api(baseUrl, '/api/special-items', { method: 'PUT', headers: A, body: { kitchen_category_id: 'nope' } });
    assertEqual(badCat.status, 400, 'a missing category is refused');
    const saved = await api(baseUrl, '/api/special-items', { method: 'PUT', headers: A, body: { kitchen_category_id: 'cat-western', bar_category_id: 'cat-drinks' } });
    assert(saved.status === 200 && saved.data.enabled && saved.data.kitchen.categoryName === 'WESTERN' && saved.data.bar.categoryName === 'DRINKS', 'owner sets kitchen and bar categories');
    const kitchenId = saved.data.kitchen.productId;
    const barId = saved.data.bar.productId;
    const hidden = db.prepare(`SELECT name, category_id, tags, price FROM products WHERE id = ?`).get(kitchenId) as any;
    assert(hidden.name === 'Special (kitchen)' && hidden.category_id === 'cat-western' && JSON.parse(hidden.tags).includes('special_item'), 'a hidden Special item is made in the kitchen category');
    const again = await api(baseUrl, '/api/special-items', { method: 'PUT', headers: A, body: { kitchen_category_id: 'cat-drinks' } });
    assert(again.data.kitchen.productId === kitchenId && again.data.kitchen.categoryId === 'cat-drinks', 'changing the category moves the same item, no duplicates');
    await api(baseUrl, '/api/special-items', { method: 'PUT', headers: A, body: { kitchen_category_id: 'cat-western' } });
    const cashierView = await api(baseUrl, '/api/special-items', { headers: C });
    assert(cashierView.data.can_add === true, 'a cashier may add specials by default');
    const serverView = await api(baseUrl, '/api/special-items', { headers: S });
    assert(serverView.status === 200 && serverView.data.can_add === false, 'a waiter (server role) may not by default');
    assert(defaultPermissionIdsForRole('manager').includes('orders.special-item') && !defaultPermissionIdsForRole('server').includes('orders.special-item'), 'the permission is on for owner, manager and cashier');

    console.log('\n─── adding a special ───');
    const create = await api(baseUrl, '/api/orders', {
      method: 'POST', headers: C,
      body: { type: 'takeaway', items: [{ product_id: kitchenId, quantity: 1, custom_name: '  Grilled   river fish ', custom_price: 8.5 }, { product_id: 'prod-burger', quantity: 1 }] },
    });
    assertEqual(create.status, 201, 'an order with a special is created');
    const lines = create.data.order.items as any[];
    const fish = lines.find((i) => i.product_id === kitchenId);
    assert(fish && fish.product_name === 'Grilled river fish' && Number(fish.unit_price) === 8.5, 'the line has the typed name and price');
    assert(Number(lines.find((i) => i.product_id === 'prod-burger').unit_price) === 6, 'normal items keep their menu price');
    assert(Math.abs(Number(create.data.order.subtotal) - 14.5) < 0.001, 'the bill adds up with the special');
    const audit = db.prepare(`SELECT details_json AS details FROM order_audit_log WHERE order_id = ? AND action = 'special_items_added'`).get(String(create.data.order.id)) as any;
    assert(audit && JSON.parse(audit.details).special_items[0].name === 'Grilled river fish', 'the special is in the order history');

    const added = await api(baseUrl, `/api/orders/${create.data.order.id}/items`, {
      method: 'POST', headers: C, body: { items: [{ product_id: barId, quantity: 2, custom_name: 'Mango shake', custom_price: '3.256' }] },
    });
    assertEqual(added.status, 200, 'a bar special can be added to an open order');
    const shake = (added.data.order.items as any[]).find((i) => i.product_name === 'Mango shake');
    assert(shake && Number(shake.unit_price) === 3.26 && shake.quantity === 2, 'price is rounded to cents');
    const auditAdd = db.prepare(`SELECT details_json AS details FROM order_audit_log WHERE order_id = ? AND action = 'items_added' ORDER BY id DESC`).get(String(create.data.order.id)) as any;
    assert(auditAdd && JSON.parse(auditAdd.details).special_items?.[0]?.name === 'Mango shake', 'items added: the history names the special');

    console.log('\n─── refused ───');
    const post = (headers: any, item: any) => api(baseUrl, '/api/orders', { method: 'POST', headers, body: { type: 'takeaway', items: [item] } });
    assertEqual((await post(S, { product_id: kitchenId, quantity: 1, custom_name: 'Fish', custom_price: 5 })).status, 403, 'staff without the permission cannot add a special');
    assertEqual((await post(C, { product_id: kitchenId, quantity: 1, custom_price: 5 })).status, 400, 'a special needs a name');
    assertEqual((await post(C, { product_id: kitchenId, quantity: 1, custom_name: 'Fish' })).status, 400, 'a special needs a price');
    assertEqual((await post(C, { product_id: kitchenId, quantity: 1, custom_name: 'Fish', custom_price: -2 })).status, 400, 'a negative price is refused');
    assertEqual((await post(C, { product_id: kitchenId, quantity: 1, custom_name: 'Fish', custom_price: 50000 })).status, 400, 'a silly price is refused');
    assertEqual((await post(C, { product_id: kitchenId, quantity: 1, custom_name: 'x'.repeat(61), custom_price: 5 })).status, 400, 'a very long name is refused');
    const sneaky = await post(C, { product_id: 'prod-burger', quantity: 1, custom_name: 'Burger', custom_price: 0.5 });
    assert(sneaky.status === 201 && Number(sneaky.data.order.items[0].unit_price) === 6 && sneaky.data.order.items[0].product_name === 'Burger', 'a typed price on a normal item is ignored');

    console.log('\n─── preview and switching off ───');
    const preview = await api(baseUrl, '/api/tax/preview', { method: 'POST', headers: C, body: { items: [{ product_id: kitchenId, quantity: 1, custom_name: 'Fish', custom_price: 8.5 }] } });
    assert(preview.status === 200 && Math.abs(Number(preview.data.summary?.subtotal) - 8.5) < 0.001 && Number(preview.data.items[0].unit_price) === 8.5, 'the cart total preview uses the typed price');
    const turnedOff = await api(baseUrl, '/api/special-items', { method: 'PUT', headers: A, body: { kitchen_category_id: null, bar_category_id: '' } });
    assert(turnedOff.data.enabled === false, 'clearing both categories turns the Special button off');
    assertEqual((await post(C, { product_id: kitchenId, quantity: 1, custom_name: 'Fish', custom_price: 5 })).status, 400, 'once off, the hidden item cannot be sold');
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may still hold the test database open */ }
  }
  const { passed, failed } = getResults();
  console.log(`\nspecial-items: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
