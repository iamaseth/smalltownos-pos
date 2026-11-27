/**
 * BackStreet: nightly backups are sent to the owner's Google Drive from the server.
 * Uses a fake Drive, so no Google account is touched.
 * Run: node tests/run-electron-node-test.cjs tests/backup-drive.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-backup-drive-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
process.env.FLO_MASTER_PIN = '7391';
process.env.FLO_RUNTIME = 'cloud';
delete process.env.BACKUP_DRIVE_CLIENT_ID;
delete process.env.BACKUP_DRIVE_CLIENT_SECRET;
delete process.env.BACKUP_DRIVE_REFRESH_TOKEN;

const assert = require('node:assert/strict');
const { initTestDb, createApp, startServer, seedOwnerUser, api, closeDatabase } = require('./helpers/test-setup');
const { getSettingValue, getBackupDirectory } = require('../main/db');
const driveSvc = require('../main/services/backup-drive');
const { databaseToolsRoutes } = require('../main/routes/database-tools');
const telegram = require('../main/services/telegram');
const alerts: string[] = [];
telegram.enqueueAlert = (title: string) => { alerts.push(title); return 1; };

let passed = 0;
const ok = (cond: boolean, msg: string) => { assert.ok(cond, msg); passed += 1; console.log(`  ✓ ${msg}`); };

type F = { id: string; name: string; parents: string[]; mimeType?: string; body?: string; trashed?: boolean };
function fakeDrive() {
  const files: F[] = [];
  let next = 1;
  let failUploads = false;
  const client = {
    files: {
      async list(params: { q: string }) {
        const parent = /'([^']+)' in parents/.exec(params.q)?.[1];
        const name = /name = '([^']+)'/.exec(params.q)?.[1];
        return { data: { files: files.filter((f) => !f.trashed && (!parent || f.parents.includes(parent)) && (!name || f.name === name)) } };
      },
      async create(params: { requestBody: { name: string; parents?: string[]; mimeType?: string }; media?: { body: NodeJS.ReadableStream } }) {
        if (failUploads && params.media) throw new Error('invalid_grant');
        let body: string | undefined;
        if (params.media) {
          const chunks: Buffer[] = [];
          for await (const c of params.media.body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
          body = Buffer.concat(chunks).toString();
        }
        const f: F = { id: `id${next++}`, name: params.requestBody.name, parents: params.requestBody.parents ?? [], mimeType: params.requestBody.mimeType, body };
        files.push(f);
        return { data: { id: f.id } };
      },
      async delete(params: { fileId: string }) {
        const i = files.findIndex((f) => f.id === params.fileId);
        if (i >= 0) files.splice(i, 1);
        return {};
      },
      async get(params: { fileId: string }) {
        const f = files.find((x) => x.id === params.fileId);
        if (!f) throw new Error('File not found');
        return { data: { id: f.id, trashed: !!f.trashed } };
      },
    },
  };
  return { client, files, setFail: (v: boolean) => { failUploads = v; } };
}

async function main() {
  const db = initTestDb();
  const { authHeader: A } = seedOwnerUser(db);
  const app = createApp({ '/api/db-tools': databaseToolsRoutes });
  const { baseUrl, server } = await startServer(app);
  const backupDir = getBackupDirectory();
  fs.mkdirSync(backupDir, { recursive: true });
  const nightly = path.join(backupDir, 'flo-backup-nightly-2026-11-26.db');
  fs.writeFileSync(nightly, 'nightly-contents');

  try {
    console.log('not set up');
    ok(driveSvc.backupDriveConfigured() === false, 'without the Railway variables it is off');
    ok(await driveSvc.sendBackupToDrive(nightly) === null, 'and nothing is sent');
    const off = await api(baseUrl, '/api/db-tools/backup-drive', { headers: A });
    ok(off.status === 200 && off.data.configured === false, 'settings show it is not set up yet');
    const offSend = await api(baseUrl, '/api/db-tools/backup-drive/send-now', { method: 'POST', headers: A, body: {} });
    ok(offSend.status === 409, 'Send now explains it is not set up');
    const status = driveSvc.getBackupDriveStatus();
    ok(!JSON.stringify(status).includes('refresh') && !('clientSecret' in status), 'the status never shows the Google login');

    console.log('sending');
    const fake = fakeDrive();
    driveSvc.setDriveClientForTests(fake.client);
    const notes = { id: 'mine', name: 'my-notes.txt', parents: [] as string[] };
    fake.files.push(notes);
    const sent = await driveSvc.sendBackupToDrive(nightly);
    ok(sent === 'flo-backup-nightly-2026-11-26.db', 'the nightly backup is sent');
    const folder = fake.files.find((f) => f.mimeType === 'application/vnd.google-apps.folder');
    ok(folder?.name === driveSvc.DRIVE_FOLDER_NAME, 'it makes its own folder in Drive');
    const up = fake.files.filter((f) => f.parents.includes(folder!.id));
    ok(up.length === 1 && up[0].body === 'nightly-contents', 'the whole file is in that folder');
    ok(getSettingValue('backup_drive_folder_id') === folder!.id, 'the folder is remembered');

    await driveSvc.sendBackupToDrive(nightly);
    ok(fake.files.filter((f) => f.parents.includes(folder!.id)).length === 1, 'sending the same backup again replaces it, no duplicate');
    ok(fake.files.filter((f) => f.mimeType === 'application/vnd.google-apps.folder').length === 1, 'the same folder is used again');

    console.log('keeping the folder tidy');
    for (let d = new Date(Date.UTC(2026, 7, 1)); d < new Date(Date.UTC(2026, 10, 26)); d = new Date(d.getTime() + 86400000)) {
      fake.files.push({ id: `old-${d.toISOString().slice(0, 10)}`, name: `flo-backup-nightly-${d.toISOString().slice(0, 10)}.db`, parents: [folder!.id] });
    }
    fake.files.push({ id: 'manual', name: 'flo-backup-2026-11-01T00-00-00-000Z-x.db', parents: [folder!.id] });
    await driveSvc.sendBackupToDrive(nightly);
    const left = fake.files.filter((f) => f.parents.includes(folder!.id)).map((f) => f.name);
    const nightlies = left.filter((n) => n.startsWith('flo-backup-nightly-'));
    ok(nightlies.length === 30 + 3, `keeps the newest 30 nights plus the first of each older month (kept ${nightlies.length})`);
    ok(left.includes('flo-backup-nightly-2026-08-01.db') && left.includes('flo-backup-nightly-2026-11-26.db'), 'the first of the month and the newest are kept');
    ok(left.includes('flo-backup-2026-11-01T00-00-00-000Z-x.db') && fake.files.some((f) => f.id === 'mine'), 'other backups and other files are never deleted');

    console.log('Send now');
    const sendNow = await api(baseUrl, '/api/db-tools/backup-drive/send-now', { method: 'POST', headers: A, body: {} });
    ok(sendNow.status === 200 && sendNow.data.lastSentFile === 'flo-backup-nightly-2026-11-26.db' && !sendNow.data.lastError, 'Send newest backup now works and shows the last copy');

    console.log('when it stops working');
    fake.setFail(true);
    ok(await driveSvc.sendBackupToDrive(nightly) === null, 'a failed send does not throw');
    ok(getSettingValue('backup_drive_fail_count') === '1' && /invalid_grant/.test(String(getSettingValue('backup_drive_last_error'))), 'the reason is shown in settings');
    ok(alerts.length === 0, 'one failed night sends no alert yet');
    await driveSvc.sendBackupToDrive(nightly);
    ok(alerts.length === 1 && /Google Drive/.test(alerts[0]), 'two failed nights in a row send one Telegram alert');
    await driveSvc.sendBackupToDrive(nightly);
    ok(alerts.length === 1, 'and not one every night after that');
    const failedRoute = await api(baseUrl, '/api/db-tools/backup-drive/send-now', { method: 'POST', headers: A, body: {} });
    ok(failedRoute.status === 500 && /invalid_grant/.test(failedRoute.data.error), 'Send now shows why it failed');
    fake.setFail(false);
    await driveSvc.sendBackupToDrive(nightly);
    ok(getSettingValue('backup_drive_fail_count') === '0' && !getSettingValue('backup_drive_last_error'), 'the next good send clears the error');

    console.log('folder deleted in Drive');
    fake.files.splice(0, fake.files.length);
    ok(await driveSvc.sendBackupToDrive(nightly) === 'flo-backup-nightly-2026-11-26.db', 'if the folder was deleted, it is made again');
  } finally {
    driveSvc.setDriveClientForTests(null);
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  console.log(`backup-drive: ${passed} passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
