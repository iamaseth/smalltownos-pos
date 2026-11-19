import { dayBoundsInTimezone, getDatabase, localDateInTimezone, tenantBusinessDayStartTime } from '../db';
import { buildDailySalesExportDataset } from './daily-sales-export';
import { serializeDailySalesExportCsv } from './daily-sales-export-files';
import { listSupplies } from './supplies';
import { getTenantCurrency } from './refund';
import { getCurrencyMinorUnitFactor } from '../countries';
import { computeDayAggregates, expectedCashFromAggregates, tenantTimezone } from '../routes/cash-closures';
import { buildCogsReport, buildWeeklyReport, mondayOf, shiftDate } from '../routes/reports';
import { buildTextPdf, pdfRow, type PdfLine } from '../lib/simple-pdf';
import { toCsvRow } from '../lib/csv';

type Db = ReturnType<typeof getDatabase>;

export const TELEGRAM_REPORT_TYPES = ['daily', 'shift', 'weekly', 'low_stock', 'purchasing'] as const;
export type TelegramReportType = typeof TELEGRAM_REPORT_TYPES[number];

export interface TelegramAttachment { filename: string; contentType: string; data: Buffer }
export interface TelegramReport { title: string; html: string; attachments: TelegramAttachment[] }
export interface ReportOptions { pdf: boolean; csv: boolean }

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function businessName(db: Db): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'business_name'").get() as { value?: string } | undefined;
  return row?.value?.trim() || 'POS';
}

function moneyFormatter(db: Db) {
  const currency = getTenantCurrency(db);
  const factor = getCurrencyMinorUnitFactor(currency);
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: factor === 1 ? 0 : 2 });
  } catch {
    formatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  }
  return { money: (amount: number) => formatter.format(amount), cents: (minor: number) => formatter.format(minor / factor) };
}

const percent = (value: number | null | undefined) => (value === null || value === undefined ? '-' : `${Math.round(value)}%`);
const prettyDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function currentBusinessDate(db: Db = getDatabase()): string {
  return localDateInTimezone(new Date(), tenantTimezone(), tenantBusinessDayStartTime(db));
}

function pre(rows: string[]): string {
  return `<pre>${escapeHtml(rows.join('\n'))}</pre>`;
}

function lowStockRows(db: Db) {
  return listSupplies(db, { lowStockOnly: true }).map((s) => ({ name: s.name, stock: s.stock_quantity, unit: s.base_unit, threshold: s.low_stock_threshold }));
}

