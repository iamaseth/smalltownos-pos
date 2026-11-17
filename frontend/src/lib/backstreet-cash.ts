export type BackStreetCashCurrency = 'USD' | 'KHR';

export type BackStreetCashKey = `${number}` | '.' | 'Backspace' | 'Clear';

export function applyBackStreetCashKey(
  current: string,
  key: string,
  currency: BackStreetCashCurrency,
): string {
  if (key === 'Clear') return '';
  if (key === 'Backspace') return current.slice(0, -1);
  if (key === '.') {
    if (currency === 'KHR' || current.includes('.')) return current;
    return `${current || '0'}.`;
  }
  if (!/^\d$/.test(key)) return current;
  if (currency === 'USD' && current.includes('.') && current.split('.')[1].length >= 2) return current;
  return current === '0' ? key : current + key;
}

export const BACKSTREET_CASH_NOTES: Record<BackStreetCashCurrency, readonly number[]> = {
  USD: [1, 5, 10, 20, 50, 100],
  KHR: [1000, 2000, 5000, 10000, 20000, 50000],
};

export function addBackStreetCashNote(
  current: string,
  note: number,
  currency: BackStreetCashCurrency,
): string {
  const base = Number(current);
  const safeBase = Number.isFinite(base) && base > 0 ? base : 0;
  if (currency === 'KHR') return String(Math.round(safeBase) + note);
  const cents = Math.round(safeBase * 100) + note * 100;
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export function calculateBackStreetCash(
  dueUsd: number,
  usdTendered: number,
  khrTendered: number,
  khrPerUsd: number,
) {
  const khrUsdInCents = khrToUsdMinor(khrTendered, khrPerUsd, 100);
  const tenderedCents = Math.round(usdTendered * 100) + khrUsdInCents;
  const dueCents = Math.round(dueUsd * 100);
  const changeCents = Math.max(0, tenderedCents - dueCents);

  return {
    fullyPaid: tenderedCents >= dueCents,
    remainingUsd: Math.max(0, dueCents - tenderedCents) / 100,
    changeUsd: changeCents / 100,
    changeKhr: Math.round(((changeCents / 100) * khrPerUsd) / 100) * 100,
  };
}

export function khrToUsdMinor(khrTendered: number, khrPerUsd: number, minorFactor: number): number {
  return Math.round((khrTendered / khrPerUsd) * minorFactor);
}
