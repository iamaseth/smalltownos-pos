# The Bay Bar — Staff PIN and busy-service register access

Status: approved design; implementation pending. Do not enable a cosmetic client-only PIN gate as security.

## Workflow
- Register begins locked. A valid unique four-digit employee PIN unlocks it.
- Busy service: staff switch active operator by tapping their own name. Do not require a PIN for each sale. This is an attribution convenience, **not verified identity**.
- Lock after five minutes of no user interaction. Locking does not end the cash shift, clear carts, close tables, or cancel payments.
- Any authorized employee can unlock with their own PIN.
- Manager-only actions (refunds, overrides, staff management, settings) require verified manager authorization, not merely selecting a manager name.
- One shared open drawer/shift, with individual operator attribution and audit events.

## Initial roles
- Chhay Ouy: owner/manager.
- Seth Shapiro: developer/system administrator.
- Do not commit PINs or seed fixed PIN values. Enroll/change PIN privately in the app.

## Backend requirements
1. Add tenant-scoped staff identity, roles, PIN credential hash (slow password hash with unique salt), active/disabled status, and failed-attempt cooldown/rate limit. Four digits have only 10,000 combinations.
2. Expose PIN verification/unlock and manager reauthorization APIs. Keep existing email/password admin authentication functional during migration.
3. Issue server-validated operator context for protected actions; client-side selection alone must never authorize privileges. Capture verified operator on sale, void, refund, discount and cash events.
4. Never persist raw PIN in logs, browser storage, order payloads, or analytics.
5. Lock on startup, explicit lock, and five minutes of inactivity. Handle reload, sleep/wake, expired sessions, and network failures safely.
6. Separate lock state from shift state and cart/table state.

## Acceptance tests (Demo Mode first)
- PIN unlock, wrong PIN cooldown, disabled employee, manager-only action.
- Two staff alternate on the same register without losing open tables, pending carts, or shared shift.
- Inactivity locks after 5 minutes; continued activity postpones lock.
- Lock during pending checkout does not duplicate charges or drop retry/idempotency state.
- Staff selection without PIN cannot grant manager privileges.
- Existing email/password login, data, historical orders and reports remain intact.

Do not roll out to live sales until backend authorization and end-to-end tests pass.
