# KS-05-03: WooCommerce Storefront Publication Foundation

## Goal

Introduce a supplier-neutral storefront publication layer between canonical KeyCore catalog data, Germany eligibility and WooCommerce product records. KeyCore remains the source of truth.

## Risk

HIGH

## Human Approval

Review/merge required.

## Dependencies

- KS-05-01 catalog synchronization and Germany eligibility
- KS-05-02 canonical product grouping foundation
- KS-03-02 multi-supplier routing foundation
- ADR-0001 ports and adapters
- ADR-0003 PostgreSQL persistence
- ADR-0009 audit event model

## Scope

- Storefront publication policy `storefront-publication-v1`.
- Publication states: `NOT_PUBLISHED`, `PENDING_CREATE`, `PUBLISHED`, `PENDING_UPDATE`, `UNPUBLISH_PENDING`, `UNPUBLISHED`, `BLOCKED`, `FAILED`, `REVIEW_REQUIRED`.
- Supplier-neutral publication service and repository boundary.
- Durable `ProductId + storefront -> remote WooCommerce product ID` mapping.
- Fail-closed conflict handling for mapping changes or remote ID reuse.
- Eligibility checks from canonical product state, safe grouping state, Germany-compatible offers, explicit price boundary, stock and required storefront fields.
- WooCommerce adapter behind `StorefrontPort` using REST API `wc/v3`.
- Reversible PostgreSQL migration for storefront publication mappings.
- Audit-safe publication events and metadata.
- Local-only WooCommerce configuration placeholders without secrets.

## Forbidden Scope

- Live WooCommerce store publication.
- Real production domains or credentials.
- Checkout, payment, procurement or fulfillment.
- GAMIVO or any new supplier adapter.
- Real product keys.
- Customer/order production data.
- Hard delete of WooCommerce products.
- Production deployment.
- KS-05-04 or later tasks.

## Acceptance Criteria

- Publication requires an active canonical product and at least one active Germany `ALLOWED` offer.
- Unsafe canonical mapping states block publication.
- `BLOCKED`, Germany-ineligible or manually disabled products are not published.
- Existing WooCommerce products are updated by durable remote ID mapping, not by title search.
- Remote mappings are idempotent and cannot be silently reassigned.
- Create ambiguity or local persistence failure after remote create requires reconciliation before retry.
- WooCommerce create transport uncertainty is classified as reconciliation-required and cannot trigger a blind second create.
- Audit events use a configured environment value and do not infer production from storefront/domain naming.
- Products are soft-unpublished by draft/hidden state rather than hard-deleted.
- Payloads contain only safe customer-facing fields and KeyCore references.
- Supplier IDs, supplier costs, credentials, product keys and customer data are not exposed to storefront payloads or audit metadata.
- Migrations are reversible.

## Required Tests

- Publication eligibility matrix.
- State machine tests for create, update, no-op, block, soft-unpublish, failure and reconciliation.
- Mapping conflict tests for product/storefront and remote/storefront uniqueness.
- WooCommerce adapter contract tests for `wc/v3` paths, auth header shape, safe payloads and no hard delete.
- WooCommerce mutating transport ambiguity tests for create, update and soft-unpublish.
- Audit environment injection tests.
- PostgreSQL mapping persistence and conflict tests.
- Existing catalog, grouping, routing, Kinguin, queue, vault, audit and persistence tests remain green.
- Secret scan and dependency audit remain clean.
