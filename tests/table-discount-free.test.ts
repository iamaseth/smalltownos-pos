/**
 * BackStreet: the table popup's Discount bill offers Free (whole bill, reason + manager PIN)
 * next to Percent / Amount, and every discount needs a reason.
 * Run: npx ts-node --transpile-only -P tests/tsconfig.json tests/table-discount-free.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const dialog = read('frontend/src/components/pos/DiscountDialog.tsx');
const panel = read('frontend/src/components/pos/FreeBillPanel.tsx');
const table = read('frontend/src/components/pos/TableCheckoutModal.tsx');
const orders = read('main/routes/orders.ts');

let passed = 0;
const ok = (cond: boolean, msg: string) => { assert.ok(cond, msg); passed += 1; console.log(`  ✓ ${msg}`); };

ok(dialog.includes('Free (whole bill)') && dialog.includes('<FreeBillPanel'), 'Discount bill shows a Free choice that opens the Free panel');
ok(/!clear && !reason\.trim\(\)/.test(dialog) && dialog.includes("'Add the reason for this discount'"), 'a discount cannot be applied without a reason');
ok(!dialog.includes('Reason (optional)'), 'the reason box no longer says optional');
ok(/free=\{discountTarget\.kind === 'order'/.test(table), 'Free is offered for the whole bill only, not for one item');
ok(/discount_reason: input\.value > 0 \? input\.reason/.test(table.slice(table.indexOf('/items/${discountTarget.item.id}/discount'))), 'item discounts send their reason too');
ok(panel.indexOf("api.post('/bills/generate'") > panel.indexOf('/comp`') && panel.indexOf("api.post('/bills/generate'") < panel.indexOf('await closeFree('), 'Free makes the bill before closing it (the table popup has none yet)');
ok(panel.includes('if (zero && !startOpen) return null;') && panel.includes('Close bill (everything is free)'), 'an already-$0 table can be closed from Discount bill → Free');
ok(/action: 'item_discount_applied', details: \{[^}]*discount_reason/.test(orders), 'the item discount reason is saved in the order history');

console.log(`table-discount-free: ${passed} passed`);
