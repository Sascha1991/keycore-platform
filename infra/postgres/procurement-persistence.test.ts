import { randomUUID } from "node:crypto";

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
import { PostgresTestDatabase } from "./test-database.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;

describe.skipIf(!connectionString)(
  "PostgresProcurementOperationRepository",
  () => {
    it("creates one logical operation for 10 concurrent starts without raw unique errors", async () => {
      await withDatabase(async (database) => {
        const repository = new PostgresProcurementOperationRepository(
          transactional(database),
        );
        const order = await insertOrderFixture(database);
        const attempts = await Promise.all(
          Array.from({ length: 10 }, () =>
            repository.createNextAttempt({
              now,
              operation: operationFixture(order),
            }),
          ),
        );

        expect(
          attempts.filter((attempt) => attempt.status === "CREATED"),
        ).toHaveLength(1);
        expect(
          attempts.filter((attempt) => attempt.status === "EXISTING"),
        ).toHaveLength(9);
        expect(await repository.listByOrder(order)).toHaveLength(1);
      });
    });

    it("allows one active execution owner and treats stale post-dispatch as ambiguous", async () => {
      await withDatabase(async (database) => {
        const repository = new PostgresProcurementOperationRepository(
          transactional(database),
        );
        const order = await insertOrderFixture(database);
        const created = await repository.createNextAttempt({
          now,
          operation: operationFixture(order),
        });
        const createdOperation = requireOperation(created.operation);
        const leases = await Promise.all(
          Array.from({ length: 10 }, () =>
            repository.acquireExecutionLease({
              executionToken: randomUUID(),
              now,
              operationId: createdOperation.id,
              staleStartedBefore: new Date(now.getTime() - 60_000),
            }),
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
        await repository.markDispatchStarted({
          executionToken: acquiredToken,
          now,
          operationId: createdOperation.id,
        });
        const stale = await repository.acquireExecutionLease({
          executionToken: randomUUID(),
          now: new Date(now.getTime() + 120_000),
          operationId: createdOperation.id,
          staleStartedBefore: new Date(now.getTime() + 60_000),
        });

        expect(stale.status).toBe("STALE_DISPATCH_STARTED");
      });
    });

    it("enforces one successful procurement per order and stores no product key", async () => {
      await withDatabase(async (database) => {
        const repository = new PostgresProcurementOperationRepository(
          transactional(database),
        );
        const order = await insertOrderFixture(database);
        const created = await repository.createNextAttempt({
          now,
          operation: operationFixture(order),
        });
        const createdOperation = requireOperation(created.operation);
        const lease = await repository.acquireExecutionLease({
          executionToken: randomUUID(),
          now,
          operationId: createdOperation.id,
          staleStartedBefore: new Date(now.getTime() - 60_000),
        });
        if (lease.status !== "ACQUIRED" || !lease.operation.executionToken) {
          throw new Error("Expected acquired procurement lease");
        }
        await repository.markDispatchStarted({
          executionToken: lease.operation.executionToken,
          now,
          operationId: createdOperation.id,
        });
        const succeeded = await repository.markSucceeded({
          acquisitionAmount: money(1_000n, currency("EUR")),
          executionToken: lease.operation.executionToken,
          externalSupplierOrderId: "supplier-order-alpha",
          normalizedSupplierStatus: "FULFILLED",
          now,
          operationId: createdOperation.id,
          responseFingerprint: "safe-fingerprint",
        });
        expect(succeeded?.status).toBe("SUCCEEDED");

        const blocked = await repository.createNextAttempt({
          now,
          operation: operationFixture(order),
        });
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
  },
);

const now = new Date("2026-08-24T12:00:00.000Z");

const transactional = (database: Queryable): TransactionalQueryable => ({
  query: (sql, values) => database.query(sql, values),
  transaction: async (callback) => {
    await database.query("BEGIN");
    try {
      const result = await callback(database);
      await database.query("COMMIT");
      return result;
    } catch (error) {
      await database.query("ROLLBACK");
      throw error;
    }
  },
});

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

const requireOperation = (
  operation: ProcurementOperation | undefined,
): ProcurementOperation => {
  if (!operation) {
    throw new Error("Expected procurement operation");
  }
  return operation;
};
