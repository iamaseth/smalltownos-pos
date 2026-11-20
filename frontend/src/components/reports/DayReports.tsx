'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { usd, khr, type DailyReportData } from '@print/shift-report-text';
import { OrderList } from './OrderList';
import { ReportOutputButtons } from './ReportOutputButtons';

export type DayView = 'daily' | 'shifts' | 'tables' | 'payments' | 'items';

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function clock(utc: string | null, timezone: string): string {
  if (!utc) return '—';
  const date = new Date(`${utc.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone });
}

const card = 'rounded-2xl border-2 border-border bg-card p-5';
const th = 'pb-2 text-xs font-semibold text-muted-foreground';
const row = 'border-t border-border';

/** Business-day reports (daily sales, shifts, tables, payments, items) for one date, each printable. */
export function DayReports({ view, canSendTelegram }: { view: DayView; canSendTelegram: boolean }) {
  const [date, setDate] = useState(localToday);
  const [state, setState] = useState<{ date: string; data: DailyReportData | null; error: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get('/reports/daily-report', { params: { date } })
      .then(({ data }) => { if (!cancelled) setState({ date, data, error: null }); })
      .catch((error) => { if (!cancelled) setState({ date, data: null, error: error?.response?.data?.error || 'Could not load the report' }); });
    return () => { cancelled = true; };
  }, [date]);

  const data = state?.date === date ? state.data : null;
  const loading = state?.date !== date;
  const tz = data?.timezone ?? 'Asia/Phnom_Penh';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm font-medium text-muted-foreground">Business day
          <input type="date" value={date} max={localToday()} onChange={(e) => e.target.value && setDate(e.target.value)}
            className="h-10 rounded-xl border-2 border-border bg-card px-2 text-foreground" />
        </label>
        <span className="flex-1" />
        {view !== 'shifts' && <ReportOutputButtons target={{ kind: 'daily', date }} telegram={canSendTelegram} />}
      </div>

      {loading ? (
        <div className={`${card} h-32 animate-pulse`} role="status" aria-live="polite"><span className="sr-only">Loading</span></div>
      ) : !data ? (
        <div className={`${card} text-center text-sm font-medium text-muted-foreground`}>{state?.error}</div>
      ) : (
        <>
          {view === 'daily' && (
            <>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                {[
                  ['Net sales', usd(data.sales.netCents)],
                  ['Orders', String(data.sales.orders)],
                  ['Average bill', usd(data.sales.averageCents)],
                  ['Unpaid tickets', `${data.unpaid.count} · ${usd(data.unpaid.totalCents)}`],
                ].map(([label, value]) => (
                  <div key={label} className={card}>
                    <p className="text-sm font-semibold text-muted-foreground">{label}</p>
                    <p className="mt-2 text-2xl font-bold tracking-tight text-foreground">{value}</p>
                  </div>
                ))}
              </div>
              <section className={card}>
                <h2 className="mb-3 text-base font-bold">Sales</h2>
                <table className="w-full max-w-md text-sm"><tbody>
                  {[
                    ['Gross sales', usd(data.sales.grossCents)],
                    ['Discounts', usd(-data.sales.discountCents)],
                    [`Refunds (${data.sales.refundCount})`, usd(-data.sales.refundCents)],
                    [`Voided items (${data.sales.voidCount})`, `${usd(data.sales.voidCents)} not charged`],
                    [`Complimentary (${data.sales.compCount})`, `${usd(data.sales.compCents)} not charged`],
                    ['Net sales', usd(data.sales.netCents)],
                  ].map(([label, value]) => (
                    <tr key={label} className={row}><td className="py-2">{label}</td><td className="py-2 text-end font-semibold">{value}</td></tr>
                  ))}
                </tbody></table>
              </section>
              {data.unpaid.count > 0 && (
                <section className={card}>
                  <h2 className="mb-3 text-base font-bold">Outstanding tickets</h2>
                  <ul className="space-y-1 text-sm">{data.unpaid.labels.map((l) => <li key={l}>{l}</li>)}</ul>
                </section>
              )}
            </>
          )}

          {view === 'shifts' && (
            <section className={card}>
              {data.shifts.length === 0 ? <p className="text-sm text-muted-foreground">No shifts opened on this day.</p> : (
                <div className="overflow-x-auto"><table className="w-full text-sm">
                  <thead><tr>
                    <th className={`${th} text-start`}>Shift</th><th className={`${th} text-start`}>Cashier</th><th className={`${th} text-start`}>Open – close</th>
                    <th className={`${th} text-end`}>Orders</th><th className={`${th} text-end`}>Net</th><th className={`${th} text-end`}>Cash difference</th><th className={`${th} text-start ps-4`}>Report</th>
                  </tr></thead>
                  <tbody>{data.shifts.map((s) => (
                    <tr key={s.id} className={row}>
                      <td className="py-2 font-semibold">#{s.id} <span className="text-xs font-medium text-muted-foreground">{s.closedAt ? 'Z' : 'X (open)'}</span></td>
                      <td className="py-2">{s.cashier}</td>
                      <td className="py-2">{clock(s.openedAt, tz)} – {s.closedAt ? clock(s.closedAt, tz) : 'open'}</td>
                      <td className="py-2 text-end">{s.orders}</td>
                      <td className="py-2 text-end font-semibold">{usd(s.netCents)}</td>
                      <td className="py-2 text-end">{s.varianceUsdCents == null ? '—' : `${usd(s.varianceUsdCents)} · ${khr(s.varianceKhrRiel ?? 0)}`}</td>
                      <td className="py-2 ps-4"><ReportOutputButtons target={{ kind: 'shift', sessionId: s.id }} size="sm" telegram={canSendTelegram} /></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
            </section>
          )}

          {view === 'tables' && <OrderList orders={data.orders ?? []} shifts={data.shifts} tz={tz} date={date} />}

          {view === 'payments' && (
            <section className={card}>
              <table className="w-full max-w-xl text-sm">
                <thead><tr><th className={`${th} text-start`}>Method</th><th className={`${th} text-end`}>Count</th><th className={`${th} text-end`}>Amount</th></tr></thead>
                <tbody>{data.payments.map((p) => (
                  <tr key={p.label} className={row}>
                    <td className="py-2 font-semibold">{p.label}</td>
                    <td className="py-2 text-end">{p.count}</td>
                    <td className="py-2 text-end font-semibold">{p.label === 'Cash KHR' ? khr(p.khrRiel) : usd(p.usdCents)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </section>
          )}

          {view === 'items' && (
            <div className="grid gap-4 lg:grid-cols-2">
              {([['By category', data.categories], ['Top products', data.products]] as const).map(([label, rows]) => (
                <section key={label} className={card}>
                  <h2 className="mb-3 text-base font-bold">{label}</h2>
                  <table className="w-full text-sm">
                    <thead><tr><th className={`${th} text-start`}>Name</th><th className={`${th} text-end`}>Qty</th><th className={`${th} text-end`}>Net</th></tr></thead>
                    <tbody>{rows.map((r) => (
                      <tr key={r.label} className={row}><td className="py-2">{r.label}</td><td className="py-2 text-end">{r.qty}</td><td className="py-2 text-end font-semibold">{usd(r.netCents)}</td></tr>
                    ))}</tbody>
                  </table>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
