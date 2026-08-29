# KS-11-03: Catalog Scale Test

## Goal

Prove deterministic import, changed refresh and exact replay of at least 50,000
synthetic products plus offers through the real catalog and PostgreSQL
boundaries.

## Dependencies

- KS-11-01 and KS-11-02 complete and merged.
- Phase-05 catalog synchronization, Germany eligibility and publication.
- PostgreSQL migration baseline 027.

## Scope

- Paged synthetic catalog source with at least 50,000 products.
- Baseline full sync, changed full refresh and exact replay.
- Bounded PostgreSQL page transactions.
- Germany eligibility and publication at scale.
- Data-loss, duplicate, orphan, foreign-key, uniqueness and index checks.
- Safe JSON/Markdown evidence in release-blocking CI.

## Acceptance Criteria

- At least 50,000 products and associated offers are processed.
- All source pages complete with bounded page materialization.
- Refresh updates changed state, adds new identities and soft-deactivates stale
  state according to current full-sync semantics.
- Exact replay does not change product, offer, publication or snapshot counts
  and does not repeat storefront mutations.
- Duplicate product/offer identity in one page fails before page persistence.
- Only `ALLOWED`, active, in-stock products are published; excluded, unknown,
  VPN-required, inactive and stale products remain fail-closed.
- Canonical, supplier-product, supplier-offer and publication identities remain
  unique with no orphan rows or data loss.
- Baseline, refresh and replay each remain below the documented five-minute CI
  ceiling.
- Safe CI evidence is archived for 14 days.
- Required catalog, PostgreSQL, publication, staging, E2E and repository quality
  gates pass.
- Region evidence snapshot replay uses an indexed offer/version/capture lookup;
  representative PostgreSQL plans prove the supporting index is selected.

## Forbidden Scope

- Production or Kinguin catalog requests.
- Production credentials, catalog snapshots, customer data or Product Keys.
- Live WooCommerce, Stripe or supplier mutation.
- Migration changes solely for test bookkeeping.
- KS-11-04 concurrency, KS-11-05 security assessment, KS-11-06 recovery or
  KS-11-07 UAT.

## Human Approval

No new approval is granted by this task. `SECURITY-READINESS` remains required
and unapproved.
