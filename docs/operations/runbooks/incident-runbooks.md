# Incident Runbooks

All diagnostics use aggregate state and safe references only. Never expose
Product Keys, ciphertext, credentials, provider payloads, customer messages or
PII. Durable operations controls require trusted authority; agents cannot
self-approve `SECURITY-READINESS`.

## RB-SUPPLIER-OUTAGE

Alert: `PROCUREMENT_BACKLOG_HIGH`, `PROCUREMENT_AMBIGUITY_HIGH` or
`SUPPLIER_OUTAGE`. Pause `PROCUREMENT_CREATE` and, if retrieval is affected,
`SUPPLIER_KEY_RETRIEVAL`. Inspect aggregate health and durable operation states.
Do not retry an ambiguous purchase, switch supplier or mark success/failure by
assumption. Reconcile already-dispatched orders read-only, verify backlog and
provider recovery, then resume with trusted approval and optimistic version.

## RB-ORDER-STUCK

Alert: `PAID_ORDER_STUCK`. Inspect payment, fraud, procurement, fulfillment and
reconciliation states by safe internal reference. Do not fabricate capture,
approval or fulfillment. Pause new procurement if the cause risks duplicate
purchases. Recover the failed dependency, replay only idempotent queued work and
verify the order progresses or enters manual review.

## RB-KEY-RETRIEVAL

Alert: `FULFILLMENT_PENDING_TOO_LONG`. Pause
`SUPPLIER_KEY_RETRIEVAL`; optionally pause `CUSTOMER_KEY_DELIVERY` for suspected
key compromise. Inspect metadata only. Never dump/decrypt all keys or retrieve
again after an ambiguous response. Preserve audit evidence, reconcile supplier
state, rotate affected credentials externally where approved, and verify
encrypted state before resume.

## RB-QUEUE-BACKLOG

Alert: `OUTBOX_BACKLOG_HIGH`. Check PostgreSQL, Redis, worker health, oldest due
work and retry counts. Do not delete outbox rows, acknowledge unprocessed work
or move business truth into Redis. Restore dependencies and allow bounded,
idempotent replay. Ambiguous external effects go to reconciliation.

## RB-DEAD-LETTER

Alert: `DEAD_LETTER_PRESENT`. Inspect work type, safe reference, reason code and
attempt count. Never inspect/copy secret payloads. Replay requires trusted
authority and must remain bounded/idempotent. `AMBIGUOUS_EXTERNAL_MUTATION`
cannot be replayed; reconcile first. Confirm resolved DLQ state without changing
domain state by assumption.

## RB-CATALOG-SYNC

Alert: `CATALOG_SYNC_STALE`. Inspect sync run/checkpoint and supplier read-only
health. Do not publish uncertain Germany eligibility or advance a failed
checkpoint. Restore read-only import, rerun idempotently and verify only
`ALLOWED` offers remain publishable.

## RB-FRAUD-REVIEW

Alert: `FRAUD_REVIEW_BACKLOG_HIGH`. Inspect aggregate review state. Do not bypass
fraud clearance, infer identity or expose correlation subjects. Restore review
capacity and use trusted review authority; verify current facts before closure.

## RB-SUPPLIER-CLAIM

Alert: `SUPPLIER_CLAIM_AMBIGUOUS`. Pause `SUPPLIER_CLAIM_SUBMISSION`. Do not
resubmit blindly, substitute a key-return API or mark supplier acceptance.
Reconcile the existing submission through a future verified provider boundary,
preserve `AMBIGUOUS` truth and escalate for human review.

## RB-BACKUP-RESTORE

Alert: `BACKUP_STALE` or `RESTORE_VALIDATION_FAILED`. Pause unsafe releases, not
provider event ingestion. Verify digest, schema version and encrypted-only
contents in an isolated target. Never restore over a normal database, bundle a
master key, print credentials or decrypt Product Keys. Escalate integrity or
leakage suspicion to Security and retain safe evidence.

## Product Key Leakage

Condition: suspected secret/Product Key leakage. Immediately pause
`CUSTOMER_KEY_DELIVERY` and `SUPPLIER_KEY_RETRIEVAL`, restrict access and
preserve safe audit evidence. Never bulk-decrypt or paste suspected values into
logs/tickets. Rotate relevant credentials/master-key wrapping access through
approved external procedures, assess ciphertext/DEK rewrap needs, verify marker
scans and obtain Security approval before resume.
