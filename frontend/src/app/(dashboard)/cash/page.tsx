'use client';

/**
 * BackStreet Cash — open shift (count the float) and a four-step close:
 * float out, count, cash spent, result. Handover and review views stay for older shifts.
 */
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { formatKhr, formatUsdCents } from '@shared/cash-counter';
import { CashCounter, cashCountPayload, cashCountTotals, emptyCashCount, type CashCountValue } from '@/components/cash/CashCounter';

interface Status {
  rate_khr_per_usd: number;
  standard_float: { usd_cents: number; khr_riel: number };
  pending_count_alert_hours: number;
  can_resolve: boolean;
  open_session: {
    id: number; opened_by_name: string; opened_at: string; is_mine: boolean;
    opening_float: { usd_cents: number; khr_riel: number };
  } | null;
  pending_counts: { id: number; opened_by: string; opened_by_name: string; cutoff_at: string }[];
  awaiting_incoming: {
    id: number; from_session_id: number; cutoff_at: string; from_cashier: string;
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
  const [status, setStatus] = useState<Status | null>(null);
  const [view, setView] = useState<View>({ name: 'home' });
  const [count, setCount] = useState<CashCountValue>(emptyCashCount());
  const [explanation, setExplanation] = useState('');
  const [disputes, setDisputes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const rate = status?.rate_khr_per_usd ?? 4100;

  const load = useCallback(async () => {
    try {
      const res = await api.get('/cash-handover/status');
      setStatus(res.data);
    } catch (error) {
      toast.error(errorText(error, 'Could not load cash status'));
    }
  }, []);
  useEffect(() => {
    let active = true;
    api.get('/cash-handover/status')
      .then((res) => { if (active) setStatus(res.data); })
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
        <button type="button" className="text-sm text-muted-foreground underline" onClick={() => { go({ name: 'home' }); void load(); }}>Back</button>
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
          <div className="rounded-xl border p-4 text-sm">
            Shift open: <b>{s.opened_by_name}</b> since {s.opened_at}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No shift open</div>
        )}
        {!s && status.awaiting_incoming.map((h) => (
          <BigButton key={h.id} tone="primary" onClick={() => go({ name: 'receive', handoverId: h.id, fromCashier: h.from_cashier })}>
            Receive drawer from {h.from_cashier} — count the float
          </BigButton>
        ))}
        {!s && status.awaiting_incoming.length === 0 && (
          <BigButton tone="primary" onClick={() => go({ name: 'open' })}>Open shift — count the float</BigButton>
        )}
        {s && (s.is_mine || status.can_resolve) && (
          <>
            <BigButton onClick={() => go({ name: 'close', sessionId: s.id })}>Close shift</BigButton>
          </>
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
    body = (
      <div className="space-y-4">
        {header('Open shift')}
        <CashCounter value={count} onChange={setCount} rate={rate} title="Count the cash in the drawer" />
        <BigButton tone="primary" disabled={busy || countIsEmpty} onClick={() => submit(async () => {
          try {
            await api.post('/cash-handover/open', { count: cashCountPayload(count), device: 'pos' });
            toast.success('Shift opened');
            go({ name: 'home' });
            await load();
          } catch (error) { toast.error(errorText(error, 'Could not open shift')); }
        })}>Confirm opening float</BigButton>
      </div>
    );
  }

  if (view.name === 'receive') {
    const tickets = status.awaiting_incoming.find((h) => h.id === view.handoverId)?.tickets ?? [];
    const disputedOrders = Object.entries(disputes).map(([orderId, reason]) => ({ order_id: Number(orderId), reason: reason.trim() }));
    const missingReason = disputedOrders.some((d) => !d.reason);
    body = (
      <div className="space-y-4">
        {header('Receive drawer')}
        <p className="text-sm text-muted-foreground">
          Count the float {view.fromCashier} left in the drawer. Count it yourself — your count becomes your opening float.
        </p>
        <CashCounter value={count} onChange={setCount} rate={rate} title="Float in the drawer" />
        {tickets.length > 0 && (
          <section className="rounded-xl border bg-card p-4">
            <h3 className="font-semibold">Open tickets from {view.fromCashier} ({tickets.length})</h3>
            <p className="mb-2 text-xs text-muted-foreground">Check each ticket. Tick Dispute and say why if one is wrong; the rest are accepted.</p>
            <ul className="divide-y">
              {tickets.map((ticket) => {
                const disputed = ticket.order_id in disputes;
                return (
                  <li key={ticket.order_id} className="py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm">
                        <span className="font-medium">{ticket.order_number}</span>
                        {ticket.table_label ? ` · ${ticket.table_label}` : ''}
                        <span className="text-muted-foreground"> · {formatUsdCents(Math.round(ticket.balance * 100))} due</span>
                      </span>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" className="size-5" checked={disputed}
                          onChange={(e) => setDisputes((current) => {
                            const next = { ...current };
                            if (e.target.checked) next[ticket.order_id] = ''; else delete next[ticket.order_id];
                            return next;
                          })} />
                        Dispute
                      </label>
                    </div>
                    {disputed && (
                      <input value={disputes[ticket.order_id]} placeholder="What is wrong with this ticket?" maxLength={200}
                        onChange={(e) => setDisputes((current) => ({ ...current, [ticket.order_id]: e.target.value }))}
                        className="mt-2 w-full rounded-lg border px-3 py-2 text-sm" />
                    )}
                  </li>
                );
              })}
            </ul>
            {missingReason && <p className="mt-2 text-xs text-red-600">Add a reason for each disputed ticket.</p>}
          </section>
        )}
        <BigButton tone="primary" disabled={busy || countIsEmpty || missingReason} onClick={() => submit(async () => {
          try {
            const res = await api.post(`/cash-handover/handovers/${view.handoverId}/receive`, {
              count: cashCountPayload(count), device: 'pos', disputed_orders: disputedOrders,
            });
            const h = res.data.handover;
            if (h.status === 'flagged') {
              toast(`Difference vs ${view.fromCashier}: ${formatUsdCents(h.diff.usd_cents)} · ${formatKhr(h.diff.khr_riel)} — flagged for the manager`, { icon: '⚠️', duration: 8000 });
            } else {
              toast.success('Float matches. Shift opened.');
            }
            go({ name: 'home' });
            await load();
          } catch (error) { toast.error(errorText(error, 'Could not receive drawer')); }
        })}>Confirm my count and start</BigButton>
      </div>
    );
  }

  if (view.name === 'handover') {
    const sf = status.standard_float;
    body = (
      <div className="space-y-4">
        {header('Hand over now')}
        <div className="rounded-xl border border-orange-200 bg-orange-50 p-4 text-sm text-orange-800">
          1. Count out the float and leave it in the drawer: <b><Money usd={sf.usd_cents} khr={sf.khr_riel} /></b><br />
          2. Take all the rest in a bag — you will count it on your phone later.<br />
          3. Open tickets pass to the next cashier.
        </div>
        <CashCounter value={count} onChange={setCount} rate={rate} title="Float you are leaving" />
        <BigButton tone="warning" disabled={busy || countIsEmpty} onClick={() => submit(async () => {
          try {
            await api.post(`/cash-handover/sessions/${view.sessionId}/handover-now`, { float_left: cashCountPayload(count), device: 'pos' });
            toast.success('Handed over. Count your takings on your phone: Cash › Takings still to count.', { duration: 8000 });
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
        onClosed={() => { go({ name: 'home' }); void load(); }} />
    );
  }

  if (view.name === 'takings') {
    body = (
      <div className="space-y-4">
        {header(`Count takings — ${view.cashier}`)}
        <p className="text-sm text-muted-foreground">
          Count first. The expected amount is shown after you submit.
        </p>
        <CashCounter value={count} onChange={setCount} rate={rate} title="Takings in the bag" />
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

  return <div className="mx-auto w-full max-w-xl p-4 pb-24">{body}</div>;
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

const STEPS = ['Float out', 'Count', 'Cash spent', 'Result'] as const;

function StepDots({ step }: { step: number }) {
  return (
    <ol className="mb-4 grid grid-cols-4 gap-1 text-center text-xs">
      {STEPS.map((label, i) => (
        <li key={label} className={`rounded-lg px-1 py-2 ${i === step ? 'bg-emerald-600 font-semibold text-white' : i < step ? 'bg-emerald-100 text-emerald-800' : 'bg-muted text-muted-foreground'}`}>
          {i + 1}. {label}
        </li>
      ))}
    </ol>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between py-1 ${strong ? 'text-base font-bold' : 'text-sm'}`}>
      <span>{label}</span><span className="tabular-nums">{value}</span>
    </div>
  );
}

function signedUsd(cents: number): string {
  return cents > 0 ? `+${formatUsdCents(cents)}` : formatUsdCents(cents);
}

function SimpleClose({ header, sessionId, rate, openingFloat, onClosed }: {
  header: (t: string) => React.ReactNode;
  sessionId: number;
  rate: number;
  openingFloat: { usd_cents: number; khr_riel: number };
  onClosed: () => void;
}) {
  const [step, setStep] = useState(0);
  const [floatOut, setFloatOut] = useState({ usd: (openingFloat.usd_cents / 100).toString(), khr: openingFloat.khr_riel.toString() });
  const [count, setCount] = useState<CashCountValue>(emptyCashCount());
  const [spent, setSpent] = useState<SpentItem[]>([]);
  const [noneSpent, setNoneSpent] = useState(false);
  const [draft, setDraft] = useState({ amount: '', currency: 'USD', what: '', mediaId: null as number | null, photoKey: 0 });
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.get(`/cash-handover/sessions/${sessionId}/cash-spent`)
      .then((res) => { if (active) setSpent(res.data.items); })
      .catch((error) => toast.error(errorText(error, 'Could not load cash spent')));
    return () => { active = false; };
  }, [sessionId]);

  const floatPayload = {
    usd_cents: Math.round((Number.parseFloat(floatOut.usd) || 0) * 100),
    khr_riel: Number.parseInt(floatOut.khr || '0', 10) || 0,
  };
  const countIsEmpty = cashCountTotals(count, rate).combined === 0;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const addSpent = () => run(async () => {
    const amount = Number.parseFloat(draft.amount) || 0;
    try {
      const res = await api.post(`/cash-handover/sessions/${sessionId}/cash-spent`, {
        currency: draft.currency,
        amount_minor: draft.currency === 'USD' ? Math.round(amount * 100) : Math.round(amount),
        what: draft.what,
        media_id: draft.mediaId,
      });
      setSpent((items) => [...items, res.data.item]);
      setNoneSpent(false);
      setDraft({ amount: '', currency: draft.currency, what: '', mediaId: null, photoKey: draft.photoKey + 1 });
    } catch (error) { toast.error(errorText(error, 'Could not add cash spent')); }
  });

  const removeSpent = (id: number) => run(async () => {
    try {
      await api.delete(`/cash-handover/sessions/${sessionId}/cash-spent/${id}`);
      setSpent((items) => items.filter((item) => item.id !== id));
    } catch (error) { toast.error(errorText(error, 'Could not remove item')); }
  });

  const checkResult = () => run(async () => {
    try {
      const res = await api.post(`/cash-handover/sessions/${sessionId}/close-preview`, { count: cashCountPayload(count), float_out: floatPayload });
      setPreview(res.data);
      setStep(3);
    } catch (error) { toast.error(errorText(error, 'Could not check the count')); }
  });

  const closeRegister = () => run(async () => {
    try {
      await api.post(`/cash-handover/sessions/${sessionId}/closing-count`, {
        count: cashCountPayload(count), float_out: floatPayload, explanation: reason.trim() || undefined, device: 'pos',
      });
      toast.success('Register closed');
      onClosed();
    } catch (error) { toast.error(errorText(error, 'Could not close the register')); }
  });

  const draftValid = (Number.parseFloat(draft.amount) || 0) > 0 && draft.what.trim().length > 0;

  return (
    <div className="space-y-4">
      {header('Close shift')}
      <StepDots step={step} />

      {step === 0 && (
        <>
          <p className="text-sm text-muted-foreground">Take the float out of the drawer and put it aside for tomorrow.</p>
          <div className="grid grid-cols-2 gap-3 rounded-xl border p-4">
            <label className="text-sm">USD
              <input inputMode="decimal" value={floatOut.usd} onChange={(e) => setFloatOut({ ...floatOut, usd: e.target.value.replace(/[^\d.]/g, '') })}
                className="mt-1 w-full rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-lg" aria-label="Float out USD" />
            </label>
            <label className="text-sm">KHR
              <input inputMode="numeric" value={floatOut.khr} onChange={(e) => setFloatOut({ ...floatOut, khr: e.target.value.replace(/\D/g, '') })}
                className="mt-1 w-full rounded-lg border border-orange-200 bg-orange-50 px-3 py-3 text-lg" aria-label="Float out KHR" />
            </label>
          </div>
          <BigButton tone="primary" onClick={() => setStep(1)}>Float is out — next</BigButton>
        </>
      )}

      {step === 1 && (
        <>
          <p className="text-sm text-muted-foreground">Count all the money left in the drawer (without the float).</p>
          <CashCounter value={count} onChange={setCount} rate={rate} title="Money left in the drawer" />
          <BigButton tone="primary" disabled={countIsEmpty} onClick={() => setStep(2)}>Next — cash spent</BigButton>
          <button type="button" className="text-sm underline" onClick={() => setStep(0)}>Back</button>
        </>
      )}

      {step === 2 && (
        <>
          <p className="text-sm text-muted-foreground">Did anyone pay for something with money from the drawer today?</p>
          {spent.length > 0 && (
            <ul className="divide-y rounded-xl border">
              {spent.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span>
                    <b className="tabular-nums">{item.amount_khr_riel ? formatKhr(item.amount_khr_riel) : formatUsdCents(item.amount_cents)}</b>
                    {' · '}{item.reason}{item.media_id ? ' · 📷' : ''}
                  </span>
                  <button type="button" disabled={busy} className="text-red-600 underline" onClick={() => removeSpent(item.id)}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-3 rounded-xl border p-4">
            <div className="text-sm font-semibold">Add cash spent</div>
            <div className="flex gap-2">
              <input inputMode="decimal" placeholder="Amount" value={draft.amount}
                onChange={(e) => setDraft({ ...draft, amount: e.target.value.replace(/[^\d.]/g, '') })}
                className="min-w-0 flex-1 rounded-lg border px-3 py-3 text-lg" aria-label="Amount spent" />
              <select value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} className="shrink-0 rounded-lg border px-3 text-lg" aria-label="Currency">
                <option value="USD">USD</option><option value="KHR">KHR</option>
              </select>
            </div>
            <input placeholder="What was it for? (ice, gas, vegetables…)" value={draft.what} maxLength={120}
              onChange={(e) => setDraft({ ...draft, what: e.target.value })} className="w-full rounded-lg border px-3 py-3" aria-label="What for" />
            <PhotoCapture key={draft.photoKey} kind="purchase_receipt" sessionId={sessionId} label="Receipt photo (optional)"
              onUploaded={(mediaId) => setDraft((d) => ({ ...d, mediaId }))} />
            <BigButton disabled={busy || !draftValid} onClick={addSpent}>+ Add</BigButton>
          </div>
          {spent.length === 0 && (
            <label className="flex items-center gap-3 rounded-xl border p-4 text-base">
              <input type="checkbox" className="size-6" checked={noneSpent} onChange={(e) => setNoneSpent(e.target.checked)} />
              No cash spent today
            </label>
          )}
          <BigButton tone="primary" disabled={busy || (spent.length === 0 && !noneSpent)} onClick={checkResult}>See result</BigButton>
          <button type="button" className="text-sm underline" onClick={() => setStep(1)}>Back</button>
        </>
      )}

      {step === 3 && preview && (
        <>
          <div className={`rounded-xl border p-4 ${preview.matches ? 'border-emerald-300 bg-emerald-50' : 'border-red-300 bg-red-50'}`}>
            <div className="mb-2 text-xl font-bold">
              {preview.matches ? 'Matches ✓' : preview.difference_usd_cents < 0 ? `Short ${formatUsdCents(-preview.difference_usd_cents)}` : `Over ${formatUsdCents(preview.difference_usd_cents)}`}
            </div>
            <Row label="Cash sales" value={formatUsdCents(preview.cash_sales_usd_cents)} />
            <Row label="− Cash spent" value={formatUsdCents(preview.cash_spent_usd_cents)} />
            <Row label="+ Float" value={formatUsdCents(preview.opening_float_usd_cents)} />
            <Row label="Should have" value={formatUsdCents(preview.should_have_usd_cents)} strong />
            <Row label="Counted (incl. float)" value={formatUsdCents(preview.counted_usd_cents)} strong />
            <Row label="Difference" value={signedUsd(preview.difference_usd_cents)} strong />
            <p className="mt-2 text-xs text-muted-foreground">
              Riel converted at {preview.rate_khr_per_usd.toLocaleString()}៛ = $1. Within ±{formatUsdCents(preview.tolerance_usd_cents)} counts as a match.
            </p>
            {preview.untracked_cash_lines > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">{preview.untracked_cash_lines} older cash payment(s) had no USD/KHR split and were counted as USD.</p>
            )}
          </div>
          {preview.non_cash_payments.length > 0 && (
            <div className="rounded-xl border p-4">
              <div className="mb-1 text-sm font-semibold">Check these against the bank app / card machine</div>
              {preview.non_cash_payments.map((p) => <Row key={p.method} label={p.method} value={formatUsdCents(p.total_cents)} />)}
            </div>
          )}
          {!preview.matches && (
            <>
              <BigButton tone="warning" onClick={() => { setStep(1); setPreview(null); }}>Recount</BigButton>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500}
                placeholder="Reason for the difference (optional)" className="w-full rounded-xl border px-4 py-3 text-sm" />
            </>
          )}
          <BigButton tone="primary" disabled={busy} onClick={closeRegister}>Close register</BigButton>
          <button type="button" className="text-sm underline" onClick={() => setStep(2)}>Back to cash spent</button>
        </>
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
