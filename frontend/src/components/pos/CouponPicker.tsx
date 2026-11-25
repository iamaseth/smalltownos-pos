'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Ticket, X } from 'lucide-react';
import api from '@/lib/api';
import type { Bill } from '@/lib/types';

interface OfferedCoupon { id: string; code: string; name: string; label: string; amount: number }
interface CouponState { coupons: OfferedCoupon[]; applied: { reason: string; amount: number } | null; blocked: string | null }

function errorText(error: unknown, fallback: string): string {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

/**
 * Coupons the manager set up that apply to this bill, as buttons. The cashier taps one,
 * confirms the paper coupon is in the drawer, and it becomes the bill's only discount.
 */
export default function CouponPicker({ bill, money, onBillUpdate }: {
  bill: Bill;
  money: (value: number) => string;
  onBillUpdate?: (bill: Bill) => void;
}) {
  const [state, setState] = useState<CouponState | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [paper, setPaper] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.get(`/coupons/for-bill/${bill.id}`)
      .then(({ data }) => { if (active) setState(data); })
      .catch(() => { if (active) setState(null); });
    return () => { active = false; };
  }, [bill.id, bill.subtotal, bill.discount_amount, bill.discount_reason]);

  if (!state) return null;

  const apply = async (coupon: OfferedCoupon) => {
    setBusy(true);
    try {
      const { data } = await api.post(`/coupons/for-bill/${bill.id}/apply`, { coupon_id: coupon.id, paper_confirmed: true });
      toast.success(`${coupon.code} applied: −${money(coupon.amount)}`);
      setConfirming(null);
      setPaper(false);
      if (data.bill && onBillUpdate) onBillUpdate(data.bill);
    } catch (error) {
      toast.error(errorText(error, 'Could not apply the coupon'));
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const { data } = await api.post(`/coupons/for-bill/${bill.id}/remove`, {});
      toast.success('Coupon removed');
      if (data.bill && onBillUpdate) onBillUpdate(data.bill);
    } catch (error) {
      toast.error(errorText(error, 'Could not remove the coupon'));
    } finally { setBusy(false); }
  };

  if (state.applied) {
    const label = state.applied.reason.replace(/^Coupon /, '');
    return (
      <div data-testid="coupon-applied" className="flex items-center gap-3 rounded-xl border-2 border-emerald-500 bg-emerald-50 px-3 py-2.5 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100">
        <Ticket size={18} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm font-bold">Coupon {label}</span>
        <span className="shrink-0 text-sm font-extrabold tabular-nums">−{money(state.applied.amount)}</span>
        {!(Number(bill.paid_amount) > 0) && (
          <button type="button" disabled={busy} onClick={() => void remove()} aria-label="Remove coupon"
            className="rounded-lg p-1.5 hover:bg-emerald-100 dark:hover:bg-emerald-900"><X size={16} /></button>
        )}
      </div>
    );
  }

  if (state.coupons.length === 0) return null;

  return (
    <div data-testid="coupon-picker" className="space-y-2">
      <p className="flex items-center gap-1.5 text-sm font-bold"><Ticket size={16} /> Coupons</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {state.coupons.map((c) => (
          <div key={c.id} className={`rounded-xl border-2 p-3 ${confirming === c.id ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/40' : 'border-border bg-card'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-mono text-sm font-extrabold">{c.code}</p>
                <p className="truncate text-xs text-muted-foreground">{c.name}</p>
              </div>
              <div className="shrink-0 text-end">
                <p className="text-sm font-extrabold text-emerald-700">{c.label}</p>
                <p className="text-xs tabular-nums text-muted-foreground">−{money(c.amount)}</p>
              </div>
            </div>
            {confirming === c.id ? (
              <div className="mt-2 space-y-2">
                <label className="flex items-start gap-2 text-sm font-semibold">
                  <input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={paper} onChange={(e) => setPaper(e.target.checked)} />
                  I have the customer&apos;s paper coupon and put it in the drawer
                </label>
                <div className="flex gap-2">
                  <button type="button" disabled={busy || !paper} onClick={() => void apply(c)}
                    className="flex-1 rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">Apply coupon</button>
                  <button type="button" onClick={() => { setConfirming(null); setPaper(false); }}
                    className="rounded-lg border border-border px-3 py-2 text-sm">Cancel</button>
                </div>
              </div>
            ) : (
              <button type="button" disabled={busy} onClick={() => { setConfirming(c.id); setPaper(false); }}
                className="mt-2 w-full rounded-lg border-2 border-emerald-700 px-3 py-2 text-sm font-bold text-emerald-800 dark:text-emerald-200">Use coupon</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
