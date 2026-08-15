# Catalog Search and Incremental Operations

KS-05-04 completes the Phase 05 catalog foundation with supplier-neutral search projections and incremental maintenance operations.

## Source Of Truth

PostgreSQL canonical catalog state remains authoritative. Search documents are reproducible projections derived from canonical `products`, canonical grouping state, Germany eligibility, offer availability and storefront publication state.

Search does not read raw Kinguin payloads, product-key material, supplier credentials or WooCommerce as source of truth.

## Search Architecture

The core boundary is `CatalogSearchPort`, `CatalogSearchService`, `CatalogSearchProjectionRepository`, `CatalogProjectionSourcePort` and `CatalogOperationsService`.

The default KS-05-04 implementation uses PostgreSQL table `catalog_search_documents`. The abstraction remains narrow so an external search engine can be added later without making it canonical truth.

## Policy Version

Search/index policy version: `catalog-search-v1`.

Every persisted projection stores this version. Future policy changes can rebuild documents from canonical catalog data without supplier API calls or WooCommerce calls.

## Projection Fields

The projection stores only customer/admin-safe catalog data:

- `ProductId`;
- canonical title;
- normalized search title;
- product type;
- platforms;
- edition;
- active flag;
- Germany publishable flag;
- storefront publication state;
- updated timestamp;
- search document version.

It does not store API keys, supplier credentials, product keys, supplier cost, raw supplier payloads, internal encryption metadata, customer records or order records.

## PostgreSQL Index Strategy

Migration `006_catalog_search_operations` adds `catalog_search_documents`, `catalog_operations`, normalized title prefix indexing, exact filter indexing, GIN platform indexing and a normal persisted `tsvector` search document with a GIN index.

`search_text` is not a generated column. The projection writer builds one deterministic source string from canonical title, normalized title, product type, edition and stably sorted platforms, then writes `to_tsvector('simple', sourceText)` during insert/upsert. This keeps the read model rebuildable while respecting PostgreSQL generated-column immutability rules.

PostgreSQL remains the native search foundation for KS-05-04. Elasticsearch/OpenSearch/Meilisearch are not introduced.

## Ranking

Ranking is deterministic:

1. exact normalized title match;
2. normalized prefix match;
3. full-token text match over title, type, edition and platforms;
4. unfiltered catalog ordering.

Ties are sorted by normalized title and then stable `ProductId`. Identical queries over unchanged data return identical ordering.

Search similarity is not canonical identity evidence and never modifies product grouping.

## Pagination

Search uses bounded cursor/keyset pagination.

- Default limit: `50`.
- Maximum limit: `200`.
- Malformed cursors throw `CatalogSearchCursorError`.

Large operational scans use `ProductId` checkpoints instead of offset pagination.

## Incremental Updates

`CatalogOperationsService.refreshProduct()` rebuilds a single `ProductId` projection from canonical state. Material catalog changes can also request storefront re-evaluation.

Material storefront triggers include title, active/disabled, Germany eligibility, availability, grouping and storefront publication changes. If the storefront publication fingerprint is unchanged, KS-05-03 publication logic can still return `NO_OP`.

## Reindex

`CatalogOperationsService.reindex()` rebuilds bounded batches from persisted canonical catalog state. It is restartable using the last processed `ProductId` checkpoint, idempotent, and does not require supplier API calls or WooCommerce calls.

`catalog_operations` records operation ID, type, status, checkpoint, processed count, changed count, failed count, timestamps and policy/index version. Failed jobs do not falsely report completion.

## Events And Webhooks

The supplier-neutral change event is `CATALOG_PRODUCT_CHANGED`. Its safe payload includes `ProductId`, change categories, correlation ID, catalog version and observed timestamp.

Kinguin `product.update` webhook handling remains a refresh-signal foundation. A verified signal can produce a supplier-neutral catalog-change event, but webhook metadata does not directly mutate WooCommerce and is not treated as authoritative product state by itself.

Duplicate events are idempotent. Older or uncertain events refresh from canonical persisted state instead of overwriting newer catalog truth with webhook metadata.

## Storefront Connection

Catalog changes request storefront re-evaluation through a safe reference-only boundary. Queue payloads contain `ProductId`, storefront/correlation references where applicable, catalog version and change categories only.

Supplier adapters never call WooCommerce directly.

## Scale Characteristics

The unit suite includes deterministic synthetic 50,000-product coverage. Local measurement during PR #11 hardening rebuilt 50,000 in-memory projections in 418 ms, performed exact lookup in 0.05 ms, ran a paginated filtered text query in 83.8 ms and refreshed one product in 0.15 ms. CI does not assert fragile millisecond thresholds.

## Security

Search records, queue payloads and audit metadata are safe-reference only. Secret scan remains release-blocking. Product keys, supplier credentials, raw supplier payloads, supplier cost, customer data and order data are excluded from projection and operation payloads.

## Limitations

- No external search engine is included.
- No live WooCommerce publishing is performed.
- No live Kinguin bulk crawl is performed.
- No GAMIVO adapter is implemented.
- No Phase 06 pricing behavior is implemented.
