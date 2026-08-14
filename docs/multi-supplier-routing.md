# Multi-Supplier Routing Foundation

KS-03-02 adds a supplier-neutral routing foundation. It lets KeyCore evaluate multiple supplier offers for the same canonical product while keeping real supplier connectors, live credentials and procurement behavior out of scope.

## Product Mapping

The routing boundary uses explicit mappings from a canonical `ProductId` to supplier-specific `SupplierProductId` and `SupplierOfferId` values. It does not match by title and does not assume that equal supplier product IDs mean the same product across suppliers.

The mapping source is represented by `ProductSupplierMappingPort` so later persistence work can store mappings durably without changing routing semantics.

## Candidate Evaluation

Each mapped supplier offer becomes a `SupplierRoutingCandidate`. The candidate model includes:

- supplier, product and offer identifiers;
- normalized offer, price and availability;
- optional comparable price;
- region evidence and Germany eligibility decision;
- supplier health and capabilities;
- safe supplier metadata only;
- deterministic rejection reason codes.

Evaluation is fail-closed for disabled suppliers, unsupported capabilities, missing offers, out-of-stock or unknown availability, stale prices, unsupported currencies, outage or unknown health when disallowed, exhausted rate limits, blocked or unclear Germany evidence, VPN requirements and foreign-account requirements.

## Policy And Ranking

`SupplierRoutingPolicy` controls allowed suppliers, operational state, priority, required capabilities, health tolerance, currency handling, price freshness and manual-review tolerance.

Eligible suppliers are ranked deterministically by:

1. health status;
2. availability;
3. comparable price;
4. configured supplier priority;
5. supplier ID;
6. supplier offer ID.

Different currencies require either a shared currency or an injected `CurrencyConversionPort`. If candidates cannot be compared safely, routing returns `NON_COMPARABLE` instead of guessing.

## Region Boundary

Routing depends on `RegionEligibilityPort` for Germany compatibility decisions. Region uncertainty, contradictory evidence, VPN requirements and foreign-account requirements remain explicit rejection reasons and are not converted into silent supplier preferences.

## Fallback Planning

Fallback planning uses the evaluated candidate list plus previous supplier purchase attempts.

Fallback is fail-closed by attempt state:

- `AMBIGUOUS` returns `RECONCILE_CURRENT_SUPPLIER_FIRST` with no candidates. This protects against duplicate procurement when the previous supplier might have accepted the order.
- `SUCCEEDED` returns `NO_FALLBACK` with no candidates. A completed supplier purchase prevents any further supplier purchasing for the procurement.
- `FAILED_RETRYABLE` returns `NO_FALLBACK` with no candidates. The caller must retry or reconcile the current supplier according to future procurement policy.
- `NOT_STARTED` returns `NO_FALLBACK` unless there is also a stricter conflicting state. It is not treated as a failed purchase and does not trigger cross-supplier fallback.
- `FAILED_TERMINAL` is the only state that can exclude a supplier and allow progression to the next untouched eligible supplier.

If multiple attempt states conflict, the safest outcome wins: ambiguous attempts require reconciliation, succeeded attempts prevent more purchasing, and retryable attempts prevent automatic cross-supplier switching. Remaining eligible fallback candidates are always returned in deterministic routing order. If none remain, the result is `NO_FALLBACK`.

## Observability And Audit

Routing emits safe observability events for evaluation start, candidate obtained/rejected/selected, no candidate, fallback plan creation and reconciliation-required fallback blocking.

Audit events record supplier-selection success or failure and fallback blocking with policy/correlation metadata only. Product keys, credentials, customer data and payment data are never part of the routing metadata.

## Phase 04 Preparation

This foundation prepares for later real supplier connectors by keeping selection logic behind supplier-neutral contracts. Phase 04 must still add separate connector-specific authentication, API mapping, sandbox/live approval gates and acceptance tests before any real supplier can be used.
