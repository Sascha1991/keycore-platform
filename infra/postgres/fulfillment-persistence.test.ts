import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  correlationId,
  currency,
  encryptFulfillmentSecret,
  fulfillmentEncryptionContext,
  money,
  supplierId,
  supplierOfferId,
  supplierProductId,
  type FulfillmentOperation,
  type KeyManagementProvider,
} from "../../packages/platform/src/contracts.js";
import {
  hashExecutionToken,
  type ControlledProcurementApproval,
} from "../suppliers/kinguin/kinguin-controlled-live-procurement.js";
import { PostgresControlledProcurementApprovalRepository } from "./controlled-procurement-repositories.js";
import { PostgresFulfillmentRepository } from "./fulfillment-repositories.js";
import type { Queryable, TransactionalQueryable } from "./client.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const now = new Date("2026-08-25T10:00:00.000Z");
const canaryProductKey = [
  "KEYCORE_TEST",
  "PRODUCT",
  "KEY",
  "DO_NOT_LEAK_12345",
].join("_");

describe.skipIf(!connectionString)("PostgresFulfillmentRepository", () => {
  it("creates fulfillment idempotently for one controlled procurement approval", async () => {
    await withDatabase(async (database) => {
      const approval = controlledApprovalFixture();
      await withControlledRepository(database.schemaName, (repository) =>
        repository.create(approval),
      );
      const operation = operationFixture({
        controlledProcurementApprovalId: approval.approvalId,
      });

      const created = await withRepository(database.schemaName, (repository) =>
        repository.createIdempotent({ now, operation }),
      );
      const repeated = await withRepository(database.schemaName, (repository) =>
        repository.createIdempotent({
          now,
          operation: operationFixture({
            controlledProcurementApprovalId: approval.approvalId,
            id: randomUUID(),
          }),
        }),
      );

      expect(created.status).toBe("CREATED");
      expect(repeated.status).toBe("EXISTING");
      expect(repeated.operation.id).toBe(created.operation.id);
    });
  });

  it("allows exactly one concurrent retrieval lease owner", async () => {
    await withDatabase(async (database) => {
      const operation = await createOperation(database);
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          withRepository(database.schemaName, (repository) =>
            repository.acquireRetrievalLease({
              executionToken: randomUUID(),
              fulfillmentId: operation.id,
              now,
              staleStartedBefore: new Date(now.getTime() - 60_000),
              tokenHash: operation.tokenHash ?? "",
            }),
          ),
        ),
      );

      expect(
        results.filter((result) => result.status === "ACQUIRED"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "IN_FLIGHT"),
      ).toHaveLength(9);
    });
  });

  it("stores encrypted secret transactionally and leaves no plaintext columns", async () => {
    await withDatabase(async (database) => {
      const provider = new MemoryKeyProvider("fulfillment-mk-v1");
      const operation = await createOperation(database);
      const lease = await withRepository(database.schemaName, (repository) =>
        repository.acquireRetrievalLease({
          executionToken: randomUUID(),
          fulfillmentId: operation.id,
          now,
          staleStartedBefore: new Date(now.getTime() - 60_000),
          tokenHash: operation.tokenHash ?? "",
        }),
      );
      if (lease.status !== "ACQUIRED") {
        throw new Error("Expected fulfillment lease");
      }
      const material = await encryptFulfillmentSecret(
        Buffer.from(canaryProductKey, "utf8"),
        fulfillmentEncryptionContext(lease.operation),
        provider,
      );
      const retrieved = await withRepository(
        database.schemaName,
        (repository) =>
          repository.markRetrieved({
            executionToken: lease.operation.retrievalExecutionToken ?? "",
            fulfillmentId: operation.id,
            material,
            now,
          }),
      );
      const secret = await withRepository(database.schemaName, (repository) =>
        repository.findSecretByFulfillmentId(operation.id),
      );

      expect(retrieved?.status).toBe("DELIVERY_PENDING");
      expect(retrieved?.retrievalState).toBe("RETRIEVED");
      expect(retrieved?.deliveryState).toBe("PENDING");
      expect(secret?.encryptionKeyId).toBe("fulfillment-mk-v1");
      expect(safeStringify({ retrieved, secret })).not.toContain(
        canaryProductKey,
      );

      const columns = await database.query<{ readonly column_name: string }>(
        `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name IN ('fulfillment_operations', 'fulfillment_secrets')
        `,
      );
      expect(columns.rows.map((row) => row.column_name)).not.toEqual(
        expect.arrayContaining([
          "plaintext_key",
          "product_key",
          "raw_supplier_response",
          "supplier_response_json",
          "customer_visible_key_copy",
        ]),
      );
    });
  });

  it("keeps terminal retrieved state from stale overwrite", async () => {
    await withDatabase(async (database) => {
      const provider = new MemoryKeyProvider("fulfillment-mk-v1");
      const operation = await createOperation(database);
      const lease = await withRepository(database.schemaName, (repository) =>
        repository.acquireRetrievalLease({
          executionToken: randomUUID(),
          fulfillmentId: operation.id,
          now,
          staleStartedBefore: new Date(now.getTime() - 60_000),
          tokenHash: operation.tokenHash ?? "",
        }),
      );
      if (lease.status !== "ACQUIRED") {
        throw new Error("Expected fulfillment lease");
      }
      await withRepository(database.schemaName, async (repository) =>
        repository.markRetrieved({
          executionToken: lease.operation.retrievalExecutionToken ?? "",
          fulfillmentId: operation.id,
          material: await encryptFulfillmentSecret(
            Buffer.from(canaryProductKey, "utf8"),
            fulfillmentEncryptionContext(lease.operation),
            provider,
          ),
          now,
        }),
      );
      await expect(
        withRepository(database.schemaName, (repository) =>
          repository.markFailed({
            executionToken: lease.operation.retrievalExecutionToken ?? "",
            fulfillmentId: operation.id,
            now,
            reasonCode: "FULFILLMENT_SUPPLIER_REJECTED",
            status: "FAILED_TERMINAL",
          }),
        ),
      ).resolves.toBeNull();
      await expect(
        withRepository(database.schemaName, (repository) =>
          repository.findById(operation.id),
        ),
      ).resolves.toMatchObject({ status: "DELIVERY_PENDING" });
    });
  });

  it("queries 50k fulfillment metadata rows without decrypting secrets", async () => {
    await withDatabase(async (database) => {
      await database.query(
        `
        INSERT INTO fulfillment_operations(
          id, supplier_id, external_supplier_order_id, expected_quantity,
          status, retrieval_state, delivery_state, token_hash,
          correlation_id, created_at, updated_at, record_version
        )
        SELECT
          gen_random_uuid(),
          'kinguin',
          'GE-' || series,
          1,
          'READY',
          'NOT_STARTED',
          'NOT_READY',
          repeat('a', 64),
          'bulk-' || series,
          $1,
          $1,
          1
        FROM generate_series(1, 50000) AS series
      `,
        [now],
      );
      const started = performance.now();
      const result = await database.query<{ readonly count: string }>(
        "SELECT count(*)::text FROM fulfillment_operations WHERE supplier_id = 'kinguin' AND status = 'READY'",
      );
      const elapsedMs = performance.now() - started;

      expect(result.rows[0]?.count).toBe("50000");
      expect(elapsedMs).toBeLessThan(1_500);
    });
  });
});

