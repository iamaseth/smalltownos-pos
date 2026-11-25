/** Receipt, A4/PDF and Telegram output for the X-report, Z-report and daily sales report. */
import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import api from '@/lib/api';
import { columnsForConfiguredPrinter } from '@print/width';
import { renderDailyReport, renderShiftReport, type DailyReportData, type ShiftReportData } from '@print/shift-report-text';
import { cashierDayRows, cashierShiftRows, rowToText, type ReceiptRow } from '@print/cashier-receipt';
import { useAuthStore } from '@/store/auth';
import { usePrinterStore } from '@/hooks/usePrinter';
import { usePosSettingsStore } from '@/store/pos-settings';
import { printerService } from './PrinterService';
import { runPrintJob } from './print-jobs';

export type ReportTarget = { kind: 'shift'; sessionId: number } | { kind: 'daily'; date: string };

async function fetchReport(target: ReportTarget): Promise<ShiftReportData | DailyReportData> {
  const res = target.kind === 'shift'
    ? await api.get('/reports/shift-report', { params: { session_id: target.sessionId } })
    : await api.get('/reports/daily-report', { params: { date: target.date } });
  return res.data;
}

function render(target: ReportTarget, data: ShiftReportData | DailyReportData, columns: number, reprint: boolean): string[] {
  return target.kind === 'shift'
    ? renderShiftReport(data as ShiftReportData, columns, data.timezone, reprint)
    : renderDailyReport(data as DailyReportData, columns, data.timezone, reprint);
}

function title(target: ReportTarget, data: ShiftReportData | DailyReportData): string {
  return target.kind === 'shift'
    ? `${(data as ShiftReportData).kind}-report shift #${target.sessionId}`
    : `Daily sales ${target.date}`;
}

