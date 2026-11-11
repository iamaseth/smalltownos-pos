/**
 * Order list: low-stock ingredients grouped by vendor, rounded up to whole packs.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/supply-order-list.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-supply-order-list-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertOrThrow, assertEqualOrThrow, getResults, resetCounters, seedOwnerUser,
} = require('./helpers/test-setup');
const { createSupply, buildOrderList, updateSupply } = require('../main/services/supplies');

async function main() {
  console.log('Supply order list test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO vendors (id, name, is_active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').run('ven_a', 'Chhay', ts, ts);

  createSupply(db, { name: 'Olive oil', baseUnit: 'ml', stockQuantity: 1000, lowStockThreshold: 2000, unitCost: 0.01, packSize: 5000, packLabel: 'jug', orderUpTo: 12000, vendorId: 'ven_a', actorUserId: actor });
  createSupply(db, { name: 'Baked beans', baseUnit: 'each', stockQuantity: 1, lowStockThreshold: 2, unitCost: 8, orderUpTo: 6, vendorId: 'ven_a', actorUserId: actor });
  createSupply(db, { name: 'Lemons', baseUnit: 'each', stockQuantity: 0, lowStockThreshold: 5, orderUpTo: 20, actorUserId: actor });
  createSupply(db, { name: 'Salt', baseUnit: 'kg', stockQuantity: 0.5, lowStockThreshold: 1, vendorId: 'ven_a', actorUserId: actor });
  createSupply(db, { name: 'Flour', baseUnit: 'kg', stockQuantity: 50, lowStockThreshold: 5, orderUpTo: 80, vendorId: 'ven_a', actorUserId: actor });
  createSupply(db, { name: 'Sugar', baseUnit: 'kg', stockQuantity: 0, lowStockThreshold: 5, unitCost: 1, orderUpTo: 10, actorUserId: actor });

  db.prepare("UPDATE supplies SET stock_quantity = -2 WHERE name = 'Sugar'").run();

  const { groups } = buildOrderList(db);
  assertEqualOrThrow(groups.length, 2, 'one group per vendor plus one for no vendor');
  assertEqualOrThrow(groups[0].vendor_name, 'Chhay', 'vendor groups come first');
  assertEqualOrThrow(groups[1].vendor_name, null, 'no-vendor group comes last');

  const chhay = groups[0];
  const names = chhay.items.map((i: any) => i.name);
  assertOrThrow(!names.includes('Flour'), 'items above their reorder point are left out');
  assertEqualOrThrow(names.length, 3, 'low items for the vendor are listed');

  const oil = chhay.items.find((i: any) => i.name === 'Olive oil');
  assertEqualOrThrow(oil.packs, 3, 'needs 11000 ml, rounds up to 3 jugs of 5000 ml');
  assertEqualOrThrow(oil.order_quantity, 15000, 'order quantity is whole packs in base units');
  assertEqualOrThrow(oil.estimated_cost, 150, 'estimated cost uses whole packs');

  const beans = chhay.items.find((i: any) => i.name === 'Baked beans');
  assertEqualOrThrow(beans.packs, null, 'no pack size means no pack count');
  assertEqualOrThrow(beans.order_quantity, 5, 'order up to 6 with 1 on hand orders 5');
  assertEqualOrThrow(beans.estimated_cost, 40, 'estimated cost for loose units');

  const salt = chhay.items.find((i: any) => i.name === 'Salt');
  assertEqualOrThrow(salt.order_quantity, null, 'no order-up-to target means no quantity');
  assertEqualOrThrow(chhay.missing_cost_count, 1, 'items without a quantity or cost are counted');
  assertEqualOrThrow(chhay.estimated_cost, 190, 'group total sums only priced items');

  const none = groups[1];
  const sugar = none.items.find((i: any) => i.name === 'Sugar');
  assertEqualOrThrow(sugar.order_quantity, 10, 'negative stock counts as zero on hand');
  const lemons = none.items.find((i: any) => i.name === 'Lemons');
  assertEqualOrThrow(lemons.estimated_cost, null, 'no cost means no estimate');

  const lemonRow = db.prepare("SELECT id FROM supplies WHERE name = 'Lemons'").get();
  updateSupply(db, lemonRow.id, { isActive: false, actorUserId: actor });
  const after = buildOrderList(db).groups.find((g: any) => g.vendor_name === null);
  assertOrThrow(!after.items.some((i: any) => i.name === 'Lemons'), 'inactive items are left out');

  const { passed, failed, total } = getResults();
  console.log(`\nPassed: ${passed}/${total}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
