/**
 * BackStreet: the table popup shows Discount and Free side by side (sharing the old
 * Discount bill spot), Free closes the whole bill with a reason + manager PIN, and every
 * discount needs a reason.
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
const pay = read('frontend/src/components/pos/PaymentModal.tsx');

let passed = 0;
const ok = (cond: boolean, msg: string) => { assert.ok(cond, msg); passed += 1; console.log(`  ✓ ${msg}`); };

const pairAt = table.indexOf("style={toneStyle('discount')}");
ok(pairAt > 0 && table.indexOf("style={toneStyle('free')}") > pairAt && table.indexOf("style={toneStyle('free')}") - pairAt < 600, 'Discount and Free sit side by side on the table popup');
ok(table.lastIndexOf('<div className="grid grid-cols-2 gap-2">', pairAt) > table.indexOf("style={toneStyle('move')}"), 'they share the old Discount bill spot, so the popup keeps its layout');
ok(/freeOpen && order && \([\s\S]{0,400}<FreeBillPanel startOpen/.test(table) && table.includes('setFreeOpen(true)'), 'Free opens the Free panel straight away');
ok(!/free=\{discountTarget/.test(table), 'Free is not repeated inside the Discount box');
ok(/!clear && !reason\.trim\(\)/.test(dialog) && dialog.includes("'Add the reason for this discount'"), 'a discount cannot be applied without a reason');
ok(!dialog.includes('Reason (optional)'), 'the reason box no longer says optional');
ok(/discount_reason: input\.value > 0 \? input\.reason/.test(table.slice(table.indexOf('/items/${discountTarget.item.id}/discount'))), 'item discounts send their reason too');
ok(panel.indexOf("api.post('/bills/generate'") > panel.indexOf('/comp`') && panel.indexOf("api.post('/bills/generate'") < panel.indexOf('await closeFree('), 'Free makes the bill before closing it (the table popup has none yet)');
ok(panel.includes('if (zero && !startOpen) return null;') && panel.includes("'Close bill'"), 'an already-$0 table can be closed with Free');
ok(/action: 'item_discount_applied', details: \{[^}]*discount_reason/.test(orders), 'the item discount reason is saved in the order history');

const payDisc = pay.indexOf("style={toneStyle('discount')}");
ok(payDisc > 0 && pay.indexOf("style={toneStyle('free')}") > payDisc && pay.indexOf("style={toneStyle('free')}") - payDisc < 900, 'the payment screen shows Discount and Free side by side, same colours as the table popup');
ok(/const canFreeHere = !bill\.split_group_id && !\(Number\(bill\.paid_amount\) > 0\) && !\(Number\(bill\.discount_amount\) > 0\)/.test(pay), 'Free shows on the payment screen only while nothing is paid and no discount is on');
ok(/showFree && !bill\.split_group_id && \(\s*<FreeBillPanel startOpen/.test(pay), 'Free on the payment screen opens the Free panel straight away');

// The browser must not fill a saved login into the note / PIN boxes, and both boxes are labelled.
ok(panel.includes('>Manager PIN</span>'), 'Free panel: the PIN box has a visible label');
ok(dialog.includes('Manager PIN (approves this)'), 'Discount box: the PIN box has a visible label');
for (const [name, src] of [['Free panel', panel], ['Discount box', dialog]] as const) {
  ok(!/type="password"/.test(src) && src.includes('autoComplete="one-time-code"') && src.includes("WebkitTextSecurity: 'disc'"), `${name}: the PIN box shows dots but is not a password field, so no saved login is filled in`);
}
// Chrome ignores autoComplete="off" and put the saved login email into a text box next to the PIN.
// So the only text box beside the PIN is a textarea (never filled with logins).
ok(!/<input type="text" name="free-note"/.test(panel) && /reason === 'other' && \(\s*<label[\s\S]{0,200}<textarea name="free-why"/.test(panel), 'Free panel: no note box next to the PIN; only Other asks why, in a box Chrome never fills');
ok(/const why = reason === 'other' \? note\.trim\(\) : ''/.test(panel), 'Free panel: words are only sent for Other');
ok(/<textarea name="discount-reason" autoComplete="off"/.test(dialog), 'Discount box: the reason box is never filled with a saved login');
ok(panel.includes("'Pick why'") && panel.includes("'Type PIN'"), 'Free panel: the button says what is still missing');
const reasons = panel.slice(panel.indexOf('const COMP_REASONS'), panel.indexOf('];', panel.indexOf('const COMP_REASONS')));
ok(['Artist', 'Event', 'Owner', 'Complaint', 'Other'].every((w) => reasons.includes(`'${w}'`)) && (reasons.match(/\['/g) || []).length === 5, 'Free panel: five short reasons (Artist, Event, Owner, Complaint, Other)');
const serverReasons = read('main/services/item-approvals.ts');
ok(['entertainer', 'event', 'owner_comp', 'complaint', 'other'].every((k) => reasons.includes(`['${k}'`) && serverReasons.includes(`'${k}'`)), 'Free panel: each reason is one the server accepts');

console.log(`table-discount-free: ${passed} passed`);
