# Operations Monitoring

KS-10-01 defines provider-neutral operational telemetry. No production
Prometheus/OpenTelemetry exporter, dashboard backend or alert-delivery service
is connected. The contracts are testable in process and can be wired later
without changing business services.

## Safe Metrics

`PostgresOperationalMetricFacts` reads aggregate counts only. Metric labels are
limited to `status`, `operationType`, `providerType`, `queueName` and
`reasonCode`; values must be bounded uppercase codes. IDs, email addresses,
provider references, arbitrary errors, URLs, message bodies and secret-bearing
material are forbidden.

Current metric families cover catalog sync state/age, order states and paid
orders still awaiting procurement after 15 minutes, procurement backlog and
ambiguity, fulfillment and delivery backlog, fraud review, support cases,
supplier claims, outbox, reconciliation and dead letters. Mail metrics are not
invented because no production mail transport exists. Negative-margin outcomes
remain enforced and audited by pricing; no aggregate operational fact source
exists yet, so no fabricated margin metric is emitted.

## Dashboard Specification

| Panel                | Metric                                                          | Critical signal              |
| -------------------- | --------------------------------------------------------------- | ---------------------------- |
| Catalog freshness    | `catalog_sync_runs`                                             | failed/stale run             |
| Order flow           | `orders_by_state`                                               | paid order does not progress |
| Procurement          | `procurement_backlog`, `procurement_ambiguous`                  | backlog or any ambiguity     |
| Fulfillment          | `fulfillment_backlog`, `delivery_pending`                       | aging pending work           |
| Risk and support     | `fraud_review_backlog`, `support_case_backlog`                  | review growth                |
| Supplier claims      | `supplier_claim_backlog`                                        | ambiguous/prepared work      |
| Async infrastructure | `outbox_backlog`, `reconciliation_backlog`, `dead_letter_count` | growth/poison work           |
| Recovery             | `backup_age_seconds`, `restore_validation_failures`             | stale or failed validation   |

Critical SLIs are time to acknowledge procurement ambiguity, paid-order age
before fulfillment, outbox/reconciliation age, dead-letter age, last validated
backup age and last isolated restore result. Production thresholds require
capacity evidence and operator approval; foundation defaults are conservative
starting values, not an approved production SLO.

## Logging and Redaction

`SafeOperationalLogger` constructs output from an allowlist: component, event,
operation, result, reason code, validated correlation ID and duration. It never
serializes an input object or exception. This omission-first design protects
Product Keys, encrypted material, tokens, credentials, headers, cookies,
provider payloads and customer/support prose. Regex-based redaction is not the
primary boundary.

## Health and Readiness

Liveness answers only whether the process executes. Readiness is role-specific:

- read-only roles may remain degraded when external suppliers are unavailable;
- durable mutations are unready when PostgreSQL is unavailable;
- external mutations are unready when their required provider is unavailable;
- Redis health cannot grant or override durable security state.

Probe exceptions map to `UNAVAILABLE`; raw errors are not returned. Health does
not automatically pause or resume durable controls, avoiding control flapping.

## Alerts

Stable alert definitions cover stuck paid orders, procurement backlog and
ambiguity, fulfillment delay, supplier outage, outbox backlog, dead letters,
fraud review backlog, ambiguous supplier claims, stale catalog sync, stale
backup and failed restore validation. Every definition has a threshold,
severity, safe summary and runbook ID in
[`incident-runbooks.md`](./runbooks/incident-runbooks.md).
