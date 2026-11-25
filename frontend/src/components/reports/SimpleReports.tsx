'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { ArrowLeftRight, CalendarCheck, CalendarDays, ChevronLeft, ChevronRight, Lock, LockOpen, Moon, Printer, Search, Send, Sun, TriangleAlert } from 'lucide-react';
import api from '@/lib/api';
import { usd, khr, type ReportOrderRow, type ReportPaymentRow, type ReportQtyRow, type ReportSales } from '@print/shift-report-text';
import { printReportReceipt, printSummaryReceipt, sendReportTelegram } from '@/lib/printer/shift-report-print';
import { OrderList } from './OrderList';
import { CashCloseModal } from '@/components/dashboard/CashCloseModal';
import { useCashClose } from '@/hooks/useCashClose';
import { useCashSession } from '@/hooks/useCashSession';
import { tenantCan } from '@/lib/permissions';
import { useAuthStore } from '@/store/auth';
import { clock } from './DayReports';

type Period = 'today' | 'week' | 'month';
type Tab = 'summary' | 'items' | 'tickets' | 'payments';

interface Shift { id: number; cashier: string; openedAt: string; closedAt: string | null; open: boolean; part: 'day' | 'night'; varianceUsdCents?: number | null; varianceKhrRiel?: number | null }
interface CashierReport {
  timezone: string; startDate: string; endDate: string; sessionId: number | null;
  shifts: Shift[];
  days: { date: string; orders: number; netCents: number }[];
  sales: ReportSales;
  payments: ReportPaymentRow[];
  items: ReportQtyRow[];
  tickets: ReportOrderRow[];
  unpaid: { count: number; totalCents: number; labels: string[] };
  cash: { openingUsdCents: number; expectedUsdCents: number; countedUsdCents: number | null; differenceUsdCents: number | null; openingKhrRiel: number; expectedKhrRiel: number; countedKhrRiel: number | null; differenceKhrRiel: number | null; shiftsCounted: number; shiftsTotal: number };
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayIso = () => iso(new Date());

function rangeFor(period: Period, anchor: string): [string, string] {
  const a = parse(anchor);
  if (period === 'today') return [anchor, anchor];
  if (period === 'week') {
    const monday = new Date(a.getFullYear(), a.getMonth(), a.getDate() - ((a.getDay() + 6) % 7));
    return [iso(monday), iso(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6))];
  }
  return [iso(new Date(a.getFullYear(), a.getMonth(), 1)), iso(new Date(a.getFullYear(), a.getMonth() + 1, 0))];
}

function step(period: Period, anchor: string, dir: 1 | -1): string {
  const a = parse(anchor);
  if (period === 'today') return iso(new Date(a.getFullYear(), a.getMonth(), a.getDate() + dir));
  if (period === 'week') return iso(new Date(a.getFullYear(), a.getMonth(), a.getDate() + 7 * dir));
  return iso(new Date(a.getFullYear(), a.getMonth() + dir, 1));
}

