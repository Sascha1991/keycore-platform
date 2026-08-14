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
- API credentials and webhook secrets are read only through the configuration/secret boundary and never logged or committed.
- Product, offer, order, key, return-key, reference-data, and webhook mappings follow the official Kinguin eCommerce API documentation.
- Key serial material is handed only to the Secure KeyVault boundary and never appears in audit or queue metadata.
- `order.complete` remains documented as deprecated and supported only as a compatibility webhook classification.
- Undocumented numeric Kinguin rate limits are not represented as exhausted capacity; HTTP `429` still maps to `RATE_LIMIT`.
- Purchase and offer resolution use an explicit `SupplierOfferId` to `SupplierProductId` mapping boundary and never scan the global catalog during purchase.

## Required Tests

- Supplier contract tests.
- Timeout/reconciliation tests.
- Secret redaction tests.

## Risk Level

Critical.

## Human Approval Requirement

`REAL-SUPPLIER` required.
