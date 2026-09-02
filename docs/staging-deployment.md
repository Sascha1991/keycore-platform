# Staging Deployment

The separate KS-ADMIN-01 staging Admin service and its trust boundary are
documented in `docs/admin/secure-admin-foundation.md`. It listens only on the
explicit `KEYRANO_STAGING_ADMIN_ORIGIN`, uses its own hash-only synthetic Admin
session and must not reuse WordPress/customer credentials. This staging shell
does not approve production Admin authentication or Product-Key reveal.

## Purpose

KS-11-01 provides a repeatable, production-like staging foundation for later
Phase-11 acceptance work. It does not deploy production and does not complete
E2E, scale, concurrency, security-assessment, recovery-exercise or UAT work.

PostgreSQL remains durable authority. Redis is isolated coordination state and
cannot grant payment, procurement, fulfillment, customer-delivery or
Operations Control authority.

## Isolation Contract

Staging requires all of the following before readiness becomes `READY`:

- exact `KEYCORE_ENV=STAGING` and a `staging-*` deployment ID;
- explicit staging resource environment and IDs for PostgreSQL, Redis and
  fulfillment encryption;
- the exact Redis namespace `keycore:staging:<deployment-id>`;
- Stripe `TEST` mode with test-form credentials injected outside Git;
- `MOCK` supplier mode, or an explicitly configured HTTPS Kinguin sandbox;
- rejection of the known Kinguin production endpoint and all controlled live
  Kinguin flags;
- captured mail with unrestricted external delivery disabled;
- the explicitly approved `https://staging.keyrano.de` public origin (or the
  isolated `https://staging.example.invalid` CI fixture), Secure cookies, CSRF
  enabled and debug disabled;
- production Operations Control authority disabled; and
- PostgreSQL reachable with exactly the repository migrations through `027`.

The resource environment and IDs are trusted deployment configuration. The
repository cannot reliably infer a cloud resource's ownership from an arbitrary
URL. Operators must provision separate staging accounts/projects and must not
mislabel production resources. Obvious production identities and the known
production supplier/origin boundaries are rejected, but these checks are not a
substitute for cloud IAM and network isolation.

Preflight output contains only status, deployment identity and stable reason
codes. URLs, credentials and configuration objects are never returned.

Origin classification is exact and auditable. `keyrano.de`, `www.keyrano.de`,
`keyrano.com` and `www.keyrano.com` are production. Arbitrary HTTPS hosts and
other KeyRaNo subdomains are not automatically trusted. Origins containing URL
credentials, paths, queries or fragments are invalid.

## Components

`infra/docker/compose.staging.yaml` pins a separate local validation stack:

- WordPress 7.0.3 with the repository plugin mounted read-only;
- MariaDB 11.8.8 for WordPress only;
- PostgreSQL 16.10 for KeyCore durable state;
- Redis 7.4 with authentication and append-only coordination persistence; and
- Mailpit 1.21.8 as a local mail capture sink.

Volumes, host ports, database names, Redis namespace and Compose project name
are staging-specific. The WordPress plugin remains an integration skeleton; no
production storefront transport, customer login UI or full customer journey is
claimed by this task. HTTPS termination and routable staging hosting remain
external deployment prerequisites.

## Fresh Bootstrap

1. Create an ignored `infra/docker/staging.env` from
   `infra/docker/staging.env.example`.
2. Replace every placeholder password/key with staging-only values injected by
   the deployment secret store. Keep `MOCK`, Stripe `TEST`, mail `CAPTURE` and
   Operations Control authority `DISABLED`. Generate a separate high-entropy
   `KEYRANO_STAGING_GUEST_CLAIM_CODE` beginning with `SYNTHETIC_`; bootstrap
   rejects the checked-in `GENERATE_LOCALLY` placeholder.
3. Export the same ignored environment values for the Node commands.
4. Validate and start the stack:

```sh
docker compose --env-file infra/docker/staging.env -f infra/docker/compose.staging.yaml config --quiet
docker compose --env-file infra/docker/staging.env -f infra/docker/compose.staging.yaml up -d postgres redis mail wordpress-db wordpress
npm run staging:migrate
npm run staging:preflight
npm run staging:seed
npm run staging:preflight
```

