import { randomUUID } from "node:crypto";

import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { OperationsControlService } from "../../packages/platform/src/operations/operations-controls.js";
import type { Queryable, TransactionalQueryable } from "./client.js";
import { PostgresOperationsControlRepository } from "./operations-control-repositories.js";
import { PostgresOperationalMetricFacts } from "./operational-metrics.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const now = new Date("2026-08-28T12:00:00.000Z");

describe.skipIf(!connectionString)("operations persistence", () => {
  it("seeds all controls and durable initialization history", async () => {
    await withDatabase(async (database) => {
      await expect(count(database, "operations_controls")).resolves.toBe("4");
      await expect(count(database, "operations_control_events")).resolves.toBe(
        "4",
      );
      const invalid = database.query(
        "UPDATE operations_controls SET state = 'ENABLED', reason_code = 'MAINTENANCE' WHERE capability = 'PROCUREMENT_CREATE'",
      );
      await expect(invalid).rejects.toThrow();
    });
  });

  it("persists pause/restart, supports exact replay and prevents lost updates", async () => {
    await withDatabase(async (database) => {
      const first = service(database);
      await expect(
        first.changeControl(change("PAUSED", 1, "pause-1")),
      ).resolves.toMatchObject({
        status: "UPDATED",
      });
      const recreated = service(database);
      await expect(recreated.evaluate("PROCUREMENT_CREATE")).resolves.toEqual({
        reasonCode: "OPERATIONS_CONTROL_PAUSED",
        status: "DENIED",
      });
      await expect(
        recreated.changeControl(change("PAUSED", 1, "pause-1")),
      ).resolves.toMatchObject({ status: "REPLAY" });
      await expect(
        recreated.changeControl(change("ENABLED", 1, "resume-stale", null)),
      ).resolves.toEqual({ code: "STALE_VERSION", status: "FAILED" });
      await expect(count(database, "operations_control_events")).resolves.toBe(
        "5",
      );
    });
  });

  it("protects append-only history and dead-letter metadata constraints", async () => {
    await withDatabase(async (database) => {
      await expect(
        database.query("DELETE FROM operations_control_events"),
      ).rejects.toThrow("append-only");
      await expect(
        database.query(
          `INSERT INTO dead_letter_items(
             id, work_type, safe_reference_id, attempt_count, reason_code,
             correlation_id, state, first_failed_at, last_failed_at, record_version
           ) VALUES ($1, 'OUTBOX_DISPATCH', 'safe-1', 1, 'RETRY_EXHAUSTED',
             'corr-safe', 'OPEN', $2, $2, 1)`,
          [randomUUID(), now],
        ),
      ).resolves.toBeDefined();
      await expect(
        new PostgresOperationalMetricFacts(database, () => now).collect(),
      ).resolves.toContainEqual({
        labels: { status: "OPEN" },
        name: "dead_letter_count",
        observedAt: now,
        value: 1,
      });
      await expect(
        database.query(
          `INSERT INTO dead_letter_items(
             id, work_type, safe_reference_id, attempt_count, reason_code,
             correlation_id, state, first_failed_at, last_failed_at, record_version
           ) VALUES ($1, 'OUTBOX_DISPATCH', $2, 1, 'RETRY_EXHAUSTED',
             'corr-safe', 'OPEN', $3, $3, 1)`,
          [randomUUID(), "unsafe payload value", now],
        ),
      ).rejects.toThrow();
    });
  });
});

const service = (database: PostgresTestDatabase): OperationsControlService =>
  new OperationsControlService(
    new PostgresOperationsControlRepository(
      new TestTransactionBoundary(database),
    ),
    {
      authority: {
        authorize: async () => ({
          actorReference: "operations-postgres-test",
          status: "AUTHORIZED",
        }),
      },
      now: () => now,
    },
  );

const change = (
  desiredState: "PAUSED" | "ENABLED",
  expectedVersion: number,
  operationId: string,
  reasonCode: "MAINTENANCE" | null = "MAINTENANCE",
) => ({
  capability: "PROCUREMENT_CREATE" as const,
  correlationId: "corr-postgres-operations",
  desiredState,
  expectedVersion,
  operationId,
  reasonCode,
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
): Promise<string> => {
  const result = await database.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM ${quoteIdentifier(table)}`,
  );
  return result.rows[0]?.count ?? "0";
};

const withDatabase = async (
  callback: (database: PostgresTestDatabase) => Promise<void>,
): Promise<void> => {
  const database = await PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `operations_${randomUUID().replaceAll("-", "")}`,
  });
  try {
    await callback(database);
  } finally {
    await database.cleanup();
  }
};
