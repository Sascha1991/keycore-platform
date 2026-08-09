# KS-03-01 - Supplier Framework & Mock Supplier

## Goal

Turn the supplier-neutral contracts into a reusable, testable supplier-adapter framework and implement a deterministic MockSupplier that can exercise catalog, offer, region, purchase, reconciliation, delayed fulfillment, key-handle, health and refund capabilities without any real supplier API.

## Dependencies

- KS-01-01 through KS-02-04 completed and merged.
- ADR-0001 through ADR-0012.
- Specification v1.0.2.

## Scope

- Supplier-neutral capability model.
- Normalized supplier product and offer boundaries.
- Supplier registry.
- Supplier-neutral error taxonomy.
- Supplier-neutral observability event contracts.
- Deterministic in-memory MockSupplier.
- MockSupplier with at least 50,000 deterministic synthetic products using scalable generated fixtures.
- Broad deterministic synthetic scenarios covering region, stock, price, supplier delays, rate limits, outages, ambiguous purchases, delayed fulfillment and refund capability.
- Reusable supplier adapter contract test suite.
- Documentation and implementation report.

## Acceptance Criteria

- SupplierPort remains supplier-neutral.
- MockSupplier implements SupplierPort and performs no network I/O.
- MockSupplier can generate at least 50,000 deterministic synthetic products without committing a 50,000-item fixture.
- Generated fixture data has stable IDs, titles, ordering, offers and timestamps across runs for the same seed/configuration.
- Generated fixtures cover Germany-compatible, EU-compatible, Global-compatible, US-only, LATAM, CIS, Asia, unknown, contradictory, VPN-required and foreign-account-required region evidence.
- Generated fixtures vary product type, platform, availability, price, currency, stock revision and changed timestamps.
- Full catalog listing, delta catalog listing, product lookup, offer lookup, price lookup, region evidence, purchase, reconciliation, key-handle retrieval, health and refund claim behavior are represented.
- Unsupported optional capabilities fail explicitly.
- Supplier-side IDs and KeyCore IDs remain distinct branded types.
- Purchase idempotency returns the same result for the same semantic request and rejects conflicting reuse.
- Unknown and contradictory region evidence never becomes implicitly `ALLOWED`.
- Fault injection is deterministic and opt-in.
- Errors and return structures contain no credentials or product keys.
- Contract tests are reusable for future adapters.
- Existing PostgreSQL, Redis, KeyVault and Audit tests remain green.

## Forbidden Scope

- Kinguin authentication, API calls, catalog parsing, purchase API, key retrieval, or credentials.
- GAMIVO or any other real supplier.
- Catalog persistence workflow.
- Germany filtering engine.
- Pricing engine.
- WooCommerce publication.
- Stripe, checkout, procurement orchestration, fulfillment, invoices, email, production deployment.
- KS-03-02 or Phase 04.

## Required Tests

- Supplier registry registration, duplicate rejection, unknown lookup and listing.
- Capability model consistency.
- Full and empty catalog.
- Generated 50,000-product catalog.
- Catalog pagination and deterministic ordering.
- First, middle and last generated catalog pages.
- Delta catalog.
- Generated delta catalog filtering.
- Generated SupplierProductId and SupplierOfferId uniqueness.
- Generated region scenario distribution.
- Generated records contain no credentials or product-key material.
- Product and offer lookup, including missing values.
- Valid money, availability and region evidence.
- Unknown/contradictory region remains review-required.
- Purchase accepted, idempotent repeat, conflicting idempotency reuse.
- Delayed, unavailable, ambiguous and terminal synthetic purchase scenarios.
- Reconciliation.
- Key and refund capability on/off behavior.
- Health and rate-limit metadata.
- Deterministic fault injection categories.
- API delay/timeout, rate limit, degraded/outage health, transient error, terminal error and malformed-response simulation.
- Supplier-neutral error safety.
- No credentials in returned structures.
- No network imports.
- Reusable contract suite passes for MockSupplier.

## Risk Level

High.

## Human Approval Requirement

Review/merge required. No production supplier approval is granted.
