'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { FileText, Printer, Send } from 'lucide-react';
import { openReportA4, printReportReceipt, sendReportTelegram, type ReportTarget } from '@/lib/printer/shift-report-print';

function message(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response?.data;
  return data?.error || (error as Error)?.message || fallback;
}

/** Receipt (80 mm) · PDF / A4 · Telegram for one report. */
export function ReportOutputButtons({ target, telegram = true, size = 'md' }: { target: ReportTarget; telegram?: boolean; size?: 'sm' | 'md' }) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } finally { setBusy(null); }
  };
  const cls = size === 'sm'
    ? 'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50'
    : 'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50';
  const icon = size === 'sm' ? 'size-3.5' : 'size-4';
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" className={cls} disabled={busy !== null}
        onClick={() => run('receipt', async () => {
          try { await printReportReceipt(target); toast.success('Sent to the receipt printer'); }
          catch (error) { toast.error(message(error, 'Could not print')); }
        })}>
        <Printer className={icon} /> {busy === 'receipt' ? 'Printing…' : 'Receipt'}
      </button>
      <button type="button" className={cls} disabled={busy !== null}
        onClick={() => run('a4', async () => {
          try { await openReportA4(target); }
          catch (error) { toast.error(message(error, 'Could not open the A4 copy')); }
        })}>
        <FileText className={icon} /> PDF / A4
      </button>
      {telegram && (
        <button type="button" className={cls} disabled={busy !== null}
          onClick={() => run('tg', async () => {
            try {
              const r = await sendReportTelegram(target);
              if (r.failed) toast.error(`Telegram: ${r.sent} sent, ${r.failed} failed`);
              else toast.success(r.pending ? `Telegram: ${r.sent} sent, ${r.pending} waiting` : `Sent to Telegram (${r.sent})`);
            } catch (error) { toast.error(message(error, 'Could not send to Telegram')); }
          })}>
          <Send className={icon} /> {busy === 'tg' ? 'Sending…' : 'Telegram'}
        </button>
      )}
    </div>
  );
}
