'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { CalendarCheck, CircleCheck, Lock, LockOpen, TriangleAlert } from 'lucide-react';
import { usd, type DailyReportData, type ReportShiftRow } from '@print/shift-report-text';
import api from '@/lib/api';
import { businessDateInTimezone } from '@/lib/business-date';
import { tenantCan } from '@/lib/permissions';
import { useAuthStore } from '@/store/auth';
import { CashCloseModal } from '@/components/dashboard/CashCloseModal';
import { ReportOutputButtons } from '@/components/reports/ReportOutputButtons';
import { useCashClose } from '@/hooks/useCashClose';
import { useCashSession } from '@/hooks/useCashSession';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

const btn = 'inline-flex h-11 items-center gap-2 rounded-xl px-4 font-semibold';

function timeOf(stamp: string, timeZone: string): string {
  return new Date(`${stamp.replace(' ', 'T')}Z`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone });
}

/** "Day shift" before 15:00 local, otherwise "Evening shift". */
function shiftName(stamp: string, timeZone: string): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(`${stamp.replace(' ', 'T')}Z`)));
  return hour < 15 ? 'Day shift' : 'Evening shift';
}

function CountTag({ shift }: { shift: ReportShiftRow }) {
  if (shift.varianceUsdCents == null) return <span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">Closed · not counted</span>;
  const off = shift.varianceUsdCents !== 0 || (shift.varianceKhrRiel ?? 0) !== 0;
  if (!off) return <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-900">Closed · cash matched</span>;
  const word = shift.varianceUsdCents < 0 ? 'short' : 'over';
  return <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-900">Closed · {word} {usd(Math.abs(shift.varianceUsdCents))}</span>;
}

/**
 * Today at a glance on Reports: every shift of the business day in order, the
 * open one with Close shift, an Open shift button when none is
 * open, Close day once everything is closed, and orders taken with no shift in red.
 */
