const Module = require('module');
const originalLoad = Module._load;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-register-access-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  initTestDb, createApp, seedManagerUser, closeDatabase, now,
} = require('./helpers/test-setup');
const { registerAccessRoutes } = require('../main/routes/register-access');
const { authRoutes } = require('../main/routes/auth');
const { getJWTSecret } = require('../main/routes/auth');
const { resetRegisterSessionsForTests, touchRegisterSession } = require('../main/services/register-session');

async function run() {
  const db = initTestDb();
  resetRegisterSessionsForTests();
  const manager = seedManagerUser(db);
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'cashier', ?, 1, ?, ?)
  `).run('cashier-pin-1', 'Cashier One', 'cashier@test.local', bcrypt.hashSync('Cashier123!', 10), bcrypt.hashSync('4321', 10), now(), now());

  const app = createApp({ '/api/auth': authRoutes, '/api/register-access': registerAccessRoutes });
  try {
    const status = await request(app).get('/api/register-access/status').set(manager.authHeader);
    if (status.status !== 200 || status.body.pin_lock_enabled !== true) throw new Error('PIN lock status should be enabled');

    const emailLogin = await request(app).post('/api/auth/login').send({ email: 'cashier@test.local', password: 'Cashier123!' });
    if (emailLogin.status !== 401) throw new Error('Operational staff email/password login must be rejected');

    const bad = await request(app).post('/api/register-access/unlock').set(manager.authHeader).send({ pin: '9999' });
    if (bad.status !== 401) throw new Error('Incorrect staff PIN should be rejected');

    const unlocked = await request(app).post('/api/register-access/unlock').set(manager.authHeader).send({ pin: '4321' });
    if (unlocked.status !== 200 || unlocked.body.operator?.id !== 'cashier-pin-1') throw new Error('Correct staff PIN should create cashier session');

    const payload = jwt.verify(unlocked.body.access_token, getJWTSecret()) as any;
    if (payload.registerSession !== true || !payload.jti) throw new Error('PIN token must be marked as a register session');
    if (!touchRegisterSession(payload.jti, 'cashier-pin-1')) throw new Error('New PIN session should be active');

    const locked = await request(app).post('/api/register-access/lock')
      .set('Authorization', `Bearer ${unlocked.body.access_token}`).send({});
    if (locked.status !== 200) throw new Error('Staff lock should succeed');
    if (touchRegisterSession(payload.jti, 'cashier-pin-1')) throw new Error('Explicit lock should revoke server-side session');

    const events = db.prepare('SELECT event_type FROM register_access_events ORDER BY id').all() as { event_type: string }[];
    const eventTypes = events.map((event) => event.event_type);
    if (!eventTypes.includes('pin_failed') || !eventTypes.includes('unlock') || !eventTypes.includes('lock')) {
      throw new Error(`Register access audit events missing: ${eventTypes.join(', ')}`);
    }
    const history = await request(app).get('/api/register-access/events').set(manager.authHeader);
    if (history.status !== 200 || !Array.isArray(history.body.events) || history.body.events.length < 3) {
      throw new Error('Manager should be able to read register access history');
    }

    console.log('register-access: all checks passed');
  } finally {
    resetRegisterSessionsForTests();
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error: any) => {
  resetRegisterSessionsForTests();
  try { closeDatabase(); } catch {}
  Module._load = originalLoad;
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  console.error(error);
  process.exit(1);
});
