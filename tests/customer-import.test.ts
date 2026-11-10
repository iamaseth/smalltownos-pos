/**
 * Customer import: adds contacts in bulk, skips duplicates, tolerates missing or invalid phones.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/customer-import.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-customer-import-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, createApp, startServer, seedOwnerUser,
  api, assertOrThrow, assertEqualOrThrow, closeDatabase,
} = require('./helpers/test-setup');
const { customerRoutes } = require('../main/routes/customers');

async function main() {
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  const app = createApp({ '/api/customers': customerRoutes });
  const { baseUrl, server } = await startServer(app);
  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM customers').get() as any).n;
  try {
    const first = await api(baseUrl, '/api/customers/import', {
      method: 'POST', headers: authHeader,
      body: { customers: [
        { name: 'Anna', phone: '+85512345678' },
        { name: 'Bob', phone: 'not a number' },
        { name: 'Cara', phone: '' },
        { name: '   ', phone: '+85598765432' },
      ] },
    });
    assertEqualOrThrow(first.status, 200, 'import accepted');
    assertEqualOrThrow(first.data.added, 3, 'three customers added');
    assertEqualOrThrow(first.data.addedWithoutPhone, 2, 'two added without a valid phone');
    assertEqualOrThrow(first.data.skippedNoName, 1, 'nameless row skipped');
    assertEqualOrThrow(count(), 3, 'three customers stored');

    const again = await api(baseUrl, '/api/customers/import', {
      method: 'POST', headers: authHeader,
      body: { customers: [{ name: 'Anna again', phone: '+85512345678' }, { name: 'cara' }, { name: 'Dave' }] },
    });
    assertEqualOrThrow(again.data.added, 1, 'only the new contact is added on a re-run');
    assertEqualOrThrow(again.data.skippedDuplicates, 2, 'same phone and same no-phone name are skipped');
    assertEqualOrThrow(count(), 4, 'four customers after re-run');

    const empty = await api(baseUrl, '/api/customers/import', { method: 'POST', headers: authHeader, body: { customers: [] } });
    assertEqualOrThrow(empty.status, 400, 'empty list rejected');
    assertOrThrow(true, 'done');
    console.log('customer-import: all checks passed');
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err: any) => { console.error(err); process.exit(1); });
