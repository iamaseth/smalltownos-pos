/**
 * Source-level guards for the UI regressions fixed by issues #621, #623, and #626.
 * Behavioral table update coverage lives in tables-string-ids.test.ts; these checks
 * keep the responsive layout and dark-mode utilities from being accidentally removed.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const tables = source('frontend/src/app/(dashboard)/tables/page.tsx');
assert.match(tables, /tenantCan\(currentTenant, 'tables\.manage'\)/, 'table management controls stay permission-gated');
assert.match(tables, /api\.put\(`\/tables\/\$\{editingTable\.id\}`/, 'table editor persists through PUT');
assert.match(tables, /TABLE_NAME_DUPLICATE: tTables\('tableNameDuplicate'\)/, 'backend table errors map to localized UI messages');
assert.match(tables, /TABLE_LOCATION_INVALID: tTables\('tableLocationInvalid'\)/, 'backend location errors map to localized UI messages');
assert.match(tables, /Number\.isInteger\(capacity\).*capacity < 1/s, 'table capacity is validated before submission');
assert.match(tables, /tTables\('allFloors'\)/, 'floor filter retains its all-floors option');
assert.match(tables, /\[table\.floor, table\.section\]/, 'floor and section remain visible together');

const whatsapp = source('frontend/src/components/settings/WhatsAppEnableCard.tsx');
assert.match(whatsapp, /font-semibold text-foreground/, 'WhatsApp enable heading uses theme foreground');

const settings = source('frontend/src/app/(dashboard)/settings/page.tsx');
assert.match(settings, /dark:bg-yellow-950\/50 dark:border-yellow-800/, 'update warning has a dark-mode surface');
assert.match(settings, /text-yellow-700 dark:text-yellow-300/, 'update warning copy has dark-mode contrast');
assert.match(settings, /text-red-600 dark:text-red-300/, 'update failure copy has dark-mode contrast');

const kds = source('frontend/src/hooks/useKdsConnection.ts');
assert.match(kds, /bg-yellow-50 dark:bg-yellow-950\/60/, 'waiting KDS cards use a dark-mode background');
assert.match(kds, /text-yellow-700 dark:text-yellow-300/, 'waiting KDS labels use dark-mode text');

const customers = source('frontend/src/app/(dashboard)/customers/page.tsx');
assert.match(customers, /text-muted-foreground whitespace-nowrap.*formatDate/, 'ledger dates use semantic text color');
assert.match(customers, /text-end text-foreground whitespace-nowrap.*fmt\(b\.total\)/, 'ledger totals use semantic text color');

const payment = source('frontend/src/components/pos/PaymentModal.tsx');
assert.match(payment, /sm:max-w-6xl/, 'desktop payment modal stays wide enough for the BackStreet cash keypad');
assert.match(payment, /lg:grid lg:grid-cols-\[minmax\(0,1fr\)_320px\]/, 'desktop payment content stays side by side with the keypad column');
assert.match(payment, /max-h-\[75vh\] overflow-y-auto.*lg:grid lg:grid-cols-\[minmax\(0,1fr\)_320px\]/, 'desktop payment stays two-column with bounded overflow fallback');
assert.match(payment, /data-testid="payment-total-due"/, 'total due sits in the compact payment header');
assert.match(payment, /aria-label="Payment type"/, 'cash, ABA and card are chosen from one payment-type row');
assert.match(payment, /ABA_SETUP_TENDER/, 'ABA stays visible at checkout even before ABA (Manual) is enabled');
assert.match(payment, /aria-label=\{`Add \$\{unit\} note`\}/, 'each cash currency has its own note buttons');
assert.ok(payment.indexOf('aria-label="Payment type"') < payment.indexOf("setShowDiscount((open) => !open)"), 'discount is a secondary action below the payment controls');
assert.doesNotMatch(payment, /lg:overflow-visible/, 'desktop payment does not clip controls outside its bounded container');

const posPage = source('frontend/src/app/(dashboard)/pos/page.tsx');
const payNowBody = posPage.slice(posPage.indexOf('const handlePayNow'), posPage.indexOf('const handlePlaceOrder'));
assert.match(payNowBody, /placeOrder\(true\)/, 'cart Pay sends the order and then opens the redesigned payment screen');
assert.doesNotMatch(payNowBody, /setShowPrepaidCheckout/, 'postpaid cart Pay does not open the old prepaid checkout');
assert.match(posPage, /thenPay && createdOrder[\s\S]*?\/bills\/generate[\s\S]*?setPaymentBill/, 'Pay generates the bill for the order it just created');
assert.match(posPage, /if \(destinationMissing\(\)\) \{\s*promptForDestination\(\);/, 'Send and Pay without a destination open the destination chooser');
assert.match(posPage, /data-testid="destination-choice"/, 'the Table / Tab / To Go chooser exists');
assert.match(posPage, /Select a table, tab or To Go to continue\./, 'the chooser explains why it opened');

const dashboard = source('frontend/src/app/(dashboard)/dashboard/page.tsx');
assert.match(dashboard, /dayInputRef.*monthInputRef/s, 'dashboard retains explicit date and month picker controls');
assert.match(dashboard, /input\.showPicker\(\)/, 'dashboard calendar buttons invoke the native Chromium picker');
assert.match(dashboard, /aria-label=\{t\('openDatePicker'\)\}/, 'dashboard date picker trigger stays accessible');

const prepaidCheckout = source('frontend/src/components/pos/PrepaidCheckoutModal.tsx');
assert.doesNotMatch(prepaidCheckout, /bg-gradient-to-br from-slate-800 to-slate-900/, 'prepaid checkout does not restore the oversized total card');
assert.match(prepaidCheckout, /preview\.discountedSubtotal/, 'prepaid checkout shows the post-discount subtotal');
assert.match(prepaidCheckout, /t\('discounts'\)/, 'prepaid checkout retains the compact cart-level discounts control');
const numberPadIndex = prepaidCheckout.indexOf('<CurrencyTouchNumberPad');
const changeReturnedIndex = prepaidCheckout.indexOf("t('changeReturned')");
assert.ok(
  numberPadIndex >= 0 && changeReturnedIndex > numberPadIndex,
  'change returned stays below the payment controls',
);

console.log('✓ UI regression guards for issues #621, #623, #625, and #626 passed');
