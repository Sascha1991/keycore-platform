# Catalog Synchronization and Germany Eligibility

KS-05-01 establishes the supplier-neutral catalog synchronization foundation. It does not publish to WooCommerce, group products, index search, run a live Kinguin bulk crawl, or implement procurement.

## Synchronization Model

The catalog sync service consumes normalized `SupplierPort` product pages and a supplier-neutral offer discovery boundary. Supplier adapters remain responsible for supplier-specific parsing and normalization before data reaches catalog sync.

Supported modes:

- `FULL`: reads all normalized product pages, stores observed products/offers, evaluates Germany eligibility, and deactivates records not seen in the completed run.
- `INCREMENTAL`: reads supplier delta pages when the supplier advertises delta capability and advances the checkpoint only after a successful run.
- `WEBHOOK`: accepts already-normalized product/offer inputs and routes them through the same validation, mapping, persistence, and eligibility path.

PostgreSQL is the durable source of truth for catalog state. Queue payload helpers carry only safe references such as supplier ID, supplier offer ID, policy version, and timestamps.

## Durable Mapping

Supplier offers are mapped by:

```text
supplierId + supplierOfferId -> supplierProductId
```

If an existing supplier offer is later observed under a different supplier product, sync fails closed. A future reconciliation task may define an explicit human-approved mapping correction workflow, but KS-05-01 does not silently remap offers.

## Germany Eligibility

Policy version: `de-eligibility-v1`.

The policy evaluates structured region evidence only. It does not infer eligibility from product titles, supplier marketing text, arbitrary free text, or undocumented display labels.

Allow outcomes:

- explicit `DE` allowed country;
- documented supplier-region semantics registered as EU including Germany;
- documented supplier-region semantics registered as global;
- documented supplier-region semantics registered as region-free.

Fail-closed outcomes:

- Germany is explicitly excluded;
- VPN activation is required;
- a foreign account is required;
- evidence is missing, unknown, contradictory, or unmapped;
- supplier or manual controls disable eligibility.

Structured blocking evidence wins over permissive evidence.

## Persistence

Migration `003_catalog_sync_foundation` adds:

- `catalog_sync_runs`;
- `catalog_sync_checkpoints`;
- lifecycle/active/first-seen/last-seen/run tracking columns on supplier products;
- active/first-seen/last-seen/run tracking columns on supplier offers.

Existing normalized tables remain the catalog foundation:

- `suppliers`;
- `products`;
- `supplier_products`;
- `supplier_offers`;
- `offers`;
- `region_evidence`;
- `region_decisions`;
- `price_snapshots`.

Raw supplier API responses, credentials, product keys, production customer data, and production order data must not be stored by catalog sync.

## Deferred Work

The following are intentionally outside KS-05-01:

- WooCommerce publication;
- customer-visible product grouping;
- search indexing;
- live bulk Kinguin crawl;
- GAMIVO or other real supplier integrations;
- procurement or key retrieval.
