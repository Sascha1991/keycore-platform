# Core Contract Skeleton

KS-01-02 establishes supplier-neutral TypeScript contracts for the KeyCore core. These contracts are intentionally adapter-free and contain no production workflow implementation.

## Boundaries

Core modules under `packages/platform/src/domain` and `packages/platform/src/ports` may define:

- immutable value and DTO types;
- versionable ports;
- small validation helpers that fail closed;
- state names and references from accepted ADRs.

Core modules must not import:

- WordPress or WooCommerce;
- Kinguin or any other real supplier;
- Stripe or another payment provider SDK;
- Redis or PostgreSQL clients;
- network clients or HTTP modules.

Adapters added by later tasks must depend inward on these contracts.

## Contract Areas

The skeleton covers:

- supplier;
- catalog;
- product;
- offer;
- region compatibility;
- pricing;
- payment;
- procurement;
- fulfillment;
- refund;
- product-key vault;
- audit events;
- queue/jobs;
- persistence;
- storefront gateway;
- mail;
- invoice;
- monitoring/health;
- secret/key-management provider;
- clock/time abstraction.

## Safety Notes

- Germany compatibility decisions are exactly `ALLOWED`, `BLOCKED`, `REVIEW_REQUIRED`, and `DISABLED`.
- Unknown, missing, or contradictory region evidence validates to `REVIEW_REQUIRED`; it never defaults to `ALLOWED`.
- Product-key vault contracts use short-lived secret material inputs and do not implement cryptography or persistence.
- Audit metadata validation rejects forbidden sensitive field names and the audit schema contains no product-key field.
- Supplier contracts are generic and contain no Kinguin-specific fields, endpoints, authentication, payloads, or purchase logic.
