/**
 * Recipe CSV import: preview, drafts that do not deplete stock, skips and problems.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/recipe-import.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-recipe-import-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertOrThrow, assertEqualOrThrow, getResults, resetCounters, seedOwnerUser, seedCategory, seedProduct,
} = require('./helpers/test-setup');
const { createSupply, importSupplies, listSupplies } = require('../main/services/supplies');
const { importRecipes, getRecipeByProduct, saveRecipe, buildRecipeSnapshot } = require('../main/services/recipes');

async function main() {
  console.log('Recipe import test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;
  seedCategory(db, 'cat-c', 'Drinks');
  seedProduct(db, 'p-spritz', 'cat-c', 'Aperol Spritz', 8, { track_inventory: false, stock_quantity: 0 });
  seedProduct(db, 'p-shot', 'cat-c', 'Aperol', 4, { track_inventory: false, stock_quantity: 0 });
  seedProduct(db, 'p-gin', 'cat-c', 'Gin shot', 4, { track_inventory: false, stock_quantity: 0 });
  seedProduct(db, 'p-old', 'cat-c', 'Old fashioned', 9, { track_inventory: false, stock_quantity: 0 });

  const ing = importSupplies(db, {
    rows: [
      { name: 'Aperol', baseUnit: 'ml', packSize: '700', packLabel: 'bottle', pourSize: '30', parLevel: '1400', orderUpTo: '4200' },
      { name: 'Prosecco', baseUnit: 'ml', packSize: '750', packLabel: 'bottle' },
      { name: 'Soda water', baseUnit: 'ml' },
    ],
    dryRun: false, actorUserId: actor,
  });
  assertEqualOrThrow(ing.to_create.length, 3, 'ingredient import creates rows');
  const aperol = listSupplies(db, {}).find((s: any) => s.name === 'Aperol');
  assertEqualOrThrow(aperol.pour_size, 30, 'ingredient import keeps the pour size');
  assertEqualOrThrow(aperol.low_stock_threshold, 1400, 'par level becomes the low-stock level');
  assertEqualOrThrow(aperol.order_up_to, 4200, 'order-up-to is kept');

  const rows = [
    { productName: 'Aperol Spritz', ingredientName: 'Prosecco', quantity: '90', unit: 'ml' },
    { productName: 'aperol spritz', ingredientName: 'Aperol', quantity: '60', unit: 'ml' },
    { productName: 'Aperol Spritz', ingredientName: 'Soda water', quantity: '30', unit: 'ml' },
    { productName: 'Aperol', ingredientName: 'Aperol', quantity: '30', unit: 'ml' },
    { productName: 'Gin shot', ingredientName: 'Gin', quantity: '30', unit: 'ml' },
    { productName: 'Old fashioned', ingredientName: 'Aperol', quantity: '30', unit: 'g' },
    { productName: 'Not on the menu', ingredientName: 'Aperol', quantity: '30', unit: 'ml' },
  ];

  const preview = importRecipes(db, { rows, dryRun: true });
  assertEqualOrThrow(preview.to_create.length, 2, 'preview lists the recipes that can be created');
  assertEqualOrThrow(preview.to_create.find((r: any) => r.product_name === 'Aperol Spritz').items, 3, 'recipe lines are grouped by product, ignoring case');
  assertEqualOrThrow(preview.skipped.length, 3, 'unknown ingredient, bad unit and unknown product are skipped');
  assertOrThrow(preview.skipped.some((s: any) => s.reason.includes('Gin')), 'skip reason names the missing ingredient');
  assertOrThrow(preview.skipped.some((s: any) => s.product_name === 'Not on the menu'), 'unknown product is reported');
  assertEqualOrThrow(getRecipeByProduct(db, 'p-spritz'), null, 'preview writes nothing');

  const done = importRecipes(db, { rows, dryRun: false });
  assertEqualOrThrow(done.to_create.length, 2, 'import creates the valid recipes');
  const spritz = getRecipeByProduct(db, 'p-spritz');
  assertEqualOrThrow(spritz.is_active, 0, 'imported recipes are drafts');
  assertEqualOrThrow(spritz.items.length, 3, 'recipe items are saved');
  assertEqualOrThrow(buildRecipeSnapshot(db, 'p-spritz', 1) === null, true, 'a draft recipe does not deplete stock');

  const again = importRecipes(db, { rows, dryRun: true });
  assertEqualOrThrow(again.already_have_recipe.length, 2, 'products that already have a recipe are left alone');
  assertEqualOrThrow(again.to_create.length, 0, 'nothing is created twice');

  saveRecipe(db, { productId: 'p-spritz', isActive: true, items: spritz.items.map((i: any) => ({ supplyId: i.supply_id, quantity: i.quantity, unit: i.unit })) });
  assertEqualOrThrow(getRecipeByProduct(db, 'p-spritz').is_active, 1, 'confirming a draft makes it active');

  seedProduct(db, 'p-lao', 'cat-c', 'Beerlao\u00a0 (Bottle)', 3, { track_inventory: false, stock_quantity: 0 });
  createSupply(db, { name: 'Beerlao (Bottle)', baseUnit: 'each', actorUserId: actor });
  const spaced = importRecipes(db, { rows: [{ productName: 'Beerlao (Bottle)', ingredientName: 'Beerlao  (Bottle)', quantity: '1', unit: 'each' }], dryRun: true });
  assertEqualOrThrow(spaced.to_create.length, 1, 'odd spacing and non-breaking spaces in names still match');

  seedCategory(db, 'cat-b', 'Breakfast');
  seedProduct(db, 'p-crab-1', 'cat-c', 'Crab Fried Rice', 3.75, { track_inventory: false, stock_quantity: 0 });
  seedProduct(db, 'p-crab-2', 'cat-b', 'Crab Fried Rice', 3.5, { track_inventory: false, stock_quantity: 0 });
  createSupply(db, { name: 'Crab meat', baseUnit: 'g', actorUserId: actor });
  const crabRows = [{ productName: 'Crab Fried Rice', ingredientName: 'Crab meat', quantity: '80', unit: 'g' }];
  const crabPreview = importRecipes(db, { rows: crabRows, dryRun: true });
  assertEqualOrThrow(crabPreview.to_create.length, 2, 'a dish listed under two categories gets a recipe for each menu item');
  importRecipes(db, { rows: crabRows, dryRun: false });
  assertEqualOrThrow(getRecipeByProduct(db, 'p-crab-1').items.length, 1, 'first menu item has the recipe');
  assertEqualOrThrow(getRecipeByProduct(db, 'p-crab-2').items.length, 1, 'second menu item has the recipe');

  const { passed, failed, total } = getResults();
  console.log(`\nPassed: ${passed}/${total}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
