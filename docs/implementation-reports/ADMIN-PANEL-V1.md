# Admin Panel V1 Implementation Report

## Delivered scope

Admin Panel V1 turns the existing secure Admin foundation into a German,
responsive operations workspace backed by existing KeyCore repositories and
domain services. It adds permission-filtered customer, catalog, supplier,
support, finance, reporting, fraud-read, notification and operations-control
surfaces. Orders now expose the complete payment, risk, procurement,
fulfillment and overall state without exposing secret material.

The customer account gains an ownership-scoped Support journey through the
existing signed WordPress bridge. Admin support staff can distinguish
customer-visible messages from internal notes and perform only domain-valid,
version-aware transitions.

## Security and architecture

- PostgreSQL remains authoritative; Redis is not used for business state.
- Existing hash-only Admin sessions and server-side capabilities protect every
  route.
- Mutations retain exact Origin, exact form, path-bound CSRF, explicit
  confirmation, optimistic concurrency and audit controls.
- Operational pause/resume reuses `OperationsControlService`; no parallel
  emergency-control model was introduced.
- Lists use bounded parameterized queries and signed, filter-bound keyset
  cursors.
- Product Keys, claim codes, session material, credentials, provider payloads
  and raw audit metadata never enter the Admin or Support views.
- Monetary formatting uses exact minor-unit `BigInt` arithmetic.

## Database and dependencies

Migration 030 expands the check-constrained Admin permission-grant allowlist
for the new read/manage capabilities. The down migration removes incompatible
new grants before restoring the prior allowlist. No new external dependency was
added. Vitest is patched from 4.1.10 to 4.1.11 to resolve
GHSA-82fw-gwwq-j7x9. The recovery and staging migration baseline advances from
029 to 030.

## UAT impact

No Human-UAT result was changed. UAT-014 and UAT-017 become technically ready
for human execution after approved staging deployment. UAT-008, UAT-010,
UAT-011, UAT-013 and UAT-016 remain blocked for the reasons recorded in
`docs/uat/admin-panel-v1-readiness.md`.

Discount/campaign mutation, refund initiation, procurement reconciliation,
fraud resolution, registration/verification and production IdP transport were
not invented. They require separate authoritative tasks.

## Main files

- `packages/platform/src/admin/admin-operations.ts`
- `infra/postgres/admin-operations-repository.ts`
- `infra/admin/admin-http.ts`
- `infra/admin/admin-support-operations.ts`
- `infra/admin/admin-operations-control.ts`
- `apps/admin/assets/admin.css`
- `infra/storefront/staging-browser-adapter.ts`
- `apps/wordpress/keycore-platform/templates/account-support*.php`
- `infra/postgres/migrations/030_admin_panel_capabilities.*.sql`

## Validation

- Focused Admin, Support and Storefront: 49 tests passed.
- Local `npm run check`: 826 passed, 140 service-gated tests skipped; format,
  lint, typecheck and secret scan passed.
- GitHub `npm run check`: all 966 tests passed against PostgreSQL and Redis.
- CI security assessment: 60 passed, 345 intentionally excluded by the focused
  configuration.
- CI E2E acceptance: all 16 tests passed.
- UAT structure: 18 scenarios and five omission-first evidence artifacts valid;
  Human Acceptance remains `IN_REVIEW` and Human Approval `NOT_APPROVED`.
- Development and staging Compose configuration: passed.
- `npm audit --audit-level=low`: zero vulnerabilities after the Vitest patch.
- `git diff --check`: passed.

The local Docker engine did not become available during final verification.
GitHub Actions therefore supplied the authoritative clean-service result:
PostgreSQL/Redis persistence, migration 030 rollback, PHP/Composer, both
Compose definitions, 38 concurrency tests, the catalog scale gate and the
REC-001 through REC-018 native restore exercise all passed in Quality Gates run
34340644493.

## Approval state

The existing KS-11-07 result remains 11/18 PASS. Human Acceptance remains
`IN_REVIEW`, Human Approval remains `NOT_APPROVED`, and `SECURITY-READINESS`
remains `NOT_APPROVED`. No production deployment, live payment, live supplier
operation or real Product Key is authorized by this work.
