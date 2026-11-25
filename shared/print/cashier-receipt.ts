/**
 * Cashier-friendly receipt layout for shift, day and list reports (Reports page
 * and the Z print at shift close). Built as rows so the browser print can use
 * real font sizes and the USB printer can use bold and double size; rowsToText()
 * gives plain lines for anything else. Money is integer cents (USD) or riel.
 */
import {
  usd, khr, formatStamp,
  type DailyReportData, type ReportAdjustmentRow, type ReportDayCash, type ReportOrderRow, type ReportPaymentRow, type ReportQtyRow, type ShiftReportData,
} from './shift-report-text';

/** title: business name · heading: report name · sub: who/when · big: headline money · result: boxed cash result. */
export type ReceiptRowKind = 'title' | 'heading' | 'sub' | 'rule' | 'section' | 'line' | 'strong' | 'big' | 'result' | 'note' | 'footer';
export interface ReceiptRow { kind: ReceiptRowKind; left: string; right?: string }

const row = (kind: ReceiptRowKind, left: string, right?: string): ReceiptRow => ({ kind, left, ...(right != null ? { right } : {}) });
const rule = (): ReceiptRow => row('rule', '');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const time = (utc: string | null, tz: string) => (utc ? formatStamp(utc, tz).split(' ').slice(-1)[0] : '—');
const dayLabel = (utc: string, tz: string) => formatStamp(utc, tz).split(' ').slice(0, 2).join(' ');
const money = (usdCents: number, riel: number) => (riel ? (usdCents ? `${usd(usdCents)} + ${khr(riel)}` : khr(riel)) : usd(usdCents));

/** Day before 16:00 local, Night after: the same rule as the Reports shift buttons. */
export function shiftPartLabel(openedAtUtc: string, tz: string): 'Day' | 'Night' {
  const hour = Number(time(openedAtUtc, tz).split(':')[0]);
  return hour >= 5 && hour < 16 ? 'Day' : 'Night';
}

/** Payment label groups: Cash (USD + riel), Card, QR (ACLEDA / ABA / KHQR / Wing); anything else is Other. */
function payGroup(label: string): 'cash' | 'card' | 'qr' | 'other' {
  if (/^cash/i.test(label)) return 'cash';
  if (/card|visa|master|amex|jcb|union/i.test(label)) return 'card';
  if (/aba|acleda|khqr|qr|wing|bakong/i.test(label)) return 'qr';
  return 'other';
}

/** SALES big, then Cash / Card / QR under it, then Tables / To go / Orders. */
function salesTop(netCents: number, payments: ReportPaymentRow[], orders: ReportOrderRow[], orderCount: number): ReceiptRow[] {
  const sum = (g: string) => payments.filter((p) => payGroup(p.label) === g)
    .reduce((a, p) => ({ usd: a.usd + p.usdCents, khr: a.khr + p.khrRiel }), { usd: 0, khr: 0 });
  const cash = sum('cash'); const card = sum('card'); const qr = sum('qr'); const other = sum('other');
  const toGo = orders.filter((o) => o.label === 'To Go').length;
  const out: ReceiptRow[] = [
    row('big', 'SALES', usd(netCents)),
    row('line', '  Cash', money(cash.usd, cash.khr)),
    row('line', '  Card', money(card.usd, card.khr)),
    row('line', '  QR', money(qr.usd, qr.khr)),
  ];
  if (other.usd || other.khr) out.push(row('line', '  Other', money(other.usd, other.khr)));
  out.push(row('line', 'Tables', String(Math.max(0, orders.length - toGo))), row('line', 'To go', String(toGo)), row('line', 'Orders', String(orderCount)));
  return out;
}

function cashResult(variance: number | null, matches: boolean | null): string {
  if (variance == null) return 'NOT COUNTED';
  if (matches || variance === 0) return 'MATCHED';
  return `${variance < 0 ? 'SHORT' : 'OVER'} ${usd(Math.abs(variance))}`;
}

interface DrawerNumbers {
  openingUsdCents: number; openingKhrRiel: number; cashSalesUsdCents: number; cashSalesKhrRiel: number;
  payInUsdCents: number; payInKhrRiel: number; payOutUsdCents: number; payOutKhrRiel: number; cashRefundUsdCents: number;
  expectedUsdCents: number; expectedKhrRiel: number; countedUsdCents: number | null; countedKhrRiel: number | null;
  floatKeptUsdCents?: number | null; floatKeptKhrRiel?: number | null;
}

