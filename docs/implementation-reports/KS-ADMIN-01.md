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

- Latest `npm run check`: passed; 791 tests passed and 131
  PostgreSQL-dependent tests skipped in the no-database quality invocation.
- Full suite with `KEYCORE_TEST_DATABASE_URL`: passed before the final five
  transport/input regression additions with 903 passed and 5 skipped. The five
  additions then passed in the focused Admin suite; the repository now contains
  913 tests in total.
- Focused Admin role/bootstrap, domain, HTTP, Compose and PostgreSQL: 25 passed
  against an isolated PostgreSQL 16 container.
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

The Human-UAT deployment exposed that the Admin service inherited the shared
image's Storefront default command. The staging Compose service now explicitly
starts `scripts/staging-admin-server.ts`; a focused regression test preserves
the Storefront default, the separate Admin bootstrap command and the absence of
the Storefront origin variable from the Admin service.

The following browser login retest found that `Referrer-Policy: no-referrer`
caused the HTML form request to arrive with `Origin: null`, which the strict
origin guard correctly rejected. Admin responses now use the restrictive
`same-origin` policy so same-origin form posts retain their concrete Origin.
Exact-origin validation remains unchanged; null, missing and cross-origin values
remain rejected. Human acceptance is still `IN_REVIEW / NOT_APPROVED` pending a
new manual staging retest.

The subsequent Human-UAT passed Admin login, Dashboard, order listing and
filtering, order detail, fail-closed Product-Key handling, neutral missing-order
responses, unauthenticated denial, logout and re-bootstrap login. It also found
a responsive usability failure on `/admin/orders` at approximately 500 px: the
desktop table forced horizontal page scrolling and made long order/customer
references difficult to use. The desktop table remains unchanged at normal
widths; at 768 px and below, the same semantic rows now become labelled stacked
order entries containing Order ID, customer, product, status, amount and date.
Filters, order details, navigation and login also reflow without requiring
page-level horizontal scrolling, and long non-secret references wrap safely.
No authentication, authorization, filtering, pagination, audit or Product-Key
behavior changed. Human acceptance remains `IN_REVIEW / NOT_APPROVED` until the
responsive staging views are manually retested, so PR #52 must not be merged.

Human-UAT then confirmed the corrected responsive order list and detail views,
but exposed a staging testability gap: the supported bootstrap could create only
`PROJECT_OWNER`. Restricted-role and direct-URL enforcement therefore could not
be exercised without unsupported manual database changes. The staging-only
bootstrap now accepts `KEYRANO_STAGING_ADMIN_ROLE`, constrained to the
authoritative existing roles `PROJECT_OWNER`, `OPERATIONS`, `SUPPORT`, `FINANCE`
and `SECURITY_AUDITOR`. An absent variable still selects `PROJECT_OWNER`; empty,
malformed or unknown values fail with `STAGING_ADMIN_ROLE_INVALID` rather than
falling back.

The bootstrap keeps one deterministic synthetic identity. In one transaction it
locks that identity, revokes every other active role assignment with
`revoked_at`, activates only the selected role, revokes every active synthetic
session and issues one hash-only session. Role history is retained and active
privileges cannot accumulate. A role switch must also use a newly generated raw
session code; attempting to reuse a session hash from the prior role fails with
`STAGING_ADMIN_ROLE_SWITCH_REQUIRES_SESSION_ROTATION` and rolls back the entire
change. Repeating the same role and session code remains idempotent. No
production runtime reads this variable, and role/capability mappings are
unchanged.

### Safe SUPPORT Human-UAT procedure

On the staging server, first deploy the current PR branch:

```bash
cd ~/keyrano/keycore-platform
git fetch origin
git switch feature/ks-admin-01-secure-admin-orders
git pull --ff-only
sudoedit .env.staging.server
```

Set `KEYRANO_STAGING_ADMIN_ROLE=SUPPORT` and replace
`KEYRANO_STAGING_ADMIN_SESSION_CODE` with a newly generated value of at least 32
characters. Generate, inspect and use that value only on the staging server and
in the login form. Never paste session codes, cookies, passwords, HMACs, nonces,
Authorization headers or other secrets into chat, tickets, command output or
logs. Then run the supported bootstrap:

```bash
cd ~/keyrano/keycore-platform
sudo docker compose \
  --env-file .env.staging.server \
  -f infra/docker/compose.staging.yaml \
  up --build --force-recreate keycore-admin-bootstrap
```

Open `https://admin.staging.keyrano.de/admin/login`, enter the new session code
locally and confirm the identity displays only `SUPPORT`. Dashboard, order list,
filters and order detail should remain available because SUPPORT has
`ORDER_VIEW`. Attempt the existing Product-Key POST control from an order detail
page and confirm the server denies it without revealing material; if the button
is disabled because no encrypted material exists, the tester may remove only
the button's local `disabled` attribute in browser developer tools and submit
the unchanged same-origin form. This uses its existing CSRF field without
copying it and verifies that UI state cannot bypass server-side capability
enforcement. Direct unauthenticated and malformed URLs must retain their neutral
denial behavior.

After the restricted-role review, restore the default owner fixture with another
new local session code:

```bash
cd ~/keyrano/keycore-platform
sudoedit .env.staging.server
```

Set `KEYRANO_STAGING_ADMIN_ROLE=PROJECT_OWNER`, rotate
`KEYRANO_STAGING_ADMIN_SESSION_CODE` again, save locally, and run:

```bash
cd ~/keyrano/keycore-platform
sudo docker compose \
  --env-file .env.staging.server \
  -f infra/docker/compose.staging.yaml \
  up --build --force-recreate keycore-admin-bootstrap
```

The SUPPORT session must then be rejected, and the new local code must identify
only `PROJECT_OWNER`. These steps provide testability only; Human Acceptance
remains `IN_REVIEW / NOT_APPROVED` until Sascha records the result.

## Human review

Focused browser UAT is still required for restricted-role/direct-URL enforcement
and any remaining role-denial/pagination scenarios not covered by the completed
Human-UAT. Production IdP/MFA and the future real-reveal design require separate
explicit security approval. KS-11-07 remains incomplete and
`SECURITY-READINESS` remains `NOT_APPROVED`.
