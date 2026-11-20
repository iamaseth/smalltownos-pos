/**
 * Staff schedule: shift types, drafts, overlap checks, move/reassign/retime,
 * copy last week, publish week, weekly targets, change history and permissions.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/staff-schedule.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-staff-schedule-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-staff-schedule';

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { initDatabase, getDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string) {
  if (condition) { passed++; console.log(`  ✓ ${message}`); } else { failed++; console.error(`  ✗ ${message}`); }
}

async function main() {
  console.log('Staff schedule');
  console.log('='.repeat(50));
  try {
    initDatabase();
  } catch (error: any) {
    if (error?.code === 'ERR_DLOPEN_FAILED' && String(error?.message || '').includes('NODE_MODULE_VERSION')) {
      console.log('  ⚠ Skipping: better-sqlite3 ABI mismatch (run via Electron)');
      process.exit(77);
    }
    throw error;
  }
  const db = getDatabase();

  console.log('Section 1: migration 107');
  for (const table of ['schedule_shift_types', 'scheduled_shifts', 'scheduled_shift_events', 'staff_schedule_settings']) {
    assert(!!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table), `table ${table} exists`);
  }
  const types = db.prepare(`SELECT id, start_time, end_time FROM schedule_shift_types ORDER BY sort_order`).all() as { id: string; start_time: string; end_time: string }[];
  assert(types.map((t) => t.id).join(',') === 'opening,main,closing,full', 'four default shift types seeded in order');
  assert(types.find((t) => t.id === 'closing')?.end_time === '01:00', 'closing ends 01:00');

  for (const [key, value] of [['country', 'KH'], ['currency', 'USD'], ['timezone', 'Asia/Phnom_Penh']]) {
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value, now());
  }
  for (const [id, name, role, active] of [['owner-s', 'Owner', 'owner', 1], ['manager-s', 'Borina', 'manager', 1], ['cashier-s', 'Bobo', 'cashier', 1],
    ['server-s', 'Jenie', 'server', 1], ['chef-s', 'Sokha', 'chef', 1], ['gone-s', 'Left', 'server', 0]] as const) {
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, name, `${id}@test.local`, bcrypt.hashSync('pw', 4), role, active, now(), now());
  }
  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'auth' });
    req.user = jwt.verify(h.split(' ')[1], getJWTSecret());
    next();
  });
  app.use('/api/schedule', require('../main/routes/schedule').scheduleRoutes);
  const tok = (id: string, role: string) => `Bearer ${jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' })}`;
  const M = tok('manager-s', 'manager');
  const C = tok('cashier-s', 'cashier');

  console.log('Section 2: store-local times');
  const { shiftInstants } = require('../main/routes/schedule');
  const closing = shiftInstants('2026-11-23', '18:00', '01:00', 'Asia/Phnom_Penh');
  assert(closing.starts_at === '2026-11-23 11:00:00' && closing.ends_at === '2026-11-23 18:00:00', 'closing 18:00–01:00 Kampot = 11:00–18:00 UTC, ending next day');
  const opening = shiftInstants('2026-11-23', '14:00', '20:00', 'Asia/Phnom_Penh');
  assert(opening.starts_at === '2026-11-23 07:00:00' && opening.ends_at === '2026-11-23 13:00:00', 'opening stored in canonical UTC format');

  console.log('Section 3: add, overlap, permissions');
  const week = '2026-11-23';
  const add = (staff_id: string, work_date: string, shift_type_id: string, extra: object = {}, auth = M) =>
    request(app).post('/api/schedule').set('Authorization', auth).send({ staff_id, work_date, shift_type_id, ...extra });
  const bobo = await add('cashier-s', week, 'opening');
  assert(bobo.status === 201 && bobo.body.shift.status === 'draft' && bobo.body.shift.staff_name === 'Bobo', 'manager adds a draft shift');
  assert(bobo.body.shift.role === 'cashier', 'shift keeps the staff role at the time');
  const clash = await add('cashier-s', week, 'full');
  assert(clash.status === 409 && /Bobo already works then/.test(clash.body.error), 'overlapping shift for the same person is refused');
  assert((await add('server-s', week, 'opening', {}, C)).status === 403, 'cashier cannot edit the schedule');
  assert((await add('gone-s', week, 'opening')).status === 400, 'inactive staff cannot be scheduled');
  assert((await add('server-s', week, 'nope')).status === 400, 'unknown shift type refused');
  const custom = await add('server-s', week, 'main', { start_time: '17:00', end_time: '23:30' });
  assert(custom.status === 201 && custom.body.shift.starts_at === '2026-11-23 10:00:00', 'a shift can have its own times');
  const jenieClosing = await add('chef-s', week, 'closing');
  assert(jenieClosing.status === 201, 'closing shift added');
  const view = await request(app).get(`/api/schedule?from=${week}&to=2026-11-29`).set('Authorization', M);
  assert(view.status === 200 && view.body.shifts.length === 3 && view.body.shift_types.length === 4, 'manager reads the week');
  assert(view.body.staff.some((s: { id: string }) => s.id === 'chef-s') && !view.body.staff.some((s: { id: string }) => s.id === 'gone-s'), 'staff list shows active staff only');
  assert((await request(app).get(`/api/schedule?from=${week}&to=2027-02-01`).set('Authorization', M)).status === 400, 'very long ranges refused');

  console.log('Section 4: publish, move, reassign, retime, remove');
  const id = bobo.body.shift.id;
  const pub = await request(app).patch(`/api/schedule/${id}`).set('Authorization', M).send({ status: 'published' });
  assert(pub.body.shift.status === 'published', 'shift published');
  const moved = await request(app).patch(`/api/schedule/${id}`).set('Authorization', M).send({ work_date: '2026-11-24' });
  assert(moved.status === 200 && moved.body.shift.work_date === '2026-11-24' && moved.body.shift.status === 'draft', 'moving a published shift makes it a draft again');
  assert(moved.body.shift.starts_at === '2026-11-24 07:00:00', 'moved shift keeps its times on the new day');
  const toMain = await request(app).patch(`/api/schedule/${id}`).set('Authorization', M).send({ shift_type_id: 'main' });
  assert(toMain.body.shift.shift_type_id === 'main' && toMain.body.shift.starts_at === '2026-11-24 09:00:00', 'dragging to another shift row takes that row\'s times');
  const reassigned = await request(app).patch(`/api/schedule/${id}`).set('Authorization', M).send({ staff_id: 'server-s', work_date: week });
  assert(reassigned.status === 409, 'reassigning onto someone already working is refused');
  const reassignedOk = await request(app).patch(`/api/schedule/${id}`).set('Authorization', M).send({ staff_id: 'manager-s' });
  assert(reassignedOk.body.shift.staff_id === 'manager-s' && reassignedOk.body.shift.role === 'manager', 'shift given to another person');
  const retimed = await request(app).patch(`/api/schedule/${id}`).set('Authorization', M).send({ start_time: '15:00', end_time: '22:00' });
  assert(retimed.body.shift.starts_at === '2026-11-24 08:00:00' && retimed.body.shift.ends_at === '2026-11-24 15:00:00', 'single shift times changed');
  const removed = await request(app).patch(`/api/schedule/${custom.body.shift.id}`).set('Authorization', M).send({ status: 'cancelled' });
  assert(removed.body.shift.status === 'cancelled', 'shift removed (kept as cancelled, not deleted)');
  const after = await request(app).get(`/api/schedule?from=${week}&to=2026-11-29`).set('Authorization', M);
  assert(!after.body.shifts.some((s: { id: string }) => s.id === custom.body.shift.id), 'removed shifts are hidden from the schedule');
  const hist = await request(app).get(`/api/schedule/${id}/history`).set('Authorization', M);
  assert(hist.body.events.map((e: { action: string }) => e.action).join(',') === 'created,published,moved,moved,reassigned,moved', 'every change is kept in the shift history');
  assert(hist.body.events[0].actor_name === 'Borina', 'history records who made the change');

  console.log('Section 5: copy last week, publish week');
  const next = '2026-11-30';
  await request(app).post('/api/schedule').set('Authorization', M).send({ staff_id: 'server-s', work_date: next, shift_type_id: 'opening' });
  const copy = await request(app).post('/api/schedule/copy-week').set('Authorization', M).send({ week_start: next });
  assert(copy.status === 200 && copy.body.copied === 2 && copy.body.skipped === 0, `copies last week's active shifts as drafts (${JSON.stringify(copy.body)})`);
  const again = await request(app).post('/api/schedule/copy-week').set('Authorization', M).send({ week_start: next });
  assert(again.body.copied === 0 && again.body.skipped === 2, 'copying twice skips people already booked');
  const one = await request(app).post('/api/schedule/copy-week').set('Authorization', M).send({ week_start: '2026-12-07', staff_id: 'chef-s' });
  assert(one.body.copied === 1, 'copy can be limited to one person');
  const published = await request(app).post('/api/schedule/publish-week').set('Authorization', M).send({ week_start: next });
  assert(published.body.published === 3, 'publish week publishes every draft in that week');
  const nextWeek = await request(app).get(`/api/schedule?from=${next}&to=2026-12-06`).set('Authorization', M);
  assert(nextWeek.body.shifts.every((s: { status: string }) => s.status === 'published'), 'week is fully published');

  console.log('Section 6: shift times and weekly targets');
  const times = await request(app).put('/api/schedule/shift-types/main').set('Authorization', M).send({ start_time: '16:30', end_time: '23:30' });
  assert(times.body.shift_type.start_time === '16:30', 'shift row times can be changed');
  assert((await request(app).put('/api/schedule/shift-types/main').set('Authorization', M).send({ start_time: '10:00', end_time: '10:00' })).status === 400, 'start and end cannot be equal');
  const target = await request(app).put('/api/schedule/targets/server-s').set('Authorization', M).send({ target_days_per_week: 5 });
  assert(target.status === 200, 'weekly target saved');
  assert((await request(app).put('/api/schedule/targets/server-s').set('Authorization', M).send({ target_days_per_week: 9 })).status === 400, 'target above 7 refused');
  const withTarget = await request(app).get(`/api/schedule?from=${week}&to=2026-11-29`).set('Authorization', M);
  assert(withTarget.body.staff.find((s: { id: string }) => s.id === 'server-s')?.target_days_per_week === 5, 'target shown with staff');
  assert((await request(app).put('/api/schedule/targets/server-s').set('Authorization', C).send({ target_days_per_week: 2 })).status === 403, 'cashier cannot change targets');

  console.log('Section 7: staff see published shifts only');
  const draftForStaff = await add('server-s', '2026-12-14', 'opening');
  const staffView = await request(app).get('/api/schedule?from=2026-11-30&to=2026-12-20').set('Authorization', C);
  assert(staffView.status === 200 && staffView.body.can_manage === false, 'cashier can open the schedule (read-only)');
  assert(staffView.body.shifts.length > 0 && staffView.body.shifts.every((s: { status: string }) => s.status === 'published'), 'staff see published shifts only');
  assert(!staffView.body.shifts.some((s: { id: string }) => s.id === draftForStaff.body.shift.id), 'drafts are hidden from staff');
  const managerView = await request(app).get('/api/schedule?from=2026-11-30&to=2026-12-20').set('Authorization', M);
  assert(managerView.body.can_manage === true && managerView.body.shifts.some((s: { id: string }) => s.id === draftForStaff.body.shift.id), 'managers see drafts');
  const chef = tok('chef-s', 'chef');
  assert((await request(app).get('/api/schedule?from=2026-11-30&to=2026-12-06').set('Authorization', chef)).status === 200, 'kitchen staff can view too');
  assert((await request(app).get(`/api/schedule/${draftForStaff.body.shift.id}/history`).set('Authorization', C)).status === 403, 'staff cannot read change history');

  console.log('Section 8: schedule-only people');
  const person = await request(app).post('/api/schedule/people').set('Authorization', M).send({ name: 'Pheap', job_label: 'Security' });
  assert(person.status === 201 && person.body.person.schedule_only === 1 && person.body.person.job_label === 'Security', 'manager adds a schedule-only person with a job label');
  const row = db.prepare(`SELECT email, pin, pin_hash, password, role, is_active FROM users WHERE id = ?`).get(person.body.person.id) as Record<string, unknown>;
  assert(row.email === null && row.pin === null && row.pin_hash === null && row.password === '!' && row.is_active === 1, 'no email, no PIN and an unusable password');
  assert((await request(app).post('/api/schedule/people').set('Authorization', C).send({ name: 'X' })).status === 403, 'cashier cannot add people');
  assert((await request(app).post('/api/schedule/people').set('Authorization', M).send({ name: '  ' })).status === 400, 'name required');
  const pheapShift = await add(person.body.person.id, '2026-12-15', 'closing');
  assert(pheapShift.status === 201, 'schedule-only person can be scheduled');
  const list = await request(app).get('/api/schedule?from=2026-12-14&to=2026-12-20').set('Authorization', M);
  const listed = list.body.staff.find((s: { id: string }) => s.id === person.body.person.id);
  assert(listed?.schedule_only === 1 && listed.job_label === 'Security', 'shown in the staff list with job label');
  const relabel = await request(app).put('/api/schedule/people/server-s').set('Authorization', M).send({ job_label: 'Bartender' });
  assert(relabel.status === 200, 'POS staff can get a job label too');
  assert((await request(app).put('/api/schedule/people/server-s').set('Authorization', M).send({ name: 'Renamed' })).status === 409, 'POS staff accounts are not renamed here');
  const retired = await request(app).put(`/api/schedule/people/${person.body.person.id}`).set('Authorization', M).send({ active: false });
  const afterRetire = await request(app).get('/api/schedule?from=2026-12-14&to=2026-12-20').set('Authorization', M);
  assert(retired.status === 200 && !afterRetire.body.staff.some((s: { id: string }) => s.id === person.body.person.id), 'schedule-only person can be retired');
  const authApp = express();
  authApp.use(express.json());
  authApp.use('/api/auth', require('../main/routes/auth').authRoutes);
  const pinLogin = await request(authApp).post('/api/auth/login').send({ email: null, password: '!' });
  assert(pinLogin.status >= 400, 'schedule-only person cannot log in');

  console.log('='.repeat(50));
  console.log(`Passed ${passed}/${passed + failed}, failed ${failed}`);
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
