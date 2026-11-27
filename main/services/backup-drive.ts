/**
 * BackStreet: send each nightly backup to the owner's Google Drive from the server (Railway).
 *
 * - Turned on by three Railway variables: BACKUP_DRIVE_CLIENT_ID, BACKUP_DRIVE_CLIENT_SECRET and
 *   BACKUP_DRIVE_REFRESH_TOKEN (a Google login for the owner's account, made once). They live in
 *   Railway only: never in the database, settings, exports or backups.
 * - Scope is drive.file: the POS can only see and change files and folders it created itself.
 *   It makes its own folder ("BackStreet POS backups (Railway)") and never touches anything else.
 * - Keeps the newest 30 nightly copies plus the first of every month (same rule as the backup
 *   folder). Other files, including ones sent with "Send newest backup now", are never deleted.
 * - Two failed nights in a row send one Telegram alert.
 * - Never throws into the nightly job.
 */
import fs from 'fs';
import path from 'path';
import { getDatabase, getSettingValue, upsertSettings } from '../db';
import { folderCopiesToPrune } from './backup-folder';

export const DRIVE_FOLDER_NAME = 'BackStreet POS backups (Railway)';
const FOLDER_ID = 'backup_drive_folder_id';
const LAST_AT = 'backup_drive_last_at';
const LAST_FILE = 'backup_drive_last_file';
const LAST_ERROR = 'backup_drive_last_error';
const FAIL_COUNT = 'backup_drive_fail_count';
const ALERT_AFTER_FAILURES = 2;
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface BackupDriveStatus {
  configured: boolean;
  folderName: string;
  lastSentAt: string | null;
  lastSentFile: string | null;
  lastError: string | null;
  failCount: number;
}

type DriveFile = { id?: string | null; name?: string | null };
/** The few Drive calls used here. Tests pass a fake. */
export interface DriveLike {
  files: {
    list(params: Record<string, unknown>): Promise<{ data: { files?: DriveFile[] } }>;
    create(params: Record<string, unknown>): Promise<{ data: DriveFile }>;
    delete(params: { fileId: string }): Promise<unknown>;
    get(params: { fileId: string; fields?: string }): Promise<{ data: DriveFile & { trashed?: boolean | null } }>;
  };
}

let driveOverride: DriveLike | null = null;
/** Tests only. */
export function setDriveClientForTests(client: DriveLike | null): void { driveOverride = client; }

function credentials(): { clientId: string; clientSecret: string; refreshToken: string } | null {
  const clientId = (process.env.BACKUP_DRIVE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.BACKUP_DRIVE_CLIENT_SECRET || '').trim();
  const refreshToken = (process.env.BACKUP_DRIVE_REFRESH_TOKEN || '').trim();
  return clientId && clientSecret && refreshToken ? { clientId, clientSecret, refreshToken } : null;
}

export function backupDriveConfigured(): boolean {
  return driveOverride !== null || credentials() !== null;
}

function driveClient(): DriveLike {
  if (driveOverride) return driveOverride;
  const creds = credentials();
  if (!creds) throw new Error('Google Drive is not set up (Railway variables missing)');
  // Loaded only when used, so the POS starts even if this package is missing.
  const { auth, drive } = require('@googleapis/drive') as typeof import('@googleapis/drive');
  const client = new auth.OAuth2(creds.clientId, creds.clientSecret);
  client.setCredentials({ refresh_token: creds.refreshToken });
  return drive({ version: 'v3', auth: client }) as unknown as DriveLike;
}

export function getBackupDriveStatus(): BackupDriveStatus {
  return {
    configured: backupDriveConfigured(),
    folderName: DRIVE_FOLDER_NAME,
    lastSentAt: getSettingValue(LAST_AT) || null,
    lastSentFile: getSettingValue(LAST_FILE) || null,
    lastError: getSettingValue(LAST_ERROR) || null,
    failCount: Number(getSettingValue(FAIL_COUNT) || 0) || 0,
  };
}

