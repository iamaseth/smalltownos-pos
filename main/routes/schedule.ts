import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { getDatabase, now } from '../db';
import { requirePermission } from '../services/authorization';

const router = Router();
const VALID_ROLES = new Set(['owner', 'manager', 'cashier', 'server', 'chef']);
const MAX_SHIFT_MS = 16 * 60 * 60 * 1000;

function parseIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function actorId(req: Request): string | null {
  const id = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
  return id || null;
}

function overlaps(db: ReturnType<typeof getDatabase>, staffId: string, startsAt: string, endsAt: string, excludeId?: string): boolean {
  const row = db.prepare(`
    SELECT id FROM scheduled_shifts
    WHERE staff_id = ? AND status != 'cancelled'
      AND starts_at < ? AND ends_at > ?${excludeId ? ' AND id != ?' : ''}
    LIMIT 1
  `).get(...(excludeId ? [staffId, endsAt, startsAt, excludeId] : [staffId, endsAt, startsAt]));
  return Boolean(row);
}

function activeStaff(db: ReturnType<typeof getDatabase>, staffId: string): { id: string; role: string } | undefined {
  return db.prepare('SELECT id, role FROM users WHERE id = ? AND is_active = 1').get(staffId) as { id: string; role: string } | undefined;
}

router.get('/', requirePermission('staff.view'), (req: Request, res: Response) => {
  const from = parseIso(req.query.from);
  const to = parseIso(req.query.to);
  if (!from || !to || Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 46 * 86400_000) {
    return res.status(400).json({ error: 'Provide a valid date range of 46 days or less' });
  }

  try {
    const shifts = getDatabase().prepare(`
      SELECT s.*, u.name AS staff_name, u.is_active AS staff_is_active
      FROM scheduled_shifts s JOIN users u ON u.id = s.staff_id
      WHERE s.starts_at < ? AND s.ends_at > ?
      ORDER BY s.starts_at, u.name
    `).all(to, from);
    res.json({ shifts });
  } catch (error) {
    console.error('[Schedule] Could not load shifts:', error);
    res.status(500).json({ error: 'Could not load the staff schedule' });
  }
});

router.post('/', requirePermission('staff.operational.manage'), (req: Request, res: Response) => {
  const userId = actorId(req);
  const staffId = typeof req.body?.staff_id === 'string' ? req.body.staff_id : '';
  const startsAt = parseIso(req.body?.starts_at);
  const endsAt = parseIso(req.body?.ends_at);
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  if (!staffId || !startsAt || !endsAt || Date.parse(endsAt) <= Date.parse(startsAt)
    || Date.parse(endsAt) - Date.parse(startsAt) > MAX_SHIFT_MS) {
    return res.status(400).json({ error: 'Choose a staff member and valid shift times (maximum 16 hours)' });
  }

  try {
    const db = getDatabase();
    const staff = activeStaff(db, staffId);
    if (!staff || !VALID_ROLES.has(staff.role)) return res.status(400).json({ error: 'Choose an active staff member' });
    if (overlaps(db, staffId, startsAt, endsAt)) return res.status(409).json({ error: 'This staff member already has an overlapping shift' });
    const timestamp = now();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO scheduled_shifts
        (id, staff_id, role, starts_at, ends_at, status, notes, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?, ?)
    `).run(id, staffId, staff.role, startsAt, endsAt, userId, userId, timestamp, timestamp);
    const shift = db.prepare(`
      SELECT s.*, u.name AS staff_name, u.is_active AS staff_is_active
      FROM scheduled_shifts s JOIN users u ON u.id = s.staff_id WHERE s.id = ?
    `).get(id);
    res.status(201).json({ shift });
  } catch (error) {
    console.error('[Schedule] Could not create shift:', error);
    res.status(500).json({ error: 'Could not create the scheduled shift' });
  }
});

router.post('/copy-week', requirePermission('staff.operational.manage'), (req: Request, res: Response) => {
  const userId = actorId(req);
  const weekStart = parseIso(req.body?.week_start);
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  if (!weekStart) return res.status(400).json({ error: 'Provide the start of the week to copy into' });

  try {
    const db = getDatabase();
    const currentStart = Date.parse(weekStart);
    const currentEnd = currentStart + 7 * 86400_000;
    const previousStart = currentStart - 7 * 86400_000;
    const source = db.prepare(`
      SELECT * FROM scheduled_shifts
      WHERE starts_at >= ? AND starts_at < ? AND status != 'cancelled'
      ORDER BY starts_at
    `).all(new Date(previousStart).toISOString(), new Date(currentStart).toISOString()) as Array<{
      staff_id: string; role: string; starts_at: string; ends_at: string; notes: string | null;
    }>;

    const copy = db.transaction(() => {
      let copied = 0;
      let skipped = 0;
      const timestamp = now();
      for (const shift of source) {
        const startsAt = new Date(Date.parse(shift.starts_at) + 7 * 86400_000).toISOString();
        const endsAt = new Date(Date.parse(shift.ends_at) + 7 * 86400_000).toISOString();
        if (Date.parse(startsAt) >= currentEnd || overlaps(db, shift.staff_id, startsAt, endsAt)) {
          skipped += 1;
          continue;
        }
        db.prepare(`
          INSERT INTO scheduled_shifts
            (id, staff_id, role, starts_at, ends_at, status, notes, created_by, updated_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'draft', 'Copied from previous week', ?, ?, ?, ?)
        `).run(randomUUID(), shift.staff_id, shift.role, startsAt, endsAt, userId, userId, timestamp, timestamp);
        copied += 1;
      }
      return { copied, skipped };
    });

    res.json(copy());
  } catch (error) {
    console.error('[Schedule] Could not copy previous week:', error);
    res.status(500).json({ error: 'Could not copy last week’s schedule' });
  }
});

router.patch('/:id', requirePermission('staff.operational.manage'), (req: Request, res: Response) => {
  const userId = actorId(req);
  const status = req.body?.status;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  if (!['draft', 'published', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Status must be draft, published, or cancelled' });
  }

  try {
    const db = getDatabase();
    const result = db.prepare(`
      UPDATE scheduled_shifts SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?
    `).run(status, userId, now(), req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Scheduled shift not found' });
    const shift = db.prepare(`
      SELECT s.*, u.name AS staff_name, u.is_active AS staff_is_active
      FROM scheduled_shifts s JOIN users u ON u.id = s.staff_id WHERE s.id = ?
    `).get(req.params.id);
    res.json({ shift });
  } catch (error) {
    console.error('[Schedule] Could not update shift:', error);
    res.status(500).json({ error: 'Could not update the scheduled shift' });
  }
});

export const scheduleRoutes = router;
