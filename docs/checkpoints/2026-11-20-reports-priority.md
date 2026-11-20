# BackStreet Riverside POS — Project Checkpoint

**Date:** 20 November 2026  
**Status:** Scheduling work preserved; pause feature expansion and prioritize operational reports and receipt-printer output.  
**Repository:** https://github.com/iamaseth/smalltownos-pos

## Current project state

- Existing production Railway project and service remain the only deployment target.
- Do not create another Railway project, duplicate app, or staging service.
- Production remains on its existing deployment branch. Do not merge or deploy scheduling without explicit approval.
- The employee scheduling implementation is preserved on `feature/backstreet-employee-scheduling`.
- Latest known scheduling commit: `3b5f59ef9c6617c2675c562b13c1f2cc5a8f4b30`.
- The scheduling branch is two commits ahead of `deploy/backstreet-v100` and includes the scheduling page, routes, schema version 106 work, and tests.
- Scheduling was built and tested against a copy of production data according to the handover from Claude. It has not been deployed to production.
- Cash-management handover changes are also present in the scheduling branch; review branch contents before any future merge.

## Immediate priority: Cashier reports and receipt printing

The POS can currently send sales information to Telegram, but the cashier also needs useful reports printed directly on the receipt printer.

Do not treat Telegram reporting as a substitute for on-site printed reports.

### Required report capabilities

1. **Shift sales report**
   - Shift date and time range.
   - Cashier/staff member and register.
   - Gross sales, discounts, refunds, voids and net sales.
   - Number of orders/bills.
   - Average bill value.
   - Sales by category and, where useful, product.
   - Open/unpaid tickets and outstanding balances.

2. **Table activity / visual summary**
   - A clear visual or compact count of tables by status: occupied/open, bill requested, unpaid, and available.
   - Number of tables served during the shift.
   - Tables still open at shift end.
   - Do not confuse table count with order count; one table may have multiple bills/orders.

3. **Payment breakdown**
   - Cash.
   - QR payments, with provider/method identified where available (for example ABA QR and ACLEDA QR).
   - Card payments, with card type/provider or merchant/terminal breakdown where the POS records it.
   - Other configured payment methods shown separately.
   - Totals by method and a grand total.
   - Refunds and payment reversals shown separately.
   - Do not group QR or card transactions into cash.

4. **Cash reconciliation**
   - Opening float.
   - Expected cash.
   - Actual cash counted.
   - Cash pay-ins/pay-outs and refunds.
   - USD and KHR totals and variances separately.
   - Combined USD equivalent using the recorded exchange rate.
   - Cash retained in drawer and amount placed in envelope, when that workflow is available.

5. **Receipt-printer output**
   - Cashier must be able to print the shift report on the receipt printer.
   - Support a concise, readable thermal-printer layout.
   - Include report title, business, shift/date, cashier, sales summary, table activity, payment breakdown, and cash reconciliation.
   - Include QR and card method/provider details when recorded.
   - Provide a reprint action with a clear indication that it is a report reprint, not a new sale receipt.
   - Keep Telegram report delivery as a separate channel.
   - Use the shared print engine so the same report can print through Chrome during staging and through the offline/native adapter later.

### Before coding

1. Inspect the existing reports currently available in the POS.
2. Inspect current receipt-printer and print-engine implementation.
3. Identify which report fields are already stored and which are not.
4. Confirm payment method IDs/names and how QR, card and merchant/provider details are represented in real transactions.
5. Confirm table statuses and how table activity is represented.
6. Reconcile report totals against actual orders, bills and payment records.
7. Produce sample on-screen and thermal receipt report layouts for review before implementation.
8. Do not invent payment/provider details that are not stored. Flag missing data for discussion.
9. Do not change production data or deploy until explicitly approved.

Reports and reliable printer output are the immediate priority over further scheduling work.

## Scheduling checkpoint — resume later

The scheduling work already implemented includes:
- By-shift and by-person views.
- Day, week and month views.
- Staff bar with drag or tap-to-place.
- Dragging shifts between days, rows and staff.
- Copy last week for everyone or an individual.
- Publish week.
- Editable shift times and weekly work-day targets.
- Double-booking prevention.
- Change history.
- Owner/manager access only for the initial planning version.
- Database version 106 changes and automated tests.

Outstanding decisions before scheduling release:
- Whether staff can view their own published shifts.
- How to support staff who do not need POS login credentials.
- Coordinate schema version 106 with the ongoing iB4 historical import process.
- Review and test the branch before merging into the existing deployment branch.

## Operational guardrails

- No new Railway projects or duplicate apps.
- No production deployment without Seth's explicit approval.
- No changes to historical sales, menu, products, payment configuration, or inventory while investigating reports.
- Keep the scheduling branch intact.
- Keep the existing production deployment branch stable.
- Do not break existing Telegram sales reports.
- Printer work must be tested without disrupting production sales or data.

## Next action

Audit the existing cashier reports, payment records, table activity and printer implementation. Return findings and sample report layouts before making changes.
