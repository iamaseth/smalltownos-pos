import assert from 'node:assert/strict';
import {
  BACKSTREET_CASH_NOTES,
  addBackStreetCashNote,
  applyBackStreetCashKey,
  calculateBackStreetCash,
  khrToUsdMinor,
  restForTenderMinor,
} from '../frontend/src/lib/backstreet-cash';

const RATE = 4000;

assert.deepEqual(calculateBackStreetCash(3, 5, 0, RATE), {
  fullyPaid: true,
  remainingUsd: 0,
  changeUsd: 2,
  changeKhr: 8000,
});
assert.deepEqual(calculateBackStreetCash(3, 0, 12000, RATE), {
  fullyPaid: true,
  remainingUsd: 0,
  changeUsd: 0,
  changeKhr: 0,
});
assert.deepEqual(calculateBackStreetCash(3, 2, 4000, RATE), {
  fullyPaid: true,
  remainingUsd: 0,
  changeUsd: 0,
  changeKhr: 0,
});
assert.deepEqual(calculateBackStreetCash(3, 5, 4000, RATE), {
  fullyPaid: true,
  remainingUsd: 0,
  changeUsd: 3,
  changeKhr: 12000,
});
assert.deepEqual(calculateBackStreetCash(3, 1, 4000, RATE), {
  fullyPaid: false,
  remainingUsd: 1,
  changeUsd: 0,
  changeKhr: 0,
});

assert.equal(applyBackStreetCashKey('', '.', 'USD'), '0.');
assert.equal(applyBackStreetCashKey('1.2', '5', 'USD'), '1.25');
assert.equal(applyBackStreetCashKey('1.25', '9', 'USD'), '1.25');
assert.equal(applyBackStreetCashKey('12000', '.', 'KHR'), '12000');
assert.equal(applyBackStreetCashKey('12000', 'Backspace', 'KHR'), '1200');
assert.equal(applyBackStreetCashKey('12000', 'Clear', 'KHR'), '');
assert.equal(applyBackStreetCashKey('2', '4', 'USD'), '24');
assert.equal(applyBackStreetCashKey('4000', '7', 'KHR'), '40007');

assert.equal(applyBackStreetCashKey('5', '000', 'KHR'), '5000');
assert.equal(applyBackStreetCashKey('', '000', 'KHR'), '');
assert.equal(applyBackStreetCashKey('0', '000', 'KHR'), '0');
assert.equal(applyBackStreetCashKey('5', '000', 'USD'), '5');
assert.equal(addBackStreetCashNote('', 5, 'USD'), '5');
assert.equal(addBackStreetCashNote(addBackStreetCashNote('', 5, 'USD'), 5, 'USD'), '10');
assert.equal(addBackStreetCashNote('2.5', 1, 'USD'), '3.50');
assert.equal(addBackStreetCashNote('0.', 20, 'USD'), '20');
assert.equal(addBackStreetCashNote('', 5000, 'KHR'), '5000');
assert.equal(addBackStreetCashNote('5000', 5000, 'KHR'), '10000');
assert.equal(addBackStreetCashNote('abc', 1000, 'KHR'), '1000');
assert.deepEqual(BACKSTREET_CASH_NOTES.USD, [1, 5, 10, 20, 50, 100]);
assert.deepEqual(BACKSTREET_CASH_NOTES.KHR, [1000, 2000, 5000, 10000, 20000, 50000]);
assert.equal(calculateBackStreetCash(7.5, Number(addBackStreetCashNote('5', 5, 'USD')), 0, RATE).changeKhr, 10000);

// Bill $16.90; cash $10 + 20,000 KHR (= $5.00 at 4,000) leaves $1.90 for ABA, not $6.90.
const khr = khrToUsdMinor(20000, 4000, 100);
assert.equal(restForTenderMinor(1690, 1000 + khr, 0), 190);
// Re-pressing Rest on a tender that already holds the rest keeps it unchanged.
assert.equal(restForTenderMinor(1690, 1000 + khr + 190, 190), 190);
// Overpaid in cash: nothing left for the tender.
assert.equal(restForTenderMinor(1690, 2000, 0), 0);

console.log('BackStreet mixed-cash math and touch-keypad regressions passed.');
