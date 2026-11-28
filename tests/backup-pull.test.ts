/**
 * BackStreet: the laptop's daily backup fetch.
 * Run: node tests/run-electron-node-test.cjs tests/backup-pull.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-backup-pull-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { initTestDb, closeDatabase } = require('./helpers/test-setup');
const { getBackupDirectory } = require('../main/db');
const { requireAuth } = require('../main/server');
const { backupPullRoutes, latestNightly, backupKeyMatches } = require('../main/routes/backup-pull');

const KEY = 'k'.repeat(20) + '-backstreet-test-key-0123456789';

async function main() {
  initTestDb();
  const dir = getBackupDirectory();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'flo-backup-nightly-2026-11-25.db'), 'old');
  fs.writeFileSync(path.join(dir, 'flo-backup-nightly-2026-11-26.db'), 'newest');
  fs.writeFileSync(path.join(dir, 'flo-backup-2026-11-27T01-00-00-000Z-abc.db'), 'manual');

  const app = express();
  app.use(requireAuth);
  app.use('/api/backup-pull', backupPullRoutes);
  app.get('/api/other', (_req: unknown, res: { json: (v: unknown) => void }) => res.json({ ok: true }));

  let passed = 0;
  const ok = (cond: boolean, msg: string) => { assert.ok(cond, msg); passed += 1; console.log(`  ✓ ${msg}`); };

  ok(latestNightly(['flo-backup-nightly-2026-11-25.db', 'flo-backup-nightly-2026-11-26.db', 'flo-backup-x.db']) === 'flo-backup-nightly-2026-11-26.db', 'the newest nightly file is chosen');
  ok(latestNightly(['flo-backup-x.db']) === null, 'no nightly file → nothing');
  ok(backupKeyMatches(KEY, KEY) && !backupKeyMatches('wrong', KEY) && !backupKeyMatches(undefined, KEY), 'key comparison');

  delete process.env.FLO_BACKUP_PULL_KEY;
  ok((await request(app).get('/api/backup-pull/latest').set('X-Backup-Key', KEY)).status === 404, 'off when no key is set on the server');
  process.env.FLO_BACKUP_PULL_KEY = 'short';
  ok((await request(app).get('/api/backup-pull/latest').set('X-Backup-Key', 'short')).status === 404, 'a key shorter than 32 characters keeps it off');

  process.env.FLO_BACKUP_PULL_KEY = KEY;
  ok((await request(app).get('/api/backup-pull/latest')).status === 401, 'no key → refused');
  ok((await request(app).get('/api/backup-pull/latest').set('X-Backup-Key', KEY + 'x')).status === 401, 'wrong key → refused');
  const good = await request(app).get('/api/backup-pull/latest').set('X-Backup-Key', KEY).buffer(true).parse((res: any, cb: any) => {
    const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  ok(good.status === 200, 'right key → backup sent');
  ok(good.headers['x-backup-file'] === 'flo-backup-nightly-2026-11-26.db', 'it is the newest nightly backup');
  ok(good.body.toString() === 'newest', 'the file contents are the nightly backup, never a manual one');
  ok((await request(app).get('/api/other').set('X-Backup-Key', KEY)).status === 401, 'the key opens nothing else: other routes still need a login');
  ok((await request(app).post('/api/backup-pull/latest').set('X-Backup-Key', KEY)).status === 401, 'only GET is allowed without a login');

  console.log(`backup-pull: ${passed} passed`);
  closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
}

main().catch((error) => { console.error(error); process.exit(1); });
