import { randomUUID } from "node:crypto";

import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import type { Queryable, TransactionalQueryable } from "./client.js";
import { loadMigrations } from "./migrations.js";
import { seedSyntheticStagingData } from "./staging-seed.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;

describe.skipIf(!connectionString)("staging deployment persistence", () => {
  it("initializes through migration 026 and seeds only a small synthetic dataset idempotently", async () => {
    await withDatabase(async (database) => {
      const expectedVersions = (await loadMigrations()).map(
        (migration) => migration.version,
      );
      const applied = await database.query<{ readonly version: string }>(
        "SELECT version FROM keycore_migrations ORDER BY version",
      );
      expect(applied.rows.map((row) => row.version)).toEqual(expectedVersions);
      expect(applied.rows.at(-1)?.version).toBe("026");

      const boundary = new TestTransactionBoundary(database);
      const input = {
        deploymentId: "staging-postgres-test",
        environment: "STAGING",
      } as const;
      await expect(seedSyntheticStagingData(boundary, input)).resolves.toEqual({
        decisionCount: 4,
        offerCount: 4,
        productCount: 4,
        status: "SEEDED",
        supplierCount: 1,
      });
      await expect(seedSyntheticStagingData(boundary, input)).resolves.toEqual({
        decisionCount: 4,
        offerCount: 4,
        productCount: 4,
        status: "SEEDED",
        supplierCount: 1,
      });

      await expect(count(database, "customers")).resolves.toBe(0);
      await expect(count(database, "keycore_orders")).resolves.toBe(0);
      await expect(count(database, "encrypted_key_records")).resolves.toBe(0);
      await expect(count(database, "fulfillment_secrets")).resolves.toBe(0);
    });
  });
});

class TestTransactionBoundary implements TransactionalQueryable {
  public constructor(private readonly database: PostgresTestDatabase) {}

  public query<TResult extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<TResult>> {
    return this.database.query<TResult>(text, values);
  }

  public async transaction<TResult>(
    callback: (client: Queryable) => Promise<TResult>,
  ): Promise<TResult> {
    await this.database.query("BEGIN");
    try {
      const result = await callback(this);
      await this.database.query("COMMIT");
      return result;
    } catch (error) {
      await this.database.query("ROLLBACK");
      throw error;
    }
  }
}

const count = async (
  database: PostgresTestDatabase,
  table: string,
): Promise<number> => {
  const result = await database.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM ${quoteIdentifier(table)}`,
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
};

const withDatabase = async (
  callback: (database: PostgresTestDatabase) => Promise<void>,
): Promise<void> => {
  const database = await PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `staging_${randomUUID().replaceAll("-", "")}`,
  });
  try {
    await callback(database);
  } finally {
    await database.cleanup();
  }
};
