/**
 * Ingredient import with Khmer names, duplicate review and recipe links by inventory ID.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/ingredient-khmer-import.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-ingredient-khmer-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertOrThrow, assertEqualOrThrow, getResults, resetCounters, seedOwnerUser,
} = require('./helpers/test-setup');
const { createSupply, importSupplies, listSupplies, updateSupply, getSupply } = require('../main/services/supplies');
const { importRecipes, getRecipeByProduct, buildRecipeSnapshot, applyRecipeSnapshot } = require('../main/services/recipes');

const near = (actual: number, expected: number) => Math.abs(actual - expected) < 1e-9;

async function main() {
  console.log('Ingredient Khmer import test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;

  console.log('\n1. English-only five-column rows still import');
  const english = importSupplies(db, {
    rows: [
      { name: 'Salt', baseUnit: 'g', packSize: '1000', packLabel: '1000 g', packPrice: '0.63' },
      { name: 'Egg', baseUnit: 'piece', packSize: '10', packLabel: '10 piece', packPrice: '1.5' },
    ],
    dryRun: false,
    actorUserId: actor,
  });
  assertEqualOrThrow(english.to_create.length, 2, 'both English rows are created');
  const salt = listSupplies(db, {}).find((s: any) => s.name === 'Salt');
  assertOrThrow(near(salt.unit_cost, 0.00063), 'salt costs 0.63 / 1000 g = $0.00063 per g');
  assertEqualOrThrow(salt.name_km, null, 'Khmer name stays empty when not supplied');
  const egg = listSupplies(db, {}).find((s: any) => s.name === 'Egg');
  assertEqualOrThrow(egg.base_unit, 'each', '"piece" is read as each');
  assertOrThrow(near(egg.unit_cost, 0.15), 'egg costs 1.50 / 10 = $0.15 each');

  console.log('\n2. Khmer names import, store and search');
  const khmer = importSupplies(db, {
    rows: [
      { name: 'Ketchup', nameKm: 'ទឹកប៉េងប៉ោះខាប់', baseUnit: 'g', packSize: '900', packLabel: '900 g bottle', packPrice: '4.00' },
      { name: 'Cooking Oil', nameKm: 'ប្រេងឆា', baseUnit: 'ml', packSize: '1000', packLabel: '1 L bottle', packPrice: '2.95' },
    ],
    dryRun: false,
    actorUserId: actor,
  });
  assertEqualOrThrow(khmer.to_create.length, 2, 'both Khmer rows are created');
  const oil = listSupplies(db, {}).find((s: any) => s.name === 'Cooking Oil');
  assertEqualOrThrow(oil.name_km, 'ប្រេងឆា', 'Khmer name is stored on the same record');
  assertOrThrow(near(oil.unit_cost, 0.00295), 'oil costs 2.95 / 1000 ml = $0.00295 per ml');
  assertEqualOrThrow(listSupplies(db, { search: 'ប្រេង' }).map((s: any) => s.name).join(','), 'Cooking Oil', 'search finds the Khmer name');
  assertEqualOrThrow(listSupplies(db, { search: 'ketch' }).map((s: any) => s.name).join(','), 'Ketchup', 'search still finds the English name');
  assertEqualOrThrow(listSupplies(db, {}).length, 4, 'one record per ingredient, not one per language');

  console.log('\n3. Editing keeps ID, stock and price');
  const kept = updateSupply(db, salt.id, { nameKm: 'អំបិល' });
  assertEqualOrThrow(kept.id, salt.id, 'ID is unchanged');
  assertEqualOrThrow(kept.name_km, 'អំបិល', 'Khmer name can be added later');
  assertOrThrow(near(kept.unit_cost, 0.00063), 'cost is unchanged');
  assertEqualOrThrow(updateSupply(db, salt.id, { name: 'Salt' }).name_km, 'អំបិល', 'saving without name_km keeps it');

  console.log('\n4. Preview sorts rows into new, existing, possible duplicates and invalid');
  const before = JSON.stringify(listSupplies(db, {}).map((s: any) => [s.id, s.name, s.name_km, s.stock_quantity, s.unit_cost]));
  const rows = [
    { name: 'Tomato Ketchup', baseUnit: 'g', packSize: '500', packLabel: '500 g', packPrice: '2' },
    { name: 'Vegetable oil', nameKm: 'ប្រេងឆា', baseUnit: 'ml', packSize: '1000', packLabel: '1 L', packPrice: '2.5' },
    { name: 'salt', baseUnit: 'g', packSize: '1000', packLabel: '1 kg', packPrice: '9' },
    { id: egg.id, name: 'Eggs (tray)', baseUnit: 'each', packSize: '30', packPrice: '4' },
    { name: 'Sugar', nameKm: 'ស្ករ', baseUnit: 'g', packSize: '1', packLabel: '1 kg', packPrice: '1.6' },
    { name: 'Flour', baseUnit: 'g', packSize: '1000', packLabel: '1 kg', packPrice: '-1' },
    { name: 'Rice', baseUnit: 'cup', packSize: '1', packPrice: '1' },
    { id: 'sup_missing', name: 'Ghost', baseUnit: 'g' },
    { name: 'Basil', nameKm: 'ជីរនាងវង', baseUnit: 'g', packSize: '100', packLabel: '100 g', packPrice: '1.2' },
    { name: 'Thai basil', baseUnit: 'g', packSize: '100', packLabel: '100 g', packPrice: '1.2' },
    { name: 'Salt flakes', baseUnit: 'g', packSize: '250', packLabel: '250 g', packPrice: '3' },
  ];
  const preview = importSupplies(db, { rows, dryRun: true, actorUserId: actor });
  assertEqualOrThrow(preview.to_create.map((r: any) => r.name).join(','), 'Basil,Salt flakes', 'clean new rows are ready');
  assertEqualOrThrow(preview.existing.map((r: any) => `${r.name}:${r.matched_by}`).join(','), 'salt:name,Eggs (tray):id', 'existing rows are matched by name and by ID');
  assertEqualOrThrow(
    preview.possible_duplicates.map((r: any) => `${r.name}>${r.matches.map((m: any) => `${m.name}/${m.reason}`).join('+')}`).join(','),
    'Tomato Ketchup>Ketchup/similar_name,Vegetable oil>Cooking Oil/same_khmer_name,Thai basil>Basil/similar_name',
    'similar English names and shared Khmer names are held for review',
  );
  assertEqualOrThrow(preview.errors.map((e: any) => e.row).join(','), '5,6,7,8', 'pack mismatch, negative price, bad unit and unknown ID are invalid');
  assertOrThrow(preview.errors[0].error.includes('1000 g'), 'pack mismatch explains the expected size');
  assertEqualOrThrow(JSON.stringify(listSupplies(db, {}).map((s: any) => [s.id, s.name, s.name_km, s.stock_quantity, s.unit_cost])), before, 'preview changes nothing');

  console.log('\n5. Nothing imports while rows are invalid; approved duplicates import, others stay out');
  let blocked = false;
  try { importSupplies(db, { rows, dryRun: false, actorUserId: actor }); } catch { blocked = true; }
  assertOrThrow(blocked, 'import with invalid rows is refused');
  const valid = rows.filter((_r, i) => ![4, 5, 6, 7].includes(i));
  const approvedRow = valid.findIndex((r) => r.name === 'Thai basil') + 1;
  const done = importSupplies(db, { rows: valid, dryRun: false, actorUserId: actor, approvedRows: [approvedRow] });
  assertEqualOrThrow(done.to_create.map((r: any) => r.name).sort().join(','), 'Basil,Salt flakes,Thai basil', 'clean and approved rows are created');
  const names = listSupplies(db, {}).map((s: any) => s.name);
  assertOrThrow(!names.includes('Tomato Ketchup') && !names.includes('Vegetable oil'), 'unapproved possible duplicates are not created');
  assertOrThrow(near(getSupply(db, salt.id).unit_cost, 0.00063), 'existing salt price is not overwritten');
  assertEqualOrThrow(getSupply(db, egg.id).pack_size, 10, 'existing egg pack is not overwritten');

  console.log('\n6. Recipes link to inventory IDs, by ID or by English or Khmer name');
  const productId = 'prod_cheeseburger';
  db.prepare("INSERT INTO categories (id, name, sort_order, is_active, created_at, updated_at) VALUES ('cat_t', 'Test', 0, 1, datetime('now'), datetime('now'))").run();
  db.prepare("INSERT INTO products (id, name, price, category_id, is_active, created_at, updated_at) VALUES (?, 'Cheeseburger', 6, 'cat_t', 1, datetime('now'), datetime('now'))").run(productId);
  const mince = createSupply(db, { name: 'Beef mince', nameKm: 'សាច់គោចិញ្ច្រាំ', baseUnit: 'g', packSize: 1000, unitCost: 0.0095 });
  const recipeRows = [
    { productId, productName: 'Cheeseburger', ingredientId: mince.id, ingredientName: 'ignored', quantity: '150', unit: 'g' },
    { productName: 'Cheeseburger', ingredientName: 'ទឹកប៉េងប៉ោះខាប់', quantity: '15', unit: 'g' },
    { productName: 'Cheeseburger', ingredientName: 'Egg', quantity: '1', unit: 'piece' },
  ];
  const byName = importRecipes(db, { rows: recipeRows.slice(1), dryRun: true });
  assertEqualOrThrow(byName.to_create.length, 1, 'Khmer ingredient name and "piece" resolve');
  const unresolved = importRecipes(db, { rows: [{ productName: 'Cheeseburger', ingredientName: 'Pickles', quantity: '10', unit: 'g' }], dryRun: true });
  assertEqualOrThrow(unresolved.skipped[0]?.reason, 'no ingredient named Pickles', 'unknown ingredients are rejected');
  const badId = importRecipes(db, { rows: [{ productId, ingredientId: 'sup_nope', quantity: '1', unit: 'g' }], dryRun: true });
  assertEqualOrThrow(badId.skipped[0]?.reason, 'no ingredient with id sup_nope', 'unknown ingredient IDs are rejected');

  const stockBefore = listSupplies(db, { includeInactive: true }).map((s: any) => `${s.id}:${s.stock_quantity}`).join(',');
  importRecipes(db, { rows: [recipeRows[0]], dryRun: false });
  const recipe = getRecipeByProduct(db, productId);
  assertEqualOrThrow(recipe.items.map((i: any) => `${i.supply_id}:${i.quantity}${i.unit}`).join(','), `${mince.id}:150g`, 'recipe line stores the inventory ID');
  assertEqualOrThrow(recipe.items[0].supply_name_km, 'សាច់គោចិញ្ច្រាំ', 'recipe line carries the Khmer name');
  assertEqualOrThrow(recipe.is_active, 0, 'imported recipes start switched off');
  assertEqualOrThrow(buildRecipeSnapshot(db, productId, 1), null, 'a switched-off recipe deducts nothing');
  assertEqualOrThrow(listSupplies(db, { includeInactive: true }).map((s: any) => `${s.id}:${s.stock_quantity}`).join(','), stockBefore, 'importing recipes does not touch stock');

  console.log('\n7. A switched-on recipe deducts on sale and restores on void');
  db.prepare('UPDATE recipes SET is_active = 1 WHERE product_id = ?').run(productId);
  const snapshot = buildRecipeSnapshot(db, productId, 2);
  applyRecipeSnapshot(db, snapshot, { direction: 'deplete', actorUserId: actor, referenceId: 'item_1' });
  assertEqualOrThrow(getSupply(db, mince.id).stock_quantity, -300, 'two burgers deduct 300 g of mince');
  applyRecipeSnapshot(db, snapshot, { direction: 'restore', actorUserId: actor, referenceId: 'item_1' });
  assertEqualOrThrow(getSupply(db, mince.id).stock_quantity, 0, 'voiding restores it');
  const moves = db.prepare("SELECT movement_type FROM supply_movements WHERE supply_id = ? ORDER BY id").all(mince.id).map((r: any) => r.movement_type).join(',');
  assertEqualOrThrow(moves, 'recipe_depletion,recipe_restore', 'both changes are in the stock log');

  const { failed } = getResults();
  console.log(failed === 0 ? '\nAll ingredient Khmer import checks passed' : `\n${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
