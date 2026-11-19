'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Download, Minus, Printer } from 'lucide-react';
import { useTranslations, type AppConfig } from 'use-intl';
import api from '@/lib/api';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { PAYMENT_METHODS } from '@/lib/payment-methods';
import { Ltr } from '@/components/layout/Ltr';
import { useAuthStore } from '@/store/auth';
import WeeklySales from '@/components/reports/WeeklySales';
import CogsReport from '@/components/reports/CogsReport';

type PosKey = keyof AppConfig['Messages']['pos'];
type Preset = 'today' | 'thisWeek' | 'thisMonth' | 'custom';

interface Summary { orders: number; netSales: number; discounts: number; discountedOrders: number; averageBill: number }
interface ReportItem { productId: string; name: string; category: string | null; onMenu: boolean; quantity: number; orders: number; net: number; cost?: number | null; profit?: number | null }
interface PeriodReport {
  period: { startDate: string; endDate: string; days: number };
  summary: Summary;
  previous: Summary;
  daily: { date: string; orders: number; sales: number }[];
  hourly: { hour: number; orders: number; sales: number }[];
  paymentMethods: { method: string; count: number; total: number }[];
  categories: { name: string | null; quantity: number; net: number }[];
  items: ReportItem[];
  canViewFinancials: boolean;
}

const BUILT_IN_PAYMENT_KEYS = { cash: 'methodCash', card: 'methodCard' } as const satisfies Record<'cash' | 'card', PosKey>;
const TOP_ITEMS = 10;

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function presetRange(preset: Exclude<Preset, 'custom'>): [string, string] {
  const today = new Date();
  if (preset === 'today') return [isoDate(today), isoDate(today)];
  if (preset === 'thisWeek') {
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    return [isoDate(monday), isoDate(today)];
  }
  return [isoDate(new Date(today.getFullYear(), today.getMonth(), 1)), isoDate(today)];
}

