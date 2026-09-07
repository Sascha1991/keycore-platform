# KS-ADMIN-02 Implementation Report

## Scope and architecture

KS-ADMIN-02 extends the existing server-rendered Node Admin and PostgreSQL
authority. It does not add authentication, passwords or a parallel identity
system. The existing `admin_identities`, `admin_role_assignments`,
`admin_sessions` and central `audit_events` remain authoritative.

The Admin now provides capability-protected staff list/detail, create, status,
single-role assignment, additive individual permission grants and a bounded
audit list. Every route is server-authorized. Mutations remain POST-only with
exact Origin, exact form shape and path-bound HMAC CSRF validation.

## Database changes

Reversible migration 029 adds bounded optional first/last name, employee number
and normalized email fields to existing identities. It adds historized
`admin_permission_grants`, enforces allowlisted capability values, one active
grant per identity/capability and one active role per identity. Existing
synthetic KS-ADMIN-01 identities remain compatible.

## Roles and permissions

The five existing roles are unchanged. `PROJECT_OWNER` has all current Admin
capabilities; restricted roles keep their prior least-privilege defaults.
Effective permissions equal role defaults plus active additive grants. Revoked
grants are historical only. KS-ADMIN-02 deliberately has no individual deny
override.

Sensitive capabilities are `PRODUCT_KEY_REVEAL`, `STAFF_MANAGE`, `ROLE_ASSIGN`,
`PERMISSION_OVERRIDE_MANAGE` and `SENSITIVE_OPERATION`. Sensitive grants require
a `PROJECT_OWNER` and cannot be self-granted. Product-Key decryption remains
disconnected and fail-closed.

## Lifecycle and audit safety

Role changes, disable and all permission changes revoke active target sessions.
The final active owner cannot be disabled or demoted; an advisory transaction
lock makes that check concurrency-safe. Mutations and success/denial audit rows
share one transaction, so audit insert failure rolls back the state change.

Audit results use descending signed keyset pagination with a page bound of 50.
Filters are exact and parameterized. The UI displays only allowlisted safe
metadata fields and never raw JSON, session material, credentials, request
headers, CSRF values, invoice bytes or Product Keys.

## Main files

- `packages/platform/src/admin/admin-staff.ts`
- `packages/platform/src/admin/admin-orders.ts`
- `infra/postgres/admin-repositories.ts`
- `infra/postgres/migrations/029_admin_staff_roles_permissions.*.sql`
- `infra/admin/admin-http.ts`
- `apps/admin/assets/admin.css`
- `scripts/staging-admin-server.ts`

## Verification

- `npm run check`: passed with 799 tests passed and 133 PostgreSQL/Redis-gated
  tests skipped; formatting, lint, type checking and secret scan passed.
- Focused Admin authentication/domain/HTTP tests: 24 passed.
- PostgreSQL Admin/staging migration tests: 5 passed locally against PostgreSQL 16.
- DB-enabled repository suite before the final two unit regressions: 928 passed
  and 2 unrelated existing tests hit
  their hard 5-second timeout on the slow local Docker volume. No Admin test
  failed; CI is the authoritative clean-service run.
- Security assessment: 60 passed, 345 intentionally excluded by the focused
  assessment configuration.
- UAT package structure: passed; Human acceptance remains `IN_REVIEW` and
  human approval remains `NOT_APPROVED`.
- Development and staging Compose validation: passed.
- PHP 8.3 syntax, Composer validation and WordPress adapter tests: passed in the
  Composer container.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- Secret scan and `git diff --check`: passed.
- The recovery baseline and exercise are updated through migration 029. Native
  `pg_dump`/`pg_restore` tools are not installed on this Windows host, so the
  complete recovery exercise remains delegated to the clean GitHub Actions job.

## Known limitations and human review

- Managed profiles do not receive passwords, session codes or production login access.
- Production IdP/SSO, MFA, provisioning, offboarding governance and network policy remain open.
- Product-Key decryption remains disabled.
- Human UAT was executed and remains `IN_REVIEW / NOT_APPROVED`: ten scenarios
  are `PASS`, while role-change session revocation and disabled-staff
  session/direct-access revocation are `PARTIAL` because the available
  synthetic profile has no login mechanism or active session. See
  `docs/uat/ks-admin-02-human-uat.md`.
- KS-11-07 remains incomplete and `SECURITY-READINESS` remains `NOT_APPROVED`.
- No production readiness, production deployment or live Stripe/Kinguin approval is claimed.
