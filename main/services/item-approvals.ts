import { pinClientKey } from '../middleware/security';
import type { Request } from 'express';
import { getDatabase, getSettingValue, now, verifyPin } from '../db';
import { hasPermission } from './authorization';
import { ROLE_ACCESS, hasRole } from '../../shared/role-permissions';

type Db = ReturnType<typeof getDatabase>;
export type ItemAction = 'void' | 'comp';

export const COMP_REASONS = ['entertainer', 'event', 'event_person', 'owner_comp', 'complaint', 'wrong_item', 'staff_meal', 'friends_owner', 'too_slow', 'other'] as const;
export const VOID_REASONS = ['wrong_item', 'customer_changed_mind', 'customer_left', 'duplicate', 'too_slow', 'other'] as const;
export const REASON_LABELS: Record<string, string> = {
  entertainer: 'Entertainer / band drink', event: 'Event (included free)', event_person: 'Event person drinks', owner_comp: 'Owner (free)', complaint: 'Customer complaint', wrong_item: 'Wrong item', staff_meal: 'Staff meal',
  friends_owner: 'Friends / owner', too_slow: 'Took too long', customer_changed_mind: 'Customer changed mind',
  customer_left: 'Customer left', duplicate: 'Rung in twice', other: 'Other',
};
const REQUEST_TTL_MINUTES = 30;
export const CHANGE_WINDOW_MINUTES = 5;

/** A sent item swapped for another within a few minutes of being sent needs no manager approval. */
export function withinChangeWindow(createdAt: string | null | undefined, nowMs = Date.now()): boolean {
  if (!createdAt) return false;
  const iso = createdAt.includes('T') ? createdAt : `${createdAt.replace(' ', 'T')}Z`;
  const sentMs = Date.parse(iso);
  return Number.isFinite(sentMs) && nowMs - sentMs >= 0 && nowMs - sentMs <= CHANGE_WINDOW_MINUTES * 60_000;
}

export interface Approval { approvedBy: string; channel: 'pin' | 'telegram' | 'allowance' | 'change_window'; requestId?: number }

const httpError = (statusCode: number, message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { statusCode, ...extra });

/** Item removal after sending needs approval only when the tenant turns it on (BackStreet does). */
export function removalRequiresApproval(): boolean {
  return getSettingValue('item_removal_requires_approval') === 'true';
}

