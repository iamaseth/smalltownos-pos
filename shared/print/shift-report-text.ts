/**
 * Plain-text layout for the X-report, Z-report and daily sales report on
 * receipt paper (42 columns on 80 mm, 32 on 58 mm — see columnsForReceiptPaperSize). Money is integer
 * cents (USD) or whole riel (KHR); nothing here calculates totals.
 */

export interface ReportPaymentRow { label: string; count: number; usdCents: number; khrRiel: number }
export interface ReportTableRow { label: string; who: string; openedAt: string | null; closedAt: string | null; bills: number; totalCents: number; status: 'paid' | 'open' | 'unpaid' }
export interface ReportOrderRow {
  id: number; orderNumber: string; label: string; cashier: string; openedAt: string; closedAt: string | null;
  totalCents: number; status: 'paid' | 'unpaid'; paidWith: string; shiftId: number | null;
}
/** A void, comp or removed item, with who asked and who approved. */
export interface ReportAdjustmentRow {
  kind: 'void' | 'comp' | 'removed'; at: string; product: string; qty: number; amountCents: number; label: string;
  requestedBy: string; approvedBy: string | null; channel: string | null; reason: string | null; reasonLabel: string; note: string | null;
}
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
  /** Who pressed Close; may differ from the cashier who opened the shift. */
  closedBy?: string | null;
  sales: ReportSales;
  payments: ReportPaymentRow[];
  unpaid: { count: number; totalCents: number; labels: string[] };
  tables: { served: number; completed: number; occupied: number; awaiting: ReportTableRow[]; rows: ReportTableRow[] };
  cash: ReportCash;
  spent: ReportSpentRow[];
  orders: ReportOrderRow[];
  adjustments: ReportAdjustmentRow[];
  /** Open tickets this cashier passed to someone else at close. */
  passedOn?: { label: string; totalCents: number; to: string | null }[];
  /** Coupons used on paid bills; the paper coupons should be in the drawer. */
  coupons?: { code: string; count: number; totalCents: number }[];
  notes: string[];
  telegram: string | null;
}

/** Cash drawer for a whole business day: every shift's float, cash sales, purchases and count added together. */
export interface ReportDayCash {
  openingUsdCents: number; openingKhrRiel: number;
  cashSalesUsdCents: number; cashSalesKhrRiel: number;
  payInUsdCents: number; payInKhrRiel: number;
  payOutUsdCents: number; payOutKhrRiel: number;
  cashRefundUsdCents: number;
  expectedUsdCents: number; expectedKhrRiel: number;
  /** Float left in the drawer at each close (opening float for shifts not closed yet). */
  floatKeptUsdCents: number; floatKeptKhrRiel: number;
  /** Sums over counted shifts only; null when no shift has been counted yet. */
  countedUsdCents: number | null; countedKhrRiel: number | null;
  varianceUsdCents: number | null; varianceKhrRiel: number | null; varianceCombinedCents: number | null;
  shiftsCounted: number; shiftsTotal: number;
}

export interface DailyReportData {
  businessName: string; timezone: string; businessDate: string; dayStart: string; dayEnd: string; printedAt: string;
  sales: ReportSales;
  cash?: ReportDayCash;
  shifts: ReportShiftRow[];
  payments: ReportPaymentRow[];
  categories: ReportQtyRow[];
  products: ReportQtyRow[];
  tables: ReportTableRow[];
  orders: ReportOrderRow[];
  adjustments: ReportAdjustmentRow[];
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
  const out = [center(w, name.toUpperCase()), center(w, `${title}${sub ? ` · ${sub}` : ''}`)];
  if (reprint) out.push(center(w, '*** REPRINT ***'));
  return out;
}

