import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  currency,
  money,
  productId,
  type CorrelationId,
  type ProductId,
} from "../../packages/platform/src/contracts.js";
import {
  OrderOrchestrationService,
  type KeyCoreOrder,
} from "../../packages/platform/src/orders/order-orchestration.js";
import { PriceLockService } from "../../packages/platform/src/pricing/price-locks.js";
import type {
  PricingService,
  ProductPriceSelection,
  SellPriceQuote,
} from "../../packages/platform/src/pricing/pricing-margin.js";
import { PostgresPriceLockRepository } from "./price-lock-repositories.js";
import { PostgresOrderRepository } from "./order-repositories.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const eur = currency("EUR");
const correlationId = "corr-postgres-orders" as CorrelationId;

describePostgres("PostgresOrderRepository", () => {
  it("creates an order, claims the PriceLock and writes history/outbox transactionally", async () => {
    const database = await initDatabase();
    try {
      const product = await insertFixtureProduct(database);
      const lock = await createActiveLock(database, product);

      const result = await withOrderClient(database.schemaName, (service) =>
        service.createOrder({
          correlationId,
          idempotencyKey: "order-pg-1",
          priceLockId: lock.id,
          productId: product,
          quantity: 1,
        }),
      );

      expect(result).toMatchObject({
        order: {
          customerAmount: money(1_300n, eur),
          priceLockId: lock.id,
          productId: product,
          status: "CREATED",
        },
        status: "CREATED",
      });
      await expect(priceLockStatus(database, lock.id)).resolves.toBe(
        "CONSUMED",
      );
      await expect(orderCount(database)).resolves.toBe(1);
      const order = required(result.order);
      await expect(historyCount(database, order.id)).resolves.toBe(1);
      await expect(outboxCount(database, order.id)).resolves.toBe(1);
    } finally {
      await database.cleanup();
    }
  }, 30_000);

  it("creates exactly one logical order for concurrent same-key same-input calls", async () => {
    const database = await initDatabase();
    try {
      const product = await insertFixtureProduct(database);
      const lock = await createActiveLock(database, product);
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          withOrderClient(database.schemaName, (service) =>
            service.createOrder({
              correlationId,
              idempotencyKey: "same-order-race",
              priceLockId: lock.id,
              productId: product,
              quantity: 1,
            }),
          ),
        ),
      );

      expect(
        results.filter((result) => result.status === "CREATED"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "IDEMPOTENT"),
      ).toHaveLength(9);
      expect(new Set(results.map((result) => result.order?.id)).size).toBe(1);
      await expect(orderCount(database)).resolves.toBe(1);
      await expect(priceLockStatus(database, lock.id)).resolves.toBe(
        "CONSUMED",
      );
    } finally {
      await database.cleanup();
    }
  });

  it("processes 10 unrelated orders concurrently without a repository-wide lock", async () => {
    const database = await initDatabase();
    try {
      const product = await insertFixtureProduct(database);
      const locks = await Promise.all(
        Array.from({ length: 10 }, () => createActiveLock(database, product)),
      );
      const results = await Promise.all(
        locks.map((lock, index) =>
          withOrderClient(database.schemaName, (service) =>
            service.createOrder({
              correlationId,
              idempotencyKey: `independent-order-${index}`,
              priceLockId: lock.id,
              productId: product,
              quantity: 1,
            }),
          ),
        ),
      );

      expect(results.every((result) => result.status === "CREATED")).toBe(true);
      expect(new Set(results.map((result) => result.order?.id)).size).toBe(10);
      await expect(orderCount(database)).resolves.toBe(10);
      const lockStates = await priceLockStates(
        database,
        locks.map((lock) => lock.id),
      );
      expect(
        [...lockStates.values()].every((status) => status === "CONSUMED"),
      ).toBe(true);
      const businessEffects = await database.query<{
        readonly history_count: string;
        readonly outbox_count: string;
      }>(`
        SELECT
          (SELECT count(*)::text FROM order_state_history) AS history_count,
          (SELECT count(*)::text FROM outbox_events WHERE event_type = 'order.created') AS outbox_count
      `);
      expect(businessEffects.rows[0]).toEqual({
        history_count: "10",
        outbox_count: "10",
      });
    } finally {
      await database.cleanup();
    }
  }, 30_000);

  it("fails closed when concurrent different idempotency keys try the same PriceLock", async () => {
    const database = await initDatabase();
    try {
      const product = await insertFixtureProduct(database);
      const lock = await createActiveLock(database, product);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_value, index) =>
          withOrderClient(database.schemaName, (service) =>
            service.createOrder({
              correlationId,
              idempotencyKey: `same-lock-${index}`,
              priceLockId: lock.id,
              productId: product,
              quantity: 1,
            }),
          ),
        ),
      );

      expect(
        results.filter((result) => result.status === "CREATED"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status !== "CREATED"),
      ).toHaveLength(9);
      expect(
        results
          .filter((result) => result.status !== "CREATED")
          .every((result) =>
            ["PRICE_LOCK_CONSUMED", "PRICE_LOCK_UNSAFE"].includes(
              result.reasonCode,
            ),
          ),
      ).toBe(true);
      await expect(orderCount(database)).resolves.toBe(1);
      await expect(priceLockStatus(database, lock.id)).resolves.toBe(
        "CONSUMED",
      );
    } finally {
      await database.cleanup();
    }
  });

  it("returns idempotency conflicts without consuming losing locks when the same key races across different PriceLocks", async () => {
    const database = await initDatabase();
    try {
      const product = await insertFixtureProduct(database);
      const locks = await Promise.all(
        Array.from({ length: 10 }, () => createActiveLock(database, product)),
      );
      const results = await Promise.all(
        locks.map((lock) =>
          withOrderClient(database.schemaName, (service) =>
            service.createOrder({
              correlationId,
              idempotencyKey: "same-key-different-locks",
              priceLockId: lock.id,
              productId: product,
              quantity: 1,
            }),
          ),
        ),
      );

      expect(
        results.filter((result) => result.status === "CREATED"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "CONFLICT"),
      ).toHaveLength(9);
      expect(
        results
          .filter((result) => result.status === "CONFLICT")
          .every(
            (result) => result.reasonCode === "ORDER_IDEMPOTENCY_CONFLICT",
          ),
      ).toBe(true);
      expect(new Set(results.map((result) => result.order?.id)).size).toBe(1);
      await expect(orderCount(database)).resolves.toBe(1);
      const winningOrder = required(
        results.find((result) => result.status === "CREATED")?.order,
      );
      await expect(outboxCount(database, winningOrder.id)).resolves.toBe(1);
      await expect(historyCount(database, winningOrder.id)).resolves.toBe(1);
      const lockStates = await priceLockStates(
        database,
        locks.map((lock) => lock.id),
      );
      expect(lockStates.get(winningOrder.priceLockId)).toBe("CONSUMED");
      expect(
        [...lockStates.entries()]
          .filter(([lockId]) => lockId !== winningOrder.priceLockId)
          .every((entry) => entry[1] === "ACTIVE"),
      ).toBe(true);
    } finally {
      await database.cleanup();
    }
  });

  it("returns stable idempotency conflicts for conflicting reuse after creation", async () => {
    const database = await initDatabase();
    try {
      const product = await insertFixtureProduct(database);
      const lock = await createActiveLock(database, product);
      const first = await withOrderClient(database.schemaName, (service) =>
        service.createOrder({
          correlationId,
          idempotencyKey: "conflicting-order-idem",
          priceLockId: lock.id,
          productId: product,
          quantity: 1,
        }),
      );
      const conflict = await withOrderClient(database.schemaName, (service) =>
        service.createOrder({
          correlationId,
          expectedCustomerAmount: money(1_299n, eur),
          idempotencyKey: "conflicting-order-idem",
          priceLockId: lock.id,
          productId: product,
          quantity: 1,
        }),
      );

      expect(conflict).toMatchObject({
        order: { id: first.order?.id },
        reasonCode: "ORDER_IDEMPOTENCY_CONFLICT",
        status: "CONFLICT",
      });
      await expect(orderCount(database)).resolves.toBe(1);
    } finally {
      await database.cleanup();
    }
  }, 30_000);

  it("returns explicit optimistic conflicts for simultaneous state transitions", async () => {
    const database = await initDatabase();
    try {
      const product = await insertFixtureProduct(database);
      const lock = await createActiveLock(database, product);
      const created = await createOrder(
        database,
        product,
        lock.id,
        "transition",
      );
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          withOrderClient(database.schemaName, (service) =>
            service.markAwaitingPayment({
              correlationId,
              expectedVersion: created.recordVersion,
              orderId: created.id,
            }),
          ),
        ),
      );

      expect(
        results.filter((result) => result.status === "UPDATED"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "CONFLICT"),
      ).toHaveLength(9);
      expect(
        results
          .filter((result) => result.status === "CONFLICT")
          .every(
            (result) => result.reasonCode === "OPTIMISTIC_CONCURRENCY_CONFLICT",
          ),
      ).toBe(true);
    } finally {
      await database.cleanup();
    }
  });

  it("persists external event receipts idempotently and conflicts on changed fingerprint", async () => {
    const database = await initDatabase();
    try {
      const product = await insertFixtureProduct(database);
      const lock = await createActiveLock(database, product);
      const order = await createOrder(database, product, lock.id, "receipt");

      const first = await withOrderClient(database.schemaName, (service) =>
        service.recordExternalEvent({
          correlationId,
          eventFingerprint: "same-fingerprint",
          eventType: "payment.updated",
          externalEventId: "evt-receipt",
          orderId: order.id,
          provider: "mock-payment",
        }),
      );
      const duplicate = await withOrderClient(database.schemaName, (service) =>
        service.recordExternalEvent({
          correlationId,
          eventFingerprint: "same-fingerprint",
          eventType: "payment.updated",
          externalEventId: "evt-receipt",
          orderId: order.id,
          provider: "mock-payment",
        }),
      );
      const conflict = await withOrderClient(database.schemaName, (service) =>
        service.recordExternalEvent({
          correlationId,
          eventFingerprint: "changed-fingerprint",
          eventType: "payment.updated",
          externalEventId: "evt-receipt",
          orderId: order.id,
          provider: "mock-payment",
        }),
      );

      expect(first).toEqual({ status: "RECORDED" });
      expect(duplicate).toEqual({
        reasonCode: "EXTERNAL_EVENT_DEDUPLICATED",
        status: "DUPLICATE",
      });
      expect(conflict).toEqual({
        reasonCode: "EXTERNAL_EVENT_CONFLICT",
        status: "CONFLICT",
      });
    } finally {
      await database.cleanup();
    }
  });

  it("deduplicates concurrent identical external event receipts without raw database errors", async () => {
    const database = await initDatabase();
    try {
      const product = await insertFixtureProduct(database);
      const lock = await createActiveLock(database, product);
      const order = await createOrder(
        database,
        product,
        lock.id,
        "receipt-race",
      );
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          withOrderClient(database.schemaName, (service) =>
            service.recordExternalEvent({
              correlationId,
              eventFingerprint: "same-event-race",
              eventType: "payment.updated",
              externalEventId: "evt-receipt-race",
              orderId: order.id,
              provider: "mock-payment",
            }),
          ),
        ),
      );

      expect(
        results.filter((result) => result.status === "RECORDED"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "DUPLICATE"),
      ).toHaveLength(9);
      await expect(
        externalReceiptCount(database, "mock-payment", "evt-receipt-race"),
      ).resolves.toBe(1);
    } finally {
      await database.cleanup();
    }
  });

  it("returns concurrent external event conflicts for reused identity with changed fingerprints", async () => {
    const database = await initDatabase();
    try {
      const product = await insertFixtureProduct(database);
      const lock = await createActiveLock(database, product);
      const order = await createOrder(
        database,
        product,
        lock.id,
        "receipt-conflict-race",
      );
      const results = await Promise.all(
        Array.from({ length: 10 }, (_value, index) =>
          withOrderClient(database.schemaName, (service) =>
            service.recordExternalEvent({
              correlationId,
              eventFingerprint: `event-fingerprint-${index}`,
              eventType: "payment.updated",
              externalEventId: "evt-receipt-conflict-race",
              orderId: order.id,
              provider: "mock-payment",
            }),
          ),
        ),
      );

      expect(
        results.filter((result) => result.status === "RECORDED"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "CONFLICT"),
      ).toHaveLength(9);
      expect(
        results
          .filter((result) => result.status === "CONFLICT")
          .every((result) => result.reasonCode === "EXTERNAL_EVENT_CONFLICT"),
      ).toBe(true);
      await expect(
        externalReceiptCount(
          database,
          "mock-payment",
          "evt-receipt-conflict-race",
        ),
      ).resolves.toBe(1);
    } finally {
      await database.cleanup();
    }
  });

  it("allows one concurrent refund request and keeps commercial fields immutable", async () => {
    const database = await initDatabase();
    try {
      const product = await insertFixtureProduct(database);
      const lock = await createActiveLock(database, product);
      const completed = await completeOrder(database, product, lock.id);
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          withOrderClient(database.schemaName, (service) =>
            service.requestRefund({
              correlationId,
              expectedVersion: completed.recordVersion,
              orderId: completed.id,
            }),
          ),
        ),
      );

      expect(
        results.filter((result) => result.status === "UPDATED"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "CONFLICT"),
      ).toHaveLength(9);
      await expect(
        database.query(
          "UPDATE keycore_orders SET customer_amount_minor = 1 WHERE id = $1",
          [completed.id],
        ),
      ).rejects.toThrow("commercial fields are immutable");
    } finally {
      await database.cleanup();
    }
  });

  it("rejects invalid persisted order states and partial external event identity", async () => {
    const database = await initDatabase();
    try {
      const product = await insertFixtureProduct(database);
      const lock = await createActiveLock(database, product);
      await expect(
        database.query(
          `
            INSERT INTO keycore_orders(
              product_id, price_lock_id, customer_amount_minor, currency,
              quantity, status, payment_status, procurement_status,
              fulfillment_status, risk_status, refund_status, record_version,
              idempotency_key, idempotency_fingerprint, correlation_id,
              created_at, updated_at
            )
            VALUES ($1, $2, 1300, 'EUR', 1, 'PROCUREMENT_IN_PROGRESS',
              'PENDING', 'IN_PROGRESS', 'NOT_STARTED', 'APPROVED',
              'NOT_REQUESTED', 1, 'bad-state', 'bad-fingerprint',
              $3, $4, $4)
          `,
          [
            product,
            lock.id,
            correlationId,
            new Date("2026-08-15T00:00:00.000Z"),
          ],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `
            INSERT INTO keycore_orders(
              product_id, price_lock_id, customer_amount_minor, currency,
              quantity, status, payment_status, procurement_status,
              fulfillment_status, risk_status, refund_status, record_version,
              idempotency_key, idempotency_fingerprint, correlation_id,
              created_at, updated_at
            )
            VALUES ($1, $2, 1300, 'EUR', 1, 'COMPLETED',
              'CAPTURED', 'IN_PROGRESS', 'SUCCEEDED', 'APPROVED',
              'NOT_REQUESTED', 1, 'bad-completed', 'bad-fingerprint',
              $3, $4, $4)
          `,
          [
            product,
            lock.id,
            correlationId,
            new Date("2026-08-15T00:00:00.000Z"),
          ],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `
            INSERT INTO keycore_orders(
              product_id, price_lock_id, customer_amount_minor, currency,
              quantity, status, payment_status, procurement_status,
              fulfillment_status, risk_status, refund_status, record_version,
              idempotency_key, idempotency_fingerprint, correlation_id,
              created_at, updated_at
            )
            VALUES ($1, $2, 1300, 'EUR', 1, 'REFUNDED',
              'CAPTURED', 'SUCCEEDED', 'SUCCEEDED', 'APPROVED',
              'PENDING', 1, 'bad-refunded', 'bad-fingerprint',
              $3, $4, $4)
          `,
          [
            product,
            lock.id,
            correlationId,
            new Date("2026-08-15T00:00:00.000Z"),
          ],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `
            INSERT INTO external_event_receipts(
              provider, external_event_id, event_type, event_fingerprint,
              correlation_id, received_at
            )
            VALUES ('', 'evt', 'payment.updated', 'fp', $1, $2)
          `,
          [correlationId, new Date("2026-08-15T00:00:00.000Z")],
        ),
      ).rejects.toThrow();
    } finally {
      await database.cleanup();
    }
  });
});

