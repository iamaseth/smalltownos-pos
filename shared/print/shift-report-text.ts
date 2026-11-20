/**
 * Plain-text layout for the X-report, Z-report and daily sales report on
 * receipt paper (42 columns on 80 mm, 32 on 58 mm — see columnsForReceiptPaperSize). Money is integer
 * cents (USD) or whole riel (KHR); nothing here calculates totals.
 */

export interface ReportPaymentRow { label: string; count: number; usdCents: number; khrRiel: number }
export interface ReportTableRow { label: string; who: string; openedAt: string | null; closedAt: string | null; bills: number; totalCents: number; status: 'paid' | 'open' | 'unpaid' }
export interface ReportQtyRow { label: string; qty: number; netCents: number }
export interface ReportSpentRow { label: string; usdCents: number; khrRiel: number; hasPhoto: boolean }
export interface ReportShiftRow { id: number; cashier: string; openedAt: string; closedAt: string | null; orders: number; netCents: number; varianceUsdCents: number | null; varianceKhrRiel: number | null }

export interface ReportSales {
  grossCents: number; discountCents: number; refundCents: number; refundCount: number;
  voidCount: number; voidCents: number; compCount: number; compCents: number;
  netCents: number; orders: number; averageCents: number;
}

export interface ReportCash {
  rate: number;
  openingUsdCents: number; openingKhrRiel: number;
  cashSalesUsdCents: number; cashSalesKhrRiel: number;
  cashRefundUsdCents: number;
  payInUsdCents: number; payInKhrRiel: number;
  payOutUsdCents: number; payOutKhrRiel: number;
  expectedUsdCents: number; expectedKhrRiel: number;
  countedUsdCents: number | null; countedKhrRiel: number | null;
  varianceUsdCents: number | null; varianceKhrRiel: number | null; varianceCombinedCents: number | null;
  matches: boolean | null; toleranceCents: number;
  floatKeptUsdCents: number | null; floatKeptKhrRiel: number | null;
  untrackedCashLines: number;
}

export interface ShiftReportData {
  kind: 'X' | 'Z';
  businessName: string; register: string; shiftNumber: number; timezone: string;
  cashier: string; openedAt: string; closedAt: string | null; printedAt: string;
  sales: ReportSales;
  payments: ReportPaymentRow[];
  unpaid: { count: number; totalCents: number; labels: string[] };
  tables: { served: number; completed: number; occupied: number; awaiting: ReportTableRow[]; rows: ReportTableRow[] };
  cash: ReportCash;
  spent: ReportSpentRow[];
  notes: string[];
  telegram: string | null;
}

export interface DailyReportData {
  businessName: string; timezone: string; businessDate: string; dayStart: string; dayEnd: string; printedAt: string;
  sales: ReportSales;
  shifts: ReportShiftRow[];
  payments: ReportPaymentRow[];
  categories: ReportQtyRow[];
  products: ReportQtyRow[];
  tables: ReportTableRow[];
  unpaid: { count: number; totalCents: number; labels: string[] };
}

/** Characters per line: 42 on 80 mm paper (72 mm print area), 32 on 58 mm. */
export type ReportWidth = number;

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(0, n)));
export const usd = (cents: number) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
export const khr = (riel: number) => `${riel < 0 ? '-' : ''}${Math.abs(Math.round(riel)).toLocaleString('en-US')} R`;
const signed = (text: string, value: number) => (value > 0 ? `+${text}` : text);

function lr(w: number, left: string, right: string): string {
  const gap = w - left.length - right.length;
  if (gap >= 1) return left + ' '.repeat(gap) + right;
  return clip(left, Math.max(0, w - right.length - 1)) + ' ' + clip(right, w);
}
function cols(w: number, label: string, mid: string, right: string): string {
  const midW = 5;
  const rightW = w >= 40 ? 13 : 12;
  return clip(label, w - midW - rightW).padEnd(w - midW - rightW) + clip(mid, midW).padStart(midW) + clip(right, rightW).padStart(rightW);
}
function center(w: number, text: string): string {
  const t = clip(text, w);
  return ' '.repeat(Math.floor((w - t.length) / 2)) + t;
}
function wrap(w: number, text: string, indent = ' '): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    if ((cur ? `${cur} ${word}` : word).length > w - indent.length) { if (cur) out.push(indent + cur); cur = clip(word, w - indent.length); }
    else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(indent + cur);
  return out;
}
const rule = (w: number, ch = '-') => ch.repeat(w);

