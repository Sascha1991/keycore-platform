# KS-05-01: Catalog Synchronization and Germany Eligibility

## Goal

Establish the supplier-neutral catalog synchronization foundation and Germany eligibility engine used before any future storefront publication.

## Dependencies

- KS-02-01 PostgreSQL persistence foundation
- KS-02-02 queue/outbox/reconciliation foundation
- KS-02-04 audit service foundation
- KS-03-01 supplier framework
- KS-03-02 multi-supplier routing
- KS-04-01 Kinguin connector boundary
- ADR-0007 Germany compatibility and region fail-closed policy

## Scope

- Full catalog synchronization from normalized supplier product pages.
- Incremental catalog synchronization using supplier delta capability when available.
- Durable supplier product and supplier offer state.
- Durable `(supplier_id, supplier_offer_id) -> supplier_product_id` mapping.
- Germany eligibility policy `de-eligibility-v1`.
- Sync run and checkpoint persistence.
- Supplier-neutral webhook-to-sync ingestion boundary.
- Queue-safe revalidation job payload helper.
- Audit-safe catalog sync event vocabulary.

## Forbidden Scope

- KS-05-02 or later tasks.
- WooCommerce publication or product creation.
- Product grouping.
- Search indexing.
- GAMIVO or any second real supplier implementation.
- Live Kinguin full crawl.
- Production deployment.
- Supplier credentials, product keys, customer/order data, or raw supplier payload persistence.

## Acceptance Criteria

- Structured Germany blocking evidence wins over permissive evidence.
- Missing, unknown, contradictory, unmapped, VPN, or foreign-account evidence fails closed.
- Only `ALLOWED` Germany decisions are marked as Germany-eligible by the policy engine.
- Full sync records products/offers and deactivates stale supplier records.
- Incremental sync records deltas and advances checkpoints only after success.
- Supplier offer/product mapping changes fail closed unless a future reconciliation task explicitly approves them.
- Webhook ingestion accepts normalized supplier-neutral product/offer inputs only.
- PostgreSQL remains the durable system of record; Redis/queue payloads do not store business state.
- No raw supplier payload, credential, product key, or production customer/order data is committed.

## Required Tests

- Germany eligibility policy matrix tests.
- Full sync orchestration tests.
- Incremental sync/checkpoint tests.
- Durable mapping tests.
- Mapping-change fail-closed tests.
- Stale full-sync deactivation tests.
- Queue-safe revalidation payload tests.
- PostgreSQL migration/repository integration tests.
- 50,000-product synthetic supplier scale test.

## Human Approval Requirement

`POLICY-EXCEPTION` approval is required for any future change that allows VPN-required, foreign-account-required, unknown, missing, contradictory, or unmapped supplier evidence to become Germany eligible.