function salesBlock(w: number, s: ReportSales): string[] {
  const out = [
    'SALES',
    lr(w, 'Gross sales', usd(s.grossCents)),
  ];
  if (s.discountCents) out.push(lr(w, 'Discounts', usd(-s.discountCents)));
  if (s.refundCount || s.refundCents) out.push(lr(w, `Refunds (${s.refundCount})`, usd(-s.refundCents)));
  if (s.voidCount || s.voidCents) out.push(lr(w, `Voided items (${s.voidCount})`, `${usd(s.voidCents)} n/c`));
  if (s.compCount || s.compCents) out.push(lr(w, `Complimentary (${s.compCount})`, `${usd(s.compCents)} n/c`));
  out.push(lr(w, 'NET SALES', usd(s.netCents)), lr(w, 'Orders', String(s.orders)), lr(w, 'Average bill', usd(s.averageCents)));
  return out;
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

/** Compact totals only; item-level audit detail belongs in the separate ticket print. */
function adjustmentsBlock(w: number, rows: ReportAdjustmentRow[]): string[] {
  if (rows.length === 0) return [];
  const out = [w >= 40 ? 'VOIDS, COMPS & REMOVED ITEMS' : 'VOIDS, COMPS, REMOVED'];
  const groups: [string, (r: ReportAdjustmentRow) => boolean][] = [
    ['Voids', (r) => r.kind === 'void'],
    ['Comps', (r) => r.kind === 'comp' && r.reason !== 'entertainer'],
    ['Entertainer', (r) => r.kind === 'comp' && r.reason === 'entertainer'],
    ['Removed', (r) => r.kind === 'removed'],
  ];
  for (const [title, test] of groups) {
    const list = rows.filter(test);
    if (!list.length) continue;
    out.push(cols(w, title, String(list.reduce((n, r) => n + r.qty, 0)), usd(list.reduce((n, r) => n + r.amountCents, 0))));
  }
  out.push(lr(w, 'Not charged total', usd(rows.reduce((n, r) => n + r.amountCents, 0))));
  return out;
}

export function renderShiftReport(d: ShiftReportData, w: ReportWidth, timezone: string, reprint = false): string[] {
  const closing = d.kind === 'Z';
  const out: string[] = [
    ...header(w, d.businessName, closing ? 'Z-REPORT  SHIFT CLOSE' : 'X-REPORT  (shift still open)', closing ? `Shift #${d.shiftNumber}` : 'Not a closing report', reprint),
    lr(w, 'Cashier', d.cashier),
    ...(closing && d.closedBy ? [lr(w, 'Closed by', d.closedBy)] : []),
    lr(w, 'Register', d.register),
    lr(w, closing ? 'Opened' : 'Shift opened', formatStamp(d.openedAt, timezone)),
  ];
  if (closing && d.closedAt) out.push(lr(w, 'Closed', formatStamp(d.closedAt, timezone)), lr(w, 'Duration', duration(d.openedAt, d.closedAt)));
  out.push(...salesBlock(w, d.sales));
  out.push(...paymentsBlock(w, d.payments, d.cash.rate));
  if (d.unpaid.count || d.unpaid.totalCents) out.push(lr(w, closing ? 'Unpaid at close' : `Unpaid (${d.unpaid.count} ticket${d.unpaid.count === 1 ? '' : 's'})`, usd(d.unpaid.totalCents)));
  out.push('TABLES',
    lr(w, 'Tables served', String(d.tables.served)),
    lr(w, 'Completed', String(d.tables.completed)),
    lr(w, closing ? 'Still occupied' : 'Occupied now', String(d.tables.occupied)));
  out.push(lr(w, 'Awaiting payment', d.tables.awaiting.length
    ? `${d.tables.awaiting.length} · ${usd(d.tables.awaiting.reduce((sum, row) => sum + row.totalCents, 0))}`
    : '0'));
  out.push(...cashBlock(w, d.cash, closing));
  if (d.spent.length) {
    out.push('CASH SPENT');
    d.spent.forEach((s) => out.push(lr(w, ` ${s.label}`, `${s.khrRiel ? khr(s.khrRiel) : usd(s.usdCents)}${s.hasPhoto ? ' [photo]' : ''}`)));
  }
  if (closing) {
    out.push('CASH HANDLING');
    if (d.cash.floatKeptUsdCents != null) out.push(lr(w, 'Float kept', usd(d.cash.floatKeptUsdCents)));
    if (d.cash.floatKeptKhrRiel) out.push(lr(w, '', khr(d.cash.floatKeptKhrRiel)));
    if (d.cash.countedUsdCents != null && d.cash.floatKeptUsdCents != null) out.push(lr(w, 'Takings out USD', usd(d.cash.countedUsdCents - d.cash.floatKeptUsdCents)));
    if (d.cash.countedKhrRiel != null) out.push(lr(w, 'Takings out KHR', khr(d.cash.countedKhrRiel - (d.cash.floatKeptKhrRiel ?? 0))));
  }
  out.push(...adjustmentsBlock(w, d.adjustments ?? []));
  if (d.notes.length) {
    out.push('NOTES');
    d.notes.forEach((n) => out.push(...wrap(w, n)));
  }
  if (closing) out.push(lr(w, 'Telegram', d.telegram ?? 'not sent'));
  out.push(center(w, closing ? 'End of shift report' : w >= 40 ? 'X-report does not close the shift' : 'Shift is still open'));
  return out;
}

export function renderDailyReport(d: DailyReportData, w: ReportWidth, timezone: string, reprint = false): string[] {
  const out: string[] = [
    ...header(w, d.businessName, 'DAILY SALES REPORT', `Business day ${d.businessDate}`, reprint),
    lr(w, 'From', formatStamp(d.dayStart, timezone)),
    lr(w, 'To', formatStamp(d.dayEnd, timezone)),
    ...salesBlock(w, d.sales),
    cols(w, 'SHIFTS', w >= 40 ? 'ords' : 'no.', 'net'),
  ];
  if (d.shifts.length === 0) out.push(' No shifts');
  for (const s of d.shifts) {
    const span = `${timeOnly(formatStamp(s.openedAt, timezone))}-${s.closedAt ? timeOnly(formatStamp(s.closedAt, timezone)) : 'open'}`;
    out.push(cols(w, w >= 40 ? `${s.cashier} ${span}` : s.cashier, String(s.orders), usd(s.netCents)));
    if (w < 40) out.push(` ${span}`);
  }
  out.push(...paymentsBlock(w, d.payments, 0));
  out.push('CASH DIFFERENCES');
  const counted = d.shifts.filter((s) => s.varianceUsdCents != null);
  if (counted.length === 0) out.push(' No closed shifts');
  counted.forEach((s) => out.push(lr(w, s.cashier, `USD ${signed(usd(s.varianceUsdCents ?? 0), s.varianceUsdCents ?? 0)} / ${signed(khr(s.varianceKhrRiel ?? 0), s.varianceKhrRiel ?? 0)}`)));
  out.push(...adjustmentsBlock(w, d.adjustments ?? []));
  if (d.unpaid.count || d.unpaid.totalCents) {
    out.push(lr(w, 'Outstanding tickets', `${d.unpaid.count} · ${usd(d.unpaid.totalCents)}`));
  }
  out.push(center(w, 'End of daily report'));
  return out;
}
