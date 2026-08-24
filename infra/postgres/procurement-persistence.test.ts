import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  correlationId,
  currency,
  idempotencyKey,
  money,
  orderId,
  supplierId,
  supplierOfferId,
  supplierProductId,
  type OrderId,
} from "../../packages/platform/src/contracts.js";
import type { ProcurementOperation } from "../../packages/platform/src/procurement/supplier-procurement.js";
import { PostgresProcurementOperationRepository } from "./procurement-repositories.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;

describe.skipIf(!connectionString)(
  "PostgresProcurementOperationRepository",
  () => {
    it("creates one logical operation for 10 concurrent starts without raw unique errors", async () => {
      await withDatabase(async (database) => {
        const order = await insertOrderFixture(database);
        const attempts = await Promise.all(
          Array.from({ length: 10 }, () =>
            withProcurementRepository(database.schemaName, (repository) =>
              repository.createNextAttempt({
                now,
                operation: operationFixture(order),
              }),
            ),
          ),
        );

        expect(
          attempts.filter((attempt) => attempt.status === "CREATED"),
        ).toHaveLength(1);
        expect(
          attempts.filter((attempt) => attempt.status === "EXISTING"),
        ).toHaveLength(9);
        await expect(operationCount(database, order)).resolves.toBe(1);
        expect(
          new Set(
            attempts.map((attempt) => requireOperation(attempt.operation).id),
          ).size,
        ).toBe(1);
      });
    });

    it("allows one active execution owner and treats stale post-dispatch as ambiguous", async () => {
      await withDatabase(async (database) => {
        const order = await insertOrderFixture(database);
        const created = await withProcurementRepository(
          database.schemaName,
          (repository) =>
            repository.createNextAttempt({
              now,
              operation: operationFixture(order),
            }),
        );
        const createdOperation = requireOperation(created.operation);
        const leases = await Promise.all(
          Array.from({ length: 10 }, () =>
            withProcurementRepository(database.schemaName, (repository) =>
              repository.acquireExecutionLease({
                executionToken: randomUUID(),
                now,
                operationId: createdOperation.id,
                staleStartedBefore: new Date(now.getTime() - 60_000),
              }),
            ),
          ),
        );
        const acquired = leases.find((lease) => lease.status === "ACQUIRED");
        if (acquired?.status !== "ACQUIRED") {
          throw new Error("Expected one acquired procurement lease");
        }
        const acquiredToken = acquired.operation.executionToken;
        if (!acquiredToken) {
          throw new Error("Expected acquired procurement lease token");
        }

        expect(
          leases.filter((lease) => lease.status === "ACQUIRED"),
        ).toHaveLength(1);
        expect(
          leases.filter((lease) => lease.status === "IN_FLIGHT"),
        ).toHaveLength(9);
        await withProcurementRepository(database.schemaName, (repository) =>
          repository.markDispatchStarted({
            executionToken: acquiredToken,
            now,
            operationId: createdOperation.id,
          }),
        );
        const stale = await withProcurementRepository(
          database.schemaName,
          (repository) =>
            repository.acquireExecutionLease({
              executionToken: randomUUID(),
              now: new Date(now.getTime() + 120_000),
              operationId: createdOperation.id,
              staleStartedBefore: new Date(now.getTime() + 60_000),
            }),
        );

        expect(stale.status).toBe("STALE_DISPATCH_STARTED");
        await withProcurementRepository(database.schemaName, (repository) =>
          repository.markReconciliation({
            now: new Date(now.getTime() + 120_000),
            operationId: createdOperation.id,
            reasonCode: "STALE_DISPATCH_REQUIRES_RECONCILIATION",
            status: "AMBIGUOUS",
          }),
        );
        await expect(
          operationStatus(database, createdOperation.id),
        ).resolves.toBe("AMBIGUOUS");
      });
    });

    it("enforces one successful procurement per order and stores no product key", async () => {
      await withDatabase(async (database) => {
        const order = await insertOrderFixture(database);
        const created = await withProcurementRepository(
          database.schemaName,
          (repository) =>
            repository.createNextAttempt({
              now,
              operation: operationFixture(order),
            }),
        );
        const createdOperation = requireOperation(created.operation);
        const lease = await withProcurementRepository(
          database.schemaName,
          (repository) =>
            repository.acquireExecutionLease({
              executionToken: randomUUID(),
              now,
              operationId: createdOperation.id,
              staleStartedBefore: new Date(now.getTime() - 60_000),
            }),
        );
        if (lease.status !== "ACQUIRED" || !lease.operation.executionToken) {
          throw new Error("Expected acquired procurement lease");
        }
        const leaseToken = lease.operation.executionToken;
        await withProcurementRepository(database.schemaName, (repository) =>
          repository.markDispatchStarted({
            executionToken: leaseToken,
            now,
            operationId: createdOperation.id,
          }),
        );
        const succeeded = await withProcurementRepository(
          database.schemaName,
          (repository) =>
            repository.markSucceeded({
              acquisitionAmount: money(1_000n, currency("EUR")),
              executionToken: leaseToken,
              externalSupplierOrderId: "supplier-order-alpha",
              normalizedSupplierStatus: "FULFILLED",
              now,
              operationId: createdOperation.id,
              responseFingerprint: "safe-fingerprint",
            }),
        );
        expect(succeeded?.status).toBe("SUCCEEDED");

        const blocked = await withProcurementRepository(
          database.schemaName,
          (repository) =>
            repository.createNextAttempt({
              now,
              operation: operationFixture(order),
            }),
        );
        expect(blocked.status).toBe("BLOCKED");

        await expect(
          database.query(
            `
            INSERT INTO procurement_operations(
              id, order_id, supplier_id, supplier_product_id, supplier_offer_id,
              quantity, status, dispatch_state, response_fingerprint,
              attempt_generation, record_version, correlation_id, created_at, updated_at
            )
            VALUES (
              gen_random_uuid(), $1, 'mock-supplier', 'sp-alpha', 'so-alpha',
              1, 'AMBIGUOUS', 'DISPATCH_STARTED', 'plaintext-product-key',
              2, 1, 'corr', now(), now()
            )
          `,
            [order],
          ),
        ).rejects.toThrow();
      });
    });

    it("recovers stale not-dispatched leases, keeps unrelated operations independent and enforces ownership", async () => {
      await withDatabase(async (database) => {
        const [orderA, orderB] = await Promise.all([
          insertOrderFixture(database),
          insertOrderFixture(database),
        ]);
        const createdResults = await Promise.all(
          [orderA, orderB].map((order) =>
            withProcurementRepository(database.schemaName, (repository) =>
              repository.createNextAttempt({
                now,
                operation: operationFixture(order),
              }),
            ),
          ),
        );
        const [createdA, createdB] = requirePair(createdResults);
        const operationA = requireOperation(createdA.operation);
        const operationB = requireOperation(createdB.operation);
        const leaseResults = await Promise.all(
          [operationA, operationB].map((operation) =>
            withProcurementRepository(database.schemaName, (repository) =>
              repository.acquireExecutionLease({
                executionToken: randomUUID(),
                now,
                operationId: operation.id,
                staleStartedBefore: new Date(now.getTime() - 60_000),
              }),
            ),
          ),
        );
        const [leaseA, leaseB] = requirePair(leaseResults);

        expect([leaseA.status, leaseB.status]).toEqual([
          "ACQUIRED",
          "ACQUIRED",
        ]);
        if (leaseA.status !== "ACQUIRED" || !leaseA.operation.executionToken) {
          throw new Error("Expected lease A");
        }
        const leaseAToken = leaseA.operation.executionToken;
        const unrelatedToken = randomUUID();
        const recoveredToken = randomUUID();
        expect(
          await withProcurementRepository(database.schemaName, (repository) =>
            repository.markDispatchStarted({
              executionToken: unrelatedToken,
              now,
              operationId: operationA.id,
            }),
          ),
        ).toBeNull();
        const recovered = await withProcurementRepository(
          database.schemaName,
          (repository) =>
            repository.acquireExecutionLease({
              executionToken: recoveredToken,
              now: new Date(now.getTime() + 120_000),
              operationId: operationA.id,
              staleStartedBefore: new Date(now.getTime() + 60_000),
            }),
        );
        expect(recovered.status).toBe("ACQUIRED");
        if (recovered.status !== "ACQUIRED") {
          throw new Error("Expected recovered lease");
        }
        expect(recovered.operation.executionToken).toBe(recoveredToken);
        expect(
          await withProcurementRepository(database.schemaName, (repository) =>
            repository.markSucceeded({
              acquisitionAmount: money(1_000n, currency("EUR")),
              executionToken: leaseAToken,
              externalSupplierOrderId: "supplier-order-old-token",
              normalizedSupplierStatus: "FULFILLED",
              now,
              operationId: operationA.id,
              responseFingerprint: "old-token-digest",
            }),
          ),
        ).toBeNull();
      });
    });

    it("allows generation 2 after terminal failure and blocks after ambiguous or succeeded attempts", async () => {
      await withDatabase(async (database) => {
        const order = await insertOrderFixture(database);
        const terminalToken = randomUUID();
        const first = await withProcurementRepository(
          database.schemaName,
          (repository) =>
            repository.createNextAttempt({
              now,
              operation: operationFixture(order),
            }),
        );
        const firstOperation = requireOperation(first.operation);
        const lease = await withProcurementRepository(
          database.schemaName,
          (repository) =>
            repository.acquireExecutionLease({
              executionToken: terminalToken,
              now,
              operationId: firstOperation.id,
              staleStartedBefore: new Date(now.getTime() - 60_000),
            }),
        );
        if (lease.status !== "ACQUIRED") {
          throw new Error("Expected terminal test lease");
        }
        await withProcurementRepository(database.schemaName, (repository) =>
          repository.markFailed({
            executionToken: terminalToken,
            now,
            operationId: firstOperation.id,
            reasonCode: "SUPPLIER_REJECTED",
            status: "FAILED_TERMINAL",
          }),
        );
        const second = await withProcurementRepository(
          database.schemaName,
          (repository) =>
            repository.createNextAttempt({
              now,
              operation: {
                ...operationFixture(order),
                supplierOfferId: supplierOfferId("so-beta"),
                supplierProductId: supplierProductId("sp-beta"),
              },
            }),
        );
        expect(second).toMatchObject({
          operation: { attemptGeneration: 2 },
          status: "CREATED",
        });

        await withProcurementRepository(database.schemaName, (repository) =>
          repository.markReconciliation({
            now,
            operationId: requireOperation(second.operation).id,
            reasonCode: "SUPPLIER_NETWORK_AMBIGUOUS",
            status: "AMBIGUOUS",
          }),
        );
        const blocked = await withProcurementRepository(
          database.schemaName,
          (repository) =>
            repository.createNextAttempt({
              now,
              operation: operationFixture(order),
            }),
        );
        expect(blocked.status).toBe("EXISTING");
      });
    });
  },
);