export function RegisterStatus() {
  const router = useRouter();
  const { currentTenant } = useAuthStore();
  const shift = useCashSession();
  const dayClose = useCashClose();
  const fmt = useFormatCurrency();
  const timeZone = currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const businessDate = businessDateInTimezone(timeZone, currentTenant?.business_day_start_time || '00:00');
  const canOpen = tenantCan(currentTenant, 'cash.shifts.open');
  const canClose = tenantCan(currentTenant, 'cash.shifts.close');
  const [day, setDay] = useState<DailyReportData | null>(null);

  const loadDay = useCallback(async () => {
    try {
      const { data } = await api.get('/reports/daily-report', { params: { date: businessDate } });
      setDay(data as DailyReportData);
    } catch { /* the timeline still shows the open shift from the cash session */ }
  }, [businessDate]);
  useEffect(() => {
    const first = setTimeout(() => { void loadDay(); }, 0);
    const timer = setInterval(() => { void loadDay(); }, 60_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [loadDay]);

  /** Re-check the shift before going to a cash screen; someone may have opened or closed it meanwhile. */
  const goCash = async (entry: 'open' | 'close') => {
    const result = await shift.refresh();
    if (result.status !== 'ok') return;
    if (result.error) { toast.error(result.error); return; }
    if (entry === 'open' && result.session) { toast('A shift is already open'); void loadDay(); return; }
    if (entry !== 'open' && !result.session) { toast('No shift is open any more'); void loadDay(); return; }
    router.push(`/cash?go=${entry}&from=reports`);
  };

  if (shift.loading && !day) {
    return <div className="mb-5 h-40 animate-pulse rounded-2xl border-2 border-border bg-muted" aria-label="Loading today's shifts" />;
  }

  const session = shift.session;
  const shifts = day?.shifts ?? [];
  const closedShifts = shifts.filter((s) => s.closedAt && s.id !== session?.id);
  const openRow = session ? shifts.find((s) => s.id === session.id) : undefined;
  const noShiftOrders = (day?.orders ?? []).filter((o) => o.shiftId == null);
  const noShiftCents = noShiftOrders.reduce((sum, o) => sum + o.totalCents, 0);
  const dateLabel = new Date(`${businessDate}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  return (
    <>
      <section aria-label="Today's shifts" className="mb-5 rounded-2xl border-2 border-border bg-card p-4">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">Today · {dateLabel}</h2>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${session ? 'bg-amber-100 text-amber-900' : 'bg-green-100 text-green-900'}`}>
            {session ? 'Register open' : 'Register closed'}
          </span>
        </div>

        {closedShifts.map((s) => (
          <div key={s.id} className="mt-2 flex flex-wrap items-center gap-3 rounded-xl bg-muted/60 p-3">
            <CircleCheck className="size-6 shrink-0 text-green-700" aria-hidden />
            <div className="min-w-44 flex-1">
              <div className="font-semibold">{shiftName(s.openedAt, timeZone)} · {s.cashier}</div>
              <div className="text-xs text-muted-foreground">{timeOf(s.openedAt, timeZone)} – {s.closedAt ? timeOf(s.closedAt, timeZone) : ''} · {s.orders} orders · {usd(s.netCents)}</div>
            </div>
            <CountTag shift={s} />
            <ReportOutputButtons target={{ kind: 'shift', sessionId: s.id }} size="sm" telegram={false} />
          </div>
        ))}

        {session ? (
          <div className="mt-2 flex flex-wrap items-center gap-3 rounded-xl border-2 border-amber-500 bg-amber-50 p-3 text-amber-950 dark:bg-amber-950 dark:text-amber-100">
            <LockOpen className="size-6 shrink-0" aria-hidden />
            <div className="min-w-44 flex-1">
              <div className="font-semibold">{shiftName(session.opened_at, timeZone)} · {session.opened_by_name}</div>
              <div className="text-xs">
                since {timeOf(session.opened_at, timeZone)} · float {fmt(session.opening_float_cents / shift.minorFactor)}
                {openRow ? ` · ${openRow.orders} orders · ${usd(openRow.netCents)} so far` : ''}
              </div>
            </div>
            <span className="rounded-full bg-amber-600 px-3 py-1 text-xs font-bold text-white">Open now</span>
            {canClose && (
              <>
                <button type="button" onClick={() => { void goCash('close'); }} className={`${btn} bg-amber-700 text-white hover:bg-amber-800`}>
                  <Lock className="size-4" aria-hidden /> Close shift
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-3 rounded-xl border-2 border-green-700 bg-green-50 p-3 text-green-950 dark:bg-green-950 dark:text-green-100">
            <Lock className="size-6 shrink-0" aria-hidden />
            <div className="min-w-44 flex-1">
              <div className="font-semibold">No shift open</div>
              <div className="text-xs">Open one and count the float before taking orders.</div>
            </div>
            {canOpen && (
              <button type="button" onClick={() => { void goCash('open'); }} className={`${btn} h-12 bg-green-700 px-6 text-lg text-white hover:bg-green-800`}>
                <LockOpen className="size-5" aria-hidden /> Open shift
              </button>
            )}
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-xl border-2 border-dashed border-border p-3">
          <CalendarCheck className="size-6 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-44 flex-1">
            <div className="font-semibold">Close day</div>
            <div className="text-xs text-muted-foreground">{session ? 'After the last shift closes' : 'All shifts closed: close the day'}</div>
          </div>
          <button type="button" disabled={!!session} onClick={dayClose.openCloseModal}
            title={session ? 'Close the open shift first' : undefined}
            className={`${btn} bg-blue-700 text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50`}>
            <Lock className="size-4" aria-hidden /> Close day
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
          {day && <span>Today so far <b className="text-foreground">{usd(day.sales.netCents)}</b></span>}
          {day && <span>{day.sales.orders} orders</span>}
          {noShiftOrders.length > 0 ? (
            <span className="inline-flex items-center gap-1 font-semibold text-red-700">
              <TriangleAlert className="size-4" aria-hidden /> {noShiftOrders.length} orders without a shift ({usd(noShiftCents)})
            </span>
          ) : day ? <span>No orders without a shift</span> : null}
        </div>
      </section>
      <CashCloseModal model={dayClose} />
    </>
  );
}
