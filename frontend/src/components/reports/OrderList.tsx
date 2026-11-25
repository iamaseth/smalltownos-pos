'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import api from '@/lib/api';
import { usd, type ReportOrderRow, type ReportShiftRow } from '@print/shift-report-text';
import { clock } from './DayReports';

type Filter = 'all' | 'open' | 'tables' | 'togo' | `shift:${number}` | 'noshift';

interface OrderDetail {
  id: number; orderNumber: string; label: string; status: string; paymentStatus: string; cashier: string; createdAt: string; paidAt: string | null;
  totalCents: number; discountCents: number; timezone: string;
  items: { name: string; qty: number; status: string; totalCents: number; note: string | null }[];
  payments: { label: string; amountCents: number; at: string | null }[];
  history: { at: string; text: string }[];
}

const th = 'pb-2 text-xs font-semibold text-muted-foreground';
const isToGo = (o: ReportOrderRow) => o.label === 'To Go';
const shortNo = (n: string) => `#${n.split('-').pop()}`;

/**
 * Orders one line each, grouped under their shift when `shifts` is given; tapping one
 * opens a read-only details panel.
 */
export function OrderList({ orders, shifts, tz, date }: { orders: ReportOrderRow[]; shifts?: ReportShiftRow[]; tz: string; date?: string }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<number | null>(null);
  const matches = (o: ReportOrderRow) => {
    if (filter === 'all') return true;
    if (filter === 'open') return o.status === 'unpaid';
    if (filter === 'togo') return isToGo(o);
    if (filter === 'tables') return !isToGo(o);
    if (filter === 'noshift') return o.shiftId == null;
    return o.shiftId === Number(filter.slice(6));
  };
  const shown = orders.filter(matches);
  const unshifted = orders.filter((o) => o.shiftId == null).length;
  const chips: [Filter, string][] = [
    ['all', `All (${orders.length})`],
    ...(shifts && unshifted ? [['noshift', `No shift (${unshifted})`] as [Filter, string]] : []),
    ['open', `Open (${orders.filter((o) => o.status === 'unpaid').length})`],
    ...(shifts ?? []).map((sh) => [`shift:${sh.id}`, `Shift #${sh.id} · ${sh.cashier}`] as [Filter, string]),
    ['tables', 'Tables'], ['togo', 'To Go'],
  ];
  const groups = shifts
    ? [...shifts.map((sh) => ({ key: `s${sh.id}`, title: `Shift #${sh.id} · ${sh.cashier} · ${clock(sh.openedAt, tz)} – ${sh.closedAt ? clock(sh.closedAt, tz) : 'open'}`, rows: shown.filter((o) => o.shiftId === sh.id) })),
      { key: 'none', title: 'Taken with no shift open', rows: shown.filter((o) => o.shiftId == null) }].filter((g) => g.rows.length)
    : [{ key: 'all', title: '', rows: shown }];

  return (
    <>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter orders">
        {chips.map(([key, label]) => (
          <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}
            className={`rounded-full border px-3 py-1 text-sm font-semibold ${key === 'noshift' ? (filter === key ? 'border-red-700 bg-red-700 text-white' : 'border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950') : filter === key ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:bg-muted'}`}>
            {label}
          </button>
        ))}
      </div>
      <section className="rounded-2xl border-2 border-border bg-card p-5">
        {shown.length === 0 ? <p className="text-sm text-muted-foreground">No orders here.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr>
              <th className={`${th} text-start`}>Table / order</th><th className={`${th} text-start`}>Cashier</th><th className={`${th} text-start`}>Opened</th>
              <th className={`${th} text-start`}>Closed</th><th className={`${th} text-end`}>Total</th><th className={`${th} text-start ps-4`}>Status</th><th className={th} />
            </tr></thead>
            {groups.map((g) => (
              <tbody key={g.key}>
                {g.title && (
                  <tr><td colSpan={7} className={`pt-4 pb-1 text-xs font-bold uppercase tracking-wide ${g.key === 'none' ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground'}`}>
                    {g.title} · {g.rows.length} {g.rows.length === 1 ? 'order' : 'orders'} · {usd(g.rows.reduce((sum, o) => sum + o.totalCents, 0))}
                  </td></tr>
                )}
                {g.rows.map((o) => (
                  <tr key={o.id} onClick={() => setOpenId(o.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(o.id); }}
                    className={`cursor-pointer border-t border-border hover:bg-muted ${openId === o.id ? 'bg-muted' : ''}`}>
                    <td className="py-2"><span className="font-semibold">{o.label}</span> <span className="text-muted-foreground">{shortNo(o.orderNumber)}</span></td>
                    <td className="py-2">{o.cashier || '—'}</td>
                    <td className="py-2">{clock(o.openedAt, tz)}</td>
                    <td className="py-2">{clock(o.closedAt, tz)}</td>
                    <td className="py-2 text-end font-semibold">{usd(o.totalCents)}</td>
                    <td className={`py-2 ps-4 ${o.status === 'paid' ? 'text-muted-foreground' : 'font-semibold text-amber-700 dark:text-amber-400'}`}>
                      {o.status === 'paid' ? `Paid${o.paidWith ? ` · ${o.paidWith}` : ''}` : 'Open · unpaid'}
                    </td>
                    <td className="py-2 text-end text-muted-foreground" aria-hidden="true">›</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table></div>
        )}
      </section>
      {openId != null && <OrderPanel key={openId} orderId={openId} date={date} onClose={() => setOpenId(null)} />}
    </>
  );
}

function OrderPanel({ orderId, date, onClose }: { orderId: number; date?: string; onClose: () => void }) {
  const [state, setState] = useState<{ detail: OrderDetail | null; error: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.get('/reports/order-detail', { params: { order_id: orderId } })
      .then(({ data }) => { if (!cancelled) setState({ detail: data, error: null }); })
      .catch((error) => { if (!cancelled) setState({ detail: null, error: error?.response?.data?.error || 'Could not load the order' }); });
    return () => { cancelled = true; };
  }, [orderId]);
  const d = state?.detail;
  const tz = d?.timezone ?? 'Asia/Phnom_Penh';
  const paid = d && ['paid', 'partially_refunded', 'refunded'].includes(d.paymentStatus);
  const stamp = (utc: string | null) => {
    if (!utc) return '—';
    const t = new Date(`${utc.replace(' ', 'T')}Z`);
    return Number.isNaN(t.getTime()) ? '—' : t.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz });
  };
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20 print:hidden" onClick={onClose}>
      <aside role="dialog" aria-label="Order details" onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-sm overflow-y-auto border-s-2 border-border bg-background p-6 shadow-xl">
        <div className="flex items-start justify-between gap-2">
          <div className="text-sm text-muted-foreground">{d ? `${d.label} · ${d.orderNumber}` : 'Order'}</div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 hover:bg-muted"><X className="size-5" /></button>
        </div>
        {!state ? <p className="mt-6 text-sm text-muted-foreground">Loading…</p> : !d ? <p className="mt-6 text-sm text-red-600">{state.error}</p> : (
          <>
            <h2 className="mt-1 flex items-center gap-2 text-2xl font-bold">
              {usd(d.totalCents)}
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${paid ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{paid ? 'Paid' : 'Unpaid'}</span>
            </h2>
            <p className="text-sm text-muted-foreground">Put through by {d.cashier || '—'} · {stamp(d.createdAt)}</p>

            <h3 className="mt-5 mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Items</h3>
            <ul className="text-sm">{d.items.map((i, n) => (
              <li key={n} className="border-t border-border py-1.5">
                <div className="flex justify-between gap-2">
                  <span className={i.status === 'voided' || i.status === 'cancelled' ? 'text-muted-foreground line-through' : ''}>{i.qty}× {i.name}</span>
                  <span className="font-semibold">{usd(i.totalCents)}</span>
                </div>
                <div className="text-xs text-muted-foreground">{i.status}{i.note ? ` · ${i.note}` : ''}</div>
              </li>
            ))}</ul>
            {d.discountCents > 0 && <p className="mt-1 text-sm">Discount −{usd(d.discountCents)}</p>}

            <h3 className="mt-5 mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payments</h3>
            {d.payments.length === 0 ? <p className="text-sm text-muted-foreground">No payment yet</p> : (
              <ul className="text-sm">{d.payments.map((p, n) => (
                <li key={n} className="flex justify-between border-t border-border py-1.5"><span>{p.label} <span className="text-xs text-muted-foreground">{stamp(p.at)}</span></span><span className="font-semibold">{usd(p.amountCents)}</span></li>
              ))}</ul>
            )}

            <h3 className="mt-5 mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">History</h3>
            <ul className="space-y-1 text-sm">{d.history.map((h, n) => <li key={n}><span className="text-muted-foreground">{stamp(h.at)}</span> · {h.text}</li>)}</ul>

            <div className="mt-6 space-y-2">
              <Link href={`/orders?search=${encodeURIComponent(d.orderNumber)}${date ? `&date=${date}` : ''}&open=${d.id}`}
                className="block rounded-xl bg-emerald-600 px-4 py-3 text-center font-semibold text-white hover:bg-emerald-700">
                {paid ? 'Open in Orders' : 'Open in Orders to take payment'}
              </Link>
              <button type="button" onClick={onClose} className="w-full rounded-xl border px-4 py-3 font-semibold hover:bg-muted">Close</button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

/** The open (or given) shift's orders, for the cashier on the Cash page. */
export function ShiftOrders({ sessionId }: { sessionId: number }) {
  const [state, setState] = useState<{ orders: ReportOrderRow[]; tz: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.get('/reports/shift-report', { params: { session_id: sessionId } })
      .then(({ data }) => { if (!cancelled) setState({ orders: data.orders ?? [], tz: data.timezone }); })
      .catch(() => { if (!cancelled) setState({ orders: [], tz: 'Asia/Phnom_Penh' }); });
    return () => { cancelled = true; };
  }, [sessionId]);
  if (!state) return <p className="text-sm text-muted-foreground">Loading tables…</p>;
  return <div className="space-y-3"><OrderList orders={state.orders} tz={state.tz} /></div>;
}
