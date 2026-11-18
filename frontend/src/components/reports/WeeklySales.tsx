'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations, type AppConfig } from 'use-intl';
import api from '@/lib/api';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { PAYMENT_METHODS } from '@/lib/payment-methods';
import { Ltr } from '@/components/layout/Ltr';

type PosKey = keyof AppConfig['Messages']['pos'];
const BUILT_IN_PAYMENT_KEYS = { cash: 'methodCash', card: 'methodCard' } as const satisfies Record<'cash' | 'card', PosKey>;

interface WeekRow {
  date: string; orders: number; gross: number; refunds: number; discounts: number; net: number; lastWeekNet?: number;
  payments: Record<string, number>; cost?: number | null; grossProfit?: number | null; averageBill?: number;
}
interface WeeklyReport {
  weekStart: string; weekEnd: string; paymentMethods: string[]; days: WeekRow[]; total: WeekRow;
  previous: { orders: number; net: number; averageBill: number; grossProfit?: number };
  uncostedLines?: number; canViewFinancials: boolean;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftWeek(date: string, weeks: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + weeks * 7);
  return isoDate(d);
}

const percentChange = (current: number, previous: number) => (previous > 0 ? Math.round(((current - previous) / previous) * 100) : null);

export default function WeeklySales() {
  const t = useTranslations('reports');
  const tDash = useTranslations('dashboard');
  const tPos = useTranslations('pos');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const [weekOf, setWeekOf] = useState(() => isoDate(new Date()));
  const [result, setResult] = useState<{ key: string; report: WeeklyReport | null } | null>(null);
  const [showPay, setShowPay] = useState(true);
  const [showCost, setShowCost] = useState(true);

  const loading = result?.key !== weekOf;
  const report = result?.report ?? null;

  useEffect(() => {
    let cancelled = false;
    api.get('/reports/weekly', { params: { week_start: weekOf } })
      .then(({ data }) => { if (!cancelled) setResult({ key: weekOf, report: data as WeeklyReport }); })
      .catch(() => { if (!cancelled) setResult({ key: weekOf, report: null }); });
    return () => { cancelled = true; };
  }, [weekOf]);

  const money = (n: number) => (n ? <Ltr>{fmt(n)}</Ltr> : <span className="text-muted-foreground">–</span>);
  const dayLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  const rangeLabel = (r: WeeklyReport) => {
    const start = new Date(`${r.weekStart}T12:00:00`);
    const end = new Date(`${r.weekEnd}T12:00:00`);
    return `${start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} – ${end.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`;
  };
  const paymentLabel = (method: string) => {
    const meta = PAYMENT_METHODS.find((m) => m.key === method);
    return meta ? tPos(BUILT_IN_PAYMENT_KEYS[meta.key]) : method === 'wallet' ? tPos('methodWallet') : method;
  };
  const changeBadge = (current: number, previous: number | undefined, label: (percent: string) => string, flat: string) => {
    const percent = previous === undefined ? null : percentChange(current, previous);
    if (percent === null) return <span className="text-muted-foreground">–</span>;
    if (percent === 0) return <span className="text-xs font-semibold text-muted-foreground">{flat}</span>;
    const up = percent > 0;
    return <span className={`text-xs font-semibold ${up ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{label(`${up ? '+' : '−'}${Math.abs(percent)}`)}</span>;
  };
  const rowChange = (row: WeekRow) => changeBadge(row.net, row.lastWeekNet, (p) => `${p}%`, '0%');

  const card = 'rounded-2xl border-2 border-border bg-card p-5';
  const showCostCols = Boolean(report?.canViewFinancials) && showCost;
  const hasCost = report?.total.cost != null;
  const cell = 'px-2 py-2 text-end tabular-nums whitespace-nowrap';
  const payCell = `${cell} bg-muted/50`;

  const toggle = (on: boolean, set: (v: boolean) => void, label: string) => (
    <button type="button" aria-pressed={on} onClick={() => set(!on)}
      className={`rounded-lg border-2 px-3 py-1 text-sm font-semibold ${on ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:bg-muted'}`}>
      {label}
    </button>
  );

  return (
    <section className="mb-8 space-y-4" aria-busy={loading}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="me-2 text-2xl font-bold text-foreground">{t('weeklySales')}</h2>
        <div className="flex items-center gap-1 print:hidden">
          <button type="button" onClick={() => setWeekOf(shiftWeek(weekOf, -1))} aria-label={t('previousWeek')}
            className="flex size-10 items-center justify-center rounded-xl border-2 border-border bg-card text-foreground hover:bg-muted"><ChevronLeft size={18} className="rtl:rotate-180" /></button>
          <button type="button" onClick={() => setWeekOf(isoDate(new Date()))}
            className="h-10 rounded-xl border-2 border-border bg-card px-3 text-sm font-semibold text-foreground hover:bg-muted">{t('thisWeek')}</button>
          <button type="button" onClick={() => setWeekOf(shiftWeek(weekOf, 1))} aria-label={t('nextWeek')}
            className="flex size-10 items-center justify-center rounded-xl border-2 border-border bg-card text-foreground hover:bg-muted"><ChevronRight size={18} className="rtl:rotate-180" /></button>
        </div>
        {report && <span className="text-base font-semibold text-foreground">{rangeLabel(report)}</span>}
      </div>

      {!report ? (
        <div className={`${card} ${loading ? 'h-64 animate-pulse' : 'text-center text-sm font-medium text-muted-foreground'}`}>
          {loading ? <span className="sr-only">{tCommon('loading')}</span> : t('loadFailed')}
        </div>
      ) : (
        <div className={`space-y-4 ${loading ? 'opacity-60' : ''}`}>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[
              { label: t('netSales'), value: fmt(report.total.net), sub: changeBadge(report.total.net, report.previous.net, (p) => t('vsLastWeek', { percent: p }), t('noChangeVsLastWeek')) },
              { label: tDash('orders'), value: String(report.total.orders), sub: changeBadge(report.total.orders, report.previous.orders, (p) => t('vsLastWeek', { percent: p }), t('noChangeVsLastWeek')) },
              { label: tDash('aov'), value: fmt(report.total.averageBill ?? 0), sub: report.previous.orders > 0 ? <span className="text-xs font-semibold text-muted-foreground">{t('lastWeekValue', { value: fmt(report.previous.averageBill) })}</span> : null },
              ...(report.canViewFinancials ? [{
                label: t('grossProfit'),
                value: hasCost ? fmt(Number(report.total.grossProfit)) : '—',
                sub: hasCost
                  ? changeBadge(Number(report.total.grossProfit), report.previous.grossProfit, (p) => t('vsLastWeek', { percent: p }), t('noChangeVsLastWeek'))
                  : <span className="text-xs font-semibold text-muted-foreground">{t('needsItemCosts')}</span>,
              }] : []),
            ].map((tile) => (
              <div key={tile.label} className={card}>
                <p className="text-sm font-semibold text-muted-foreground">{tile.label}</p>
                <p className="mt-2 text-3xl font-bold tracking-tight text-foreground"><Ltr>{tile.value}</Ltr></p>
                <div className="mt-2 min-h-5">{tile.sub}</div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <span className="text-sm font-semibold text-muted-foreground">{t('show')}</span>
            <span className="rounded-lg border-2 border-foreground bg-foreground px-3 py-1 text-sm font-semibold text-background">{t('sales')}</span>
            {toggle(showPay, setShowPay, t('paidBy'))}
            {report.canViewFinancials && toggle(showCost, setShowCost, t('costAndProfit'))}
          </div>

          <div className={`${card} overflow-x-auto`}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs font-semibold text-muted-foreground">
                  <th className="px-2 pb-2 text-start">{t('day')}</th>
                  <th className="px-2 pb-2 text-end">{tDash('orders')}</th>
                  <th className="px-2 pb-2 text-end">{t('gross')}</th>
                  <th className="px-2 pb-2 text-end">{t('refunds')}</th>
                  <th className="px-2 pb-2 text-end">{t('discountsShort')}</th>
                  <th className="px-2 pb-2 text-end">{t('netSales')}</th>
                  <th className="px-2 pb-2 text-end" title={t('sameDayHint')}>{t('vsSameDayLastWeek')}</th>
                  {showPay && report.paymentMethods.map((m) => <th key={m} className="bg-muted/50 px-2 pb-2 text-end">{paymentLabel(m)}</th>)}
                  {showCostCols && <>
                    <th className="px-2 pb-2 text-end">{t('costOfGoods')}</th>
                    <th className="px-2 pb-2 text-end">{t('grossProfit')}</th>
                    <th className="px-2 pb-2 text-end">{t('margin')}</th>
                  </>}
                </tr>
              </thead>
              <tbody>
                {[...report.days, report.total].map((row, index) => {
                  const isTotal = index === report.days.length;
                  const margin = row.grossProfit != null && row.net > 0 ? `${Math.round((row.grossProfit / row.net) * 100)}%` : '—';
                  return (
                    <tr key={isTotal ? 'total' : row.date} className={isTotal ? 'border-t-2 border-foreground font-bold' : 'border-t border-border'}>
                      <td className="px-2 py-2 font-semibold text-foreground whitespace-nowrap">{isTotal ? tCommon('total') : dayLabel(row.date)}</td>
                      <td className={cell}>{row.orders || <span className="text-muted-foreground">–</span>}</td>
                      <td className={cell}>{money(row.gross)}</td>
                      <td className={cell}>{money(row.refunds)}</td>
                      <td className={cell}>{money(row.discounts)}</td>
                      <td className={`${cell} font-bold text-foreground`}>{money(row.net)}</td>
                      <td className={cell}>{rowChange(row)}</td>
                      {showPay && report.paymentMethods.map((m) => <td key={m} className={payCell}>{money(row.payments[m] ?? 0)}</td>)}
                      {showCostCols && <>
                        <td className={cell}>{row.cost != null ? money(row.cost) : <span className="text-muted-foreground">—</span>}</td>
                        <td className={cell}>{row.grossProfit != null ? money(row.grossProfit) : <span className="text-muted-foreground">—</span>}</td>
                        <td className={`${cell} text-muted-foreground`}>{margin}</td>
                      </>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-3 text-xs font-medium text-muted-foreground">
              {t('sameDayHint')}
              {showCostCols && !hasCost && ` ${t('profitNeedsCosts')}`}
              {showCostCols && hasCost && Number(report.uncostedLines) > 0 && ` ${t('itemsWithoutCost', { count: Number(report.uncostedLines) })}`}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
