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

Initial local Windows verification:

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

The original implementation run did not have local PHP or Docker executables;
those checks were subsequently covered by GitHub Actions.

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

## Local Staging UAT Corrections

Follow-up manual UAT found three presentation/bootstrap defects while secure
reveal and cross-owner isolation behaved correctly. The WP-CLI image ran as
UID/GID `82` against WordPress-owned files from UID/GID `33`, local HTTP was
forced to HTTPS, and the default English/USD WooCommerce setup remained visible.

The bootstrap now runs as `33:33` without a manual CLI flag and retains the
repository plugin's read-only mount. `FORCE_SSL_ADMIN` is controlled by an
exact boolean environment value, defaults to `true`, and can be explicitly set
to `false` only for isolated local HTTP staging. Bootstrap activates `de_DE`,
configures Germany/EUR and German price formatting, removes the sample page and
disables WooCommerce's staging-only coming-soon screen, and the plugin suppresses
the duplicate theme navigation. Customer-facing order, payment and invoice
status codes are mapped to German labels without changing their internal values.

No production behavior, database schema, price calculation, owner isolation,
HMAC, nonce, origin, rate-limit or vault rule changed. Repeated human UAT must
still use only the synthetic staging key; Security Readiness and all human UAT
results remain unapproved/pending.

Correction verification on the local isolated Docker stack:

- `npm run check`: passed; 746 tests passed and 124 environment-dependent tests
  skipped; format, lint, typecheck and secret scan passed.
- Focused staging tests: 38 passed and one PostgreSQL-dependent test skipped in
  the no-database run; the focused PostgreSQL run separately passed all six
  staging deployment/seed tests.
- PHP 8.3 container syntax checks: all plugin PHP files passed; deterministic
  adapter test passed.
- `docker compose ... config --quiet`: passed for local HTTP and committed HTTPS
  example configurations, including the bootstrap profile.
- Full stack recreation: seven services started; PostgreSQL, Redis, MariaDB and
  staging bridge became healthy.
- Bootstrap without manual `--user`: passed twice idempotently; effective UID
  and GID were both 33, customer IDs remained 2 and 3, six products were
  published, and the sample page count was zero.
- Browser checks: shop/product/account/cart/checkout returned HTTP 200, German
  customer text and EUR prices were visible, USD/English shop controls were not
  visible, one KeyRaNo header remained, and desktop plus 390 px layouts had no
  horizontal overflow after correction.
- Synthetic owner reveal: matched the configured synthetic fixture without an
  HTTPS redirect; cross-owner detail access returned the safe unavailable state
  and no synthetic value.
- `npm audit --audit-level=low`: zero vulnerabilities.
- `git diff --check`: passed.

The branch is technically ready for repeated Human-UAT. Remaining human work is
the formal evidence capture and disposition of the prepared UAT scenarios;
placeholders remain acceptable, checkout remains intentionally non-live, guest
claim and invoice-document delivery remain outside this correction, and neither
Human-UAT nor Security Readiness is approved by this report.