function rangeLabel(period: Period, start: string, end: string): string {
  const s = parse(start);
  if (period === 'today') return s.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  if (period === 'month') return s.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const e = parse(end);
  return `${s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

const PERIODS: { key: Period; label: string; color: string; soft: string; ink: string }[] = [
  { key: 'today', label: 'TODAY', color: '#185FA5', soft: '#E6F1FB', ink: '#0C447C' },
  { key: 'week', label: 'WEEK', color: '#3B6D11', soft: '#EAF3DE', ink: '#27500A' },
  { key: 'month', label: 'MONTH', color: '#BA7517', soft: '#FAEEDA', ink: '#633806' },
];
const PART = {
  day: { color: '#BA7517', soft: '#FAEEDA', ink: '#633806', label: 'Day', Icon: Sun },
  night: { color: '#534AB7', soft: '#EEEDFE', ink: '#3C3489', label: 'Night', Icon: Moon },
};
const ALL = { color: '#3B6D11', soft: '#EAF3DE', ink: '#27500A' };
const TABS: { key: Tab; label: string }[] = [
  { key: 'summary', label: 'Summary' }, { key: 'items', label: 'Items sold' }, { key: 'tickets', label: 'Tickets' }, { key: 'payments', label: 'Payments' },
];

const card = 'rounded-2xl bg-muted/60 p-4';
const rowCls = 'flex items-baseline justify-between gap-3 border-b border-border py-2.5 text-base';

function lr(w: number, left: string, right: string): string {
  const gap = w - left.length - right.length;
  return gap >= 1 ? left + ' '.repeat(gap) + right : `${left.slice(0, Math.max(0, w - right.length - 1))} ${right}`;
}

function CountNote({ shift }: { shift: Shift }) {
  if (shift.varianceUsdCents == null) return null;
  const off = shift.varianceUsdCents !== 0 || (shift.varianceKhrRiel ?? 0) !== 0;
  if (!off) return <span className="text-green-800 dark:text-green-300"> · matched</span>;
  return <span className="text-red-700 dark:text-red-300"> · {shift.varianceUsdCents < 0 ? 'short' : 'over'} {usd(Math.abs(shift.varianceUsdCents))}</span>;
}

/** Simple reports for cashiers: one day, week or month, by shift, with print and Telegram. */
export function SimpleReports({ canTelegram }: { canTelegram: boolean }) {
  const [period, setPeriod] = useState<Period>('today');
  const [anchor, setAnchor] = useState(todayIso);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>('summary');
  const [itemSearch, setItemSearch] = useState('');
  const [busy, setBusy] = useState<'print' | 'tg' | null>(null);
  const [state, setState] = useState<{ key: string; data: CashierReport | null; error: string | null } | null>(null);
  const dateInput = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const currentTenant = useAuthStore((st) => st.currentTenant);
  const canOpen = tenantCan(currentTenant, 'cash.shifts.open');
  const canClose = tenantCan(currentTenant, 'cash.shifts.close');
  const register = useCashSession();
  const dayClose = useCashClose();
  const [start, end] = rangeFor(period, anchor);
  const shiftForQuery = period === 'today' ? sessionId : null;
  const key = `${start}|${end}|${shiftForQuery ?? 'all'}`;

  useEffect(() => {
    let cancelled = false;
    api.get('/reports/cashier', { params: { start_date: start, end_date: end, ...(shiftForQuery != null && { session_id: shiftForQuery }) } })
      .then(({ data }) => { if (!cancelled) setState({ key, data, error: null }); })
      .catch((error) => { if (!cancelled) setState({ key, data: null, error: error?.response?.data?.error || 'Could not load the report' }); });
    return () => { cancelled = true; };
  }, [key, start, end, shiftForQuery]);

  const data = state?.key === key ? state.data : null;
  const loading = state?.key !== key;
  const tz = data?.timezone ?? 'Asia/Phnom_Penh';
  const pay = (match: RegExp) => (data?.payments ?? []).filter((p) => match.test(p.label));
  const sumPay = (rows: ReportPaymentRow[]) => rows.reduce((a, p) => ({ usd: a.usd + p.usdCents, khr: a.khr + p.khrRiel, n: a.n + p.count }), { usd: 0, khr: 0, n: 0 });
  const cash = sumPay(pay(/^cash/i));
  const qr = sumPay(pay(/aba|acleda|khqr|qr/i));
  const cardPay = sumPay(pay(/card/i));
  const other = sumPay((data?.payments ?? []).filter((p) => !/^cash|aba|acleda|khqr|qr|card/i.test(p.label)));
  const items = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    return (data?.items ?? []).filter((i) => !q || i.label.toLowerCase().includes(q));
  }, [data, itemSearch]);

  const choosePeriod = (p: Period) => { setPeriod(p); setSessionId(null); };
  const move = (dir: 1 | -1) => { setAnchor(step(period, anchor, dir)); setSessionId(null); };
  const pickDate = (value: string) => { if (value) { setAnchor(value); setSessionId(null); } };

  const title = period === 'today'
    ? (sessionId != null ? `Shift #${sessionId}` : `Day ${start}`)
    : `${period === 'week' ? 'Week' : 'Month'} ${start} to ${end}`;

  const print = async () => {
    if (!data) return;
    setBusy('print');
    try {
      if (period === 'today') await printReportReceipt(sessionId != null ? { kind: 'shift', sessionId } : { kind: 'daily', date: start });
      else {
        await printSummaryReceipt(title, (w) => [
          'SALES SUMMARY', title, '-'.repeat(w),
          lr(w, 'Total sales', usd(data.sales.netCents)), lr(w, 'Orders', String(data.sales.orders)),
          lr(w, 'Discounts', usd(-data.sales.discountCents)), lr(w, 'Refunds', usd(-data.sales.refundCents)), lr(w, 'Voids', String(data.sales.voidCount)),
          '-'.repeat(w), 'PAYMENTS',
          ...data.payments.map((p) => lr(w, `${p.label} (${p.count})`, p.khrRiel ? `${usd(p.usdCents)} + ${khr(p.khrRiel)}` : usd(p.usdCents))),
          '-'.repeat(w), 'DAYS',
          ...data.days.filter((d) => d.orders > 0).map((d) => lr(w, `${parse(d.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} (${d.orders})`, usd(d.netCents))),
        ]);
      }
      toast.success('Sent to the receipt printer');
    } catch (error) {
      toast.error((error as Error)?.message || 'Could not print');
    } finally { setBusy(null); }
  };

  const telegram = async () => {
    setBusy('tg');
    try {
      const r = await sendReportTelegram(sessionId != null ? { kind: 'shift', sessionId } : { kind: 'daily', date: start });
      if (r.failed) toast.error(`Telegram: ${r.sent} sent, ${r.failed} failed`);
      else toast.success(r.pending ? `Telegram: ${r.sent} sent, ${r.pending} waiting` : `Sent to Telegram (${r.sent})`);
    } catch (error) {
      toast.error((error as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not send to Telegram');
    } finally { setBusy(null); }
  };

  /** Re-check the live shift, then go straight to the open / hand-over / close screen and come back here. */
  const goCash = async (entry: 'open' | 'close' | 'handover') => {
    const result = await register.refresh();
    if (result.status !== 'ok') return;
    if (result.error) { toast.error(result.error); return; }
    if (entry === 'open' && result.session) { toast('A shift is already open'); return; }
    if (entry !== 'open' && !result.session) { toast('No shift is open any more'); return; }
    router.push(`/cash?go=${entry}&from=reports`);
  };

  const bigBox = (label: string, v: { usd: number; khr: number; n: number }) => (
    <div className={card}>
      <p className="text-sm font-semibold text-muted-foreground">{label}</p>
      <p className="mt-1 text-3xl font-black tabular-nums text-foreground">{usd(v.usd)}</p>
      <p className="text-sm font-semibold text-muted-foreground">{v.n} payment{v.n === 1 ? '' : 's'}{v.khr ? ` · ${khr(v.khr)}` : ''}</p>
    </div>
  );

  const isToday = period === 'today' && anchor === todayIso();
  const shifts = period === 'today' ? (data?.shifts ?? []) : [];
  const showShiftRow = period === 'today' && (shifts.length > 0 || isToday);
  const noShiftTickets = shifts.length > 0 ? (data?.tickets ?? []).filter((t) => t.shiftId == null) : [];

  return (
    <div className="space-y-4" data-testid="simple-reports">
      {showShiftRow && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-stretch gap-2" role="group" aria-label="Shifts">
            {shifts.map((s) => {
              const tone = PART[s.part];
              const on = sessionId === s.id;
              const live = isToday && register.session?.id === s.id;
              return (
                <div key={s.id} style={{ borderColor: tone.color, backgroundColor: on || live ? tone.soft : undefined }}
                  className={`flex items-center gap-1.5 rounded-xl border-2 p-1 ${on || live ? '' : 'bg-card'} ${on ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : ''}`}>
                  <button type="button" aria-pressed={on} onClick={() => setSessionId(s.id)} style={{ color: tone.ink }}
                    className="flex min-w-32 flex-col items-start rounded-lg px-2 py-1 text-start">
                    <span className="flex items-center gap-1.5 text-base font-black"><tone.Icon size={16} />{tone.label} · {s.cashier}</span>
                    <span className="text-xs font-semibold">
                      {clock(s.openedAt, tz)} – {s.open ? 'open now' : clock(s.closedAt, tz)}
                      {!s.open && <CountNote shift={s} />}
                    </span>
                  </button>
                  {live && canClose && (
                    <>
                      <button type="button" onClick={() => { void goCash('handover'); }}
                        className="inline-flex h-10 items-center gap-1.5 rounded-lg border-2 border-border bg-card px-3 text-sm font-bold text-foreground hover:bg-muted">
                        <ArrowLeftRight className="size-4" aria-hidden /> Hand over
                      </button>
                      <button type="button" onClick={() => { void goCash('close'); }}
                        className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-amber-700 px-3 text-sm font-bold text-white hover:bg-amber-800">
                        <Lock className="size-4" aria-hidden /> Close shift
                      </button>
                    </>
                  )}
                </div>
              );
            })}
            {isToday && !register.loading && !register.session && canOpen && (
              <button type="button" onClick={() => { void goCash('open'); }}
                className="inline-flex items-center gap-2 rounded-xl border-2 border-dashed border-green-700 bg-card px-4 text-base font-black text-green-800 hover:bg-green-50 dark:text-green-300 dark:hover:bg-green-950">
                <LockOpen className="size-5" aria-hidden /> Open shift
              </button>
            )}
            {shifts.length > 0 && (
              <div style={{ borderColor: ALL.color, backgroundColor: sessionId === null ? ALL.soft : undefined }}
                className={`flex items-center gap-1.5 rounded-xl border-2 p-1 ${sessionId === null ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : 'bg-card'}`}>
                <button type="button" aria-pressed={sessionId === null} onClick={() => setSessionId(null)} style={{ color: ALL.ink }}
                  className="flex min-w-24 flex-col items-start rounded-lg px-2 py-1 text-start">
                  <span className="text-base font-black">All day</span>
                  <span className="text-xs font-semibold">{shifts.length} shift{shifts.length === 1 ? '' : 's'}</span>
                </button>
                {isToday && !register.loading && !register.session && (
                  <button type="button" onClick={dayClose.openCloseModal}
                    className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-blue-700 px-3 text-sm font-bold text-white hover:bg-blue-800">
                    <CalendarCheck className="size-4" aria-hidden /> Close day
                  </button>
                )}
              </div>
            )}
          </div>
          {sessionId === null && noShiftTickets.length > 0 && (
            <p className="flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-800 dark:bg-red-950 dark:text-red-200">
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              {noShiftTickets.length} order{noShiftTickets.length === 1 ? '' : 's'} taken without a shift ({usd(noShiftTickets.reduce((a, t) => a + t.totalCents, 0))})
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p.key} type="button" aria-pressed={period === p.key} onClick={() => choosePeriod(p.key)}
              style={{ borderColor: p.color, backgroundColor: period === p.key ? p.color : p.soft, color: period === p.key ? '#ffffff' : p.ink }}
              className="h-11 rounded-xl border-2 px-5 text-sm font-black tracking-wide">{p.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Previous" onClick={() => move(-1)} className="flex h-11 w-11 items-center justify-center rounded-xl border-2 border-border bg-card hover:bg-muted"><ChevronLeft size={22} /></button>
          <span className="min-w-40 text-center text-lg font-black text-foreground" data-testid="report-range">{rangeLabel(period, start, end)}</span>
          <button type="button" aria-label="Next" disabled={end >= todayIso() && period === 'today'} onClick={() => move(1)} className="flex h-11 w-11 items-center justify-center rounded-xl border-2 border-border bg-card hover:bg-muted disabled:opacity-40"><ChevronRight size={22} /></button>
          <span className="relative">
            <button type="button" aria-label="Pick a date" onClick={() => { try { dateInput.current?.showPicker(); } catch { dateInput.current?.focus(); } }}
              className="flex h-11 w-11 items-center justify-center rounded-xl border-2 border-border bg-card hover:bg-muted"><CalendarDays size={22} /></button>
            <input ref={dateInput} type="date" aria-label="Date" value={anchor} max={todayIso()} onChange={(e) => pickDate(e.target.value)}
              className="pointer-events-none absolute inset-0 opacity-0" tabIndex={-1} />
          </span>
        </div>
      </div>

      {loading ? (
        <div className={`${card} h-40 animate-pulse`} role="status" aria-live="polite"><span className="sr-only">Loading</span></div>
      ) : !data ? (
        <div className={`${card} text-center text-base font-semibold text-muted-foreground`}>{state?.error}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <div className={`${card} col-span-2`}>
              <p className="text-sm font-semibold text-muted-foreground">Total sales</p>
              <p className="mt-1 text-5xl font-black tabular-nums text-foreground" data-testid="report-total">{usd(data.sales.netCents)}</p>
              <p className="text-sm font-semibold text-muted-foreground">{data.sales.orders} orders{data.unpaid.count ? ` · ${data.unpaid.count} open` : ''}</p>
            </div>
            {bigBox('Cash', cash)}
            {bigBox('ACLEDA / QR', qr)}
            {bigBox('Card', cardPay)}
            {other.n > 0 && bigBox('Other', other)}
          </div>

          <div className="flex gap-1 overflow-x-auto border-b-2 border-border" role="tablist">
            {TABS.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
                className={`-mb-0.5 whitespace-nowrap border-b-4 px-5 py-2.5 text-base font-bold ${tab === t.key ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{t.label}</button>
            ))}
          </div>

          {tab === 'summary' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="max-w-lg">
                <div className={rowCls}><span>Opening float</span><span className="font-bold tabular-nums">{usd(data.cash.openingUsdCents)}{data.cash.openingKhrRiel ? ` + ${khr(data.cash.openingKhrRiel)}` : ''}</span></div>
                <div className={rowCls}><span>Cash expected</span><span className="font-bold tabular-nums">{usd(data.cash.expectedUsdCents)}{data.cash.expectedKhrRiel ? ` + ${khr(data.cash.expectedKhrRiel)}` : ''}</span></div>
                <div className={rowCls}><span>Cash counted</span><span className="font-bold tabular-nums">{data.cash.countedUsdCents == null ? 'not counted yet' : `${usd(data.cash.countedUsdCents)}${data.cash.countedKhrRiel ? ` + ${khr(data.cash.countedKhrRiel)}` : ''}`}</span></div>
                <div className={`${rowCls} text-lg font-black`}>
                  <span>Difference</span>
                  <span className={`tabular-nums ${data.cash.differenceUsdCents == null ? 'text-muted-foreground' : data.cash.differenceUsdCents < 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                    {data.cash.differenceUsdCents == null ? '—' : `${data.cash.differenceUsdCents > 0 ? '+' : ''}${usd(data.cash.differenceUsdCents)}`}
                  </span>
                </div>
                {data.cash.shiftsTotal > 1 && data.cash.shiftsCounted < data.cash.shiftsTotal && (
                  <p className="pt-1 text-sm text-muted-foreground">{data.cash.shiftsCounted} of {data.cash.shiftsTotal} shifts counted</p>
                )}
                <div className="flex justify-between gap-3 py-2.5 text-sm text-muted-foreground">
                  <span>Refunds · Discounts · Voids</span>
                  <span className="tabular-nums">{usd(data.sales.refundCents)} · {usd(data.sales.discountCents)} · {data.sales.voidCount}</span>
                </div>
              </div>
              {data.days.length > 0 && (
                <div>
                  <p className="mb-1 text-sm font-bold uppercase tracking-wide text-muted-foreground">Days</p>
                  {data.days.map((d) => (
                    <button key={d.date} type="button" onClick={() => { setPeriod('today'); setAnchor(d.date); setSessionId(null); }}
                      className="flex w-full justify-between border-b border-border py-2 text-start text-base hover:bg-muted">
                      <span>{parse(d.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} <span className="text-sm text-muted-foreground">· {d.orders} orders</span></span>
                      <span className="font-bold tabular-nums">{usd(d.netCents)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'items' && (
            <div className="max-w-2xl">
              <label className="relative mb-2 block max-w-sm">
                <Search size={18} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input value={itemSearch} onChange={(e) => setItemSearch(e.target.value)} placeholder="Search items"
                  className="h-11 w-full rounded-xl border-2 border-border bg-card ps-10 pe-3 text-base" />
              </label>
              <table className="w-full text-base">
                <thead><tr className="text-sm text-muted-foreground"><th className="py-2 text-start font-semibold">Item</th><th className="py-2 text-end font-semibold">Qty</th><th className="py-2 text-end font-semibold">Sales</th></tr></thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.label} className="border-t border-border"><td className="py-2">{i.label}</td><td className="py-2 text-end font-bold tabular-nums">{i.qty}</td><td className="py-2 text-end tabular-nums">{usd(i.netCents)}</td></tr>
                  ))}
                  {items.length === 0 && <tr><td colSpan={3} className="py-6 text-center text-muted-foreground">No items</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'tickets' && <OrderList orders={[...data.tickets].sort((a, b) => (a.status === b.status ? 0 : a.status === 'unpaid' ? -1 : 1))} tz={tz} />}

          {tab === 'payments' && (
            <div className="max-w-lg">
              {data.payments.map((p) => (
                <div key={p.label} className={rowCls}>
                  <span>{p.label} <span className="text-sm text-muted-foreground">· {p.count}</span></span>
                  <span className="font-bold tabular-nums">{usd(p.usdCents)}{p.khrRiel ? ` + ${khr(p.khrRiel)}` : ''}</span>
                </div>
              ))}
              {data.payments.length === 0 && <p className="py-6 text-center text-muted-foreground">No payments</p>}
              <div className={`${rowCls} text-lg font-black`}><span>Total</span><span className="tabular-nums">{usd(data.payments.reduce((n, p) => n + p.usdCents, 0))}</span></div>
            </div>
          )}

          <div className="flex flex-wrap gap-3 pt-2">
            <button type="button" disabled={busy !== null} onClick={print}
              style={{ backgroundColor: '#185FA5', color: '#ffffff' }}
              className="flex h-14 items-center gap-2 rounded-xl px-7 text-lg font-black disabled:opacity-50"><Printer size={22} />{busy === 'print' ? 'Printing…' : 'PRINT'}</button>
            {canTelegram && period === 'today' && (
              <button type="button" disabled={busy !== null} onClick={telegram}
                style={{ backgroundColor: '#3B6D11', color: '#ffffff' }}
                className="flex h-14 items-center gap-2 rounded-xl px-7 text-lg font-black disabled:opacity-50"><Send size={22} />{busy === 'tg' ? 'Sending…' : 'TELEGRAM'}</button>
            )}
          </div>
        </>
      )}
      <CashCloseModal model={dayClose} />
    </div>
  );
}