export function buildDailyReport(db: Db, businessDate: string, options: ReportOptions): TelegramReport {
  const { money, cents } = moneyFormatter(db);
  const dataset = buildDailySalesExportDataset(businessDate, db);
  const summary = dataset.summary;
  const aggregates = computeDayAggregates(db, businessDate);
  const closure = db.prepare(`SELECT expected_cash_cents, counted_cash_cents, variance_cents, z_number FROM cash_closures WHERE scope = 'day' AND business_date = ?`)
    .get(businessDate) as { expected_cash_cents: number; counted_cash_cents: number; variance_cents: number; z_number: number } | undefined;
  const cogs = buildCogsReport(db, businessDate, businessDate, 'week').totals;
  const topItems = [...dataset.items].sort((a, b) => b.net_item_sales - a.net_item_sales).slice(0, 5);
  const lowStock = lowStockRows(db);
  const title = `Daily summary ${prettyDate(businessDate)}`;
  const expectedCash = closure ? closure.expected_cash_cents : expectedCashFromAggregates(aggregates);

  const salesRows = [
    `Bills          ${summary.paid_bill_count}`,
    `Gross          ${money(summary.gross_collected)}`,
    `Refunds        ${money(summary.refunds_issued)}`,
    `Discounts      ${money(summary.discount_total)}`,
    `Net collected  ${money(summary.net_collected)}`,
    cogs.costedSales > 0 ? `Cost of goods  ${money(cogs.cost)} (${percent(cogs.costPercent)} of costed sales)` : 'Cost of goods  no costed recipes sold',
  ];
  const paymentRows = summary.payment_methods.map((p) => `${(p.method.charAt(0).toUpperCase() + p.method.slice(1)).slice(0, 18).padEnd(18)} ${money(p.total)}`);
  const cashRows = closure
    ? [`Expected       ${cents(closure.expected_cash_cents)}`, `Counted        ${cents(closure.counted_cash_cents)}`, `Difference     ${cents(closure.variance_cents)}`, `Z number       ${closure.z_number}`]
    : [`Expected       ${cents(expectedCash)}`, 'Day not closed yet'];
  const topRows = topItems.map((i) => `${i.product_name.slice(0, 22).padEnd(22)} ${String(i.quantity).padStart(4)} ${money(i.net_item_sales)}`);

  const html = [
    `<b>${escapeHtml(businessName(db))} - ${escapeHtml(title)}</b>`,
    '', '<b>Sales</b>', pre(salesRows),
    '<b>Payments</b>', pre(paymentRows.length ? paymentRows : ['No payments']),
    '<b>Cash</b>', pre(cashRows),
    '<b>Best sellers</b>', pre(topRows.length ? topRows : ['No sales']),
    lowStock.length ? `<b>Low stock (${lowStock.length})</b>\n${pre(lowStock.slice(0, 10).map((s) => `${s.name.slice(0, 24).padEnd(24)} ${s.stock} ${s.unit}`))}` : '',
  ].filter((part) => part !== '').join('\n');

  const attachments: TelegramAttachment[] = [];
  if (options.pdf) {
    const lines: PdfLine[] = [
      { text: `${businessName(db)} - ${title}`, bold: true, size: 15, gap: 4 },
      { text: 'Sales', bold: true, size: 12, gap: 8 }, ...salesRows.map((t) => ({ text: t, mono: true })),
      { text: 'Payments', bold: true, size: 12, gap: 8 }, ...(paymentRows.length ? paymentRows : ['No payments']).map((t) => ({ text: t, mono: true })),
      { text: 'Cash', bold: true, size: 12, gap: 8 }, ...cashRows.map((t) => ({ text: t, mono: true })),
      { text: 'Items sold', bold: true, size: 12, gap: 8 },
      { text: pdfRow(['Item', 'Qty', 'Net'], [34, 6, 14]), mono: true, bold: true },
      ...[...dataset.items].sort((a, b) => b.net_item_sales - a.net_item_sales).map((i) => ({ text: pdfRow([i.product_name, i.quantity, money(i.net_item_sales)], [34, 6, 14]), mono: true })),
    ];
    attachments.push({ filename: `daily-summary-${businessDate}.pdf`, contentType: 'application/pdf', data: buildTextPdf(lines) });
  }
  if (options.csv) {
    attachments.push({ filename: `daily-sales-${businessDate}-items.csv`, contentType: 'text/csv', data: Buffer.from(`﻿${serializeDailySalesExportCsv(dataset, 'items')}`, 'utf8') });
  }
  return { title, html, attachments };
}

