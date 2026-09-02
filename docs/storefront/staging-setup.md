# Visible Storefront Staging Setup

## Prerequisites

- Docker with Compose
- a clean, isolated staging volume set
- no production database, Redis, credentials, catalog or customer data
- an environment file copied from `infra/docker/staging.env.example`

Generate values locally and place them only in the ignored environment file:

```sh
openssl rand -base64 48  # KEYRANO_STAGING_BRIDGE_SECRET
openssl rand -base64 32  # KEYRANO_STAGING_BROWSER_MASTER_KEY
openssl rand -base64 24  # each WordPress password
printf 'SYNTHETIC_%s\n' "$(openssl rand -hex 32)"  # KEYRANO_STAGING_GUEST_CLAIM_CODE
```

Set `KEYRANO_STAGING_SYNTHETIC_KEY` to a locally chosen value beginning with
`SYNTHETIC_`. Set `KEYRANO_STAGING_GUEST_CLAIM_CODE` to the separately generated
synthetic value above. The checked-in `GENERATE_LOCALLY` placeholders are not
runtime values, and the claim placeholder is rejected by bootstrap. Never reuse
or paste a real Product Key or claim credential. For local browser use,
set both staging public origins to `http://localhost:18080` and set
`KEYRANO_STAGING_FORCE_SSL_ADMIN=false`. For hosted staging, use
`https://staging.keyrano.de` and keep
`KEYRANO_STAGING_FORCE_SSL_ADMIN=true`. The secure default is `true`; only the
exact values `true` and `false` are accepted, and `false` is rejected unless the
configured origin is local HTTP on `localhost`, `127.0.0.1` or `::1`.

## Start

```sh
docker compose --env-file .env.staging -f infra/docker/compose.staging.yaml up -d --build
docker compose --env-file .env.staging -f infra/docker/compose.staging.yaml --profile bootstrap run --rm wordpress-bootstrap
```

Open `http://localhost:18080` for local use. The bootstrap installs WooCommerce,
activates the KeyRaNo plugin, creates two synthetic customer accounts, verifies
their expected numeric IDs, installs immutable KeyCore mappings, publishes the
small synthetic catalog, seeds one hash-only one-time guest claim and sets Shop
as the front page. It runs as UID/GID
`33:33`, matching the Apache WordPress image, so no manual `--user` argument or
world-writable permission change is required. It also activates `de_DE`, sets
WooCommerce to Germany and EUR, uses German price separators and removes the
WordPress sample page. WooCommerce's default coming-soon screen is disabled for
this isolated synthetic storefront so anonymous UAT reaches the actual shop.
The persisted WooCommerce account page is idempotently titled `Mein Konto`
while its stable `/my-account/` slug remains unchanged. A non-clean database
with conflicting IDs fails instead of silently changing identity authority.

Passwords are supplied from the ignored environment file. No credentials are
committed or printed by the documented commands.

The local HTTP exception applies only to WordPress admin transport in this
isolated staging stack. It does not alter the exact-origin, nonce, HMAC,
ownership, rate-limit or no-store controls on secure reveal. A manual reveal
check must use only the configured synthetic value and must never use or record
a real Product Key. The Guest Claim code must be transferred to the human tester
through the approved staging channel and must not appear in screenshots, notes,
URLs or logs.

## Stop

```sh
docker compose --env-file .env.staging -f infra/docker/compose.staging.yaml down
```

Add `--volumes` only when intentionally destroying the isolated synthetic
staging data. A consumed Guest Claim is deliberately not reactivated by an
ordinary bootstrap; recreating the scenario requires this explicit staging-only
volume reset followed by a fresh bootstrap.
