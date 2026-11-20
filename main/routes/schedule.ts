import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { dayBoundsInTimezone, getDatabase, now, withTxn } from '../db';
import { hasPermission, requirePermission } from '../services/authorization';
import { tenantTimezone } from './cash-closures';

type Db = ReturnType<typeof getDatabase>;
type ShiftStatus = 'draft' | 'published' | 'cancelled';

interface ShiftRow {
  id: string; staff_id: string; role: string; work_date: string; shift_type_id: string | null;
  starts_at: string; ends_at: string; status: ShiftStatus; notes: string | null;
  created_by: string; updated_by: string; created_at: string; updated_at: string;
}
interface ShiftTypeRow { id: string; label: string; start_time: string; end_time: string; sort_order: number; active: number }

const router = Router();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_RANGE_DAYS = 45;
const SHIFT_SELECT = `
  SELECT s.*, u.name AS staff_name FROM scheduled_shifts s JOIN users u ON u.id = s.staff_id
`;

class ScheduleError extends Error {
  constructor(message: string, public statusCode: number) { super(message); }
}

function fail(message: string, statusCode = 400): never {
  throw new ScheduleError(message, statusCode);
}

function send(res: Response, error: unknown, fallback: string): void {
  if (error instanceof ScheduleError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  console.error(`[Schedule] ${fallback}:`, error);
  res.status(500).json({ error: fallback });
}

function actor(req: Request): string {
  const id = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
  if (!id) fail('Authentication required', 401);
  return id;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function parseDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) fail(`${label} must be YYYY-MM-DD`);
  return value;
}

function parseTime(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TIME.test(value)) fail(`${label} must be HH:MM`);
  return value;
}

/** Store-local date and wall times to canonical UTC timestamps; an end at or before the start ends the next day. */
export function shiftInstants(workDate: string, start: string, end: string, timezone: string): { starts_at: string; ends_at: string } {
  const startsAt = dayBoundsInTimezone(workDate, timezone, start)[0];
  const endDate = end <= start ? addDays(workDate, 1) : workDate;
  const endsAt = dayBoundsInTimezone(endDate, timezone, end)[0];
  return { starts_at: startsAt, ends_at: endsAt };
}

function loadShift(db: Db, id: string): ShiftRow {
  const row = db.prepare(`SELECT * FROM scheduled_shifts WHERE id = ?`).get(id) as ShiftRow | undefined;
  if (!row) fail('Scheduled shift not found', 404);
  return row;
}

function loadType(db: Db, id: unknown): ShiftTypeRow {
  const row = typeof id === 'string'
    ? db.prepare(`SELECT * FROM schedule_shift_types WHERE id = ? AND active = 1`).get(id) as ShiftTypeRow | undefined
    : undefined;
  if (!row) fail('Choose a shift');
  return row;
}

function activeStaff(db: Db, id: unknown): { id: string; role: string; name: string } {
  const row = typeof id === 'string'
    ? db.prepare(`SELECT id, role, name FROM users WHERE id = ? AND is_active = 1`).get(id) as { id: string; role: string; name: string } | undefined
    : undefined;
  if (!row) fail('Choose an active staff member');
  return row;
}

