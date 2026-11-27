/**
 * Nightly backup: once a day, between 04:00 and 06:00 restaurant time, copy the database into the
 * backups folder as flo-backup-nightly-YYYY-MM-DD.db. After a good nightly backup, old copies are
 * removed so the disk does not fill up: keep the newest 7 nightly, 3 pre-update ("Auto") and
 * 5 manual backups. Off with FLO_NIGHTLY_BACKUP=off.
 */
import fs from 'fs';
import path from 'path';
import { createBackup, getBackupDirectory, isDatabaseMaintenanceActive } from '../db';
import { tenantTimezone } from '../routes/cash-closures';
import { copyBackupToFolder } from './backup-folder';
import { sendBackupToDrive } from './backup-drive';

const CHECK_EVERY_MS = 10 * 60 * 1000;
const KEEP = 7;
const KEEP_PRE_UPDATE = 3;
const KEEP_MANUAL = 5;
const NIGHTLY_RE = /^flo-backup-nightly-(\d{4}-\d{2}-\d{2})\.db$/;
const BACKUP_RE = /^flo-backup-[\w.-]+\.db$/;

let timer: NodeJS.Timeout | null = null;
let running = false;

function localDateAndHour(at: Date, timeZone: string): { date: string; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** True when the nightly backup should run now: inside the 04:00-06:00 window and not yet done today. */
export function nightlyBackupDue(at: Date, timeZone: string, existing: string[]): string | null {
  const { date, hour } = localDateAndHour(at, timeZone);
  if (hour < 4 || hour >= 6) return null;
  return existing.includes(`flo-backup-nightly-${date}.db`) ? null : date;
}

/** Nightly files beyond the newest `keep`, oldest first. */
export function nightlyBackupsToPrune(existing: string[], keep = KEEP): string[] {
  const nightly = existing.filter((name) => NIGHTLY_RE.test(name)).sort();
  return nightly.slice(0, Math.max(0, nightly.length - keep));
}

export type BackupFile = { name: string; mtimeMs: number };

/**
 * Every backup file to remove: nightly beyond the newest 7 (by date in the name), pre-update
 * ("-pre-v") beyond the newest 3 and manual beyond the newest 5 (by file time). Oldest first.
 */
export function backupsToPrune(files: BackupFile[], keep = { nightly: KEEP, preUpdate: KEEP_PRE_UPDATE, manual: KEEP_MANUAL }): string[] {
  const backups = files.filter((f) => BACKUP_RE.test(f.name));
  const oldestFirst = (list: BackupFile[]) => list.slice().sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  const beyond = (list: BackupFile[], n: number) => list.slice(0, Math.max(0, list.length - n)).map((f) => f.name);
  const nightly = beyond(backups.filter((f) => NIGHTLY_RE.test(f.name)).sort((a, b) => a.name.localeCompare(b.name)), keep.nightly);
  const preUpdate = beyond(oldestFirst(backups.filter((f) => !NIGHTLY_RE.test(f.name) && f.name.includes('-pre-v'))), keep.preUpdate);
  const manual = beyond(oldestFirst(backups.filter((f) => !NIGHTLY_RE.test(f.name) && !f.name.includes('-pre-v'))), keep.manual);
  return [...nightly, ...preUpdate, ...manual];
}

function backupFiles(dir: string): BackupFile[] {
  const out: BackupFile[] = [];
  for (const name of fs.readdirSync(dir)) {
    try {
      const stat = fs.lstatSync(path.join(dir, name));
      if (stat.isFile()) out.push({ name, mtimeMs: stat.mtimeMs });
    } catch { /* gone already */ }
  }
  return out;
}

export async function runNightlyBackupIfDue(at = new Date()): Promise<string | null> {
  if (running || isDatabaseMaintenanceActive()) return null;
  const dir = getBackupDirectory();
  const existing = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const date = nightlyBackupDue(at, tenantTimezone(), existing);
  if (!date) return null;
  running = true;
  try {
    const target = path.join(dir, `flo-backup-nightly-${date}.db`);
    await createBackup(target);
    for (const name of backupsToPrune(backupFiles(dir))) {
      try { fs.unlinkSync(path.join(dir, name)); } catch (error) { console.error('[NightlyBackup] Could not remove', name, error); }
    }
    console.log('[NightlyBackup] Saved', target);
    // BackStreet: also put a copy in the backup folder (e.g. Google Drive) when one is set.
    copyBackupToFolder(target);
    // BackStreet: and send it to the owner's Google Drive when Railway has the Drive login set.
    // Runs in the background; it records its own result and never fails the nightly backup.
    void sendBackupToDrive(target, { nightly: true });
    return target;
  } catch (error) {
    console.error('[NightlyBackup] Failed:', error);
    return null;
  } finally {
    running = false;
  }
}

export function startNightlyBackup(): void {
  if (timer || process.env.FLO_NIGHTLY_BACKUP === 'off') return;
  timer = setInterval(() => { void runNightlyBackupIfDue(); }, CHECK_EVERY_MS);
  timer.unref?.();
}

export function stopNightlyBackup(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
