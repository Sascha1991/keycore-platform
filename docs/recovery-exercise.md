# KS-11-06 Recovery Exercise

## Scope

`npm run recovery:exercise` validates REC-001 through REC-018 against real
ephemeral PostgreSQL and Redis services. It creates distinct disposable source
and restore databases, applies migration 027, seeds representative synthetic
commerce state, creates a native custom-format backup, restores it into the
empty target, queries the restored schema and continues application work only
against the target.

The exercise uses no production data, provider call, WooCommerce mutation,
customer email or Product Key plaintext. Encrypted fulfillment bytes are
synthetic opaque fixtures. PostgreSQL remains durable authority and Redis is
flushed and rebuilt without losing or authorizing business state.

## Scenario Map

| Scenario | Recovery proof                                                         |
| -------- | ---------------------------------------------------------------------- |
| REC-001  | Non-empty custom backup, SHA-256, manifest and tool metadata           |
| REC-002  | Restore into a new independently reachable database                    |
| REC-003  | Migration 027, required tables, indexes and triggers queried in target |
| REC-004  | Orders, payments, PriceLocks, history and versions preserved           |
| REC-005  | Dispatched outbox stays dispatched; pending work resumes once          |
| REC-006  | Successful and ambiguous procurement identities preserved              |
| REC-007  | Ambiguous dispatch reconciles without retry or fallback purchase       |
| REC-008  | Encrypted fulfillment relationship restored without plaintext          |
| REC-009  | Ownership and consumed delivery capability remain stable               |
| REC-010  | Active guest claim resumes once; consumed claim cannot replay          |
| REC-011  | Completed refund state remains terminal and unique                     |
| REC-012  | ALLOW, REVIEW and DENY risk evidence remains intact                    |
| REC-013  | Support visibility and supplier-claim history remain linked            |
| REC-014  | Six durable emergency controls remain paused                           |
| REC-015  | Empty Redis cannot erase state or bypass controls                      |
| REC-016  | Truncated backup copy fails digest validation before restore           |
| REC-017  | Production, missing, ambiguous, same and unsafe targets are rejected   |
| REC-018  | Repository reads restored order and creates a new independent order    |

## Post-Restore Audit

The target database is audited for orphan orders, payments, procurement,
fulfillment and ownership; duplicate PriceLock consumption, provider events,
procurement identities, leases, fulfillment, guest claims and refunds; terminal
regression; broken outbox/history references; plaintext-key columns; and lost
emergency controls. Every count must be zero.

Refund recovery maps to authoritative `keycore_orders.refund_status` and
payment/order identity because this repository has no separate modern refund
operation table. Ownership reassignment is proven by the restored database
trigger rejecting a cross-customer update.

## Evidence And Limits

Evidence under `artifacts/recovery-exercise/` contains only classifications,
fingerprints, checksums, byte counts, aggregate row/invariant counts, safe reason
codes and durations. The raw dump, credentials, database URL, ciphertext,
tokens and Product Keys are excluded. Temporary databases and files are removed
in `finally` cleanup.

The measured runtime is `MEASURED_CI_EXERCISE_TIME`, not a production target.
`PRODUCTION_RTO_TARGET` and `PRODUCTION_RPO_TARGET` remain
`NOT_YET_APPROVED`. Database recovery is validated; production KMS, backup
storage/scheduling/retention, restore authorization, infrastructure failover,
observability, provider reconciliation and WooCommerce recovery remain Phase 12.
