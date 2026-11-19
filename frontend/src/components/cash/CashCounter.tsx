'use client';

/**
 * BackStreet Cash Counter — one reusable counter for opening float, closing
 * count, handover float and takings. Works on the POS touchscreen, desktop
 * and phone.
 *
 * Gestures on a note tile: tap = +1 · swipe right = double · swipe left = clear
 * · press and hold = enter an exact quantity. Desktop/keyboard: focus a tile and
 * use + / − / * (double) / Delete (clear) / digits + Enter (exact).
 *
 * Denomination counting and manual totals are alternatives — never added together.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  CASH_DENOMINATIONS, applyTileGesture, classifySwipe, combinedUsdCents, emptyDenominations, formatKhr, formatUsdCents,
  subtotalFromDenominations, type CashCountMethod, type CashCurrency, type CashDenominations, type TileGesture,
} from '@shared/cash-counter';

export interface CashCountValue {
  method: CashCountMethod;
  denominations: CashDenominations;
  manualUsd: string;
  manualKhr: string;
}

export function emptyCashCount(method: CashCountMethod = 'denominations'): CashCountValue {
  return { method, denominations: emptyDenominations(), manualUsd: '', manualKhr: '' };
}

/** Totals in minor units for the current value (USD cents, KHR riel). */
export function cashCountTotals(value: CashCountValue, rate: number) {
  if (value.method === 'denominations') {
    const usd = subtotalFromDenominations('USD', value.denominations.USD);
    const khr = subtotalFromDenominations('KHR', value.denominations.KHR);
    return { usd, khr, combined: combinedUsdCents(usd, khr, rate) };
  }
  const usd = Math.round((Number.parseFloat(value.manualUsd) || 0) * 100);
  const khr = Math.round(Number.parseInt(value.manualKhr || '0', 10) || 0);
  return { usd, khr, combined: combinedUsdCents(usd, khr, rate) };
}

/** Payload for the backend (`count` field); the server recomputes all totals. */
export function cashCountPayload(value: CashCountValue) {
  if (value.method === 'denominations') return { method: 'denominations' as const, denominations: value.denominations };
  const { usd, khr } = cashCountTotals(value, 4100);
  return { method: 'manual' as const, usd_cents: usd, khr_riel: khr };
}

const LONG_PRESS_MS = 500;

const noteLabel = (currency: CashCurrency, note: number) => (currency === 'USD' ? `$${note}` : `${note.toLocaleString('en-US')}៛`);

function NoteTile({
  currency, note, quantity, onGesture, onHold,
}: { currency: CashCurrency; note: number; quantity: number; onGesture: (g: TileGesture) => void; onHold: () => void }) {
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const [typing, setTyping] = useState('');

  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

  const askExact = () => {
    longPressed.current = true;
    onHold();
  };

  const usd = currency === 'USD';
  const label = noteLabel(currency, note);
  return (
    <button
      type="button"
      aria-label={`${label}: ${quantity} notes. Tap to add one, swipe right to double, swipe left to clear, hold to type a number.`}
      className={[
        'flex items-center justify-between rounded-xl border px-4 py-4 text-left select-none touch-pan-y',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
        usd ? 'bg-emerald-50 border-emerald-200 text-emerald-800 focus-visible:ring-emerald-500'
          : 'bg-orange-50 border-orange-200 text-orange-700 focus-visible:ring-orange-500',
        quantity > 0 ? 'font-semibold' : '',
      ].join(' ')}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, y: e.clientY, t: Date.now() };
        longPressed.current = false;
        clearTimer();
        timer.current = setTimeout(askExact, LONG_PRESS_MS);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        if (Math.abs(e.clientX - start.current.x) > 8 || Math.abs(e.clientY - start.current.y) > 8) clearTimer();
      }}
      onPointerUp={(e) => {
        clearTimer();
        const s = start.current;
        start.current = null;
        if (!s || longPressed.current) return;
        const swipe = classifySwipe(e.clientX - s.x, e.clientY - s.y);
        if (swipe) onGesture({ type: swipe });
        else if (Math.abs(e.clientY - s.y) < 10) onGesture({ type: 'tap' });
      }}
      onPointerCancel={() => { clearTimer(); start.current = null; }}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => { if (e.detail === 0) onGesture({ type: 'tap' }); }}
      onKeyDown={(e) => {
        if (e.key === '+' || e.key === '=') { e.preventDefault(); onGesture({ type: 'tap' }); }
        else if (e.key === '-') { e.preventDefault(); onGesture({ type: 'decrement' }); }
        else if (e.key === '*') { e.preventDefault(); onGesture({ type: 'double' }); }
        else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); setTyping(''); onGesture({ type: 'clear' }); }
        else if (/^\d$/.test(e.key)) { e.preventDefault(); setTyping((t) => (t + e.key).slice(0, 4)); }
        else if (e.key === 'Enter' && typing) { e.preventDefault(); onGesture({ type: 'set', quantity: Number(typing) }); setTyping(''); }
      }}
      onBlur={() => setTyping('')}
    >
      <span className="text-lg">{label}</span>
      <span className="text-lg tabular-nums text-foreground">{typing ? `${typing}…` : quantity}</span>
    </button>
  );
}

