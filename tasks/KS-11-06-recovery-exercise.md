# KS-11-06 - Recovery Exercise

## Objective

Validate repository-level recovery through a native PostgreSQL backup and
restore into a clean isolated database, followed by invariant, Redis-loss and
application-continuity checks using synthetic data only.

## Acceptance Criteria

- `npm run recovery:exercise` covers REC-001 through REC-018.
- Source and target are distinct disposable databases; unsafe identities fail.
- A real custom-format `pg_dump` and `pg_restore` execute in CI.
- The current migration baseline 028 and required structures are queried in the restored target.
- Restored repositories preserve commercial, ownership, ambiguity, encrypted
  fulfillment, guest-claim, fraud, support, control and outbox invariants.
- Empty Redis does not erase authority or enable a paused operation.
- A corrupted backup is rejected before restore.
- A new order is created against the restored database without changing prior
  records or duplicating identities.
- Evidence excludes the raw dump, secrets, tokens, Product Keys and database
  URLs and is retained for 14 days.
- KS-11-07 and `SECURITY-READINESS` remain untouched.

## Delivery

Open one PR named `KS-11-06: Add recovery exercise and restore validation` and
do not merge it. The recovery exercise now validates migration baseline 028.
