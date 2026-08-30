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
```

Set `KEYRANO_STAGING_SYNTHETIC_KEY` to a locally chosen value beginning with
`SYNTHETIC_`. Never reuse or paste a real Product Key. For local browser use,
set both staging public origins to `http://localhost:18080`. For hosted staging,
use `https://staging.keyrano.de`.

## Start

```sh
docker compose --env-file .env.staging -f infra/docker/compose.staging.yaml up -d --build
docker compose --env-file .env.staging -f infra/docker/compose.staging.yaml --profile bootstrap run --rm wordpress-bootstrap
```

Open `http://localhost:18080` for local use. The bootstrap installs WooCommerce,
activates the KeyRaNo plugin, creates two synthetic customer accounts, verifies
their expected numeric IDs, installs immutable KeyCore mappings, publishes the
small synthetic catalog and sets Shop as the front page. A non-clean database
with conflicting IDs fails instead of silently changing identity authority.

Passwords are supplied from the ignored environment file. No credentials are
committed or printed by the documented commands.

## Stop

```sh
docker compose --env-file .env.staging -f infra/docker/compose.staging.yaml down
```

Add `--volumes` only when intentionally destroying the isolated synthetic
staging data.
