# KS-04-01: Kinguin Connector Boundary

## Goal

Prepare the Kinguin connector only after official/private documentation and required access are available.

## Dependencies

- KS-03-01
- ADR-0008
- `REAL-SUPPLIER` approval artifact

## Scope

- Documented mapping from official/private Kinguin Purchase/Reseller API docs to the supplier port.
- Authentication, catalog retrieval, offer retrieval, ordering, status polling/webhooks, key retrieval, and refund behavior only as documented.
- Supplier contract tests based on documented fixtures.

## Forbidden Scope

- Guessing endpoints, authentication, payloads, pagination, rate limits, region semantics, purchase semantics, webhook signatures, key delivery, refund behavior, or tax/fee fields.
- Non-mock ordering without approval.

## Deliverables

- Kinguin adapter implementation plan or implementation when docs and approval exist.
- Contract tests tied to documented behavior.
- No-go evidence if docs or access are incomplete.

## Acceptance Criteria

- Real ordering is impossible without `REAL-SUPPLIER` approval.
- All documented behavior is covered by contract tests.
- Ambiguous supplier timeouts reconcile before retry.

## Required Tests

- Supplier contract tests.
- Timeout/reconciliation tests.
- Secret redaction tests.

## Risk Level

Critical.

## Human Approval Requirement

`REAL-SUPPLIER` required.