function pageLabel(target: ReportTarget, data: ShiftReportData | DailyReportData): string {
  return target.kind === 'shift'
    ? `${(data as ShiftReportData).kind}-report #${target.sessionId}`
    : `Daily report ${target.date}`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Prints on the receipt printer (WebUSB bytes when connected, otherwise the browser
 * frame at receipt width). `auto` is the one-off Z print at close; the ledger skips a
 * duplicate of it. Any later Z print is marked REPRINT; X and daily reports are live copies.
 */
export async function printReportReceipt(target: ReportTarget, opts: { auto?: boolean; detailed?: boolean } = {}): Promise<void> {
  const data = await fetchReport(target);
  const paper = usePosSettingsStore.getState().printerPaperSize === 'thermal80' ? 80 : 58;
  const printer = usePrinterStore.getState();
  const columns = columnsForConfiguredPrinter((printer.webusbPrinter ?? printer.hardwarePrinter)?.paper_width, paper);
  const reprint = !opts.auto && target.kind === 'shift' && (data as ShiftReportData).kind === 'Z';
  const key = target.kind === 'shift' ? `shift-report:${(data as ShiftReportData).kind}:${target.sessionId}` : `daily-report:${target.date}`;
  if (!opts.detailed) {
    // Cashier layout: bigger text, only what the cashier needs (the Full reports keep the detailed one).
    const printedBy = useAuthStore.getState().user?.name ?? null;
    const rows = target.kind === 'shift'
      ? cashierShiftRows(data as ShiftReportData, data.timezone, { reprint, printedBy })
      : cashierDayRows(data as DailyReportData, data.timezone, { reprint, printedBy });
    await printRows(rows, columns, paper, {
      jobKey: opts.auto ? key : `${key}:print:${Date.now()}`,
      label: `${title(target, data)}${reprint ? ' (reprint)' : ''}`,
      payload: target,
      pageLabel: pageLabel(target, data),
    });
    return;
  }
  const lines = render(target, data, columns, reprint);
  await printLines(lines, columns, paper, {
    jobKey: opts.auto ? key : `${key}:print:${Date.now()}`,
    label: `${title(target, data)}${reprint ? ' (reprint)' : ''}`,
    payload: target,
    pageLabel: pageLabel(target, data),
  });
}

/** Prints plain report lines on the receipt printer (WebUSB) or the browser print path. */
async function printLines(lines: string[], columns: number, paper: 58 | 80, job: { jobKey: string; label: string; payload: unknown; pageLabel: string }): Promise<void> {
  const printer = usePrinterStore.getState();
  const transport = printer.currentTransport() === 'webusb' ? 'webusb' : 'browser';
  await printerService.awaitPendingReconnect();
  await runPrintJob({ jobKey: job.jobKey, kind: 'other', label: job.label, transport, payload: job.payload }, async () => {
    if (transport === 'webusb') {
      const enc = new ReceiptPrinterEncoder({ columns });
      enc.initialize();
      for (const line of lines) enc.text(line).newline();
      enc.newline().newline().newline().cut();
      await printerService.print(enc.encode());
      return;
    }
    const { printHtmlInFrame } = await import('./frame-print');
    const lineHtml = lines.map((line) => `<div class="receipt-line">${line ? escapeHtml(line) : '&nbsp;'}</div>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(job.label)}</title>
<style>html,body{margin:0;padding:0;display:block}body{font:12px/1.25 'Courier New',monospace}.receipt-report{margin:0;padding:0}.receipt-line{min-height:1.25em;white-space:pre}</style></head>
<body><div class="receipt-report">${lineHtml}</div></body></html>`;
    await printHtmlInFrame(html, {
      receiptPaperWidthMm: paper,
      receiptPageLengthMm: usePosSettingsStore.getState().receiptPageLengthMm,
      reportPageLabel: job.pageLabel,
    });
  });
}

const ROW_CLASS: Record<ReceiptRow['kind'], string> = {
  title: 'r-title', heading: 'r-heading', sub: 'r-sub', rule: 'r-rule', section: 'r-section', line: 'r-line',
  strong: 'r-strong', big: 'r-big', result: 'r-result', note: 'r-note', footer: 'r-footer',
};

/** Browser print: real font sizes. Each row is a .receipt-line so long reports paginate between rows. */
export function receiptRowsHtml(rows: ReceiptRow[], label: string): string {
  const body = rows.map((r) => {
    const cls = `receipt-line ${ROW_CLASS[r.kind]}`;
    if (r.kind === 'rule') return `<div class="${cls}"></div>`;
    if (r.right != null) return `<div class="${cls}"><span>${escapeHtml(r.left)}</span><span>${escapeHtml(r.right)}</span></div>`;
    return `<div class="${cls}">${escapeHtml(r.left) || '&nbsp;'}</div>`;
  }).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(label)}</title>
<style>
html,body{margin:0;padding:0;display:block;color:#000}
body{font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:15px;line-height:1.35}
.receipt-report{margin:0;padding:0 3mm;box-sizing:border-box;width:100%}
.receipt-line{min-width:0}
.receipt-line span:first-child{overflow-wrap:anywhere}
.receipt-line{display:flex;justify-content:space-between;gap:6px;min-height:1.35em}
.receipt-line span:last-child{text-align:right;white-space:nowrap}
.r-title{justify-content:center;font-size:20px;font-weight:900;letter-spacing:.04em}
.r-heading{justify-content:center;font-size:17px;font-weight:900}
.r-sub,.r-footer{justify-content:center;text-align:center;font-size:14px}
.r-footer{font-size:12px;font-weight:600;margin-top:2px}
.r-rule{min-height:0;border-top:2px dashed #000;margin:6px 0}
.r-section{font-size:13px;font-weight:900;letter-spacing:.06em;margin-top:2px}
.r-strong{font-weight:900;font-size:16px}
.r-big{font-size:24px;font-weight:900;line-height:1.25}
.r-result{font-size:20px;font-weight:900;border:3px solid #000;padding:3px 6px;margin-top:4px}
.r-note{font-size:12px;font-weight:600;padding-left:10px;min-height:0}
</style></head>
<body><div class="receipt-report" data-rich="1">${body}</div></body></html>`;
}

/** USB printer: the same rows with bold and double size for the headline lines. */
function encodeRows(enc: ReceiptPrinterEncoder, rows: ReceiptRow[], columns: number): void {
  for (const r of rows) {
    const double = r.kind === 'title' || r.kind === 'big' || r.kind === 'result';
    const bold = double || r.kind === 'heading' || r.kind === 'section' || r.kind === 'strong';
    if (double) enc.width(2).height(2);
    enc.bold(bold);
    for (const line of rowToText(r, columns)) enc.text(line).newline();
    if (double) enc.width(1).height(1);
    enc.bold(false);
  }
}

async function printRows(rows: ReceiptRow[], columns: number, paper: 58 | 80, job: { jobKey: string; label: string; payload: unknown; pageLabel: string }): Promise<void> {
  const printer = usePrinterStore.getState();
  const transport = printer.currentTransport() === 'webusb' ? 'webusb' : 'browser';
  await printerService.awaitPendingReconnect();
  await runPrintJob({ jobKey: job.jobKey, kind: 'other', label: job.label, transport, payload: job.payload }, async () => {
    if (transport === 'webusb') {
      const enc = new ReceiptPrinterEncoder({ columns });
      enc.initialize();
      encodeRows(enc, rows, columns);
      enc.newline().newline().newline().cut();
      await printerService.print(enc.encode());
      return;
    }
    const { printHtmlInFrame } = await import('./frame-print');
    await printHtmlInFrame(receiptRowsHtml(rows, job.label), {
      receiptPaperWidthMm: paper,
      receiptPageLengthMm: usePosSettingsStore.getState().receiptPageLengthMm,
      reportPageLabel: job.pageLabel,
    });
  });
}

/** Prints a ready-made cashier receipt (the Reports tab lists, week and month summaries). */
export async function printReceiptRows(label: string, rows: ReceiptRow[]): Promise<void> {
  const paper = usePosSettingsStore.getState().printerPaperSize === 'thermal80' ? 80 : 58;
  const printer = usePrinterStore.getState();
  const columns = columnsForConfiguredPrinter((printer.webusbPrinter ?? printer.hardwarePrinter)?.paper_width, paper);
  await printRows(rows, columns, paper, { jobKey: `list:${label}:${Date.now()}`, label, payload: { kind: 'list', title: label }, pageLabel: label });
}

/** Week or month summary for the simple Reports page, printed as one compact receipt. */
export async function printSummaryReceipt(titleText: string, build: (columns: number) => string[]): Promise<void> {
  const paper = usePosSettingsStore.getState().printerPaperSize === 'thermal80' ? 80 : 58;
  const printer = usePrinterStore.getState();
  const columns = columnsForConfiguredPrinter((printer.webusbPrinter ?? printer.hardwarePrinter)?.paper_width, paper);
  await printLines(build(columns), columns, paper, { jobKey: `summary:${titleText}:${Date.now()}`, label: titleText, payload: { kind: 'summary', title: titleText }, pageLabel: titleText });
}

/**
 * Opens a full-page copy in a new tab with a Print / Save as PDF button. The tab is
 * opened before the fetch so the browser treats it as part of the click.
 */
export async function openReportA4(target: ReportTarget): Promise<void> {
  const win = window.open('', '_blank');
  if (!win) throw new Error('Allow pop-ups for this site to open the A4 / PDF copy');
  win.document.write('<p style="font-family:sans-serif;padding:24px">Loading report…</p>');
  try {
    const data = await fetchReport(target);
    const lines = render(target, data, 64, false);
    win.document.open();
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title(target, data))}</title>
<style>
@page{size:A4;margin:16mm}
body{font-family:system-ui,sans-serif;margin:24px;color:#111}
.bar{display:flex;gap:8px;margin-bottom:16px}
.bar button{font-size:15px;padding:8px 14px;border-radius:8px;border:1px solid #999;background:#fff;cursor:pointer}
pre{font:13px/1.35 'Courier New',monospace;white-space:pre;margin:0}
@media print{.bar{display:none}body{margin:0}}
</style></head><body>
<div class="bar"><button onclick="window.print()">Print / Save as PDF</button><button onclick="window.close()">Close</button></div>
<pre>${escapeHtml(lines.join('\n'))}</pre></body></html>`);
    win.document.close();
  } catch (error) {
    win.close();
    throw error;
  }
}

export async function sendReportTelegram(target: ReportTarget): Promise<{ sent: number; pending: number; failed: number }> {
  const res = target.kind === 'shift'
    ? await api.post('/reports/shift-report/telegram', { session_id: target.sessionId })
    : await api.post('/reports/daily-report/telegram', { date: target.date });
  return res.data;
}
