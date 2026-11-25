'use client';

/**
 * BackStreet print status + help, for the computer the printer is plugged into.
 * Shows where prints go (USB on this computer / Chrome print dialog / desktop app),
 * connects the USB printer, prints a test, lists kitchen tickets and receipts that
 * did not print (Retry / Dismiss) and shows diagnostics.
 */
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { Printer, AlertTriangle, CheckCircle2, RefreshCw, X } from 'lucide-react';
import api from '@/lib/api';
import { usePrinterStore } from '@/hooks/usePrinter';
import { useAuthStore } from '@/store/auth';
import { printerService } from '@/lib/printer/PrinterService';
import { printErrorHelp, runPrintJob, usePrintAlerts, classifyLocalPrintError, PrintSkippedError } from '@/lib/printer/print-jobs';
import type { Bill, Order, OrderItem } from '@/lib/types';

interface Job {
  id: number; job_key: string; kind: string; label: string; transport: string; status: string; attempts: number;
  last_error_code: string | null; last_error: string | null; updated_at: string;
  payload: { billId?: number; isReprint?: boolean; orderId?: number; stationName?: string | null; items?: OrderItem[] | null };
}

/** ESC/POS test slip: init, centered bold title, lines, feed and partial cut. 80 mm = 48 chars (Font A). */
function testSlipBytes(): Uint8Array {
  const enc = new TextEncoder();
  const now = new Date().toLocaleString('en-GB');
  const parts: number[] = [];
  const push = (...b: number[]) => parts.push(...b);
  const text = (s: string) => parts.push(...enc.encode(s));
  push(0x1b, 0x40);                 // init
  push(0x1b, 0x61, 0x01);           // center
  push(0x1b, 0x45, 0x01); text('BACKSTREET RIVERSIDE\n'); push(0x1b, 0x45, 0x00);
  text('Printer test\n');
  push(0x1b, 0x61, 0x00);           // left
  text('------------------------------------------------\n');
  text(`Time: ${now}\n`);
  text('If you can read this, the USB printer works.\n');
  text('------------------------------------------------\n\n\n\n');
  push(0x1d, 0x56, 0x42, 0x00);     // feed + partial cut
  return Uint8Array.from(parts);
}