/**
 * Cash in the cashier's words. The float is shown but left out of the sums:
 * cash sales - purchases = should have; cash on hand is the count without the
 * float; then matched / short / over. The same float is taken off both sides,
 * so the difference is the system's own closing difference.
 */
function drawerBlock(c: DrawerNumbers, counted: boolean, result: string, note?: string): ReceiptRow[] {
  const floatUsd = c.floatKeptUsdCents ?? c.openingUsdCents;
  const floatKhr = c.floatKeptKhrRiel ?? c.openingKhrRiel;
  const out: ReceiptRow[] = [
    row('section', 'CASH'),
    row('line', 'Float', money(floatUsd, floatKhr)),
    row('line', 'Cash sales', money(c.cashSalesUsdCents, c.cashSalesKhrRiel)),
  ];
  if (c.payInUsdCents || c.payInKhrRiel) out.push(row('line', '+ Cash added', money(c.payInUsdCents, c.payInKhrRiel)));
  out.push(row('line', '- Purchases', money(c.payOutUsdCents, c.payOutKhrRiel)));
  if (c.cashRefundUsdCents) out.push(row('line', '- Cash refunds', usd(c.cashRefundUsdCents)));
  if (counted && c.countedUsdCents != null) {
    out.push(row('strong', 'Cash on hand', money(c.countedUsdCents - floatUsd, (c.countedKhrRiel ?? 0) - floatKhr)));
    out.push(row('result', 'RESULT', result));
  } else {
    // Shift still open (X) or not counted yet: show what should be in hand without the float.
    out.push(row('strong', 'Cash in hand now', money(c.expectedUsdCents - floatUsd, c.expectedKhrRiel - floatKhr)));
  }
  if (note) out.push(row('note', note));
  return out;
}

/** Discounts, refunds, voids and free items, always listed so a zero is visible too. */
function extrasBlock(sales: { discountCents: number; refundCount: number; refundCents: number; voidCount: number; voidCents: number; compCount: number; compCents: number }, unpaid: { count: number; totalCents: number }): ReceiptRow[] {
  return [
    row('section', 'DISCOUNTS, REFUNDS, VOIDS, FREE'),
    row('line', 'Discounts', usd(sales.discountCents)),
    row('line', `Refunds (${sales.refundCount})`, usd(sales.refundCents)),
    row('line', `Voids / deleted (${sales.voidCount})`, usd(sales.voidCents)),
    row('line', `Free / comps (${sales.compCount})`, usd(sales.compCents)),
    row('line', 'Unpaid tables', unpaid.count ? `${unpaid.count} · ${usd(unpaid.totalCents)}` : '0'),
  ];
}

/** Shift report for the cashier: X while open, Z when closed. */
export function cashierShiftRows(d: ShiftReportData, tz: string, opts: { reprint?: boolean; printedBy?: string | null } = {}): ReceiptRow[] {
  const closing = d.kind === 'Z';
  const c = d.cash;
  const out: ReceiptRow[] = [
    row('title', d.businessName.toUpperCase()),
    row('heading', closing ? 'SHIFT CLOSED' : 'SHIFT SO FAR'),
    ...(opts.reprint ? [row('heading', '*** REPRINT ***')] : []),
    row('sub', `${shiftPartLabel(d.openedAt, tz)} · ${d.cashier} · ${dayLabel(d.openedAt, tz)}`),
    row('sub', `${time(d.openedAt, tz)} – ${closing && d.closedAt ? time(d.closedAt, tz) : 'still open'}`),
    rule(),
    ...salesTop(d.sales.netCents, d.payments, d.orders, d.sales.orders),
    rule(),
  ];
  out.push(...drawerBlock(c, closing, cashResult(c.varianceCombinedCents ?? c.varianceUsdCents, c.matches)));
  if (d.spent.length) {
    out.push(rule(), row('section', 'PURCHASES'));
    d.spent.forEach((s) => out.push(row('line', s.label, money(s.usdCents, s.khrRiel))));
  }
  out.push(rule(), ...extrasBlock(d.sales, d.unpaid));
  if (d.passedOn?.length) {
    out.push(rule(), row('section', 'PASSED ON'));
    d.passedOn.forEach((t) => out.push(row('line', `${t.label} to ${t.to ?? 'next cashier'}`, usd(t.totalCents))));
  }
  if (d.notes.length) {
    out.push(rule(), row('section', 'NOTES'));
    d.notes.forEach((n) => out.push(row('note', n)));
  }
  out.push(rule(), row('footer', `Printed ${formatStamp(d.printedAt, tz)}${opts.printedBy ? ` by ${opts.printedBy}` : ''}`));
  return out;
}

