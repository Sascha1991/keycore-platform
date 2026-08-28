# Incident Runbooks

Diagnostics use aggregate state and safe references only. Never expose Product
Keys, ciphertext, credentials, provider payloads, SQL containing values,
customer messages or PII. Operations Controls require trusted authority;
automation and agents cannot self-approve `SECURITY-READINESS`.

## RB-SUPPLIER-OUTAGE

- Alerts/severity: `PROCUREMENT_BACKLOG_HIGH` (warning),
  `PROCUREMENT_AMBIGUITY_HIGH` and `SUPPLIER_OUTAGE` (critical).
- Owner role: Operations.
- Containment/diagnostics: pause `PROCUREMENT_CREATE` and affected retrieval;
  inspect aggregate health and durable operation/reconciliation states.
- Prohibited: never retry an ambiguous purchase, switch supplier or infer
  success/failure.
- Recovery: reconcile already-dispatched work, verify provider recovery and
  backlog progress, then resume with trusted authority.
- Rollback/fallback: no automatic rollback; reconcile first and preserve truth.
- Verification/escalation: purchase calls remain zero while paused; escalate
  unresolved ambiguity to Engineering and Operations approval.

## RB-ORDER-STUCK

- Alerts/severity: `PAID_ORDER_STUCK` (critical).
- Owner role: Operations.
- Containment/diagnostics: inspect payment, fraud, procurement, fulfillment and
  reconciliation by safe reference; pause new procurement when duplication is
  possible.
- Prohibited: do not fabricate capture, fraud approval or fulfillment.
- Recovery: restore the dependency and replay only bounded idempotent work.
- Rollback/fallback: keep authoritative order state and enter manual review when
  automated progress is unsafe.
- Verification/escalation: verify state progress or manual-review ownership;
  escalate financial inconsistency to Finance/Operations.

## RB-KEY-RETRIEVAL

- Alerts/severity: `FULFILLMENT_PENDING_TOO_LONG` (warning); suspected key
  leakage is a critical Security condition.
- Owner role: Security.
- Containment/diagnostics: pause retrieval and, for suspected compromise,
  delivery; inspect metadata and audit evidence only.
- Prohibited: never bulk decrypt, dump keys or retrieve again after ambiguity.
- Recovery: reconcile supplier state, rotate approved external credentials and
  verify encrypted state before resume.
- Rollback/fallback: no plaintext rollback; preserve encrypted records and use
  manual review.
- Verification/escalation: prove zero plaintext output and obtain Security
  approval before resume.

## RB-QUEUE-BACKLOG

- Alerts/severity: `OUTBOX_BACKLOG_HIGH` (critical).
- Owner role: Engineering.
- Containment/diagnostics: inspect PostgreSQL, Redis, worker health, oldest due
  work and retry counts.
- Prohibited: do not delete outbox rows, acknowledge unprocessed work or move
  durable truth into Redis.
- Recovery: restore dependencies and permit bounded idempotent replay.
- Rollback/fallback: ambiguous external effects go to reconciliation rather
  than rollback or replay.
- Verification/escalation: verify decreasing age/count and durable ACK state;
  escalate persistent database or queue failure to Operations.

## RB-DEAD-LETTER

- Alerts/severity: `DEAD_LETTER_PRESENT` (warning; critical when external
  ambiguity or sustained growth affects commerce).
- Owner role: Operations.
- Containment/diagnostics: inspect work type, safe reference, reason code and
  attempt count only.
- Prohibited: never inspect secret payloads or replay
  `AMBIGUOUS_EXTERNAL_MUTATION`.
- Recovery: authorized, bounded and idempotent replay after the cause is fixed.
- Rollback/fallback: reconcile ambiguous work first; DLQ state never rewrites
  business truth.
- Verification/escalation: verify resolved DLQ state and unchanged domain truth;
  escalate repeated poison work to Engineering.

## RB-CATALOG-SYNC

- Alerts/severity: `CATALOG_SYNC_STALE` (warning).
- Owner role: Operations.
- Containment/diagnostics: inspect sync run/checkpoint and supplier read health.
- Prohibited: never advance a failed checkpoint or publish uncertain Germany
  eligibility.
- Recovery: restore read-only import and rerun idempotently.
- Rollback/fallback: keep uncertain offers unpublished.
- Verification/escalation: verify only `ALLOWED` offers are publishable;
  escalate unexplained mapping conflicts to Engineering.

## RB-FRAUD-REVIEW

- Alerts/severity: `FRAUD_REVIEW_BACKLOG_HIGH` (warning).
- Owner role: Finance/Operations.
- Containment/diagnostics: inspect aggregate review state and review capacity.
- Prohibited: do not bypass clearance, infer identity or expose correlation
  subjects.
- Recovery: restore review capacity and use trusted authority against current
  facts.
- Rollback/fallback: keep uncleared orders blocked.
- Verification/escalation: verify current fact fingerprints before closure;
  escalate policy uncertainty for human approval.

## RB-SUPPLIER-CLAIM

- Alerts/severity: `SUPPLIER_CLAIM_AMBIGUOUS` (critical).
- Owner role: Operations.
- Containment/diagnostics: pause submission and inspect durable submission state.
- Prohibited: do not resubmit blindly, substitute a key-return API or infer
  provider acceptance.
- Recovery: reconcile the existing submission through a verified provider
  boundary and preserve audit history.
- Rollback/fallback: no automatic rollback; reconcile first.
- Verification/escalation: verify exactly one external effect or retained
  ambiguity; escalate to supplier-policy human review.

## RB-BACKUP-RESTORE

- Alerts/severity: `BACKUP_STALE` and `RESTORE_VALIDATION_FAILED` (critical).
- Owner role: Engineering.
- Containment/diagnostics: pause unsafe releases; inspect safe manifest,
  checksum, migration identity and aggregate validation results.
- Prohibited: never restore over a normal/live target, bundle a master key,
  print credentials or decrypt Product Keys.
- Recovery: rerun only with an authorized synthetic backup and disposable
  `keycore_restore_` target; verify encrypted and Operations Control digests.
- Rollback/fallback: abandon and destroy the disposable target on failure; do
  not rewrite production truth.
- Verification/escalation: confirm cleanup and stable validation reason codes;
  escalate integrity or leakage suspicion to Security.

## Product Key Leakage

- Condition/severity: suspected Product Key or secret leakage (critical).
- Owner role: Security.
- Containment/diagnostics: pause delivery/retrieval, restrict access and preserve
  safe audit evidence.
- Prohibited: never paste, bulk decrypt or export suspected values.
- Recovery: rotate approved external credentials or wrapping access and assess
  ciphertext/DEK rewrap requirements without plaintext extraction.
- Rollback/fallback: keep affected paths paused until evidence is complete.
- Verification/escalation: run leakage scans and require human Security approval
  before resume.