export default function PrintCenter({ open, onOpenChange: setOpen }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { status, printMethod, setPrintMethod, connect, runtime, refreshHardwarePrinter, deviceInfo, lastError, printBill, printKot, currentTransport } = usePrinterStore();
  const tenant = useAuthStore((s) => s.currentTenant);
  const { failedCount, version, setFailed } = usePrintAlerts();
  const [failed, setFailedJobs] = useState<Job[]>([]);
  const [recent, setRecent] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);

  const loadJobs = useCallback(async (withRecent: boolean) => {
    try {
      const f = await api.get('/print-jobs/failed');
      setFailedJobs(f.data.jobs || []);
      setFailed((f.data.jobs || []).length);
      if (withRecent) setRecent((await api.get('/print-jobs/recent')).data.jobs || []);
    } catch { /* older server or no permission */ }
  }, [setFailed]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => { void loadJobs(true); }, 0);
    return () => clearTimeout(timer);
  }, [open, loadJobs]);

  useEffect(() => {
    void refreshHardwarePrinter();
  }, [refreshHardwarePrinter]);

  useEffect(() => {
    let active = true;
    const tick = () => {
      api.get('/print-jobs/failed').then((f) => {
        if (!active) return;
        setFailedJobs(f.data.jobs || []);
        setFailed((f.data.jobs || []).length);
      }).catch(() => undefined);
    };
    tick();
    const timer = setInterval(tick, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [version, setFailed]);

  const transport = currentTransport();
  const usbConnected = status === 'connected';
  const label = printMethod === 'browser'
    ? 'Print: Chrome dialog'
    : transport === 'native' ? 'Print: desktop printer'
      : usbConnected ? 'USB printer ✓' : 'Printer not connected';
  const tone = failedCount > 0 ? 'border-red-500 bg-red-600 text-white'
    : printMethod === 'browser' || usbConnected || transport === 'native' ? 'border-[#1e293b] bg-[#182234] text-slate-100'
      : 'border-amber-500 bg-amber-500 text-black';

  const retry = async (job: Job) => {
    setBusy(true);
    try {
      if (job.kind === 'receipt' && job.payload.billId && tenant) {
        const res = await api.get(`/bills/${job.payload.billId}`);
        await printBill(res.data.bill as Bill, tenant, { isReprint: Boolean(job.payload.isReprint) });
      } else if (job.kind === 'kot' && job.payload.orderId) {
        const res = await api.get(`/orders/${job.payload.orderId}`);
        const order = res.data.order as Order;
        await printKot(order, {
          ...(job.payload.items ? { items: job.payload.items } : {}),
          ...(job.payload.stationName ? { stationName: job.payload.stationName } : {}),
        });
      } else {
        toast.error('This job cannot be retried automatically');
        return;
      }
      toast.success('Printed');
    } catch (error) {
      if (error instanceof PrintSkippedError) toast(error.message, { icon: '🖨️' });
      else toast.error(printErrorHelp(classifyLocalPrintError(error)));
    } finally {
      setBusy(false);
      await loadJobs(open);
    }
  };

  const dismiss = async (job: Job) => {
    try { await api.post(`/print-jobs/${job.id}/dismiss`); } catch { /* ignore */ }
    await loadJobs(open);
  };

  const testPrint = async () => {
    setBusy(true);
    try {
      await runPrintJob({ jobKey: `test:${Date.now()}`, kind: 'test', label: 'Printer test', transport: currentTransport() }, async () => {
        if (printMethod === 'browser' || !usbConnected) {
          await printerService.printViaBrowser('<div style="text-align:center"><b>BACKSTREET RIVERSIDE</b><br/>Printer test<br/>' + new Date().toLocaleString('en-GB') + '</div>', 80);
        } else {
          await printerService.print(testSlipBytes());
        }
      });
      toast.success('Test sent to the printer');
    } catch (error) {
      toast.error(printErrorHelp(classifyLocalPrintError(error)));
    } finally {
      setBusy(false);
      await loadJobs(true);
    }
  };

  const webUsbSupported = typeof navigator !== 'undefined' && 'usb' in navigator;

  return (
    <div className="relative">
      {(failedCount > 0 || !(printMethod === 'browser' || usbConnected || transport === 'native')) && <button type="button" onClick={() => setOpen(!open)}
        className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-[11px] font-semibold ${tone}`} aria-expanded={open}>
        {failedCount > 0 ? <AlertTriangle size={15} /> : <Printer size={15} />}
        <span>{failedCount > 0 ? `${failedCount} not printed` : label}</span>
      </button>}
      {open && (
        <>
          <button type="button" className="fixed inset-0 z-40 cursor-default" aria-label="Close printer panel" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-2 w-96 max-w-[94vw] space-y-3 rounded-xl border border-slate-700 bg-[#111a2e] p-4 text-sm text-slate-100 shadow-2xl">
            <div className="flex items-center justify-between">
              <b>Printer on this computer</b>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close"><X size={16} /></button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button type="button" disabled={busy || !webUsbSupported} onClick={async () => { setPrintMethod('escpos'); await connect(); await refreshHardwarePrinter(); }}
                className={`rounded-lg px-3 py-2 font-semibold ${printMethod === 'escpos' ? 'bg-emerald-600' : 'bg-slate-700'} disabled:opacity-50`}>
                {usbConnected ? 'Choose another USB printer' : 'Connect USB printer'}
              </button>
              <button type="button" onClick={() => setPrintMethod(printMethod === 'browser' ? 'escpos' : 'browser')}
                className={`rounded-lg px-3 py-2 font-semibold ${printMethod === 'browser' ? 'bg-emerald-600' : 'bg-slate-700'}`}>
                {printMethod === 'browser' ? 'Chrome dialog ✓' : 'Use Chrome dialog'}
              </button>
              <button type="button" disabled={busy} onClick={testPrint} className="col-span-2 rounded-lg bg-slate-700 px-3 py-2 font-semibold disabled:opacity-50">
                Print test slip
              </button>
            </div>

            <div>
              <div className="mb-1 font-semibold">{failed.length ? 'Not printed' : 'All tickets printed'}</div>
              {failed.length === 0 && <div className="flex items-center gap-2 text-emerald-400"><CheckCircle2 size={15} /> Nothing waiting</div>}
              <div className="max-h-56 space-y-2 overflow-y-auto">
                {failed.map((job) => (
                  <div key={job.id} className={`rounded-lg border p-2 ${job.kind === 'kot' ? 'border-red-500 bg-red-950/40' : 'border-slate-600'}`}>
                    <div className="font-semibold">{job.kind === 'kot' ? '🍳 ' : '🧾 '}{job.label}</div>
                    <div className="text-xs text-slate-300">{printErrorHelp(job.last_error_code || 'unknown')}</div>
                    <div className="mt-2 flex gap-2">
                      <button type="button" disabled={busy} onClick={() => retry(job)} className="flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-xs font-semibold disabled:opacity-50">
                        <RefreshCw size={12} /> Retry
                      </button>
                      <button type="button" onClick={() => dismiss(job)} className="rounded bg-slate-700 px-2 py-1 text-xs">Dismiss</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <details className="text-xs text-slate-300">
              <summary className="cursor-pointer font-semibold text-slate-100">Diagnostics</summary>
              <div className="mt-2 space-y-1">
                <div>Runs on: {runtime === 'cloud' ? 'Online POS (prints from this computer)' : runtime === 'desktop' ? 'Desktop app' : 'unknown'}</div>
                <div>Print path now: {transport}</div>
                <div>Chrome USB support: {webUsbSupported ? 'yes' : 'no — use Chrome or Edge on a computer'}</div>
                <div>USB status: {status}{deviceInfo ? ` — ${deviceInfo.manufacturerName ?? ''} ${deviceInfo.productName ?? ''} (${deviceInfo.vendorId.toString(16)}:${deviceInfo.productId.toString(16)})` : ''}</div>
                {lastError && <div className="text-amber-300">Last error: {lastError}<br />{printErrorHelp(classifyLocalPrintError(new Error(lastError)))}</div>}
                <div className="pt-1 font-semibold text-slate-100">Recent jobs</div>
                {recent.slice(0, 10).map((j) => (
                  <div key={j.id} className="flex justify-between gap-2">
                    <span className="truncate">{j.label || j.job_key}</span>
                    <span className={j.status === 'failed' ? 'text-red-400' : 'text-slate-400'}>{j.status}{j.attempts > 1 ? ` ×${j.attempts}` : ''} · {j.transport}</span>
                  </div>
                ))}
              </div>
            </details>
          </div>
        </>
      )}
    </div>
  );
}
