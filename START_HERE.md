# Start Here - KeyCore Specification v1.0.2

**Public store:** KeyPlanet
**Initial domain:** `key-planet.de`
**Internal platform:** KeyCore
**Repository:** `keycore-platform`

## Objective

Use this repository as the authoritative specification for building KeyCore safely in small, reviewable tasks.

## Reading Order

1. Read `PROJECT_CONSTITUTION.md`.
2. Read `AGENTS.md`.
3. Read `README.md`.
4. Read `ROADMAP.md`.
5. Read `docs/00-project-overview.md`.
6. Read all ADRs in `decisions/architecture-decisions/`.
7. Read `docs/dependency-matrix.md`.
8. Read `docs/acceptance-test-matrix.md`.
9. Read the assigned task file under `tasks/`.

## Execution Order

Execute development tasks in phase order. Do not begin `KS-01-01` until Specification Review v1.0.2 has been reviewed and any release-blocking specification findings have been resolved or explicitly accepted by the appropriate human approval gate.

## First Implementation Prompt

```text
Implement tasks/phase-01-foundation/KS-01-01-foundation-bootstrap.md.
Follow PROJECT_CONSTITUTION.md and AGENTS.md.
Do not implement later tasks.
Run all checks defined by the task and provide a concise completion report.
```

## Production Safety

Do not start real supplier ordering, live payments, production invoice issuance, or production deployment before the required approval artifacts exist under `docs/approvals/`.
