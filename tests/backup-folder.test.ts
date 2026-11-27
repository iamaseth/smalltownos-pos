/**
 * BackStreet: nightly backups are also copied into a folder on the POS computer
 * (e.g. Google Drive for desktop). Run: node tests/run-electron-node-test.cjs tests/backup-folder.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-backup-folder-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
process.env.FLO_MASTER_PIN = '7391';
delete process.env.FLO_RUNTIME;

const assert = require('node:assert/strict');
const { initTestDb, createApp, startServer, seedOwnerUser, api, closeDatabase } = require('./helpers/test-setup');
const { getSettingValue, upsertSettings, getBackupDirectory } = require('../main/db');
const folderSvc = require('../main/services/backup-folder');
const { databaseToolsRoutes } = require('../main/routes/database-tools');
const { databaseRoutes } = require('../main/routes/database');

let passed = 0;
const ok = (cond: boolean, msg: string) => { assert.ok(cond, msg); passed += 1; console.log(`  ✓ ${msg}`); };

async function main() {
  const db = initTestDb();
  const { authHeader: A } = seedOwnerUser(db);
  const app = createApp({ '/api/db-tools': databaseToolsRoutes, '/api/db': databaseRoutes });
  const { baseUrl, server } = await startServer(app);
  const drive = path.join(testDir, 'Google Drive', 'POS backups');
  fs.mkdirSync(drive, { recursive: true });
  fs.writeFileSync(path.join(drive, 'my-notes.txt'), 'not a backup');

  try {
    console.log('keeping the folder tidy');
    const days: string[] = [];
    for (let d = new Date(Date.UTC(2026, 7, 1)); d <= new Date(Date.UTC(2026, 10, 26)); d = new Date(d.getTime() + 86400000)) {
      days.push(`flo-backup-nightly-${d.toISOString().slice(0, 10)}.db`);
    }
    const prune = folderSvc.folderCopiesToPrune([...days, 'my-notes.txt', 'flo-backup-2026-11-01T00-00-00-000Z-x.db']);
    const kept = days.filter((n) => !prune.includes(n));
    ok(kept.length === 30 + 3, `keeps the newest 30 nights plus the first of each older month (kept ${kept.length})`);
    ok(kept.includes('flo-backup-nightly-2026-08-01.db') && kept.includes('flo-backup-nightly-2026-09-01.db') && kept.includes('flo-backup-nightly-2026-10-01.db'), 'the first backup of each month is kept');
    ok(!prune.includes('my-notes.txt') && !prune.some((n: string) => !n.startsWith('flo-backup-nightly-')), 'only nightly backup copies are ever deleted');

    console.log('checking a folder');
    ok(folderSvc.checkBackupFolder('') === 'Enter a folder', 'empty folder is refused');
    ok(/full folder location/.test(folderSvc.checkBackupFolder('Google Drive/POS')), 'a relative path is refused');
    ok(/does not exist/.test(folderSvc.checkBackupFolder(path.join(testDir, 'nope'))), 'a missing folder is refused');
    ok(folderSvc.checkBackupFolder(drive) === null, 'a real folder works');
    ok(fs.readdirSync(drive).every((n: string) => !n.startsWith('.flo-backup-test')), 'the test file is cleaned up');

    console.log('routes');
    const test = await api(baseUrl, '/api/db-tools/backup-folder/test', { method: 'POST', headers: A, body: { folder: drive } });
    ok(test.status === 200 && test.data.ok === true, 'Test folder button reports Works');
    const noPin = await api(baseUrl, '/api/db-tools/backup-folder', { method: 'POST', headers: A, body: { folder: drive } });
    ok(noPin.status !== 200 && getSettingValue('backup_copy_folder') == null, 'saving the folder without the Master PIN is refused');
    const badFolder = await api(baseUrl, '/api/db-tools/backup-folder', { method: 'POST', headers: A, body: { folder: path.join(testDir, 'nope'), master_pin: '7391' } });
    ok(badFolder.status === 400, 'a folder that does not work cannot be saved');
    const saved = await api(baseUrl, '/api/db-tools/backup-folder', { method: 'POST', headers: A, body: { folder: drive, master_pin: '7391' } });
    ok(saved.status === 200 && saved.data.folder === drive, 'with the Master PIN the folder is saved');

    console.log('copying');
    const backupDir = getBackupDirectory();
    fs.mkdirSync(backupDir, { recursive: true });
    const nightly = path.join(backupDir, 'flo-backup-nightly-2026-11-26.db');
    fs.writeFileSync(nightly, 'nightly-contents');
    const copied = folderSvc.copyBackupToFolder(nightly);
    ok(copied === path.join(drive, 'flo-backup-nightly-2026-11-26.db'), 'the nightly backup is copied into the folder');
    ok(fs.readFileSync(copied, 'utf8') === 'nightly-contents', 'the copy is complete');
    ok(!fs.readdirSync(drive).some((n: string) => n.endsWith('.partial')), 'no half-written file is left behind');
    const status = await api(baseUrl, '/api/db-tools/backup-folder', { headers: A });
    ok(status.data.lastCopyFile === 'flo-backup-nightly-2026-11-26.db' && !status.data.lastError, 'settings show the last copy');
    const copyNow = await api(baseUrl, '/api/db-tools/backup-folder/copy-now', { method: 'POST', headers: A, body: {} });
    ok(copyNow.status === 200, 'Copy newest backup now works');

    console.log('when the folder stops working');
    const gone = path.join(testDir, 'Google Drive', 'gone');
    fs.mkdirSync(gone);
    upsertSettings({ backup_copy_folder: gone, backup_copy_fail_count: '0' });
    fs.rmSync(gone, { recursive: true });
    ok(folderSvc.copyBackupToFolder(nightly) === null, 'a failed copy does not crash the nightly backup');
    ok(getSettingValue('backup_copy_fail_count') === '1' && /does not exist/.test(String(getSettingValue('backup_copy_last_error'))), 'the failure is recorded for Settings');
    folderSvc.copyBackupToFolder(nightly);
    ok(getSettingValue('backup_copy_fail_count') === '2', 'two nights in a row are counted (Telegram alert is sent at 2)');
    upsertSettings({ backup_copy_folder: drive });
    folderSvc.copyBackupToFolder(nightly);
    ok(getSettingValue('backup_copy_fail_count') === '0' && !getSettingValue('backup_copy_last_error'), 'a good copy clears the warning');

    console.log('on the cloud server');
    process.env.FLO_RUNTIME = 'cloud';
    ok(folderSvc.copyBackupToFolder(nightly) === null, 'no copy is attempted on the cloud server');
    const cloudStatus = await api(baseUrl, '/api/db-tools/backup-folder', { headers: A });
    ok(cloudStatus.data.available === false, 'Settings explain it works on a restaurant computer');
    ok(/restaurant/.test(folderSvc.checkBackupFolder(drive)), 'Test folder explains why on the cloud server');
    delete process.env.FLO_RUNTIME;

    console.log('export and import never carry the folder');
    const exported = await api(baseUrl, '/api/db/export', { headers: A });
    const exportedRow = (exported.data?.data?.settings || []).find((r: any) => r.key === 'backup_copy_folder');
    ok(exported.status === 200 && exportedRow?.value === '[REDACTED]', 'the folder location is hidden in an export');
    // A hand-made file that puts a real folder in: Replace All with the Master PIN.
    const crafted = JSON.parse(JSON.stringify(exported.data));
    crafted.data.settings = crafted.data.settings.map((r: any) => (r.key === 'backup_copy_folder' ? { ...r, value: path.join(testDir, 'attacker') } : r));
    const importRes = await api(baseUrl, '/api/db/import', { method: 'POST', headers: A, body: { data: crafted, overwrite: true, master_pin: '7391' } });
    ok(importRes.status === 200, `the import itself goes through (${importRes.status} ${importRes.data?.error || ''})`);
    ok(getSettingValue('backup_copy_folder') === drive, 'an imported file cannot change the folder');

    console.log(`backup-folder: ${passed} passed`);
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may still hold the test database open; leave the temp folder */ }
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
