/**
 * Nightly backup: once a day, between 04:00 and 06:00 restaurant time, copy the database into the
 * backups folder as flo-backup-nightly-YYYY-MM-DD.db and keep the newest 14 nightly copies.
 * Manual and pre-update backups are never touched. Off with FLO_NIGHTLY_BACKUP=off.
 */
import fs from 'fs';
import path from 'path';
import { createBackup, getBackupDirectory, isDatabaseMaintenanceActive } from '../db';
import { tenantTimezone } from '../routes/cash-closures';
import { copyBackupToFolder } from './backup-folder';

const CHECK_EVERY_MS = 10 * 60 * 1000;
const KEEP = 14;
const NIGHTLY_RE = /^flo-backup-nightly-(\d{4}-\d{2}-\d{2})\.db$/;

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
    for (const name of nightlyBackupsToPrune(fs.readdirSync(dir))) {
      try { fs.unlinkSync(path.join(dir, name)); } catch (error) { console.error('[NightlyBackup] Could not remove', name, error); }
    }
    console.log('[NightlyBackup] Saved', target);
    // BackStreet: also put a copy in the backup folder (e.g. Google Drive) when one is set.
    copyBackupToFolder(target);
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
