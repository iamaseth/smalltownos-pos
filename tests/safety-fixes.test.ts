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
const { nightlyBackupDue, nightlyBackupsToPrune, backupsToPrune, runNightlyBackupIfDue } = require('../main/services/nightly-backup');
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
    assert(pruned.length === 9 && pruned[0].endsWith('11-01.db') && pruned[8].endsWith('11-09.db'), 'keeps the newest 7 nightly backups, removes the oldest');
    assert(!pruned.some((n: string) => !n.startsWith('flo-backup-nightly-')), 'the nightly rule only touches nightly files');

    const files = [
      ...names.map((name, i) => ({ name, mtimeMs: 1000 + i })),
      ...Array.from({ length: 5 }, (_, i) => ({ name: `flo-backup-2026-11-0${i + 1}T01-00-00-000Z-pre-v10${i}-to-v10${i + 1}.db`, mtimeMs: 2000 + i })),
      ...Array.from({ length: 8 }, (_, i) => ({ name: `flo-backup-2026-11-1${i}T01-00-00-000Z-ab${i}.db`, mtimeMs: 3000 + i })),
      { name: 'flo-database.db', mtimeMs: 1 }, { name: 'notes.txt', mtimeMs: 1 }, { name: '.flo-backup-x.db.tmp-1', mtimeMs: 1 },
    ];
    const gone = backupsToPrune(files);
    const kept = files.map((f) => f.name).filter((n) => !gone.includes(n));
    assertEqual(kept.filter((n) => n.startsWith('flo-backup-nightly-')).length, 7, '7 nightly backups are kept');
    assertEqual(kept.filter((n) => n.includes('-pre-v')).length, 3, '3 pre-update backups are kept');
    assert(kept.includes('flo-backup-2026-11-05T01-00-00-000Z-pre-v104-to-v105.db') && !kept.includes('flo-backup-2026-11-01T01-00-00-000Z-pre-v100-to-v101.db'), 'the newest pre-update backups are the ones kept');
    assertEqual(kept.filter((n) => /-ab\d\.db$/.test(n)).length, 5, '5 manual backups are kept');
    assert(kept.includes('flo-backup-2026-11-17T01-00-00-000Z-ab7.db') && !kept.includes('flo-backup-2026-11-10T01-00-00-000Z-ab0.db'), 'the newest manual backups are the ones kept');
    assert(kept.includes('flo-database.db') && kept.includes('notes.txt') && kept.includes('.flo-backup-x.db.tmp-1'), 'files that are not backups are never touched');
    assertEqual(backupsToPrune(files.slice(0, 3)).length, 0, 'nothing is removed when there are only a few backups');

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
    try { fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may still hold the test database open; leave the temp folder */ }
  }
  const { passed, failed, total } = getResults();
  console.log(`\nResults: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('Test crashed:', err); process.exit(1); });
