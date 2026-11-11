/**
 * Ingredient CSV import: preview, duplicates, vendor creation, validation.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/supply-import.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-supply-import-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertOrThrow, assertEqualOrThrow, getResults, resetCounters, seedOwnerUser,
} = require('./helpers/test-setup');
const { createSupply, importSupplies, listSupplies } = require('../main/services/supplies');

function expectError(fn: () => void, statusCode: number, label: string): void {
  let thrown: any = null;
  try { fn(); } catch (error: any) { thrown = error; }
  assertOrThrow(thrown !== null, `${label} should throw`);
  assertEqualOrThrow(thrown.statusCode, statusCode, label);
}

async function main() {
  console.log('Supply import test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;
  createSupply(db, { name: 'Cune Crianza 2021, 13.5%', baseUnit: 'ml', actorUserId: actor });

  const rows = [
    { name: 'Cune Crianza 2021, 13.5%', baseUnit: 'ml', packSize: '750', packLabel: 'bottle' },
    { name: 'Extra Virgin Olive Oil 5L PET', baseUnit: 'ml', packSize: '5000', packLabel: 'jug', packPrice: '46' },
    { name: 'Baked Beans 3kg', baseUnit: 'each', packSize: '', packLabel: '', packPrice: '8' },
    { name: 'extra virgin olive oil 5l pet', baseUnit: 'ml', packSize: '5000', packLabel: 'jug' },
  ];

  const preview = importSupplies(db, { rows, vendorName: 'Chhay', dryRun: true, actorUserId: actor });
  assertEqualOrThrow(preview.to_create.length, 2, 'preview counts new items');
  assertEqualOrThrow(preview.already_exist.length, 2, 'preview counts existing and repeated names');
  assertEqualOrThrow(listSupplies(db, {}).length, 1, 'preview writes nothing');
  assertEqualOrThrow(db.prepare('SELECT COUNT(*) AS n FROM vendors').get().n, 0, 'preview creates no vendor');

  const done = importSupplies(db, { rows, vendorName: 'Chhay', dryRun: false, actorUserId: actor });
  assertEqualOrThrow(done.to_create.length, 2, 'import creates the new items');
  assertOrThrow(done.vendor_created, 'vendor is created when missing');
  const oil = listSupplies(db, {}).find((s: any) => s.name === 'Extra Virgin Olive Oil 5L PET');
  assertEqualOrThrow(oil.vendor_id, done.vendor_id, 'items carry the vendor');
  assertEqualOrThrow(oil.pack_size, 5000, 'pack size is stored');
  assertEqualOrThrow(oil.pack_label, 'jug', 'pack label is stored');
  assertEqualOrThrow(oil.stock_quantity, 0, 'imported stock starts at zero');
  assertEqualOrThrow(oil.unit_cost, 0.0092, 'cost per ml is pack price divided by pack size');
  const beans = listSupplies(db, {}).find((s: any) => s.name === 'Baked Beans 3kg');
  assertEqualOrThrow(beans.pack_size, null, 'blank pack size stays empty');
  assertEqualOrThrow(beans.unit_cost, 8, 'an each item uses the price as cost per item');
  assertEqualOrThrow(preview.to_create[0].pack_price, 46, 'preview shows the pack price');

  const again = importSupplies(db, { rows, vendorName: 'chhay', dryRun: false, actorUserId: actor });
  assertEqualOrThrow(again.to_create.length, 0, 'second import adds nothing');
  assertEqualOrThrow(again.vendor_id, done.vendor_id, 'vendor is matched case-insensitively');
  assertOrThrow(!again.vendor_created, 'vendor is not duplicated');
  assertEqualOrThrow(listSupplies(db, {}).length, 3, 'no duplicate ingredients');
  assertEqualOrThrow(db.prepare('SELECT COUNT(*) AS n FROM vendors').get().n, 1, 'one vendor row');

  const bad = [{ name: 'Good one', baseUnit: 'ml' }, { name: 'Bad unit', baseUnit: 'barrel' }, { name: '', baseUnit: 'each' }];
  const badPreview = importSupplies(db, { rows: bad, dryRun: true, actorUserId: actor });
  assertEqualOrThrow(badPreview.errors.length, 2, 'preview lists row errors');
  expectError(() => importSupplies(db, { rows: bad, dryRun: false, actorUserId: actor }), 400, 'import refuses when any row has errors');
  assertEqualOrThrow(listSupplies(db, {}).length, 3, 'nothing is imported when a row is invalid');
  expectError(() => importSupplies(db, { rows: [], dryRun: true, actorUserId: actor }), 400, 'empty import refused');
  const noSize = importSupplies(db, { rows: [{ name: 'Y', baseUnit: 'ml', packPrice: '9' }], dryRun: true, actorUserId: actor });
  assertEqualOrThrow(noSize.errors.length, 1, 'a liquid price without a pack size is a row error');
  const negativePrice = importSupplies(db, { rows: [{ name: 'Z', baseUnit: 'each', packPrice: '-1' }], dryRun: true, actorUserId: actor });
  assertEqualOrThrow(negativePrice.errors.length, 1, 'negative price is a row error');
  const negative = importSupplies(db, { rows: [{ name: 'X', baseUnit: 'ml', packSize: '-5' }], dryRun: true, actorUserId: actor });
  assertEqualOrThrow(negative.errors.length, 1, 'negative pack size is listed as a row error');

  console.log('='.repeat(50));
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
