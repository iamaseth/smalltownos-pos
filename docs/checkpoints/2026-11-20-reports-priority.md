# BackStreet Riverside POS — Project Checkpoint

**Date:** 20 November 2026  
**Status:** Scheduling work preserved; pause feature expansion and prioritize reports.  
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

## Immediate priority: Reports

Pause further scheduling implementation and focus on the BackStreet reporting requirements.

Before coding reports:
1. Inspect the existing reports currently available in the POS.
2. Identify which reports are missing, inaccurate, difficult to use, or not reconciling.
3. Review the underlying sales, payment, cash drawer, shift, purchase, refund, void, discount, and inventory data structures.
4. Confirm report totals against actual database records and existing closing reports.
5. Prepare a prioritized report specification and examples for owner/manager use.
6. Do not change production data or deploy until explicitly approved.

Reports should be treated as a priority over adding new features. Preserve the current production POS and its data while investigating.

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
- Printer work is a separate immediate workstream; investigate the current printer connection issue without disrupting report work or production data.

## Next action

Start by auditing the existing BackStreet POS reports and identifying the highest-priority gaps. Return findings and a proposed report plan before making changes.
