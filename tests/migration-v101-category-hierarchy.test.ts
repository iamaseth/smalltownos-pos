/**
 * BackStreet Food and Drinks category hierarchy migration coverage.
 *
 * Existing category IDs and product assignments must survive the migration.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v101-'));

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
  MIGRATIONS.push(...originalMigrations.filter((migration: any) => migration.version <= 100));
  initDatabase();
  const db = getDatabase();

  const insertCategory = db.prepare(`
    INSERT INTO categories (id, name, parent_id, sort_order, is_active, slug, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `);
  const existingCategory = db.prepare(
    'SELECT id FROM categories WHERE lower(trim(name)) = lower(trim(?)) AND deleted_at IS NULL ORDER BY sort_order, id LIMIT 1'
  );
  const ensure = (id: string, name: string, sortOrder: number, parentId: string | null = null): string => {
    const existing = existingCategory.get(name) as { id: string } | undefined;
    if (existing) return existing.id;
    insertCategory.run(id, name, parentId, sortOrder, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), now(), now());
    return id;
  };

  const foodId = ensure('fixture-food', 'Food', 1);
  const drinksId = ensure('fixture-drinks', 'Drinks', 2);
  const breakfastId = ensure('fixture-breakfast', 'Breakfast', 1, foodId);
  const pizzaId = ensure('fixture-pizza', 'Pizza', 2);
  const beefId = ensure('fixture-beef', 'Beef', 3);
  const dessertId = ensure('fixture-desserts', 'Desserts', 4);
  const cocktailId = ensure('fixture-cocktails', 'Cocktails', 5);

  db.prepare(`
    INSERT INTO products (id, name, category_id, price, image_url, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run('fixture-pizza-product', 'Pizza test item', pizzaId, 9.75, 'data:image/png;base64,aGVsbG8=', now(), now());
  db.prepare(`
    INSERT INTO products (id, name, category_id, price, image_url, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run('fixture-beef-product', 'Beef test item', beefId, 15, null, now(), now());
  const productsBefore = db.prepare('SELECT id, category_id, price, image_url FROM products ORDER BY id').all();

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  const migration = originalMigrations.find((entry: any) => entry.version === 101);
  if (!migration) throw new Error('Migration 101 is not registered');
  const runMigration = db.transaction(() => {
    migration.up();
    db.pragma('user_version = 101');
  });
  runMigration();

  const category = db.prepare('SELECT id, parent_id FROM categories WHERE lower(trim(name)) = lower(trim(?)) AND deleted_at IS NULL ORDER BY sort_order, id LIMIT 1');
  const parentId = (name: string) => (category.get(name) as any)?.parent_id;
  const id = (name: string) => (category.get(name) as any)?.id;
  const foodChildren = db.prepare('SELECT name FROM categories WHERE parent_id = ? AND deleted_at IS NULL ORDER BY sort_order, name').all(foodId).map((row: any) => row.name);
  assert(JSON.stringify(foodChildren) === JSON.stringify(['Breakfast', 'Western', 'Asian', 'Seafood & Meat', 'Desserts']),
    'Food has exactly the five requested direct categories in order');
  assert(parentId('Drinks') === null, 'Drinks remains a top-level category');
  assert(parentId('Cocktails') === drinksId, 'existing drink categories are nested under Drinks');
  assert(parentId('Pizza') === id('Western'), 'existing Western category IDs are retained under Western');
  assert(parentId('Beef') === id('Seafood & Meat'), 'existing meat category IDs are retained under Seafood & Meat');
  assert(parentId('Breakfast') === foodId && parentId('Desserts') === foodId, 'existing target category IDs are reused as Food groups');
  const productsAfter = db.prepare('SELECT id, category_id, price, image_url FROM products ORDER BY id').all();
  assert(JSON.stringify(productsAfter) === JSON.stringify(productsBefore), 'product IDs, assignments, prices, and images remain unchanged');

  const beforeRepeat = (db.prepare('SELECT COUNT(*) AS count FROM categories WHERE deleted_at IS NULL').get() as any).count;
  migration.up();
  const afterRepeat = (db.prepare('SELECT COUNT(*) AS count FROM categories WHERE deleted_at IS NULL').get() as any).count;
  assert(afterRepeat === beforeRepeat, 'rerunning the migration does not create duplicate categories');
  assert(Boolean(breakfastId && dessertId && cocktailId), 'original category references remain present');

  closeDatabase();
  fs.rmSync(activeTestDir, { recursive: true, force: true });
  console.log(`\n${passed}/${total} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
