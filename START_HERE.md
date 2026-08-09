# Start here – KeyCore Sprint 1

**Public store:** KeyPlanet  
**Initial domain:** `key-planet.de`  
**Internal platform:** KeyCore  
**Repository:** `keycore-platform`

## Sprint 1 objective

Create a reproducible development foundation on which Codex and human reviewers can safely implement KeyCore in small pull requests.

Sprint 1 is complete only when:

- the private GitHub repository exists;
- repository protection and review rules are enabled;
- the documented directory structure exists;
- the local Docker development environment starts successfully;
- WordPress and WooCommerce are available locally;
- PostgreSQL and Redis are available locally;
- CI validates formatting, tests, schemas and secrets;
- configuration uses example environment files only;
- no production credentials or real product keys are present;
- the first architecture and security checks pass.

## Execution order

1. Read `PROJECT_CONSTITUTION.md`.
2. Read `AGENTS.md`.
3. Read `docs/00-project-overview.md`.
4. Read `sprints/SPRINT-01-foundation.md`.
5. Ask Codex to perform the specification review described below.
6. Resolve critical findings before implementation.
7. Execute phase 01 tasks in numerical order.

## First Codex prompt

```text
Read PROJECT_CONSTITUTION.md, AGENTS.md, README.md, ROADMAP.md,
docs/00-project-overview.md and all ADR files.

Do not write implementation code yet.

Review this specification for:
- contradictory requirements;
- missing dependencies;
- security weaknesses;
- unsafe assumptions;
- tasks in the wrong phase;
- missing acceptance tests;
- unclear human approval gates.

Write the result only to docs/specification-review-v1.0.md.
Classify every finding as critical, high, medium or low.
Do not modify any other file.
```

## First implementation prompt after review approval

```text
Implement tasks/phase-01-foundation/01-01-repository-bootstrap.md.
Follow PROJECT_CONSTITUTION.md and AGENTS.md.
Do not implement later tasks.
Run all checks defined by the task and provide a concise completion report.
```
