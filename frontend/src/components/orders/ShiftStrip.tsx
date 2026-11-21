'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import toast from 'react-hot-toast';
import { Printer } from 'lucide-react';
import api from '@/lib/api';
import { usd } from '@print/shift-report-text';
import { printReportReceipt } from '@/lib/printer/shift-report-print';

interface ShiftSummary { id: number; cashier: string; openedAt: string; orders: number; netCents: number; unpaidCount: number; unpaidCents: number; timezone: string }

/** Open shift at a glance on the Orders page; without one, a prompt to open it. */
export function ShiftStrip({ refreshKey, onShift }: { refreshKey: number; onShift?: (openedAt: string | null) => void }) {
  const [state, setState] = useState<{ shift: ShiftSummary | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: status } = await api.get('/cash-handover/status');
        const s = status.open_session;
        if (!s) { if (!cancelled) { setState({ shift: null }); onShift?.(null); } return; }
        const { data: r } = await api.get('/reports/shift-report', { params: { session_id: s.id } });
        if (cancelled) return;
        setState({ shift: { id: s.id, cashier: r.cashier, openedAt: r.openedAt, orders: r.orders?.length ?? r.sales.orders, netCents: r.sales.netCents, unpaidCount: r.unpaid.count, unpaidCents: r.unpaid.totalCents, timezone: r.timezone } });
        onShift?.(r.openedAt);
      } catch {
        if (!cancelled) setState({ shift: null });
      }
    })();
    return () => { cancelled = true; };
  }, [refreshKey, onShift]);

  if (!state) return <div className="h-[68px] animate-pulse rounded-2xl border-2 border-border" />;
  const s = state.shift;
  if (!s) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border-2 border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        <div className="flex-1"><b>No shift open.</b> Orders taken now won&apos;t be on anyone&apos;s shift report.</div>
        <Link href="/cash" className="rounded-xl bg-amber-600 px-4 py-2 font-bold text-white">Open shift</Link>
      </div>
    );
  }
  const since = new Date(`${s.openedAt.replace(' ', 'T')}Z`).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: s.timezone });
  const stat = (label: string, value: string, warn = false) => (
    <div>
      <div className="text-xs font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">{label}</div>
      <div className={`text-lg font-extrabold ${warn ? 'text-amber-700 dark:text-amber-400' : ''}`}>{value}</div>
    </div>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border-2 border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-900 dark:bg-emerald-950">
      <div>
        <div className="text-xs font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">My shift</div>
        <div className="font-bold">#{s.id} · {s.cashier} · since {since}</div>
      </div>
      {stat('Orders', String(s.orders))}
      {stat('Sales', usd(s.netCents))}
      {stat('Not paid', `${s.unpaidCount} · ${usd(s.unpaidCents)}`, s.unpaidCount > 0)}
      <span className="flex-1" />
      <button type="button" onClick={() => printReportReceipt({ kind: 'shift', sessionId: s.id }).then(() => toast.success('X-report sent to the printer')).catch(() => toast.error('Could not print the X-report'))}
        className="inline-flex items-center gap-2 rounded-xl border bg-background px-3 py-2 text-sm font-bold hover:bg-muted">
        <Printer className="size-4" /> X-report
      </button>
      <Link href="/cash" className="rounded-xl border bg-background px-3 py-2 text-sm font-bold hover:bg-muted">Close shift →</Link>
    </div>
  );
}
