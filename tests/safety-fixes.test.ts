/**
 * Safety fixes: nightly backup window and retention, PIN limits per person on a shared
 * restaurant address, and the chunk-error reload check.
 * Run: node tests/run-electron-node-test.cjs tests/safety-fixes.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-safety-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, assert, assertEqual, getResults, closeDatabase, now } = require('./helpers/test-setup');
const { nightlyBackupDue, nightlyBackupsToPrune, runNightlyBackupIfDue } = require('../main/services/nightly-backup');
const { pinClientKey } = require('../main/middleware/security');
const { isChunkLoadError } = require('../frontend/src/lib/chunk-reload');
const { listBackups } = require('../main/db');

async function main(): Promise<void> {
  const db = initTestDb();
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('timezone', 'Asia/Phnom_Penh', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(now());
  try {
    console.log('\n─── nightly backup ───');
    const tz = 'Asia/Phnom_Penh';
    assertEqual(nightlyBackupDue(new Date('2026-11-25T21:30:00Z'), tz, []), '2026-11-26', '04:30 local is inside the window');
    assertEqual(nightlyBackupDue(new Date('2026-11-25T21:30:00Z'), tz, ['flo-backup-nightly-2026-11-26.db']), null, 'only once a day');
    assertEqual(nightlyBackupDue(new Date('2026-11-26T05:00:00Z'), tz, []), null, 'not during the day (12:00 local)');
    assertEqual(nightlyBackupDue(new Date('2026-11-25T19:00:00Z'), tz, []), null, 'not before 04:00 (02:00 local)');
    const names = Array.from({ length: 16 }, (_, i) => `flo-backup-nightly-2026-11-${String(i + 1).padStart(2, '0')}.db`);
    const pruned = nightlyBackupsToPrune([...names, 'flo-backup-2026-11-01-manual.db', 'flo-backup-x-pre-v110.db']);
    assert(pruned.length === 2 && pruned[0].endsWith('11-01.db') && pruned[1].endsWith('11-02.db'), 'keeps the newest 14 nightly backups, removes the oldest');
    assert(!pruned.some((n: string) => !n.startsWith('flo-backup-nightly-')), 'manual and pre-update backups are never removed');

    const saved = await runNightlyBackupIfDue(new Date('2026-11-25T21:30:00Z'));
    assert(!!saved && fs.existsSync(saved), 'the nightly backup file is written');
    const listed = listBackups().find((b: any) => b.fileName === 'flo-backup-nightly-2026-11-26.db');
    assert(!!listed && listed.kind === 'auto', 'it shows in Backup History as Auto');
    const again = await runNightlyBackupIfDue(new Date('2026-11-25T22:00:00Z'));
    assertEqual(again, null, 'a second run the same night does nothing');

    console.log('\n─── PIN limits per person ───');
    const a = pinClientKey({ ip: '203.0.113.5', socket: {}, user: { userId: 'thida' } });
    const b = pinClientKey({ ip: '203.0.113.5', socket: {}, user: { userId: 'ly' } });
    assert(a !== b, 'two staff on one restaurant address have separate PIN limits');
    assertEqual(pinClientKey({ ip: '203.0.113.5', socket: {} }), '203.0.113.5', 'without a signed-in person the address alone is used');

    console.log('\n─── chunk errors ───');
    assert(isChunkLoadError(Object.assign(new Error('Loading chunk 742 failed.'), { name: 'ChunkLoadError' })), 'ChunkLoadError is recognised');
    assert(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /_next/x.js')), 'a failed module import is recognised');
    assert(!isChunkLoadError(new Error('Invalid manager PIN')), 'other errors do not reload the page');
  } finally {
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  const { passed, failed, total } = getResults();
  console.log(`\nResults: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('Test crashed:', err); process.exit(1); });
