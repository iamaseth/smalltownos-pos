/** Receipt, A4/PDF and Telegram output for the X-report, Z-report and daily sales report. */
import ReceiptPrinterEncoder from '@point-of-sale/receipt-printer-encoder';
import api from '@/lib/api';
import { columnsForConfiguredPrinter } from '@print/width';
import { renderDailyReport, renderShiftReport, type DailyReportData, type ShiftReportData } from '@print/shift-report-text';
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
export async function printReportReceipt(target: ReportTarget, opts: { auto?: boolean } = {}): Promise<void> {
  const data = await fetchReport(target);
  const paper = usePosSettingsStore.getState().printerPaperSize === 'thermal80' ? 80 : 58;
  const printer = usePrinterStore.getState();
  const columns = columnsForConfiguredPrinter((printer.webusbPrinter ?? printer.hardwarePrinter)?.paper_width, paper);
  const reprint = !opts.auto && target.kind === 'shift' && (data as ShiftReportData).kind === 'Z';
  const lines = render(target, data, columns, reprint);
  const key = target.kind === 'shift' ? `shift-report:${(data as ShiftReportData).kind}:${target.sessionId}` : `daily-report:${target.date}`;
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