function dayDrawer(c: ReportDayCash): ReceiptRow[] {
  // Cash on hand and the result only make sense once every shift of the day is counted.
  const allCounted = c.shiftsTotal > 0 && c.shiftsCounted === c.shiftsTotal;
  const variance = c.varianceCombinedCents ?? c.varianceUsdCents;
  const note = c.shiftsTotal > 0 && !allCounted ? `${c.shiftsCounted} of ${plural(c.shiftsTotal, 'shift')} counted so far` : undefined;
  return drawerBlock(c, allCounted, cashResult(variance, variance === 0), note);
}

/** Whole business day for the cashier: sales, how paid, each shift with its cash result. */
export function cashierDayRows(d: DailyReportData, tz: string, opts: { reprint?: boolean; printedBy?: string | null } = {}): ReceiptRow[] {
  const out: ReceiptRow[] = [
    row('title', d.businessName.toUpperCase()),
    row('heading', 'DAY REPORT'),
    ...(opts.reprint ? [row('heading', '*** REPRINT ***')] : []),
    row('sub', new Date(`${d.businessDate}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })),
    rule(),
    ...salesTop(d.sales.netCents, d.payments, d.orders, d.sales.orders),
    rule(),
    ...(d.cash ? [...dayDrawer(d.cash), rule()] : []),
    row('section', 'SHIFTS'),
  ];
  if (!d.shifts.length) out.push(row('line', 'No shifts'));
  for (const s of d.shifts) {
    out.push(row('line', `${shiftPartLabel(s.openedAt, tz)} · ${s.cashier}`, usd(s.netCents)));
    const counted = s.varianceUsdCents == null ? (s.closedAt ? 'not counted' : 'open now') : cashResult(s.varianceUsdCents, s.varianceUsdCents === 0 && !s.varianceKhrRiel).toLowerCase();
    out.push(row('note', `${time(s.openedAt, tz)}–${s.closedAt ? time(s.closedAt, tz) : 'open'} · ${plural(s.orders, 'order')} · ${counted}`));
  }
  out.push(rule(), ...extrasBlock(d.sales, d.unpaid));
  out.push(rule(), row('footer', `Printed ${formatStamp(d.printedAt, tz)}${opts.printedBy ? ` by ${opts.printedBy}` : ''}`));
  return out;
}

/** Header shared by the tab prints: title, what was printed (shift or day), when. */
function listHeader(businessName: string, title: string, scope: string): ReceiptRow[] {
  return [row('title', businessName.toUpperCase()), row('heading', title), row('sub', scope), rule()];
}

export function itemsSoldRows(businessName: string, scope: string, items: ReportQtyRow[], printedAt: string): ReceiptRow[] {
  const out = listHeader(businessName, 'ITEMS SOLD', scope);
  if (!items.length) out.push(row('line', 'Nothing sold'));
  items.forEach((i) => out.push(row('line', `${i.qty}x ${i.label}`, usd(i.netCents))));
  out.push(rule(), row('line', plural(items.reduce((n, i) => n + i.qty, 0), 'item')), row('big', 'TOTAL', usd(items.reduce((n, i) => n + i.netCents, 0))));
  out.push(row('footer', `Printed ${printedAt}`));
  return out;
}

export function ticketsRows(businessName: string, scope: string, tickets: ReportOrderRow[], tz: string, printedAt: string): ReceiptRow[] {
  const out = listHeader(businessName, 'TICKETS', scope);
  if (!tickets.length) out.push(row('line', 'No tickets'));
  tickets.forEach((t) => {
    out.push(row('line', `${time(t.openedAt, tz)} ${t.label}`, usd(t.totalCents)));
    out.push(row('note', t.status === 'paid' ? `${t.paidWith || 'paid'}${t.cashier ? ` · ${t.cashier}` : ''}` : 'NOT PAID'));
  });
  out.push(rule(), row('line', plural(tickets.length, 'ticket')), row('big', 'TOTAL', usd(tickets.reduce((n, t) => n + t.totalCents, 0))));
  out.push(row('footer', `Printed ${printedAt}`));
  return out;
}

export function paymentsRows(businessName: string, scope: string, payments: ReportPaymentRow[], printedAt: string): ReceiptRow[] {
  const out = listHeader(businessName, 'PAYMENTS', scope);
  const shown = payments.filter((p) => p.count > 0 || p.usdCents || p.khrRiel);
  if (!shown.length) out.push(row('line', 'No payments'));
  const groups: [string, 'cash' | 'card' | 'qr' | 'other'][] = [['Cash', 'cash'], ['Card', 'card'], ['QR', 'qr'], ['Other', 'other']];
  for (const [title, key] of groups) {
    const list = shown.filter((p) => payGroup(p.label) === key);
    if (!list.length) continue;
    const n = list.reduce((a, p) => a + p.count, 0);
    out.push(row('strong', `${title} (${n})`, money(list.reduce((a, p) => a + p.usdCents, 0), list.reduce((a, p) => a + p.khrRiel, 0))));
    if (list.length > 1 || list[0].label !== title) list.forEach((p) => out.push(row('note', `${p.label} (${p.count}): ${money(p.usdCents, p.khrRiel)}`)));
  }
  out.push(rule(), row('big', 'TOTAL', usd(shown.reduce((n, p) => n + p.usdCents, 0))));
  if (shown.some((p) => p.khrRiel)) out.push(row('line', '', khr(shown.reduce((n, p) => n + p.khrRiel, 0))));
  out.push(row('footer', `Printed ${printedAt}`));
  return out;
}

/** Deleted (voids) or Free (comps): each item with time, table, who asked and who approved. */
export function adjustmentRows(businessName: string, scope: string, kind: 'deleted' | 'free', rows: ReportAdjustmentRow[], tz: string, printedAt: string): ReceiptRow[] {
  const out = listHeader(businessName, kind === 'deleted' ? 'DELETED (VOIDS)' : 'FREE (COMPS)', scope);
  if (!rows.length) out.push(row('line', kind === 'deleted' ? 'Nothing deleted' : 'Nothing free'));
  rows.forEach((r) => {
    out.push(row('line', `${time(r.at, tz)} ${r.label} ${r.qty > 1 ? `${r.qty}x ` : ''}${r.product}`, usd(r.amountCents)));
    const why = kind === 'free' && r.reasonLabel ? `${r.reasonLabel} · ` : '';
    out.push(row('note', `${why}asked ${r.requestedBy || '—'}${r.approvedBy ? ` · ok ${r.approvedBy}` : ''}`));
  });
  out.push(rule(), row('line', plural(rows.reduce((n, r) => n + r.qty, 0), 'item')), row('big', 'TOTAL', usd(rows.reduce((n, r) => n + r.amountCents, 0))));
  out.push(row('footer', `Printed ${printedAt}`));
  return out;
}

/** Splits adjustments into the Deleted and Free lists (removed-before-send items count as deleted). */
export function splitAdjustments(rows: ReportAdjustmentRow[]): { deleted: ReportAdjustmentRow[]; free: ReportAdjustmentRow[] } {
  return { deleted: rows.filter((r) => r.kind !== 'comp'), free: rows.filter((r) => r.kind === 'comp') };
}

function fit(w: number, left: string, right = ''): string {
  if (!right) return left.length <= w ? left : left.slice(0, w);
  const gap = w - left.length - right.length;
  if (gap >= 1) return left + ' '.repeat(gap) + right;
  return `${left.slice(0, Math.max(0, w - right.length - 1))} ${right}`;
}
const centre = (w: number, t: string) => ' '.repeat(Math.max(0, Math.floor((w - t.length) / 2))) + t.slice(0, w);

function wrapWords(w: number, text: string, indent = ''): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > w - indent.length && cur) { out.push(indent + cur); cur = word; } else cur = next;
  }
  if (cur) out.push(indent + cur.slice(0, w - indent.length));
  return out;
}

/** Plain-text lines at `w` columns (big rows are laid out for double width, i.e. w/2 columns). */
export function rowToText(r: ReceiptRow, w: number): string[] {
  switch (r.kind) {
    case 'title': case 'heading': return [centre(r.kind === 'title' ? Math.floor(w / 2) : w, r.left)];
    case 'sub': case 'footer': return [centre(w, r.left)];
    case 'rule': return ['-'.repeat(w)];
    case 'section': return [r.left];
    case 'big': case 'result': return [fit(Math.floor(w / 2), r.left, r.right)];
    case 'note': return wrapWords(w, r.left, '  ');
    default: return [fit(w, r.left, r.right)];
  }
}

export function rowsToText(rows: ReceiptRow[], w: number): string[] {
  return rows.flatMap((r) => rowToText(r, w));
}
