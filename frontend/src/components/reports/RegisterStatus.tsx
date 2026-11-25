'use client';

import Link from 'next/link';
import { Lock, LockOpen, UserRound } from 'lucide-react';
import { CashCloseModal } from '@/components/dashboard/CashCloseModal';
import { useCashClose } from '@/hooks/useCashClose';
import { useCashSession } from '@/hooks/useCashSession';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

export function RegisterStatus() {
  const shift = useCashSession();
  const dayClose = useCashClose();
  const fmt = useFormatCurrency();

  if (shift.loading) {
    return <div className="mb-5 h-28 animate-pulse rounded-2xl border-2 border-border bg-muted" aria-label="Loading register status" />;
  }

  const session = shift.session;
  const openedAt = session
    ? new Date(`${session.opened_at.replace(' ', 'T')}Z`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <>
      {session ? (
        <section className="mb-5 flex flex-wrap items-center gap-4 rounded-2xl border-2 border-amber-500 bg-amber-50 px-5 py-4 text-amber-950 dark:bg-amber-950 dark:text-amber-100" aria-label="Register open">
          <LockOpen className="size-7 shrink-0" />
          <div className="min-w-48 flex-1">
            <h2 className="text-xl font-bold">Register OPEN</h2>
            <p className="text-sm">{session.opened_by_name} · since {openedAt} · float {fmt(session.opening_float_cents / shift.minorFactor)}</p>
          </div>
          <Link href="/cash" className="inline-flex h-11 items-center gap-2 rounded-xl border-2 border-border bg-card px-4 font-semibold text-foreground hover:bg-muted">
            <UserRound className="size-4" /> Close shift
          </Link>
          <button type="button" onClick={dayClose.openCloseModal} className="inline-flex h-11 items-center gap-2 rounded-xl bg-blue-700 px-4 font-semibold text-white hover:bg-blue-800">
            <Lock className="size-4" /> Close day
          </button>
        </section>
      ) : (
        <section className="mb-5 flex items-center gap-4 rounded-2xl border-2 border-green-700 bg-green-50 px-5 py-4 text-green-900 dark:bg-green-950 dark:text-green-100" aria-label="Register closed">
          <Lock className="size-7 shrink-0" />
          <div>
            <h2 className="text-xl font-bold">Register CLOSED</h2>
            <p className="text-sm">No shift is open.</p>
          </div>
        </section>
      )}
      <CashCloseModal model={dayClose} />
    </>
  );
}
