# KeyCore Platform - Specification v1.0.2

Codex-ready repository specification for the modular German KeyCore platform.

## Primary Goal

Build the production-grade KeyPlanet storefront that imports the complete supplier catalog, publishes only offers that are verifiably usable in Germany, sells under the shop's own brand, automatically purchases keys from approved connected suppliers, issues invoices, delivers keys securely, and supports future suppliers through a common adapter architecture.

## Status

- Specification version: 1.0.2
- Implementation status: Specification hardening complete; development tasks ready
- Public brand: KeyPlanet
- Initial domain: key-planet.de
- Internal platform: KeyCore
- Repository: keycore-platform
- Primary supplier: Kinguin
- Future suppliers: supported through adapter interfaces
- Public market at launch: Germany
- Currency at launch: EUR
- Storefront: WordPress + WooCommerce
- Platform services: modular background services with queues, monitoring and secure key storage

## Start Here

Open `START_HERE.md` first.

1. Read `PROJECT_CONSTITUTION.md`.
2. Read `AGENTS.md`.
3. Read `docs/00-project-overview.md`.
4. Review ADRs in `decisions/architecture-decisions/`.
5. Review the applicable task file under `tasks/`.
6. Execute tasks in numerical phase order.
7. Do not start production integrations before the required approval gates are complete.

## Key Documents

- `docs/00-project-overview.md`
- `docs/dependency-matrix.md`
- `docs/acceptance-test-matrix.md`
- `docs/staging-deployment.md`
- `docs/phase-11-acceptance-matrix.md`
- `docs/e2e-acceptance-suite.md`
- `docs/testing/test-strategy.md`
- `docs/specification-review-v1.0.md`
- `docs/specification-review-v1.0.2.md`
- `decisions/architecture-decisions/`
- `tasks/`
- `docs/approvals/`

## Codex Usage

Use one task file per Codex run. Example:

> Implement `tasks/phase-01-foundation/KS-01-01-foundation-bootstrap.md`. Follow all applicable `AGENTS.md` files. Do not implement unrelated tasks. Run the required checks and report any unresolved blockers.

## Important Limitations

The final Kinguin connector must be implemented only against the current official/private Kinguin Purchase/Reseller API documentation and credentials supplied by Kinguin.

Development must use MockSupplier until the required documentation, access, contract evidence, and `REAL-SUPPLIER` approval gate are complete.

KeyCore must not invent legal or tax policy. Production sales require `TAX-INVOICE` approval based on professionally validated configuration.
