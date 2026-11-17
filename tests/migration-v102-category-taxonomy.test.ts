/**
 * BackStreet category taxonomy migration coverage.
 * Verifies references, product rows, and classification of legacy mixed categories.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v102-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, MIGRATIONS, closeDatabase, now } = require('../main/db');
let passed = 0;
let failed = 0;
let total = 0;

function assert(condition: boolean, message: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function main() {
  const originalMigrations = MIGRATIONS.slice();
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations.filter((migration: any) => migration.version <= 101));
  initDatabase();
  const db = getDatabase();
  const categoryByName = db.prepare('SELECT id FROM categories WHERE lower(trim(name)) = lower(trim(?)) AND deleted_at IS NULL ORDER BY sort_order, id LIMIT 1');
  const insertCategory = db.prepare(`
    INSERT INTO categories (id, name, parent_id, sort_order, is_active, slug, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `);
  const ensureCategory = (name: string, parentId: string | null = null): string => {
    const found = categoryByName.get(name) as { id: string } | undefined;
    if (found) return found.id;
    const id = `fixture-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    insertCategory.run(id, name, parentId, 0, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), now(), now());
    return id;
  };
  const id = (name: string) => (categoryByName.get(name) as { id: string } | undefined)?.id ?? null;

  const foodId = id('Food')!;
  const drinksId = id('Drinks')!;
  const westernId = id('Western')!;
  const asianId = id('Asian')!;
  const seafoodMeatId = id('Seafood & Meat')!;
  const breakfastId = id('Breakfast')!;
  const dessertsId = id('Desserts')!;
  const mainsId = ensureCategory('Mains', seafoodMeatId);
  const snacksId = ensureCategory('Snacks', westernId);
  const saladId = ensureCategory('Salad', westernId);
  const pizzaId = ensureCategory('Pizza', westernId);
  const pastaId = ensureCategory('Pasta', westernId);
  const burgerComboId = ensureCategory('Burgers & Sandwiches', westernId);
  const fondueId = ensureCategory('Fondues', westernId);
  const asianFoodId = ensureCategory('Asian Food', asianId);
  const asianDelightsId = ensureCategory('Asian Delights', asianId);
  const vegetarianId = ensureCategory('Vegetarian', asianId);
  const beefId = ensureCategory('Beef', seafoodMeatId);
  const chickenDuckId = ensureCategory('Chicken & Duck', seafoodMeatId);
  const fishId = ensureCategory('Fish', seafoodMeatId);
  const lobsterId = ensureCategory('King Mekong Lobster', seafoodMeatId);
  const lambId = ensureCategory('Lamb', seafoodMeatId);
  const porkId = ensureCategory('Pork', seafoodMeatId);
  const softDrinksId = ensureCategory('Soft Drinks', drinksId);
  const coffeeTeaId = ensureCategory('Coffee & Tea', drinksId);
  const beerId = ensureCategory('Beer');
  const wineId = ensureCategory('Wine');
  const spiritsId = ensureCategory('Spirits');
  ensureCategory('Cocktails');

  const insertProduct = db.prepare(`
    INSERT INTO products (id, name, category_id, price, image_url, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `);
  let productNumber = 0;
  const addProduct = (name: string, categoryId: string): string => {
    const productId = `fixture-product-${++productNumber}`;
    insertProduct.run(productId, name, categoryId, 7.25 + productNumber, 'data:image/png;base64,aGVsbG8=', now(), now());
    return productId;
  };
  const expectedCategory: Record<string, string> = {};
  expectedCategory['American Breakfast'] = breakfastId;
  addProduct('American Breakfast', breakfastId);
  expectedCategory['Main Course'] = mainsId;
  addProduct('Main Course', mainsId);
  expectedCategory['Snack Item'] = snacksId;
  addProduct('Snack Item', snacksId);
  expectedCategory['Salad Item'] = saladId;
  addProduct('Salad Item', saladId);
  expectedCategory['Aloha Pizza'] = pizzaId;
  addProduct('Aloha Pizza', pizzaId);
  expectedCategory['Pasta Dish'] = pastaId;
  addProduct('Pasta Dish', pastaId);
  expectedCategory['B.L.T Beef Burger'] = burgerComboId;
  addProduct('B.L.T Beef Burger', burgerComboId);
  expectedCategory['B.L.T Sandwich'] = burgerComboId;
  addProduct('B.L.T Sandwich', burgerComboId);
  expectedCategory['Cheese Fondue'] = fondueId;
  addProduct('Cheese Fondue', fondueId);
  expectedCategory['Loc Lac'] = asianDelightsId;
  addProduct('Loc Lac', asianDelightsId);
  expectedCategory['Ebi Tempura'] = asianDelightsId;
  addProduct('Ebi Tempura', asianDelightsId);
  expectedCategory['Amok'] = asianFoodId;
  addProduct('Amok', asianFoodId);
  expectedCategory['Vegetarian Fried Rice'] = vegetarianId;
  addProduct('Vegetarian Fried Rice', vegetarianId);
  expectedCategory['Beef Steak'] = beefId;
  addProduct('Beef Steak', beefId);
  expectedCategory['Chicken Fillet'] = chickenDuckId;
  addProduct('Chicken Fillet', chickenDuckId);
  expectedCategory['Pan Fried Duck with Honey & Vinegar'] = chickenDuckId;
  addProduct('Pan Fried Duck with Honey & Vinegar', chickenDuckId);
  expectedCategory['Fish Fillet'] = fishId;
  addProduct('Fish Fillet', fishId);
  expectedCategory['Juicy Mekong Lobster'] = lobsterId;
  addProduct('Juicy Mekong Lobster', lobsterId);
  expectedCategory['Lamb Chops'] = lambId;
  addProduct('Lamb Chops', lambId);
  expectedCategory['Pork Chop'] = porkId;
  addProduct('Pork Chop', porkId);
  expectedCategory['Coca Cola (Can)'] = drinksId;
  addProduct('Coca Cola (Can)', drinksId);
  expectedCategory['Fresh Coconut'] = softDrinksId;
  addProduct('Fresh Coconut', softDrinksId);
  expectedCategory['Black Coffee'] = drinksId;
  addProduct('Black Coffee', drinksId);
  expectedCategory['Hot Tea'] = drinksId;
  addProduct('Hot Tea', drinksId);
  expectedCategory['Tea Pot'] = coffeeTeaId;
  addProduct('Tea Pot', coffeeTeaId);
  expectedCategory['Cambodia Draft'] = beerId;
  addProduct('Cambodia Draft', beerId);
  expectedCategory['ABC Bottle'] = beerId;
  addProduct('ABC Bottle', beerId);
  expectedCategory['Somersby Apple Cider'] = beerId;
  addProduct('Somersby Apple Cider', beerId);
  expectedCategory['Cabernet Sauvignon — Glass'] = wineId;
  addProduct('Cabernet Sauvignon — Glass', wineId);
  expectedCategory['Sauvignon Blanc — Glass'] = wineId;
  addProduct('Sauvignon Blanc — Glass', wineId);
  expectedCategory['Absolut Blue'] = spiritsId;
  addProduct('Absolut Blue', spiritsId);
  expectedCategory['B-52'] = spiritsId;
  addProduct('B-52', spiritsId);

  const productsBefore = db.prepare('SELECT id, name, price, image_url FROM products ORDER BY id').all() as any[];
  const originalCategoryIds = {
    food: foodId,
    western: westernId,
    asian: asianId,
    seafoodMeat: seafoodMeatId,
    drinks: drinksId,
  };

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  const migration = originalMigrations.find((entry: any) => entry.version === 102);
  if (!migration) throw new Error('Migration 102 is not registered');
  db.transaction(() => {
    migration.up();
    db.pragma('user_version = 102');
  })();

  const category = db.prepare('SELECT id, name, parent_id, is_active FROM categories WHERE lower(trim(name)) = lower(trim(?)) AND deleted_at IS NULL ORDER BY sort_order, id LIMIT 1');
  const categoryId = (name: string) => (category.get(name) as any)?.id ?? null;
  const parentId = (name: string) => (category.get(name) as any)?.parent_id ?? null;
  const children = (parentName: string) => {
    const parent = category.get(parentName) as any;
    if (!parent) return [];
    return (db.prepare('SELECT name FROM categories WHERE parent_id = ? AND deleted_at IS NULL AND is_active = 1 ORDER BY sort_order, name').all(parent.id) as any[]).map(row => row.name);
  };
  const roots = db.prepare('SELECT name FROM categories WHERE parent_id IS NULL AND deleted_at IS NULL AND is_active = 1 ORDER BY sort_order, name').all() as any[];
  const rootNames = roots.map(row => row.name);
  const expectedRoots = ['FOOD', 'WESTERN', 'ASIAN', 'SEAFOOD', 'MEAT', 'DRINKS', 'BEER', 'WINE', 'SPIRITS', 'COCKTAILS'];
  assert(expectedRoots.every(name => rootNames.includes(name)), 'all requested main categories are active database roots');
  assert(categoryId('FOOD') === originalCategoryIds.food && categoryId('WESTERN') === originalCategoryIds.western &&
    categoryId('ASIAN') === originalCategoryIds.asian && categoryId('MEAT') === originalCategoryIds.seafoodMeat &&
    categoryId('DRINKS') === originalCategoryIds.drinks, 'existing main category IDs are retained');
  assert(JSON.stringify(children('FOOD')) === JSON.stringify(['Breakfast', 'Mains', 'Desserts', 'Snacks', 'Salad']), 'Food subcategories and order match the approved list');
  assert(JSON.stringify(children('WESTERN')) === JSON.stringify(['Pizza', 'Pasta', 'Burgers', 'Fondue']), 'Western subcategories match the approved list');
  assert(JSON.stringify(children('ASIAN')) === JSON.stringify(['Khmer', 'Vegetarian', 'Vietnamese']), 'Asian subcategories match the approved list');
  assert(JSON.stringify(children('SEAFOOD')) === JSON.stringify(['Fish', 'Lobster']), 'Seafood subcategories match the approved list');
  assert(JSON.stringify(children('MEAT')) === JSON.stringify(['Beef', 'Chicken', 'Duck', 'Lamb', 'Pork']), 'Meat subcategories match the approved list');
  assert(JSON.stringify(children('DRINKS')) === JSON.stringify(['Soda', 'Juices', 'Coffee', 'Tea']), 'Drinks subcategories match the approved list');
  assert(JSON.stringify(children('BEER')) === JSON.stringify(['Can', 'Bottle', 'Draft', 'Cider', 'Craft']), 'Beer subcategories match the approved list');
  assert(JSON.stringify(children('WINE')) === JSON.stringify(['Red', 'White', 'Sparkling']), 'Wine subcategories match the approved list');
  assert(JSON.stringify(children('SPIRITS')) === JSON.stringify(['Rum', 'Vodka', 'Gin', 'Tequila', 'Aperitifs', 'Whisky', 'Liquors', 'Shooters']), 'Spirits subcategories match the approved list');
  assert(children('COCKTAILS').length === 0, 'Cocktails stays a standalone main category');

  const expectedAssignments: Record<string, string> = {
    'B.L.T Beef Burger': 'Burgers',
    'B.L.T Sandwich': 'WESTERN',
    'Pan Fried Duck with Honey & Vinegar': 'Duck',
    'Loc Lac': 'Khmer',
    'Ebi Tempura': 'ASIAN',
    'Coca Cola (Can)': 'Soda',
    'Fresh Coconut': 'Juices',
    'Black Coffee': 'Coffee',
    'Hot Tea': 'Tea',
    'Tea Pot': 'Tea',
    'Cambodia Draft': 'Draft',
    'ABC Bottle': 'Bottle',
    'Somersby Apple Cider': 'Cider',
    'Cabernet Sauvignon — Glass': 'Red',
    'Sauvignon Blanc — Glass': 'White',
    'Absolut Blue': 'Vodka',
    'B-52': 'Shooters',
  };
  for (const [name, expected] of Object.entries(expectedAssignments)) {
    const row = db.prepare('SELECT c.name FROM products p JOIN categories c ON c.id = p.category_id WHERE p.name = ?').get(name) as any;
    assert(row?.name === expected, `${name} is assigned to ${expected}`);
  }
  const inactiveLegacy = category.get('Asian Delights') as any;
  assert(inactiveLegacy?.is_active === 0, 'obsolete Asian catch-all stays in the database but is hidden after its products are reassigned');
  const missingRefs = (db.prepare('SELECT COUNT(*) AS count FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.category_id IS NOT NULL AND c.id IS NULL').get() as any).count;
  assert(missingRefs === 0, 'all product category references still resolve');
  const productsAfter = db.prepare('SELECT id, name, price, image_url FROM products ORDER BY id').all();
  assert(JSON.stringify(productsAfter) === JSON.stringify(productsBefore), 'product IDs, names, prices, and images are unchanged');
  assert(Object.keys(expectedCategory).length === productsBefore.length, 'fixture products cover the source categories');

  const countBeforeRepeat = (db.prepare('SELECT COUNT(*) AS count FROM categories WHERE deleted_at IS NULL').get() as any).count;
  db.transaction(() => migration.up())();
  const countAfterRepeat = (db.prepare('SELECT COUNT(*) AS count FROM categories WHERE deleted_at IS NULL').get() as any).count;
  assert(countAfterRepeat === countBeforeRepeat, 'repeating the migration does not create duplicate category rows');

  closeDatabase();
  fs.rmSync(activeTestDir, { recursive: true, force: true });
  console.log(`\n${passed}/${total} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
