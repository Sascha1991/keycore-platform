# PostgreSQL Persistence Foundation

KS-02-01 establishes KeyCore's PostgreSQL persistence foundation. PostgreSQL is the durable system of record for platform state. WordPress and WooCommerce tables are not KeyCore's primary persistence layer.

## Schema Ownership

The schema under `infra/postgres/migrations` owns platform tables for:

- suppliers and supplier-side product/offer references;
- internal products and offers;
- region evidence and Germany compatibility decisions;
- price snapshots;
- customers, commerce orders, and immutable commerce order-line UUIDs;
- payment, procurement, fulfillment, and refund records;
- encrypted key record metadata and ciphertext containers;
- audit events;
- idempotency records;
- transactional outbox events;
- reconciliation records.

Supplier identifiers and supplier-side product/offer identifiers remain separate from KeyCore internal UUIDs.

## Migration Technology

Migrations are plain SQL files with paired `.up.sql` and `.down.sql` files, executed by the TypeScript migration runner in `infra/postgres/migrate.ts` using `pg@8.23.0`.

Commands:

```sh
npm run db:status
npm run db:migrate
npm run db:rollback
```

Set `KEYCORE_DATABASE_URL` or `DATABASE_URL` before running migration commands.

There is no production reset command. For local development reset, use a disposable local database or Docker volume and run the reversible down/up migration sequence only against local data.

## Local PostgreSQL Development

Start local services:

```sh
docker compose -f infra/docker/compose.yaml up postgres
```

Use `.env.example` as a template for local-only values. Do not commit `.env`, production connection strings, credentials, real customer data, real supplier data, real product keys, or payment credentials.

## Integration Tests

PostgreSQL integration tests live in `infra/postgres/persistence.test.ts`.

They require:

```sh
KEYCORE_TEST_DATABASE_URL=postgres://...
```

When the variable is absent, local Vitest runs skip the PostgreSQL integration suite. CI provides a PostgreSQL 16.10 service and runs the same tests against a real database.

## Backup Assumptions at This Stage

KS-02-01 only creates schema foundations. Backup implementation is deferred. Current assumptions:

- encrypted key records must be backed up as ciphertext and cryptographic metadata only;
- no plaintext product-key column exists;
- PostgreSQL backups must not contain external master keys;
- future backup/restore tasks must validate encrypted-key restore behavior before production use.
