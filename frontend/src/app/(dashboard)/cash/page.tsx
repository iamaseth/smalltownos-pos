'use client';

/**
 * BackStreet Cash — open shift (count the float) and a four-step close:
 * float out, count, cash spent, result. Handover and review views stay for older shifts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { combinedUsdCents, formatKhr, formatUsdCents } from '@shared/cash-counter';
import { CashCounter, cashCountPayload, cashCountTotals, emptyCashCount, type CashCountValue } from '@/components/cash/CashCounter';
import { ReportOutputButtons } from '@/components/reports/ReportOutputButtons';
import { ShiftOrders } from '@/components/reports/OrderList';
import { printReportReceipt } from '@/lib/printer/shift-report-print';
import { PrintSkippedError } from '@/lib/printer/print-jobs';

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
  const router = useRouter();
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
  const [fromPos, setFromPos] = useState(false);
  useEffect(() => {
    let active = true;
    const entry = new URLSearchParams(window.location.search).get('go');
    api.get('/cash-handover/status')
      .then((res) => {
        if (!active) return;
        const st = res.data as Status;
        setStatus(st);
        const s = st.open_session;
        if (entry === 'open' && !s && st.awaiting_incoming.length === 0) {
          setFromPos(true);
          setView({ name: 'open' });
        } else if (entry === 'close' && s && (s.is_mine || st.can_resolve)) {
          setFromPos(true);
          setView({ name: 'close', sessionId: s.id });
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
          onClick={() => { if (fromPos) { router.push('/pos'); return; } go({ name: 'home' }); void load(); }}>Back</button>
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
          <BigButton key={h.id} tone="primary" onClick={() => go({ name: 'receive', handoverId: h.id, fromCashier: h.from_cashier })}>
            Receive drawer from {h.from_cashier} — count the float
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
        {s && (s.is_mine || status.can_resolve) && (
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
      <div className="space-y-4">
        {header('Open shift')}
        <p className="text-sm text-muted-foreground">Count the float (starting cash) in the drawer. Use − if you tap too many.</p>
        <CashCounter value={count} onChange={setCount} rate={rate} />
        <BigButton tone="primary" disabled={busy || countIsEmpty} onClick={() => submit(async () => {
          try {
            await api.post('/cash-handover/open', { count: cashCountPayload(count), device: 'pos' });
            toast.success(`Shift opened with ${floatText}`);
            router.push('/pos');
          } catch (error) { toast.error(errorText(error, 'Could not open shift')); }
        })}>{countIsEmpty ? 'Count the float to open the shift' : `Open shift with ${floatText}`}</BigButton>
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
        onClosed={() => { if (fromPos) { router.push('/pos'); return; } go({ name: 'home' }); void load(); }}
        onHandover={() => go({ name: 'handover', sessionId: view.sessionId })} />
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

const STEPS = ['Take out float', 'Count cash', 'Cash spent', 'Check & close'] as const;

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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1 text-sm">
      <span>{label}</span><span className="tabular-nums">{value}</span>
    </div>
  );
}

function signedUsd(cents: number): string {
  return cents > 0 ? `+${formatUsdCents(cents)}` : formatUsdCents(cents);
}

function ResultLine({ n, label, value, tone }: { n: number; label: string; value: string; tone?: 'minus' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 text-base">
      <span><span className="me-2 text-muted-foreground">{n}.</span>{label}</span>
      <span className={`tabular-nums font-semibold ${tone === 'minus' ? 'text-red-700' : ''}`}>{value}</span>
    </div>
  );
}

/** Camera (take a photo) and gallery (import) buttons for a receipt; uploads and returns the media id. */
function ReceiptPhotoButtons({ sessionId, mediaId, onUploaded }: {
  sessionId: number; mediaId: number | null; onUploaded: (mediaId: number) => void;
}) {
  const [state, setState] = useState<'idle' | 'uploading' | 'failed'>('idle');
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setState('uploading');
    try {
      const data = await readFileAsDataUrl(file);
      const res = await api.post('/cash-handover/media', { kind: 'purchase_receipt', data, session_id: sessionId },
        { headers: { 'Idempotency-Key': newKey() } });
      setState('idle');
      onUploaded(res.data.media.id);
    } catch (error) {
      setState('failed');
      toast.error(errorText(error, 'Photo upload failed, try again'));
    }
  };
  const iconClass = 'flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border text-lg hover:bg-muted';
  if (mediaId) return <span className="flex size-10 shrink-0 items-center justify-center text-lg text-emerald-700" title="Receipt photo attached">✓</span>;
  return (
    <div className="flex shrink-0 gap-1">
      <label className={iconClass} title="Take a photo of the receipt" aria-label="Take a photo of the receipt">
        {state === 'uploading' ? '…' : '📷'}
        <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      <label className={iconClass} title="Import a receipt photo" aria-label="Import a receipt photo">
        🖼
        <input type="file" accept="image/*" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
      </label>
    </div>
  );
}