const now = new Date("2026-08-24T12:00:00.000Z");

const withProcurementRepository = async <TResult>(
  schemaName: string,
  action: (
    repository: PostgresProcurementOperationRepository,
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
      new PostgresProcurementOperationRepository(new ClientBoundary(client)),
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
    schemaName: `procurement_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await action(database);
  } finally {
    await database.cleanup();
  }
};

const insertOrderFixture = async (database: Queryable): Promise<OrderId> => {
  const product = randomUUID();
  const lock = randomUUID();
  const order = randomUUID();
  await database.query(
    "INSERT INTO products(id, product_type, title, platform) VALUES ($1, 'GAME', 'Synthetic Product', 'WINDOWS')",
    [product],
  );
  await database.query(
    `
      INSERT INTO price_locks(
        id, product_id, currency, locked_sell_price_minor,
        pricing_quote_fingerprint, source_fingerprint, pricing_policy_version,
        pricing_policy_record_version, tax_policy_version, fee_policy_version,
        status, record_version, correlation_id, created_at, expires_at,
        consumed_at, reason_code
      )
      VALUES (
        $1, $2, 'EUR', 2000, 'quote', 'source', 'pricing-policy-v1',
        1, 'tax', 'fee', 'CONSUMED', 1, 'corr', $3, $4, $3,
        'PRICE_LOCK_CONSUMED'
      )
    `,
    [lock, product, now, new Date(now.getTime() + 300_000)],
  );
  await database.query(
    `
      INSERT INTO keycore_orders(
        id, product_id, price_lock_id, customer_amount_minor, currency,
        quantity, status, payment_status, procurement_status,
        fulfillment_status, risk_status, refund_status, record_version,
        idempotency_key, idempotency_fingerprint, correlation_id,
        created_at, updated_at
      )
      VALUES (
        $1, $2, $3, 2000, 'EUR', 1, 'PAYMENT_CAPTURED', 'CAPTURED',
        'NOT_STARTED', 'NOT_STARTED', 'APPROVED', 'NOT_REQUESTED',
        1, $4, 'fingerprint', 'corr', $5, $5
      )
    `,
    [order, product, lock, `idem-${order}`, now],
  );
  return orderId(order);
};

const operationFixture = (fixtureOrderId: OrderId): ProcurementOperation => ({
  acquisitionAmount: money(1_000n, currency("EUR")),
  attemptGeneration: 1,
  clientIdempotencyReference: idempotencyKey(
    `keycore:procurement:${fixtureOrderId}:mock-supplier:g1`,
  ),
  correlationId: correlationId("corr"),
  createdAt: now,
  dispatchState: "NOT_DISPATCHED",
  id: randomUUID(),
  orderId: fixtureOrderId,
  quantity: 1,
  recordVersion: 1,
  status: "READY",
  supplierId: supplierId("mock-supplier"),
  supplierOfferId: supplierOfferId("so-alpha"),
  supplierProductId: supplierProductId("sp-alpha"),
  updatedAt: now,
});

const operationCount = async (
  database: Queryable,
  requestedOrderId: OrderId,
): Promise<number> => {
  const result = await database.query<{ readonly count: string }>(
    "SELECT count(*)::text AS count FROM procurement_operations WHERE order_id = $1",
    [requestedOrderId],
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
};

const operationStatus = async (
  database: Queryable,
  operationIdValue: string,
): Promise<string> => {
  const result = await database.query<{ readonly status: string }>(
    "SELECT status FROM procurement_operations WHERE id = $1",
    [operationIdValue],
  );
  return result.rows[0]?.status ?? "";
};

const requireOperation = (
  operation: ProcurementOperation | undefined,
): ProcurementOperation => {
  if (!operation) {
    throw new Error("Expected procurement operation");
  }
  return operation;
};

const requirePair = <TValue>(
  values: readonly TValue[],
): readonly [TValue, TValue] => {
  const [first, second] = values;
  if (!first || !second) {
    throw new Error("Expected two fixture values");
  }
  return [first, second];
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