export function buildWeeklyManagementReport(db: Db, anyDateInWeek: string, options: ReportOptions): TelegramReport {
  const { money } = moneyFormatter(db);
  const weekStart = mondayOf(anyDateInWeek);
  const weekly = buildWeeklyReport(db, weekStart, true);
  const cogs = buildCogsReport(db, weekStart, shiftDate(weekStart, 6), 'week');
  const title = `Weekly report ${prettyDate(weekly.weekStart)} - ${prettyDate(weekly.weekEnd)}`;
  const change = weekly.previous.net > 0 ? Math.round(((weekly.total.net - weekly.previous.net) / weekly.previous.net) * 100) : null;
  const dayRows = weekly.days.map((d) => `${prettyDate(d.date).replace(/ \d{4}$/, '').padEnd(11)} ${String(d.orders).padStart(4)} ${money(d.net).padStart(11)}`);
  const costed = cogs.items.filter((i) => i.cost !== null);
  const topProfit = [...costed].sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0)).slice(0, 5);
  const lowMargin = costed.filter((i) => i.net > 0 && (i.profit ?? 0) / i.net < 0.55).slice(0, 5);
  const headline = [
    `Net sales      ${money(weekly.total.net)}${change === null ? '' : ` (${change >= 0 ? '+' : ''}${change}% vs last week)`}`,
    `Orders         ${weekly.total.orders}`,
    `Average bill   ${money(weekly.total.averageBill ?? 0)}`,
    ...(cogs.totals.costedSales > 0 ? [
      `Cost of goods  ${money(cogs.totals.cost)} (${percent(cogs.totals.costPercent)})`,
      `Gross profit   ${money(cogs.totals.grossProfit)} (margin ${percent(cogs.totals.margin)})`,
    ] : ['Cost of goods  no costed recipes sold']),
    `No recipe      ${cogs.totals.uncostedItems} items, ${money(cogs.totals.uncostedSales)} of sales`,
  ];
  const html = [
    `<b>${escapeHtml(businessName(db))} - ${escapeHtml(title)}</b>`, '', pre(headline),
    '<b>By day</b>', pre(dayRows),
    topProfit.length ? `<b>Most profitable</b>\n${pre(topProfit.map((i) => `${i.name.slice(0, 22).padEnd(22)} ${money(i.profit ?? 0)}`))}` : '',
    lowMargin.length ? `<b>Margin under 55%</b>\n${pre(lowMargin.map((i) => `${i.name.slice(0, 22).padEnd(22)} ${percent(((i.profit ?? 0) / i.net) * 100)}`))}` : '',
  ].filter((part) => part !== '').join('\n');

  const attachments: TelegramAttachment[] = [];
  if (options.pdf) {
    const lines: PdfLine[] = [
      { text: `${businessName(db)} - ${title}`, bold: true, size: 15, gap: 4 },
      ...headline.map((t) => ({ text: t, mono: true })),
      { text: 'By day', bold: true, size: 12, gap: 8 },
      { text: pdfRow(['Day', 'Orders', 'Net'], [16, 8, 14]), mono: true, bold: true },
      ...weekly.days.map((d) => ({ text: pdfRow([prettyDate(d.date), d.orders, money(d.net)], [16, 8, 14]), mono: true })),
      { text: 'Items and cost of goods', bold: true, size: 12, gap: 8 },
      { text: pdfRow(['Item', 'Sold', 'Sales', 'Cost', 'Profit', 'Margin'], [26, 5, 11, 10, 11, 7]), mono: true, bold: true },
      ...costed.map((i) => ({ text: pdfRow([i.name, i.quantity, money(i.net), money(i.cost ?? 0), money(i.profit ?? 0), percent(i.net > 0 ? ((i.profit ?? 0) / i.net) * 100 : null)], [26, 5, 11, 10, 11, 7]), mono: true })),
    ];
    attachments.push({ filename: `weekly-report-${weekly.weekStart}.pdf`, contentType: 'application/pdf', data: buildTextPdf(lines) });
  }
  if (options.csv) {
    const rows = [toCsvRow(['item', 'category', 'sold', 'sales', 'cost_each', 'total_cost', 'gross_profit'])];
    for (const i of cogs.items) rows.push(toCsvRow([i.name, i.category ?? '', i.quantity, i.net.toFixed(2), i.unitCost === null ? '' : i.unitCost.toFixed(2), i.cost === null ? '' : i.cost.toFixed(2), i.profit === null ? '' : i.profit.toFixed(2)]));
    attachments.push({ filename: `weekly-items-${weekly.weekStart}.csv`, contentType: 'text/csv', data: Buffer.from(`﻿${rows.join('\r\n')}\r\n`, 'utf8') });
  }
  return { title, html, attachments };
}

export function buildShiftReport(db: Db, sessionId: number, event: 'open' | 'close'): TelegramReport {
  const { cents } = moneyFormatter(db);
  const session = db.prepare('SELECT * FROM cash_sessions WHERE id = ?').get(sessionId) as {
    id: number; opened_by_name: string; opened_at: string; opening_float_cents: number; closed_at: string | null; closure_id: number | null;
  } | undefined;
  if (!session) throw new Error(`shift ${sessionId} not found`);
  if (event === 'open') {
    const title = `Shift opened by ${session.opened_by_name || 'staff'}`;
    return { title, attachments: [], html: `<b>${escapeHtml(businessName(db))} - ${escapeHtml(title)}</b>\n${pre([`Opened   ${session.opened_at}`, `Float    ${cents(session.opening_float_cents)}`])}` };
  }
  const closure = session.closure_id
    ? db.prepare('SELECT expected_cash_cents, counted_cash_cents, variance_cents, net_collected_cents, bill_count FROM cash_closures WHERE id = ?').get(session.closure_id) as
      { expected_cash_cents: number; counted_cash_cents: number; variance_cents: number; net_collected_cents: number; bill_count: number } | undefined
    : undefined;
  const title = `Shift closed (${session.opened_by_name || 'staff'})`;
  const rows = [`Opened     ${session.opened_at}`, `Closed     ${session.closed_at ?? '-'}`];
  if (closure) rows.push(`Bills      ${closure.bill_count}`, `Collected  ${cents(closure.net_collected_cents)}`, `Expected   ${cents(closure.expected_cash_cents)}`, `Counted    ${cents(closure.counted_cash_cents)}`, `Difference ${cents(closure.variance_cents)}`);
  return { title, attachments: [], html: `<b>${escapeHtml(businessName(db))} - ${escapeHtml(title)}</b>\n${pre(rows)}` };
}

