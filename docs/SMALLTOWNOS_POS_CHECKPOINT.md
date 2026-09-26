# SmalltownOS POS — Durable Project Checkpoint

## Status
Active.

## Critical architecture decision

There are TWO codebases with different roles.

### 1. Actual SmalltownOS POS application
Lovable project:
https://lovable.dev/projects/d80fe793-ea84-405a-800a-aba630890128

This existing Lovable POS is the application Seth will see, test, and develop interactively.

Development workflow:
Seth tests visually in Lovable -> changes are made to the SmalltownOS POS -> Seth tests again.

Do NOT abandon this Lovable project merely because FloCafe cannot be imported directly into Lovable.

### 2. FloCafe reference / source library
GitHub fork:
https://github.com/iamaseth/smalltownos-pos

Upstream:
https://github.com/FreeOpenSourcePOS/FloCafe

This repository preserves the complete FloCafe open-source code so its proven POS architecture and implementations can be studied and selectively adapted into the actual SmalltownOS POS.

FloCafe is NOT the user-facing SmalltownOS application and does not need to be forced into Lovable.

Preserve FloCafe's MIT license and attribution when reusing applicable code.

## What to reuse/adapt from FloCafe
Use FloCafe as the blueprint/parts library for:
- local/offline POS operation
- multiple server/waiter devices
- shared/open orders and tabs
- tables
- staff/PIN/permissions
- modifiers/add-ons
- KDS
- printing
- payment workflows
- WebSocket/local-network synchronization
- held orders
- phone-oriented workflows
- inventory/recipe concepts where useful

Do not copy UI blindly. SmalltownOS should have its own simpler, modern, phone-first interface.

## First SmalltownOS POS priority
Make order entry extremely fast and easy during busy service.

Initial proof:
1 bar + 1 main register + 2 server phones.

Target server flow:
PIN -> Open Orders / Tables -> select or create order -> tap products -> Send.

Requirements:
- large touch targets
- favorites/recent items
- quick category switching
- current order always visible
- common drink in roughly 2–3 taps
- no repeated order/table selection
- no unnecessary confirmation screens
- multiple phones share the same live order
- staff attribution retained
- register sees changes quickly
- cash finalized at main register
- authorized electronic/KHQR closing later after confirmed payment

## Accounting boundary
SmalltownOS POS owns operational POS state.

Emerald Ledger remains the accounting system of record for:
- general ledger
- statements
- AP
- cash/bank/KHQR clearing
- accounting-side inventory/COGS
- reconciliation
- periods
- audit

Do not burden the ordering UI with accounting complexity.

## Later integration direction
Verified/finalized POS transactions should eventually emit durable idempotent events toward SmalltownOS/Emerald Ledger.

Initial event families:
- sale.finalized
- payment.captured
- payment.refunded
- sale.voided
- inventory.demand_recorded
- register.cash_movement_recorded

## Deferred until core ordering works
- Voice Capture ordering
- deeper KHQR integration
- Khmer localization enhancements
- SmalltownOS universal login
- Emerald Ledger event posting
- advanced multi-location/cloud features

## Important history
An earlier checkpoint incorrectly described the FloCafe fork as the implementation foundation itself. The decision was clarified on 2026-09-26: the existing visible Lovable POS is the actual SmalltownOS POS application; FloCafe is the open-source reference/source library used to accelerate and strengthen it.

## Resume command
$continue dev smalltownOS POS

On resume:
1. Restore the existing Lovable POS project above.
2. Use this FloCafe fork as the reference/source library.
3. Continue the fast multi-phone server/waiter workflow.
4. Do not require Seth to import FloCafe into Lovable.