function ExactQuantitySheet({
  currency, note, initial, onSet, onCancel,
}: { currency: CashCurrency; note: number; initial: number; onSet: (quantity: number) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial > 0 ? String(initial) : '');
  const valid = /^\d{1,4}$/.test(text);
  const usd = currency === 'USD';
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" role="dialog" aria-modal="true"
      aria-label={`${noteLabel(currency, note)} — how many notes?`} onClick={onCancel}>
      <form className="w-full max-w-sm rounded-t-2xl bg-card p-5 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (valid) onSet(Number(text)); }}>
        <p className={`text-lg font-semibold ${usd ? 'text-emerald-700' : 'text-orange-600'}`}>{noteLabel(currency, note)}</p>
        <label className="mt-1 block text-sm text-muted-foreground" htmlFor="exact-quantity">How many notes?</label>
        <input id="exact-quantity" autoFocus inputMode="numeric" pattern="[0-9]*" value={text}
          onChange={(e) => setText(e.target.value.replace(/\D/g, '').slice(0, 4))}
          className={`mt-2 w-full rounded-xl border px-4 py-3 text-2xl tabular-nums ${usd ? 'border-emerald-200 bg-emerald-50' : 'border-orange-200 bg-orange-50'}`} />
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button type="button" onClick={onCancel} className="rounded-xl border px-4 py-3 font-semibold">Cancel</button>
          <button type="submit" disabled={!valid} className="rounded-xl bg-foreground px-4 py-3 font-semibold text-background disabled:opacity-50">Set</button>
        </div>
      </form>
    </div>
  );
}

export function CashCounter({
  value, onChange, rate, title, allowManual = true,
}: {
  value: CashCountValue;
  onChange: (next: CashCountValue) => void;
  rate: number;
  title?: string;
  allowManual?: boolean;
}) {
  const totals = useMemo(() => cashCountTotals(value, rate), [value, rate]);
  const [exact, setExact] = useState<{ currency: CashCurrency; note: number } | null>(null);
  const setQty = useCallback((currency: CashCurrency, note: number, gesture: TileGesture) => {
    const current = value.denominations[currency][String(note)] || 0;
    onChange({
      ...value,
      denominations: {
        ...value.denominations,
        [currency]: { ...value.denominations[currency], [String(note)]: applyTileGesture(current, gesture) },
      },
    });
  }, [value, onChange]);

  const denominationsOn = value.method === 'denominations';
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        {title ? <h3 className="text-base font-semibold text-foreground">{title}</h3> : <span />}
        {allowManual && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
            <span>{denominationsOn ? 'Count notes' : 'Enter totals'}</span>
            <button
              type="button"
              role="switch"
              aria-checked={denominationsOn}
              aria-label="Count notes on or off"
              onClick={() => onChange({ ...value, method: denominationsOn ? 'manual' : 'denominations' })}
              className={`relative h-7 w-12 rounded-full transition-colors ${denominationsOn ? 'bg-emerald-600' : 'bg-muted-foreground/40'}`}
            >
              <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${denominationsOn ? 'left-6' : 'left-1'}`} />
            </button>
          </label>
        )}
      </div>

      {denominationsOn ? (
        <>
          <p className="text-xs text-muted-foreground">Tap +1 · swipe right ×2 · swipe left clear · hold to type</p>
          <section>
            <h4 className="mb-2 text-sm font-semibold text-emerald-700">USD</h4>
            <div className="grid grid-cols-2 gap-3">
              {CASH_DENOMINATIONS.USD.map((note) => (
                <NoteTile key={note} currency="USD" note={note} quantity={value.denominations.USD[String(note)] || 0}
                  onGesture={(g) => setQty('USD', note, g)} onHold={() => setExact({ currency: 'USD', note })} />
              ))}
            </div>
          </section>
          <section>
            <h4 className="mb-2 text-sm font-semibold text-orange-600">KHR</h4>
            <div className="grid grid-cols-2 gap-3">
              {CASH_DENOMINATIONS.KHR.map((note) => (
                <NoteTile key={note} currency="KHR" note={note} quantity={value.denominations.KHR[String(note)] || 0}
                  onGesture={(g) => setQty('KHR', note, g)} onHold={() => setExact({ currency: 'KHR', note })} />
              ))}
            </div>
          </section>
        </>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-emerald-700">USD total</span>
            <input inputMode="decimal" value={value.manualUsd} placeholder="0.00"
              onChange={(e) => onChange({ ...value, manualUsd: e.target.value.replace(/[^\d.]/g, '') })}
              className="w-full rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-lg tabular-nums" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-orange-600">KHR total</span>
            <input inputMode="numeric" value={value.manualKhr} placeholder="0"
              onChange={(e) => onChange({ ...value, manualKhr: e.target.value.replace(/\D/g, '') })}
              className="w-full rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-lg tabular-nums" />
          </label>
        </div>
      )}

      {exact && (
        <ExactQuantitySheet currency={exact.currency} note={exact.note}
          initial={value.denominations[exact.currency][String(exact.note)] || 0}
          onCancel={() => setExact(null)}
          onSet={(quantity) => { setQty(exact.currency, exact.note, { type: 'set', quantity }); setExact(null); }} />
      )}

      <div className="rounded-xl border bg-card p-4">
        <div className="text-sm text-muted-foreground">Cash total</div>
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <span className="text-2xl font-semibold tabular-nums text-emerald-700">{formatUsdCents(totals.usd)}</span>
          <span className="text-2xl font-semibold tabular-nums text-orange-600">{formatKhr(totals.khr)}</span>
        </div>
        <div className="mt-2 flex justify-between text-xs text-muted-foreground">
          <span>Combined (reporting only) @ {rate.toLocaleString('en-US')}៛/$</span>
          <span className="tabular-nums">{formatUsdCents(totals.combined)}</span>
        </div>
        {!denominationsOn && totals.khr % 100 !== 0 && (
          <p className="mt-2 text-xs text-red-600">KHR total must be a multiple of 100៛.</p>
        )}
      </div>
    </div>
  );
}
