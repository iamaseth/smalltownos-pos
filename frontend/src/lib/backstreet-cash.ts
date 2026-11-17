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