const initDatabase = async (): Promise<PostgresTestDatabase> =>
  PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `orders_${randomUUID().replaceAll("-", "_")}`,
  });

const insertFixtureProduct = async (
  database: PostgresTestDatabase,
): Promise<ProductId> => {
  const result = await database.query<{ readonly product_id: string }>(
    `
      INSERT INTO products(product_type, title, platform, lifecycle, active, canonical_metadata_confidence)
      VALUES ('GAME', 'Order Product', 'WINDOWS', 'IN_STOCK', true, 'HIGH')
      RETURNING id::text AS product_id
    `,
  );
  return productId(result.rows[0]?.product_id ?? "");
};

const createActiveLock = async (
  database: PostgresTestDatabase,
  targetProductId: ProductId,
) => {
  const repository = new PostgresPriceLockRepository(database);
  return repository.create({
    correlationId,
    createdAt: new Date("2026-08-15T00:00:00.000Z"),
    currency: eur,
    expiresAt: new Date("2026-08-15T00:02:00.000Z"),
    feePolicyVersion: "fee-v1",
    id: randomUUID(),
    idempotencyFingerprint: `lock-fingerprint-${randomUUID()}`,
    idempotencyKey: `lock-idem-${randomUUID()}`,
    lockedSellPrice: money(1_300n, eur),
    pricingPolicyRecordVersion: 1,
    pricingPolicyVersion: "pricing-policy-v1",
    pricingQuoteFingerprint: "quote-fingerprint",
    productId: targetProductId,
    recordVersion: 1,
    sourceOfferFingerprint: "source-fingerprint",
    status: "ACTIVE",
    taxPolicyVersion: "tax-v1",
  });
};

