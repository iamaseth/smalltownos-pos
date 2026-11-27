'use client';

/**
 * BackStreet Cash — open shift (count the float) and a four-step close:
 * float out, count, cash spent, result. Handover and review views stay for older shifts.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { combinedUsdCents, formatKhr, formatUsdCents } from '@shared/cash-counter';
import { CashCounter, cashCountPayload, cashCountTotals, emptyCashCount, type CashCountValue } from '@/components/cash/CashCounter';
import { ReportOutputButtons } from '@/components/reports/ReportOutputButtons';
import { ShiftOrders } from '@/components/reports/OrderList';
import { printReportReceipt } from '@/lib/printer/shift-report-print';
import { PrintSkippedError } from '@/lib/printer/print-jobs';
import { requestRegisterLock } from '@/hooks/useRegisterAccess';
import type { ShiftReportData } from '@print/shift-report-text';

interface Status {
  rate_khr_per_usd: number;
  standard_float: { usd_cents: number; khr_riel: number };
  pending_count_alert_hours: number;
  can_resolve: boolean;
  can_close?: boolean;
  my_name?: string;
  open_session: {
    id: number; opened_by_name: string; opened_at: string; is_mine: boolean;
    opening_float: { usd_cents: number; khr_riel: number };
  } | null;
  pending_counts: { id: number; opened_by: string; opened_by_name: string; cutoff_at: string }[];
  awaiting_incoming: {
    id: number; from_session_id: number; cutoff_at: string; from_cashier: string; passed_to?: string | null;
    tickets: { order_id: number; order_number: string; table_label: string | null; total: number; balance: number }[];
  }[];
}

interface Reconciliation {
  id: number;
  status: string;
  expected: { usd_cents: number; khr_riel: number; combined_usd_cents: number; untracked_cash_lines: number } | null;
  actual: { usd_cents: number; khr_riel: number } | null;
  variance: { usd_cents: number; khr_riel: number; combined_usd_cents: number } | null;
  float_retained: { usd_cents: number; khr_riel: number } | null;
  envelope: { usd_cents: number; khr_riel: number } | null;
}

type View =
  | { name: 'home' }
  | { name: 'open' }
  | { name: 'close'; sessionId: number }
  | { name: 'handover'; sessionId: number }
  | { name: 'receive'; handoverId: number; fromCashier: string }
  | { name: 'takings'; sessionId: number; cashier: string }
  | { name: 'result'; sessionId: number; reconciliation: Reconciliation; needsExplanation: boolean }
  | { name: 'receipt' }
  | { name: 'review' };

function errorText(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response?.data;
  return data?.error || fallback;
}

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function BigButton({ children, onClick, tone = 'default', disabled }: {
  children: React.ReactNode; onClick: () => void; tone?: 'default' | 'primary' | 'warning'; disabled?: boolean;
}) {
  const tones = {
    default: 'border bg-card text-foreground',
    primary: 'bg-emerald-600 text-white',
    warning: 'bg-orange-500 text-white',
  };
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className={`w-full rounded-xl px-5 py-4 text-left text-base font-semibold disabled:opacity-50 ${tones[tone]}`}>
      {children}
    </button>
  );
}

function Money({ usd, khr }: { usd: number; khr: number }) {
  return (
    <span className="tabular-nums">
      <span className="text-emerald-700">{formatUsdCents(usd)}</span>
      {' · '}
      <span className="text-orange-600">{formatKhr(khr)}</span>
    </span>
  );
}

/** Photo capture with safe retry: the same idempotency key is reused until the upload succeeds. */
function PhotoCapture({ kind, sessionId, onUploaded, label }: {
  kind: 'envelope' | 'purchase_receipt'; sessionId?: number | null; onUploaded: (mediaId: number) => void; label: string;
}) {
  const [state, setState] = useState<'idle' | 'uploading' | 'done' | 'failed'>('idle');
  const [pending, setPending] = useState<{ data: string; key: string } | null>(null);
  const upload = async (payload: { data: string; key: string }) => {
    setState('uploading');
    try {
      const res = await api.post('/cash-handover/media', { kind, data: payload.data, session_id: sessionId ?? null },
        { headers: { 'Idempotency-Key': payload.key } });
      setState('done');
      setPending(null);
      onUploaded(res.data.media.id);
    } catch (error) {
      setState('failed');
      toast.error(errorText(error, 'Upload failed — tap Retry'));
    }
  };
  return (
    <div className="space-y-2 rounded-xl border p-4">
      <div className="text-sm font-semibold">{label}</div>
      <input type="file" accept="image/*" capture="environment" className="block w-full text-sm"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const payload = { data: await readFileAsDataUrl(file), key: newKey() };
          setPending(payload);
          await upload(payload);
        }} />
      <div className="text-sm">
        {state === 'uploading' && <span className="text-muted-foreground">Uploading…</span>}
        {state === 'done' && <span className="text-emerald-700">Photo saved ✓</span>}
        {state === 'failed' && pending && (
          <button type="button" className="rounded-lg bg-orange-500 px-3 py-1 text-white" onClick={() => upload(pending)}>Retry upload</button>
        )}
      </div>
    </div>
  );
}

