# AGENTS.md - Repository-wide Codex Instructions

## Mission

Build and maintain the KeyCore Platform according to the specification in this repository. Work in small, reviewable tasks. Prefer correctness, security and auditability over speed.

## Mandatory Reading Order

Before changing code or specification behavior:

1. `PROJECT_CONSTITUTION.md`
2. this file
3. `docs/00-project-overview.md`
4. the assigned task file
5. linked requirements and ADRs
6. nearest nested `AGENTS.md`, if present

## Working Rules

- Implement only the assigned task and its necessary prerequisites.
- Do not silently expand scope.
- Do not invent supplier API fields. Use interfaces, fixtures or mocks when documentation is missing.
- Keep supplier-specific mappings inside supplier adapters.
- Never add secrets, tokens, production data or real product keys.
- Use synthetic keys in tests, such as `TEST-AAAAA-BBBBB-CCCCC`.
- Do not log raw request or response bodies if they may contain keys or credentials.
- Use structured reason codes for business decisions.
- Germany compatibility decisions are exactly `ALLOWED`, `BLOCKED`, `REVIEW_REQUIRED`, and `DISABLED`.
- Only `ALLOWED` offers may be published or sold.
- `REVIEW_REQUIRED` is fail-closed and must not be published.
- All payment, procurement, fulfillment and refund handlers must be idempotent.
- Add or update tests for every changed business rule.
- Add reversible migrations for schema changes.
- Update relevant documentation when behavior changes.
- Update `CHANGELOG.md` and specification version when applicable.
- Do not deploy to production.
- Agents cannot approve their own human approval gates.

## Preferred Implementation Style

- PHP 8.3+ for WordPress and WooCommerce integration.
- TypeScript on Node.js 22 LTS for standalone services unless an ADR changes this.
- PostgreSQL 16+ for platform catalog and workflow data.
- Redis 7+ for queues, locks and short-lived caching.
- REST or event-driven internal contracts with explicit versioning.
- Strict typing, linting and automated formatting.
- Dependency injection around external systems.
- Ports-and-adapters architecture for suppliers and payment integrations.

## Required Checks

Before marking a task complete:

- unit tests pass;
- integration tests for affected workflows pass;
- supplier contract tests pass where adapter behavior is affected;
- E2E tests pass where customer-visible workflows are affected;
- security tests pass where secrets, keys, payments, authorization, audit, or approvals are affected;
- linting and type checks pass;
- no secrets are present;
- migrations are reversible;
- acceptance criteria in the task are satisfied;
- documentation is updated;
- `CHANGELOG.md` and specification version are updated when applicable;
- required human approval gates are identified and approval artifacts exist where required;
- a concise implementation summary and remaining risks are provided.

## Definition of Done

A task is done only when:

1. implementation or specification changes are complete within the assigned scope;
2. automated tests cover required behavior;
3. required checks pass;
4. documentation is current;
5. `CHANGELOG.md` and specification version updates are complete when applicable;
6. no secrets, real product keys, tokens, production data, or unnecessary personal data are present;
7. no unresolved critical security issue remains;
8. acceptance criteria are demonstrably met;
9. human approval gates are clearly identified, and required artifacts are present when applicable;
10. agents have not approved their own gates.

## Pull Request Expectations

Every pull request must include:

- task ID and title;
- summary of changes;
- architecture impact;
- security impact;
- test evidence;
- migration notes;
- rollback notes;
- documentation and versioning notes;
- approval-gate impact;
- known limitations;
- screenshots for visible UI changes.
