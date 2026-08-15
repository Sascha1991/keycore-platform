# KS-05-04 - Search & Incremental Catalog Operations

Risk: MEDIUM/HIGH

Human approval: Review/merge required.

## Scope

Implement supplier-neutral catalog search and incremental catalog maintenance operations on top of persisted KeyCore canonical catalog state.

## Acceptance Criteria

- Search reads from canonical KeyCore catalog search projections, not raw supplier payloads or WooCommerce.
- Search supports text query, exact `ProductId`, platform, product type, edition, active, Germany-publishable and publication-state filters.
- Search uses deterministic ranking and bounded keyset/cursor pagination.
- Malformed cursors fail clearly.
- Search projection policy is versioned as `catalog-search-v1`.
- Reindex is bounded, restartable, idempotent and rebuilds from persisted canonical catalog state without supplier or WooCommerce API calls.
- Incremental refresh updates only affected `ProductId` projections.
- Catalog change events contain safe supplier-neutral references only.
- Storefront re-evaluation requests carry only safe `ProductId`, storefront and correlation references.
- Duplicate and out-of-order events are safe.
- PostgreSQL schema changes are reversible and use the shared PostgreSQL integration-test bootstrap.
- Tests cover search, projection, incremental operations, webhook refresh signals, operations, security and regression behavior.
- Documentation and implementation report are updated.

## Out Of Scope

- Elasticsearch, OpenSearch, Meilisearch or AI/fuzzy identity matching.
- GAMIVO.
- Pricing/margin engine.
- Checkout, payments, orders, procurement, key retrieval, fulfillment, invoices and customer account.
- Live WooCommerce publishing.
- Live Kinguin bulk crawl.
- Phase 06.
