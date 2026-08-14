# KS-05-02: Canonical Product Grouping Foundation

## Goal

Introduce a supplier-neutral canonical product identity layer so supplier-specific products can be grouped under one KeyCore `ProductId` only when identity evidence is strong enough.

## Risk

HIGH

## Human Approval

Review/merge required.

## Dependencies

- KS-05-01 catalog synchronization and Germany eligibility
- KS-03-02 multi-supplier routing foundation
- ADR-0001 ports and adapters
- ADR-0003 PostgreSQL persistence
- ADR-0009 audit event model

## Scope

- Canonical product grouping policy `canonical-grouping-v1`.
- Evidence model for trusted identifiers, title normalization, edition markers, product type and platform compatibility.
- Supplier-neutral `CanonicalProductGroupingService`.
- Mapping states: `UNMATCHED`, `AUTO_MATCHED`, `MANUAL_MATCHED`, `REVIEW_REQUIRED`, `REJECTED`, `DETACHED`.
- Repository boundary and in-memory/PostgreSQL implementations.
- Reversible PostgreSQL migration for canonical identifiers and supplier-product mappings.
- Manual command foundation for match, detach and reject decisions.
- Audit-safe event vocabulary and metadata.

## Forbidden Scope

- WooCommerce publication.
- WordPress product sync.
- GAMIVO adapter.
- Steam API calls.
- Web scraping.
- Fuzzy AI/ML matching.
- Search indexing.
- Pricing, checkout, procurement or fulfillment.
- Production deployment.
- KS-05-03 or later tasks.

## Acceptance Criteria

- Supplier product identity remains distinct from canonical product identity.
- Title equality or fuzzy similarity alone never auto-groups products.
- Verified trusted strong identifiers can auto-match only when product type, edition and platform evidence are compatible.
- Strong identifier conflicts fail closed as review/conflict.
- Existing supplier-product mappings cannot be silently reassigned to another `ProductId`.
- Manual match, detach and reject operations preserve actor and reason.
- Germany eligibility does not affect canonical identity grouping.
- Data produced by grouping can support future routing by canonical `ProductId`.
- No raw supplier payloads, credentials, product keys or production data are persisted.
- Migrations are reversible.

## Required Tests

- Policy matrix tests for strong IDs, weak evidence, title normalization, edition safety, platform safety and product type conflicts.
- Manual mapping tests.
- Audit event tests.
- PostgreSQL mapping and identifier persistence tests.
- Existing KS-05-01, Germany eligibility, routing, Kinguin and persistence tests remain green.
- Large synthetic lookup test for 50,000 supplier products.
