/**
 * BackStreet cash counter: shared, framework-free counting rules used by the
 * Cash Counter UI (POS touchscreen, desktop and phone) and validated again by
 * the backend, which stays authoritative for every stored total.
 *
 * Amounts are integer minor units: USD in cents, KHR in whole riel.
 * The combined USD-equivalent is a reporting value only; it is never the
 * physical USD balance of the drawer.
 */

export type CashCurrency = 'USD' | 'KHR';
export type CashCountMethod = 'denominations' | 'manual';

/** Note values in major units (dollars / riel), largest first. */
export const CASH_DENOMINATIONS: Readonly<Record<CashCurrency, readonly number[]>> = {
  USD: [100, 50, 20, 10, 5, 2, 1],
  KHR: [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 100],
};

/** Quantities keyed by note value as a string, e.g. { "20": 5 }. */
export type DenominationQuantities = Record<string, number>;

export interface CashDenominations {
  USD: DenominationQuantities;
  KHR: DenominationQuantities;
}

export interface CashCountInput {
  method: CashCountMethod;
  /** Required for method 'manual'; ignored (recomputed) for 'denominations'. */
  usd_cents?: number;
  khr_riel?: number;
  denominations?: CashDenominations | null;
}

export interface CashCountTotals {
  method: CashCountMethod;
  usd_cents: number;
  khr_riel: number;
  rate_khr_per_usd: number;
  combined_usd_cents: number;
  denominations: CashDenominations | null;
}

/** Maximum notes of one value in a single count (guards typos like 2000 × $100). */
export const MAX_NOTES_PER_DENOMINATION = 9999;

export function emptyDenominations(): CashDenominations {
  const make = (currency: CashCurrency) =>
    Object.fromEntries(CASH_DENOMINATIONS[currency].map((v) => [String(v), 0])) as DenominationQuantities;
  return { USD: make('USD'), KHR: make('KHR') };
}

/** KHR converted to USD cents at the given rate (riel per 1 USD), rounded to the nearest cent. */
export function khrToUsdCents(khrRiel: number, rateKhrPerUsd: number): number {
  if (!Number.isFinite(rateKhrPerUsd) || rateKhrPerUsd <= 0) return 0;
  return Math.round((khrRiel * 100) / rateKhrPerUsd);
}

/** Combined USD equivalent = USD + KHR / rate, in cents. Reporting value only. */
export function combinedUsdCents(usdCents: number, khrRiel: number, rateKhrPerUsd: number): number {
  return usdCents + khrToUsdCents(khrRiel, rateKhrPerUsd);
}

export function subtotalFromDenominations(currency: CashCurrency, quantities: DenominationQuantities): number {
  let total = 0;
  for (const value of CASH_DENOMINATIONS[currency]) {
    const qty = Number(quantities[String(value)] || 0);
    total += qty * value;
  }
  // USD returned in cents, KHR in riel.
  return currency === 'USD' ? total * 100 : total;
}

/* ── Tile gestures ─────────────────────────────────────────────────────── */

export type TileGesture =
  | { type: 'tap' }
  | { type: 'double' }
  | { type: 'clear' }
  | { type: 'set'; quantity: number }
  | { type: 'decrement' };

/**
 * Applies one gesture to a note quantity.
 * tap = +1, swipe right = double, swipe left = clear, press-and-hold = exact quantity.
 * 'decrement' exists for keyboard/desktop accessibility.
 */
export function applyTileGesture(quantity: number, gesture: TileGesture): number {
  const current = Number.isInteger(quantity) && quantity > 0 ? quantity : 0;
  let next: number;
  switch (gesture.type) {
    case 'tap': next = current + 1; break;
    case 'double': next = current * 2; break;
    case 'clear': next = 0; break;
    case 'decrement': next = Math.max(0, current - 1); break;
    case 'set': next = Number.isFinite(gesture.quantity) ? Math.max(0, Math.floor(gesture.quantity)) : current; break;
    default: next = current;
  }
  return Math.min(next, MAX_NOTES_PER_DENOMINATION);
}

