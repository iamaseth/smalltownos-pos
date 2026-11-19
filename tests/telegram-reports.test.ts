/**
 * Telegram reporting: connection, recipient linking, reports, attachments,
 * scheduling, retries and duplicate prevention against a fake Bot API server.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/telegram-reports.test.ts
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-telegram-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-telegram';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { assertOrThrow, assertEqualOrThrow, isNativeAbiMismatch } = require('./helpers/test-setup');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');

type Call = { method: string; body: string; contentType: string };
const calls: Call[] = [];
let failMode: null | number = null;

function startFakeTelegram(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const method = (req.url || '').split('/').pop() || '';
        const body = Buffer.concat(chunks).toString('latin1');
        calls.push({ method, body, contentType: String(req.headers['content-type'] || '') });
        if (!(req.url || '').startsWith('/bottest-token/')) { res.writeHead(401); res.end(JSON.stringify({ ok: false, description: 'Unauthorized' })); return; }
        if (failMode && method !== 'getMe') { res.writeHead(failMode, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, description: `fake ${failMode}` })); return; }
        const result = method === 'getMe' ? { username: 'BackStreetTestBot' } : method === 'getUpdates' ? [] : { message_id: calls.length };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  console.log('Telegram reports');
  console.log('='.repeat(50));
  try { initDatabase(); } catch (error: any) {
    if (isNativeAbiMismatch(error)) { console.log('  ⚠ Skipping: ABI mismatch'); process.exit(77); }
    throw error;
  }
  const fake = await startFakeTelegram();
  const port = (fake.address() as { port: number }).port;
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${port}`;

  const telegram = require('../main/services/telegram');
  const { telegramRoutes } = require('../main/routes/telegram');
  telegram.setTelegramTestMode(true);
  const db = getDatabase();
  const setSetting = db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  setSetting.run('currency', 'USD', now());
  setSetting.run('country', 'KH', now());
  setSetting.run('timezone', 'Asia/Phnom_Penh', now());
  setSetting.run('business_name', 'BackStreet Test', now());
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES ('owner-tg', 'Owner', 'o@t.local', ?, 'owner', 1, ?, ?)`).run(bcrypt.hashSync('pw', 4), now(), now());
  db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES ('cashier-tg', 'Cashier', 'c@t.local', ?, 'cashier', 1, ?, ?)`).run(bcrypt.hashSync('pw', 4), now(), now());

  const app = express();
  app.use(express.json());
  app.use((req: any, res: any, next: any) => {
    try { req.user = jwt.verify(String(req.headers.authorization || '').replace('Bearer ', ''), getJWTSecret()); next(); } catch { res.status(401).end(); }
  });
  app.use('/api/telegram', telegramRoutes);
  const owner = `Bearer ${jwt.sign({ userId: 'owner-tg', role: 'owner' }, getJWTSecret())}`;
  const cashier = `Bearer ${jwt.sign({ userId: 'cashier-tg', role: 'cashier' }, getJWTSecret())}`;

  try {
    console.log('\n1. Bot connection and access');
    delete process.env.TELEGRAM_BOT_TOKEN;
    let res = await request(app).get('/api/telegram/status').set('Authorization', owner);
    assertEqualOrThrow(res.body.status.tokenConfigured, false, 'status shows no token');
    assertOrThrow(!JSON.stringify(res.body).includes('test-token'), 'status never contains a token');
    res = await request(app).post('/api/telegram/connect').set('Authorization', owner);
    assertEqualOrThrow(res.status, 400, 'connecting without TELEGRAM_BOT_TOKEN is refused');
    res = await request(app).get('/api/telegram/status').set('Authorization', cashier);
    assertEqualOrThrow(res.status, 403, 'cashiers cannot see Telegram settings');
    process.env.TELEGRAM_BOT_TOKEN = 'wrong-token';
    res = await request(app).post('/api/telegram/connect').set('Authorization', owner);
    assertEqualOrThrow(res.status, 502, 'a bad token fails to connect');
    assertOrThrow(!JSON.stringify(res.body).includes('wrong-token'), 'the error does not leak the token');
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    res = await request(app).post('/api/telegram/connect').set('Authorization', owner);
    assertEqualOrThrow(res.status, 200, 'connects with a good token');
    assertEqualOrThrow(res.body.status.botUsername, 'BackStreetTestBot', 'status shows the bot name');
    telegram.stopTelegram();

    console.log('\n2. Recipient authorisation');
    res = await request(app).post('/api/telegram/link-code').set('Authorization', owner);
    const code = res.body.code as string;
    assertOrThrow(/^\d{6}$/.test(code), 'admins get a six-digit link code');
    assertEqualOrThrow(await telegram.handleUpdate({ update_id: 1, message: { text: '/report', chat: { id: 999, type: 'private' } } }), 'rejected', 'strangers sending commands are refused');
    assertEqualOrThrow(await telegram.handleUpdate({ update_id: 2, message: { text: '/start 000000', chat: { id: 999, type: 'private' } } }), 'rejected', 'a wrong code is refused');
    assertEqualOrThrow(telegram.listRecipients().length, 0, 'nobody is linked yet');
    assertEqualOrThrow(await telegram.handleUpdate({ update_id: 3, message: { text: `/start ${code}`, chat: { id: 111, type: 'private', first_name: 'Owner', username: 'owner' } } }), 'linked', 'the code links the owner');
    assertEqualOrThrow(await telegram.handleUpdate({ update_id: 4, message: { text: `/start ${code}`, chat: { id: 222, type: 'private' } } }), 'rejected', 'a used code cannot be reused');
    const groupCode = (await request(app).post('/api/telegram/link-code').set('Authorization', owner)).body.code as string;
    assertEqualOrThrow(await telegram.handleUpdate({ update_id: 5, message: { text: `/start@BackStreetTestBot ${groupCode}`, chat: { id: -1001234567890, type: 'supergroup', title: 'BackStreet Managers' } } }), 'linked', 'a supergroup links with /start@bot CODE');
    const group = telegram.listRecipients().find((r: { chat_id: string }) => r.chat_id === '-1001234567890');
    assertEqualOrThrow(group?.display_name, 'BackStreet Managers', 'the group shows under its title');
    await request(app).delete(`/api/telegram/recipients/${group.id}`).set('Authorization', owner);
    const recipient = telegram.listRecipients()[0];
    assertEqualOrThrow(recipient.chat_id, '111', 'one recipient, the linked chat');
    res = await request(app).put(`/api/telegram/recipients/${recipient.id}`).set('Authorization', owner).send({ reports: ['daily', 'weekly', 'shift', 'low_stock', 'purchasing', 'bogus'] });
    assertEqualOrThrow(res.body.recipient.reports.join(','), 'daily,weekly,shift,low_stock,purchasing', 'report choices are saved, unknown ones dropped');

    console.log('\n3. Test message');
    calls.length = 0;
    res = await request(app).post('/api/telegram/test').set('Authorization', owner).send({});
    assertEqualOrThrow(res.body.queued, 1, 'test goes to the one recipient');
    const testCall = calls.find((c) => c.method === 'sendMessage');
    assertOrThrow(Boolean(testCall && testCall.body.includes('"chat_id":"111"') && testCall.body.includes('Test message')), 'test message reached Telegram');

    console.log('\n4. Daily sales report with PDF and CSV');
    db.prepare(`INSERT INTO categories (id, name, sort_order, is_active, created_at, updated_at) VALUES ('cat-b', 'Beer', 0, 1, ?, ?)`).run(now(), now());
    db.prepare(`INSERT INTO products (id, name, price, category_id, is_active, created_at, updated_at) VALUES ('p-beer', 'Angkor Draft', 1.5, 'cat-b', 1, ?, ?)`).run(now(), now());
    const businessDate = require('../main/services/telegram-reports').currentBusinessDate(db);
    calls.length = 0;
    telegram.notifyTelegram('day_close', { businessDate });
    await telegram.processQueue();
    const methods = calls.map((c) => c.method);
    assertEqualOrThrow(methods.filter((m) => m === 'sendMessage').length, 1, 'one formatted summary message');
    assertEqualOrThrow(methods.filter((m) => m === 'sendDocument').length, 2, 'PDF and CSV attachments');
    const summary = calls.find((c) => c.method === 'sendMessage')!.body;
    assertOrThrow(summary.includes('Daily summary') && summary.includes('Payments') && summary.includes('Cash') && summary.includes('HTML'), 'summary has sales, payments and cash sections');
    const docs = calls.filter((c) => c.method === 'sendDocument').map((c) => c.body);
    assertOrThrow(docs.some((d) => d.includes('application/pdf') && d.includes('%PDF-1.4')), 'the PDF is a real PDF');
    assertOrThrow(docs.some((d) => d.includes('text/csv') && d.includes('product_name')), 'the CSV has the item columns');

    console.log('\n5. Duplicate prevention');
    calls.length = 0;
    telegram.notifyTelegram('day_close', { businessDate });
    telegram.runScheduledChecks();
    await telegram.processQueue();
    assertEqualOrThrow((db.prepare(`SELECT COUNT(*) n FROM telegram_deliveries WHERE dedupe_key LIKE ?`).get(`daily|${businessDate}|%`) as { n: number }).n, 1, 'closing the same day again does not queue a second report');
    assertEqualOrThrow((db.prepare(`SELECT attempts FROM telegram_deliveries WHERE dedupe_key LIKE ?`).get(`daily|${businessDate}|%`) as { attempts: number }).attempts, 1, 'the closed day was sent once');
    const yesterdayKey = (db.prepare(`SELECT dedupe_key FROM telegram_deliveries WHERE report_type = 'daily' AND dedupe_key NOT LIKE ?`).get(`daily|${businessDate}|%`) as { dedupe_key: string } | undefined)?.dedupe_key ?? '';
    const backupDue = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Phnom_Penh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()) >= '10:00';
    assertEqualOrThrow(Boolean(yesterdayKey), backupDue, 'an unclosed previous day gets the 10:00 backup report only after 10:00');

    console.log('\n6. Failed delivery and retry');
    db.prepare(`INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents) VALUES ('owner-tg', 'Owner', ?, 5000)`).run(now());
    const sessionId = (db.prepare('SELECT id FROM cash_sessions ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
    failMode = 500;
    telegram.notifyTelegram('shift_open', { sessionId });
    await telegram.processQueue();
    let row = db.prepare(`SELECT status, attempts, next_attempt_at, last_error FROM telegram_deliveries WHERE report_type = 'shift'`).get() as { status: string; attempts: number; next_attempt_at: string; last_error: string };
    assertOrThrow(row.status === 'pending' && row.attempts === 1 && row.next_attempt_at > now(), 'a server error is kept for retry later');
    assertOrThrow(row.last_error.includes('fake 500'), 'the error is recorded');
    failMode = null;
    await telegram.processQueue();
    assertEqualOrThrow((db.prepare(`SELECT attempts FROM telegram_deliveries WHERE report_type = 'shift'`).get() as { attempts: number }).attempts, 1, 'it waits for the retry time');
    db.prepare(`UPDATE telegram_deliveries SET next_attempt_at = ? WHERE report_type = 'shift'`).run('2000-01-01T00:00:00.000Z');
    calls.length = 0;
    await telegram.processQueue();
    row = db.prepare(`SELECT status, attempts FROM telegram_deliveries WHERE report_type = 'shift'`).get() as typeof row;
    assertOrThrow(row.status === 'sent' && row.attempts === 2, 'the retry succeeds');
    assertOrThrow(calls.some((c) => c.body.includes('Shift opened by Owner')), 'shift opening message sent');
    failMode = 400;
    telegram.notifyTelegram('shift_close', { sessionId });
    await telegram.processQueue();
    row = db.prepare(`SELECT status, attempts FROM telegram_deliveries WHERE dedupe_key LIKE 'shift|%|close|%'`).get() as typeof row;
    assertOrThrow(row.status === 'failed' && row.attempts === 1, 'a permanent error (400) fails without retrying');
    failMode = null;

    console.log('\n7. Scheduled delivery and low stock');
    const { createSupply } = require('../main/services/supplies');
    createSupply(db, { name: 'Draft keg', baseUnit: 'each', lowStockThreshold: 1 });
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Phnom_Penh', weekday: 'short' }).format(new Date()));
    telegram.saveSchedule({ weeklyDay: weekday, weeklyTime: '00:00' });
    calls.length = 0;
    telegram.runScheduledChecks();
    await telegram.processQueue();
    const sent = calls.filter((c) => c.method === 'sendMessage').map((c) => c.body);
    assertOrThrow(sent.some((b) => b.includes('Weekly report')), 'weekly report sent on its day');
    assertOrThrow(sent.some((b) => b.includes('Purchasing')), 'purchasing summary sent with it');
    assertOrThrow(sent.some((b) => b.includes('Low stock') && b.includes('Draft keg')), 'low stock alert sent');
    calls.length = 0;
    telegram.runScheduledChecks();
    await telegram.processQueue();
    assertEqualOrThrow(calls.length, 0, 'the next check sends nothing new');
    res = await request(app).put('/api/telegram/schedule').set('Authorization', owner).send({ weeklyTime: '25:00' });
    assertEqualOrThrow(res.status, 400, 'invalid times are refused');

    console.log('\n8. Send a report now from the Reports page');
    assertEqualOrThrow(telegram.onDemandKind('2026-11-16', '2026-11-16'), 'daily', 'one day sends the daily summary');
    assertEqualOrThrow(telegram.onDemandKind('2026-11-09', '2026-11-15'), 'weekly', 'a Monday-Sunday week sends the weekly report');
    assertEqualOrThrow(telegram.onDemandKind('2026-11-16', '2026-11-19'), 'period', 'a partial week sends a period summary');
    assertEqualOrThrow(telegram.onDemandKind('2026-11-01', '2026-11-19'), 'period', 'a month range sends a period summary');
    calls.length = 0;
    res = await request(app).post('/api/telegram/send-now').set('Authorization', owner).send({ start_date: businessDate, end_date: businessDate, recipient_ids: [recipient.id] });
    assertEqualOrThrow(res.body.sent, 1, 'the daily summary is sent on demand');
    res = await request(app).post('/api/telegram/send-now').set('Authorization', owner).send({ start_date: businessDate, end_date: businessDate, recipient_ids: [recipient.id] });
    assertEqualOrThrow(res.body.sent, 1, 'sending the same day again is allowed');
    assertEqualOrThrow(calls.filter((c) => c.method === 'sendMessage' && c.body.includes('Daily summary')).length, 2, 'both on-demand sends reached Telegram');
    calls.length = 0;
    res = await request(app).post('/api/telegram/send-now').set('Authorization', owner).send({ start_date: '2026-11-01', end_date: '2026-11-19', recipient_ids: [recipient.id] });
    assertEqualOrThrow(res.body.kind, 'period', 'a range sends the period summary');
    assertOrThrow(calls.some((c) => c.method === 'sendMessage' && c.body.includes('Sales summary') && c.body.includes('Payments')), 'the period summary has sales and payments');
    assertEqualOrThrow(calls.filter((c) => c.method === 'sendDocument').length, 2, 'the period summary has PDF and CSV');
    res = await request(app).post('/api/telegram/send-now').set('Authorization', owner).send({ start_date: '2026-11-19', end_date: '2026-11-01', recipient_ids: [recipient.id] });
    assertEqualOrThrow(res.status, 400, 'a reversed range is refused');
    res = await request(app).post('/api/telegram/send-now').set('Authorization', owner).send({ start_date: businessDate, end_date: businessDate, recipient_ids: [] });
    assertEqualOrThrow(res.status, 400, 'sending with no recipient is refused');
    res = await request(app).post('/api/telegram/send-now').set('Authorization', cashier).send({ start_date: businessDate, end_date: businessDate, recipient_ids: [recipient.id] });
    assertEqualOrThrow(res.status, 403, 'cashiers cannot send reports');

    console.log('\n9. Disconnect stops sending');
    await request(app).post('/api/telegram/disconnect').set('Authorization', owner);
    calls.length = 0;
    telegram.notifyTelegram('shift_open', { sessionId: sessionId + 99 });
    assertEqualOrThrow((db.prepare(`SELECT COUNT(*) n FROM telegram_deliveries WHERE dedupe_key LIKE ?`).get(`shift|${sessionId + 99}|%`) as { n: number }).n, 0, 'nothing is queued while disconnected');

    console.log('\nAll telegram checks passed');
  } finally {
    telegram.stopTelegram();
    fake.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
