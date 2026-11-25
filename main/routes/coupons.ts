import { Router, Request, Response } from 'express';
import { getDatabase, recordOrderAudit } from '../db';
import { requirePermission } from '../services/authorization';
import { tenantTimezone } from './cash-closures';
import { writeBillDiscount, type DiscountableBill } from './bills';
import { notifyOrderUpdated } from '../services/kds';
import {
  COUPON_REASON_PREFIX, billCouponBlock, couponDiscountFor, couponLabel, isCouponLive, isCouponReason,
  normalizeCoupons, readCoupons, saveCoupons,
} from '../services/coupons';

const router = Router();

function fail(res: Response, error: unknown) {
  const statusCode = (error as { statusCode?: number }).statusCode;
  if (!statusCode) console.error('[Coupons]', error);
  res.status(statusCode || 500).json({ error: statusCode ? (error as Error).message : 'Internal server error' });
}

const httpError = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

function actorId(req: Request): string {
  const id = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
  if (!id) throw httpError('Authentication required', 401);
  return id;
}

/** Settings: every coupon, live or not. */
router.get('/', requirePermission('settings.manage'), (_req: Request, res: Response) => {
  try { res.json({ coupons: readCoupons(), timezone: tenantTimezone() }); } catch (error) { fail(res, error); }
});

router.put('/', requirePermission('settings.manage'), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const exists = db.prepare('SELECT 1 FROM categories WHERE id = ? AND deleted_at IS NULL');
    const coupons = normalizeCoupons(req.body?.coupons, (id) => Boolean(exists.get(id)));
    saveCoupons(coupons);
    res.json({ coupons });
  } catch (error) { fail(res, error); }
});

function loadBill(billId: string) {
  const db = getDatabase();
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as (DiscountableBill & {
    discount_amount: number; discount_reason: string | null; payment_status: string; split_group_id: unknown; paid_amount: number;
  }) | undefined;
  if (!bill) throw httpError('Bill not found', 404);
  return { db, bill };
}

/** Checkout: coupons live right now that give something off this bill. */
router.get('/for-bill/:billId', requirePermission('bills.discount.apply'), (req: Request, res: Response) => {
  try {
    const { db, bill } = loadBill(String(req.params.billId));
    const applied = isCouponReason(bill.discount_reason) && Number(bill.discount_amount) > 0
      ? { reason: String(bill.discount_reason), amount: Number(bill.discount_amount) } : null;
    const blocked = applied ? null : billCouponBlock(db, bill);
    const now = new Date();
    const tz = tenantTimezone();
    const coupons = blocked || applied ? [] : readCoupons()
      .filter((c) => isCouponLive(c, now, tz))
      .map((c) => {
        const result = couponDiscountFor(db, c, bill);
        return 'amount' in result ? { id: c.id, code: c.code, name: c.name, label: couponLabel(c), amount: result.amount } : null;
      })
      .filter(Boolean);
    res.json({ coupons, applied, blocked });
  } catch (error) { fail(res, error); }
});

/** Applies one coupon as the bill's only discount. The cashier keeps the paper coupon in the drawer. */
router.post('/for-bill/:billId/apply', requirePermission('bills.discount.apply'), (req: Request, res: Response) => {
  try {
    const me = actorId(req);
    if (req.body?.paper_confirmed !== true) throw httpError('Take the paper coupon from the customer and put it in the drawer', 400);
    const { db, bill } = loadBill(String(req.params.billId));
    const coupon = readCoupons().find((c) => c.id === req.body?.coupon_id);
    if (!coupon) throw httpError('Coupon not found', 404);
    if (!isCouponLive(coupon, new Date(), tenantTimezone())) throw httpError(`${coupon.code} can't be used right now`, 409);
    if (isCouponReason(bill.discount_reason) && Number(bill.discount_amount) > 0) throw httpError('This bill already has a coupon. Remove it first.', 409);
    const blocked = billCouponBlock(db, bill);
    if (blocked) throw httpError(blocked, 409);
    const result = couponDiscountFor(db, coupon, bill);
    if (!('amount' in result)) throw httpError(`${coupon.code}: ${result.reason}`, 409);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(bill.order_id) as object | undefined;
    if (!order) throw httpError('Order not found', 404);
    const reason = `${COUPON_REASON_PREFIX}${coupon.code} · ${coupon.name}`;
    const updated = coupon.kind === 'percent_bill'
      ? writeBillDiscount(db, bill, order, result.amount, 'percentage', coupon.value, reason)
      : writeBillDiscount(db, bill, order, result.amount, 'amount', result.amount, reason);
    recordOrderAudit(db, {
      orderId: String(bill.order_id), actorUserId: me, action: 'coupon_applied',
      details: { bill_id: bill.id, coupon: coupon.code, amount: result.amount, paper_coupon_in_drawer: true },
    });
    notifyOrderUpdated();
    res.json({ bill: updated });
  } catch (error) { fail(res, error); }
});

router.post('/for-bill/:billId/remove', requirePermission('bills.discount.apply'), (req: Request, res: Response) => {
  try {
    const me = actorId(req);
    const { db, bill } = loadBill(String(req.params.billId));
    if (!isCouponReason(bill.discount_reason) || !(Number(bill.discount_amount) > 0)) throw httpError('This bill has no coupon', 409);
    if (bill.payment_status === 'paid' || Number(bill.paid_amount) > 0) throw httpError('Payment has started; the coupon can no longer be removed', 409);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(bill.order_id) as object;
    const updated = writeBillDiscount(db, bill, order, 0, 'percentage', 0, null);
    recordOrderAudit(db, {
      orderId: String(bill.order_id), actorUserId: me, action: 'coupon_removed',
      details: { bill_id: bill.id, reason: bill.discount_reason },
    });
    notifyOrderUpdated();
    res.json({ bill: updated });
  } catch (error) { fail(res, error); }
});

export { router as couponRoutes };
