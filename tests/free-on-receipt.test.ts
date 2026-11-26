/**
 * BackStreet: the bill receipt says why an item was free.
 *
 * Run: npx ts-node --transpile-only -P tests/tsconfig.json tests/free-on-receipt.test.ts
 */
import assert from 'node:assert/strict';
import { freeReasonText, withFreeReason, FREE_REASON_RECEIPT_LABELS } from '../shared/print/free-reason';
import { buildBillPrintData } from '../main/printers/document-classic';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('no reason → nothing printed', () => {
  assert.equal(freeReasonText(null), '');
  assert.equal(freeReasonText(undefined), '');
  assert.equal(freeReasonText(''), '');
  assert.equal(withFreeReason('no ice', null), 'no ice');
});

test('each reason has a short receipt label and says Free, never comp', () => {
  for (const key of ['entertainer', 'event', 'event_person', 'owner_comp', 'complaint', 'wrong_item', 'staff_meal', 'friends_owner', 'too_slow', 'other']) {
    const text = freeReasonText(key);
    assert.ok(text.startsWith('Free – '), text);
    assert.ok(!/\bcomp\b/i.test(text), text);
    assert.ok(FREE_REASON_RECEIPT_LABELS[key], key);
  }
  assert.equal(freeReasonText('event'), 'Free – Event');
});

test('free reason goes before the kitchen note', () => {
  assert.equal(withFreeReason('no ice', 'event'), 'Free – Event · no ice');
  assert.equal(withFreeReason('', 'staff_meal'), 'Free – Staff meal');
});

test('server bill print data carries the free reason on the item note', () => {
  const data = buildBillPrintData(
    { order_number: '13', created_at: '2026-11-20 04:11:00', items: [
      { product_name: 'Pineapple Shake', quantity: 1, unit_price: 2.5, total: 0, comp_reason: 'event', special_instructions: '' },
      { product_name: 'Passion Shake', quantity: 1, unit_price: 2.5, total: 2.5, special_instructions: 'less sugar' },
    ] },
    { bill_number: 'INV-1', subtotal: 2.5, total: 2.5 },
    { name: 'BackStreet Riverside' },
    false,
  );
  assert.equal(data.order.items[0].specialInstructions, 'Free – Event');
  assert.equal(data.order.items[1].specialInstructions, 'less sugar');
});

console.log(`free-on-receipt: ${passed} passed`);
