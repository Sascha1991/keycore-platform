# PRE-UAT Visible Storefront Implementation Report

## Scope

Implemented the first browser-visible KeyRaNo WordPress/WooCommerce staging
surface. No Phase-12 task, production deployment, live payment, live supplier
call or real Product Key operation was started.

## Implementation

- Expanded the WordPress plugin into bridge, publisher, account, templates,
  assets and deterministic PHP hook/publication tests.
- Added KeyRaNo branding, catalog/product facts, cart/checkout navigation,
  staging payment warning, account navigation, Meine Käufe, purchase detail,
  pending/error states, invoice/activation metadata and guest-claim shell.
- Added a staging-only Node HTTP bridge using fresh HMAC-authenticated requests,
  request-bound signed responses, exact allowed origin, immutable synthetic
  identity mappings and existing KeyCore account/vault services.
- Added nine synthetic catalog inputs, of which six are positively eligible,
  available and publishable. Blocked, review-required and unavailable inputs do
  not enter the WooCommerce manifest.
- Added encrypted synthetic-only reveal with exact owner authorization, nonce
  and same-origin enforcement, bounded rate limiting, safe audit, no-store
  response and omission tests.
- Added a reproducible staging service image and bootstrap for WooCommerce,
  synthetic users, identity mappings, front page, permalinks and catalog sync.
- Added `PRE-UAT-KEY-REAL-01` as an unexecuted, separately gated follow-up.

## Files

Changed repository governance/CI, Compose and UAT files plus `ROADMAP.md` and
`CHANGELOG.md`. Added the WordPress `includes/`, `templates/`, `assets/` and
`tests/` trees; staging storefront TypeScript modules/tests; an in-memory
encrypted-key adapter; the staging server; storefront documentation; smoke
test; blocker map; Dockerfile, build-context exclusions and follow-up task.

## Dependencies and Migration

- New dependency versions: none.
- Database migration: none. Baseline remains migration 027.
- Images remain pinned to the existing WordPress 7.0.3, WooCommerce 11.0.0,
  Node 22.22.0, PostgreSQL 16.10, Redis 7.4 and Mailpit versions.

## Verification

Local Windows verification:

- `npm run check`: passed; 743 tests passed, 124 environment-dependent tests
  skipped; format, lint, typecheck and secret scan passed.
- focused storefront/UAT: 24 passed; storefront tests pass repeatedly.
- `npm run e2e:acceptance`: 15 passed, 1 PostgreSQL test skipped.
- `npm run catalog:scale`: 10 PostgreSQL tests skipped locally.
- `npm run order:concurrency`: 38 PostgreSQL tests skipped locally.
- `npm run security:assessment`: 36 passed, 366 intentionally filtered or
  PostgreSQL-dependent tests skipped.
- `npm run recovery:exercise`: 1 passed, 1 PostgreSQL exercise skipped.
- `npm run uat:validate`: passed; human acceptance remains `PENDING` and human
  approval remains `NOT_APPROVED`.
- `npm audit --audit-level=low`: zero vulnerabilities.
- `npm run secrets:scan`: passed.
- `git diff --check`: passed.

PHP and Docker executables are not installed in the local shell. `composer
check`, PHP 8.3 syntax/tests, Compose configuration and PostgreSQL-backed gates
must therefore be confirmed by GitHub Actions before review completion.

## Acceptance Status

- Visible KeyRaNo storefront and responsive branded shell: implemented.
- Product catalog/detail, cart and checkout shell: implemented with synthetic
  data and no live payment.
- Publisher create/update/unpublish/idempotency/fail-closed rules: implemented
  and covered by PHP plus TypeScript tests.
- Account, Meine Käufe and purchase detail: implemented with exact mapped
  identity and owner-filtered KeyCore reads.
- Synthetic Key anzeigen: implemented with existing vault authorization and no
  WordPress plaintext storage.
- Cross-owner, anonymous, CSRF, rate, no-store and omission coverage:
  implemented.
- Guest claim mutation: deliberately not implemented; safe shell only.
- Invoice document: deliberately not implemented; authorized metadata shell
  only.
- Real payment/order creation and real Product Key retrieval: not implemented.

## UAT and Approvals

UAT-001, UAT-006 and UAT-015 move to `EXECUTABLE_NOW`. UAT-002, UAT-003,
UAT-004, UAT-007, UAT-012, UAT-016 and UAT-018 move to
`PARTIALLY_EXECUTABLE`. Other scenarios remain non-executable. Every changed
result remains `PENDING`; no human PASS was fabricated.

`SECURITY-READINESS` remains `NOT_APPROVED`, KS-11-07 human review remains
pending, Phase 11 remains incomplete and Phase 12 remains not started.

## Known Limitations and Human Review

- Browser screenshots and smoke-test evidence require a human-run staging
  stack because Docker is unavailable locally.
- The staging bridge uses in-memory synthetic projections and vault material;
  production requires durable deployment composition and approved KMS.
- Rate limiting is process-local and staging-only.
- Synthetic WordPress identity bootstrap requires a clean database or the
  expected user IDs; conflicts fail closed.
- Human review must verify responsive rendering, all smoke-test steps and that
  evidence fully redacts the revealed synthetic value.
