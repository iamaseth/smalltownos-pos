/**
 * Print job ledger + cloud runtime guard (BackStreet USB printing on the
 * computer the printer is plugged into).
 *
 * Usage: node tests/run-electron-node-test.cjs tests/print-jobs.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-print-jobs-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-print-jobs';

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
  console.log('Print job ledger');
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
  const version = Number(db.pragma('user_version', { simple: true }));
  assert(version >= 106, `schema at v106+ (got v${version})`);
  assert(!!db.prepare(`SELECT name FROM sqlite_master WHERE name = 'print_jobs'`).get(), 'print_jobs table exists');

  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES ('cash-p', 'Cashier', 'c@p.test', ?, 'cashier', 1, ?, ?)`)
    .run(bcrypt.hashSync('pw', 4), now(), now());
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = jwt.verify(String(req.headers.authorization).split(' ')[1], getJWTSecret());
    next();
  });
  app.use('/api/print-jobs', require('../main/routes/print-jobs').printJobRoutes);
  app.use('/api/printers', require('../main/routes/printers').printerRoutes);
  const auth = `Bearer ${jwt.sign({ userId: 'cash-p', email: 'c@p.test', role: 'cashier' }, getJWTSecret(), { expiresIn: '1h' })}`;
  const claim = (body: object) => request(app).post('/api/print-jobs/claim').set('Authorization', auth).send(body);

  const first = await claim({ job_key: 'kot:10:Kitchen:abc', kind: 'kot', label: 'Kitchen ticket 10', transport: 'webusb', payload: { orderId: 10 } });
  assert(first.status === 200 && first.body.action === 'print', 'first claim may print');
  const jobId = first.body.job.id;
  const tap2 = await claim({ job_key: 'kot:10:Kitchen:abc', kind: 'kot', transport: 'browser' });
  assert(tap2.body.action === 'skip' && tap2.body.reason === 'in_progress', 'double tap / mode switch while printing is skipped');

  const failedRes = await request(app).post(`/api/print-jobs/${jobId}/result`).set('Authorization', auth)
    .send({ status: 'failed', error_code: 'not_connected', error: 'Printer is not connected', transport: 'webusb' });
  assert(failedRes.body.job.status === 'failed' && failedRes.body.job.last_error_code === 'not_connected', 'failure recorded with code');
  const list = await request(app).get('/api/print-jobs/failed').set('Authorization', auth);
  assert(list.body.jobs.length === 1 && list.body.jobs[0].payload.orderId === 10, 'failed kitchen ticket listed with payload for retry');

  const retry = await claim({ job_key: 'kot:10:Kitchen:abc', kind: 'kot', transport: 'webusb' });
  assert(retry.body.action === 'print' && retry.body.job.attempts === 2, 'failed job may be retried (attempt 2)');
  assert(retry.body.job.payload.orderId === 10, 'retry keeps the original payload');
  await request(app).post(`/api/print-jobs/${jobId}/result`).set('Authorization', auth).send({ status: 'printed', transport: 'webusb' });
  const dup = await claim({ job_key: 'kot:10:Kitchen:abc', kind: 'kot', transport: 'webusb' });
  assert(dup.body.action === 'skip' && dup.body.reason === 'already_printed', 'just-printed ticket is not printed twice');

  db.prepare(`UPDATE print_jobs SET printed_at = datetime('now', '-10 minutes') WHERE id = ?`).run(jobId);
  const later = await claim({ job_key: 'kot:10:Kitchen:abc', kind: 'kot', transport: 'webusb' });
  assert(later.body.action === 'print', 'deliberate reprint later is allowed');

  db.prepare(`UPDATE print_jobs SET updated_at = datetime('now', '-5 minutes') WHERE id = ?`).run(jobId);
  const stale = await claim({ job_key: 'kot:10:Kitchen:abc', kind: 'kot', transport: 'webusb' });
  assert(stale.body.action === 'print', 'stale "printing" lease (crashed tab) does not block forever');

  const r2 = await claim({ job_key: 'bill:5:paid', kind: 'receipt', transport: 'browser' });
  await request(app).post(`/api/print-jobs/${r2.body.job.id}/result`).set('Authorization', auth).send({ status: 'failed', error_code: 'popup_blocked' });
  const r3 = await claim({ job_key: 'kot:11:Kitchen:x', kind: 'kot', transport: 'webusb' });
  await request(app).post(`/api/print-jobs/${r3.body.job.id}/result`).set('Authorization', auth).send({ status: 'failed', error_code: 'weird_code' });
  const ordered = await request(app).get('/api/print-jobs/failed').set('Authorization', auth);
  assert(ordered.body.jobs[0].kind === 'kot', 'kitchen tickets are listed before receipts');
  assert(ordered.body.jobs.find((j: any) => j.job_key === 'kot:11:Kitchen:x').last_error_code === 'unknown', 'unknown error codes are normalised');
  const dis = await request(app).post(`/api/print-jobs/${r2.body.job.id}/dismiss`).set('Authorization', auth);
  assert(dis.body.dismissed === true, 'failed job can be dismissed');
  const missing = await claim({ kind: 'kot' });
  assert(missing.status === 400, 'job_key required');

  console.log('Section 2: online POS never prints from the server');
  delete process.env.FLO_RUNTIME;
  const desktop = await request(app).get('/api/printers/runtime').set('Authorization', auth);
  assert(desktop.body.runtime === 'desktop' && desktop.body.server_side_printing === true, 'desktop runtime prints natively');
  process.env.FLO_RUNTIME = 'cloud';
  const cloud = await request(app).get('/api/printers/runtime').set('Authorization', auth);
  assert(cloud.body.runtime === 'cloud' && cloud.body.server_side_printing === false, 'Railway runtime reported as cloud');
  const refusedBill = await request(app).post('/api/printers/print-bill').set('Authorization', auth).send({ billId: 1 });
  assert(refusedBill.status === 409 && refusedBill.body.code === 'server_printing_unavailable', 'server receipt printing refused in cloud');
  const refusedKot = await request(app).post('/api/printers/print-kot').set('Authorization', auth).send({ orderId: 1 });
  assert(refusedKot.status === 409, 'server kitchen printing refused in cloud');
  delete process.env.FLO_RUNTIME;

  console.log('='.repeat(50));
  console.log(`Passed ${passed}/${passed + failed}, failed ${failed}`);
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
