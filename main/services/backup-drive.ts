/**
 * BackStreet: send each nightly backup to the owner's Google Drive from the server (Railway).
 *
 * - The owner's Google account runs a small Apps Script (scripts/backstreet/drive-backup-apps-script.gs)
 *   deployed as a web app. The POS posts the backup to it, compressed, with a secret key; the
 *   script saves it in its own folder ("BackStreet POS backups (Railway)") and keeps 30 nights
 *   plus the 1st of every month. The script can only add files: it never sends any back.
 * - Turned on by two Railway variables: BACKUP_DRIVE_URL (the script's /exec link) and
 *   BACKUP_DRIVE_KEY (32+ characters, the same as BACKUP_KEY in the script). They live in Railway
 *   only: never in the database, settings, exports or backups.
 * - Two failed nights in a row send one Telegram alert.
 * - Never throws into the nightly job.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createHash } from 'crypto';
import { getDatabase, getSettingValue, upsertSettings } from '../db';

export const DRIVE_FOLDER_NAME = 'BackStreet POS backups (Railway)';
const LAST_AT = 'backup_drive_last_at';
const LAST_FILE = 'backup_drive_last_file';
const LAST_ERROR = 'backup_drive_last_error';
const FAIL_COUNT = 'backup_drive_fail_count';
const ALERT_AFTER_FAILURES = 2;
const SCRIPT_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{10,200}\/exec$/;
const MAX_UPLOAD_BYTES = 45 * 1024 * 1024;
const TIMEOUT_MS = 180_000;

export interface BackupDriveStatus {
  configured: boolean;
  folderName: string;
  lastSentAt: string | null;
  lastSentFile: string | null;
  lastError: string | null;
  failCount: number;
}

/** Posts the JSON body and returns the final reply. Tests pass a fake. */
export type DrivePoster = (url: string, body: string) => Promise<{ status: number; text: string }>;

let posterOverride: DrivePoster | null = null;
/** Tests only. */
export function setDrivePosterForTests(poster: DrivePoster | null): void { posterOverride = poster; }

const defaultPoster: DrivePoster = async (url, body) => {
  // Apps Script answers a POST with a redirect to the result, which fetch follows as a GET.
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, text: await res.text() };
};

function settings(): { url: string; key: string } | null {
  const url = (process.env.BACKUP_DRIVE_URL || '').trim();
  const key = (process.env.BACKUP_DRIVE_KEY || '').trim();
  return SCRIPT_URL_RE.test(url) && key.length >= 32 ? { url, key } : null;
}

export function backupDriveConfigured(): boolean {
  return settings() !== null;
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
        `The nightly backup could not be sent to Google Drive for ${failures} nights.\nReason: ${message}\nCheck the Apps Script link and key (BACKUP_DRIVE_URL / BACKUP_DRIVE_KEY in Railway).`,
        `backup-drive|${new Date().toISOString().slice(0, 10)}`,
        getDatabase(),
      );
    } catch (error) {
      console.error('[BackupDrive] Could not send alert:', error);
    }
  }
}

/** Turns the script's reply into the saved name, or a plain-English error. */
function readReply(reply: { status: number; text: string }, expectedName: string): string {
  const text = reply.text.trim();
  if (text.startsWith('<')) {
    throw new Error('Google sent back a web page instead of the script reply: check the Apps Script is deployed as a Web app with access "Anyone"');
  }
  let data: { ok?: boolean; name?: string; error?: string } = {};
  try { data = JSON.parse(text); } catch { throw new Error(`Unexpected reply from Google (HTTP ${reply.status})`); }
  if (!data.ok) throw new Error(`The Apps Script refused the backup: ${String(data.error || 'no reason given').slice(0, 200)}`);
  if (data.name !== expectedName) throw new Error('The Apps Script did not confirm the file');
  return expectedName;
}

/**
 * Send one backup file to the Drive folder (compressed, as NAME.gz). Returns the file name sent,
 * or null when Drive is not set up or the send failed (the reason is kept in the status).
 * Never throws.
 */
export async function sendBackupToDrive(sourcePath: string, opts: { nightly?: boolean } = {}): Promise<string | null> {
  const config = settings();
  if (!config) return null;
  const fileName = `${path.basename(sourcePath)}.gz`;
  try {
    if (!fs.existsSync(sourcePath)) throw new Error('Backup file not found');
    const packed = zlib.gzipSync(fs.readFileSync(sourcePath), { level: 9 });
    if (packed.length > MAX_UPLOAD_BYTES) throw new Error('The backup is too big for the Apps Script (over 45 MB compressed)');
    const body = JSON.stringify({
      key: config.key,
      name: fileName,
      sha256: createHash('sha256').update(packed).digest('hex'),
      data: packed.toString('base64'),
    });
    const reply = await (posterOverride ?? defaultPoster)(config.url, body);
    readReply(reply, fileName);
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
