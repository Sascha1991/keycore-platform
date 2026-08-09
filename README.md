# KeyCore Platform – Specification v1.0

Codex-ready repository specification for a modular German keycore platform.

## Primary goal

Build the production-grade KeyPlanet storefront that imports the complete supplier catalog, publishes only offers that are verifiably usable in Germany, sells under the shop's own brand, automatically purchases keys from connected suppliers, issues invoices, delivers keys securely, and supports future suppliers through a common adapter architecture.

## Status

- Specification version: 1.0.1 (Sprint 1 bootstrap).1 (Sprint 1 bootstrap)
- Implementation status: Sprint 1 ready
- Public brand: KeyPlanet
- Initial domain: key-planet.de
- Internal platform: KeyCore
- Public brand: KeyPlanet
- Initial domain: key-planet.de
- Internal platform: KeyCore
- Primary supplier: Kinguin
- Future suppliers: supported through adapter interfaces
- Public market at launch: Germany
- Currency at launch: EUR
- Storefront: WordPress + WooCommerce
- Platform services: modular background services with queues, monitoring and secure key storage

## Start here

Open `START_HERE.md` first.


1. Read `PROJECT_CONSTITUTION.md`.
2. Read `AGENTS.md`.
3. Read `docs/00-project-overview.md`.
4. Review ADRs in `decisions/architecture-decisions/`.
5. Execute tasks in numerical phase order.
6. Do not start production integrations before the required approval gates are complete.

## Codex usage

Use one task file per Codex run. Example:

> Implement `tasks/phase-01-foundation/01-01-repository-bootstrap.md`. Follow all applicable `AGENTS.md` files. Do not implement unrelated tasks. Run the required checks and report any unresolved blockers.

## Important limitation

The final Kinguin connector must be implemented against the current private API documentation and credentials supplied by Kinguin. The repository contains a mock supplier so that the platform can be built and tested before the production API is available.
