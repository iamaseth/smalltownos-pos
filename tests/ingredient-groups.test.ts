/**
 * Ingredient groups: "any Red wine" recipe lines use the oldest bottle with stock first and cost from it.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/ingredient-groups.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-ingredient-groups-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertOrThrow, assertEqualOrThrow, getResults, resetCounters, seedOwnerUser, seedCategory, seedProduct,
} = require('./helpers/test-setup');
const { createSupply, updateSupply, recordSupplyMovement, importSupplies, getSupply } = require('../main/services/supplies');
const { saveRecipe, getRecipeByProduct, buildRecipeSnapshot, applyRecipeSnapshot, importRecipes } = require('../main/services/recipes');

function throwsMessage(fn: () => unknown): string {
  try { fn(); } catch (error: any) { return String(error?.message || error); }
  return '';
}

async function main() {
  console.log('Ingredient groups test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;
  seedCategory(db, 'cat-w', 'Wine');
  seedProduct(db, 'p-glass', 'cat-w', 'Wine by the Glass (Red)', 4, { track_inventory: false, stock_quantity: 0 });

  const cune = createSupply(db, { name: 'Cune Crianza', baseUnit: 'ml', packSize: 750, unitCost: 0.015, groupName: 'Red wine', actorUserId: actor });
  const protos = createSupply(db, { name: 'Protos Roble', baseUnit: 'ml', packSize: 750, unitCost: 0.02, groupName: 'red wine', actorUserId: actor });
  const lone = createSupply(db, { name: 'Gin', baseUnit: 'ml', actorUserId: actor });
  assertEqualOrThrow(getSupply(db, cune.id).group_name, 'Red wine', 'group is saved on the ingredient');

  assertOrThrow(throwsMessage(() => createSupply(db, { name: 'Red cooking wine', baseUnit: 'each', groupName: 'RED WINE', actorUserId: actor })).includes('same unit'), 'a group cannot mix units');
  assertOrThrow(throwsMessage(() => updateSupply(db, lone.id, { groupName: 'Red wine' })) === '' , 'ml ingredient may join an ml group');
  updateSupply(db, lone.id, { groupName: null });
  assertEqualOrThrow(getSupply(db, lone.id).group_name, null, 'group can be cleared');

  recordSupplyMovement(db, { supplyId: cune.id, movementType: 'receive', quantity: 300, actorUserId: actor, createdAt: '2026-11-01T10:00:00.000Z' });
  recordSupplyMovement(db, { supplyId: protos.id, movementType: 'receive', quantity: 750, actorUserId: actor, createdAt: '2026-11-05T10:00:00.000Z' });

  saveRecipe(db, { productId: 'p-glass', items: [{ groupName: 'Red wine', quantity: 150, unit: 'ml' }] });
  let recipe = getRecipeByProduct(db, 'p-glass');
  assertEqualOrThrow(recipe.items[0].group_name, 'Red wine', 'recipe line keeps the group');
  assertEqualOrThrow(recipe.items[0].supply_name, 'Cune Crianza', 'oldest delivery with stock is used first');
  assertEqualOrThrow(recipe.cost_per_serving, 2.25, 'cost comes from the bottle being poured (150 x 0.015)');

  let snap = buildRecipeSnapshot(db, 'p-glass', 1);
  assertEqualOrThrow(snap.components.length, 1, 'one glass comes from one bottle');
  assertEqualOrThrow(snap.components[0].supply_id, cune.id, 'sale takes from the first bottle');

  snap = buildRecipeSnapshot(db, 'p-glass', 3);
  assertEqualOrThrow(snap.components.length, 2, 'an order larger than the first bottle spills to the next');
  assertEqualOrThrow(snap.components[0].quantity, 300, 'first bottle is emptied');
  assertEqualOrThrow(snap.components[1].supply_id, protos.id, 'remainder comes from the next bottle');
  assertEqualOrThrow(snap.components[1].quantity, 150, 'remainder amount is right');
  applyRecipeSnapshot(db, snap, { direction: 'deplete', actorUserId: actor, referenceId: 'o1' });
  assertEqualOrThrow(Number(getSupply(db, cune.id).stock_quantity), 0, 'first bottle is at zero after sale');
  assertEqualOrThrow(Number(getSupply(db, protos.id).stock_quantity), 600, 'next bottle is reduced');
  applyRecipeSnapshot(db, snap, { direction: 'restore', actorUserId: actor, referenceId: 'o1' });
  assertEqualOrThrow(Number(getSupply(db, cune.id).stock_quantity), 300, 'restore puts stock back on the same bottles');

  applyRecipeSnapshot(db, buildRecipeSnapshot(db, 'p-glass', 2), { direction: 'deplete', actorUserId: actor, referenceId: 'o2' });
  recipe = getRecipeByProduct(db, 'p-glass');
  assertEqualOrThrow(recipe.items[0].supply_name, 'Protos Roble', 'recipe follows to the next bottle once the first is empty');
  assertEqualOrThrow(recipe.cost_per_serving, 3, 'cost now comes from the new bottle (150 x 0.02)');

  snap = buildRecipeSnapshot(db, 'p-glass', 10);
  const total = snap.components.reduce((s: number, c: any) => s + c.quantity, 0);
  assertEqualOrThrow(total, 1500, 'full amount is always taken, even beyond stock');
  assertEqualOrThrow(snap.components[snap.components.length - 1].supply_id, protos.id, 'shortfall goes to the last bottle used');

  assertOrThrow(throwsMessage(() => saveRecipe(db, { productId: 'p-glass', items: [{ groupName: 'Red wine', quantity: 1, unit: 'ml' }, { groupName: 'red wine', quantity: 1, unit: 'ml' }] })).includes('duplicate'), 'same group twice is rejected');
  assertOrThrow(throwsMessage(() => saveRecipe(db, { productId: 'p-glass', items: [{ groupName: 'No such group', quantity: 1, unit: 'ml' }] })).includes('no ingredients'), 'unknown group is rejected');

  seedProduct(db, 'p-bottle', 'cat-w', 'Red Bottle', 18, { track_inventory: false, stock_quantity: 0 });
  const dry = importRecipes(db, { rows: [{ productName: 'Red Bottle', ingredientName: 'Red wine', quantity: '750', unit: 'ml' }], dryRun: true });
  assertEqualOrThrow(dry.to_create.length, 1, 'recipe import accepts a group name as the ingredient');
  importRecipes(db, { rows: [{ productName: 'Red Bottle', ingredientName: 'Red wine', quantity: '750', unit: 'ml' }], dryRun: false });
  assertEqualOrThrow(getRecipeByProduct(db, 'p-bottle').items[0].group_name, 'Red wine', 'imported line is a group line');

  const imp = importSupplies(db, { rows: [{ name: 'Mona Lisa', baseUnit: 'ml', groupName: 'White wine' }, { name: 'Marina', baseUnit: 'each', groupName: 'white wine' }], dryRun: true, actorUserId: actor });
  assertEqualOrThrow(imp.errors.length, 1, 'supply import flags a unit mismatch inside a group');
  const imp2 = importSupplies(db, { rows: [{ name: 'Mona Lisa', baseUnit: 'ml', groupName: 'White wine' }], dryRun: false, actorUserId: actor });
  assertEqualOrThrow(imp2.to_create[0].group_name, 'White wine', 'supply import carries the group');

  console.log('='.repeat(50));
  const { passed, failed, total: count } = getResults();
  console.log(`${passed}/${count} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
