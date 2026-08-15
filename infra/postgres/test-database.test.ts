import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { PostgresTestDatabase } from "./test-database.js";

const databaseUrl = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("PostgreSQL integration test database bootstrap", () => {
  it("initializes isolated schemas concurrently without racing pgcrypto", async () => {
    const leftSchema = `ks_bootstrap_left_${randomUUID().replaceAll("-", "_")}`;
    const rightSchema = `ks_bootstrap_right_${randomUUID().replaceAll("-", "_")}`;
    const [left, right] = await Promise.all([
      PostgresTestDatabase.initialize({
        connectionString: databaseUrl,
        schemaName: leftSchema,
      }),
      PostgresTestDatabase.initialize({
        connectionString: databaseUrl,
        schemaName: rightSchema,
      }),
    ]);

    try {
      await expect(tableExists(left, leftSchema, "suppliers")).resolves.toBe(
        true,
      );
      await expect(tableExists(right, rightSchema, "suppliers")).resolves.toBe(
        true,
      );
      await expect(tableExists(left, rightSchema, "suppliers")).resolves.toBe(
        true,
      );
      await expect(schemaMigrationCount(left)).resolves.toBe("5");
      await expect(schemaMigrationCount(right)).resolves.toBe("5");
      await expect(pgcryptoCount(left)).resolves.toBe("1");

      await left.query(
        "INSERT INTO suppliers(supplier_code, display_name) VALUES ('left-only', 'Left Only')",
      );
      await expect(supplierCount(left)).resolves.toBe("1");
      await expect(supplierCount(right)).resolves.toBe("0");

      await left.cleanup();

      await expect(tableExists(right, rightSchema, "suppliers")).resolves.toBe(
        true,
      );
      await expect(schemaMigrationCount(right)).resolves.toBe("5");
      await expect(pgcryptoCount(right)).resolves.toBe("1");
    } finally {
      await left.cleanup();
      await right.cleanup();
    }
  });
});

const tableExists = async (
  database: PostgresTestDatabase,
  schemaName: string,
  tableName: string,
): Promise<boolean> => {
  const result = await database.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2
      )
    `,
    [schemaName, tableName],
  );
  return result.rows[0]?.exists ?? false;
};

const schemaMigrationCount = async (
  database: PostgresTestDatabase,
): Promise<string> => {
  const result = await database.query<{ count: string }>(
    "SELECT count(*)::text FROM keycore_migrations",
  );
  return result.rows[0]?.count ?? "0";
};

const pgcryptoCount = async (
  database: PostgresTestDatabase,
): Promise<string> => {
  const result = await database.query<{ count: string }>(
    "SELECT count(*)::text FROM pg_extension WHERE extname = 'pgcrypto'",
  );
  return result.rows[0]?.count ?? "0";
};

const supplierCount = async (
  database: PostgresTestDatabase,
): Promise<string> => {
  const result = await database.query<{ count: string }>(
    "SELECT count(*)::text FROM suppliers",
  );
  return result.rows[0]?.count ?? "0";
};
