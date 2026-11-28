/**
 * BackStreet: lets the owner's laptop fetch the latest nightly backup by itself, so a copy
 * lands in Google Drive every day without anyone pressing Download.
 *
 * GET /api/backup-pull/latest with header `X-Backup-Key: <FLO_BACKUP_PULL_KEY>`.
 * - Off unless FLO_BACKUP_PULL_KEY is set in the server environment (at least 32 characters).
 * - Only ever returns the newest flo-backup-nightly-YYYY-MM-DD.db; nothing else can be fetched.
 * - Wrong keys are rate limited, and every fetch is written to the server log.
 */
import { createHash, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getBackupDirectory } from '../db';

const router = Router();
const NIGHTLY_RE = /^flo-backup-nightly-\d{4}-\d{2}-\d{2}\.db$/;
export const MIN_KEY_LENGTH = 32;

function configuredKey(): string | null {
  const key = process.env.FLO_BACKUP_PULL_KEY?.trim();
  return key && key.length >= MIN_KEY_LENGTH ? key : null;
}

/** Constant-time comparison of the presented key with the configured one. */
export function backupKeyMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || !presented) return false;
  const a = createHash('sha256').update(presented.trim()).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The newest nightly backup file name in the list, or null. */
export function latestNightly(names: string[]): string | null {
  const nightly = names.filter((n) => NIGHTLY_RE.test(n)).sort();
  return nightly.length ? nightly[nightly.length - 1] : null;
}

const wrongKeyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts' },
});

router.get('/latest', wrongKeyLimiter, (req: Request, res: Response) => {
  const expected = configuredKey();
  if (!expected) return res.status(404).json({ error: 'Not found' });
  if (!backupKeyMatches(req.get('x-backup-key'), expected)) {
    console.warn('[BackupPull] Wrong key from', req.ip);
    return res.status(401).json({ error: 'Wrong key' });
  }
  try {
    const dir = getBackupDirectory();
    const name = fs.existsSync(dir) ? latestNightly(fs.readdirSync(dir)) : null;
    if (!name) return res.status(404).json({ error: 'No nightly backup yet' });
    console.log('[BackupPull] Sending', name, 'to', req.ip);
    res.setHeader('X-Backup-File', name);
    res.setHeader('Cache-Control', 'no-store');
    res.download(path.join(dir, name), name, (error) => {
      if (error && !res.headersSent) res.status(500).json({ error: 'Download failed' });
    });
  } catch (error) {
    console.error('[BackupPull] Failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Download failed' });
  }
});

export { router as backupPullRoutes };
