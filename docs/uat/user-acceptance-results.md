# KS-11-07 User Acceptance Results

## Current State

- Preparation: complete in this change.
- Human review: pending.
- Human approval: `NOT_APPROVED`.
- `SECURITY-READINESS`: `NOT_APPROVED`.
- Human `PASS` results: zero.
- Phase 11: incomplete.

The machine-readable source is
`artifacts/user-acceptance/uat-results.json`. All 18 scenarios are initially
`NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` because the repository has no composed
KeyCore browser surface. This classification is a blocker report, not a test
failure and not acceptance.

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
Automated evidence cannot become `PASS`. `npm run uat:validate` rejects any
initial fabricated reviewer, timestamp or pass.

## Acceptance Record

The product owner must explicitly update
`artifacts/user-acceptance/human-approval.json` after reviewing all applicable
results. PR merge, green CI, repository ownership and prior technical evidence
are not approval. A separate approval under `docs/approvals/` is required for
`SECURITY-READINESS`.