function SimpleClose({ header, sessionId, rate, openingFloat, onClosed, onHandover }: {
  header: (t: string) => React.ReactNode;
  sessionId: number;
  rate: number;
  openingFloat: { usd_cents: number; khr_riel: number };
  onClosed: () => void;
  /** Hand the open (unpaid) tables to the next cashier instead of closing. */
  onHandover: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [openTickets, setOpenTickets] = useState<{ order_id: number; order_number: string; table_label: string | null; balance: number }[]>([]);
  const [floatCount, setFloatCount] = useState<CashCountValue>(emptyCashCount());
  const [count, setCount] = useState<CashCountValue>(emptyCashCount());
  const [spent, setSpent] = useState<SpentItem[]>([]);
  const [draft, setDraft] = useState({ paidTo: '', what: '', amount: '', currency: 'USD', mediaId: null as number | null });
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const paidToRef = useRef<HTMLInputElement>(null);
  const whatRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    api.get('/cash-handover/open-tickets').then(({ data }) => { if (active) setOpenTickets(data.tickets || []); }).catch(() => {});
    api.get(`/cash-handover/sessions/${sessionId}/cash-spent`)
      .then((res) => { if (active) setSpent(res.data.items); })
      .catch((error) => toast.error(errorText(error, 'Could not load cash spent')));
    return () => { active = false; };
  }, [sessionId]);

  const floatTotals = cashCountTotals(floatCount, rate);
  const floatPayload = { usd_cents: floatTotals.usd, khr_riel: floatTotals.khr };
  const floatIsEmpty = floatTotals.combined === 0;
  const countIsEmpty = cashCountTotals(count, rate).combined === 0;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const draftValid = (Number.parseFloat(draft.amount) || 0) > 0 && draft.what.trim().length > 0;
  const draftStarted = draft.paidTo.trim() !== '' || draft.what.trim() !== '' || draft.amount.trim() !== '' || draft.mediaId != null;

  const saveDraft = async (): Promise<boolean> => {
    const amount = Number.parseFloat(draft.amount) || 0;
    const what = (draft.paidTo.trim() ? `${draft.paidTo.trim()}: ${draft.what.trim()}` : draft.what.trim()).slice(0, 120);
    try {
      const res = await api.post(`/cash-handover/sessions/${sessionId}/cash-spent`, {
        currency: draft.currency,
        amount_minor: draft.currency === 'USD' ? Math.round(amount * 100) : Math.round(amount),
        what,
        media_id: draft.mediaId,
      });
      setSpent((items) => [...items, res.data.item]);
      setDraft({ paidTo: '', what: '', amount: '', currency: draft.currency, mediaId: null });
      return true;
    } catch (error) {
      toast.error(errorText(error, 'Could not add cash spent'));
      return false;
    }
  };

  // Enter moves along the line: Paid to → What for → Amount → saves the line and starts a new one.
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>, next: 'what' | 'amount' | 'save') => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (next === 'what') whatRef.current?.focus();
    else if (next === 'amount') amountRef.current?.focus();
    else if (draftValid) void run(async () => { if (await saveDraft()) paidToRef.current?.focus(); });
    else toast.error('Add what it was for and the amount');
  };

  const removeSpent = (id: number) => run(async () => {
    try {
      await api.delete(`/cash-handover/sessions/${sessionId}/cash-spent/${id}`);
      setSpent((items) => items.filter((item) => item.id !== id));
    } catch (error) { toast.error(errorText(error, 'Could not remove item')); }
  });

  const checkResult = () => run(async () => {
    if (draftStarted) {
      if (!draftValid) {
        toast.error('Finish the last line (what it was for and the amount), or clear it');
        return;
      }
      if (!(await saveDraft())) return;
    }
    try {
      const res = await api.post(`/cash-handover/sessions/${sessionId}/close-preview`, { count: cashCountPayload(count), float_out: floatPayload });
      setPreview(res.data);
      setStep(3);
    } catch (error) { toast.error(errorText(error, 'Could not check the count')); }
  });

  const closeShift = () => run(async () => {
    try {
      await api.post(`/cash-handover/sessions/${sessionId}/closing-count`, {
        count: cashCountPayload(count), float_out: floatPayload, explanation: reason.trim() || undefined, device: 'pos',
      });
      toast.success('Shift closed');
      try {
        await printReportReceipt({ kind: 'shift', sessionId }, { auto: true });
      } catch (printError) {
        if (!(printError instanceof PrintSkippedError)) toast.error('The shift is closed, but the Z report did not print. Reprint it from Reports → Shifts.', { duration: 8000 });
      }
      onClosed();
    } catch (error) { toast.error(errorText(error, 'Could not close the shift')); }
  });

  const openingText = `${formatUsdCents(openingFloat.usd_cents)} + ${formatKhr(openingFloat.khr_riel)}`;
  const noLines = spent.length === 0 && !draftStarted;

  const openOwed = openTickets.reduce((sum, t) => sum + Number(t.balance || 0), 0);

  return (
    <div className="space-y-4">
      {header('Close shift')}
      {openTickets.length > 0 && (
        <div className="space-y-3 rounded-xl border border-orange-300 bg-orange-50 p-4 text-sm text-orange-900">
          <p>
            <b>{openTickets.length} {openTickets.length === 1 ? 'bill is' : 'bills are'} still not paid</b> (${openOwed.toFixed(2)}):{' '}
            {openTickets.slice(0, 6).map((t) => t.table_label || `#${String(t.order_number).split('-').pop()}`).join(', ')}{openTickets.length > 6 ? '…' : ''}.
            {' '}Take payment or cancel them before closing, or hand them over to the next cashier.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => router.push('/orders')}
              className="rounded-xl border-2 border-orange-400 bg-white px-3 py-3 font-semibold">Go to Orders</button>
            <button type="button" onClick={onHandover}
              className="rounded-xl bg-orange-600 px-3 py-3 font-semibold text-white">Hand over to next cashier</button>
          </div>
        </div>
      )}
      <StepDots step={step} />

      {step === 0 && (
        <>
          <p className="text-sm text-muted-foreground">
            Take the float out of the drawer and count it. The shift started with <b>{openingText}</b>.
          </p>
          <CashCounter value={floatCount} onChange={setFloatCount} rate={rate} title="Float taken out" />
          <BigButton tone="primary" disabled={floatIsEmpty} onClick={() => setStep(1)}>I&apos;ve taken the float out: next</BigButton>
        </>
      )}

      {step === 1 && (
        <>
          <p className="text-sm text-muted-foreground">Now count all the money left in the drawer.</p>
          <CashCounter value={count} onChange={setCount} rate={rate} title="Money in the drawer" />
          <BigButton tone="primary" disabled={countIsEmpty} onClick={() => setStep(2)}>I&apos;ve finished counting the cash: next</BigButton>
          <button type="button" className="text-sm underline" onClick={() => setStep(0)}>Back</button>
        </>
      )}

      {step === 2 && (
        <>
          <p className="text-sm text-muted-foreground">Was any money from the drawer used to pay for something? Add one line each.</p>
          <div className="overflow-hidden rounded-xl border">
            <div className="grid grid-cols-[1fr_1.4fr_7rem_5.5rem] gap-2 bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground">
              <span>Paid to</span><span>What for</span><span>Amount</span><span>Receipt</span>
            </div>
            {spent.map((item) => {
              const text = item.reason || '';
              const cut = text.indexOf(': ');
              const paidTo = cut > 0 ? text.slice(0, cut) : '';
              const what = cut > 0 ? text.slice(cut + 2) : text;
              return (
                <div key={item.id} className="grid grid-cols-[1fr_1.4fr_7rem_5.5rem] items-center gap-2 border-t px-3 py-2 text-sm">
                  <span className="truncate">{paidTo || '·'}</span>
                  <span className="truncate">{what}</span>
                  <span className="tabular-nums font-semibold">{item.amount_khr_riel ? formatKhr(item.amount_khr_riel) : formatUsdCents(item.amount_cents)}</span>
                  <span className="flex items-center justify-between gap-1">
                    <span>{item.media_id ? '📷' : ''}</span>
                    <button type="button" disabled={busy} aria-label="Remove line" className="rounded px-2 text-red-600 hover:bg-red-50" onClick={() => removeSpent(item.id)}>✕</button>
                  </span>
                </div>
              );
            })}
            <div className="grid grid-cols-[1fr_1.4fr_7rem_5.5rem] items-center gap-2 border-t px-3 py-2">
              <input ref={paidToRef} placeholder="Shop / person" value={draft.paidTo} maxLength={40} aria-label="Paid to"
                onChange={(e) => setDraft({ ...draft, paidTo: e.target.value })} onKeyDown={(e) => onEnter(e, 'what')}
                className="min-w-0 rounded-md border px-2 py-2 text-sm" />
              <input ref={whatRef} placeholder="Ice, gas, vegetables…" value={draft.what} maxLength={80} aria-label="What for"
                onChange={(e) => setDraft({ ...draft, what: e.target.value })} onKeyDown={(e) => onEnter(e, 'amount')}
                className="min-w-0 rounded-md border px-2 py-2 text-sm" />
              <div className="flex min-w-0 gap-1">
                <input ref={amountRef} inputMode="decimal" placeholder="0" value={draft.amount} aria-label="Amount"
                  onChange={(e) => setDraft({ ...draft, amount: e.target.value.replace(/[^\d.]/g, '') })} onKeyDown={(e) => onEnter(e, 'save')}
                  className="min-w-0 flex-1 rounded-md border px-2 py-2 text-sm tabular-nums" />
                <select value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
                  aria-label="Currency" className="shrink-0 rounded-md border px-1 text-xs">
                  <option value="USD">$</option><option value="KHR">៛</option>
                </select>
              </div>
              <ReceiptPhotoButtons sessionId={sessionId} mediaId={draft.mediaId} onUploaded={(mediaId) => setDraft((d) => ({ ...d, mediaId }))} />
            </div>
          </div>
          {draftValid && (
            <button type="button" disabled={busy} onClick={() => run(async () => { if (await saveDraft()) paidToRef.current?.focus(); })}
              className="text-sm font-semibold text-emerald-700 underline">+ Add another line</button>
          )}
          <BigButton tone="primary" disabled={busy} onClick={checkResult}>
            {noLines ? 'No cash spent today: next' : 'Next: check the result'}
          </BigButton>
          <button type="button" className="text-sm underline" onClick={() => setStep(1)}>Back</button>
        </>
      )}

      {step === 3 && preview && (() => {
        const floatOutCents = combinedUsdCents(floatPayload.usd_cents, floatPayload.khr_riel, preview.rate_khr_per_usd);
        const moneyInHand = preview.counted_usd_cents - floatOutCents;
        const shouldBeInHand = preview.cash_sales_usd_cents - preview.cash_spent_usd_cents;
        const floatGap = floatOutCents - preview.opening_float_usd_cents;
        const diff = preview.difference_usd_cents;
        return (
          <>
            <div className="rounded-xl border p-4">
              <ResultLine n={1} label="Cash sales" value={formatUsdCents(preview.cash_sales_usd_cents)} />
              <ResultLine n={2} label="Cash spent" value={`−${formatUsdCents(preview.cash_spent_usd_cents)}`} tone="minus" />
              <div className="flex justify-between border-t py-1 text-sm text-muted-foreground">
                <span>Should be in hand</span><span className="tabular-nums">{formatUsdCents(shouldBeInHand)}</span>
              </div>
              <ResultLine n={3} label="Money in hand (counted, without float)" value={formatUsdCents(moneyInHand)} />
              <div className={`mt-2 flex items-baseline justify-between rounded-lg px-3 py-3 text-lg font-bold ${preview.matches ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>
                <span><span className="me-2 font-normal text-muted-foreground">4.</span>{preview.matches ? 'Match ✓' : diff < 0 ? 'Short' : 'Over'}</span>
                <span className="tabular-nums">{preview.matches ? signedUsd(diff) : formatUsdCents(Math.abs(diff))}</span>
              </div>
              {floatGap !== 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Float taken out {formatUsdCents(floatOutCents)}; the shift started with {formatUsdCents(preview.opening_float_usd_cents)}.
                  The {formatUsdCents(Math.abs(floatGap))} gap is included in the result.
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                Riel converted at {preview.rate_khr_per_usd.toLocaleString()}៛ = $1. Within ±{formatUsdCents(preview.tolerance_usd_cents)} counts as a match.
              </p>
              {preview.untracked_cash_lines > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">{preview.untracked_cash_lines} older cash payment(s) had no USD/KHR split and were counted as USD.</p>
              )}
            </div>
            {preview.non_cash_payments.length > 0 && (
              <div className="rounded-xl border p-4">
                <div className="mb-1 text-sm font-semibold">Check against the bank app / card machine</div>
                {preview.non_cash_payments.map((p) => <Row key={p.method} label={p.method} value={formatUsdCents(p.total_cents)} />)}
              </div>
            )}
            {!preview.matches && (
              <>
                <BigButton tone="warning" onClick={() => { setStep(1); setPreview(null); }}>Recount the cash</BigButton>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500}
                  placeholder="Reason for the difference (optional)" className="w-full rounded-xl border px-4 py-3 text-sm" />
              </>
            )}
            <BigButton tone="primary" disabled={busy} onClick={closeShift}>Close shift &amp; print Z report</BigButton>
            <button type="button" className="text-sm underline" onClick={() => setStep(2)}>Back to cash spent</button>
          </>
        );
      })()}
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
