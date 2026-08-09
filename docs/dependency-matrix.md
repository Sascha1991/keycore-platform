# Dependency Matrix

Specification version: 1.0.2

| Dependency | Local | CI | Staging | Production | Required by phase | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| PHP | PHP 8.3+ | PHP 8.3+ | PHP 8.3+ | PHP 8.3+ | 01 | Used for WordPress/WooCommerce integration. |
| Node.js | Node.js 22 LTS | Node.js 22 LTS | Node.js 22 LTS | Node.js 22 LTS | 01 | Used for standalone services and tooling. |
| WordPress | Local dev instance | Test fixture or container | Managed staging instance | Managed production instance | 01, 05, 07, 08 | Version must be pinned before implementation. |
| WooCommerce | Local plugin | Test fixture or container | Staging plugin | Production plugin | 01, 05, 07, 08 | Product, order, account, and payment-facing integration. |
| PostgreSQL | PostgreSQL 16+ | PostgreSQL 16+ service | PostgreSQL 16+ managed DB | PostgreSQL 16+ managed DB | 02 | Platform catalog, workflow, audit, and idempotency data. |
| Redis | Redis 7+ | Redis 7+ service | Redis 7+ managed service | Redis 7+ managed service | 02 | Queues, locks, short-lived cache, and rate limiting. |
| Stripe | Mock or sandbox | Mock/sandbox | Stripe test mode | Stripe live mode | 07 | `LIVE-PAYMENTS` approval required before live mode. |
| Mail provider | Local sink | Test sink | Sandbox provider | Approved provider | 08 | No secrets in logs or fixtures. |
| Invoice component | Mock adapter | Test adapter | Sandbox/provider test config | Professionally validated config | 07, 08, 12 | `TAX-INVOICE` approval required before production sales. |
| Monitoring | Local logs and test alerts | Test checks | Staging dashboards/alerts | Production dashboards/alerts | 10 | Must redact secrets and product keys. |
| Kinguin | Not used; MockSupplier only | Not used; MockSupplier only | Disabled until approved | Disabled until approved | 04 | `REAL-SUPPLIER` approval and official/private docs required. |

## Environment Rules

- Local and CI must never require real supplier credentials, live payment credentials, real product keys, or customer data.
- Staging may use sandbox credentials only after the relevant approval gate exists.
- Production dependencies require documented ownership, credentials stored outside Git, monitoring, rollback notes, and approval artifacts in `docs/approvals/`.
- Missing, incompatible, or unapproved dependencies must fail closed for unsafe mutations.