export default function CashPage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [view, setView] = useState<View>({ name: 'home' });
  const [count, setCount] = useState<CashCountValue>(emptyCashCount());
  const [explanation, setExplanation] = useState('');
  const [disputes, setDisputes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [openStep, setOpenStep] = useState<'bills' | 'float'>('bills');
  const rate = status?.rate_khr_per_usd ?? 4100;

  const load = useCallback(async () => {
    try {
      const res = await api.get('/cash-handover/status');
      setStatus(res.data);
    } catch (error) {
      toast.error(errorText(error, 'Could not load cash status'));
    }
  }, []);
  const [fromPos, setFromPos] = useState(false);
  // Where to go after opening, receiving or closing: back to Reports when that is where the user came from.
  const [returnTo, setReturnTo] = useState('/pos');
  useEffect(() => {
    let active = true;
    const params = new URLSearchParams(window.location.search);
    const entry = params.get('go');
    api.get('/cash-handover/status')
      .then((res) => {
        if (!active) return;
        if (params.get('from') === 'reports') setReturnTo('/reports');
        const st = res.data as Status;
        setStatus(st);
        const s = st.open_session;
        if (entry === 'open' && !s && st.awaiting_incoming.length === 0) {
          setFromPos(true);
          setView({ name: 'open' });
        } else if (entry === 'open' && !s && st.awaiting_incoming.length > 0) {
          const h = st.awaiting_incoming[0];
          setFromPos(true);
          setOpenStep(h.tickets.length > 0 ? 'bills' : 'float');
          setView({ name: 'receive', handoverId: h.id, fromCashier: h.from_cashier });
        } else if (entry === 'close' && s && (s.is_mine || st.can_resolve || st.can_close)) {
          setFromPos(true);
          setView({ name: 'close', sessionId: s.id });
        } else if (entry === 'handover' && s && (s.is_mine || st.can_resolve || st.can_close)) {
          setFromPos(true);
          setView({ name: 'handover', sessionId: s.id });
        }
      })
      .catch((error) => toast.error(errorText(error, 'Could not load cash status')));
    return () => { active = false; };
  }, []);

  const go = (next: View) => {
    setCount(emptyCashCount());
    setExplanation('');
    setDisputes({});
    setView(next);
  };

  const submit = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const countIsEmpty = cashCountTotals(count, rate).combined === 0;

  /* ── views ──────────────────────────────────────────────────────────── */

  if (!status) return <div className="p-6 text-muted-foreground">Loading cash…</div>;

  const header = (title: string) => (
    <div className="mb-4 flex items-center justify-between">
      <h1 className="text-xl font-bold">{title}</h1>
      {view.name !== 'home' && (
        <button type="button" className="text-sm text-muted-foreground underline"
          onClick={() => { if (fromPos) { router.push(returnTo); return; } go({ name: 'home' }); void load(); }}>Back</button>
      )}
    </div>
  );

  let body: React.ReactNode = null;

  if (view.name === 'home') {
    const s = status.open_session;
    const myPending = status.pending_counts;
    body = (
      <div className="space-y-3">
        {header('Cash')}
        {s ? (
          <div className="space-y-3 rounded-xl border p-4 text-sm">
            <div>Shift open: <b>{s.opened_by_name}</b> since {s.opened_at}</div>
            <div>
              <div className="mb-1 text-xs font-semibold text-muted-foreground">X-report (shift so far — does not close it)</div>
              <ReportOutputButtons target={{ kind: 'shift', sessionId: s.id }} size="sm" />
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No shift open</div>
        )}
        {!s && status.awaiting_incoming.map((h) => (
          <BigButton key={h.id} tone="primary" onClick={() => { setOpenStep(h.tickets.length > 0 ? 'bills' : 'float'); go({ name: 'receive', handoverId: h.id, fromCashier: h.from_cashier }); }}>
            Open shift{h.tickets.length > 0 ? ` (${h.tickets.length} bills from ${h.from_cashier}${h.passed_to ? ` for ${h.passed_to}` : ''})` : ` after ${h.from_cashier}`}
          </BigButton>
        ))}
        {!s && status.awaiting_incoming.length === 0 && (
          <BigButton tone="primary" onClick={() => go({ name: 'open' })}>Open shift — count the float</BigButton>
        )}
        {s && <BigButton tone="primary" onClick={() => router.push('/pos')}>Go to POS</BigButton>}
        {s && (
          <details className="rounded-xl border p-4">
            <summary className="cursor-pointer text-base font-semibold">This shift&apos;s tables and orders</summary>
            <div className="mt-3"><ShiftOrders sessionId={s.id} /></div>
          </details>
        )}
        {s && (s.is_mine || status.can_resolve || status.can_close) && (
          <BigButton onClick={() => go({ name: 'close', sessionId: s.id })}>Close shift</BigButton>
        )}
        {myPending.length > 0 && (
          <div className="space-y-2 pt-2">
            <div className="text-sm font-semibold">Takings still to count</div>
            {myPending.map((p) => (
              <BigButton key={p.id} tone="warning" onClick={() => go({ name: 'takings', sessionId: p.id, cashier: p.opened_by_name })}>
                {p.opened_by_name} — handed over {p.cutoff_at}
              </BigButton>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (view.name === 'open') {
    const openTotals = cashCountTotals(count, rate);
    const floatText = `${formatUsdCents(openTotals.usd)} + ${formatKhr(openTotals.khr)}`;
    body = (
      <div className="mx-auto w-full max-w-xl space-y-4">
        {header('Open shift')}
        <StepDots steps={['Float', 'POS']} current={0} />
        <h2 className="text-2xl font-bold">Count the float</h2>
        <p className="text-base text-muted-foreground">Count the money in the drawer. Use − if you tap too many.</p>
        <div className="rounded-xl border border-emerald-300 bg-card p-3">
          <CashCounter value={count} onChange={setCount} rate={rate} />
        </div>
        <BigButton tone="primary" disabled={busy || countIsEmpty} onClick={() => submit(async () => {
          try {
            await api.post('/cash-handover/open', { count: cashCountPayload(count), device: 'pos' });
            toast.success(`Shift opened with ${floatText}`);
            router.push(returnTo);
          } catch (error) { toast.error(errorText(error, 'Could not open shift')); }
        })}>{countIsEmpty ? 'Count the float first' : `Start with ${floatText}: go to POS`}</BigButton>
      </div>
    );
  }

  if (view.name === 'receive') {
    const tickets = status.awaiting_incoming.find((h) => h.id === view.handoverId)?.tickets ?? [];
    const disputedOrders = Object.entries(disputes).map(([orderId, reason]) => ({ order_id: Number(orderId), reason: reason.trim() }));
    const steps = tickets.length > 0 ? ['Open bills', 'Float', 'POS'] : ['Float', 'POS'];
    const step = tickets.length > 0 && openStep === 'bills' ? 'bills' : 'float';
    const owed = tickets.reduce((sum, t) => sum + Number(t.balance || 0), 0);
    const openTotals = cashCountTotals(count, rate);
    body = (
      <div className="mx-auto w-full max-w-xl space-y-4">
        {header('Open shift')}
        <StepDots steps={steps} current={step === 'bills' ? 0 : steps.length - 2} />
        {step === 'bills' && (
          <>
            <h2 className="text-2xl font-bold">Take these open bills?</h2>
            <p className="text-base text-muted-foreground">From {view.fromCashier} · {formatUsdCents(Math.round(owed * 100))}</p>
            <ul className="space-y-2">
              {tickets.map((ticket) => (
                <li key={ticket.order_id} className="flex items-center justify-between rounded-xl border-2 px-4 py-3 text-lg">
                  <span className="font-semibold">{ticket.table_label || `#${String(ticket.order_number).split('-').pop()}`}</span>
                  <span className="tabular-nums">{formatUsdCents(Math.round(ticket.balance * 100))}</span>
                </li>
              ))}
            </ul>
            <BigButton tone="primary" onClick={() => { setDisputes({}); setOpenStep('float'); }}>Yes, I take them</BigButton>
            <BigButton onClick={() => {
              setDisputes(Object.fromEntries(tickets.map((t) => [t.order_id, 'Not right: call manager'])));
              setOpenStep('float');
              toast('The manager will check these bills.', { icon: '⚠️' });
            }}>Not right: call manager</BigButton>
          </>
        )}
        {step === 'float' && (
          <>
            <h2 className="text-2xl font-bold">Count the float</h2>
            <p className="text-base text-muted-foreground">Count the money {view.fromCashier} left in the drawer.</p>
            {disputedOrders.length > 0 && <p className="rounded-lg bg-orange-50 px-3 py-2 text-sm font-semibold text-orange-800">The manager will check the open bills.</p>}
            <div className="rounded-xl border border-emerald-300 bg-card p-3">
              <CashCounter value={count} onChange={setCount} rate={rate} title="Float" />
            </div>
            <BigButton tone="primary" disabled={busy || countIsEmpty} onClick={() => submit(async () => {
              try {
                const res = await api.post(`/cash-handover/handovers/${view.handoverId}/receive`, {
                  count: cashCountPayload(count), device: 'pos', disputed_orders: disputedOrders,
                });
                const h = res.data.handover;
                if (h.status === 'flagged') {
                  toast(`Float is different from ${view.fromCashier}: ${formatUsdCents(h.diff.usd_cents)} · ${formatKhr(h.diff.khr_riel)}. The manager will check.`, { icon: '⚠️', duration: 8000 });
                } else {
                  toast.success('Float OK. Shift open.');
                }
                router.push(returnTo);
              } catch (error) { toast.error(errorText(error, 'Could not open the shift')); }
            })}>{countIsEmpty ? 'Count the float first' : `Start with ${formatUsdCents(openTotals.usd)} + ${formatKhr(openTotals.khr)}: go to POS`}</BigButton>
            {tickets.length > 0 && <button type="button" className="text-sm underline" onClick={() => setOpenStep('bills')}>Back</button>}
          </>
        )}
      </div>
    );
  }

  if (view.name === 'handover') {
    const sf = status.standard_float;
    body = (
      <div className="mx-auto w-full max-w-xl space-y-4">
        {header('Hand over now')}
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-800">
          1. Count out the float and leave it in the drawer: <b><Money usd={sf.usd_cents} khr={sf.khr_riel} /></b><br />
          2. Take all the rest in a bag — you will count it on your phone later.<br />
          3. Open tickets pass to the next cashier.
        </div>
        <div className="rounded-xl border border-emerald-300 bg-card p-3">
          <CashCounter value={count} onChange={setCount} rate={rate} title="Float you are leaving" />
        </div>
        <BigButton tone="warning" disabled={busy || countIsEmpty} onClick={() => submit(async () => {
          try {
            await api.post(`/cash-handover/sessions/${view.sessionId}/handover-now`, { float_left: cashCountPayload(count), device: 'pos' });
            toast.success('Handed over. Count your takings on your phone: Cash › Takings still to count.', { duration: 8000 });
            if (fromPos) { router.push(returnTo); return; }
            go({ name: 'home' });
            await load();
          } catch (error) { toast.error(errorText(error, 'Could not hand over')); }
        })}>Hand over now</BigButton>
      </div>
    );
  }

  if (view.name === 'close' && status.open_session) {
    body = (
      <SimpleClose header={header} sessionId={view.sessionId} rate={rate} openingFloat={status.open_session.opening_float}
        openedBy={status.open_session.opened_by_name} openedAt={status.open_session.opened_at} closingAs={status.my_name || ''}
        onClosed={() => { if (fromPos) { router.push(returnTo); return; } go({ name: 'home' }); void load(); }} />
    );
  }

  if (view.name === 'takings') {
    body = (
      <div className="mx-auto w-full max-w-xl space-y-4">
        {header(`Count takings — ${view.cashier}`)}
        <p className="text-sm text-muted-foreground">
          Count first. The expected amount is shown after you submit.
        </p>
        <div className="rounded-xl border border-emerald-300 bg-card p-3">
          <CashCounter value={count} onChange={setCount} rate={rate} title="Takings in the bag" />
        </div>
        <textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} rows={2} placeholder="Explanation (if the cash is short or over)"
          className="w-full rounded-xl border px-4 py-3 text-sm" />
        <BigButton tone="primary" disabled={busy || countIsEmpty} onClick={() => submit(async () => {
          try {
            const res = await api.post(`/cash-handover/sessions/${view.sessionId}/takings-count`, { count: cashCountPayload(count), explanation, device: 'phone' });
            setView({ name: 'result', sessionId: view.sessionId, reconciliation: res.data.reconciliation, needsExplanation: res.data.needs_explanation });
            await load();
          } catch (error) { toast.error(errorText(error, 'Could not submit the count')); }
        })}>Submit count</BigButton>
      </div>
    );
  }

  if (view.name === 'result') {
    const r = view.reconciliation;
    const balanced = r.status === 'balanced';
    body = (
      <div className="space-y-4">
        {header('Cash result')}
        <div className={`rounded-xl border p-4 ${balanced ? 'border-emerald-300 bg-emerald-50' : 'border-red-300 bg-red-50'}`}>
          <div className="text-lg font-bold">{balanced ? 'Balanced ✓' : 'Difference — manager review needed'}</div>
          {r.expected && <div className="mt-2 text-sm">Expected: <Money usd={r.expected.usd_cents} khr={r.expected.khr_riel} /></div>}
          {r.actual && <div className="text-sm">Counted: <Money usd={r.actual.usd_cents} khr={r.actual.khr_riel} /></div>}
          {r.variance && <div className="text-sm font-semibold">Difference: <Money usd={r.variance.usd_cents} khr={r.variance.khr_riel} /></div>}
          {r.expected && r.expected.untracked_cash_lines > 0 && (
            <div className="mt-2 text-xs text-muted-foreground">{r.expected.untracked_cash_lines} older cash payment(s) had no USD/KHR split and were counted as USD.</div>
          )}
          {r.envelope && <div className="mt-2 text-sm">Envelope: <Money usd={r.envelope.usd_cents} khr={r.envelope.khr_riel} /></div>}
        </div>
        {view.needsExplanation && (
          <div className="space-y-2">
            <textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} rows={2} placeholder="Please explain the difference"
              className="w-full rounded-xl border px-4 py-3 text-sm" />
            <BigButton disabled={busy || !explanation.trim()} onClick={() => submit(async () => {
              try {
                await api.post(`/cash-handover/reconciliations/${r.id}/notes`, { kind: 'cashier_explanation', body: explanation });
                toast.success('Explanation saved');
                setView({ ...view, needsExplanation: false });
              } catch (error) { toast.error(errorText(error, 'Could not save explanation')); }
            })}>Save explanation</BigButton>
          </div>
        )}
        <PhotoCapture kind="envelope" sessionId={view.sessionId} label="Photograph the sealed envelope"
          onUploaded={async (mediaId) => {
            try {
              await api.post(`/cash-handover/sessions/${view.sessionId}/envelope`, {
                usd_cents: r.envelope?.usd_cents ?? 0, khr_riel: r.envelope?.khr_riel ?? 0, media_id: mediaId,
              });
            } catch (error) { toast.error(errorText(error, 'Photo saved but not attached — try again')); }
          }} />
        <BigButton onClick={() => { go({ name: 'home' }); void load(); }}>Done</BigButton>
      </div>
    );
  }

  if (view.name === 'receipt') body = <ReceiptView header={header} onDone={() => go({ name: 'home' })} />;
  if (view.name === 'review') body = <ReviewView header={header} />;

  return <div className="mx-auto w-full max-w-none p-3 pb-24">{body}</div>;
}

interface OpenTicket {
  order_id: number; order_number: string; table_label: string | null; balance: number;
  all_free?: number; original_user_name?: string | null;
}
interface SpentItem { id: number; reason: string | null; amount_cents: number; amount_khr_riel: number; media_id: number | null }

interface ClosePreview {
  rate_khr_per_usd: number;
  opening_float_usd_cents: number;
  cash_sales_usd_cents: number;
  cash_spent_usd_cents: number;
  should_have_usd_cents: number;
  counted_usd_cents: number;
  difference_usd_cents: number;
  matches: boolean;
  tolerance_usd_cents: number;
  non_cash_payments: { method: string; total_cents: number }[];
  untracked_cash_lines: number;
}

function StepDots({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="mb-4">
      <p className="mb-1 text-sm font-semibold text-muted-foreground">Step {current + 1} of {steps.length}</p>
      <ol className="grid gap-1 text-center text-xs" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((label, i) => (
          <li key={label} className={`rounded-lg px-1 py-2 ${i === current ? 'bg-emerald-600 font-semibold text-white' : i < current ? 'bg-emerald-100 text-emerald-800' : 'bg-muted text-muted-foreground'}`}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'minus' }) {
  return (
    <div className={'flex justify-between gap-2 border-b py-1.5 text-sm last:border-0 ' + (strong ? 'font-bold' : '')}>
      <span>{label}</span><span className={'tabular-nums ' + (tone === 'minus' ? 'text-red-600' : '')}>{value}</span>
    </div>
  );
}

function signedUsd(cents: number): string {
  return cents > 0 ? `+${formatUsdCents(cents)}` : formatUsdCents(cents);
}

function CloseLine({ n, label, hint, value, tone, children }: {
  n: number; label: string; hint?: string; value: string; tone?: 'minus' | 'good' | 'bad'; children?: React.ReactNode;
}) {
  const color = tone === 'minus' || tone === 'bad' ? 'text-red-600' : tone === 'good' ? 'text-emerald-700' : '';
  return (
    <div className="flex items-center gap-3 border-b px-4 py-3 last:border-0">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-bold text-white">{n}</span>
      <span className="text-lg font-bold">{label}{hint && <span className="ms-2 text-sm font-normal text-muted-foreground">{hint}</span>}</span>
      <span className={'ms-auto text-2xl font-extrabold tabular-nums ' + color}>{value}</span>
      {children}
    </div>
  );
}

type PhonePhoto = { id: number; created_at: string };

/** Phone upload QR link and the phone photos still waiting for details. */
function usePhoneReceipts(sessionId: number) {
  const [qr, setQr] = useState<string | null>(null);
  const [photos, setPhotos] = useState<PhonePhoto[]>([]);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});

  useEffect(() => {
    let active = true;
    const makeLink = () => api.post(`/cash-handover/sessions/${sessionId}/phone-upload-link`, { origin: window.location.origin })
      .then(({ data }) => { if (active) setQr(data.qr); })
      .catch(() => { if (active) setQr(null); });
    void makeLink();
    const renew = window.setInterval(makeLink, 25 * 60 * 1000);
    return () => { active = false; window.clearInterval(renew); };
  }, [sessionId]);

  useEffect(() => {
    let active = true;
    const poll = () => api.get(`/cash-handover/sessions/${sessionId}/phone-receipts`)
      .then(({ data }) => { if (active) setPhotos(data.photos || []); })
      .catch(() => {});
    void poll();
    const timer = window.setInterval(poll, 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, [sessionId]);

  useEffect(() => {
    for (const photo of photos) {
      if (thumbs[photo.id]) continue;
      api.get(`/cash-handover/media/${photo.id}`, { responseType: 'blob' })
        .then(({ data }) => {
          const reader = new FileReader();
          reader.onload = () => setThumbs((t) => ({ ...t, [photo.id]: String(reader.result) }));
          reader.readAsDataURL(data as Blob);
        })
        .catch(() => {});
    }
  }, [photos, thumbs]);

  const used = (id: number) => setPhotos((p) => p.filter((x) => x.id !== id));
  const dismiss = async (id: number) => {
    try {
      await api.post(`/cash-handover/sessions/${sessionId}/phone-receipts/${id}/dismiss`);
      used(id);
    } catch (error) { toast.error(errorText(error, 'Could not remove the photo')); }
  };
  return { qr, photos, thumbs, used, dismiss };
}

/** Add payout window: 1. receipt photo, 2. what for, 3. how much. */
function AddPayoutModal({ sessionId, phone, onSaved, onClose }: {
  sessionId: number;
  phone: ReturnType<typeof usePhoneReceipts>;
  onSaved: (item: SpentItem) => void;
  onClose: () => void;
}) {
  const [taken, setTaken] = useState<{ id: number; src: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [what, setWhat] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [saving, setSaving] = useState(false);

  const waiting = phone.photos[0];
  const photo = taken ? { ...taken, fromPhone: false }
    : waiting ? { id: waiting.id, src: phone.thumbs[waiting.id] ?? null, fromPhone: true } : null;

  const takePhoto = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const data = await readFileAsDataUrl(file);
      const res = await api.post('/cash-handover/media', { kind: 'purchase_receipt', data, session_id: sessionId },
        { headers: { 'Idempotency-Key': newKey() } });
      setTaken({ id: res.data.media.id, src: data });
    } catch (error) {
      toast.error(errorText(error, 'Photo upload failed, try again'));
    } finally { setUploading(false); }
  };

  const removePhoto = async () => {
    if (photo?.fromPhone) await phone.dismiss(photo.id);
    else setTaken(null);
  };

  const value = Number.parseFloat(amount) || 0;
  const save = async () => {
    if (!what.trim() || value <= 0) { toast.error('Add what it was for and the amount'); return; }
    setSaving(true);
    try {
      const res = await api.post('/cash-handover/sessions/' + sessionId + '/cash-spent', {
        currency,
        amount_minor: currency === 'USD' ? Math.round(value * 100) : Math.round(value),
        what: what.trim().slice(0, 120),
        media_id: photo?.id ?? null,
      });
      if (photo?.fromPhone) phone.used(photo.id);
      onSaved(res.data.item);
    } catch (error) {
      toast.error(errorText(error, 'Could not add cash payout'));
    } finally { setSaving(false); }
  };

  const bigChoice = 'flex cursor-pointer flex-col items-center gap-1 rounded-xl border-2 p-4 text-base font-bold hover:bg-muted';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Add payout">
      <div className="w-full max-w-md space-y-4 rounded-2xl bg-card p-5 shadow-xl">
        <h2 className="text-2xl font-bold">Add payout</h2>
        <div>
          <p className="mb-1 text-sm font-semibold text-muted-foreground">1. Receipt photo</p>
          {photo ? (
            <div className="flex items-center gap-3 rounded-xl border-2 border-emerald-300 p-2">
              {photo.src ? <img src={photo.src} alt="Receipt" className="size-16 rounded-lg object-cover" /> : <div className="size-16 rounded-lg bg-muted" />}
              <span className="flex-1 font-semibold text-emerald-800">{photo.fromPhone ? 'Photo from phone' : 'Photo added'}</span>
              <button type="button" onClick={removePhoto} aria-label="Remove photo" className="rounded-lg px-3 py-2 text-red-600 hover:bg-red-50">✕</button>
            </div>
          ) : showQr ? (
            <div className="flex items-center gap-3 rounded-xl bg-muted p-3">
              {phone.qr ? <img src={phone.qr} alt="QR code to send a receipt photo from a phone" className="size-28 shrink-0 rounded-lg bg-white p-1" /> : <div className="size-28 shrink-0 rounded-lg bg-background" />}
              <div className="text-sm"><p className="text-base font-bold">Scan with your phone</p><p className="text-muted-foreground">Take the photo. It appears here.</p>
                <button type="button" className="mt-2 underline" onClick={() => setShowQr(false)}>Back</button></div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <label className={bigChoice}>
                <span className="text-3xl" aria-hidden="true">📷</span>{uploading ? 'Uploading…' : 'Take photo'}
                <input type="file" accept="image/*" capture="environment" className="sr-only" disabled={uploading} onChange={(e) => takePhoto(e.target.files?.[0])} />
              </label>
              <button type="button" className={bigChoice} onClick={() => setShowQr(true)}>
                <span className="text-3xl" aria-hidden="true">📱</span>Use phone
              </button>
            </div>
          )}
        </div>
        <label className="block">
          <span className="mb-1 block text-sm font-semibold text-muted-foreground">2. What for?</span>
          <input value={what} maxLength={120} onChange={(e) => setWhat(e.target.value)} placeholder="Ice, gas, vegetables…"
            className="h-14 w-full rounded-xl border-2 px-3 text-lg" />
        </label>
        <div>
          <span className="mb-1 block text-sm font-semibold text-muted-foreground">3. How much?</span>
          <div className="flex gap-2">
            <input value={amount} inputMode="decimal" aria-label="Amount" placeholder="0.00"
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              className="h-14 min-w-0 flex-1 rounded-xl border-2 px-3 text-lg tabular-nums" />
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency" className="rounded-xl border-2 px-3 text-lg">
              <option value="USD">$</option><option value="KHR">៛</option>
            </select>
          </div>
        </div>
        <button type="button" disabled={saving || uploading} onClick={save}
          className="h-14 w-full rounded-xl bg-emerald-700 text-xl font-bold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={onClose} className="w-full py-2 font-semibold text-muted-foreground">Cancel</button>
      </div>
    </div>
  );
}

/** Whole drawer (cash to hand over + float left) as one count, as the server expects. */
function drawerCountPayload(cash: CashCountValue, float: CashCountValue) {
  if (cash.method === 'denominations' && float.method === 'denominations') {
    const sum = (a: Record<string, number>, b: Record<string, number>) =>
      Object.fromEntries(Object.keys(a).map((note) => [note, (a[note] || 0) + (b[note] || 0)]));
    return {
      method: 'denominations' as const,
      denominations: { USD: sum(cash.denominations.USD, float.denominations.USD), KHR: sum(cash.denominations.KHR, float.denominations.KHR) },
    };
  }
  const a = cashCountTotals(cash, 4100);
  const b = cashCountTotals(float, 4100);
  return { method: 'manual' as const, usd_cents: a.usd + b.usd, khr_riel: a.khr + b.khr };
}

const USE_COUNTER_KEY = 'flo.close.useCounter';
function readUseCounter(): boolean {
  try { return typeof window === 'undefined' ? true : localStorage.getItem(USE_COUNTER_KEY) !== '0'; } catch { return true; }
}

/** USD and KHR boxes typed straight into a Step 2 line (counter switched off). */
function TotalsInput({ label, value, onChange }: { label: string; value: CashCountValue; onChange: (v: CashCountValue) => void }) {
  // A line filled by the counter shows its totals; typing turns it into a typed total.
  const shown = value.method === 'manual' ? value : (() => {
    const t = cashCountTotals(value, 4100);
    return { ...value, manualUsd: t.usd ? String(t.usd / 100) : '', manualKhr: t.khr ? String(t.khr) : '' };
  })();
  const set = (patch: Partial<CashCountValue>) => onChange({ ...shown, ...patch, method: 'manual' });
  return (
    <div className="grid grid-cols-2 gap-2 border-b px-4 pb-3 ps-[3.75rem]">
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase text-emerald-700">{label} USD</span>
        <input inputMode="decimal" value={shown.manualUsd} placeholder="0.00" aria-label={label + ' USD'}
          onChange={(e) => set({ manualUsd: e.target.value.replace(/[^\d.]/g, '') })}
          className="w-full rounded-lg border-2 border-emerald-300 bg-emerald-50 px-3 py-2 text-xl font-bold tabular-nums" />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold uppercase text-orange-600">{label} KHR</span>
        <input inputMode="numeric" value={shown.manualKhr} placeholder="0" aria-label={label + ' KHR'}
          onChange={(e) => set({ manualKhr: e.target.value.replace(/\D/g, '') })}
          className="w-full rounded-lg border-2 border-orange-300 bg-orange-50 px-3 py-2 text-xl font-bold tabular-nums" />
      </label>
    </div>
  );
}

function SimpleClose({ header, sessionId, rate, openedBy, openedAt, closingAs, onClosed }: {
  header: (t: string) => React.ReactNode;
  sessionId: number;
  rate: number;
  openingFloat: { usd_cents: number; khr_riel: number };
  openedBy: string;
  openedAt: string;
  closingAs: string;
  onClosed: () => void;
}) {
  const router = useRouter();
  const [openTickets, setOpenTickets] = useState<OpenTicket[] | null>(null);
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([]);
  const [lateClose, setLateClose] = useState(false);
  const [passTo, setPassTo] = useState('');
  const [ownerPin, setOwnerPin] = useState('');
  const [freeId, setFreeId] = useState<number | null>(null);
  const [freePin, setFreePin] = useState('');
  // Counter ON: count notes on the right, then press "Use for Float" / "Use for Cash on hand".
  // Counter OFF: type the totals straight into Step 2. Remembered on this device.
  const [useCounter, setUseCounterState] = useState<boolean>(() => readUseCounter());
  const [scratch, setScratch] = useState<CashCountValue>(emptyCashCount());
  const [floatCount, setFloatCount] = useState<CashCountValue>(emptyCashCount('manual'));
  const [count, setCount] = useState<CashCountValue>(emptyCashCount('manual'));
  const [spent, setSpent] = useState<SpentItem[]>([]);
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  const [report, setReport] = useState<ShiftReportData | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [addingPayout, setAddingPayout] = useState(false);
  const phone = usePhoneReceipts(sessionId);

  const loadPreview = async () => {
    const res = await api.post('/cash-handover/sessions/' + sessionId + '/close-preview', {
      count: cashCountPayload(emptyCashCount()),
      float_out: { usd_cents: 0, khr_riel: 0 },
    });
    setPreview(res.data);
  };

  useEffect(() => {
    let active = true;
    api.get('/reports/shift-report', { params: { session_id: sessionId } })
      .then(({ data }) => { if (active) setReport(data); })
      .catch(() => {});
    Promise.all([
      api.get('/cash-handover/open-tickets'),
      api.get('/cash-handover/sessions/' + sessionId + '/cash-spent'),
      api.post('/cash-handover/sessions/' + sessionId + '/close-preview', {
        count: cashCountPayload(emptyCashCount()),
        float_out: { usd_cents: 0, khr_riel: 0 },
      }),
    ]).then(([ticketsRes, spentRes, previewRes]) => {
      if (!active) return;
      setOpenTickets(ticketsRes.data.tickets || []);
      setStaff(ticketsRes.data.staff || []);
      setLateClose(!!ticketsRes.data.late_close);
      setSpent(spentRes.data.items || []);
      setPreview(previewRes.data);
    }).catch((error) => {
      if (!active) return;
      toast.error(errorText(error, 'Could not load closing figures'));
      setOpenTickets([]);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionId]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const reloadTickets = async () => {
    const { data } = await api.get('/cash-handover/open-tickets');
    setOpenTickets(data.tickets || []);
    setStaff(data.staff || []);
    setLateClose(!!data.late_close);
  };

  const closeFree = (orderId: number) => run(async () => {
    try {
      const res = await api.post('/cash-handover/open-tickets/' + orderId + '/close-free', { pin: freePin });
      toast.success('Bill closed. Approved by ' + res.data.approved_by);
      setFreeId(null);
      setFreePin('');
      await reloadTickets();
    } catch (error) {
      setFreePin('');
      toast.error(errorText(error, 'Could not close the bill'));
    }
  });

  const removeSpent = (id: number) => run(async () => {
    try {
      await api.delete('/cash-handover/sessions/' + sessionId + '/cash-spent/' + id);
      setSpent((items) => items.filter((item) => item.id !== id));
      await loadPreview();
    } catch (error) { toast.error(errorText(error, 'Could not remove payout')); }
  });

  const floatTotals = cashCountTotals(floatCount, rate);
  const floatPayload = { usd_cents: floatTotals.usd, khr_riel: floatTotals.khr };
  const countTotals = cashCountTotals(count, rate);
  const openingCombined = preview?.opening_float_usd_cents ?? 0;
  const expected = preview?.should_have_usd_cents ?? 0;
  const payoutTotal = preview?.cash_spent_usd_cents ?? 0;
  const cashSales = preview?.cash_sales_usd_cents ?? 0;
  const tickets = openTickets ?? [];
  const freeTickets = tickets.filter((t) => Number(t.all_free) === 1);
  const owedTickets = tickets.filter((t) => Number(t.all_free) !== 1);
  const openOwed = owedTickets.reduce((sum, ticket) => sum + Number(ticket.balance || 0), 0);
  const ticketsBlock = freeTickets.length > 0 || (owedTickets.length > 0 && (!passTo || (lateClose && !ownerPin.trim())));
  const floatCountCombined = combinedUsdCents(floatPayload.usd_cents, floatPayload.khr_riel, rate);
  const floatGap = floatCountCombined - openingCombined;
  const difference = countTotals.combined + floatCountCombined - expected;
  const tolerance = preview?.tolerance_usd_cents ?? 0;
  const needsExplanation = Math.abs(difference) > tolerance || Math.abs(floatGap) > tolerance;
  const phonePending = phone.photos.length;

  const closeShift = () => run(async () => {
    if (!preview) return;
    if (phonePending > 0) {
      toast.error('A phone receipt photo still needs details. Tap Add payout.');
      return;
    }
    if (freeTickets.length > 0) {
      toast.error('Close the $0 bills where everything is free first (manager PIN).');
      return;
    }
    if (owedTickets.length > 0 && !passTo) {
      toast.error('Take payment for the open tickets, or choose who takes them.');
      return;
    }
    if (owedTickets.length > 0 && lateClose && !ownerPin.trim()) {
      toast.error('Last close of the night: take payment for every ticket, or enter the owner PIN.');
      return;
    }
    if (openingCombined > 0 && floatCountCombined === 0) {
      toast.error('Count the float that will remain in the drawer.');
      return;
    }
    if (needsExplanation && !reason.trim()) {
      toast.error('Please explain the cash or float difference before closing.');
      return;
    }
    try {
      const res = await api.post('/cash-handover/sessions/' + sessionId + '/closing-count', {
        count: drawerCountPayload(count, floatCount),
        float_retained: floatPayload,
        explanation: reason.trim() || undefined,
        device: 'pos',
        pass_open_tickets: owedTickets.length > 0 || undefined,
        pass_to_user_id: owedTickets.length > 0 ? passTo : undefined,
        owner_pin: owedTickets.length > 0 && lateClose ? ownerPin.trim() : undefined,
      });
      const passed = res.data?.passed_to_next_cashier;
      const passedName = staff.find((u) => u.id === passTo)?.name ?? 'the next cashier';
      toast.success(passed?.tickets ? 'Shift closed. ' + passed.tickets + ' tickets passed to ' + passedName + '.' : 'Shift closed', { duration: 6000 });
      try {
        await printReportReceipt({ kind: 'shift', sessionId }, { auto: true });
      } catch (printError) {
        if (!(printError instanceof PrintSkippedError)) toast.error('The shift is closed, but the Z report did not print. Reprint it from Reports → Shifts.', { duration: 8000 });
      }
      onClosed();
      // The shift is over: log this cashier out so the next one logs in with their own PIN.
      toast('Logged out. Next cashier: log in with your PIN.', { icon: '🔒', duration: 6000 });
      requestRegisterLock();
    } catch (error) {
      setOwnerPin('');
      toast.error(errorText(error, 'Could not close the shift'));
      void reloadTickets().catch(() => {});
    }
  });

  const setUseCounter = (on: boolean) => {
    setUseCounterState(on);
    try { localStorage.setItem(USE_COUNTER_KEY, on ? '1' : '0'); } catch { /* storage may be unavailable */ }
  };
  // Copies the counted notes into Float or Cash on hand. It replaces that line, never adds to it.
  const applyCountTo = (target: 'float' | 'cash') => {
    const totals = cashCountTotals(scratch, rate);
    if (totals.usd === 0 && totals.khr === 0) { toast.error('Count the notes first.'); return; }
    (target === 'float' ? setFloatCount : setCount)({ ...scratch, method: 'denominations' });
    setScratch(emptyCashCount());
    toast.success((target === 'float' ? 'Float' : 'Cash on hand') + ' set to ' + formatUsdCents(totals.usd) + (totals.khr ? ' + ' + formatKhr(totals.khr) : ''));
  };
  const sales = report?.sales;

  return (
    <div className="w-full space-y-3">
      {header('Close shift')}
      <p className="text-base">
        Opened by <b>{openedBy}</b> <span className="text-muted-foreground">· {new Date(openedAt.replace(' ', 'T') + 'Z').toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        {closingAs && <> — Closing: <b>{closingAs}</b></>}
      </p>
      {loading && <p className="text-sm text-muted-foreground">Loading shift figures…</p>}
      <div className="grid min-h-0 grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(220px,0.9fr)_minmax(390px,1.2fr)_minmax(360px,1fr)]">
        <aside className="space-y-3">
          <section className="rounded-xl border bg-card p-4">
            <h2 className="mb-2 text-lg font-bold">Shift Summary</h2>
            {sales ? (
              <>
                <Row label="Total sales (gross)" value={formatUsdCents(sales.grossCents)} />
                <Row label="Discounts" value={'−' + formatUsdCents(sales.discountCents)} tone="minus" />
                <Row label="Refunds" value={'−' + formatUsdCents(sales.refundCents)} tone="minus" />
                <Row label="Voids" value={'−' + formatUsdCents(sales.voidCents)} tone="minus" />
                <div className="mt-2 flex justify-between rounded-lg bg-emerald-50 px-3 py-2 text-lg font-extrabold">
                  <span>Net sales</span><span className="tabular-nums">{formatUsdCents(sales.netCents)}</span>
                </div>
              </>
            ) : <p className="text-sm text-muted-foreground">Loading…</p>}
          </section>
          <section className="rounded-xl border bg-card p-4">
            <h2 className="mb-2 text-lg font-bold">Payment Methods</h2>
            {(report?.payments || []).map((p) => (
              <Row key={p.label} label={p.label} value={p.khrRiel && !p.usdCents ? formatKhr(p.khrRiel) : formatUsdCents(p.usdCents)} />
            ))}
            {report && report.payments.length === 0 && <p className="text-sm text-muted-foreground">No payments yet.</p>}
          </section>
          <section className="rounded-xl border bg-card p-4">
            <h2 className="mb-2 text-lg font-bold">Tables</h2>
            {report ? (
              <>
                <Row label="Tables served" value={String(report.tables.served)} />
                <Row label="Occupied (now)" value={String(report.tables.occupied)} />
                <Row label="Waiting for payment" value={String(report.tables.awaiting.length)} />
              </>
            ) : <p className="text-sm text-muted-foreground">Loading…</p>}
          </section>
          {preview?.untracked_cash_lines ? (
            <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
              {preview.untracked_cash_lines} older cash payment(s) had no USD/KHR split and were counted as USD.
            </p>
          ) : null}
        </aside>

        <main className="space-y-3">
          <section data-testid="close-open-tickets" className={'rounded-xl border p-4 ' + (ticketsBlock ? 'border-orange-300 bg-orange-50' : 'bg-card')}>
            <h2 className="mb-2 text-lg font-bold">Step 1 · Open tickets</h2>
            {openTickets === null ? <p className="text-sm text-muted-foreground">Checking tickets…</p> : tickets.length === 0 ? (
              <p className="text-base font-semibold text-emerald-700">✓ No open tickets</p>
            ) : (
              <div className="space-y-2">
                {freeTickets.map((t) => (
                  <div key={t.order_id} className="rounded-lg border border-red-300 bg-red-50 p-3 text-red-900">
                    <div className="flex items-center justify-between gap-2 font-bold">
                      <span>{t.table_label || t.order_number} · everything free</span><span className="tabular-nums">$0.00</span>
                    </div>
                    <p className="text-xs">Can&apos;t be passed on. A manager must close it.</p>
                    {freeId === t.order_id ? (
                      <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); void closeFree(t.order_id); }}>
                        <input autoFocus type="password" inputMode="numeric" value={freePin} onChange={(e) => setFreePin(e.target.value)} aria-label="Manager PIN"
                          placeholder="Manager PIN" className="min-w-0 flex-1 rounded-lg border bg-white px-3 py-2 text-base text-foreground" />
                        <button type="submit" disabled={busy || !freePin} className="rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">Close bill</button>
                        <button type="button" onClick={() => { setFreeId(null); setFreePin(''); }} className="rounded-lg border bg-white px-3 py-2 text-sm text-foreground">Cancel</button>
                      </form>
                    ) : (
                      <button type="button" onClick={() => { setFreeId(t.order_id); setFreePin(''); }} className="mt-2 w-full rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white">Close with manager PIN</button>
                    )}
                  </div>
                ))}
                {owedTickets.length > 0 && (
                  <div className="rounded-lg border bg-white p-3">
                    <div className="mb-1 flex items-center justify-between font-bold">
                      <span>{owedTickets.length} open ticket{owedTickets.length > 1 ? 's' : ''}</span>
                      <span className="tabular-nums">{formatUsdCents(Math.round(openOwed * 100))}</span>
                    </div>
                    <ul className="mb-2 text-sm">
                      {owedTickets.map((t) => (
                        <li key={t.order_id} className="flex justify-between border-t py-1">
                          <span>{t.table_label || t.order_number}{t.original_user_name ? <span className="text-muted-foreground"> · {t.original_user_name}</span> : null}</span>
                          <span className="tabular-nums">{formatUsdCents(Math.round(Number(t.balance || 0) * 100))}</span>
                        </li>
                      ))}
                    </ul>
                    <button type="button" onClick={() => router.push('/orders')} className="mb-2 w-full rounded-lg border-2 border-emerald-700 px-3 py-2 text-sm font-bold text-emerald-800">Take payment now</button>
                    {lateClose ? (
                      <div className="rounded-lg bg-red-50 p-2 text-sm text-red-900">
                        <p className="font-bold">Last close of the night: every ticket must be paid or cancelled.</p>
                        <p className="mb-2 text-xs">Only the owner can let them stay open overnight.</p>
                        <select value={passTo} onChange={(e) => setPassTo(e.target.value)} aria-label="Pass tickets to"
                          className="mb-2 w-full rounded-lg border bg-white px-2 py-2 text-base text-foreground">
                          <option value="">Pass them to…</option>
                          {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                        <input type="password" inputMode="numeric" value={ownerPin} onChange={(e) => setOwnerPin(e.target.value)} aria-label="Owner PIN"
                          placeholder="Owner PIN" className="w-full rounded-lg border bg-white px-3 py-2 text-base text-foreground" />
                      </div>
                    ) : (
                      <label className="block text-sm font-semibold">
                        Or pass them to
                        <select value={passTo} onChange={(e) => setPassTo(e.target.value)} aria-label="Pass tickets to"
                          className="mt-1 w-full rounded-lg border bg-white px-2 py-2 text-base">
                          <option value="">Choose a person…</option>
                          {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="overflow-hidden rounded-xl border bg-card">
            <h2 className="bg-emerald-50 px-4 py-3 text-lg font-bold">Step 2 · Count the cash</h2>
            <CloseLine n={1} label="Cash sales" hint="(from POS)" value={formatUsdCents(cashSales)} />
            <CloseLine n={2} label="Float" hint={`(start ${formatUsdCents(openingCombined)})`} value={formatUsdCents(floatCountCombined)} />
            {!useCounter && <TotalsInput label="Float" value={floatCount} onChange={setFloatCount} />}
            <div className="border-b">
              <CloseLine n={3} label="Cash payouts" value={'−' + formatUsdCents(payoutTotal)} tone="minus">
                <button type="button" onClick={() => setAddingPayout(true)}
                  className="ms-2 shrink-0 rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white">
                  + Add payout{phonePending > 0 ? ` (${phonePending} photo)` : ''}
                </button>
              </CloseLine>
              {spent.length > 0 && (
                <ul className="-mt-1 space-y-1 px-4 pb-3 ps-[3.75rem] text-sm">
                  {spent.map((item) => (
                    <li key={item.id} className="flex items-center gap-2">
                      <span className="w-5 shrink-0" title={item.media_id ? 'Receipt photo' : 'No photo'}>{item.media_id ? '🧾' : ''}</span>
                      <span className="min-w-0 flex-1 truncate">{item.reason}</span>
                      <span className="tabular-nums">{item.amount_khr_riel ? formatKhr(item.amount_khr_riel) : formatUsdCents(item.amount_cents)}</span>
                      <button type="button" disabled={busy} aria-label="Remove payout" className="rounded px-2 text-muted-foreground hover:bg-red-50 hover:text-red-600" onClick={() => removeSpent(item.id)}>✕</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="bg-emerald-50">
              <CloseLine n={4} label="Cash on hand" hint="(without float)" value={formatUsdCents(countTotals.combined)} />
              {!useCounter && <TotalsInput label="Cash on hand" value={count} onChange={setCount} />}
            </div>
            <CloseLine n={5} label="Difference" value={signedUsd(difference)} tone={difference === 0 ? 'good' : 'bad'} />
            <p className="-mt-2 px-4 pb-3 ps-[3.75rem] text-sm text-muted-foreground">
              Should be {formatUsdCents(expected - floatCountCombined)} · counted {formatUsdCents(countTotals.combined)}
            </p>
            {floatGap !== 0 && floatCountCombined > 0 && (
              <p className="px-4 pb-3 text-xs text-amber-700">Float counted differs from the opening float by {signedUsd(floatGap)}. Add a note below.</p>
            )}
          </section>

          <section className="rounded-xl border bg-card p-4">
            <h2 className="mb-2 text-lg font-bold">Note</h2>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} aria-label="Note"
              placeholder={needsExplanation ? 'Explain the difference (required)' : 'Note (optional)…'}
              className={'w-full rounded-lg border px-3 py-2 text-sm ' + (needsExplanation && !reason.trim() ? 'border-amber-400 bg-amber-50' : '')} />
          </section>

          <button type="button" disabled={busy || loading || !preview || phonePending > 0 || ticketsBlock || needsExplanation && !reason.trim() || (openingCombined > 0 && floatCountCombined === 0)}
            onClick={closeShift}
            className="w-full rounded-xl bg-emerald-700 px-5 py-4 text-white disabled:opacity-50">
            <span className="block text-xl font-bold">{busy ? 'Closing…' : 'Close shift'}</span>
            <span className="block text-sm">Print shift report</span>
          </button>
        </main>

        <aside className="rounded-xl border border-emerald-300 bg-card p-3">
          <button type="button" role="switch" aria-checked={useCounter} onClick={() => setUseCounter(!useCounter)}
            data-testid="close-use-counter"
            className="mb-3 flex w-full items-center justify-between gap-3 rounded-xl border-2 border-slate-300 bg-white px-4 py-3 text-start">
            <span>
              <span className="block text-lg font-bold">{useCounter ? 'Count notes' : 'Type totals'}</span>
              <span className="block text-sm text-muted-foreground">{useCounter ? 'Turn off to type the totals in Step 2' : 'Turn on to count note by note'}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="text-sm font-bold">Counter</span>
              <span className={'relative inline-flex h-8 w-14 items-center rounded-full transition-colors ' + (useCounter ? 'bg-emerald-600' : 'bg-slate-300')}>
                <span className={'inline-block size-6 rounded-full bg-white shadow transition-transform ' + (useCounter ? 'translate-x-7' : 'translate-x-1')} />
              </span>
              <span className={'w-9 text-sm font-extrabold ' + (useCounter ? 'text-emerald-700' : 'text-slate-500')}>{useCounter ? 'ON' : 'OFF'}</span>
            </span>
          </button>
          {useCounter ? (
            <>
              <CashCounter value={scratch} onChange={setScratch} rate={rate} title="Count the notes" allowManual={false} />
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => applyCountTo('float')} data-testid="close-use-for-float"
                  className="rounded-xl bg-sky-700 px-3 py-3 text-base font-bold text-white">Use for Float</button>
                <button type="button" onClick={() => applyCountTo('cash')} data-testid="close-use-for-cash"
                  className="rounded-xl bg-emerald-700 px-3 py-3 text-base font-bold text-white">Use for Cash on hand</button>
              </div>
              <p className="mt-2 rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground">
                Count the float that stays in the drawer, press Use for Float. Then count the cash you take out, press Use for Cash on hand. Each press replaces that line.
              </p>
            </>
          ) : (
            <p className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
              Type the Float and Cash on hand totals in Step 2.
            </p>
          )}
        </aside>
      </div>
      {addingPayout && (
        <AddPayoutModal sessionId={sessionId} phone={phone} onClose={() => setAddingPayout(false)}
          onSaved={(item) => { setSpent((items) => [...items, item]); setAddingPayout(false); void loadPreview(); }} />
      )}
    </div>
  );
}

function ReceiptView({ header, onDone }: { header: (t: string) => React.ReactNode; onDone: () => void }) {
  const [mediaId, setMediaId] = useState<number | null>(null);
  const [form, setForm] = useState({ vendor: '', date: new Date().toISOString().slice(0, 10), total: '', currency: 'USD', notes: '' });
  return (
    <div className="space-y-4">
      {header('Supplier receipt')}
      <PhotoCapture kind="purchase_receipt" label="Photograph the receipt" onUploaded={setMediaId} />
      <input placeholder="Supplier" value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} className="w-full rounded-xl border px-4 py-3" />
      <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="w-full rounded-xl border px-4 py-3" />
      <div className="flex gap-2">
        <input inputMode="decimal" placeholder="Total" value={form.total} onChange={(e) => setForm({ ...form, total: e.target.value.replace(/[^\d.]/g, '') })} className="flex-1 rounded-xl border px-4 py-3" />
        <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className="rounded-xl border px-3">
          <option value="USD">USD</option><option value="KHR">KHR</option>
        </select>
      </div>
      <textarea placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="w-full rounded-xl border px-4 py-3" />
      <BigButton tone="primary" disabled={!mediaId || !form.total} onClick={async () => {
        try {
          const amount = Number.parseFloat(form.total) || 0;
          await api.post('/cash-handover/purchase-receipts', {
            media_id: mediaId, vendor_name: form.vendor || null, purchase_date: form.date, currency: form.currency,
            total_minor: form.currency === 'USD' ? Math.round(amount * 100) : Math.round(amount), notes: form.notes || null,
          });
          toast.success('Receipt saved for review (stock is not changed)');
          onDone();
        } catch (error) { toast.error(errorText(error, 'Could not save receipt')); }
      }}>Save receipt</BigButton>
    </div>
  );
}

function ReviewView({ header }: { header: (t: string) => React.ReactNode }) {
  const [data, setData] = useState<{
    pending_review: { id: number; session_id: number; opened_by_name: string; cutoff_at: string; variance_usd_cents: number; variance_khr_riel: number }[];
    pending_counts: { id: number; opened_by_name: string; cutoff_at: string; overdue: number }[];
    flagged_handovers: { id: number; diff_usd_cents: number; diff_khr_riel: number; cutoff_at: string }[];
    disputed_tickets: { order_number: string; table_label: string | null; balance: number; dispute_reason: string }[];
  } | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const load = useCallback(async () => {
    try { setData((await api.get('/cash-handover/review')).data); } catch (error) { toast.error(errorText(error, 'Could not load review')); }
  }, []);
  useEffect(() => {
    let active = true;
    api.get('/cash-handover/review')
      .then((res) => { if (active) setData(res.data); })
      .catch((error) => toast.error(errorText(error, 'Could not load review')));
    return () => { active = false; };
  }, []);
  if (!data) return <div>{header('Manager review')}Loading…</div>;
  return (
    <div className="space-y-4">
      {header('Manager review')}
      <section className="space-y-2">
        <h2 className="font-semibold">Differences to resolve</h2>
        {data.pending_review.length === 0 && <p className="text-sm text-muted-foreground">None</p>}
        {data.pending_review.map((r) => (
          <div key={r.id} className="space-y-2 rounded-xl border p-3 text-sm">
            <div><b>{r.opened_by_name}</b> — {r.cutoff_at}: <Money usd={r.variance_usd_cents} khr={r.variance_khr_riel} /></div>
            <textarea rows={2} placeholder="Manager explanation" value={notes[r.id] || ''}
              onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} className="w-full rounded-lg border px-3 py-2" />
            <button type="button" disabled={!notes[r.id]?.trim()} className="rounded-lg bg-emerald-600 px-4 py-2 text-white disabled:opacity-50"
              onClick={async () => {
                try {
                  await api.post(`/cash-handover/reconciliations/${r.id}/notes`, { kind: 'manager_acknowledgement', body: notes[r.id] });
                  toast.success('Resolved');
                  await load();
                } catch (error) { toast.error(errorText(error, 'Could not resolve')); }
              }}>Acknowledge &amp; resolve</button>
          </div>
        ))}
      </section>
      <section className="space-y-1 text-sm">
        <h2 className="font-semibold">Takings not yet counted</h2>
        {data.pending_counts.length === 0 && <p className="text-muted-foreground">None</p>}
        {data.pending_counts.map((p) => (
          <div key={p.id} className={p.overdue ? 'text-red-600' : ''}>{p.opened_by_name} — handed over {p.cutoff_at}{p.overdue ? ' (overdue)' : ''}</div>
        ))}
      </section>
      <section className="space-y-1 text-sm">
        <h2 className="font-semibold">Float differences at handover</h2>
        {data.flagged_handovers.length === 0 && <p className="text-muted-foreground">None</p>}
        {data.flagged_handovers.map((h) => <div key={h.id}>{h.cutoff_at}: <Money usd={h.diff_usd_cents} khr={h.diff_khr_riel} /></div>)}
      </section>
      <section className="space-y-1 text-sm">
        <h2 className="font-semibold">Disputed tickets</h2>
        {data.disputed_tickets.length === 0 && <p className="text-muted-foreground">None</p>}
        {data.disputed_tickets.map((d, i) => <div key={i}>{d.order_number} {d.table_label ? `(${d.table_label})` : ''} — {d.dispute_reason}</div>)}
      </section>
    </div>
  );
}
