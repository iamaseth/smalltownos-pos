/**
 * Recipe costing: cost per serving, margin, incomplete costs, unit conversion.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/recipe-costing.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-recipe-costing-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertOrThrow, assertEqualOrThrow, getResults, resetCounters, seedOwnerUser, seedCategory, seedProduct,
} = require('./helpers/test-setup');
const { createSupply, updateSupply } = require('../main/services/supplies');
const { saveRecipe, getRecipeByProduct, listRecipes } = require('../main/services/recipes');

async function main() {
  console.log('Recipe costing test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;
  seedCategory(db, 'cat-c', 'Drinks');
  seedProduct(db, 'p-gt', 'cat-c', 'Gin and tonic', 6, { track_inventory: false, stock_quantity: 0 });
  seedProduct(db, 'p-free', 'cat-c', 'Mystery drink', 5, { track_inventory: false, stock_quantity: 0 });

  const gin = createSupply(db, { name: 'Gin', baseUnit: 'ml', packSize: 700, unitCost: 0.02, actorUserId: actor });
  const tonic = createSupply(db, { name: 'Tonic', baseUnit: 'ml', unitCost: 0.004, actorUserId: actor });
  const noCost = createSupply(db, { name: 'Garnish', baseUnit: 'each', actorUserId: actor });

  saveRecipe(db, {
    productId: 'p-gt', yieldQuantity: 1,
    items: [{ supplyId: gin.id, quantity: 40, unit: 'ml' }, { supplyId: tonic.id, quantity: 0.2, unit: 'l' }],
  });
  const gt = getRecipeByProduct(db, 'p-gt');
  assertEqualOrThrow(gt.cost_per_serving, 1.6, 'cost sums ingredient costs, converting litres to ml (0.8 + 0.8)');
  assertOrThrow(gt.cost_complete, 'recipe with all costs is complete');
  assertEqualOrThrow(gt.selling_price, 6, 'menu price is returned');
  assertEqualOrThrow(gt.margin, 4.4, 'margin is price minus cost');
  assertEqualOrThrow(gt.margin_percent, 73.33, 'margin percent is margin over price');

  saveRecipe(db, {
    productId: 'p-gt', yieldQuantity: 2,
    items: [{ supplyId: gin.id, quantity: 80, unit: 'ml' }, { supplyId: tonic.id, quantity: 0.4, unit: 'l' }],
  });
  assertEqualOrThrow(getRecipeByProduct(db, 'p-gt').cost_per_serving, 1.6, 'cost per serving divides by yield');

  saveRecipe(db, {
    productId: 'p-free', yieldQuantity: 1,
    items: [{ supplyId: gin.id, quantity: 30, unit: 'ml' }, { supplyId: noCost.id, quantity: 1, unit: 'each' }],
  });
  const partial = getRecipeByProduct(db, 'p-free');
  assertOrThrow(!partial.cost_complete, 'a missing ingredient cost makes the recipe incomplete');
  assertEqualOrThrow(partial.missing_cost_supplies[0], 'Garnish', 'the missing ingredient is named');
  assertEqualOrThrow(partial.margin, null, 'no margin is shown when a cost is missing');
  assertEqualOrThrow(partial.cost_per_serving, 0.6, 'known costs are still summed');

  updateSupply(db, noCost.id, { unitCost: 0.1 });
  const filled = getRecipeByProduct(db, 'p-free');
  assertOrThrow(filled.cost_complete, 'recipe becomes complete once the cost is set');
  assertEqualOrThrow(filled.margin, 4.3, 'margin appears with the complete cost');

  const listed = listRecipes(db);
  assertEqualOrThrow(listed.length, 2, 'list returns both recipes');
  assertOrThrow(listed.every((r: any) => typeof r.cost_complete === 'boolean'), 'list carries costing fields');

  console.log('='.repeat(50));
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
