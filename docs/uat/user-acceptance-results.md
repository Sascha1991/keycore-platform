# KS-11-07 User Acceptance Results

## Current State

- Preparation: complete.
- Human review: `IN_REVIEW`; scoped visible-storefront review completed on
  2026-08-30.
- Human approval: `NOT_APPROVED`.
- `SECURITY-READINESS`: `NOT_APPROVED`.
- Human `PASS` results: five (`UAT-001`, `UAT-002`, `UAT-006`, `UAT-015`, `UAT-018`).
- Phase 11: incomplete.

The machine-readable source is
`artifacts/user-acceptance/uat-results.json`. The visible storefront remediation
makes UAT-001, UAT-006 and UAT-015 executable and several related journeys
partially executable. The product owner accepted UAT-001 and UAT-006 on
2026-08-30 using only synthetic staging data. The product owner completed and
accepted UAT-002 on 2026-08-31. The product owner confirmed UAT-018 `PASS` on
2026-09-01 after the secure invoice correction. The product owner confirmed
UAT-015 `PASS` on 2026-09-02. Unchanged browser gaps remain
`NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY`. Readiness is not acceptance.

## Allowed Results

| Status                                  | Meaning                                                         |
| --------------------------------------- | --------------------------------------------------------------- |
| `PENDING`                               | Executable but not yet reviewed                                 |
| `PASS`                                  | Human reviewer executed and accepted the scenario               |
| `FAIL`                                  | Human reviewer executed and observed unacceptable behavior      |
| `BLOCKED`                               | Execution started or was planned but a concrete blocker remains |
| `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Required user-facing surface does not currently exist           |

Every human result requires a real reviewer, UTC `reviewedAt`, notes and safe
evidence references. A human may edit results only after executing the scenario.
Automated evidence cannot become `PASS`.

`npm run uat:validate` accepts legitimate future human results while enforcing
the lifecycle:

- `PASS` requires `EXECUTABLE_NOW`, reviewer, valid UTC `reviewedAt`, non-empty
  safe evidence and no stale blocking reason/dependency;
- `FAIL` requires an executable or partially executable scenario, reviewer,
  valid UTC `reviewedAt`, explanatory notes and safe evidence;
- `BLOCKED` requires reviewer, valid UTC `reviewedAt`, explanatory notes, reason
  and target dependency;
- `PENDING` and `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` contain no human reviewer
  or review time; and
- result and readiness scenario IDs/statuses must agree.

The checked-in package is `IN_REVIEW`. Its five scoped `PASS` results identify
the product-owner role and date-normalized UTC timestamps. Safe textual records
are stored in `docs/uat/human-uat-2026-08-30.md` and
`docs/uat/open-scenario-reconciliation-2026-08-31.md`; the later UAT-018 and
UAT-015 results are recorded in `docs/uat/human-uat-2026-09-01-invoice.md` and
`docs/uat/human-uat-2026-09-02-account-history.md`. No overall approval is
recorded.

## Acceptance Record

The product owner must explicitly update
`artifacts/user-acceptance/human-approval.json` after reviewing all applicable
results. PR merge, green CI, repository ownership and prior technical evidence
are not approval. A separate approval under `docs/approvals/` is required for
`SECURITY-READINESS`.

An `APPROVED` UAT artifact is structurally valid only when all 18 scenarios,
including UAT-018, are human `PASS` results with safe evidence and the readiness
state is also `APPROVED`. `SECURITY-READINESS` may remain `NOT_APPROVED` because
it is a separate gate. The validator provides consistency checks, not proof of
human identity; ROLE-UAT-05 and Git/PR review provide that authority boundary.
The current scoped acceptance does not satisfy these complete-approval rules.

## Open Scenario Reconciliation

The 2026-08-31 review in
`docs/uat/open-scenario-reconciliation-2026-08-31.md` maps every required step
for UAT-002, UAT-015 and UAT-018 to human evidence, automated evidence and any
remaining browser gate as known on that date. UAT-002 is `PASS`; UAT-015 remains
and UAT-018 are now `PASS`. Their historical pending assessments are superseded
only by the product owner's separately recorded 2026-09-01 and 2026-09-02 human
results; other scenarios and approval gates remain unchanged.