function csvCell(value: string | number | null | undefined): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function Bars({ rows, format }: { rows: { label: string; value: number; title: string }[]; format: (n: number) => string }) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  return (
    <div className="flex h-44 items-end gap-1.5" role="list">
      {rows.map((row) => (
        <div key={row.label} role="listitem" className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1" title={`${row.title}: ${format(row.value)}`}>
          <div className="print-bar w-full max-w-10 rounded-t-md bg-foreground" style={{ height: `${max > 0 ? Math.max((row.value / max) * 100, row.value > 0 ? 2 : 0) : 0}%` }} />
          <span className="w-full truncate text-center text-[11px] font-semibold text-muted-foreground">{row.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function ReportsPage() {
  const t = useTranslations('reports');
  const tDash = useTranslations('dashboard');
  const tPos = useTranslations('pos');
  const tCommon = useTranslations('common');
  const tOrders = useTranslations('orders');
  const fmt = useFormatCurrency();
  const businessName = useAuthStore((s) => s.currentTenant?.business_name);
  const [preset, setPreset] = useState<Preset>('thisWeek');
  const [range, setRange] = useState<[string, string]>(() => presetRange('thisWeek'));
  const [result, setResult] = useState<{ key: string; report: PeriodReport | null; failed: boolean } | null>(null);
  const [lastReport, setLastReport] = useState<PeriodReport | null>(null);
  const [showAllItems, setShowAllItems] = useState(false);
  const rangeKey = `${range[0]}|${range[1]}`;
  const validRange = Boolean(range[0] && range[1] && range[0] <= range[1]);
  const loading = validRange && result?.key !== rangeKey;
  const failed = !loading && Boolean(result?.failed);
  const report = loading ? lastReport : result?.report ?? null;

  useEffect(() => {
    if (!validRange) return;
    let cancelled = false;
    api.get('/reports/period', { params: { start_date: range[0], end_date: range[1] } })
      .then(({ data }) => {
        if (cancelled) return;
        setResult({ key: rangeKey, report: data as PeriodReport, failed: false });
        setLastReport(data as PeriodReport);
      })
      .catch(() => { if (!cancelled) setResult({ key: rangeKey, report: null, failed: true }); });
    return () => { cancelled = true; };
  }, [rangeKey, validRange, range]);

  const choosePreset = (next: Preset) => {
    setPreset(next);
    if (next !== 'custom') setRange(presetRange(next));
  };

  const dayLabel = (date: string, days: number) => {
    const d = new Date(`${date}T12:00:00`);
    return days <= 7
      ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
      : String(d.getDate());
  };

  const formatDay = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  const paymentLabel = (method: string) => {
    const meta = PAYMENT_METHODS.find((m) => m.key === method);
    return meta ? tPos(BUILT_IN_PAYMENT_KEYS[meta.key]) : method === 'wallet' ? tPos('methodWallet') : method;
  };

  const costed = useMemo(() => (report?.items ?? []).filter((i) => i.cost != null), [report]);
  const missingCost = (report?.items ?? []).filter((i) => i.onMenu && i.cost == null).length;
  const paymentTotal = (report?.paymentMethods ?? []).reduce((sum, p) => sum + Number(p.total || 0), 0);

  const exportCsv = () => {
    if (!report) return;
    const lines = [
      [t('item'), tDash('topCategories'), t('quantity'), tDash('orders'), t('net'), ...(report.canViewFinancials ? [t('cost'), t('profit')] : [])].map(csvCell).join(','),
      ...report.items.map((i) => [i.name, i.category ?? t('notOnMenu'), i.quantity, i.orders, i.net.toFixed(2),
        ...(report.canViewFinancials ? [i.cost == null ? '' : i.cost.toFixed(2), i.profit == null ? '' : i.profit.toFixed(2)] : [])].map(csvCell).join(',')),
      '',
      [t('salesByDay'), tDash('orders'), t('netSales')].map(csvCell).join(','),
      ...report.daily.map((d) => [d.date, d.orders, d.sales.toFixed(2)].map(csvCell).join(',')),
    ];
    const blob = new Blob([`﻿${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `sales-report-${report.period.startDate}-to-${report.period.endDate}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const change = (current: number, previous: number) => {
    if (previous <= 0) return null;
    const percent = Math.round(((current - previous) / previous) * 100);
    if (percent === 0) return <span className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground"><Minus size={12} />{t('noChangeVsPrevious')}</span>;
    const up = percent > 0;
    return (
      <span className={`inline-flex items-center gap-1 text-xs font-semibold ${up ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
        {up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
        {t('changeVsPrevious', { percent: `${up ? '+' : ''}${percent}` })}
      </span>
    );
  };

  const card = 'rounded-2xl border-2 border-border bg-card p-5';
  const heading = 'mb-4 text-base font-bold text-foreground';

  return (
    <div className="print-report mx-auto w-full max-w-7xl p-4 sm:p-6">
      {report && (
        <div className="mb-4 hidden border-b-2 border-border pb-3 print:block">
          {businessName && <p className="text-sm font-semibold">{businessName}</p>}
          <p className="text-xl font-bold">{t('title')} · {formatDay(report.period.startDate)}{report.period.endDate !== report.period.startDate ? ` – ${formatDay(report.period.endDate)}` : ''}</p>
          <p className="text-xs">{tOrders('printed')} {new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</p>
        </div>
      )}
      <WeeklySales />
      <div className="mb-6 flex flex-wrap items-center gap-3 print:hidden">
        <h1 className="me-2 text-2xl font-bold text-foreground">{t('title')}</h1>
        <div className="flex h-10 rounded-xl border-2 border-border bg-card p-1" role="group" aria-label={t('periodView')}>
          {(['today', 'thisWeek', 'thisMonth', 'custom'] as const).map((key) => (
            <button key={key} type="button" onClick={() => choosePreset(key)} aria-pressed={preset === key}
              className={`rounded-lg px-3 text-sm font-semibold transition-colors ${preset === key ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}>
              {t(key)}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">{t('startDate')}
              <input type="date" value={range[0]} max={range[1]} onChange={(e) => setRange([e.target.value, range[1]])} className="h-10 rounded-xl border-2 border-border bg-card px-2 text-foreground" />
            </label>
            <label className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">{t('endDate')}
              <input type="date" value={range[1]} min={range[0]} onChange={(e) => setRange([range[0], e.target.value])} className="h-10 rounded-xl border-2 border-border bg-card px-2 text-foreground" />
            </label>
          </div>
        )}
        <span className="flex-1" />
        <button type="button" onClick={exportCsv} disabled={!report || report.items.length === 0}
          className="inline-flex h-10 items-center gap-2 rounded-xl border-2 border-border bg-card px-4 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50">
          <Download size={15} />{tDash('exportCsv')}
        </button>
        <button type="button" onClick={() => window.print()} disabled={!report}
          className="inline-flex h-10 items-center gap-2 rounded-xl border-2 border-border bg-card px-4 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50">
          <Printer size={15} />{tCommon('print')}
        </button>
      </div>

      {report?.canViewFinancials && validRange && <CogsReport startDate={range[0]} endDate={range[1]} />}

      {loading && !report ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4" role="status" aria-live="polite">
          <span className="sr-only">{tCommon('loading')}</span>
          {[0, 1, 2, 3].map((n) => <div key={n} aria-hidden="true" className="h-32 animate-pulse rounded-2xl border-2 border-border bg-card" />)}
        </div>
      ) : failed || !report ? (
        <div className={`${card} text-center text-sm font-medium text-muted-foreground`}>{t('loadFailed')}</div>
      ) : (
        <div className={`space-y-4 ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[
              { label: t('netSales'), value: fmt(report.summary.netSales), sub: change(report.summary.netSales, report.previous.netSales) },
              { label: tDash('orders'), value: String(report.summary.orders), sub: change(report.summary.orders, report.previous.orders) },
              { label: tDash('aov'), value: fmt(report.summary.averageBill), sub: report.previous.orders > 0 ? <span className="text-xs font-semibold text-muted-foreground">{t('previousValue', { value: fmt(report.previous.averageBill) })}</span> : null },
              { label: t('discounts'), value: fmt(report.summary.discounts), sub: <span className="text-xs font-semibold text-muted-foreground">{t('discountedBills', { count: report.summary.discountedOrders })}</span> },
            ].map((tile) => (
              <div key={tile.label} className={card}>
                <p className="text-sm font-semibold text-muted-foreground">{tile.label}</p>
                <p className="mt-2 text-3xl font-bold tracking-tight text-foreground"><Ltr>{tile.value}</Ltr></p>
                <div className="mt-2 min-h-5">{tile.sub}</div>
              </div>
            ))}
          </div>

          {report.summary.orders === 0 ? (
            <div className={`${card} text-center text-sm font-medium text-muted-foreground`}>{t('noSales')}</div>
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-3">
                <section className={`${card} lg:col-span-2`}>
                  <h2 className={heading}>{t('salesByDay')}</h2>
                  <Bars format={fmt} rows={report.daily.map((d) => ({ label: dayLabel(d.date, report.period.days), title: d.date, value: d.sales }))} />
                </section>
                <section className={card}>
                  <h2 className={heading}>{tDash('paymentMethods')}</h2>
                  <table className="w-full text-sm">
                    <tbody>
                      {report.paymentMethods.map((p) => (
                        <tr key={p.method} className="border-t border-border first:border-t-0">
                          <td className="py-2 font-semibold text-foreground">{paymentLabel(p.method)}</td>
                          <td className="py-2 text-end font-semibold text-foreground"><Ltr>{fmt(p.total)}</Ltr></td>
                          <td className="w-12 py-2 text-end text-muted-foreground">{paymentTotal > 0 ? `${Math.round((p.total / paymentTotal) * 100)}%` : ''}</td>
                        </tr>
                      ))}
                      <tr className="border-t-2 border-border">
                        <td className="py-2 font-bold text-foreground">{tCommon('total')}</td>
                        <td className="py-2 text-end font-bold text-foreground"><Ltr>{fmt(paymentTotal)}</Ltr></td>
                        <td />
                      </tr>
                    </tbody>
                  </table>
                </section>
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                <section className={`${card} lg:col-span-2`}>
                  <h2 className={heading}>{tDash('topProducts')}</h2>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs font-semibold text-muted-foreground">
                          <th className="pb-2 text-start">{t('item')}</th>
                          <th className="w-16 pb-2 text-end">{t('quantity')}</th>
                          <th className="w-24 pb-2 text-end">{t('net')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.items.map((i, index) => (
                          <tr key={`${i.productId}-${i.name}`} className={`border-t border-border ${!showAllItems && index >= TOP_ITEMS ? 'hidden print:table-row' : ''}`}>
                            <td className="py-2 font-semibold text-foreground">
                              {i.name}
                              {!i.onMenu && <span className="ms-2 text-xs font-medium text-muted-foreground">{t('notOnMenu')}</span>}
                            </td>
                            <td className="py-2 text-end text-foreground">{Math.round(i.quantity * 100) / 100}</td>
                            <td className="py-2 text-end font-semibold text-foreground"><Ltr>{fmt(i.net)}</Ltr></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {report.items.length > TOP_ITEMS && (
                    <button type="button" onClick={() => setShowAllItems((v) => !v)} className="mt-3 text-sm font-semibold text-foreground underline underline-offset-4 print:hidden">
                      {showAllItems ? t('showLess') : t('showAll', { count: report.items.length })}
                    </button>
                  )}
                </section>
                <section className={card}>
                  <h2 className={heading}>{t('salesByCategory')}</h2>
                  <div className="space-y-3">
                    {report.categories.map((c) => {
                      const max = report.categories[0]?.net || 1;
                      return (
                        <div key={c.name ?? '_none'}>
                          <div className="mb-1 flex justify-between gap-2 text-sm">
                            <span className="truncate font-semibold text-foreground">{c.name ?? t('notOnMenu')}</span>
                            <span className="shrink-0 font-semibold text-foreground"><Ltr>{fmt(c.net)}</Ltr></span>
                          </div>
                          <div className="print-track h-2 overflow-hidden rounded-full bg-muted">
                            <div className="print-bar h-full rounded-full bg-foreground" style={{ width: `${Math.max((c.net / max) * 100, 0)}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                <section className={`${card} lg:col-span-2`}>
                  <h2 className={heading}>{t('salesByHour')}</h2>
                  <Bars format={fmt} rows={(() => {
                    const active = report.hourly.filter((h) => h.orders > 0).map((h) => h.hour);
                    const from = active.length ? Math.min(...active) : 0;
                    const to = active.length ? Math.max(...active) : 23;
                    return report.hourly.slice(from, to + 1).map((h) => ({ label: String(h.hour), title: `${String(h.hour).padStart(2, '0')}:00`, value: h.sales }));
                  })()} />
                </section>
                {report.canViewFinancials && (
                  <section className={card}>
                    <h2 className={heading}>{t('profitByItem')}</h2>
                    {costed.length === 0 ? (
                      <p className="text-sm font-medium text-muted-foreground">{t('profitNeedsCosts')}</p>
                    ) : (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-xs font-semibold text-muted-foreground">
                            <th className="pb-2 text-start">{t('item')}</th>
                            <th className="pb-2 text-end">{t('profit')}</th>
                            <th className="w-14 pb-2 text-end">{t('margin')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...costed].sort((a, b) => Number(b.profit) - Number(a.profit)).slice(0, TOP_ITEMS).map((i) => (
                            <tr key={i.productId} className="border-t border-border">
                              <td className="py-2 font-semibold text-foreground">{i.name}</td>
                              <td className="py-2 text-end font-semibold text-foreground"><Ltr>{fmt(Number(i.profit))}</Ltr></td>
                              <td className="py-2 text-end text-muted-foreground">{i.net > 0 ? `${Math.round((Number(i.profit) / i.net) * 100)}%` : ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {missingCost > 0 && costed.length > 0 && (
                      <p className="mt-3 text-xs font-semibold text-amber-700 dark:text-amber-400">{t('itemsWithoutCost', { count: missingCost })}</p>
                    )}
                  </section>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
