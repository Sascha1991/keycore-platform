# KS-03-02 - Multi-Supplier Routing Foundation

## Goal

Introduce the supplier-neutral routing foundation needed to evaluate more than one supplier for the same canonical product without implementing any real supplier connector.

## Scope

- Model canonical-product to supplier-offer mappings without assuming supplier product IDs or titles are globally equivalent.
- Evaluate multiple supplier candidates using supplier capabilities, health, price freshness, availability, currency comparability, Germany eligibility, operational state and policy priority.
- Provide deterministic supplier selection and safe fallback planning.
- Keep PostgreSQL as the future durable source of truth; this task only defines in-process ports and deterministic test fixtures.
- Extend observability and audit event vocabularies with safe routing events.

## Explicitly Out Of Scope

- Kinguin, GAMIVO or any other live supplier implementation.
- Production business behavior, checkout orchestration, procurement, customer delivery or Phase 04 connector work.
- Live credentials, product keys, customer data or production deployment.

## Acceptance Criteria

- At least two suppliers can be registered and evaluated for one canonical product.
- Candidate evaluation rejects blocked, disabled, out-of-stock, stale, unhealthy, unknown, rate-limited and non-comparable suppliers fail-closed.
- Germany compatibility and manual-review outcomes remain explicit.
- Currency comparison is deterministic and requires either same currency or an injected conversion boundary.
- Fallback planning never skips reconciliation after an ambiguous supplier purchase attempt.
- Observability and audit outputs contain correlation/policy metadata and no secrets.
- Contract tests verify deterministic ranking, safe fallback, region boundaries, currency handling, supplier failure isolation and no real supplier/network imports.

## Required Checks

- `npm run format`
- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run check`
- `npm audit --audit-level=low`

## Human Approval Gate

Approval is required before any later task enables a real supplier connector, live supplier API credentials, production procurement, customer delivery, or Phase 04 implementation.
