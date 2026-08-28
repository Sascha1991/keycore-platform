import { createHash, randomUUID } from "node:crypto";

import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { OperationsControlService } from "../../packages/platform/src/operations/operations-controls.js";
import {
  SyntheticRestoreDrillService,
  createBackupInspection,
  type RestoreInspection,
} from "../../packages/platform/src/operations/backup-restore.js";
import type { Queryable, TransactionalQueryable } from "./client.js";
import { PostgresOperationsControlRepository } from "./operations-control-repositories.js";
import { PostgresOperationalMetricFacts } from "./operational-metrics.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const now = new Date("2026-08-28T12:00:00.000Z");

describe.skipIf(!connectionString)("operations persistence", () => {
  it("seeds all controls and durable initialization history", async () => {
    await withDatabase(async (database) => {
      await expect(count(database, "operations_controls")).resolves.toBe("6");
      await expect(count(database, "operations_control_events")).resolves.toBe(
        "6",
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
        "7",
      );
    });
  });

  it("persists a global pause and denies checkout without consulting Redis", async () => {
    await withDatabase(async (database) => {
      const controls = service(database);
      await expect(
        controls.changeControl({
          ...change("PAUSED", 1, "global-pause"),
          capability: "GLOBAL_COMMERCE_MUTATIONS",
        }),
      ).resolves.toMatchObject({ status: "UPDATED" });

      const afterRestart = service(database);
      await expect(afterRestart.evaluate("CHECKOUT_CREATE")).resolves.toEqual({
        reasonCode: "OPERATIONS_CONTROL_PAUSED",
        status: "DENIED",
      });
      await expect(
        afterRestart.evaluate("PROCUREMENT_CREATE"),
      ).resolves.toEqual({
        reasonCode: "OPERATIONS_CONTROL_PAUSED",
        status: "DENIED",
      });
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

  it("runs a synthetic encrypted restore drill between disposable isolated schemas", async () => {
    const source = await PostgresTestDatabase.initialize({
      connectionString,
      schemaName: `operations_source_${randomUUID().replaceAll("-", "")}`,
    });
    const target = await PostgresTestDatabase.initialize({
      connectionString,
      schemaName: `keycore_restore_${randomUUID().replaceAll("-", "")}`,
    });
    const restoreTarget = {
      disposable: true,
      identifier: target.schemaName,
      kind: "ISOLATED_SCHEMA",
    } as const;
    try {
      await pauseGlobal(source, "synthetic-drill-pause");
      await insertSyntheticEncryptedFulfillment(source);
      const backupState = await inspectRestoreState(source);
      const backup = createBackupInspection({
        backupId: "synthetic-postgres-drill-1002",
        contentSha256: backupState.contentDigest,
        createdAt: now,
        embeddedDatabaseCredentials: 0,
        embeddedMasterKeys: 0,
        encryptedFulfillmentDigestSha256: backupState.fulfillmentDigest,
        encryptedFulfillmentRecords: backupState.fulfillmentRecords,
        migrationIdentity: backupState.migrationIdentity,
        operationsControlDigestSha256: backupState.controlDigest,
        operationsControlEvents: backupState.controlEvents,
        operationsControlRows: backupState.controlRows,
        plaintextProductKeyFields: 0,
        schemaVersion: backupState.schemaVersion,
      });
      const drill = new SyntheticRestoreDrillService({
        cleanup: async () => target.cleanup(),
        createSyntheticBackup: async () => backup,
        restoreToIsolatedTarget: async () => {
          await pauseGlobal(target, "synthetic-drill-pause");
          await insertSyntheticEncryptedFulfillment(target);
          const restored = await inspectRestoreState(target);
          return {
            embeddedDatabaseCredentials: 0,
            embeddedMasterKeys: 0,
            encryptedFulfillmentDigestSha256: restored.fulfillmentDigest,
            encryptedFulfillmentRecords: restored.fulfillmentRecords,
            externalMasterKeyAvailable: false,
            operationsControlDigestSha256: restored.controlDigest,
            operationsControlEvents: restored.controlEvents,
            operationsControlRows: restored.controlRows,
            plaintextProductKeyFields: 0,
            restoredMigrationIdentity: restored.migrationIdentity,
            restoredSchemaVersion: restored.schemaVersion,
            target: restoreTarget,
          } satisfies RestoreInspection;
        },
      });

      await expect(drill.run(restoreTarget)).resolves.toEqual({
        reasonCode: "RESTORE_VALIDATED_EXTERNAL_KEY_SEPARATE",
        status: "VALID",
      });
    } finally {
      await source.cleanup();
      await target.cleanup().catch(() => undefined);
    }
  }, 15_000);
});

const pauseGlobal = async (
  database: PostgresTestDatabase,
  operationId: string,
): Promise<void> => {
  const result = await service(database).changeControl({
    ...change("PAUSED", 1, operationId),
    capability: "GLOBAL_COMMERCE_MUTATIONS",
  });
  if (result.status !== "UPDATED") throw new Error("Synthetic pause failed");
};

const insertSyntheticEncryptedFulfillment = async (
  database: PostgresTestDatabase,
): Promise<void> => {
  const fulfillmentId = "00000000-0000-4000-8000-000000100201";
  const secretId = "00000000-0000-4000-8000-000000100202";
  await database.query(
    `INSERT INTO fulfillment_operations(
       id, supplier_id, external_supplier_order_id, expected_quantity, status,
       retrieval_state, delivery_state, record_version, correlation_id,
       created_at, updated_at, retrieved_at
     ) VALUES ($1, 'SYNTHETIC', 'synthetic-order-1002', 1, 'RETRIEVED',
       'RETRIEVED', 'PENDING', 1, 'corr-synthetic-restore', $2, $2, $2)`,
    [fulfillmentId, now],
  );
  await database.query(
    `INSERT INTO fulfillment_secrets(
       id, fulfillment_id, ciphertext, encryption_nonce, encryption_tag,
       wrapped_data_encryption_key, encryption_key_id, encryption_version,
       encryption_algorithm, created_at
     ) VALUES ($1, $2, decode('01020304', 'hex'), decode($3, 'hex'),
       decode($4, 'hex'), decode('05060708', 'hex'), 'synthetic-kms-v1', 1,
       'AES-256-GCM-v1', $5)`,
    [secretId, fulfillmentId, "11".repeat(12), "22".repeat(16), now],
  );
  await database.query(
    "UPDATE fulfillment_operations SET encrypted_secret_id = $2 WHERE id = $1",
    [fulfillmentId, secretId],
  );
};

const inspectRestoreState = async (database: PostgresTestDatabase) => {
  const migrations = await database.query<{
    readonly version: string;
    readonly name: string;
  }>(
    "SELECT version, name FROM keycore_migrations ORDER BY version DESC LIMIT 1",
  );
  const controls = await database.query(
    `SELECT capability, state, reason_code, record_version
       FROM operations_controls ORDER BY capability`,
  );
  const events = await database.query(
    `SELECT capability, event_type, from_state, to_state, reason_code,
            actor_reference, operation_id, correlation_id
       FROM operations_control_events ORDER BY capability, operation_id`,
  );
  const fulfillment = await database.query(
    `SELECT f.id::text, f.status, f.retrieval_state, f.delivery_state,
            encode(s.ciphertext, 'hex') AS ciphertext,
            encode(s.encryption_nonce, 'hex') AS nonce,
            encode(s.encryption_tag, 'hex') AS tag,
            encode(s.wrapped_data_encryption_key, 'hex') AS wrapped_dek,
            s.encryption_key_id, s.encryption_version, s.encryption_algorithm
       FROM fulfillment_operations f
       JOIN fulfillment_secrets s ON s.id = f.encrypted_secret_id
      ORDER BY f.id`,
  );
  const migration = migrations.rows[0];
  if (!migration) throw new Error("Synthetic migration identity unavailable");
  const controlDigest = digest([controls.rows, events.rows]);
  const fulfillmentDigest = digest(fulfillment.rows);
  return {
    contentDigest: digest([
      migration.version,
      migration.name,
      controlDigest,
      fulfillmentDigest,
    ]),
    controlDigest,
    controlEvents: events.rowCount ?? 0,
    controlRows: controls.rowCount ?? 0,
    fulfillmentDigest,
    fulfillmentRecords: fulfillment.rowCount ?? 0,
    migrationIdentity: `${migration.version}-${migration.name}`,
    schemaVersion: migration.version,
  };
};

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

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
