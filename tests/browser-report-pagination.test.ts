import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { paginateReportLines } from '../frontend/src/lib/printer/frame-print';

const lines = [
  'Z-REPORT #12', 'Cashier                 Thida', 'SALES', 'Gross sales            $50.00',
  'Net sales              $50.00', '', 'PAYMENTS', 'Cash        2           $50.00',
  'CASH', 'Expected USD             $50.00', 'Counted USD              $50.00', 'End',
];
const pages = paginateReportLines(lines, 7);
assert.equal(pages.length, 2, 'long reports split into whole-line pages');
assert.deepEqual(pages.flat(), lines, 'pagination neither drops nor duplicates report lines');
assert.equal(pages[1][0], 'PAYMENTS', 'pagination prefers a section heading over a mid-section split');

const short = paginateReportLines(lines.slice(0, 4), 7);
assert.deepEqual(short, [lines.slice(0, 4)], 'short reports remain one page');

const source = fs.readFileSync(path.resolve('frontend/src/lib/printer/frame-print.ts'), 'utf8');
assert.match(source, /getBoundingClientRect\(\)\.height/, 'page capacity uses rendered measurements');
assert.match(source, /pageLength - 8/, 'fixed pages reserve eight millimetres for page furniture');
assert.match(source, /padding: 1mm 0/, 'each fixed page keeps its header and footer clear of the cutter edge');
assert.ok(source.includes('margin: 0 !important; padding: 0 !important; display: block !important;'), 'fixed pages remove margin, padding, and flex centering');
assert.match(source, /break-after: page/, 'receipt report pages force physical page breaks');

const reportPrint = fs.readFileSync(path.resolve('frontend/src/lib/printer/shift-report-print.ts'), 'utf8');
assert.match(reportPrint, /transport === 'webusb'/, 'WebUSB remains a separate raw-text path');
assert.match(reportPrint, /receiptPageLengthMm/, 'browser reports use the configured fixed page length');

console.log('✓ browser report pagination guards passed');
