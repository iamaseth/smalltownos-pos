'use client';

/**
 * BackStreet Cash Counter — one reusable counter for opening float, closing
 * count, handover float and takings. Works on the POS touchscreen, desktop
 * and phone.
 *
 * Each note is one compact line: − / type the number / +.
 *
 * Denomination counting and manual totals are alternatives — never added together.
 */
import { useCallback, useMemo } from 'react';
import {
  CASH_DENOMINATIONS, applyTileGesture, combinedUsdCents, emptyDenominations, formatKhr, formatUsdCents,
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

const noteLabel = (currency: CashCurrency, note: number) => (currency === 'USD' ? `$${note}` : `${note.toLocaleString('en-US')}៛`);

/**
 * One compact line per note: label · − · quantity (type to set) · +.
 * Small enough that USD and KHR fit side by side on a till or phone screen.
 */
function NoteRow({
  currency, note, quantity, onChange,
}: { currency: CashCurrency; note: number; quantity: number; onChange: (g: TileGesture) => void }) {
  const usd = currency === 'USD';
  const label = noteLabel(currency, note);
  // Short on screen (50k៛) so both columns fit on a phone; full value for screen readers.
  const shortLabel = usd ? label : note >= 1000 ? `${note / 1000}k៛` : `${note}៛`;
  return (
    <div className={`flex items-center gap-1 rounded-lg border px-2 py-1 ${quantity > 0
      ? (usd ? 'border-emerald-300 bg-emerald-50' : 'border-orange-300 bg-orange-50')
      : 'border-border bg-card'}`}>
      <span className={`min-w-0 flex-1 truncate text-sm font-semibold tabular-nums ${usd ? 'text-emerald-700' : 'text-orange-600'}`}>{shortLabel}</span>
      <button type="button" aria-label={`Remove one ${label}`} disabled={quantity === 0}
        onClick={() => onChange({ type: 'decrement' })}
        className="flex size-8 shrink-0 items-center justify-center rounded-md border text-lg font-bold leading-none disabled:opacity-30">−</button>
      <input aria-label={`Number of ${label} notes`} inputMode="numeric" pattern="[0-9]*"
        value={quantity === 0 ? '' : String(quantity)} placeholder="0"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => onChange({ type: 'set', quantity: Number(e.target.value.replace(/\D/g, '').slice(0, 4) || 0) })}
        className="h-8 w-10 shrink-0 rounded-md border bg-background text-center text-sm font-semibold tabular-nums" />
      <button type="button" aria-label={`Add one ${label}`}
        onClick={() => onChange({ type: 'tap' })}
        className={`flex size-8 shrink-0 items-center justify-center rounded-md text-lg font-bold leading-none text-white ${usd ? 'bg-emerald-600' : 'bg-orange-500'}`}>+</button>
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
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        {title ? <h3 className="text-base font-semibold text-foreground">{title}</h3> : <span />}
        {allowManual && (
          <button type="button" onClick={() => onChange({ ...value, method: denominationsOn ? 'manual' : 'denominations' })}
            className="shrink-0 text-xs text-muted-foreground underline">
            {denominationsOn ? 'Type totals instead' : 'Count notes instead'}
          </button>
        )}
      </div>

      {denominationsOn ? (
        <div className="grid grid-cols-2 gap-3">
          <section aria-label="US dollars" className="space-y-1">
            <h4 className="text-xs font-semibold uppercase text-emerald-700">USD</h4>
            {CASH_DENOMINATIONS.USD.map((note) => (
              <NoteRow key={note} currency="USD" note={note} quantity={value.denominations.USD[String(note)] || 0}
                onChange={(g) => setQty('USD', note, g)} />
            ))}
          </section>
          <section aria-label="Riel" className="space-y-1">
            <h4 className="text-xs font-semibold uppercase text-orange-600">KHR</h4>
            {CASH_DENOMINATIONS.KHR.map((note) => (
              <NoteRow key={note} currency="KHR" note={note} quantity={value.denominations.KHR[String(note)] || 0}
                onChange={(g) => setQty('KHR', note, g)} />
            ))}
          </section>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-emerald-700">USD total</span>
            <input inputMode="decimal" value={value.manualUsd} placeholder="0.00"
              onChange={(e) => onChange({ ...value, manualUsd: e.target.value.replace(/[^\d.]/g, '') })}
              className="w-full rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-lg tabular-nums" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-orange-600">KHR total</span>
            <input inputMode="numeric" value={value.manualKhr} placeholder="0"
              onChange={(e) => onChange({ ...value, manualKhr: e.target.value.replace(/\D/g, '') })}
              className="w-full rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-lg tabular-nums" />
          </label>
        </div>
      )}

      <div className="flex items-baseline justify-between gap-3 rounded-lg border bg-card px-3 py-2">
        <span className="text-sm text-muted-foreground">Total</span>
        <span className="text-lg font-semibold tabular-nums text-emerald-700">{formatUsdCents(totals.usd)}</span>
        <span className="text-lg font-semibold tabular-nums text-orange-600">{formatKhr(totals.khr)}</span>
      </div>
      {!denominationsOn && totals.khr % 100 !== 0 && (
        <p className="text-xs text-red-600">KHR total must be a multiple of 100៛.</p>
      )}
    </div>
  );
}
