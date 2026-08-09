# Local Development Bootstrap

This document covers KS-01-01 foundation setup only. It does not enable production supplier ordering, live payments, real product keys, production customer data, or production deployment.

## Required Tools

- Node.js 22.22.0 with npm 11.6.2 or newer npm 11.x. Use `.nvmrc` or `.node-version`.
- PHP 8.3+.
- Composer 2.
- Docker with Docker Compose.

## First Setup

```sh
npm ci
composer validate --strict
docker compose -f infra/docker/compose.yaml config
```

Copy `.env.example` to `.env` for local-only development values. Do not commit `.env`.

## Checks

```sh
npm run check
composer validate --strict
find apps -name '*.php' -print0 | xargs -0 -n1 php -l
docker compose -f infra/docker/compose.yaml config
```

## Local Services

```sh
docker compose -f infra/docker/compose.yaml up
```

Services:

- WordPress local skeleton: `http://localhost:8080`
- MariaDB for local WordPress only: internal Docker network
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`
- Mailpit: `http://localhost:8025`

The local WordPress container mounts the KeyCore plugin skeleton from `apps/wordpress/keycore-platform`. WooCommerce is pinned to 11.0.0 for local installation by `infra/docker/woocommerce-install.sh`, but no production checkout, payment, invoice, supplier, or key-delivery behavior is implemented in KS-01-01.

## Safety Rules

- Use only local placeholder values in `.env`.
- Never commit secrets, live payment credentials, supplier credentials, real product keys, or production customer data.
- Keep real supplier ordering disabled until the `REAL-SUPPLIER` gate exists.
- Keep live payments disabled until the `LIVE-PAYMENTS` gate exists.
