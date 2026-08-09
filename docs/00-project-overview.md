# KeyCore Platform Overview

Specification version: 1.0.2

KeyCore is the internal platform behind the KeyPlanet storefront at `key-planet.de`. The platform imports supplier catalogs, publishes only offers that are positively verified as usable in Germany, sells under the KeyPlanet brand, procures keys after confirmed payment, issues invoices, and delivers product keys through a secure customer account experience.

## Scope

KeyCore covers:

- WordPress and WooCommerce storefront integration.
- Supplier adapters behind a common port.
- Catalog import, normalization, Germany compatibility decisions, pricing, checkout orchestration, procurement, fulfillment, refunds, invoices, customer key access, audit trails, monitoring, and operational controls.
- MockSupplier development and contract testing before real supplier ordering is approved.

KeyCore does not define legal, tax, payment, supplier, or marketplace policy by invention. Production behavior that depends on external policy requires explicit human approval and professionally validated configuration where applicable.

## Non-Negotiable Rules

The project constitution is authoritative. In particular:

- Product keys are encrypted at rest and never exposed in logs, traces, analytics, exceptions, queues, caches, backups, or test snapshots.
- Only `ALLOWED` Germany compatibility decisions may be sold or published.
- `REVIEW_REQUIRED`, `BLOCKED`, and `DISABLED` are fail-closed.
- Payment, procurement, fulfillment, and refund operations are idempotent.
- Ambiguous supplier purchase timeouts must reconcile before another purchase attempt.
- Production deployment and non-mock supplier ordering require human approval.

## Architecture Summary

The platform uses ports-and-adapters boundaries:

- Generic core: product, offer, pricing, order, payment, procurement, fulfillment, refund, audit, authorization, and approval concepts.
- Supplier adapters: supplier-specific authentication, mapping, capability discovery, ordering, polling/webhooks, key retrieval, and refunds.
- Storefront adapter: WooCommerce product, order, account, and payment-facing integration.
- Infrastructure adapters: PostgreSQL, Redis, mail, invoice, monitoring, and secret-management integrations.

Supplier-specific behavior must not leak into the generic core.

## Secure Key Vault

Product keys are stored only in a secure key vault using envelope encryption and authenticated encryption. Each stored secret has a unique data encryption key. Master keys live outside the database and Git. Plaintext may exist only temporarily in process memory after authorization checks, and every reveal is audited without logging the key.

Backups must contain only encrypted secret payloads. Restore procedures must verify that master-key access remains external and controlled. Automated canary leakage tests must fail the release if synthetic key material appears in logs, traces, analytics, queues, caches, exceptions, snapshots, or backups.

## State Machines

Every order line has an immutable internal order-line UUID. That UUID is the idempotency root for payment confirmation, procurement, fulfillment, and refund workflows. Provider event IDs must be unique and replay-safe. Ambiguous states are reconciled by durable jobs and eventually enter `MANUAL_REVIEW` if no safe automated conclusion exists.

Payment states:

- `CREATED`
- `AWAITING_PROVIDER`
- `AUTHORIZED`
- `CAPTURED`
- `FAILED`
- `CANCELED`
- `REFUND_PENDING`
- `REFUNDED`
- `PARTIALLY_REFUNDED`
- `DISPUTED`
- `MANUAL_REVIEW`

Procurement states:

- `NOT_STARTED`
- `ELIGIBILITY_CHECKED`
- `PURCHASE_REQUESTED`
- `PURCHASE_CONFIRMED`
- `AMBIGUOUS_TIMEOUT`
- `FAILED_RETRYABLE`
- `FAILED_FINAL`
- `MANUAL_REVIEW`

Fulfillment states:

- `NOT_READY`
- `READY_FOR_KEY_RETRIEVAL`
- `KEY_RETRIEVED`
- `KEY_STORED`
- `CUSTOMER_NOTIFIED`
- `CUSTOMER_REVEALED`
- `FAILED_RETRYABLE`
- `FAILED_FINAL`
- `MANUAL_REVIEW`

Refund states:

- `NOT_REQUESTED`
- `REQUESTED`
- `SUPPLIER_CLAIM_PENDING`
- `PAYMENT_REFUND_PENDING`
- `REFUNDED`
- `PARTIALLY_REFUNDED`
- `REJECTED`
- `DISPUTED`
- `MANUAL_REVIEW`

No procurement may start from unconfirmed payment. Supplier purchases must be deduplicated by order-line UUID and supplier idempotency references where supported. If a supplier purchase times out ambiguously, reconciliation must run before another purchase is attempted.

## Germany Compatibility Engine

Valid decisions are exactly:

