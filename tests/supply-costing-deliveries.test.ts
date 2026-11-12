/**
 * Supply costing: pack conversion, weighted-average cost on delivery, vendors link.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/supply-costing-deliveries.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-supply-costing-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertOrThrow, assertEqualOrThrow, getResults, resetCounters, seedOwnerUser, seedCategory, seedProduct,
} = require('./helpers/test-setup');
const { createSupply, getSupply, receiveDelivery, updateSupply } = require('../main/services/supplies');

function expectError(fn: () => void, statusCode: number, label: string): void {
  let thrown: any = null;
  try { fn(); } catch (error: any) { thrown = error; }
  assertOrThrow(thrown !== null, `${label} should throw`);
  assertEqualOrThrow(thrown.statusCode, statusCode, label);
}

async function main() {
  console.log('Supply costing and deliveries test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;
  db.prepare("INSERT INTO vendors (id, name) VALUES ('ven_test', 'Test Wholesale')").run();

  const whisky = createSupply(db, {
    name: 'Whisky', baseUnit: 'ml', packSize: 700, packLabel: 'bottle', pourSize: 30,
    lowStockThreshold: 700, orderUpTo: 2100, actorUserId: actor,
  });
  assertEqualOrThrow(whisky.pack_size, 700, 'create stores pack size');
  assertEqualOrThrow(whisky.pour_size, 30, 'create stores pour size');
  assertEqualOrThrow(whisky.order_up_to, 2100, 'create stores order-up-to');
  assertEqualOrThrow(whisky.unit_cost, null, 'cost starts empty');

  // first delivery: 2 bottles at 40 each
  const first = receiveDelivery(db, {
    vendorId: 'ven_test', reference: 'INV-1', actorUserId: actor,
    lines: [{ supplyId: whisky.id, packs: 2, packPrice: 40 }],
  });
  assertEqualOrThrow(first.lines[0].received_quantity, 1400, 'two bottles are 1400 ml');
  assertEqualOrThrow(first.lines[0].stock_after, 1400, 'stock rises by delivery');
  assertEqualOrThrow(Number(first.lines[0].average_cost.toFixed(6)), Number((40 / 700).toFixed(6)), 'first delivery sets cost per ml');
  assertEqualOrThrow(getSupply(db, whisky.id).vendor_id, 'ven_test', 'vendor is remembered on the ingredient');

  // second delivery at a different price: 1 bottle at 52, with 1400 ml on hand
  const second = receiveDelivery(db, {
    actorUserId: actor,
    lines: [{ supplyId: whisky.id, packs: 1, packPrice: 52 }],
  });
  const expectedAverage = (1400 * (40 / 700) + 700 * (52 / 700)) / 2100;
  assertEqualOrThrow(
    Number(second.lines[0].average_cost.toFixed(6)),
    Number(expectedAverage.toFixed(6)),
    'weighted average across two deliveries',
  );
  assertEqualOrThrow(second.lines[0].stock_after, 2100, 'stock after second delivery');

  const movement = db.prepare(
    "SELECT unit_cost, reference_type FROM supply_movements WHERE movement_type = 'receive' ORDER BY id DESC LIMIT 1",
  ).get();
  assertEqualOrThrow(movement.reference_type, 'delivery', 'receive movement is tied to a delivery');
  assertOrThrow(movement.unit_cost > 0, 'receive movement keeps the unit cost');

  // first-in, first-out price in use: 2100 ml on hand = 700 ml @ 52/700 on top of 1400 ml @ 40/700
  const { supplyCostInUse } = require('../main/services/supply-cost');
  const inUse = (stock: number) => supplyCostInUse(db, whisky.id, stock, getSupply(db, whisky.id).unit_cost);
  assertEqualOrThrow(Number(inUse(2100).current.toFixed(6)), Number((40 / 700).toFixed(6)), 'the older delivery sets the price while it still has stock');
  assertEqualOrThrow(Number(inUse(2100).next.toFixed(6)), Number((52 / 700).toFixed(6)), 'the newer delivery is the next price');
  assertEqualOrThrow(Number(inUse(701).current.toFixed(6)), Number((40 / 700).toFixed(6)), 'one unit of the older delivery left still uses the old price');
  assertEqualOrThrow(Number(inUse(700).current.toFixed(6)), Number((52 / 700).toFixed(6)), 'the price switches once the older delivery is used up');
  assertEqualOrThrow(inUse(700).next, null, 'no next price when only the newest delivery remains');
  assertEqualOrThrow(Number(inUse(0).current.toFixed(6)), Number((52 / 700).toFixed(6)), 'with no stock the latest price is shown');
  assertEqualOrThrow(Number(inUse(2500).current.toFixed(6)), Number(getSupply(db, whisky.id).unit_cost.toFixed(6)), 'stock older than the history uses the stored cost');

  seedCategory(db, 'cat-fifo', 'FIFO');
  seedProduct(db, 'prod-fifo', 'cat-fifo', 'Whisky pour', 8);
  const { saveRecipe, getRecipeByProduct } = require('../main/services/recipes');
  saveRecipe(db, { productId: 'prod-fifo', yieldQuantity: 1, isActive: true, items: [{ supplyId: whisky.id, quantity: 30, unit: 'ml' }] });
  assertEqualOrThrow(Number(getRecipeByProduct(db, 'prod-fifo').cost_per_serving.toFixed(6)), Number((30 * 0.057143).toFixed(6)), 'recipe cost uses the price in use (delivery cost is stored to 6 places)');

  // quantity + total cost path, in another unit (1 l at 30 total = 0.03 per ml)
  const syrup = createSupply(db, { name: 'Syrup', baseUnit: 'ml', actorUserId: actor });
  const syrupDelivery = receiveDelivery(db, {
    actorUserId: actor,
    lines: [{ supplyId: syrup.id, quantity: 1, unit: 'l', totalCost: 30 }],
  });
  assertEqualOrThrow(syrupDelivery.lines[0].received_quantity, 1000, 'litres convert to ml');
  assertEqualOrThrow(syrupDelivery.lines[0].average_cost, 0.03, 'cost per ml from total');

  // negative stock does not drag the weighted average
  const lime = createSupply(db, { name: 'Lime', baseUnit: 'each', actorUserId: actor });
  db.prepare('UPDATE supplies SET stock_quantity = -5, unit_cost = 0.5 WHERE id = ?').run(lime.id);
  const limeDelivery = receiveDelivery(db, {
    actorUserId: actor,
    lines: [{ supplyId: lime.id, quantity: 10, totalCost: 10 }],
  });
  assertEqualOrThrow(limeDelivery.lines[0].average_cost, 1, 'negative stock is ignored in the average');

  // validation
  expectError(() => receiveDelivery(db, { actorUserId: actor, lines: [] }), 400, 'empty delivery refused');
  expectError(
    () => receiveDelivery(db, { actorUserId: actor, lines: [{ supplyId: lime.id, packs: 1, packPrice: 5 }] }),
    400, 'packs need a pack size',
  );
  expectError(
    () => receiveDelivery(db, { vendorId: 'missing', actorUserId: actor, lines: [{ supplyId: lime.id, quantity: 1 }] }),
    400, 'unknown vendor refused',
  );
  expectError(() => updateSupply(db, whisky.id, { pourSize: 0 }), 400, 'pour size must be positive');
  expectError(() => updateSupply(db, whisky.id, { unitCost: -1 }), 400, 'cost cannot be negative');

  const unchanged = updateSupply(db, whisky.id, { name: 'House whisky' });
  assertEqualOrThrow(unchanged.pack_size, 700, 'rename keeps costing fields');
  assertEqualOrThrow(unchanged.order_up_to, 2100, 'rename keeps order-up-to');

  console.log('='.repeat(50));
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
