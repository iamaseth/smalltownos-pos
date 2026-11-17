import assert from 'node:assert/strict';
import {
  applyBackStreetCashKey,
  calculateBackStreetCash,
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

console.log('BackStreet mixed-cash math and touch-keypad regressions passed.');