/** "2026-11-20 11:02:00" UTC → "20 Nov 18:02" in the store timezone. */
export function formatStamp(utc: string | null, timezone: string): string {
  if (!utc) return '—';
  try {
    const d = new Date(`${utc.replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(utc) ? '' : 'Z'}`);
    const date = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'short' }).format(d);
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    return `${date} ${time}`;
  } catch { return utc.slice(5, 16); }
}
const timeOnly = (stamp: string) => stamp.split(' ').slice(-1)[0];

function duration(fromUtc: string, toUtc: string): string {
  const ms = Date.parse(`${toUtc.replace(' ', 'T')}Z`) - Date.parse(`${fromUtc.replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.round(ms / 60000);
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function header(w: number, name: string, title: string, sub: string | null, reprint: boolean): string[] {
  const out = [center(w, name.toUpperCase()), rule(w, '='), center(w, title)];
  if (sub) out.push(center(w, sub));
  if (reprint) out.push(center(w, '*** REPRINT ***'));
  out.push(rule(w, '='));
  return out;
}

function salesBlock(w: number, s: ReportSales): string[] {
  return [
    'SALES',
    lr(w, 'Gross sales', usd(s.grossCents)),
    lr(w, 'Discounts', usd(-s.discountCents)),
    lr(w, `Refunds (${s.refundCount})`, usd(-s.refundCents)),
    lr(w, `Voided items (${s.voidCount})`, `${usd(s.voidCents)} n/c`),
    lr(w, `Complimentary (${s.compCount})`, `${usd(s.compCents)} n/c`),
    lr(w, 'NET SALES', usd(s.netCents)),
    lr(w, 'Orders', String(s.orders)),
    lr(w, 'Average bill', usd(s.averageCents)),
  ];
}

function paymentsBlock(w: number, rows: ReportPaymentRow[], rate: number): string[] {
  const out = [cols(w, 'PAYMENTS', w >= 40 ? 'count' : 'no.', 'amount')];
  if (rows.length === 0) out.push(' No payments');
  for (const row of rows) {
    if (row.label === 'Cash KHR') {
      out.push(cols(w, row.label, String(row.count), khr(row.khrRiel)));
      if (row.khrRiel && rate > 0) out.push(cols(w, w >= 40 ? `  (= at ${rate.toLocaleString('en-US')} R/$)` : ` (${rate.toLocaleString('en-US')} R/$)`, '', usd(Math.round((row.khrRiel / rate) * 100))));
    } else {
      out.push(cols(w, row.label, String(row.count), usd(row.usdCents)));
    }
  }
  return out;
}

function cashBlock(w: number, c: ReportCash, closing: boolean): string[] {
  const out = [closing ? 'CASH' : 'CASH DRAWER (expected now)',
    lr(w, 'Opening float', usd(c.openingUsdCents))];
  if (c.openingKhrRiel) out.push(lr(w, '', khr(c.openingKhrRiel)));
  out.push(lr(w, 'Cash sales', usd(c.cashSalesUsdCents)));
  if (c.cashSalesKhrRiel) out.push(lr(w, '', khr(c.cashSalesKhrRiel)));
  if (c.cashRefundUsdCents) out.push(lr(w, 'Cash refunds', usd(-c.cashRefundUsdCents)));
  if (c.payInUsdCents || c.payInKhrRiel) out.push(lr(w, 'Pay-ins', [c.payInUsdCents ? usd(c.payInUsdCents) : '', c.payInKhrRiel ? khr(c.payInKhrRiel) : ''].filter(Boolean).join(' ')));
  if (c.payOutUsdCents) out.push(lr(w, 'Cash spent', usd(-c.payOutUsdCents)));
  if (c.payOutKhrRiel) out.push(lr(w, c.payOutUsdCents ? '' : 'Cash spent', khr(-c.payOutKhrRiel)));
  out.push(lr(w, 'Expected USD', usd(c.expectedUsdCents)));
  if (closing && c.countedUsdCents != null) {
    out.push(lr(w, 'Counted USD', usd(c.countedUsdCents)), lr(w, 'USD difference', signed(usd(c.varianceUsdCents ?? 0), c.varianceUsdCents ?? 0)));
  }
  out.push(lr(w, 'Expected KHR', khr(c.expectedKhrRiel)));
  if (closing && c.countedKhrRiel != null) {
    out.push(lr(w, 'Counted KHR', khr(c.countedKhrRiel)), lr(w, 'KHR difference', signed(khr(c.varianceKhrRiel ?? 0), c.varianceKhrRiel ?? 0)));
    out.push(lr(w, `Combined (${c.rate.toLocaleString('en-US')} R/$)`, signed(usd(c.varianceCombinedCents ?? 0), c.varianceCombinedCents ?? 0)));
    out.push(lr(w, 'Result', c.matches ? `MATCH (within ${usd(c.toleranceCents)})` : 'DIFFERENCE'));
  }
  if (c.untrackedCashLines > 0) out.push(...wrap(w, `${c.untrackedCashLines} older cash payment(s) had no USD/KHR split and are counted as USD.`));
  return out;
}

function tableLine(w: number, row: ReportTableRow, timezone: string): string {
  const when = row.openedAt ? timeOnly(formatStamp(row.openedAt, timezone)) : '';
  const status = row.status === 'paid' ? '' : row.status === 'open' ? ' open' : ' due';
  return cols(w, `${row.label}${row.who ? ` ${row.who}` : ''}`, when, `${usd(row.totalCents)}${status}`);
}

export function renderShiftReport(d: ShiftReportData, w: ReportWidth, timezone: string, reprint = false): string[] {
  const closing = d.kind === 'Z';
  const out: string[] = [
    ...header(w, d.businessName, closing ? 'Z-REPORT  SHIFT CLOSE' : 'X-REPORT  (shift still open)', closing ? `Shift #${d.shiftNumber}` : 'Not a closing report', reprint),
    lr(w, 'Cashier', d.cashier),
    lr(w, 'Register', d.register),
    lr(w, closing ? 'Opened' : 'Shift opened', formatStamp(d.openedAt, timezone)),
  ];
  if (closing && d.closedAt) out.push(lr(w, 'Closed', formatStamp(d.closedAt, timezone)), lr(w, 'Duration', duration(d.openedAt, d.closedAt)));
  out.push(lr(w, 'Printed', formatStamp(d.printedAt, timezone)), rule(w));
  out.push(...salesBlock(w, d.sales), rule(w));
  out.push(...paymentsBlock(w, d.payments, d.cash.rate));
  out.push(lr(w, closing ? 'Unpaid at close' : `Unpaid (${d.unpaid.count} ticket${d.unpaid.count === 1 ? '' : 's'})`, usd(d.unpaid.totalCents)), rule(w));
  out.push('TABLES',
    lr(w, 'Tables served', String(d.tables.served)),
    lr(w, 'Completed', String(d.tables.completed)),
    lr(w, closing ? 'Still occupied' : 'Occupied now', String(d.tables.occupied)));
  if (d.tables.awaiting.length === 0) out.push(lr(w, 'Awaiting payment', '0'));
  d.tables.awaiting.forEach((row, i) => out.push(lr(w, i === 0 ? 'Awaiting payment' : '', `${row.label} ${usd(row.totalCents)}`)));
  if (d.tables.rows.length) {
    out.push(cols(w, 'Table list', w >= 40 ? 'open' : 'open', 'total'));
    d.tables.rows.forEach((row) => out.push(tableLine(w, row, timezone)));
  }
  out.push(rule(w), ...cashBlock(w, d.cash, closing));
  if (d.spent.length) {
    out.push(rule(w), 'CASH SPENT');
    d.spent.forEach((s) => out.push(lr(w, ` ${s.label}`, `${s.khrRiel ? khr(s.khrRiel) : usd(s.usdCents)}${s.hasPhoto ? ' [photo]' : ''}`)));
  }
  if (closing) {
    out.push(rule(w), 'CASH HANDLING');
    if (d.cash.floatKeptUsdCents != null) out.push(lr(w, 'Float kept', usd(d.cash.floatKeptUsdCents)));
    if (d.cash.floatKeptKhrRiel) out.push(lr(w, '', khr(d.cash.floatKeptKhrRiel)));
    if (d.cash.countedUsdCents != null && d.cash.floatKeptUsdCents != null) out.push(lr(w, 'Takings out USD', usd(d.cash.countedUsdCents - d.cash.floatKeptUsdCents)));
    if (d.cash.countedKhrRiel != null) out.push(lr(w, 'Takings out KHR', khr(d.cash.countedKhrRiel - (d.cash.floatKeptKhrRiel ?? 0))));
  }
  if (d.notes.length) {
    out.push(rule(w), 'NOTES');
    d.notes.forEach((n) => out.push(...wrap(w, n)));
  }
  if (closing) out.push(rule(w), lr(w, 'Telegram', d.telegram ?? 'not sent'));
  out.push(rule(w, '='), center(w, closing ? 'End of shift report' : 'X-report does not close the shift'));
  return out;
}