export function buildLowStockAlert(db: Db, supplyNames: string[]): TelegramReport {
  const rows = lowStockRows(db).filter((s) => supplyNames.includes(s.name));
  const title = `Low stock: ${rows.map((r) => r.name).slice(0, 3).join(', ')}${rows.length > 3 ? ` +${rows.length - 3}` : ''}`;
  return {
    title,
    attachments: [],
    html: `<b>${escapeHtml(businessName(db))} - Low stock</b>\n${pre(rows.map((s) => `${s.name.slice(0, 24).padEnd(24)} ${s.stock} ${s.unit} (alert at ${s.threshold})`))}`,
  };
}

export function buildPurchasingReport(db: Db, startDate: string, endDate: string, options: ReportOptions): TelegramReport {
  const { money } = moneyFormatter(db);
  const tz = tenantTimezone();
  const startTime = tenantBusinessDayStartTime(db);
  const [from] = dayBoundsInTimezone(startDate, tz, startTime);
  const [, to] = dayBoundsInTimezone(endDate, tz, startTime);
  const lines = db.prepare(`
    SELECT s.name, s.base_unit, COALESCE(v.name, 'No vendor') AS vendor, SUM(m.quantity_delta) AS quantity,
      SUM(m.quantity_delta * COALESCE(m.unit_cost, s.unit_cost, 0)) AS spend, COUNT(DISTINCT m.reference_id) AS deliveries
    FROM supply_movements m
    JOIN supplies s ON s.id = m.supply_id
    LEFT JOIN vendors v ON v.id = s.vendor_id
    WHERE m.movement_type = 'receive' AND m.created_at >= ? AND m.created_at < ?
    GROUP BY s.id ORDER BY spend DESC
  `).all(from, to) as { name: string; base_unit: string; vendor: string; quantity: number; spend: number; deliveries: number }[];
  const byVendor = new Map<string, number>();
  for (const line of lines) byVendor.set(line.vendor, (byVendor.get(line.vendor) ?? 0) + Number(line.spend || 0));
  const total = [...byVendor.values()].reduce((a, b) => a + b, 0);
  const title = `Purchasing ${prettyDate(startDate)} - ${prettyDate(endDate)}`;
  const vendorRows = [...byVendor.entries()].sort((a, b) => b[1] - a[1]).map(([vendor, spend]) => `${vendor.slice(0, 24).padEnd(24)} ${money(spend)}`);
  const html = [
    `<b>${escapeHtml(businessName(db))} - ${escapeHtml(title)}</b>`,
    pre([`Total received  ${money(total)}`, `Items           ${lines.length}`]),
    '<b>By supplier</b>', pre(vendorRows.length ? vendorRows : ['No deliveries recorded']),
    lines.length ? `<b>Top items</b>\n${pre(lines.slice(0, 8).map((l) => `${l.name.slice(0, 22).padEnd(22)} ${money(Number(l.spend || 0))}`))}` : '',
  ].filter((part) => part !== '').join('\n');
  const attachments: TelegramAttachment[] = [];
  if (options.csv && lines.length) {
    const rows = [toCsvRow(['item', 'supplier', 'quantity', 'unit', 'spend', 'deliveries'])];
    for (const l of lines) rows.push(toCsvRow([l.name, l.vendor, Number(l.quantity).toFixed(2), l.base_unit, Number(l.spend || 0).toFixed(2), l.deliveries]));
    attachments.push({ filename: `purchasing-${startDate}-to-${endDate}.csv`, contentType: 'text/csv', data: Buffer.from(`﻿${rows.join('\r\n')}\r\n`, 'utf8') });
  }
  if (options.pdf && lines.length) {
    attachments.push({
      filename: `purchasing-${startDate}-to-${endDate}.pdf`, contentType: 'application/pdf',
      data: buildTextPdf([
        { text: `${businessName(db)} - ${title}`, bold: true, size: 15, gap: 4 },
        { text: `Total received ${money(total)}`, mono: true },
        { text: 'By supplier', bold: true, size: 12, gap: 8 }, ...vendorRows.map((t) => ({ text: t, mono: true })),
        { text: 'Items', bold: true, size: 12, gap: 8 },
        { text: pdfRow(['Item', 'Supplier', 'Qty', 'Spend'], [24, 18, 10, 12]), mono: true, bold: true },
        ...lines.map((l) => ({ text: pdfRow([l.name, l.vendor, `${Number(l.quantity).toFixed(1)}${l.base_unit}`, money(Number(l.spend || 0))], [24, 18, 10, 12]), mono: true })),
      ]),
    });
  }
  return { title, html, attachments };
}
