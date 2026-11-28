/**
 * BackStreet: nightly backups are sent to the owner's Google Drive through a small Apps Script.
 * Runs the real script (scripts/backstreet/drive-backup-apps-script.gs) against a pretend Drive,
 * so no Google account is touched.
 * Run: node tests/run-electron-node-test.cjs tests/backup-drive.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-backup-drive-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};
process.env.FLO_MASTER_PIN = '7391';
process.env.FLO_RUNTIME = 'cloud';
delete process.env.BACKUP_DRIVE_URL;
delete process.env.BACKUP_DRIVE_KEY;

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

const KEY = 'k'.repeat(20) + 'secret-key-0123456789';
const URL = 'https://script.google.com/macros/s/AKfycbTestDeployment_123/exec';

/** A pretend Google Drive and Apps Script runtime, running the real script file. */
function fakeAppsScript(scriptKey: string | null) {
  type File = { id: string; name: string; parent: string; bytes?: Buffer; trashed: boolean; folder?: boolean };
  const files: File[] = [];
  const props: Record<string, string> = scriptKey ? { BACKUP_KEY: scriptKey } : {};
  let next = 1;
  const iter = (list: any[]) => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; };
  const fileObj = (f: File) => ({
    getId: () => f.id, getName: () => f.name, isTrashed: () => f.trashed, setTrashed: (v: boolean) => { f.trashed = v; },
  });
  const folderObj = (f: File): any => ({
    ...fileObj(f),
    createFile: (blob: { bytes: number[]; name: string }) => {
      const nf: File = { id: `f${next++}`, name: blob.name, parent: f.id, bytes: Buffer.from(Int8Array.from(blob.bytes).buffer), trashed: false };
      files.push(nf);
      return fileObj(nf);
    },
    getFilesByName: (name: string) => iter(files.filter((x) => x.parent === f.id && !x.folder && !x.trashed && x.name === name).map(fileObj)),
    getFiles: () => iter(files.filter((x) => x.parent === f.id && !x.folder && !x.trashed).map(fileObj)),
  });
  const signed = (buf: Buffer) => Array.from(new Int8Array(buf.buffer, buf.byteOffset, buf.length));
  const sandbox: any = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => props[k] ?? null, setProperty: (k: string, v: string) => { props[k] = v; } }) },
    Utilities: {
      base64Decode: (s: string) => signed(Buffer.from(s, 'base64')),
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_a: string, bytes: number[]) => signed(crypto.createHash('sha256').update(Buffer.from(Int8Array.from(bytes).buffer)).digest()),
      newBlob: (bytes: number[], _mime: string, name: string) => ({ bytes, name }),
    },
    LockService: { getScriptLock: () => ({ waitLock: () => undefined, releaseLock: () => undefined }) },
    DriveApp: {
      getFolderById: (id: string) => { const f = files.find((x) => x.id === id && x.folder); if (!f) throw new Error('No item with the given ID'); return folderObj(f); },
      getFoldersByName: (name: string) => iter(files.filter((x) => x.folder && x.name === name).map(folderObj)),
      createFolder: (name: string) => { const f: File = { id: `d${next++}`, name, parent: 'root', trashed: false, folder: true }; files.push(f); return folderObj(f); },
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (text: string) => ({ text, setMimeType() { return this; } }) },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'backstreet', 'drive-backup-apps-script.gs'), 'utf8'), sandbox);
  let down = false;
  const calls: { url: string; body: string }[] = [];
  const poster = async (url: string, body: string) => {
    calls.push({ url, body });
    if (down) return { status: 200, text: '<!DOCTYPE html><html>Sign in</html>' };
    return { status: 200, text: sandbox.doPost({ postData: { contents: body } }).text };
  };
  return { files, props, poster, calls, sandbox, setDown: (v: boolean) => { down = v; } };
}

