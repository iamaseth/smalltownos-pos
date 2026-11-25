/**
 * Coupons: promotions a manager sets up in Settings, which the cashier picks at checkout
 * instead of typing a code. Stored as JSON in settings (like special prices), applied as the
 * bill's single discount with the reason "Coupon CODE · Name". One discount per bill.
 */
import { getDatabase, getSettingValue, upsertSettings } from '../db';

export const COUPONS_SETTING = 'coupons';
export const COUPON_REASON_PREFIX = 'Coupon ';
const MAX_COUPONS = 50;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[A-Z0-9-]{2,20}$/;

type Db = ReturnType<typeof getDatabase>;

export type CouponKind = 'percent_bill' | 'percent_category' | 'amount_bill';

export interface Coupon {
  id: string;
  code: string;
  name: string;
  kind: CouponKind;
  /** Percent (1-100) for percent kinds, money amount for amount_bill. */
  value: number;
  category_id: string | null;
  min_spend: number;
  start_date: string | null;
  end_date: string | null;
  /** 0 = Sunday … 6 = Saturday; empty means every day. */
  days: number[];
  start_time: string | null;
  end_time: string | null;
  enabled: boolean;
}

const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

export function readCoupons(): Coupon[] {
  try {
    const parsed = JSON.parse(getSettingValue(COUPONS_SETTING) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCoupons(coupons: Coupon[]): void {
  upsertSettings({ [COUPONS_SETTING]: JSON.stringify(coupons) });
}

/** Validates the list sent from Settings. */
export function normalizeCoupons(input: unknown, categoryExists: (id: string) => boolean): Coupon[] {
  if (!Array.isArray(input)) throw badRequest('Coupons must be a list');
  if (input.length > MAX_COUPONS) throw badRequest(`At most ${MAX_COUPONS} coupons`);
  const ids = new Set<string>();
  const codes = new Set<string>();
  return input.map((raw, index) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    const code = typeof c.code === 'string' ? c.code.trim().toUpperCase() : '';
    if (!CODE_RE.test(code)) throw badRequest(`Coupon ${index + 1}: the code must be 2-20 letters, numbers or dashes`);
    if (codes.has(code)) throw badRequest(`${code} is listed twice`);
    codes.add(code);
    const name = typeof c.name === 'string' ? c.name.trim().slice(0, 60) : '';
    if (!name) throw badRequest(`${code}: add a short description`);
    const id = typeof c.id === 'string' && /^[\w-]{1,40}$/.test(c.id) ? c.id : `cp-${Date.now().toString(36)}-${index}`;
    if (ids.has(id)) throw badRequest('Coupon ids must be unique');
    ids.add(id);
    const kind: CouponKind = c.kind === 'percent_category' || c.kind === 'amount_bill' ? c.kind : 'percent_bill';
    const value = Number(c.value);
    if (kind === 'amount_bill') {
      if (!Number.isFinite(value) || value <= 0 || value > 100000) throw badRequest(`${code}: enter the amount off`);
    } else if (!Number.isFinite(value) || value <= 0 || value > 100) {
      throw badRequest(`${code}: enter a percent between 1 and 100`);
    }
    const categoryId = kind === 'percent_category' && typeof c.category_id === 'string' ? c.category_id : null;
    if (kind === 'percent_category' && (!categoryId || !categoryExists(categoryId))) throw badRequest(`${code}: choose a category`);
    const minSpend = Number(c.min_spend ?? 0);
    if (!Number.isFinite(minSpend) || minSpend < 0 || minSpend > 100000) throw badRequest(`${code}: minimum spend is not valid`);
    const startDate = typeof c.start_date === 'string' && DATE_RE.test(c.start_date) ? c.start_date : null;
    const endDate = typeof c.end_date === 'string' && DATE_RE.test(c.end_date) ? c.end_date : null;
    if (startDate && endDate && endDate < startDate) throw badRequest(`${code}: the end date is before the start date`);
    const days = Array.isArray(c.days) ? [...new Set(c.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
    const startTime = typeof c.start_time === 'string' && TIME_RE.test(c.start_time) ? c.start_time : null;
    const endTime = typeof c.end_time === 'string' && TIME_RE.test(c.end_time) ? c.end_time : null;
    if ((startTime && !endTime) || (!startTime && endTime) || (startTime && startTime === endTime)) {
      throw badRequest(`${code}: set both a start and end time, or leave both empty`);
    }
    return {
      id, code, name, kind,
      value: Math.round(value * 100) / 100,
      category_id: categoryId,
      min_spend: Math.round(minSpend * 100) / 100,
      start_date: startDate, end_date: endDate, days,
      start_time: startTime, end_time: endTime,
      enabled: c.enabled !== false,
    };
  });
}

function localParts(at: Date, timeZone: string): { date: string; day: number; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, day, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** True when the coupon can be used at `at` (store time zone). Overnight hours run past midnight. */
export function isCouponLive(c: Coupon, at: Date, timeZone: string): boolean {
  if (!c.enabled) return false;
  const { date, day, minutes } = localParts(at, timeZone);
  if (c.start_date && date < c.start_date) return false;
  if (c.end_date && date > c.end_date) return false;
  if (c.start_time && c.end_time) {
    const start = toMinutes(c.start_time);
    const end = toMinutes(c.end_time);
    const inWindow = end > start ? minutes >= start && minutes < end : minutes >= start || minutes < end;
    if (!inWindow) return false;
    // For an overnight window after midnight, the day that counts is the day it started.
    const startedYesterday = end <= start && minutes < end;
    const effectiveDay = startedYesterday ? (day + 6) % 7 : day;
    return c.days.length === 0 || c.days.includes(effectiveDay);
  }
  return c.days.length === 0 || c.days.includes(day);
}

export function couponLabel(c: Coupon): string {
  if (c.kind === 'amount_bill') return `$${c.value.toFixed(2).replace(/\.00$/, '')} OFF`;
  return `${c.value}% OFF`;
}

export function isCouponReason(reason: unknown): boolean {
  return typeof reason === 'string' && reason.startsWith(COUPON_REASON_PREFIX);
}

function categoryTree(db: Db, rootId: string): Set<string> {
  const rows = db.prepare('SELECT id, parent_id FROM categories WHERE deleted_at IS NULL').all() as { id: string; parent_id: string | null }[];
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (r.parent_id && ids.has(r.parent_id) && !ids.has(r.id)) { ids.add(r.id); grew = true; }
    }
  }
  return ids;
}

interface BillLike { id: number | string; order_id: number | string; subtotal: number; discount_amount?: number; discount_reason?: string | null }

/** Why a bill can't take a coupon at all (one discount per bill), or null if it can. */
export function billCouponBlock(db: Db, bill: BillLike & { payment_status?: string; split_group_id?: unknown; paid_amount?: number }): string | null {
  if (bill.payment_status === 'paid' || bill.payment_status === 'refunded' || bill.payment_status === 'partially_refunded') return 'This bill is already paid';
  if (bill.split_group_id) return 'Add the coupon before splitting the bill';
  if (Number((bill as { paid_amount?: number }).paid_amount || 0) > 0) return 'Add the coupon before taking payment';
  if (Number(bill.discount_amount) > 0 && !isCouponReason(bill.discount_reason)) return 'This bill already has a discount. Only one discount per bill.';
  const order = db.prepare('SELECT discount_amount, discount_reason FROM orders WHERE id = ?').get(bill.order_id) as { discount_amount: number; discount_reason: string | null } | undefined;
  if (order && Number(order.discount_amount) > 0 && !isCouponReason(order.discount_reason)) return 'This bill already has a discount. Only one discount per bill.';
  const itemDiscount = db.prepare(`SELECT 1 FROM order_items WHERE order_id = ? AND COALESCE(discount_amount, 0) > 0
    AND status NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded') LIMIT 1`).get(bill.order_id);
  if (itemDiscount) return 'An item on this bill already has a discount. Only one discount per bill.';
  return null;
}

/** Money off this coupon gives on the bill, or a reason it doesn't apply. */
export function couponDiscountFor(db: Db, c: Coupon, bill: BillLike): { amount: number } | { reason: string } {
  const subtotal = Number(bill.subtotal || 0);
  if (c.min_spend > 0 && subtotal < c.min_spend) return { reason: `Needs a bill of at least $${c.min_spend.toFixed(2)}` };
  let amount = 0;
  if (c.kind === 'percent_bill') {
    amount = (subtotal * c.value) / 100;
  } else if (c.kind === 'amount_bill') {
    amount = Math.min(c.value, subtotal);
  } else {
    const tree = categoryTree(db, String(c.category_id));
    const items = db.prepare(`
      SELECT oi.total, p.category_id FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? AND oi.status NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded') AND oi.comp_reason IS NULL
    `).all(bill.order_id) as { total: number; category_id: string | null }[];
    const eligible = items.filter((i) => i.category_id && tree.has(String(i.category_id))).reduce((sum, i) => sum + Number(i.total || 0), 0);
    if (eligible <= 0) return { reason: 'No items from that category on this bill' };
    amount = (Math.min(eligible, subtotal) * c.value) / 100;
  }
  amount = Math.round(amount * 100) / 100;
  if (amount <= 0) return { reason: 'Nothing to take off' };
  return { amount };
}

/** True when the order's bill carries a coupon; manual discounts are refused then (one discount per bill). */
export function orderHasCoupon(db: Db, orderId: number | string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM bills WHERE order_id = ? AND COALESCE(discount_amount, 0) > 0 AND discount_reason LIKE 'Coupon %' LIMIT 1`).get(orderId));
}
