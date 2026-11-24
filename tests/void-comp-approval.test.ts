/**
 * Voids and comps with approval: strict removal setting, manager PIN, Telegram-approved
 * requests, the entertainer allowance, and the report section listing them.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/void-comp-approval.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-void-comp-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-void-comp';
delete process.env.TELEGRAM_BOT_TOKEN;

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { initTestDb, createApp, startServer, api, assertOrThrow, assertEqualOrThrow, closeDatabase, now } = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes, resetPinRateLimitForTests } = require('../main/routes/orders');
const { registerRoutes } = require('../main/routes/index');
const approvals = require('../main/services/item-approvals');
const telegram = require('../main/services/telegram');

function seedUser(db: any, id: string, role: string, pin?: string) {
  const email = `${id}@test.local`;
  db.prepare(`INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(id, id, email, bcrypt.hashSync('pw', 4), role, pin ? bcrypt.hashSync(pin, 4) : null, now(), now());
  return { Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}` };
}

let seq = 0;
function seedOrder(db: any, itemStatus: string, qty = 1, price = 4) {
  seq += 1;
  db.prepare(`INSERT INTO orders (order_number, type, status, subtotal, tax_amount, total, created_at, updated_at) VALUES (?, 'dine_in', 'pending', ?, 0, ?, ?, ?)`)
    .run(`VC-${seq}`, price * qty + 3, price * qty + 3, now(), now());
  const orderId = (db.prepare('SELECT id FROM orders WHERE order_number = ?').get(`VC-${seq}`) as any).id;
  const add = (name: string, q: number, p: number, status: string) => Number(db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, tax_amount, total, status, created_at, updated_at)
    VALUES (?, 'p-beer', ?, ?, ?, ?, 0, ?, ?, ?, ?)`).run(orderId, name, p, q, p * q, p * q, status, now(), now()).lastInsertRowid);
  const itemId = add('Angkor Beer', qty, price, itemStatus);
  add('Water', 1, 3, 'served');
  return { orderId, itemId };
}

async function main() {
  console.log('Voids and comps with approval');
  console.log('='.repeat(50));
  resetPinRateLimitForTests();
  const db = initTestDb();
  db.prepare(`INSERT INTO categories (id, name, sort_order) VALUES ('c-bar', 'Bar', 1)`).run();
  db.prepare(`INSERT INTO products (id, category_id, name, price, tax_type, is_active, sort_order, created_at, updated_at) VALUES ('p-beer', 'c-bar', 'Angkor Beer', 4, 'none', 1, 1, ?, ?)`).run(now(), now());
  seedUser(db, 'mgr', 'manager', '1234');
  const owner = seedUser(db, 'own', 'owner', '5678');
  const cashier = seedUser(db, 'csh', 'cashier', '9999');
  const app = createApp({ '/api/orders': orderRoutes });
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);
  const call = (p: string, method: string, body: any, headers: any) => api(baseUrl, p, { method, body, headers });
  const item = (id: number) => db.prepare('SELECT * FROM order_items WHERE id = ?').get(id) as any;
  const orderTotal = (id: number) => Number((db.prepare('SELECT total FROM orders WHERE id = ?').get(id) as any).total);

  try {
    console.log('Section 1: setting off keeps the old rules');
    {
      const o = seedOrder(db, 'pending');
      const r = await call(`/api/orders/${o.orderId}/items/${o.itemId}/cancel`, 'PATCH', {}, owner);
      assertEqualOrThrow(r.status, 200, 'owner removes a pending item without PIN when the setting is off');
    }

    console.log('Section 2: strict removal');
    const set = await call('/api/settings/item-control', 'PUT', { item_removal_requires_approval: true, entertainer_comp_allowance: 2 }, owner);
    assertEqualOrThrow(set.status, 200, `owner turns on strict removal (${set.data?.error || ''})`);
    {
      const o = seedOrder(db, 'pending');
      const noReason = await call(`/api/orders/${o.orderId}/items/${o.itemId}/cancel`, 'PATCH', {}, owner);
      assertEqualOrThrow(noReason.status, 400, 'a reason is required');
      const noPin = await call(`/api/orders/${o.orderId}/items/${o.itemId}/cancel`, 'PATCH', { reason: 'wrong_item' }, owner);
      assertEqualOrThrow(noPin.status, 403, 'even the owner account needs a manager PIN or approval');
      assertOrThrow(noPin.data?.approvalRequired === true, 'response says approval is required');
      const ownPin = await call(`/api/orders/${o.orderId}/items/${o.itemId}/cancel`, 'PATCH', { reason: 'wrong_item', override_pin: '9999' }, cashier);
      assertEqualOrThrow(ownPin.status, 403, "a cashier's PIN cannot approve");
      const ok = await call(`/api/orders/${o.orderId}/items/${o.itemId}/cancel`, 'PATCH', { reason: 'wrong_item', note: 'meant water', override_pin: '1234' }, cashier);
      assertEqualOrThrow(ok.status, 200, `cashier removes it with a manager PIN (${ok.data?.error || ''})`);
      assertEqualOrThrow(item(o.itemId).status, 'cancelled', 'pending item is cancelled (not made)');
      const audit = JSON.parse((db.prepare(`SELECT details_json FROM order_audit_log WHERE order_item_id = ? AND action = 'item_cancelled'`).get(o.itemId) as any).details_json);
      assertOrThrow(audit.approved_by === 'mgr' && audit.reason === 'wrong_item' && audit.approval_channel === 'pin' && audit.note === 'meant water', 'audit records approver, channel, reason and note');
    }
    {
      const o = seedOrder(db, 'served');
      const r = await call(`/api/orders/${o.orderId}/items/${o.itemId}/cancel`, 'PATCH', { reason: 'customer_left', override_pin: '1234' }, cashier);
      assertEqualOrThrow(r.status, 200, 'served item can be removed with approval');
      assertEqualOrThrow(item(o.itemId).status, 'voided', 'a served item is voided (it was made), not cancelled');
    }

    console.log('Section 3: comps');
    {
      const o = seedOrder(db, 'served', 1, 4);
      const before = orderTotal(o.orderId);
      const bad = await call(`/api/orders/${o.orderId}/items/${o.itemId}/comp`, 'PATCH', { reason: 'nope' }, cashier);
      assertEqualOrThrow(bad.status, 400, 'unknown comp reason rejected');
      const noApproval = await call(`/api/orders/${o.orderId}/items/${o.itemId}/comp`, 'PATCH', { reason: 'complaint' }, cashier);
      assertEqualOrThrow(noApproval.status, 403, 'comp needs approval');
      const ok = await call(`/api/orders/${o.orderId}/items/${o.itemId}/comp`, 'PATCH', { reason: 'complaint', override_pin: '1234' }, cashier);
      assertEqualOrThrow(ok.status, 200, `comp with manager PIN (${ok.data?.error || ''})`);
      const it = item(o.itemId);
      assertOrThrow(Number(it.total) === 0 && it.status === 'served', 'comped item stays on the order at $0');
      assertOrThrow(it.comp_reason === 'complaint' && it.comped_by === 'csh' && it.comp_approved_by === 'mgr', 'comp records reason, who asked and who approved');
      assertEqualOrThrow(orderTotal(o.orderId), before - 4, 'order total drops by the comped item');
      const again = await call(`/api/orders/${o.orderId}/items/${o.itemId}/comp`, 'PATCH', { reason: 'complaint', override_pin: '1234' }, cashier);
      assertEqualOrThrow(again.status, 409, 'cannot comp twice');
    }

    console.log('Section 4: entertainer allowance (2 a night)');
    {
      const a = seedOrder(db, 'served', 1);
      const b = seedOrder(db, 'served', 1);
      const c = seedOrder(db, 'served', 1);
      const r1 = await call(`/api/orders/${a.orderId}/items/${a.itemId}/comp`, 'PATCH', { reason: 'entertainer' }, cashier);
      const r2 = await call(`/api/orders/${b.orderId}/items/${b.itemId}/comp`, 'PATCH', { reason: 'entertainer' }, cashier);
      assertOrThrow(r1.status === 200 && r2.status === 200, 'two entertainer drinks go through without approval');
      const r3 = await call(`/api/orders/${c.orderId}/items/${c.itemId}/comp`, 'PATCH', { reason: 'entertainer' }, cashier);
      assertEqualOrThrow(r3.status, 403, 'the third needs a manager');
      const audit = JSON.parse((db.prepare(`SELECT details_json FROM order_audit_log WHERE order_item_id = ? AND action = 'item_comped'`).get(a.itemId) as any).details_json);
      assertEqualOrThrow(audit.approval_channel, 'allowance', 'allowance comps are marked as such');
    }

    console.log('Section 5: Telegram-approved request');
    {
      const o = seedOrder(db, 'preparing');
      db.prepare(`INSERT INTO telegram_recipients (chat_id, display_name, reports, is_active, approver_user_id, created_at, updated_at) VALUES ('555', 'Bobo', '[]', 1, 'mgr', ?, ?)`).run(now(), now());
      db.prepare(`INSERT INTO telegram_recipients (chat_id, display_name, reports, is_active, created_at, updated_at) VALUES ('777', 'Not approver', '[]', 1, ?, ?)`).run(now(), now());
      const req = approvals.createRequest(db, { orderId: o.orderId, itemId: o.itemId, action: 'void', reason: 'wrong_item', requestedBy: 'csh' });
      const early = await call(`/api/orders/${o.orderId}/items/${o.itemId}/cancel`, 'PATCH', { reason: 'wrong_item', approval_request_id: req.id }, cashier);
      assertEqualOrThrow(early.status, 403, 'cannot use a request that is still pending');
      const stranger = await telegram.handleUpdate({ update_id: 1, callback_query: { id: 'q1', data: `ap:${req.id}:y`, message: { message_id: 9, chat: { id: '777' } } } }, db);
      assertEqualOrThrow(stranger, 'rejected', 'a recipient not linked as approver cannot approve');
      const done = await telegram.handleUpdate({ update_id: 2, callback_query: { id: 'q2', data: `ap:${req.id}:y`, message: { message_id: 9, chat: { id: '555' } } } }, db);
      assertEqualOrThrow(done, 'linked', 'linked manager approves from Telegram');
      const status = await call(`/api/item-approvals/${req.id}`, 'GET', undefined, cashier);
      assertOrThrow(status.data.status === 'approved' && status.data.decidedBy === 'mgr', 'till sees the approval and who gave it');
      const used = await call(`/api/orders/${o.orderId}/items/${o.itemId}/cancel`, 'PATCH', { reason: 'wrong_item', approval_request_id: req.id }, cashier);
      assertEqualOrThrow(used.status, 200, `approved request removes the item (${used.data?.error || ''})`);
      assertEqualOrThrow(item(o.itemId).status, 'voided', 'preparing item is voided');
      const o2 = seedOrder(db, 'preparing');
      const reuse = await call(`/api/orders/${o2.orderId}/items/${o2.itemId}/cancel`, 'PATCH', { reason: 'wrong_item', approval_request_id: req.id }, cashier);
      assertEqualOrThrow(reuse.status, 400, 'an approval cannot be reused on another item');
      const rej = approvals.createRequest(db, { orderId: o2.orderId, itemId: o2.itemId, action: 'comp', reason: 'complaint', requestedBy: 'csh' });
      await telegram.handleUpdate({ update_id: 3, callback_query: { id: 'q3', data: `ap:${rej.id}:n`, message: { message_id: 10, chat: { id: '555' } } } }, db);
      const after = await call(`/api/orders/${o2.orderId}/items/${o2.itemId}/comp`, 'PATCH', { reason: 'complaint', approval_request_id: rej.id }, cashier);
      assertEqualOrThrow(after.status, 403, 'a rejected request cannot be used');
    }

    console.log('Section 6: report lists voids, comps and removed items');
    {
      const { buildDailyReport } = require('../main/services/shift-report');
      const { renderDailyReport } = require('../shared/print/shift-report-text');
      const tz = 'UTC';
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('timezone', 'UTC', ?) ON CONFLICT(key) DO UPDATE SET value = 'UTC'`).run(now());
      const today = new Date().toISOString().slice(0, 10);
      const day = buildDailyReport(today);
      const kinds = day.adjustments.map((a: any) => a.kind);
      assertOrThrow(kinds.includes('void') && kinds.includes('comp') && kinds.includes('removed'), `report has voids, comps and removed items (${kinds.join(',')})`);
      const comp = day.adjustments.find((a: any) => a.kind === 'comp' && a.reason === 'complaint');
      assertOrThrow(comp && comp.approvedBy === 'mgr' && comp.requestedBy === 'csh' && comp.amountCents === 400, 'comp line shows amount, who asked and who approved');
      const text = renderDailyReport(day, 42, tz).join('\n');
      assertOrThrow(text.includes('VOIDS, COMPS') && text.includes('Entertainer'), 'printed report has the section and entertainer drinks');
    }
    console.log('Section 7: quick change, item notes, moving items');
    {
      const o = seedOrder(db, 'pending');
      const r = await call(`/api/orders/${o.orderId}/items/${o.itemId}/cancel`, 'PATCH', { reason: 'customer_changed_mind', changing: true }, cashier);
      assertEqualOrThrow(r.status, 200, `a fresh item can be swapped without a PIN (${r.data?.error || ''})`);
      const audit = JSON.parse((db.prepare(`SELECT details_json FROM order_audit_log WHERE order_item_id = ? AND action = 'item_cancelled'`).get(o.itemId) as any).details_json);
      assertEqualOrThrow(audit.approval_channel, 'change_window', 'quick change is recorded as such');
      const old = seedOrder(db, 'pending');
      db.prepare(`UPDATE order_items SET created_at = ? WHERE id = ?`).run(new Date(Date.now() - 6 * 60_000).toISOString(), old.itemId);
      const late = await call(`/api/orders/${old.orderId}/items/${old.itemId}/cancel`, 'PATCH', { reason: 'customer_changed_mind', changing: true }, cashier);
      assertEqualOrThrow(late.status, 403, 'after 5 minutes a change needs a manager PIN');
      const noFlag = seedOrder(db, 'pending');
      const plain = await call(`/api/orders/${noFlag.orderId}/items/${noFlag.itemId}/cancel`, 'PATCH', { reason: 'wrong_item' }, cashier);
      assertEqualOrThrow(plain.status, 403, 'a plain removal still needs a manager PIN');
      assertOrThrow(approvals.withinChangeWindow(new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19)), 'SQLite-style timestamps are read as UTC');
    }
    {
      const o = seedOrder(db, 'pending');
      const n = await call(`/api/orders/${o.orderId}/items/${o.itemId}/note`, 'PATCH', { note: '  no ice  ' }, cashier);
      assertEqualOrThrow(n.status, 200, `cashier changes a note (${n.data?.error || ''})`);
      assertEqualOrThrow(item(o.itemId).special_instructions, 'no ice', 'note is saved trimmed');
      const audit = db.prepare(`SELECT 1 FROM order_audit_log WHERE order_item_id = ? AND action = 'item_note_changed'`).get(o.itemId);
      assertOrThrow(!!audit, 'note change is audited');
      const bad = await call(`/api/orders/${o.orderId}/items/${o.itemId}/note`, 'PATCH', { note: 5 }, cashier);
      assertEqualOrThrow(bad.status, 400, 'non-text note rejected');
    }
    {
      db.prepare(`INSERT INTO tables (id, number, capacity, status, created_at, updated_at) VALUES ('t-a', 'A1', 2, 'occupied', ?, ?), ('t-b', 'B1', 2, 'available', ?, ?), ('t-c', 'C1', 2, 'available', ?, ?)`).run(now(), now(), now(), now(), now(), now());
      const o = seedOrder(db, 'pending', 2, 4);
      db.prepare(`UPDATE orders SET table_id = 't-a' WHERE id = ?`).run(o.orderId);
      const waterId = (db.prepare(`SELECT id FROM order_items WHERE order_id = ? AND product_name = 'Water'`).get(o.orderId) as any).id;
      const moved = await call(`/api/orders/${o.orderId}/move-items`, 'POST', { item_ids: [o.itemId], target_table_id: 't-b' }, cashier);
      assertEqualOrThrow(moved.status, 200, `cashier moves one item to a free table (${moved.data?.error || ''})`);
      const newOrder = moved.data.targetOrderId;
      assertEqualOrThrow(Number(item(o.itemId).order_id), Number(newOrder), 'item now belongs to the new table order');
      assertEqualOrThrow(orderTotal(newOrder), 8, 'new table order totals the moved item');
      assertEqualOrThrow(orderTotal(o.orderId), 3, 'old table keeps only the rest');
      assertEqualOrThrow((db.prepare(`SELECT status FROM tables WHERE id = 't-b'`).get() as any).status, 'occupied', 'target table is now occupied');
      const back = await call(`/api/orders/${o.orderId}/move-items`, 'POST', { item_ids: [waterId], target_table_id: 't-b' }, cashier);
      assertEqualOrThrow(back.status, 200, 'moving the last item onto a busy table works');
      assertEqualOrThrow(Number(back.data.targetOrderId), Number(newOrder), 'items join the open order on that table');
      assertEqualOrThrow(orderTotal(newOrder), 11, 'busy table total includes both items');
      const src = db.prepare('SELECT status FROM orders WHERE id = ?').get(o.orderId) as any;
      assertEqualOrThrow(src.status, 'cancelled', 'emptied order is closed');
      assertEqualOrThrow((db.prepare(`SELECT status FROM tables WHERE id = 't-a'`).get() as any).status, 'available', 'emptied table is freed');
      const same = await call(`/api/orders/${newOrder}/move-items`, 'POST', { item_ids: [waterId], target_table_id: 't-b' }, cashier);
      assertEqualOrThrow(same.status, 400, 'cannot move to the same table');
      db.prepare(`INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, balance, payment_status, paid_amount, created_at, updated_at) VALUES ('MV-1', ?, 11, 0, 11, 5, 'partial', 6, ?, ?)`).run(newOrder, now(), now());
      const paid = await call(`/api/orders/${newOrder}/move-items`, 'POST', { item_ids: [waterId], target_table_id: 't-c' }, cashier);
      assertEqualOrThrow(paid.status, 409, 'cannot move items once payment has started');
      const audit = db.prepare(`SELECT 1 FROM order_audit_log WHERE order_id = ? AND action = 'items_moved_in'`).get(newOrder);
      assertOrThrow(!!audit, 'moves are audited');
    }

    console.log('='.repeat(50));
    console.log('All void/comp checks passed');
  } finally {
    server.close();
    closeDatabase();
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
