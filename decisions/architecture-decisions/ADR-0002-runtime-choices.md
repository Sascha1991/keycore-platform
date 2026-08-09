# ADR-0002: Runtime Choices

Status: Accepted

## Decision

Use PHP 8.3+ for WordPress and WooCommerce integration and TypeScript on Node.js 22 LTS for standalone services unless a future ADR changes this decision.

## Consequences

- Runtime versions must be pinned in local, CI, staging, and production environments before implementation tasks complete.
- Cross-runtime contracts must be versioned and tested.
- Secrets, product keys, and customer data handling rules apply equally to both runtimes.
