# AGENTS.md – Repository-wide Codex Instructions

## Mission

Build and maintain the KeyCore Platform according to the specification in this repository. Work in small, reviewable tasks. Prefer correctness, security and auditability over speed.

## Mandatory reading order

Before changing code:

1. `PROJECT_CONSTITUTION.md`
2. this file
3. the assigned task file
4. linked requirements and ADRs
5. nearest nested `AGENTS.md`, if present

## Working rules

- Implement only the assigned task and its necessary prerequisites.
- Do not silently expand scope.
- Do not invent supplier API fields. Use interfaces, fixtures or mocks when documentation is missing.
- Keep supplier-specific mappings inside supplier adapters.
- Never add secrets, tokens, production data or real product keys.
- Use synthetic keys in tests, such as `TEST-AAAAA-BBBBB-CCCCC`.
- Do not log raw request or response bodies if they may contain keys or credentials.
- Use structured reason codes for business decisions.
- Unknown region data must result in `REVIEW_REQUIRED` or `BLOCKED`, never `ALLOWED`.
- All payment, procurement, fulfillment and refund handlers must be idempotent.
- Add or update tests for every changed business rule.
- Add migrations for schema changes.
- Update relevant documentation when behavior changes.
- Do not deploy to production.

## Preferred implementation style

- PHP 8.3+ for WordPress and WooCommerce integration.
- TypeScript on Node.js 22 LTS for standalone services unless an ADR changes this.
- PostgreSQL for platform catalog and workflow data.
- Redis for queues, locks and short-lived caching.
- REST or event-driven internal contracts with explicit versioning.
- Strict typing, linting and automated formatting.
- Dependency injection around external systems.
- Ports-and-adapters architecture for suppliers and payment integrations.

## Required checks

Before marking a task complete:

- unit tests pass;
- integration tests for affected workflows pass;
- linting and type checks pass;
- no secrets are present;
- migrations are reversible;
- acceptance criteria in the task are satisfied;
- documentation is updated;
- a concise implementation summary and remaining risks are provided.

## Definition of done

A task is done only when:

1. implementation is complete;
2. automated tests cover required behavior;
3. required checks pass;
4. documentation is current;
5. no unresolved critical security issue remains;
6. acceptance criteria are demonstrably met;
7. human approval gates are clearly identified when required.

## Pull request expectations

Every pull request must include:

- task ID and title;
- summary of changes;
- architecture impact;
- security impact;
- test evidence;
- migration notes;
- rollback notes;
- known limitations;
- screenshots for visible UI changes.