`staging:migrate` performs the local safety guard before making a database
connection, then repeatably applies the existing reversible migrations
through `027_catalog_snapshot_lookup_indexes`. `staging:seed` is transactionally
idempotent and refuses any environment other than explicit `STAGING` with a
valid staging deployment ID.

The optional `wordpress-bootstrap` profile activates pinned WooCommerce 11.0.0
and the KeyCore plugin after WordPress has been initialized through the normal
trusted staging administration process. The container runs as UID/GID `33:33`
to match the mounted WordPress volume owner; do not add a manual `--user`
argument or broaden permissions:

```sh
docker compose --env-file infra/docker/staging.env -f infra/docker/compose.staging.yaml --profile bootstrap run --rm wordpress-bootstrap
```

The bootstrap activates the German WordPress and WooCommerce language packs,
configures Germany/EUR storefront defaults and removes the sample page. For an
isolated local origin such as `http://localhost:18080`, explicitly set
`KEYRANO_STAGING_FORCE_SSL_ADMIN=false`. Hosted TLS staging keeps it `true`.
The default is `true`, and invalid values fail during WordPress configuration;
`false` also fails unless the configured origin is local HTTP on an explicit
loopback host. This local transport exception does not weaken reveal
authorization or request integrity controls.

The committed example is a template only. Ordinary PR CI validates it with
synthetic placeholders and never receives staging or production credentials.

## Synthetic Dataset

The seed creates one clearly named mock supplier and four catalog cases:

- Germany allowed;
- global allowed;
- Germany blocked; and
- unknown/review required.

It creates matching offers, evidence, decisions and prices only. It creates no
customer, order, fulfillment secret, encrypted key record or Product Key. It
does not create the separate 50,000-product corpus reserved for KS-11-03.

The later storefront `keycore-checkout-bootstrap` additionally creates two
verified synthetic customers and one deterministic unowned synthetic order with
a hash-only Guest Claim challenge. It never stores the raw claim code, never
reactivates a consumed challenge and never creates fulfillment/key material.

## Readiness And Diagnostics

`npm run staging:preflight` exits non-zero on unsafe configuration, unavailable
PostgreSQL or migration mismatch. The `STAGING_DEPLOYMENT` readiness role
requires PostgreSQL, Redis and `STAGING_CONFIGURATION` to be healthy. Unrelated
read-only roles retain the existing degraded-read semantics.

Representative reason codes include:

- `STAGING_ENVIRONMENT_REQUIRED`
- `PRODUCTION_DATABASE_FORBIDDEN`
- `PRODUCTION_REDIS_FORBIDDEN`
- `REDIS_NAMESPACE_UNSAFE`
- `STRIPE_LIVE_MODE_FORBIDDEN`
- `PRODUCTION_SUPPLIER_ENDPOINT_FORBIDDEN`
- `UNSAFE_MAIL_TRANSPORT`
- `MIGRATION_MISMATCH`

## Reset

Reset is destructive to the named staging Compose project only:

```sh
docker compose --env-file infra/docker/staging.env -f infra/docker/compose.staging.yaml down --volumes
```

Verify `KEYCORE_ENV=STAGING`, the deployment ID and the Compose project shown by
`docker compose ... config` before reset. Never point this procedure at a
production project or external database. Re-run the fresh bootstrap to recreate
an empty migrated and synthetically seeded environment. This destructive reset
is the only supported way to recreate a consumed human Guest Claim fixture.

## Safe External Modes

- Kinguin: mock by default; no production purchase, retrieval, return or claim.
- Stripe: test mode only; no live PaymentIntent, refund or dispute mutation.
- Mail: Mailpit capture only; no unrestricted external recipients.
- Keys: no real Product Keys; staging encryption material must be separately
  injected and must never be copied from production.
- Operations Controls: durable deny-only semantics remain unchanged; `ENABLED`
  never grants business authority.

## Remaining Work

KS-11-02 through KS-11-07 remain not started. In particular, production-like
hosting, HTTPS termination, real staging secret provisioning, complete HTTP
composition, storefront initialization, E2E journeys, 50k scale evidence,
concurrency evidence, security assessment, recovery exercise and owner UAT are
not completed here. `SECURITY-READINESS` remains not approved.