const createOrder = async (
  database: PostgresTestDatabase,
  targetProductId: ProductId,
  lockId: string,
  idempotencyKey: string,
): Promise<KeyCoreOrder> => {
  const result = await withOrderClient(database.schemaName, (service) =>
    service.createOrder({
      correlationId,
      idempotencyKey,
      priceLockId: lockId,
      productId: targetProductId,
      quantity: 1,
    }),
  );
  if (!result.order) {
    throw new Error("Expected order to be created");
  }
  return result.order;
};

const completeOrder = async (
  database: PostgresTestDatabase,
  targetProductId: ProductId,
  lockId: string,
): Promise<KeyCoreOrder> => {
  const created = await createOrder(
    database,
    targetProductId,
    lockId,
    "complete",
  );
  const awaiting = await mustOrder(database, created.id, (service) =>
    service.markAwaitingPayment({
      correlationId,
      expectedVersion: created.recordVersion,
      orderId: created.id,
    }),
  );
  const authorized = await mustOrder(database, created.id, (service) =>
    service.transitionPayment({
      correlationId,
      expectedVersion: awaiting.recordVersion,
      orderId: created.id,
      paymentStatus: "AUTHORIZED",
    }),
  );
  const captured = await mustOrder(database, created.id, (service) =>
    service.transitionPayment({
      correlationId,
      expectedVersion: authorized.recordVersion,
      orderId: created.id,
      paymentStatus: "CAPTURED",
    }),
  );
  const approved = await mustOrder(database, created.id, (service) =>
    service.markRisk({
      correlationId,
      expectedVersion: captured.recordVersion,
      orderId: created.id,
      riskStatus: "APPROVED",
    }),
  );
  const pending = await mustOrder(database, created.id, (service) =>
    service.markProcurementPending({
      correlationId,
      expectedVersion: approved.recordVersion,
      orderId: created.id,
    }),
  );
  const inProgress = await mustOrder(database, created.id, (service) =>
    service.beginProcurement({
      correlationId,
      expectedVersion: pending.recordVersion,
      orderId: created.id,
    }),
  );
  const fulfillment = await mustOrder(database, created.id, (service) =>
    service.recordProcurementResult({
      correlationId,
      expectedVersion: inProgress.recordVersion,
      orderId: created.id,
      procurementStatus: "SUCCEEDED",
    }),
  );
  return mustOrder(database, created.id, (service) =>
    service.recordFulfillmentResult({
      correlationId,
      expectedVersion: fulfillment.recordVersion,
      fulfillmentStatus: "SUCCEEDED",
      orderId: created.id,
    }),
  );
};