const quote = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** The POS's own folder: the saved one if it still exists, else found by name, else created. */
async function ensureFolder(drive: DriveLike): Promise<string> {
  const saved = getSettingValue(FOLDER_ID);
  if (saved) {
    try {
      const { data } = await drive.files.get({ fileId: saved, fields: 'id, trashed' });
      if (data.id && !data.trashed) return data.id;
    } catch { /* deleted or not ours any more: find or make it again */ }
  }
  const found = await drive.files.list({
    q: `name = '${quote(DRIVE_FOLDER_NAME)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: 'files(id, name)', spaces: 'drive', pageSize: 10,
  });
  let id = found.data.files?.[0]?.id ?? null;
  if (!id) {
    const created = await drive.files.create({ requestBody: { name: DRIVE_FOLDER_NAME, mimeType: FOLDER_MIME }, fields: 'id' });
    id = created.data.id ?? null;
  }
  if (!id) throw new Error('Could not create the Google Drive folder');
  upsertSettings({ [FOLDER_ID]: id });
  return id;
}

async function listFolder(drive: DriveLike, folderId: string): Promise<DriveFile[]> {
  const { data } = await drive.files.list({
    q: `'${quote(folderId)}' in parents and trashed = false`,
    fields: 'files(id, name)', spaces: 'drive', pageSize: 1000,
  });
  return data.files ?? [];
}

function recordSuccess(fileName: string): void {
  upsertSettings({ [LAST_AT]: new Date().toISOString(), [LAST_FILE]: fileName, [LAST_ERROR]: '', [FAIL_COUNT]: '0' });
}

function recordFailure(message: string, alert: boolean): void {
  const failures = (Number(getSettingValue(FAIL_COUNT) || 0) || 0) + 1;
  upsertSettings({ [LAST_ERROR]: message, [FAIL_COUNT]: String(failures) });
  if (alert && failures === ALERT_AFTER_FAILURES) {
    try {
      const { enqueueAlert } = require('./telegram') as typeof import('./telegram');
      enqueueAlert(
        'Backup to Google Drive failed',
        `The nightly backup could not be sent to Google Drive for ${failures} nights.\nReason: ${message}\nCheck the Google Drive login in the Railway variables.`,
        `backup-drive|${new Date().toISOString().slice(0, 10)}`,
        getDatabase(),
      );
    } catch (error) {
      console.error('[BackupDrive] Could not send alert:', error);
    }
  }
}

/**
 * Upload one backup file to the POS's Drive folder (replacing a copy with the same name) and
 * tidy old nightly copies. Returns the file name sent, or null when Drive is not set up or the
 * upload failed (the reason is kept in the status). Never throws.
 */
export async function sendBackupToDrive(sourcePath: string, opts: { nightly?: boolean } = {}): Promise<string | null> {
  if (!backupDriveConfigured()) return null;
  const fileName = path.basename(sourcePath);
  try {
    if (!fs.existsSync(sourcePath)) throw new Error('Backup file not found');
    const drive = driveClient();
    const folderId = await ensureFolder(drive);
    const created = await drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media: { mimeType: 'application/octet-stream', body: fs.createReadStream(sourcePath) },
      fields: 'id',
    });
    const newId = created.data.id;
    if (!newId) throw new Error('Google Drive did not confirm the upload');
    // The new copy is safely up: now remove an older copy with the same name, and old nightlies.
    const files = await listFolder(drive, folderId);
    const prune = new Set(folderCopiesToPrune(Array.from(new Set(files.map((f) => f.name || '')))));
    for (const file of files) {
      if (!file.id || file.id === newId) continue;
      if (file.name === fileName || prune.has(file.name || '')) {
        try { await drive.files.delete({ fileId: file.id }); } catch (error) { console.error('[BackupDrive] Could not remove', file.name, error); }
      }
    }
    recordSuccess(fileName);
    console.log('[BackupDrive] Sent', fileName, 'to Google Drive');
    return fileName;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[BackupDrive] Send failed:', message);
    recordFailure(message, opts.nightly !== false);
    return null;
  }
}