const createOperation = async (
  database: PostgresTestDatabase,
): Promise<FulfillmentOperation> => {
  const approval = controlledApprovalFixture();
  await withControlledRepository(database.schemaName, (repository) =>
    repository.create(approval),
  );
  const operation = operationFixture({
    controlledProcurementApprovalId: approval.approvalId,
  });
  const result = await withRepository(database.schemaName, (repository) =>
    repository.createIdempotent({ now, operation }),
  );
  return result.operation;
};

const operationFixture = (
  overrides: Partial<FulfillmentOperation> = {},
): FulfillmentOperation => ({
  approvalExpiresAt: new Date(now.getTime() + 300_000),
  controlledProcurementApprovalId: randomUUID(),
  correlationId: correlationId("fulfillment-persistence"),
  createdAt: now,
  deliveryState: "NOT_READY",
  expectedQuantity: 1,
  externalSupplierOrderId: "GE1373B866F3",
  id: randomUUID(),
  orderId: null,
  procurementOperationId: null,
  recordVersion: 1,
  retrievalState: "NOT_STARTED",
  status: "READY",
  supplierId: supplierId("kinguin"),
  supplierItemReference: "offer-alpha",
  tokenHash: "a".repeat(64),
  updatedAt: now,
  ...overrides,
});

const controlledApprovalFixture = (): ControlledProcurementApproval => ({
  approvalId: randomUUID(),
  claimedAt: now,
  completedAt: now,
  consumedAt: now,
  createdAt: now,
  currentAcquisitionAmount: money(498n, currency("EUR")),
  dispatchStartedAt: now,
  dispatchState: "DISPATCH_CONFIRMED",
  expiresAt: new Date(now.getTime() + 300_000),
  externalSupplierOrderId: "GE1373B866F3",
  maximumAcquisitionAmount: money(498n, currency("EUR")),
  mode: "CONTROLLED_VERIFICATION",
  orderExternalId: `keycore-liveverify-${randomUUID()}`,
  productTitle: "Anno 2070",
  purchaseRequestFingerprint: "b".repeat(64),
  quantity: 1,
  recordVersion: 1,
  responseFingerprint: "c".repeat(64),
  status: "PROCUREMENT_CONFIRMED",
  supplierId: "kinguin",
  supplierOfferId: supplierOfferId("5fb5819ffdae4e0001c6277c"),
  supplierProductId: supplierProductId("5c9b5eab2539a4e8f172143e"),
  supplierStatus: "processing",
  tokenHash: hashExecutionToken("already-consumed"),
  updatedAt: now,
});

