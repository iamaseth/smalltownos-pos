'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, LockOpen, RefreshCw } from 'lucide-react';
import api from '@/lib/api';

interface ShiftGate {
  required: boolean;
  open: boolean;
  session: { id: number; opened_by_name: string; opened_at: string } | null;
}

/**
 * Reads GET /api/cash-sessions/gate: whether the owner requires an open shift
 * (Settings → Payment methods) and whether one is open. Re-checks every 20
 * seconds and whenever the window regains focus.
 */
export function useShiftGate() {
  const [gate, setGate] = useState<ShiftGate | null>(null);
  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get('/cash-sessions/gate');
      setGate(data as ShiftGate);
    } catch {
      // Unknown state is not "no shift": keep the last known answer and let the
      // server refuse with no_open_shift if a shift really is missing.
    }
  }, []);
  useEffect(() => {
    const first = setTimeout(() => { void refresh(); }, 0);
    const timer = setInterval(() => { void refresh(); }, 20_000);
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { clearTimeout(first); clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  return { gate, refresh, blocked: !!gate && gate.required && !gate.open };
}

/**
 * No floating tickets: when a shift is required and none is open, cover the
 * menu and cart so nobody can start a ticket. Cashiers get a big Open shift
 * button; waiters are told to ask the cashier.
 */
export function ShiftRequiredOverlay({ canOpenShift, onCheckAgain }: { canOpenShift: boolean; onCheckAgain: () => void }) {
  const router = useRouter();
  return (
    <div role="alertdialog" aria-modal="false" aria-labelledby="shift-required-title" data-testid="pos-shift-required"
      className="absolute inset-0 z-30 flex items-center justify-center bg-slate-900/70 p-6 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-2xl border-2 border-amber-500 bg-card p-6 text-center text-foreground shadow-2xl">
        <Lock className="mx-auto size-12 text-amber-600" aria-hidden />
        <h2 id="shift-required-title" className="mt-3 text-2xl font-black">No shift open</h2>
        <p className="mt-2 text-base text-muted-foreground">
          Every order must belong to a shift. Open the shift and count the float before taking orders or payments.
        </p>
        {canOpenShift ? (
          <button type="button" onClick={() => router.push('/cash?go=open')}
            className="mt-5 inline-flex h-16 w-full items-center justify-center gap-3 rounded-xl bg-green-700 text-xl font-black text-white hover:bg-green-800 active:scale-[0.98]">
            <LockOpen className="size-6" aria-hidden /> Open shift
          </button>
        ) : (
          <p className="mt-5 rounded-xl bg-amber-100 px-4 py-4 text-lg font-bold text-amber-950">Ask the cashier to open the shift.</p>
        )}
        <button type="button" onClick={onCheckAgain}
          className="mt-3 inline-flex h-11 items-center gap-2 rounded-xl border-2 border-border px-4 text-sm font-semibold hover:bg-muted">
          <RefreshCw className="size-4" aria-hidden /> Check again
        </button>
      </div>
    </div>
  );
}