/**
 * Horizontal-swipe classifier that ignores vertical scrolling.
 * Returns 'double' for a right swipe, 'clear' for a left swipe, null otherwise.
 */
export function classifySwipe(dx: number, dy: number, minDistance = 40): 'double' | 'clear' | null {
  if (Math.abs(dx) < minDistance) return null;
  if (Math.abs(dx) < 2 * Math.abs(dy)) return null;
  return dx > 0 ? 'double' : 'clear';
}

/* ── Validation (backend-authoritative) ───────────────────────────────── */

export class CashCountError extends Error {
  readonly statusCode = 400;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function normalizeQuantities(currency: CashCurrency, raw: unknown): DenominationQuantities {
  if (raw == null) return Object.fromEntries(CASH_DENOMINATIONS[currency].map((v) => [String(v), 0]));
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new CashCountError(`${currency} denominations must be an object`);
  const allowed = new Set(CASH_DENOMINATIONS[currency].map(String));
  const out: DenominationQuantities = {};
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!allowed.has(key)) throw new CashCountError(`Unknown ${currency} note: ${key}`);
  }
  for (const value of CASH_DENOMINATIONS[currency]) {
    const qty = (raw as Record<string, unknown>)[String(value)] ?? 0;
    if (!isNonNegativeInteger(qty) || qty > MAX_NOTES_PER_DENOMINATION) {
      throw new CashCountError(`${currency} ${value} quantity must be a whole number between 0 and ${MAX_NOTES_PER_DENOMINATION}`);
    }
    out[String(value)] = qty;
  }
  return out;
}

/**
 * Validates a submitted count and computes its totals. Denomination counts are
 * recomputed from the quantities (client totals are ignored); manual counts use
 * the entered totals. The two methods are never added together.
 */
export function normalizeCashCount(input: unknown, rateKhrPerUsd: number): CashCountTotals {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CashCountError('count is required');
  const body = input as Record<string, unknown>;
  const method = body.method;
  if (method !== 'denominations' && method !== 'manual') {
    throw new CashCountError("count.method must be 'denominations' or 'manual'");
  }
  if (!Number.isInteger(rateKhrPerUsd) || rateKhrPerUsd < 1000 || rateKhrPerUsd > 10000) {
    throw new CashCountError('USD/KHR exchange rate is not configured correctly');
  }
  if (method === 'denominations') {
    const denoms = body.denominations as Record<string, unknown> | undefined;
    if (!denoms || typeof denoms !== 'object' || Array.isArray(denoms)) {
      throw new CashCountError('count.denominations is required for denomination counting');
    }
    const denominations: CashDenominations = {
      USD: normalizeQuantities('USD', denoms.USD),
      KHR: normalizeQuantities('KHR', denoms.KHR),
    };
    const usd = subtotalFromDenominations('USD', denominations.USD);
    const khr = subtotalFromDenominations('KHR', denominations.KHR);
    return {
      method, usd_cents: usd, khr_riel: khr, rate_khr_per_usd: rateKhrPerUsd,
      combined_usd_cents: combinedUsdCents(usd, khr, rateKhrPerUsd), denominations,
    };
  }
  const usd = body.usd_cents ?? 0;
  const khr = body.khr_riel ?? 0;
  if (!isNonNegativeInteger(usd)) throw new CashCountError('count.usd_cents must be a whole number of cents >= 0');
  if (!isNonNegativeInteger(khr)) throw new CashCountError('count.khr_riel must be a whole number of riel >= 0');
  if (khr % 100 !== 0) throw new CashCountError('count.khr_riel must be a multiple of 100 riel');
  return {
    method, usd_cents: usd, khr_riel: khr, rate_khr_per_usd: rateKhrPerUsd,
    combined_usd_cents: combinedUsdCents(usd, khr, rateKhrPerUsd), denominations: null,
  };
}

/* ── Formatting helpers (UI) ──────────────────────────────────────────── */

export function formatUsdCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatKhr(riel: number): string {
  const sign = riel < 0 ? '-' : '';
  return `${sign}${Math.abs(riel).toLocaleString('en-US')}៛`;
}
