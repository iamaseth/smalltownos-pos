'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, Plus, Printer, UserRound, X } from 'lucide-react';
import api from '@/lib/api';
import type { Order } from '@/lib/types';

interface Detail {
  payments: { label: string; amountCents: number; at: string | null }[];
  history: { at: string; text: string }[];
  timezone: string;
}

const REMOVED = ['cancelled', 'voided', 'void_adjustment', 'refunded'];
const COMP_LABEL: Record<string, string> = {
  entertainer: 'Entertainer', event_person: 'Event person drinks', owner_comp: 'Owner comp (Thida)', complaint: 'Complaint', wrong_item: 'Wrong item', staff_meal: 'Staff meal', friends_owner: 'Friends / owner', too_slow: 'Too slow', other: 'Other',
};
const money = (n: number) => `$${Number(n || 0).toFixed(2)}`;

export function orderPlace(order: Order): string {
  if (order.tab_name) return `Tab ${order.tab_name}`;
  if (order.table?.name) return String(order.table.name);
  if (order.type === 'takeaway') return 'To Go';
  if (order.type === 'delivery') return 'Delivery';
  if (order.type === 'online') return 'Online';
  return 'Walk-in';
}

/** Tidy, read-first view of one order with every action grouped; "More options" keeps the full card. */
export function OrderSidePanel({
  order, paid, cancelled, onClose, onTakePayment, onAddItems, onPrint, onCustomer, onVoid, onComp, onCancelOrder, onRefund, moreOptions,
}: {
  order: Order; paid: boolean; cancelled: boolean; onClose: () => void;
  onTakePayment: () => void; onAddItems: () => void; onPrint: (() => void) | null; onCustomer: () => void;
  onVoid: () => void; onComp: () => void; onCancelOrder: () => void; onRefund: (() => void) | null; moreOptions: ReactNode;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let cancelledReq = false;
    api.get('/reports/order-detail', { params: { order_id: order.id } })
      .then(({ data }) => { if (!cancelledReq) setDetail(data); })
      .catch(() => { if (!cancelledReq) setDetail({ payments: [], history: [], timezone: 'Asia/Phnom_Penh' }); });
    return () => { cancelledReq = true; };
  }, [order.id, order.total, order.status]);

  const tz = detail?.timezone ?? 'Asia/Phnom_Penh';
  const stamp = (utc: string | null | undefined) => {
    if (!utc) return '—';
    const d = new Date(`${utc.replace(' ', 'T')}${/Z$/.test(utc) ? '' : 'Z'}`);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz });
  };
  const items = (order.items || []).filter((i) => i.status !== 'void_adjustment');
  const kitchen = items.some((i) => i.status === 'pending') ? 'Waiting' : items.some((i) => ['preparing', 'ready'].includes(i.status)) ? 'Making' : 'Served';
  const editable = !paid && !cancelled && order.status !== 'completed';
  const btn = 'flex items-center justify-center gap-2 rounded-xl border border-border px-3 py-2.5 text-sm font-bold hover:bg-muted disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" onClick={onClose}>
      <aside role="dialog" aria-label="Order details" onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-md overflow-y-auto border-s-2 border-border bg-background p-5 shadow-xl">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-xs text-muted-foreground">{order.order_number} · {order.type === 'takeaway' ? 'Takeaway' : order.type === 'dine_in' ? 'Dine in' : order.type}</div>
            <div className="text-2xl font-extrabold">{orderPlace(order)} · {money(order.total)}</div>
            <span className={`mt-1 inline-block rounded-full px-2.5 py-0.5 text-xs font-bold ${cancelled ? 'bg-gray-200 text-gray-700' : paid ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
              {cancelled ? 'Cancelled' : paid ? 'Paid' : 'Not paid'}
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 hover:bg-muted"><X className="size-5" /></button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
          {[['Put through by', order.staff_name || '—'], ['Paid by', order.paid_by_name || '—'], ['Time', stamp(order.created_at)], ['Customer', order.customer?.name || 'Walk-in'], ['Kitchen / bar', cancelled ? '—' : kitchen]].map(([k, v]) => (
            <div key={k} className="rounded-xl bg-muted px-3 py-2 text-muted-foreground">{k}<b className="block text-sm text-foreground">{v}</b></div>
          ))}
        </div>

        <h3 className="mt-5 mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Items</h3>
        <ul className="text-sm">
          {items.map((i) => {
            const gone = REMOVED.includes(i.status);
            return (
              <li key={i.id} className="flex items-start justify-between gap-2 border-t border-border py-2">
                <span className={gone || i.comped_at ? 'text-muted-foreground line-through' : ''}>
                  {i.quantity} × {i.product_name}
                  <small className="block text-xs text-muted-foreground no-underline">{i.status}</small>
                </span>
                {i.comped_at ? <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-bold text-violet-800">COMP · {COMP_LABEL[i.comp_reason || ''] || 'free'}</span>
                  : gone ? <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">{i.status === 'cancelled' ? 'REMOVED' : 'VOID'}</span>
                    : <b>{money(i.total)}</b>}
              </li>
            );
          })}
        </ul>
        {Number(order.discount_amount) > 0 && <div className="flex justify-between text-sm"><span>Discount</span><span>−{money(order.discount_amount)}</span></div>}
        <div className="mt-1 flex justify-between border-t-2 border-foreground pt-2 text-xl font-extrabold"><span>Total</span><span>{money(order.total)}</span></div>

        <h3 className="mt-5 mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payment</h3>
        {!detail ? <p className="text-sm text-muted-foreground">…</p> : detail.payments.length === 0 ? <p className="text-sm text-muted-foreground">No payment yet</p> : (
          <ul className="text-sm">{detail.payments.map((p, n) => (
            <li key={n} className="flex justify-between border-t border-border py-1.5"><span>{p.label} <span className="text-xs text-muted-foreground">{stamp(p.at)}</span></span><b>{money(p.amountCents / 100)}</b></li>
          ))}</ul>
        )}

        {editable && (
          <button type="button" onClick={onTakePayment} className="mt-4 w-full rounded-xl bg-emerald-600 px-4 py-3 text-lg font-extrabold text-white hover:bg-emerald-700">Take payment</button>
        )}
        <div className="mt-2 grid grid-cols-2 gap-2">
          {editable && <button type="button" className={btn} onClick={onAddItems}><Plus className="size-4" /> Add items</button>}
          {onPrint && <button type="button" className={btn} onClick={onPrint}><Printer className="size-4" /> Print bill</button>}
          {!cancelled && <button type="button" className={btn} onClick={() => { onCustomer(); setMore(true); }}><UserRound className="size-4" /> Customer</button>}
        </div>

        {(editable || onRefund) && (
          <>
            <h3 className="mt-5 mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Problems</h3>
            <div className="grid grid-cols-2 gap-2">
              {editable && <button type="button" className={`${btn} border-violet-200 text-violet-700`} onClick={onComp}>🎁 Comp an item</button>}
              {editable && <button type="button" className={`${btn} border-red-200 text-red-700`} onClick={onVoid}>Void an item</button>}
              {editable && <button type="button" className={`${btn} col-span-2 border-red-200 text-red-700`} onClick={onCancelOrder}>Cancel order</button>}
              {onRefund && <button type="button" className={`${btn} col-span-2 border-red-200 text-red-700`} onClick={onRefund}>Refund</button>}
            </div>
          </>
        )}

        <h3 className="mt-5 mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</h3>
        <ul className="space-y-1 text-sm">{(detail?.history ?? []).map((h, n) => <li key={n}><span className="text-muted-foreground">{stamp(h.at)}</span> · {h.text}</li>)}</ul>

        <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more}
          className="mt-5 flex w-full items-center justify-between rounded-xl border border-border px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted">
          More options (print preview, WhatsApp, change to takeaway…) <ChevronDown className={`size-4 transition ${more ? 'rotate-180' : ''}`} />
        </button>
        {more && <div className="mt-2">{moreOptions}</div>}
      </aside>
    </div>
  );
}
