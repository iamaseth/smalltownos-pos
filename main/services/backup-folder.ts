/**
 * BackStreet: also save each nightly backup into a folder on this computer, such as a
 * Google Drive for desktop folder, so a copy leaves the building every night.
 *
 * - The folder is a setting (backup_copy_folder). Only works when the POS runs on the
 *   computer itself; on the cloud server (FLO_RUNTIME=cloud) it stays off.
 * - The copy is written as a .partial file and then renamed, so the sync app never uploads
 *   half a file.
 * - The folder keeps the newest 30 nightly copies plus the first copy of every month.
 *   Other files in the folder are never touched.
 * - Two failed nights in a row send one Telegram alert to the people who get the daily report.
 */
import fs from 'fs';
import path from 'path';
import { getDatabase, getSettingValue, upsertSettings } from '../db';

export const BACKUP_FOLDER_SETTING = 'backup_copy_folder';
const LAST_AT = 'backup_copy_last_at';
const LAST_FILE = 'backup_copy_last_file';
const LAST_ERROR = 'backup_copy_last_error';
const FAIL_COUNT = 'backup_copy_fail_count';
const NIGHTLY_RE = /^flo-backup-nightly-(\d{4})-(\d{2})-(\d{2})\.db$/;
export const KEEP_RECENT = 30;
const ALERT_AFTER_FAILURES = 2;

export interface BackupFolderStatus {
  available: boolean;
  folder: string;
  lastCopyAt: string | null;
  lastCopyFile: string | null;
  lastError: string | null;
  failCount: number;
}

export function backupFolderAvailable(): boolean {
  return process.env.FLO_RUNTIME !== 'cloud';
}

export function getBackupFolder(): string {
  return (getSettingValue(BACKUP_FOLDER_SETTING) || '').trim();
}

export function getBackupFolderStatus(): BackupFolderStatus {
  return {
    available: backupFolderAvailable(),
    folder: getBackupFolder(),
    lastCopyAt: getSettingValue(LAST_AT) || null,
    lastCopyFile: getSettingValue(LAST_FILE) || null,
    lastError: getSettingValue(LAST_ERROR) || null,
    failCount: Number(getSettingValue(FAIL_COUNT) || 0) || 0,
  };
}

/** Why this folder can't be used, or null when it works. Writes and removes a small test file. */
export function checkBackupFolder(folder: string): string | null {
  if (!backupFolderAvailable()) return 'Available when the POS runs on a computer in the restaurant';
  const clean = folder.trim();
  if (!clean) return 'Enter a folder';
  if (!path.isAbsolute(clean)) return 'Use the full folder location, e.g. C:\\Users\\Bobo\\Google Drive\\POS backups';
  try {
    if (!fs.existsSync(clean)) return 'That folder does not exist. Create it first.';
    if (!fs.statSync(clean).isDirectory()) return 'That is a file, not a folder';
    const probe = path.join(clean, `.flo-backup-test-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'BackStreet POS backup folder test');
    fs.unlinkSync(probe);
    return null;
  } catch (error) {
    return `Can't write to that folder (${(error as NodeJS.ErrnoException).code || 'error'})`;
  }
}

/**
 * Nightly copies to delete: everything except the newest `keep` and the first copy of each
 * month. Only names matching flo-backup-nightly-YYYY-MM-DD.db are ever considered.
 */
export function folderCopiesToPrune(names: string[], keep = KEEP_RECENT): string[] {
  const nightly = names.filter((n) => NIGHTLY_RE.test(n)).sort();
  const recent = new Set(nightly.slice(-keep));
  const firstOfMonth = new Set<string>();
  const seenMonth = new Set<string>();
  for (const name of nightly) {
    const m = NIGHTLY_RE.exec(name)!;
    const month = `${m[1]}-${m[2]}`;
    if (!seenMonth.has(month)) { seenMonth.add(month); firstOfMonth.add(name); }
  }
  return nightly.filter((n) => !recent.has(n) && !firstOfMonth.has(n));
}

function recordSuccess(fileName: string): void {
  upsertSettings({ [LAST_AT]: new Date().toISOString(), [LAST_FILE]: fileName, [LAST_ERROR]: '', [FAIL_COUNT]: '0' });
}

function recordFailure(message: string): void {
  const failures = (Number(getSettingValue(FAIL_COUNT) || 0) || 0) + 1;
  upsertSettings({ [LAST_ERROR]: message, [FAIL_COUNT]: String(failures) });
  if (failures === ALERT_AFTER_FAILURES) {
    try {
      const { enqueueAlert } = require('./telegram') as typeof import('./telegram');
      enqueueAlert(
        'Backup copy failed',
        `The nightly backup could not be copied to the backup folder for ${failures} nights.\nReason: ${message}\nCheck that Google Drive for desktop is signed in on the POS computer.`,
        `backup-folder|${new Date().toISOString().slice(0, 10)}`,
        getDatabase(),
      );
    } catch (error) {
      console.error('[BackupFolder] Could not send alert:', error);
    }
  }
}

/**
 * Copy one backup file into the configured folder and tidy old copies.
 * Returns the copied file path, or null when no folder is set. Never throws.
 */
export function copyBackupToFolder(sourcePath: string): string | null {
  const folder = getBackupFolder();
  if (!folder || !backupFolderAvailable()) return null;
  const fileName = path.basename(sourcePath);
  try {
    const problem = checkBackupFolder(folder);
    if (problem) throw new Error(problem);
    const target = path.join(folder, fileName);
    const partial = `${target}.partial`;
    fs.copyFileSync(sourcePath, partial);
    fs.renameSync(partial, target);
    for (const old of folderCopiesToPrune(fs.readdirSync(folder))) {
      try { fs.unlinkSync(path.join(folder, old)); } catch (error) { console.error('[BackupFolder] Could not remove', old, error); }
    }
    recordSuccess(fileName);
    console.log('[BackupFolder] Copied', fileName, 'to', folder);
    return target;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[BackupFolder] Copy failed:', message);
    recordFailure(message);
    return null;
  }
}
