# Catalog Scale Test

## Scope

KS-11-03 validates the existing supplier-neutral `CatalogSyncService`,
`PostgresCatalogSyncRepository`, Germany eligibility engine,
`StorefrontPublicationService` and PostgreSQL publication repository. The source
and storefront ports are deterministic local adapters. No supplier,
WooCommerce, Kinguin or other external network is used.

ADR-0009 remains the audit-event decision and does not define a catalog load
architecture. This suite follows the existing Phase-05 catalog contracts and
ADR-0007 fail-closed Germany rules.

## Dataset

The baseline contains exactly 50,000 synthetic products and 60,000 supplier
offers. Products are generated on demand in 100 pages of 500; no 50k product or
offer array is retained. At most 500 products and three offers per product are
materialized by the import boundary.

The deterministic distribution includes:

- Germany-allowed in-stock products;
- explicit Germany exclusions;
- missing/unknown region evidence;
- VPN-required activation;
- Germany-allowed but out-of-stock offers; and
- secondary offers on a stable product subset.

The refresh emits 50,000 active products covering indexes 100 through 50,099.
It adds 100 products and 610 offer identities, changes titles, prices,
availability and region eligibility, and leaves 100 products plus 5,110 offers
stale. Full-sync semantics soft-deactivate those records. The refresh source has
55,500 active offers; final durable identity counts are 50,100 products and
60,610 offers.

## Architecture

`CatalogSyncService` prepares one normalized page and uses the optional
repository page-upsert capability when available. PostgreSQL performs each page
inside one bounded transaction using JSON recordsets and existing unique/foreign
key constraints. Repositories without the capability retain the established
single-record fallback.

An existing supplier-product mapping keeps its internal ProductId during
refresh. Region evidence, decisions and price snapshots are appended only when
their source snapshot changes, so exact replay does not create snapshot rows.
Missing full-sync products/offers are soft-deactivated after all pages complete.

Publication reads PostgreSQL snapshots by ProductId and invokes the real
publication service with a deterministic local storefront. Eligible records are
created or updated; blocked records remain blocked or are unpublished. Repeated
blocked/unpublished evaluation is a `NO_OP`, preventing duplicate remote side
effects.

The publication harness preloads snapshots, latest prices and current
publication rows for the same 500-product page and persists that page in one
bounded transaction. It retains only the published slug/remote-owner uniqueness
index between pages (at most the published subset, not the complete catalog).
Each PostgreSQL publication save uses one atomic upsert; the existing
ProductId/storefront and remote/storefront mapping conflicts still fail closed
with stable domain errors.

## Acceptance Scenarios

| ID        | Proof                                                             |
| --------- | ----------------------------------------------------------------- |
| SCALE-001 | 50k/60k baseline import and publication                           |
| SCALE-002 | changed full refresh with soft deactivation                       |
| SCALE-003 | exact replay leaves rows, snapshots and remote call counts stable |
| SCALE-004 | 500-record pagination completeness and bounded materialization    |
| SCALE-005 | duplicate identity inside one page fails before persistence       |
| SCALE-006 | DE exclusions, unknown evidence and VPN remain unpublished        |
| SCALE-007 | exact counts plus first/middle/last/changed/new/stale samples     |
| SCALE-008 | no duplicate or stale active publication                          |
| SCALE-009 | foreign keys, uniqueness and indexed lookup plans                 |
| SCALE-010 | bounded performance targets and safe evidence                     |

## Performance Targets

Baseline, refresh and exact replay each have a five-minute hard ceiling. The
dedicated CI step has a 20-minute job-step ceiling. These ceilings include both
PostgreSQL synchronization and publication evaluation and are intentionally
more generous than the existing 15-second in-memory 50k foundation benchmark.
Observed CI durations are written to the evidence artifact and copied into the
implementation report after the first successful branch run.

## Database Evidence

The suite checks unique supplier product and offer identities, one publication
per ProductId/storefront, unique remote publication IDs, no orphan offers, no
orphan publications and no unreferenced scale ProductIds. `EXPLAIN (FORMAT
JSON)` is inspected for the existing supplier-product, supplier-offer and
publication indexes without asserting brittle costs or exact plan text.

No migration is added. Migration baseline 026 and its existing constraints are
unchanged.

## Safe Evidence

`npm run catalog:scale` writes JSON and Markdown to
`artifacts/catalog-scale/`. CI uploads the directory as
`ks-11-03-catalog-scale-evidence` for 14 days. Evidence contains only suite,
environment, commit, synthetic counts, durations, safe result states and batch
metadata. Database URLs, credentials, provider payloads, customer data and
Product Keys are omitted.

## Limits

The test is ordinary sequential catalog batching, not the KS-11-04 concurrent
order/replay test. It is not a security assessment, disaster-recovery exercise
or storefront UAT. KS-11-04 through KS-11-07 remain not started, Phase 11 remains
incomplete and `SECURITY-READINESS` remains unapproved.