const withRepository = async <TResult>(
  schemaName: string,
  action: (repository: PostgresFulfillmentRepository) => Promise<TResult>,
): Promise<TResult> => {
  if (!connectionString) {
    throw new Error("KEYCORE_TEST_DATABASE_URL is required");
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `SET search_path TO ${quoteIdentifier(schemaName)}, public`,
    );
    return await action(
      new PostgresFulfillmentRepository(new ClientBoundary(client)),
    );
  } finally {
    await client.end();
  }
};

const withControlledRepository = async <TResult>(
  schemaName: string,
  action: (
    repository: PostgresControlledProcurementApprovalRepository,
  ) => Promise<TResult>,
): Promise<TResult> => {
  if (!connectionString) {
    throw new Error("KEYCORE_TEST_DATABASE_URL is required");
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `SET search_path TO ${quoteIdentifier(schemaName)}, public`,
    );
    return await action(
      new PostgresControlledProcurementApprovalRepository(
        new ClientBoundary(client),
      ),
    );
  } finally {
    await client.end();
  }
};

const withDatabase = async (
  action: (database: PostgresTestDatabase) => Promise<void>,
): Promise<void> => {
  const database = await PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `fulfillment_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await action(database);
  } finally {
    await database.cleanup();
  }
};

class ClientBoundary implements TransactionalQueryable {
  public constructor(private readonly client: Client) {}

  public async query<TResult extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<TResult>> {
    return this.client.query<TResult>(sql, values ? [...values] : undefined);
  }

  public async transaction<TResult>(
    callback: (client: Queryable) => Promise<TResult>,
  ): Promise<TResult> {
    await this.client.query("BEGIN");
    try {
      const result = await callback(this);
      await this.client.query("COMMIT");
      return result;
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }
}

class MemoryKeyProvider implements KeyManagementProvider {
  public constructor(private readonly keyId: string) {}

  public async activeMasterKeyVersion(): Promise<string> {
    return this.keyId;
  }

  public async wrapDataKey(request: { readonly dataKey: Uint8Array }) {
    return {
      keyVersion: this.keyId,
      wrappedDataKey: Buffer.from(request.dataKey).map((byte) => byte ^ 0xa5),
    };
  }

  public async unwrapDataKey(request: {
    readonly wrappedDataKey: Uint8Array;
    readonly keyVersion: string;
  }) {
    if (request.keyVersion !== this.keyId) {
      throw new Error("wrong key");
    }
    return Buffer.from(request.wrappedDataKey).map((byte) => byte ^ 0xa5);
  }

  public async getKeyVersionMetadata() {
    return { provider: "memory", version: this.keyId };
  }
}

const safeStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, current) =>
    typeof current === "bigint" ? current.toString() : current,
  );