const mustOrder = async (
  database: PostgresTestDatabase,
  requestedOrderId: KeyCoreOrder["id"],
  action: (
    service: OrderOrchestrationService,
  ) => Promise<{ readonly order?: KeyCoreOrder }>,
): Promise<KeyCoreOrder> =>
  withOrderClient(database.schemaName, async (service) => {
    const result = await action(service);
    return result.order ?? required(await service.getOrder(requestedOrderId));
  });

const withOrderClient = async <TResult>(
  schemaName: string,
  action: (service: OrderOrchestrationService) => Promise<TResult>,
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
    const boundary = new ClientTransactionBoundary(client);
    const priceLocks = new PriceLockService({
      now: () => new Date("2026-08-15T00:00:30.000Z"),
      pricing: new FixturePricingService() as unknown as PricingService,
      repository: new PostgresPriceLockRepository(boundary),
    });
    return await action(
      new OrderOrchestrationService({
        now: () => new Date("2026-08-15T00:00:30.000Z"),
        operationsControlGate: {
          evaluate: async () => ({ status: "ALLOWED" }),
        },
        priceLocks,
        repository: new PostgresOrderRepository(boundary),
      }),
    );
  } finally {
    await client.end();
  }
};

class ClientTransactionBoundary implements TransactionalQueryable {
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

class FixturePricingService {
  public async quoteProduct(input: {
    readonly productId: ProductId;
  }): Promise<ProductPriceSelection> {
    const quote: SellPriceQuote = {
      acquisitionCost: money(1_000n, eur),
      calculatedAt: new Date("2026-08-15T00:00:30.000Z"),
      currency: eur,
      expectedProfit: money(300n, eur),
      hardMinimumProfit: money(50n, eur),
      hardMinimumSellPrice: money(0n, eur),
      knownFees: money(0n, eur),
      marginBasisPoints: 2_307n,
      markupBasisPoints: 3_000n,
      offerId: "fixture-offer" as SellPriceQuote["offerId"],
      preRoundingPrice: money(1_300n, eur),
      pricingPolicyRecordVersion: 1,
      pricingPolicyVersion: "pricing-policy-v1",
      productId: input.productId,
      sellPrice: money(1_300n, eur),
      sourceFingerprint: "safe-current-offer",
      status: "QUOTED",
      taxAmount: money(0n, eur),
      taxPolicyVersion: "tax-v1",
    };
    return {
      productId: input.productId,
      quotes: [quote],
      selectedQuote: quote,
      status: "QUOTED",
    };
  }
}

const priceLockStatus = async (
  database: PostgresTestDatabase,
  lockId: string,
): Promise<string> => {
  const result = await database.query<{ readonly status: string }>(
    "SELECT status FROM price_locks WHERE id = $1",
    [lockId],
  );
  return result.rows[0]?.status ?? "";
};

const priceLockStates = async (
  database: PostgresTestDatabase,
  lockIds: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  const result = await database.query<{
    readonly id: string;
    readonly status: string;
  }>("SELECT id::text, status FROM price_locks WHERE id = ANY($1::uuid[])", [
    lockIds,
  ]);
  return new Map(result.rows.map((row) => [row.id, row.status]));
};

const orderCount = async (database: PostgresTestDatabase): Promise<number> => {
  const result = await database.query<{ readonly count: string }>(
    "SELECT count(*)::text FROM keycore_orders",
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
};

const historyCount = async (
  database: PostgresTestDatabase,
  requestedOrderId: KeyCoreOrder["id"],
): Promise<number> => {
  const result = await database.query<{ readonly count: string }>(
    "SELECT count(*)::text FROM order_transition_history WHERE order_id = $1",
    [requestedOrderId],
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
};

const outboxCount = async (
  database: PostgresTestDatabase,
  requestedOrderId: KeyCoreOrder["id"],
): Promise<number> => {
  const result = await database.query<{ readonly count: string }>(
    "SELECT count(*)::text FROM outbox_events WHERE aggregate_id = $1",
    [requestedOrderId],
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
};

const externalReceiptCount = async (
  database: PostgresTestDatabase,
  provider: string,
  externalEventId: string,
): Promise<number> => {
  const result = await database.query<{ readonly count: string }>(
    `
      SELECT count(*)::text
      FROM external_event_receipts
      WHERE provider = $1 AND external_event_id = $2
    `,
    [provider, externalEventId],
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
};

const required = <TValue>(value: TValue | undefined | null): TValue => {
  if (!value) {
    throw new Error("Expected PostgreSQL test fixture value");
  }
  return value;
};
