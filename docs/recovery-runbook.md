# Synthetic Recovery Exercise Runbook

## Authorization And Preconditions

This runbook is for disposable local/CI test databases only. Set the existing
test PostgreSQL and Redis environment variables through an approved secret
mechanism. Never put a database URL on a command line, in evidence or in this
document. The PostgreSQL account must be able to create and drop temporary
databases.

The command accepts only loopback PostgreSQL with a test-classified base
database. Generated source and target names must respectively begin
`keycore_recovery_source_` and `keycore_recovery_restore_`. Source and target
must differ. Production, missing or ambiguous classifications fail closed.

## Procedure

1. Confirm the environment is isolated and contains synthetic data only.
2. Run `npm run recovery:exercise`.
3. Confirm native backup and restore completed and migration 027 was queried in
   the restored target.
4. Confirm all REC scenarios and post-restore invariant counts passed.
5. Confirm Redis was emptied and rebuilt without changing PostgreSQL truth or
   paused Operations Controls.
6. Inspect only the omission-first evidence artifact; never retain or upload the
   raw dump.
7. Confirm temporary source/target databases and files were deleted.

## Failure Handling

Stop immediately on manifest mismatch, corrupted backup, unsafe target,
restore/tool failure, migration mismatch, invariant failure, ownership change,
lost control, duplicate effect or unsafe evidence. Do not retry procurement,
refund or delivery blindly. Preserve safe reason codes, keep commercial effects
paused and require authorized reconciliation.

Errors intentionally omit tool stderr because it may contain connection
details. Investigate through CI's safe step status and ephemeral service logs.
Never paste dump content or connection credentials into a ticket.

## Production Boundary

This procedure is not production restore authorization. Production backup
storage, retention, scheduling, KMS material, RTO/RPO, infrastructure failover,
provider reconciliation, escalation and operator authority require Phase-12
design and human approval.