export function entertainerAllowance(): number {
  const n = Number(getSettingValue('entertainer_comp_allowance') || 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function permissionFor(action: ItemAction): 'orders.discount.apply' | 'orders.item.void' {
  return action === 'comp' ? 'orders.discount.apply' : 'orders.item.void';
}

export function isApprover(db: Db, userId: string | null | undefined, action: ItemAction): boolean {
  if (!userId) return false;
  const user = db.prepare('SELECT id, role FROM users WHERE id = ? AND is_active = 1').get(userId) as { id: string; role: string } | undefined;
  return !!user && hasRole(user.role, ROLE_ACCESS.ownerManager) && hasPermission(user.id, permissionFor(action));
}

export function approverByPin(db: Db, req: Request, pin: string, action: ItemAction): string {
  const clientIp = pinClientKey(req);
  const { checkPinRateLimit, clearPinAttempts } = require('../routes/orders') as typeof import('../routes/orders');
  const limitKey = `pin:${clientIp}:item-${action}`;
  if (!checkPinRateLimit(limitKey)) throw httpError(429, 'Too many PIN attempts. Try again in 15 minutes.');
  const managers = db.prepare('SELECT id, role, pin_hash FROM users WHERE pin_hash IS NOT NULL AND is_active = 1').all() as { id: string; role: string; pin_hash: string }[];
  const match = managers.find((u) => isApprover(db, u.id, action) && verifyPin(u.pin_hash, pin));
  if (!match) throw httpError(403, 'Invalid manager PIN');
  clearPinAttempts(limitKey);
  return match.id;
}

/** Comps given today for entertainers (business day), for the nightly allowance. */
export function entertainerCompsToday(db: Db): number {
  const { dayBoundsInTimezone, tenantBusinessDayStartTime } = require('../db') as typeof import('../db');
  const { tenantTimezone } = require('../routes/cash-closures') as typeof import('../routes/cash-closures');
  const tz = tenantTimezone();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const [start, end] = dayBoundsInTimezone(today, tz, tenantBusinessDayStartTime(db));
  const row = db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS n FROM order_items WHERE comp_reason = 'entertainer' AND comped_at >= ? AND comped_at < ?`).get(start, end) as { n: number };
  return Number(row.n || 0);
}

/**
 * Resolves who approved a void or comp: a manager PIN typed at the till, a request a manager
 * approved on Telegram (consumed here), or the entertainer allowance for comps.
 */
export function resolveApproval(db: Db, req: Request, input: {
  orderId: number; itemId: number; action: ItemAction; reason?: string; quantity?: number;
  overridePin?: unknown; approvalRequestId?: unknown;
}): Approval {
  if (typeof input.overridePin === 'string' && input.overridePin) {
    return { approvedBy: approverByPin(db, req, input.overridePin, input.action), channel: 'pin' };
  }
  const requestId = Number(input.approvalRequestId);
  if (Number.isInteger(requestId) && requestId > 0) {
    const row = db.prepare(`SELECT * FROM item_approval_requests WHERE id = ?`).get(requestId) as ApprovalRequestRow | undefined;
    if (!row || row.order_item_id !== input.itemId || row.order_id !== input.orderId || row.action !== input.action) throw httpError(400, 'Approval does not match this item');
    if (row.status !== 'approved' || !row.decided_by) throw httpError(403, row.status === 'pending' ? 'Still waiting for a manager to approve' : `Request was ${row.status}`);
    const used = db.prepare(`UPDATE item_approval_requests SET status = 'used', updated_at = ? WHERE id = ? AND status = 'approved'`).run(now(), requestId);
    if (!used.changes) throw httpError(409, 'Approval already used');
    return { approvedBy: row.decided_by, channel: 'telegram', requestId };
  }
  if (input.action === 'comp' && input.reason === 'entertainer') {
    const allowance = entertainerAllowance();
    if (allowance > 0 && entertainerCompsToday(db) + (input.quantity ?? 1) <= allowance) {
      return { approvedBy: String((req as any).user?.userId), channel: 'allowance' };
    }
  }
  throw httpError(403, 'Manager approval required', { approvalRequired: true });
}

export interface ApprovalRequestRow {
  id: number; order_id: number; order_item_id: number; action: ItemAction; reason: string; note: string | null;
  requested_by: string; status: string; decided_by: string | null; decided_at: string | null; telegram_messages: string;
  created_at: string; updated_at: string;
}

export function expireOldRequests(db: Db): void {
  const cutoff = new Date(Date.now() - REQUEST_TTL_MINUTES * 60_000).toISOString().replace('T', ' ').replace(/\..*$/, '');
  db.prepare(`UPDATE item_approval_requests SET status = 'expired', updated_at = ? WHERE status IN ('pending', 'approved') AND created_at < ?`).run(now(), cutoff);
}

export function getRequest(db: Db, id: number): ApprovalRequestRow | undefined {
  expireOldRequests(db);
  return db.prepare(`SELECT * FROM item_approval_requests WHERE id = ?`).get(id) as ApprovalRequestRow | undefined;
}

export function createRequest(db: Db, input: { orderId: number; itemId: number; action: ItemAction; reason: string; note?: string | null; requestedBy: string }): ApprovalRequestRow {
  const item = db.prepare(`SELECT oi.id, oi.status FROM order_items oi WHERE oi.id = ? AND oi.order_id = ?`).get(input.itemId, input.orderId) as { id: number; status: string } | undefined;
  if (!item) throw httpError(404, 'Item not found in this order');
  if (['cancelled', 'voided', 'void_adjustment', 'refunded'].includes(item.status)) throw httpError(400, 'Item is already removed');
  const at = now();
  db.prepare(`UPDATE item_approval_requests SET status = 'cancelled', updated_at = ? WHERE order_item_id = ? AND status = 'pending'`).run(at, input.itemId);
  const id = Number(db.prepare(`
    INSERT INTO item_approval_requests (order_id, order_item_id, action, reason, note, requested_by, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(input.orderId, input.itemId, input.action, input.reason, input.note ?? null, input.requestedBy, at, at).lastInsertRowid);
  return getRequest(db, id)!;
}

export function cancelRequest(db: Db, id: number): void {
  db.prepare(`UPDATE item_approval_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'`).run(now(), id);
}

/** Records a manager's decision; returns false when the request is no longer pending. */
export function decideRequest(db: Db, id: number, approverId: string, approve: boolean): { ok: boolean; row?: ApprovalRequestRow; reason?: string } {
  const row = getRequest(db, id);
  if (!row) return { ok: false, reason: 'not found' };
  if (row.status !== 'pending') return { ok: false, row, reason: `already ${row.status}` };
  if (!isApprover(db, approverId, row.action)) return { ok: false, row, reason: 'not allowed' };
  const changed = db.prepare(`UPDATE item_approval_requests SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
    .run(approve ? 'approved' : 'rejected', approverId, now(), now(), id);
  return { ok: changed.changes > 0, row: getRequest(db, id) };
}

/** Text for the manager's Telegram message. */
export function describeRequest(db: Db, row: ApprovalRequestRow): string {
  const info = db.prepare(`
    SELECT o.order_number, o.tab_name, o.type, t.number AS table_number, oi.product_name, oi.quantity, oi.total, u.name AS requester,
      (SELECT value FROM settings WHERE key = 'business_name') AS business
    FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN users u ON u.id = ?
    WHERE oi.id = ?
  `).get(row.requested_by, row.order_item_id) as {
    order_number: string; tab_name: string | null; type: string; table_number: string | null; product_name: string; quantity: number; total: number; requester: string | null; business: string | null;
  };
  const where = info.table_number ? `Table ${info.table_number}` : info.tab_name ? `Tab ${info.tab_name}` : info.type === 'takeaway' ? 'To Go' : 'Walk-in';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    `<b>${row.action === 'comp' ? '🎁 Comp' : '🚫 Void'} request — ${esc(info.business || 'POS')}</b>`,
    `${esc(where)} · ${esc(info.order_number)}`,
    `${info.quantity} × ${esc(info.product_name)} · <b>$${Number(info.total || 0).toFixed(2)}</b>`,
    `Reason: ${esc(REASON_LABELS[row.reason] || row.reason)}${row.note ? ` — ${esc(row.note)}` : ''}`,
    `Asked by: ${esc(info.requester || '—')}`,
  ].join('\n');
}
