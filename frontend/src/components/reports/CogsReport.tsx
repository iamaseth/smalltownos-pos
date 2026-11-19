'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Download } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { Ltr } from '@/components/layout/Ltr';

interface CogsItem {
  productId: string; name: string; category: string | null; quantity: number; net: number;
  unitCost: number | null; cost: number | null; profit: number | null; previousMargin: number | null;
}
interface CogsTotals {
  sales: number; costedSales: number; cost: number; grossProfit: number; margin: number | null;
  costPercent: number | null; uncostedSales: number; uncostedItems: number;
}
interface CogsReport {
  period: { startDate: string; endDate: string };
  totals: CogsTotals;
  previous: CogsTotals;
  items: CogsItem[];
  trendBy: 'week' | 'month';
  trend: { start: string; end: string; costedSales: number; cost: number; costPercent: number | null }[];
}
type SortKey = 'sales' | 'profit' | 'margin' | 'cost';

const LOW_MARGIN = 55;
const VISIBLE_ROWS = 15;
const marginOf = (item: CogsItem) => (item.profit !== null && item.net > 0 ? (item.profit / item.net) * 100 : null);

export default function CogsReport({ startDate, endDate }: { startDate: string; endDate: string }) {
  const t = useTranslations('reports');
  const tDash = useTranslations('dashboard');
  const fmt = useFormatCurrency();
  const [trendBy, setTrendBy] = useState<'week' | 'month'>('week');
  const [category, setCategory] = useState('');
  const [sort, setSort] = useState<SortKey>('sales');
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<{ key: string; report: CogsReport | null } | null>(null);
  const key = `${startDate}|${endDate}|${trendBy}`;
  const report = result?.report ?? null;
  const loading = result?.key !== key;

  useEffect(() => {
    let cancelled = false;
    api.get('/reports/cogs', { params: { start_date: startDate, end_date: endDate, trend: trendBy } })
      .then(({ data }) => { if (!cancelled) setResult({ key, report: data as CogsReport }); })
      .catch(() => { if (!cancelled) setResult({ key, report: null }); });
    return () => { cancelled = true; };
  }, [key, startDate, endDate, trendBy]);

  const categories = useMemo(
    () => [...new Set((report?.items ?? []).map((i) => i.category).filter((c): c is string => Boolean(c)))].sort(),
    [report],
  );
  const rows = useMemo(() => {
    const list = (report?.items ?? []).filter((i) => !category || i.category === category);
    const costed = list.filter((i) => i.cost !== null);
    const value = (i: CogsItem) => (sort === 'profit' ? i.profit ?? 0 : sort === 'margin' ? marginOf(i) ?? 0 : sort === 'cost' ? i.cost ?? 0 : i.net);
    return { costed: [...costed].sort((a, b) => value(b) - value(a)), uncosted: list.filter((i) => i.cost === null) };
  }, [report, category, sort]);

  const filteredTotals = useMemo(() => {
    const sales = rows.costed.reduce((sum, i) => sum + i.net, 0);
    const cost = rows.costed.reduce((sum, i) => sum + (i.cost ?? 0), 0);
    return { sales, cost, profit: sales - cost, margin: sales > 0 ? ((sales - cost) / sales) * 100 : null };
  }, [rows]);

  const exportCsv = () => {
    if (!report) return;
    const cell = (v: string | number) => {
      const text = String(v);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [[t('item'), tDash('topCategories'), t('quantity'), t('sales'), t('costEach'), t('totalCost'), t('grossProfit'), t('margin')].map(cell).join(',')];
    for (const i of [...rows.costed, ...rows.uncosted]) {
      const margin = marginOf(i);
      lines.push([i.name, i.category ?? '', i.quantity, i.net.toFixed(2), i.unitCost === null ? '' : i.unitCost.toFixed(2),
        i.cost === null ? '' : i.cost.toFixed(2), i.profit === null ? '' : i.profit.toFixed(2), margin === null ? '' : `${Math.round(margin)}%`].map(cell).join(','));
    }
    const blob = new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `cost-of-goods-${report.period.startDate}-to-${report.period.endDate}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const card = 'rounded-2xl border-2 border-border bg-card p-4 print:break-inside-avoid';
  const tile = 'rounded-xl bg-muted/60 p-3';
  const trendMax = Math.max(1, ...(report?.trend ?? []).map((b) => b.costPercent ?? 0));
  const trendLabel = (start: string) => new Date(`${start}T12:00:00`).toLocaleDateString(undefined, trendBy === 'week' ? { day: 'numeric', month: 'short' } : { month: 'short' });

  const change = (current: number | null, previous: number | null, invert = false) => {
    if (current === null || previous === null) return null;
    const points = Math.round(current - previous);
    if (points === 0) return <span className="text-xs font-medium text-muted-foreground">{t('noChangeVsPrevious')}</span>;
    const good = invert ? points < 0 : points > 0;
    const Icon = points > 0 ? ArrowUpRight : ArrowDownRight;
    return (
      <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${good ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>
        <Icon size={13} aria-hidden="true" />{t('pointsVsPrevious', { points: points > 0 ? `+${points}` : String(points) })}
      </span>
    );
  };
  const profitChange = (() => {
    if (!report || report.previous.grossProfit <= 0) return null;
    const percent = Math.round(((report.totals.grossProfit - report.previous.grossProfit) / report.previous.grossProfit) * 100);
    if (percent === 0) return <span className="text-xs font-medium text-muted-foreground">{t('noChangeVsPrevious')}</span>;
    return (
      <span className={`text-xs font-semibold ${percent > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>
        {t('changeVsPrevious', { percent: percent > 0 ? `+${percent}` : String(percent) })}
      </span>
    );
  })();

  return (
    <section className={`${card} space-y-4`} aria-busy={loading}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="me-auto text-base font-bold text-foreground">{t('cogsTitle')}</h2>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label={tDash('topCategories')}
          className="h-10 rounded-xl border-2 border-border bg-card px-3 text-sm font-semibold print:hidden">
          <option value="">{t('allCategories')}</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label={t('sortBy')}
          className="h-10 rounded-xl border-2 border-border bg-card px-3 text-sm font-semibold print:hidden">
          <option value="sales">{t('sortBy')}: {t('sales')}</option>
          <option value="profit">{t('sortBy')}: {t('grossProfit')}</option>
          <option value="margin">{t('sortBy')}: {t('margin')}</option>
          <option value="cost">{t('sortBy')}: {t('costOfGoods')}</option>
        </select>
        <button type="button" onClick={exportCsv} disabled={!report}
          className="inline-flex h-10 items-center gap-2 rounded-xl border-2 border-border bg-card px-4 text-sm font-semibold hover:bg-muted disabled:opacity-50 print:hidden">
          <Download size={15} aria-hidden="true" />{tDash('exportCsv')}
        </button>
      </div>

      {!report ? (
        <p className="text-sm text-muted-foreground">{loading ? '…' : t('loadFailed')}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div className={tile}><p className="text-xs font-semibold text-muted-foreground">{t('costedSales')}</p><p className="text-xl font-bold"><Ltr>{fmt(report.totals.costedSales)}</Ltr></p></div>
            <div className={tile}>
              <p className="text-xs font-semibold text-muted-foreground">{t('costOfGoods')}</p>
              <p className="text-xl font-bold"><Ltr>{fmt(report.totals.cost)}</Ltr></p>
              <p className="text-xs font-medium text-muted-foreground">{report.totals.costPercent === null ? '' : t('costPercentOfSales', { percent: Math.round(report.totals.costPercent) })}</p>
            </div>
            <div className={tile}><p className="text-xs font-semibold text-muted-foreground">{t('grossProfit')}</p><p className="text-xl font-bold"><Ltr>{fmt(report.totals.grossProfit)}</Ltr></p>{profitChange}</div>
            <div className={tile}>
              <p className="text-xs font-semibold text-muted-foreground">{t('margin')}</p>
              <p className="text-xl font-bold">{report.totals.margin === null ? '–' : `${Math.round(report.totals.margin)}%`}</p>
              {change(report.totals.margin, report.previous.margin)}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2">
              <p className="me-auto text-sm font-semibold text-foreground">{trendBy === 'week' ? t('costTrendWeeks') : t('costTrendMonths')}</p>
              <div className="flex rounded-xl border-2 border-border p-0.5 print:hidden" role="group" aria-label={t('costTrendWeeks')}>
                {(['week', 'month'] as const).map((value) => (
                  <button key={value} type="button" aria-pressed={trendBy === value} onClick={() => setTrendBy(value)}
                    className={`rounded-lg px-3 py-1 text-xs font-semibold ${trendBy === value ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'}`}>
                    {value === 'week' ? t('trendWeeks') : t('trendMonths')}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex h-28 items-end gap-2">
              {report.trend.map((bucket) => (
                <div key={bucket.start} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${trendLabel(bucket.start)}: ${fmt(bucket.cost)} / ${fmt(bucket.costedSales)}`}>
                  <span className="text-xs font-semibold text-foreground">{bucket.costPercent === null ? '–' : `${Math.round(bucket.costPercent)}%`}</span>
                  <div className="print-bar w-full rounded-t-md bg-foreground/70" style={{ height: `${Math.max(2, ((bucket.costPercent ?? 0) / trendMax) * 64)}px` }} />
                  <span className="truncate text-[11px] text-muted-foreground">{trendLabel(bucket.start)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-xs font-semibold text-muted-foreground">
                  <th className="pb-2 text-start">{t('item')}</th>
                  <th className="pb-2 text-start">{tDash('topCategories')}</th>
                  <th className="pb-2 text-end">{t('sold')}</th>
                  <th className="pb-2 text-end">{t('sales')}</th>
                  <th className="pb-2 text-end">{t('costEach')}</th>
                  <th className="pb-2 text-end">{t('totalCost')}</th>
                  <th className="pb-2 text-end">{t('grossProfit')}</th>
                  <th className="pb-2 text-end">{t('margin')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.costed.map((i, index) => {
                  const hiddenRow = !expanded && index >= VISIBLE_ROWS ? 'hidden print:table-row' : '';
                  const margin = marginOf(i);
                  const marginMove = margin !== null && i.previousMargin !== null ? Math.round(margin - i.previousMargin) : null;
                  return (
                    <tr key={`${i.productId}|${i.name}`} className={`border-t border-border ${hiddenRow}`}>
                      <td className="py-2 font-semibold text-foreground">{i.name}</td>
                      <td className="py-2 text-muted-foreground">{i.category ?? ''}</td>
                      <td className="py-2 text-end">{i.quantity}</td>
                      <td className="py-2 text-end"><Ltr>{fmt(i.net)}</Ltr></td>
                      <td className="py-2 text-end text-muted-foreground"><Ltr>{fmt(i.unitCost ?? 0)}</Ltr></td>
                      <td className="py-2 text-end"><Ltr>{fmt(i.cost ?? 0)}</Ltr></td>
                      <td className="py-2 text-end font-semibold"><Ltr>{fmt(i.profit ?? 0)}</Ltr></td>
                      <td className={`py-2 text-end font-semibold ${margin !== null && margin < LOW_MARGIN ? 'text-amber-700 dark:text-amber-400' : 'text-foreground'}`}>
                        {margin === null ? '–' : `${Math.round(margin)}%`}
                        {marginMove !== null && marginMove !== 0 && (
                          <span className={`ms-1 text-[11px] ${marginMove > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>{marginMove > 0 ? `+${marginMove}` : marginMove}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-border font-bold">
                  <td className="py-2" colSpan={3}>{t('totalCosted', { count: rows.costed.length })}</td>
                  <td className="py-2 text-end"><Ltr>{fmt(filteredTotals.sales)}</Ltr></td>
                  <td />
                  <td className="py-2 text-end"><Ltr>{fmt(filteredTotals.cost)}</Ltr></td>
                  <td className="py-2 text-end"><Ltr>{fmt(filteredTotals.profit)}</Ltr></td>
                  <td className="py-2 text-end">{filteredTotals.margin === null ? '–' : `${Math.round(filteredTotals.margin)}%`}</td>
                </tr>
                {rows.uncosted.map((i) => (
                  <tr key={`${i.productId}|${i.name}`} className={`border-t border-border ${expanded ? '' : 'hidden print:table-row'}`}>
                    <td className="py-2 font-semibold text-foreground">{i.name}</td>
                    <td className="py-2 text-muted-foreground">{i.category ?? t('notOnMenu')}</td>
                    <td className="py-2 text-end">{i.quantity}</td>
                    <td className="py-2 text-end"><Ltr>{fmt(i.net)}</Ltr></td>
                    <td className="py-2 ps-4 text-amber-700 dark:text-amber-400" colSpan={4}>{t('noRecipe')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.costed.length + rows.uncosted.length > VISIBLE_ROWS && (
            <button type="button" onClick={() => setExpanded((on) => !on)}
              className="inline-flex h-10 items-center rounded-xl border-2 border-border bg-card px-4 text-sm font-semibold hover:bg-muted print:hidden">
              {expanded ? t('showLess') : t('showAll', { count: rows.costed.length + rows.uncosted.length })}
            </button>
          )}
          {rows.uncosted.length > 0 && (
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
              {t('uncostedNote', { count: rows.uncosted.length, amount: fmt(rows.uncosted.reduce((sum, i) => sum + i.net, 0)) })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
