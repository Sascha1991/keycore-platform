# KS-ADMIN-01 Implementation Report

## Outcome

Implemented a separate secure Admin foundation with Dashboard and Bestellungen,
PostgreSQL-backed identities/roles/hash-only sessions, deterministic order
search/detail projections, audited authorization and a fail-closed Product-Key
access shell. No production deployment or real key reveal was performed.

## Files and components

- Domain/application: `packages/platform/src/admin/admin-orders.ts`
- HTTP/UI: `infra/admin/admin-http.ts`, `apps/admin/assets/admin.css`
- Persistence: `infra/postgres/admin-repositories.ts`, migration 028
- Staging: `scripts/staging-admin-bootstrap.ts`,
  `scripts/staging-admin-server.ts`, Compose/env/Dockerfile updates
- Tests: Admin domain, HTTP and PostgreSQL persistence suites
- Documentation: Admin architecture, task, Roadmap, Changelog and this report

## Security decisions

- Raw sessions remain outside PostgreSQL and logs; only keyed HMAC hashes are
  persisted.
- Customer/WordPress authentication cannot satisfy Admin authentication.
- Actual fulfillment secret decryption is not connected. The separate
  capability-controlled POST boundary always fails closed and audits the attempt.
- Invoice status is `NOT_AVAILABLE` because the repository has no authoritative
  persisted invoice projection suitable for an Admin read model.
- Admin read audit failure prevents the protected result from returning.

## Migration

Migration 028 adds `admin_identities`, `admin_role_assignments`, `admin_sessions`
and bounded order lookup indexes. Its down migration removes only these additions.
No prior migration or business-state constraint was changed.

## Verification

The completed local checks were:

- `npm run check`: passed; 783 tests passed and 130 PostgreSQL-dependent tests
  skipped in the no-database quality invocation.
- Full suite with `KEYCORE_TEST_DATABASE_URL`: passed before the final five
  transport/input regression additions with 903 passed and 5 skipped. The five
  additions then passed in the focused Admin suite; the repository now contains
  913 tests in total.
- Focused Admin domain/HTTP: 14 passed.
- Focused PostgreSQL Admin/staging/full-migration persistence: 29 passed.
- Focused existing account/checkout regression set: 54 passed.
- PHP 8.3 syntax and WordPress adapter: passed in the PHP 8.3 container.
- Composer strict validation: passed in the Composer 2 container.
- Development and staging Compose configuration: passed.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- Secret scan, UAT structure validation and `git diff --check`: passed.

PostgreSQL tests exercise migration 028, hash-only sessions, roles, exact email
search, safe detail hydration and the complete migration rollback/reapply chain.
Database-enabled Vitest runs use one file worker to avoid unrelated isolated
schema migrations exhausting a shared CI PostgreSQL service; concurrency inside
the persistence tests remains enabled and unchanged.

The repository recovery exercise and its current runbook now validate migration
baseline 028, all 28 migration records and the three restored Admin tables. This
keeps the isolated backup/restore gate aligned with the Admin schema addition
without weakening any recovery or database invariant.

## Human review

Focused browser UAT is still required for login, role-denial UX, search,
pagination, order details, responsive layout and the fail-closed reveal shell.
Production IdP/MFA and the future real-reveal design require separate explicit
security approval. KS-11-07 remains incomplete and `SECURITY-READINESS` remains
`NOT_APPROVED`.
