# KS-01-02: Core Contract Skeleton

## Goal

Establish the supplier-neutral KeyCore domain and port boundaries required by the approved ports-and-adapters architecture without implementing real business workflows, supplier APIs, payments, persistence, queues, encryption or WooCommerce business behavior.

## Dependencies

- KS-01-01 completed and CI green
- ADR-0001 through ADR-0012
- Specification v1.0.2

## Scope

- Define supplier-neutral domain/value types.
- Define generic core contracts for supplier, catalog, product, offer, region compatibility, pricing, payment, procurement, fulfillment, refund, product-key vault, audit events, queue/jobs, persistence, storefront gateway, mail, invoice, monitoring/health, secret/key-management provider, and clock/time abstraction.
- Keep all contracts versionable and adapter-neutral.
- Add dependency-boundary checks where practical.
- Add automated tests for contract safety and fail-closed defaults.

## Forbidden Scope

- Real Kinguin integration.
- GAMIVO or another real supplier.
- Stripe.
- Payment processing.
- Procurement workflows.
- Catalog synchronization.
- Germany filtering business logic.
- Pricing calculations.
- PostgreSQL repositories.
- Redis queues.
- Encryption.
- Key storage.
- WordPress/WooCommerce business integration.
- Emails.
- Invoices.
- Fraud rules.
- Production deployment.
- KS-02-01 or any later phase task.

## Deliverables

- Supplier-neutral TypeScript domain contracts and value types.
- Versionable supplier port contract and neutral DTOs.
- Region evidence contract with fail-closed representation for unknown, missing, or contradictory evidence.
- Payment, procurement, fulfillment, and refund state-machine boundary types.
- KeyVault port with safe value types and no plaintext persistence encouragement.
- Audit event contract matching ADR-0009 with no product-key field.
- Storefront/WooCommerce boundary port that imports no WordPress/WooCommerce classes.
- Boundary tests/static checks proving the core imports no WordPress, WooCommerce, Kinguin, Stripe, Redis, PostgreSQL, or network clients.
- Completion report at `docs/implementation-reports/KS-01-02.md`.

## Acceptance Criteria

- Core/domain modules define generic contracts for all required port areas.
- Domain/value types include `SupplierId`, `SupplierProductId`, `SupplierOfferId`, `ProductId`, `OfferId`, `OrderId`, `OrderLineId`, `CustomerId`, `Currency`, `Money`, region evidence, `GermanyCompatibilityDecision`, `GermanyCompatibilityReasonCode`, `Platform`, `ProductType`, `Availability`, `PriceSnapshot`, `CorrelationId`, and `IdempotencyKey`.
- `GermanyCompatibilityDecision` contains exactly `ALLOWED`, `BLOCKED`, `REVIEW_REQUIRED`, and `DISABLED`.
- Unknown region data never defaults to `ALLOWED`.
- Supplier contracts include no Kinguin-specific field, type, endpoint, payload, authentication, region mapping, or purchase logic.
- Core/domain modules do not import WordPress, WooCommerce, Kinguin, Stripe, Redis, PostgreSQL clients, or network clients.
- KeyVault contracts expose no logging or audit plaintext-key field and do not implement cryptography.
- Audit contracts include the ADR-0009 fields and no product-key field.
- Contract DTO validation fails safely on malformed or unknown input where validation is introduced.
- No real supplier, live payment, production customer data, real product key, production invoice, or production deployment behavior is introduced.

## Required Tests

- Money rejects invalid currency/value combinations where applicable.
- Identifier types cannot be confused accidentally when branded types are used.
- Germany decision enum contains exactly `ALLOWED`, `BLOCKED`, `REVIEW_REQUIRED`, and `DISABLED`.
- Supplier contracts contain no Kinguin-specific field/type names.
- Core/domain modules do not import WordPress/WooCommerce.
- Core/domain modules do not import Stripe.
- Core/domain modules do not import Redis/PostgreSQL clients.
- Key-vault contracts expose no logging/audit plaintext-key field.
- Audit-event schema contains no product-key field.
- Contract DTO validation fails safely on malformed/unknown input where validation is introduced.
- Existing KS-01-01 quality gates continue to pass.

## Risk Level

Medium.

## Human Approval Requirement

No production approval required. Human review/merge required.
