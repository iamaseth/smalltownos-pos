/**
 * Print job ledger client (BackStreet). Every receipt and kitchen ticket is
 * registered before printing so a double tap, an automatic retry or a switch
 * between USB and the Chrome dialog cannot print the same ticket twice, and a
 * failed kitchen ticket stays visible until it is printed or dismissed.
 *
 * Printing never depends on the ledger: if the server cannot be reached the
 * ticket still prints locally (the printer is on this computer).
 */
import api from '@/lib/api';
import { create } from 'zustand';
import { printerService } from './PrinterService';

export type PrintJobKind = 'receipt' | 'kot' | 'test' | 'other';
export type PrintTransport = 'webusb' | 'browser' | 'native' | 'unknown';
export type PrintErrorCode =
  | 'not_connected' | 'device_busy' | 'permission_denied' | 'driver_conflict' | 'popup_blocked'
  | 'not_configured' | 'offline' | 'timeout' | 'cancelled' | 'refused' | 'unknown';

/** Small store the POS uses to show the red "ticket did not print" badge. */
export const usePrintAlerts = create<{ failedCount: number; version: number; bump: (failedDelta?: number) => void; setFailed: (n: number) => void }>((set) => ({
  failedCount: 0,
  version: 0,
  bump: (failedDelta = 0) => set((s) => ({ version: s.version + 1, failedCount: Math.max(0, s.failedCount + failedDelta) })),
  setFailed: (n) => set({ failedCount: n }),
}));

const DEVICE_KEY = 'backstreet.print.deviceId';

export function printDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `dev-${Date.now()}`;
    window.localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return 'unknown-device';
  }
}

/** Stable, privacy-safe error code for a local print failure. */
export function classifyLocalPrintError(error: unknown): PrintErrorCode {
  const name = (error as { name?: string } | null)?.name ?? '';
  const msg = `${name} ${(error as Error | null)?.message ?? String(error ?? '')}`.toLowerCase();
  if (msg.includes('allow popups')) return 'popup_blocked';
  if (msg.includes('refus') || msg.includes('financial')) return 'refused';
  if (msg.includes('unable to claim interface') || msg.includes('access denied') || msg.includes('securityerror')) return 'driver_conflict';
  if (msg.includes('notallowederror') || msg.includes('permission')) return 'permission_denied';
  if (msg.includes('not connected') || msg.includes('disconnected') || msg.includes('no device') || msg.includes('notfounderror')) return 'not_connected';
  if (msg.includes('networkerror') || msg.includes('transferout') || msg.includes('busy') || msg.includes('stall')) return 'device_busy';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('disabled')) return 'not_configured';
  return 'unknown';
}

/** Plain-language help shown next to a failed job / in diagnostics. */
export function printErrorHelp(code: string): string {
  switch (code) {
    case 'not_connected': return 'The USB printer is not connected. Check the cable and power, then press Connect printer.';
    case 'device_busy': return 'The printer did not accept the data. Check paper and lid, then Retry.';
    case 'driver_conflict': return 'Windows is holding the printer with its own driver, so Chrome cannot use it. Use "Chrome print dialog" mode, or replace the driver with WinUSB (Zadig) once.';
    case 'permission_denied': return 'Chrome was not given access to the printer. Press Connect printer and choose it in the list.';
    case 'popup_blocked': return 'Chrome blocked the print window. Allow pop-ups for this site, then Retry.';
    case 'refused': return 'The receipt was not printed because an amount could not be printed correctly. Check the printer settings.';
    case 'not_configured': return 'Printing is switched off in settings.';
    default: return 'Printing failed. Press Retry; if it fails again, switch to "Chrome print dialog".';
  }
}

const RETRYABLE: ReadonlySet<PrintErrorCode> = new Set(['not_connected', 'device_busy', 'timeout']);

export interface PrintJobSpec {
  jobKey: string;
  kind: PrintJobKind;
  label: string;
  transport: PrintTransport;
  payload?: unknown;
}

export class PrintSkippedError extends Error {
  constructor(public readonly reason: string) { super(reason === 'in_progress' ? 'This ticket is already printing' : 'This ticket was just printed'); }
}

async function claim(spec: PrintJobSpec): Promise<{ id: number | null; skip: string | null }> {
  try {
    const res = await api.post('/print-jobs/claim', {
      job_key: spec.jobKey, kind: spec.kind, label: spec.label, transport: spec.transport, payload: spec.payload ?? {},
      device_id: printDeviceId(),
    });
    if (res.data?.action === 'skip') return { id: res.data.job?.id ?? null, skip: String(res.data.reason || 'already_printed') };
    return { id: res.data?.job?.id ?? null, skip: null };
  } catch {
    // Ledger unreachable: print anyway (the printer is local), just untracked.
    return { id: null, skip: null };
  }
}

async function report(id: number | null, body: Record<string, unknown>): Promise<void> {
  if (!id) return;
  try { await api.post(`/print-jobs/${id}/result`, body); } catch { /* best effort */ }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a print through the ledger. WebUSB failures that look transient are
 * retried twice (reconnecting the USB device in between). Browser-dialog jobs
 * are recorded as "printed_unconfirmed" because Chrome cannot confirm paper.
 * Throws PrintSkippedError for duplicates and the original error on failure.
 */
export async function runPrintJob<T>(spec: PrintJobSpec, run: () => Promise<T>): Promise<T> {
  const { id, skip } = await claim(spec);
  if (skip) throw new PrintSkippedError(skip);
  const maxAttempts = spec.transport === 'webusb' ? 3 : 1;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await run();
      await report(id, { status: spec.transport === 'browser' ? 'printed_unconfirmed' : 'printed', transport: spec.transport });
      usePrintAlerts.getState().bump(0);
      return result;
    } catch (error) {
      lastError = error;
      const code = classifyLocalPrintError(error);
      if (attempt < maxAttempts && RETRYABLE.has(code)) {
        await sleep(attempt === 1 ? 1500 : 4000);
        try { await printerService.tryReconnect(); } catch { /* next attempt reports */ }
        continue;
      }
      break;
    }
  }
  const code = classifyLocalPrintError(lastError);
  await report(id, { status: 'failed', error_code: code, error: (lastError as Error)?.message ?? String(lastError), transport: spec.transport });
  usePrintAlerts.getState().bump(1);
  throw lastError;
}

/** Short stable hash for a kitchen ticket's item batch (same items → same key). */
export function itemBatchHash(items: ReadonlyArray<{ id?: number | string; product_id?: string | number; quantity?: number }> | undefined): string {
  const text = (items ?? []).map((i) => `${i.id ?? i.product_id ?? '?'}x${i.quantity ?? 1}`).sort().join(',');
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