- `ALLOWED`
- `BLOCKED`
- `REVIEW_REQUIRED`
- `DISABLED`

Only `ALLOWED` may be published or sold. `REVIEW_REQUIRED` is fail-closed and must not be published.

Structured blocking evidence always wins over permissive evidence. Free-text product titles alone are never sufficient for `ALLOWED`.

Decision rules:

| Evidence                                                 | Decision          | Reason code                     |
| -------------------------------------------------------- | ----------------- | ------------------------------- |
| Explicit DE allow with no blocking evidence              | `ALLOWED`         | `REGION_DE_ALLOWED`             |
| Explicit DE exclusion                                    | `BLOCKED`         | `REGION_DE_EXCLUDED`            |
| EU allow with no DE exclusion                            | `ALLOWED`         | `REGION_EU_ALLOWED`             |
| Global allow with no blocking evidence                   | `ALLOWED`         | `REGION_GLOBAL_ALLOWED`         |
| Region Free with no blocking evidence                    | `ALLOWED`         | `REGION_FREE_ALLOWED`           |
| Incompatible region such as US, LATAM, CIS, or Asia only | `BLOCKED`         | `REGION_INCOMPATIBLE`           |
| VPN activation required                                  | `BLOCKED`         | `VPN_ACTIVATION_BLOCKED`        |
| Foreign-account requirement                              | `BLOCKED`         | `FOREIGN_ACCOUNT_REQUIRED`      |
| Missing structured evidence                              | `REVIEW_REQUIRED` | `REGION_EVIDENCE_MISSING`       |
| Contradictory structured evidence                        | `REVIEW_REQUIRED` | `REGION_EVIDENCE_CONTRADICTORY` |
| Unknown structured region value                          | `REVIEW_REQUIRED` | `REGION_UNKNOWN_VALUE`          |
| Manually disabled offer or supplier                      | `DISABLED`        | `MANUAL_OR_SUPPLIER_DISABLED`   |

Revalidation triggers include supplier catalog updates, region metadata changes, title or activation-text changes, supplier adapter changes, policy changes, manual review actions, and periodic scheduled rechecks.

## Kinguin Integration Boundary

Development must use `MockSupplier` until current official/private Kinguin Purchase/Reseller API documentation and required access exist. The project must not guess endpoints, authentication, payloads, pagination, rate limits, region semantics, purchase semantics, webhook signatures, key delivery, refund behavior, or tax/fee fields.

`REAL-SUPPLIER` human approval is required before any non-mock ordering.

## Authorization Model

Roles:

- `PROJECT_OWNER`: owns approvals, release readiness, policy decisions, and emergency overrides.
- `OPERATIONS`: manages catalog, outages, queues, supplier health, and operational runbooks.
- `SUPPORT`: handles customer support cases with least-privilege access.
- `FINANCE`: handles payments, refunds, invoice workflows, and dispute evidence.
- `SECURITY_AUDITOR`: reads audit/security evidence without customer key plaintext access.

Customer key access must verify authenticated identity, exact order-line ownership, eligible order and fulfillment state, and authorization immediately before decryption. Cross-customer key access must always be denied.

## Outage Behavior

Unsafe mutations fail closed.

- Supplier outage: disable new procurement for affected supplier, keep paid orders pending reconciliation, do not duplicate ambiguous purchases.
- Payment outage: block new payment confirmation-dependent mutations and reconcile provider events later.
- Mail outage: keep fulfillment state durable, retry notification, allow authorized account access if key is safely stored.
- Invoice outage: block production sales unless approved fallback exists; queue invoice creation only when legally permitted.
- Redis/queue outage: stop workflows requiring locks or durable async processing; do not process purchase/refund mutations without idempotency guarantees.
- PostgreSQL outage: disable checkout/procurement mutations and serve only explicitly safe read-only surfaces.
- WooCommerce synchronization outage: stop publication changes and reconcile catalog/order state before resuming.

## Tax and Invoicing Boundary

KeyCore must not invent legal or tax policy. Production sales require `TAX-INVOICE` approval based on professionally validated configuration for VAT, invoices, correction invoices, cancellation invoices, required customer data, retention, and invoice provider behavior.

## Refund and Dispute Ownership

- Phase 04 defines supplier refund capability and supplier-specific claim interfaces.
- Phase 07 owns durable refund orchestration and payment-provider execution.
- Phase 09 owns support cases, fraud investigation, dispute evidence, and supplier claim workflow.

## Documentation and Versioning Policy

Requirement or externally visible behavior changes require applicable documentation updates, CHANGELOG updates, and specification version updates when the change alters normative behavior or approval requirements.
