# Operations Monitoring

KS-10-01 and the KS-10-02 gap closure define provider-neutral operational
telemetry. No production
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
remain blocked by pricing, but no negative-margin order metric is emitted.
Persisted price snapshots, locks and orders do not retain the complete
historical acquisition cost, fee, tax and FX amounts required to prove realized
order margin. Recomputing from mutable catalog offers would fabricate truth. A
future boundary must persist an immutable order-bound commercial snapshot
before `NEGATIVE_MARGIN_ORDER_COUNT` can be authoritative.

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

`SafeOperationalLogger` constructs output from field-specific value allowlists
for component, event, operation, result and reason code plus a validated
correlation ID and non-negative duration. Unknown values are omitted even when
placed in an otherwise allowed field. It never serializes an input object,
nested data, exception or stack. This omission-first design protects
Product Keys, encrypted material, tokens, credentials, headers, cookies,
provider/webhook payloads, SQL, email/IP/address/device data and
customer/support prose. Correlation IDs are context only, never authorization
evidence. Regex-based redaction is not the primary boundary.

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
Critical coverage is validated against a code-owned registry requiring an
owner role, recovery procedure and rollback or safe-fallback strategy.