function overlapping(db: Db, staffId: string, startsAt: string, endsAt: string, ignoreId?: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM scheduled_shifts
    WHERE staff_id = ? AND status != 'cancelled' AND starts_at < ? AND ends_at > ? AND id != ?
    LIMIT 1
  `).get(staffId, endsAt, startsAt, ignoreId ?? ''));
}

function recordEvent(db: Db, shiftId: string, action: string, before: ShiftRow | null, after: ShiftRow | null, actorId: string): void {
  db.prepare(`
    INSERT INTO scheduled_shift_events (shift_id, action, before_json, after_json, actor_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(shiftId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, actorId, now());
}

function shapeShift(db: Db, id: string): unknown {
  return db.prepare(`${SHIFT_SELECT} WHERE s.id = ?`).get(id);
}

function insertShift(db: Db, fields: Omit<ShiftRow, 'id' | 'created_at' | 'updated_at' | 'updated_by'>, actorId: string, action: string): string {
  const id = randomUUID();
  const at = now();
  db.prepare(`
    INSERT INTO scheduled_shifts (id, staff_id, role, work_date, shift_type_id, starts_at, ends_at, status, notes, created_by, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, fields.staff_id, fields.role, fields.work_date, fields.shift_type_id, fields.starts_at, fields.ends_at,
    fields.status, fields.notes, fields.created_by, actorId, at, at);
  recordEvent(db, id, action, null, loadShift(db, id), actorId);
  return id;
}

/** Managers see drafts; everyone else with schedule access sees published shifts only. */
router.get('/', requirePermission('schedule.view'), (req: Request, res: Response) => {
  try {
    const canManage = hasPermission(actor(req), 'staff.operational.manage');
    const from = parseDate(req.query.from, 'from');
    const to = parseDate(req.query.to, 'to');
    if (to < from || addDays(from, MAX_RANGE_DAYS) < to) fail(`Choose a date range of ${MAX_RANGE_DAYS} days or less`);
    const db = getDatabase();
    const shifts = db.prepare(`${SHIFT_SELECT} WHERE s.work_date >= ? AND s.work_date <= ? AND s.status ${canManage ? "!= 'cancelled'" : "= 'published'"} ORDER BY s.work_date, s.starts_at, u.name`).all(from, to);
    const shiftTypes = db.prepare(`SELECT id, label, start_time, end_time, sort_order FROM schedule_shift_types WHERE active = 1 ORDER BY sort_order, label`).all();
    const staff = db.prepare(`
      SELECT u.id, u.name, u.role, u.schedule_only, st.target_days_per_week, st.job_label
      FROM users u LEFT JOIN staff_schedule_settings st ON st.user_id = u.id
      WHERE u.is_active = 1 ORDER BY u.name
    `).all();
    res.json({ shifts, shift_types: shiftTypes, staff, timezone: tenantTimezone(), can_manage: canManage });
  } catch (error) { send(res, error, 'Could not load the staff schedule'); }
});

router.post('/', requirePermission('staff.operational.manage'), (req: Request, res: Response) => {
  try {
    const me = actor(req);
    const db = getDatabase();
    const body = req.body || {};
    const id = withTxn(() => {
      const person = activeStaff(db, body.staff_id);
      const workDate = parseDate(body.work_date, 'work_date');
      const type = loadType(db, body.shift_type_id);
      const start = body.start_time == null ? type.start_time : parseTime(body.start_time, 'start_time');
      const end = body.end_time == null ? type.end_time : parseTime(body.end_time, 'end_time');
      const instants = shiftInstants(workDate, start, end, tenantTimezone());
      if (overlapping(db, person.id, instants.starts_at, instants.ends_at)) fail(`${person.name} already works then`, 409);
      return insertShift(db, {
        staff_id: person.id, role: person.role, work_date: workDate, shift_type_id: type.id, ...instants,
        status: 'draft', notes: null, created_by: me,
      }, me, 'created');
    });
    res.status(201).json({ shift: shapeShift(db, id) });
  } catch (error) { send(res, error, 'Could not add the shift'); }
});

/** Move, reassign, retime or change status. Any change other than status turns a published shift back into a draft. */
router.patch('/:id', requirePermission('staff.operational.manage'), (req: Request, res: Response) => {
  try {
    const me = actor(req);
    const db = getDatabase();
    const body = req.body || {};
    withTxn(() => {
      const before = loadShift(db, String(req.params.id));
      if (before.status === 'cancelled') fail('This shift was removed', 409);
      const person = body.staff_id == null ? activeStaff(db, before.staff_id) : activeStaff(db, body.staff_id);
      const workDate = body.work_date == null ? before.work_date : parseDate(body.work_date, 'work_date');
      const type = body.shift_type_id == null ? (before.shift_type_id ? loadType(db, before.shift_type_id) : null) : loadType(db, body.shift_type_id);
      const typeChanged = body.shift_type_id != null && body.shift_type_id !== before.shift_type_id;
      const status: ShiftStatus | null = body.status == null ? null
        : (['draft', 'published', 'cancelled'] as const).find((s) => s === body.status) ?? fail('Status must be draft, published or cancelled');
      let instants = { starts_at: before.starts_at, ends_at: before.ends_at };
      const timesGiven = body.start_time != null || body.end_time != null;
      const placementChanged = workDate !== before.work_date || typeChanged || timesGiven;
      if (placementChanged) {
        const tz = tenantTimezone();
        const currentLocal = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
          .format(new Date(`${iso.replace(' ', 'T')}Z`));
        const start = body.start_time != null ? parseTime(body.start_time, 'start_time')
          : (typeChanged && type ? type.start_time : currentLocal(before.starts_at));
        const end = body.end_time != null ? parseTime(body.end_time, 'end_time')
          : (typeChanged && type ? type.end_time : currentLocal(before.ends_at));
        instants = shiftInstants(workDate, start, end, tz);
      }
      const nextStatus: ShiftStatus = status ?? (placementChanged || person.id !== before.staff_id ? 'draft' : before.status);
      if (nextStatus !== 'cancelled' && overlapping(db, person.id, instants.starts_at, instants.ends_at, before.id)) fail(`${person.name} already works then`, 409);
      db.prepare(`
        UPDATE scheduled_shifts SET staff_id = ?, role = ?, work_date = ?, shift_type_id = ?, starts_at = ?, ends_at = ?, status = ?, updated_by = ?, updated_at = ?
        WHERE id = ?
      `).run(person.id, person.id === before.staff_id ? before.role : person.role, workDate, type?.id ?? before.shift_type_id,
        instants.starts_at, instants.ends_at, nextStatus, me, now(), before.id);
      const action = status === 'cancelled' ? 'removed' : status === 'published' ? 'published'
        : person.id !== before.staff_id ? 'reassigned' : placementChanged ? 'moved' : 'updated';
      recordEvent(db, before.id, action, before, loadShift(db, before.id), me);
    });
    res.json({ shift: shapeShift(db, String(req.params.id)) });
  } catch (error) { send(res, error, 'Could not update the shift'); }
});

router.get('/:id/history', requirePermission('staff.view'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    loadShift(db, String(req.params.id));
    const events = db.prepare(`
      SELECT e.id, e.action, e.before_json, e.after_json, e.created_at, u.name AS actor_name
      FROM scheduled_shift_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.shift_id = ? ORDER BY e.id
    `).all(String(req.params.id));
    res.json({ events });
  } catch (error) { send(res, error, 'Could not load the shift history'); }
});

router.post('/copy-week', requirePermission('staff.operational.manage'), (req: Request, res: Response) => {
  try {
    const me = actor(req);
    const db = getDatabase();
    const weekStart = parseDate(req.body?.week_start, 'week_start');
    const onlyStaff = typeof req.body?.staff_id === 'string' ? req.body.staff_id : null;
    const result = withTxn(() => {
      const source = db.prepare(`
        SELECT * FROM scheduled_shifts WHERE work_date >= ? AND work_date < ? AND status != 'cancelled' ${onlyStaff ? 'AND staff_id = ?' : ''}
        ORDER BY work_date, starts_at
      `).all(...[addDays(weekStart, -7), weekStart, ...(onlyStaff ? [onlyStaff] : [])]) as ShiftRow[];
      let copied = 0;
      let skipped = 0;
      for (const shift of source) {
        const staff = db.prepare(`SELECT is_active FROM users WHERE id = ?`).get(shift.staff_id) as { is_active: number } | undefined;
        const shiftBy = (iso: string) => new Date(Date.parse(`${iso.replace(' ', 'T')}Z`) + 7 * 86400_000).toISOString().replace('T', ' ').replace(/\..*$/, '');
        const startsAt = shiftBy(shift.starts_at);
        const endsAt = shiftBy(shift.ends_at);
        if (!staff?.is_active || overlapping(db, shift.staff_id, startsAt, endsAt)) { skipped += 1; continue; }
        insertShift(db, {
          staff_id: shift.staff_id, role: shift.role, work_date: addDays(shift.work_date, 7), shift_type_id: shift.shift_type_id,
          starts_at: startsAt, ends_at: endsAt, status: 'draft', notes: 'Copied from previous week', created_by: me,
        }, me, 'copied');
        copied += 1;
      }
      return { copied, skipped };
    });
    res.json(result);
  } catch (error) { send(res, error, "Could not copy last week's schedule"); }
});

router.post('/publish-week', requirePermission('staff.operational.manage'), (req: Request, res: Response) => {
  try {
    const me = actor(req);
    const db = getDatabase();
    const weekStart = parseDate(req.body?.week_start, 'week_start');
    const published = withTxn(() => {
      const drafts = db.prepare(`SELECT * FROM scheduled_shifts WHERE work_date >= ? AND work_date < ? AND status = 'draft'`)
        .all(weekStart, addDays(weekStart, 7)) as ShiftRow[];
      for (const before of drafts) {
        db.prepare(`UPDATE scheduled_shifts SET status = 'published', updated_by = ?, updated_at = ? WHERE id = ?`).run(me, now(), before.id);
        recordEvent(db, before.id, 'published', before, loadShift(db, before.id), me);
      }
      return drafts.length;
    });
    res.json({ published });
  } catch (error) { send(res, error, 'Could not publish the week'); }
});

router.put('/shift-types/:id', requirePermission('staff.operational.manage'), (req: Request, res: Response) => {
  try {
    actor(req);
    const db = getDatabase();
    const type = loadType(db, req.params.id);
    const label = typeof req.body?.label === 'string' && req.body.label.trim() ? req.body.label.trim().slice(0, 40) : type.label;
    const start = parseTime(req.body?.start_time ?? type.start_time, 'start_time');
    const end = parseTime(req.body?.end_time ?? type.end_time, 'end_time');
    if (start === end) fail('Start and end time cannot be the same');
    db.prepare(`UPDATE schedule_shift_types SET label = ?, start_time = ?, end_time = ?, updated_at = ? WHERE id = ?`).run(label, start, end, now(), type.id);
    res.json({ shift_type: db.prepare(`SELECT id, label, start_time, end_time, sort_order FROM schedule_shift_types WHERE id = ?`).get(type.id) });
  } catch (error) { send(res, error, 'Could not save the shift times'); }
});

router.put('/targets/:staffId', requirePermission('staff.operational.manage'), (req: Request, res: Response) => {
  try {
    actor(req);
    const db = getDatabase();
    const person = activeStaff(db, req.params.staffId);
    const raw = req.body?.target_days_per_week;
    if (raw !== null && (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 7)) fail('Target must be 0–7 days or empty');
    db.prepare(`
      INSERT INTO staff_schedule_settings (user_id, target_days_per_week, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET target_days_per_week = excluded.target_days_per_week, updated_at = excluded.updated_at
    `).run(person.id, raw, now());
    res.json({ staff_id: person.id, target_days_per_week: raw });
  } catch (error) { send(res, error, 'Could not save the target'); }
});

function jobLabel(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') fail('Job must be text');
  const trimmed = value.trim().slice(0, 30);
  return trimmed || null;
}

/** People who are on the schedule but never log in (kitchen helpers, security): no email, no PIN, unusable password. */
router.post('/people', requirePermission('staff.operational.manage'), (req: Request, res: Response) => {
  try {
    actor(req);
    const db = getDatabase();
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 60) : '';
    if (!name) fail('Enter a name');
    const job = jobLabel(req.body?.job_label);
    const id = randomUUID();
    const at = now();
    withTxn(() => {
      db.prepare(`
        INSERT INTO users (id, name, email, password, role, pin, pin_hash, is_active, schedule_only, created_at, updated_at)
        VALUES (?, ?, NULL, '!', 'server', NULL, NULL, 1, 1, ?, ?)
      `).run(id, name, at, at);
      db.prepare(`INSERT INTO staff_schedule_settings (user_id, target_days_per_week, job_label, updated_at) VALUES (?, NULL, ?, ?)`).run(id, job, at);
    });
    res.status(201).json({ person: { id, name, role: 'server', schedule_only: 1, target_days_per_week: null, job_label: job } });
  } catch (error) { send(res, error, 'Could not add the person'); }
});

/** Set anyone's job label; rename or retire schedule-only people (POS staff accounts stay on the Staff page). */
router.put('/people/:id', requirePermission('staff.operational.manage'), (req: Request, res: Response) => {
  try {
    actor(req);
    const db = getDatabase();
    const person = db.prepare(`SELECT id, name, schedule_only FROM users WHERE id = ?`).get(String(req.params.id)) as { id: string; name: string; schedule_only: number } | undefined;
    if (!person) fail('Person not found', 404);
    const changesAccount = req.body && ('name' in req.body || 'active' in req.body);
    if (!person.schedule_only && changesAccount) fail('Change POS staff on the Staff page', 409);
    const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim().slice(0, 60) : person.name;
    const active = req.body?.active === false ? 0 : 1;
    withTxn(() => {
      if (person.schedule_only) db.prepare(`UPDATE users SET name = ?, is_active = ?, updated_at = ? WHERE id = ?`).run(name, active, now(), person.id);
      if (req.body && 'job_label' in req.body) {
        db.prepare(`
          INSERT INTO staff_schedule_settings (user_id, target_days_per_week, job_label, updated_at) VALUES (?, NULL, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET job_label = excluded.job_label, updated_at = excluded.updated_at
        `).run(person.id, jobLabel(req.body.job_label), now());
      }
    });
    res.json({ ok: true });
  } catch (error) { send(res, error, 'Could not update the person'); }
});

export const scheduleRoutes = router;
