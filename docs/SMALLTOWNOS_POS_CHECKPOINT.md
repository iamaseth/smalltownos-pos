# SmalltownOS POS — Project Foundation

## Status
Active development foundation established from the FloCafe fork.

## Repository
https://github.com/iamaseth/smalltownos-pos

## Upstream foundation
FloCafe
https://github.com/FreeOpenSourcePOS/FloCafe

FloCafe remains the operational POS foundation. Preserve its MIT license and attribution.

## Product direction
SmalltownOS POS is a modern, offline-first POS for bars, cafes, restaurants, and hybrid venues.

The first priority is not accounting or back-office configuration. The first priority is extremely fast service during busy periods using one main register and multiple staff phones.

## First operational target
1 bar + 1 main register + 2 server phones.

Required behavior:
1. Server opens phone interface and enters PIN.
2. Server creates or opens a tab/table/order.
3. Server adds items using large, fast product buttons.
4. Server sends the order with minimal taps.
5. Main register sees the order immediately over the local network.
6. A second server phone can open the same active tab/order and add more items.
7. Kitchen/bar tickets are generated where applicable.
8. Cash is finalized at the main register.
9. Authorized staff may finalize confirmed electronic/KHQR payment on phone later.
10. Internet can be disconnected and local ordering must continue over Wi-Fi/LAN.
11. Reconnection must sync without duplicate sales.

## Fast phone UX
Target interaction:
PIN -> Open Orders / Tables -> select order -> tap products -> Send.

Design principles:
- phone-first
- very large touch targets
- favorites/recent items near the top
- category switching without deep navigation
- current order always visible
- common drink in roughly 2–3 taps
- no repeated table/order selection
- no unnecessary confirmation screens
- multiple phones share the same live order state
- each order/item retains staff attribution

## FloCafe capabilities to preserve and reuse
- local SQLite database
- local HTTP/WebSocket services
- server/waiter application
- table and held-order workflows
- modifiers/add-ons
- KDS
- printing
- staff permissions/PINs
- offline-first local operation
- payment and order infrastructure
- existing tests, including phone-oriented behavior

## Architecture boundary
SmalltownOS POS owns operational POS state:
- open orders
- checks/tabs/tables
- line items and modifiers
- payment attempts
- tender/register/device/staff attribution
- receipts
- refunds and void requests
- local/offline state
- finalized sale events

Emerald Ledger remains the accounting system of record:
- general ledger
- financial statements
- AP
- cash/bank/KHQR clearing
- accounting-side inventory/COGS
- reconciliation
- periods
- audit trail

Do not move accounting complexity into the ordering interface.

## Event integration direction
POS finalized transactions will later emit durable, idempotent events toward SmalltownOS / Emerald Ledger.

Initial event families:
- sale.finalized
- payment.captured
- payment.refunded
- sale.voided
- inventory.demand_recorded
- register.cash_movement_recorded

## Offline sync rule
The main register/local service is the local authority during outages.

Phones/KDS -> local Wi-Fi -> main register/local service -> durable local store/outbox -> cloud when internet returns.

Only acknowledged events are considered synchronized. Stable IDs and idempotency keys are required to prevent duplicate accounting entries.

## Deferred until core flow works
- voice ordering
- deeper KHQR integration
- Khmer localization enhancements
- SmalltownOS universal-login integration
- Emerald Ledger event posting
- advanced multi-location/cloud features

## Resume command
$continue dev smalltownOS POS

When resuming, start from this repository and this checkpoint. Do not return to the old generated `my-pos-system` POS as the implementation foundation.
