/**
 * BackStreet cash management: dual-currency Cash Counter, blind closing,
 * busy-time handover (count out the float, take the rest, count on phone),
 * incoming independent float count, append-only notes and manager resolve.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/cash-handover.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cash-handover-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-cash-handover';

const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const { initDatabase, getDatabase, now } = require('../main/db');
const { getJWTSecret } = require('../main/routes/auth');
const counter = require('../shared/cash-counter');

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string) {
  if (condition) { passed++; console.log(`  ✓ ${message}`); } else { failed++; console.error(`  ✗ ${message}`); }
}

async function main() {
  console.log('Cash handover / dual-currency reconciliation');
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

  console.log('Section 1: migration 105');
  const version = Number(db.pragma('user_version', { simple: true }));
  assert(version >= 105, `schema at v105+ (got v${version})`);
  for (const table of ['cash_counts', 'cash_reconciliations', 'cash_reconciliation_notes', 'cash_handovers',
    'ticket_handovers', 'ticket_handover_items', 'media_uploads', 'cash_envelopes', 'purchase_receipts']) {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
    assert(!!row, `table ${table} exists`);
  }
  const sessionCols = (db.prepare(`PRAGMA table_info(cash_sessions)`).all() as { name: string }[]).map((c) => c.name);
  for (const col of ['handover_state', 'cutoff_at', 'opening_count_id', 'opening_khr_riel', 'review_required']) {
    assert(sessionCols.includes(col), `cash_sessions.${col} added`);
  }
  const setting = (key: string) => (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
  assert(setting('cash_standard_float_usd_cents') === '10000', 'standard float USD seeded ($100)');
  assert(setting('cash_change_policy') === 'usd_whole_khr_rest', 'change policy seeded');

  console.log('Section 2: shared counter rules');
  const denoms = counter.emptyDenominations();
  denoms.USD['100'] = 4; denoms.USD['10'] = 3; denoms.USD['2'] = 5; denoms.KHR['100000'] = 7;
  const totals = counter.normalizeCashCount({ method: 'denominations', denominations: denoms, usd_cents: 1 }, 4100);
  assert(totals.usd_cents === 44000, 'screenshot count: $440.00');
  assert(totals.khr_riel === 700000, 'screenshot count: 700,000៛');
  assert(totals.combined_usd_cents === 44000 + Math.round(70000000 / 4100), 'combined = USD + KHR/rate');
  assert(counter.applyTileGesture(5, { type: 'double' }) === 10 && counter.applyTileGesture(10, { type: 'double' }) === 20, 'swipe right doubles 5 → 10 → 20');
  assert(counter.applyTileGesture(20, { type: 'clear' }) === 0, 'swipe left clears');
  assert(counter.applyTileGesture(0, { type: 'tap' }) === 1, 'tap adds one');
  assert(counter.applyTileGesture(3, { type: 'set', quantity: 12 }) === 12, 'press-and-hold sets exact');
  assert(counter.classifySwipe(10, 80) === null, 'vertical scroll is not a swipe');
  assert(counter.classifySwipe(-60, 5) === 'clear' && counter.classifySwipe(60, 5) === 'double', 'horizontal swipes classified');
  let threw = false;
  try { counter.normalizeCashCount({ method: 'manual', usd_cents: 100, khr_riel: 150 }, 4100); } catch { threw = true; }
  assert(threw, 'manual KHR must be a multiple of 100');
  threw = false;
  try { counter.normalizeCashCount({ method: 'denominations', denominations: { USD: { 3: 1 }, KHR: {} } }, 4100); } catch { threw = true; }
  assert(threw, 'unknown note rejected');

  console.log('Section 3: API flow');
  for (const [key, value] of [['country', 'KH'], ['currency', 'USD'], ['timezone', 'Asia/Phnom_Penh']]) {
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value, now());
  }
  for (const [id, name, role] of [['owner-h', 'Owner', 'owner'], ['manager-h', 'Manager', 'manager'], ['cashier-a', 'Sokha', 'cashier'], ['cashier-b', 'Dara', 'cashier']]) {
    db.prepare(`INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, name, `${id}@test.local`, bcrypt.hashSync('pw', 4), role, now(), now());
  }
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use((req: any, res: any, next: any) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'auth' });
    req.user = jwt.verify(h.split(' ')[1], getJWTSecret());
    next();
  });
  app.use('/api/cash-handover', require('../main/routes/cash-handover').cashHandoverRoutes);
  app.use('/api/cash-sessions', require('../main/routes/cash-sessions').cashSessionRoutes);
  const tok = (id: string, role: string) => `Bearer ${jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' })}`;
  const A = tok('cashier-a', 'cashier');
  const B = tok('cashier-b', 'cashier');
  const M = tok('manager-h', 'manager');

  const open = await request(app).post('/api/cash-handover/open').set('Authorization', A)
    .send({ count: { method: 'denominations', denominations: denoms }, device: 'pos' });
  assert(open.status === 200, `cashier A opens with Cash Counter (${open.status} ${JSON.stringify(open.body).slice(0, 120)})`);
  const sessionId = open.body?.session?.id;
  assert(open.body?.session?.opening_khr_riel === 700000, 'opening KHR stored on session');
  assert(open.body?.session?.opening_float_cents === totals.combined_usd_cents, 'legacy opening_float_cents = combined USD equivalent');

  // Sales during the shift: split cash lines + one legacy (untracked) cash line + an ABA line.
  let orderSeq = 0;
  const addBill = (lines: object[], status = 'paid') => {
    orderSeq += 1;
    const t = now();
    const order = db.prepare(`INSERT INTO orders (order_number, user_id, type, status, subtotal, total, created_at, updated_at) VALUES (?, 'cashier-a', 'dine_in', ?, 0, 0, ?, ?)`)
      .run(`T-${orderSeq}`, status === 'paid' ? 'completed' : 'pending', t, t);
    db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at) VALUES (?, ?, 0, 10, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`B-${orderSeq}`, Number(order.lastInsertRowid), status === 'paid' ? 10 : 0, status === 'paid' ? 0 : 10, status,
        JSON.stringify(lines), status === 'paid' ? t : null, t, t);
  };
  addBill([{ method: 'cash', amount: 18, cash_session_id: sessionId, cash_usd_in: 20, cash_khr_in: 0, change_usd_out: 2, change_khr_out: 0, timestamp: now() }]);
  addBill([{ method: 'cash', amount: 10, cash_session_id: sessionId, cash_usd_in: 0, cash_khr_in: 41000, change_usd_out: 0, change_khr_out: 0, timestamp: now() }]);
  addBill([{ method: 'cash', amount: 5, cash_session_id: sessionId, timestamp: now() }]);
  addBill([{ method: 'custom', payment_method_id: 1, amount: 30, cash_session_id: sessionId, timestamp: now() }]);
  addBill([], 'unpaid');

  const status = await request(app).get('/api/cash-handover/status').set('Authorization', A);
  assert(status.status === 200 && status.body.open_session?.id === sessionId, 'status shows the open shift');
  assert(!JSON.stringify(status.body).includes('expected'), 'status never reveals expected cash (blind)');

  const quietClose = await request(app).post(`/api/cash-handover/sessions/${sessionId}/closing-count`).set('Authorization', A)
    .send({ count: { method: 'manual', usd_cents: 1000, khr_riel: 0 } });
  assert(quietClose.status === 409 && /unpaid bill/.test(quietClose.body.error), 'normal close blocked by unpaid ticket');

  const otherCashier = await request(app).post(`/api/cash-handover/sessions/${sessionId}/handover-now`).set('Authorization', B)
    .send({ float_left: { method: 'manual', usd_cents: 10000, khr_riel: 400000 } });
  assert(otherCashier.status === 403, 'another cashier cannot hand over A\'s shift');

  const hand = await request(app).post(`/api/cash-handover/sessions/${sessionId}/handover-now`).set('Authorization', A)
    .send({ float_left: { method: 'manual', usd_cents: 10000, khr_riel: 400000 }, device: 'pos' });
  assert(hand.status === 200 && typeof hand.body.handover_id === 'number', 'busy handover-now succeeds');
  const frozen = db.prepare(`SELECT * FROM cash_sessions WHERE id = ?`).get(sessionId) as any;
  assert(frozen.status === 'closed' && frozen.handover_state === 'pending_count', 'session stops selling, awaits count');
  assert(frozen.closure_id === null, 'no closure written until takings are counted');
  const items = db.prepare(`SELECT COUNT(*) AS c FROM ticket_handover_items`).get() as { c: number };
  assert(items.c === 1, 'open ticket snapshotted for handover');
  const rec0 = db.prepare(`SELECT * FROM cash_reconciliations WHERE session_id = ?`).get(sessionId) as any;
  assert(rec0.expected_usd_cents === 44000 + 1800 + 500, `expected USD = opening + net USD cash + untracked (${rec0.expected_usd_cents})`);
  assert(rec0.expected_khr_riel === 700000 + 41000, `expected KHR = opening + KHR received (${rec0.expected_khr_riel})`);
  assert(rec0.untracked_cash_lines === 1, 'legacy cash line flagged as untracked');

  const recA = await request(app).get(`/api/cash-handover/sessions/${sessionId}/reconciliation`).set('Authorization', A);
  assert(recA.status === 200 && recA.body.reconciliation.expected === null, 'cashier cannot see expected before counting');
  const recM = await request(app).get(`/api/cash-handover/sessions/${sessionId}/reconciliation`).set('Authorization', M);
  assert(recM.body.reconciliation.expected?.usd_cents === 46300, 'manager may see expected');

  const statusB = await request(app).get('/api/cash-handover/status').set('Authorization', B);
  const waiting = (statusB.body.awaiting_incoming || []).find((h: { id: number }) => h.id === hand.body.handover_id);
  assert(waiting?.tickets?.length === 1 && waiting.tickets[0].order_number === 'T-5', 'incoming cashier sees the handed-over ticket list');
  const disputedOrderId = waiting.tickets[0].order_id;
  const receive = await request(app).post(`/api/cash-handover/handovers/${hand.body.handover_id}/receive`).set('Authorization', B)
    .send({ count: { method: 'manual', usd_cents: 9000, khr_riel: 400000 }, device: 'phone', disputed_orders: [{ order_id: disputedOrderId, reason: 'Table already paid' }] });
  assert(receive.status === 200, `incoming cashier B receives drawer (${receive.status} ${receive.body.error || ''})`);
  assert(receive.body.handover.status === 'flagged' && receive.body.handover.diff.usd_cents === -1000, 'declared $100 vs counted $90 → flagged −$10');
  assert(receive.body.session.opening_float_cents === 9000 + Math.round(40000000 / 4100), 'B opens with own counted float');
  const ticket = db.prepare(`SELECT status, accepted_by FROM ticket_handovers`).get() as any;
  assert(ticket.status === 'disputed' && ticket.accepted_by === 'cashier-b', 'ticket handover recorded as disputed by the incoming cashier');
  const disputedItem = db.prepare(`SELECT item_status, dispute_reason FROM ticket_handover_items WHERE order_id = ?`).get(disputedOrderId) as any;
  assert(disputedItem.item_status === 'disputed' && disputedItem.dispute_reason === 'Table already paid', 'disputed ticket keeps its reason');
  const again = await request(app).post(`/api/cash-handover/handovers/${hand.body.handover_id}/receive`).set('Authorization', B)
    .send({ count: { method: 'manual', usd_cents: 9000, khr_riel: 400000 } });
  assert(again.status === 409, 'handover cannot be received twice');

  // Phone: A counts the takings bag. USD balances, KHR is 10,000 short (more than $1).
  const takings = await request(app).post(`/api/cash-handover/sessions/${sessionId}/takings-count`).set('Authorization', A)
    .send({ count: { method: 'manual', usd_cents: 46300 - 9000, khr_riel: 741000 - 400000 - 10000 }, device: 'phone' });
  assert(takings.status === 200, `takings counted from phone (${takings.status} ${takings.body.error || ''})`);
  const rec = takings.body.reconciliation;
  assert(rec.variance.usd_cents === 0 && rec.variance.khr_riel === -10000, 'USD balanced, KHR −10,000 recorded separately');
  assert(rec.status === 'pending_review' && takings.body.needs_explanation === true, 'variance → pending review, explanation requested');
  assert(rec.envelope.usd_cents === 37300 && rec.float_retained.usd_cents === 9000, 'envelope = takings, float = verified count');
  const closed = db.prepare(`SELECT s.handover_state, c.period_end, c.counted_cash_cents FROM cash_sessions s JOIN cash_closures c ON c.id = s.closure_id WHERE s.id = ?`).get(sessionId) as any;
  assert(closed?.handover_state === 'counted' && closed.period_end === frozen.cutoff_at, 'legacy closure written for the cutoff window');

  const cashierAck = await request(app).post(`/api/cash-handover/reconciliations/${rec.id}/notes`).set('Authorization', A)
    .send({ kind: 'manager_acknowledgement', body: 'ok' });
  assert(cashierAck.status === 403, 'cashier cannot approve their own discrepancy');
  const explain = await request(app).post(`/api/cash-handover/reconciliations/${rec.id}/notes`).set('Authorization', A)
    .send({ kind: 'cashier_explanation', body: 'Gave 10,000៛ too much change at table 7' });
  assert(explain.status === 200, 'cashier adds explanation');
  const ack = await request(app).post(`/api/cash-handover/reconciliations/${rec.id}/notes`).set('Authorization', M)
    .send({ kind: 'manager_acknowledgement', body: 'Checked with table 7, accepted' });
  assert(ack.status === 200 && ack.body.reconciliation.status === 'resolved', 'logged-in manager resolves without a second PIN');
  assert(ack.body.reconciliation.variance.khr_riel === -10000, 'acknowledgement does not erase the variance');
  assert(ack.body.notes.length >= 2, 'notes are kept (append-only)');

  console.log('Section 4: evidence uploads');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const up = await request(app).post('/api/cash-handover/media').set('Authorization', A).set('Idempotency-Key', 'env-1')
    .send({ kind: 'envelope', data: png, session_id: sessionId });
  assert(up.status === 200 && up.body.media?.id, 'envelope photo stored');
  const upAgain = await request(app).post('/api/cash-handover/media').set('Authorization', A).set('Idempotency-Key', 'env-1')
    .send({ kind: 'envelope', data: png, session_id: sessionId });
  assert(upAgain.body.duplicate === true && upAgain.body.media.id === up.body.media.id, 'retry with same key does not duplicate');
  const stored = db.prepare(`SELECT file_path FROM media_uploads WHERE id = ?`).get(up.body.media.id) as { file_path: string };
  assert(fs.existsSync(stored.file_path) && stored.file_path.startsWith(testDir), 'original photo saved on the data volume');
  const env = await request(app).post(`/api/cash-handover/sessions/${sessionId}/envelope`).set('Authorization', A)
    .send({ usd_cents: 37300, khr_riel: 340000, media_id: up.body.media.id });
  assert(env.status === 200, 'envelope recorded with photo');
  const { buildShiftReport } = require('../main/services/telegram-reports');
  const report = buildShiftReport(db, sessionId, 'close');
  assert(report.html.includes('CASH DIFFERENCE') && report.html.includes('Diff KHR'), 'Telegram closing report shows per-currency difference');
  assert(report.html.includes('Gave 10,000') && report.html.includes('manager acknowledgement'), 'Telegram report includes cashier and manager notes');
  assert(report.attachments.length === 1 && report.attachments[0].contentType === 'image/png', 'Telegram report attaches the envelope photo');
  assert(report.html.includes('Handover:') && report.html.includes('Dara'), 'Telegram report names the incoming cashier');
  const bad = await request(app).post('/api/cash-handover/media').set('Authorization', A).send({ kind: 'envelope', data: 'data:text/plain;base64,aGk=' });
  assert(bad.status === 400, 'non-image upload rejected');

  console.log('Section 5: quiet close with float retained');
  const sessionB = receive.body.session.id;
  db.prepare(`UPDATE bills SET payment_status = 'paid', balance = 0, paid_at = ? WHERE payment_status = 'unpaid'`).run(now());
  const quiet = await request(app).post(`/api/cash-handover/sessions/${sessionB}/closing-count`).set('Authorization', B)
    .send({ count: { method: 'manual', usd_cents: 9000, khr_riel: 400000 }, float_retained: { usd_cents: 9000, khr_riel: 400000 } });
  assert(quiet.status === 200 && quiet.body.reconciliation.status === 'balanced', 'B closes balanced (blind count)');
  assert(quiet.body.reconciliation.envelope.usd_cents === 0, 'envelope = counted − float retained');
  const legacy = await request(app).post('/api/cash-sessions/open').set('Authorization', A).send({ opening_float_cents: 5000 });
  assert(legacy.status === 200, 'classic open endpoint still works');

  console.log('Section 5b: simple close — float out, count, cash spent, result');
  const simpleStatus = await request(app).get('/api/cash-handover/status').set('Authorization', A);
  const s7 = simpleStatus.body.open_session;
  assert(s7?.opening_float?.usd_cents === 5000 && s7.opening_float.khr_riel === 0, 'status gives the opening float for the "float out" default');
  addBill([{ method: 'cash', amount: 20, cash_session_id: s7.id, cash_usd_in: 20, cash_khr_in: 0, change_usd_out: 0, change_khr_out: 0, timestamp: now() }]);
  addBill([{ method: 'cash', amount: 10, cash_session_id: s7.id, cash_usd_in: 0, cash_khr_in: 41000, change_usd_out: 0, change_khr_out: 0, timestamp: now() }]);
  addBill([{ method: 'custom', payment_method_id: 1, amount: 12, cash_session_id: s7.id, timestamp: now() }]);
  const spentUrl = `/api/cash-handover/sessions/${s7.id}/cash-spent`;
  const ice = await request(app).post(spentUrl).set('Authorization', A).send({ currency: 'USD', amount_minor: 300, what: 'Ice' });
  assert(ice.status === 201 && ice.body.item.amount_cents === 300 && ice.body.item.reason === 'Ice', 'cash spent in USD recorded');
  const receiptMedia = await request(app).post('/api/cash-handover/media').set('Authorization', A)
    .send({ kind: 'purchase_receipt', data: 'data:image/png;base64,iVBORw0KGgo=', session_id: s7.id });
  const veg = await request(app).post(spentUrl).set('Authorization', A).send({ currency: 'KHR', amount_minor: 8200, what: 'Vegetables', media_id: receiptMedia.body.media?.id });
  assert(veg.status === 201 && veg.body.item.amount_khr_riel === 8200 && veg.body.item.media_id === receiptMedia.body.media?.id, 'cash spent in KHR recorded with receipt photo');
  const noWhat = await request(app).post(spentUrl).set('Authorization', A).send({ currency: 'USD', amount_minor: 100, what: ' ' });
  assert(noWhat.status === 400, 'cash spent needs "what for"');
  const notMine = await request(app).post(spentUrl).set('Authorization', B).send({ currency: 'USD', amount_minor: 100, what: 'Gas' });
  assert(notMine.status === 403, 'another cashier cannot add cash spent to A\'s shift');
  const junk = await request(app).post(spentUrl).set('Authorization', A).send({ currency: 'USD', amount_minor: 999, what: 'Typo' });
  const removed = await request(app).delete(`${spentUrl}/${junk.body.item.id}`).set('Authorization', A);
  const listed = await request(app).get(spentUrl).set('Authorization', A);
  assert(removed.status === 200 && listed.body.items.length === 2, 'a mistaken item can be removed before closing');

  const previewUrl = `/api/cash-handover/sessions/${s7.id}/close-preview`;
  const floatOut = { usd_cents: 5000, khr_riel: 0 };
  const exact = await request(app).post(previewUrl).set('Authorization', A)
    .send({ count: { method: 'manual', usd_cents: 1700, khr_riel: 32800 }, float_out: floatOut });
  assert(exact.status === 200, `preview ok (${exact.status} ${exact.body.error || ''})`);
  assert(exact.body.should_have_usd_cents === 7500 && exact.body.counted_usd_cents === 7500, 'should have = float + cash sales − cash spent; counted includes float');
  assert(exact.body.cash_sales_usd_cents === 3000 && exact.body.cash_spent_usd_cents === 500, 'cash sales $30, cash spent $5 (riel converted)');
  assert(exact.body.matches === true && exact.body.difference_usd_cents === 0, 'exact count matches');
  assert(exact.body.non_cash_payments.length === 1 && exact.body.non_cash_payments[0].total_cents === 1200, 'non-cash total shown for checking against the bank app');
  const near = await request(app).post(previewUrl).set('Authorization', A)
    .send({ count: { method: 'manual', usd_cents: 1650, khr_riel: 32800 }, float_out: floatOut });
  assert(near.body.matches === true && near.body.difference_usd_cents === -50, '50¢ short still counts as a match (±$1)');
  const short = await request(app).post(previewUrl).set('Authorization', A)
    .send({ count: { method: 'manual', usd_cents: 1500, khr_riel: 32800 }, float_out: floatOut });
  assert(short.body.matches === false && short.body.difference_usd_cents === -200, '$2 short does not match');
  const stillOpen = db.prepare(`SELECT status FROM cash_sessions WHERE id = ?`).get(s7.id) as { status: string };
  assert(stillOpen.status === 'open', 'preview saves nothing, so the cashier can recount');

  const simpleClose = await request(app).post(`/api/cash-handover/sessions/${s7.id}/closing-count`).set('Authorization', A)
    .send({ count: { method: 'manual', usd_cents: 1650, khr_riel: 32800 }, float_out: floatOut, device: 'pos' });
  assert(simpleClose.status === 200 && simpleClose.body.reconciliation.status === 'balanced', 'close within ±$1 is recorded as matching');
  assert(simpleClose.body.reconciliation.actual.usd_cents === 6650 && simpleClose.body.reconciliation.float_retained.usd_cents === 5000,
    'closing count = takings + float out; float out is kept as the float');
  const closedS7 = db.prepare(`SELECT status FROM cash_sessions WHERE id = ?`).get(s7.id) as { status: string };
  assert(closedS7.status === 'closed', 'Close register closes the shift');
  const simpleReport = buildShiftReport(db, s7.id, 'close');
  assert(simpleReport.html.includes('Vegetables') && simpleReport.html.includes('Cash matches') && !simpleReport.html.includes('Envelope photo missing'),
    'Telegram close report lists cash spent and does not demand an envelope photo');

  console.log('Section 6: payment USD/KHR split validation');
  db.prepare(`UPDATE settings SET value = '4100' WHERE key = 'usd_khr_exchange_rate'`).run();
  const { cashSplitFields } = require('../main/routes/bills');
  const ok = cashSplitFields({ cash_usd_in: 20, cash_khr_in: 41000, change_usd_out: 3, change_khr_out: 2000 }, true, 30, 3.49);
  assert(ok.cash_khr_in === 41000 && ok.change_usd_out === 3, 'consistent split is stored on the cash line');
  assert(Object.keys(cashSplitFields({ cash_usd_in: 5 }, false, 5, 0)).length === 0, 'split ignored on non-cash lines');
  let mismatch = false;
  try { cashSplitFields({ cash_usd_in: 20, cash_khr_in: 0, change_usd_out: 0, change_khr_out: 0 }, true, 30, 0); } catch { mismatch = true; }
  assert(mismatch, 'split that does not match the tender is rejected');

  console.log('='.repeat(50));
  console.log(`Passed ${passed}/${passed + failed}, failed ${failed}`);
  fs.rmSync(testDir, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