async function main() {
  const db = initTestDb();
  const { authHeader: A } = seedOwnerUser(db);
  const app = createApp({ '/api/db-tools': databaseToolsRoutes });
  const { baseUrl, server } = await startServer(app);
  const backupDir = getBackupDirectory();
  fs.mkdirSync(backupDir, { recursive: true });
  const nightly = path.join(backupDir, 'flo-backup-nightly-2026-11-26.db');
  const contents = Buffer.from('SQLite format 3\0' + 'nightly-contents '.repeat(5000));
  fs.writeFileSync(nightly, contents);

  try {
    console.log('not set up');
    ok(driveSvc.backupDriveConfigured() === false, 'without the Railway variables it is off');
    ok(await driveSvc.sendBackupToDrive(nightly) === null, 'and nothing is sent');
    const off = await api(baseUrl, '/api/db-tools/backup-drive', { headers: A });
    ok(off.status === 200 && off.data.configured === false, 'settings show it is not set up yet');
    const offSend = await api(baseUrl, '/api/db-tools/backup-drive/send-now', { method: 'POST', headers: A, body: {} });
    ok(offSend.status === 409, 'Send now explains it is not set up');
    process.env.BACKUP_DRIVE_URL = 'https://example.com/macros/s/AKfycbTestDeployment_123/exec';
    process.env.BACKUP_DRIVE_KEY = KEY;
    ok(driveSvc.backupDriveConfigured() === false, 'only a Google Apps Script link is accepted');
    process.env.BACKUP_DRIVE_URL = URL;
    process.env.BACKUP_DRIVE_KEY = 'short';
    ok(driveSvc.backupDriveConfigured() === false, 'a short key is not accepted');
    process.env.BACKUP_DRIVE_KEY = KEY;
    ok(driveSvc.backupDriveConfigured() === true, 'with the link and key it is on');
    const status = JSON.stringify(driveSvc.getBackupDriveStatus());
    ok(!status.includes(KEY) && !status.includes('AKfycb'), 'the status never shows the key or link');

    console.log('sending');
    const gas = fakeAppsScript(KEY);
    driveSvc.setDrivePosterForTests(gas.poster);
    gas.files.push({ id: 'mine', name: 'my-notes.txt', parent: 'root', trashed: false });
    const sent = await driveSvc.sendBackupToDrive(nightly);
    ok(sent === 'flo-backup-nightly-2026-11-26.db.gz', 'the nightly backup is sent');
    ok(gas.calls[0].url === URL, 'to the Apps Script link');
    const folder = gas.files.find((f) => f.folder);
    ok(folder?.name === driveSvc.DRIVE_FOLDER_NAME, 'the script makes its own folder in Drive');
    const up = gas.files.filter((f) => f.parent === folder!.id && !f.trashed);
    ok(up.length === 1 && zlib.gunzipSync(up[0].bytes!).equals(contents), 'the whole file is in that folder, compressed, and unpacks to the original');
    ok(up[0].bytes!.length < contents.length / 5, `it is much smaller than the original (${up[0].bytes!.length} vs ${contents.length} bytes)`);
    ok(gas.props.FOLDER_ID === folder!.id, 'the script remembers its folder');

    await driveSvc.sendBackupToDrive(nightly);
    ok(gas.files.filter((f) => f.parent === folder!.id && !f.trashed).length === 1, 'sending the same backup again replaces it, no duplicate');
    ok(gas.files.filter((f) => f.folder).length === 1, 'the same folder is used again');

    console.log('the script protects itself');
    const reply = (body: unknown) => JSON.parse(gas.sandbox.doPost({ postData: { contents: JSON.stringify(body) } }).text);
    const good = JSON.parse(gas.calls[0].body);
    ok(reply({ ...good, key: 'x'.repeat(KEY.length) }).error === 'wrong key', 'a wrong key is refused');
    ok(reply({ ...good, name: '../evil.db.gz' }).error === 'bad file name', 'a strange file name is refused');
    ok(reply({ ...good, name: 'notes.txt' }).error === 'bad file name', 'only backup files can be added');
    ok(reply({ ...good, sha256: '0'.repeat(64) }).error === 'file damaged on the way', 'a damaged file is refused');
    ok(JSON.parse(gas.sandbox.doGet().text).ok === true && !gas.sandbox.doGet().text.includes('flo-backup'), 'opening the link only says it is running, nothing is listed');
    const noKeyScript = fakeAppsScript(null);
    ok(JSON.parse(noKeyScript.sandbox.doPost({ postData: { contents: gas.calls[0].body } }).text).ok === false, 'without BACKUP_KEY in the script it refuses everything');

    console.log('keeping the folder tidy');
    for (let d = new Date(Date.UTC(2026, 7, 1)); d < new Date(Date.UTC(2026, 10, 26)); d = new Date(d.getTime() + 86400000)) {
      gas.files.push({ id: `old-${d.toISOString().slice(0, 10)}`, name: `flo-backup-nightly-${d.toISOString().slice(0, 10)}.db.gz`, parent: folder!.id, trashed: false });
    }
    gas.files.push({ id: 'manual', name: 'flo-backup-2026-11-01T00-00-00-000Z-x.db.gz', parent: folder!.id, trashed: false });
    gas.files.push({ id: 'other', name: 'photo.jpg', parent: folder!.id, trashed: false });
    await driveSvc.sendBackupToDrive(nightly);
    const left = gas.files.filter((f) => f.parent === folder!.id && !f.trashed).map((f) => f.name);
    const nightlies = left.filter((n) => n.startsWith('flo-backup-nightly-'));
    ok(nightlies.length === 30 + 3, `keeps the newest 30 nights plus the first of each older month (kept ${nightlies.length})`);
    ok(left.includes('flo-backup-nightly-2026-08-01.db.gz') && left.includes('flo-backup-nightly-2026-11-26.db.gz'), 'the first of the month and the newest are kept');
    ok(left.includes('flo-backup-2026-11-01T00-00-00-000Z-x.db.gz') && left.includes('photo.jpg') && gas.files.find((f) => f.id === 'mine')!.trashed === false, 'other backups and other files are never touched');
    ok(gas.files.filter((f) => f.trashed).every((f) => f.name.startsWith('flo-backup-nightly-')), 'old nightlies go to the Bin, not deleted for good');

    console.log('Send now');
    const sendNow = await api(baseUrl, '/api/db-tools/backup-drive/send-now', { method: 'POST', headers: A, body: {} });
    ok(sendNow.status === 200 && sendNow.data.lastSentFile === 'flo-backup-nightly-2026-11-26.db.gz' && !sendNow.data.lastError, 'Send newest backup now works and shows the last copy');

    console.log('when it stops working');
    gas.setDown(true);
    ok(await driveSvc.sendBackupToDrive(nightly) === null, 'a failed send does not throw');
    ok(getSettingValue('backup_drive_fail_count') === '1' && /web page/.test(String(getSettingValue('backup_drive_last_error'))), 'the reason is shown in settings');
    ok(alerts.length === 0, 'one failed night sends no alert yet');
    await driveSvc.sendBackupToDrive(nightly);
    ok(alerts.length === 1 && /Google Drive/.test(alerts[0]), 'two failed nights in a row send one Telegram alert');
    await driveSvc.sendBackupToDrive(nightly);
    ok(alerts.length === 1, 'and not one every night after that');
    const failedRoute = await api(baseUrl, '/api/db-tools/backup-drive/send-now', { method: 'POST', headers: A, body: {} });
    ok(failedRoute.status === 500 && /web page/.test(failedRoute.data.error), 'Send now shows why it failed');
    ok(!String(getSettingValue('backup_drive_last_error')).includes(KEY), 'the key never appears in an error');
    gas.setDown(false);
    gas.props.BACKUP_KEY = 'z'.repeat(40);
    await driveSvc.sendBackupToDrive(nightly);
    ok(/wrong key/.test(String(getSettingValue('backup_drive_last_error'))), 'a key that does not match the script is reported');
    gas.props.BACKUP_KEY = KEY;
    await driveSvc.sendBackupToDrive(nightly);
    ok(getSettingValue('backup_drive_fail_count') === '0' && !getSettingValue('backup_drive_last_error'), 'the next good send clears the error');

    console.log('folder deleted in Drive');
    gas.files.forEach((f) => { if (f.folder) f.trashed = true; });
    ok(await driveSvc.sendBackupToDrive(nightly) === 'flo-backup-nightly-2026-11-26.db.gz', 'if the folder was deleted, it is made again');
    ok(gas.files.filter((f) => f.folder && !f.trashed).length === 1, 'with exactly one new folder');
  } finally {
    driveSvc.setDrivePosterForTests(null);
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  console.log(`backup-drive: ${passed} passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