export function renderDailyReport(d: DailyReportData, w: ReportWidth, timezone: string, reprint = false): string[] {
  const out: string[] = [
    ...header(w, d.businessName, 'DAILY SALES REPORT', `Business day ${d.businessDate}`, reprint),
    lr(w, 'From', formatStamp(d.dayStart, timezone)),
    lr(w, 'To', formatStamp(d.dayEnd, timezone)),
    lr(w, 'Printed', formatStamp(d.printedAt, timezone)),
    rule(w),
    ...salesBlock(w, d.sales),
    rule(w),
    cols(w, 'SHIFTS', w >= 40 ? 'ords' : 'no.', 'net'),
  ];
  if (d.shifts.length === 0) out.push(' No shifts');
  for (const s of d.shifts) {
    const span = `${timeOnly(formatStamp(s.openedAt, timezone))}-${s.closedAt ? timeOnly(formatStamp(s.closedAt, timezone)) : 'open'}`;
    out.push(cols(w, w >= 40 ? `${s.cashier} ${span}` : s.cashier, String(s.orders), usd(s.netCents)));
    if (w < 40) out.push(` ${span}`);
  }
  out.push(rule(w), ...paymentsBlock(w, d.payments, 0), rule(w), cols(w, 'CATEGORIES', 'qty', 'net'));
  d.categories.forEach((c) => out.push(cols(w, c.label, String(c.qty), usd(c.netCents))));
  out.push(rule(w), cols(w, 'TOP ITEMS', 'qty', 'net'));
  d.products.forEach((p) => out.push(cols(w, p.label, String(p.qty), usd(p.netCents))));
  out.push(rule(w), cols(w, 'TABLES (day)', 'open', 'total'));
  if (d.tables.length === 0) out.push(' No tables');
  d.tables.forEach((row) => out.push(tableLine(w, row, timezone)));
  out.push(rule(w), 'CASH DIFFERENCES');
  const counted = d.shifts.filter((s) => s.varianceUsdCents != null);
  if (counted.length === 0) out.push(' No closed shifts');
  counted.forEach((s) => out.push(lr(w, s.cashier, `USD ${signed(usd(s.varianceUsdCents ?? 0), s.varianceUsdCents ?? 0)} / ${signed(khr(s.varianceKhrRiel ?? 0), s.varianceKhrRiel ?? 0)}`)));
  out.push(lr(w, 'Outstanding tickets', d.unpaid.count ? `${d.unpaid.count} · ${usd(d.unpaid.totalCents)}` : 'none'));
  d.unpaid.labels.forEach((l) => out.push(` ${l}`));
  out.push(rule(w, '='), center(w, 'End of daily report'));
  return out;
}
