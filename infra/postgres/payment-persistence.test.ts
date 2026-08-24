import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  currency,
  money,
  orderId,
  productId,
  type CorrelationId,
  type KeyCoreOrder,
  type ProductId,
} from "../../packages/platform/src/contracts.js";
import {
  stripePaymentIntentIdempotencyKey,
  stripePaymentIntentFingerprint,
  stripePaymentMetadata,
} from "../../packages/platform/src/payments/stripe-payments.js";
import { PostgresPaymentRepository } from "./payment-repositories.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const eur = currency("EUR");
const correlationId = "corr-postgres-payments" as CorrelationId;

describePostgres("PostgresPaymentRepository", () => {
  it("creates exactly one reserved STRIPE payment for concurrent order initialization", async () => {
    const database = await initDatabase();
    try {
      const order = await insertFixtureOrder(database);
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          withPaymentRepository(database.schemaName, (repository) =>
            repository.reserveForOrder({
              now: new Date("2026-08-15T00:01:00.000Z"),
              order,
              stripeIdempotencyKey: stripePaymentIntentIdempotencyKey(
                order.id,
                1,
              ),
            }),
          ),
        ),
      );

      expect(
        results.filter((result) => result.status === "CREATED"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "EXISTING"),
      ).toHaveLength(9);
      expect(new Set(results.map((result) => result.payment.id)).size).toBe(1);
      await expect(paymentCount(database)).resolves.toBe(1);
      await expect(
        database.query(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = $1
              AND table_name = 'order_payments'
              AND column_name = 'client_secret'
          `,
          [database.schemaName],
        ),
      ).resolves.toMatchObject({ rowCount: 0 });
    } finally {
      await database.cleanup();
    }
  });

  it("allows only one concurrent create lease claimant without globally serializing unrelated orders", async () => {
    const database = await initDatabase();
    try {
      const order = await insertFixtureOrder(database);
      const reserved = await withPaymentRepository(
        database.schemaName,
        (repository) =>
          repository.reserveForOrder({
            now: new Date("2026-08-15T00:01:00.000Z"),
            order,
            stripeIdempotencyKey: stripePaymentIntentIdempotencyKey(
              order.id,
              1,
            ),
          }),
      );
      const results = await Promise.all(
        Array.from({ length: 10 }, (_value, index) =>
          withPaymentRepository(database.schemaName, (repository) =>
            repository.acquireCreateLease({
              leaseToken: `lease-${index}`,
              now: new Date("2026-08-15T00:01:01.000Z"),
              paymentId: reserved.payment.id,
              staleAfter: new Date("2026-08-15T00:00:00.000Z"),
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

      const unrelatedA = await insertFixtureOrder(database);
      const unrelatedB = await insertFixtureOrder(database);
      const [reservedA, reservedB] = await Promise.all(
        [unrelatedA, unrelatedB].map((nextOrder) =>
          withPaymentRepository(database.schemaName, (repository) =>
            repository.reserveForOrder({
              now: new Date("2026-08-15T00:01:02.000Z"),
              order: nextOrder,
              stripeIdempotencyKey: stripePaymentIntentIdempotencyKey(
                nextOrder.id,
                1,
              ),
            }),
          ),
        ),
      );
      const unrelatedLeaseResults = await Promise.all([
        withPaymentRepository(database.schemaName, (repository) =>
          repository.acquireCreateLease({
            leaseToken: "lease-unrelated-a",
            now: new Date("2026-08-15T00:01:03.000Z"),
            paymentId: required(reservedA).payment.id,
            staleAfter: new Date("2026-08-15T00:00:00.000Z"),
          }),
        ),
        withPaymentRepository(database.schemaName, (repository) =>
          repository.acquireCreateLease({
            leaseToken: "lease-unrelated-b",
            now: new Date("2026-08-15T00:01:03.000Z"),
            paymentId: required(reservedB).payment.id,
            staleAfter: new Date("2026-08-15T00:00:00.000Z"),
          }),
        ),
      ]);
      expect(
        unrelatedLeaseResults.every((result) => result.status === "ACQUIRED"),
      ).toBe(true);
    } finally {
      await database.cleanup();
    }
  });

  it("persists provider creation, rejects external ID reuse and prevents captured regression", async () => {
    const database = await initDatabase();
    try {
      const order = await insertFixtureOrder(database);
      const reserved = await withPaymentRepository(
        database.schemaName,
        (repository) =>
          repository.reserveForOrder({
            now: new Date("2026-08-15T00:01:00.000Z"),
            order,
            stripeIdempotencyKey: stripePaymentIntentIdempotencyKey(
              order.id,
              1,
            ),
          }),
      );
      const intent = {
        amount: money(1_300n, eur),
        createdAt: new Date("2026-08-15T00:01:01.000Z"),
        currency: eur,
        id: "pi_pg_fixture_1",
        metadata: stripePaymentMetadata({
          orderId: order.id,
          paymentVersion: 1,
        }),
        status: "succeeded" as const,
      };
      const created = await withPaymentRepository(
        database.schemaName,
        async (repository) => {
          const lease = await repository.acquireCreateLease({
            leaseToken: "lease-created",
            now: new Date("2026-08-15T00:01:01.000Z"),
            paymentId: reserved.payment.id,
            staleAfter: new Date("2026-08-15T00:00:00.000Z"),
          });
          if (lease.status !== "ACQUIRED") {
            throw new Error("Expected payment create lease");
          }
          return repository.markProviderCreated({
            externalPaymentId: intent.id,
            lastProviderEventAt: intent.createdAt,
            leaseToken: lease.leaseToken,
            now: new Date("2026-08-15T00:01:02.000Z"),
            paymentId: reserved.payment.id,
            providerFingerprint: stripePaymentIntentFingerprint(intent),
            status: "CAPTURED",
          });
        },
      );

      expect(created).toMatchObject({
        payment: {
          externalPaymentId: "pi_pg_fixture_1",
          status: "CAPTURED",
        },
        status: "UPDATED",
      });
      await expect(
        withPaymentRepository(database.schemaName, (repository) =>
          repository.updateFromProvider({
            expectedVersion: required(created.payment).recordVersion,
            lastProviderEventAt: new Date("2026-08-15T00:00:59.000Z"),
            now: new Date("2026-08-15T00:01:03.000Z"),
            paymentId: reserved.payment.id,
            providerFingerprint: "older-processing",
            reconciliationRequired: false,
            status: "PROCESSING",
          }),
        ),
      ).resolves.toMatchObject({
        payment: { status: "CAPTURED" },
        status: "NOOP",
      });
      const other = await insertFixtureOrder(database);
      const otherReservation = await withPaymentRepository(
        database.schemaName,
        (repository) =>
          repository.reserveForOrder({
            now: new Date("2026-08-15T00:01:04.000Z"),
            order: other,
            stripeIdempotencyKey: stripePaymentIntentIdempotencyKey(
              other.id,
              1,
            ),
          }),
      );
      await expect(
        withPaymentRepository(database.schemaName, async (repository) => {
          const lease = await repository.acquireCreateLease({
            leaseToken: "lease-duplicate",
            now: new Date("2026-08-15T00:01:04.000Z"),
            paymentId: otherReservation.payment.id,
            staleAfter: new Date("2026-08-15T00:00:00.000Z"),
          });
          if (lease.status !== "ACQUIRED") {
            throw new Error("Expected duplicate payment create lease");
          }
          return repository.markProviderCreated({
            externalPaymentId: "pi_pg_fixture_1",
            lastProviderEventAt: new Date("2026-08-15T00:01:05.000Z"),
            leaseToken: lease.leaseToken,
            now: new Date("2026-08-15T00:01:05.000Z"),
            paymentId: otherReservation.payment.id,
            providerFingerprint: "duplicate-external",
            status: "REQUIRES_PAYMENT_METHOD",
          });
        }),
      ).rejects.toThrow();
    } finally {
      await database.cleanup();
    }
  });

  it("enforces payment amount, status, provider and immutable commercial constraints", async () => {
    const database = await initDatabase();
    try {
      const order = await insertFixtureOrder(database);
      await expect(
        database.query(
          `
            INSERT INTO order_payments(
              order_id, provider, amount_minor, currency, status,
              record_version, operation_version, stripe_idempotency_key,
              created_at, updated_at
            )
            VALUES ($1, 'STRIPE', 0, 'EUR', 'CREATION_PENDING', 1, 1, 'zero', now(), now())
          `,
          [order.id],
        ),
      ).rejects.toThrow();
      const reserved = await withPaymentRepository(
        database.schemaName,
        (repository) =>
          repository.reserveForOrder({
            now: new Date("2026-08-15T00:01:00.000Z"),
            order,
            stripeIdempotencyKey: stripePaymentIntentIdempotencyKey(
              order.id,
              1,
            ),
          }),
      );
      await expect(
        database.query(
          "UPDATE order_payments SET amount_minor = 1400 WHERE id = $1",
          [reserved.payment.id],
        ),
      ).rejects.toThrow("immutable");
      await expect(
        database.query(
          "UPDATE order_payments SET status = 'UNKNOWN' WHERE id = $1",
          [reserved.payment.id],
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
    schemaName: `payments_${randomUUID().replaceAll("-", "_")}`,
  });

const insertFixtureOrder = async (
  database: PostgresTestDatabase,
): Promise<KeyCoreOrder> => {
  const product = await insertFixtureProduct(database);
  const lockId = randomUUID();
  const createdAt = new Date("2026-08-15T00:00:00.000Z");
  await database.query(
    `
      INSERT INTO price_locks(
        id, product_id, currency, locked_sell_price_minor,
        pricing_quote_fingerprint, source_fingerprint, pricing_policy_version,
        pricing_policy_record_version, tax_policy_version, fee_policy_version,
        status, record_version, idempotency_key, idempotency_fingerprint,
        correlation_id, created_at, expires_at
      )
      VALUES (
        $1, $2, 'EUR', 1300, 'quote', 'source', 'pricing-v1',
        1, 'tax-v1', 'fee-v1', 'CONSUMED', 1, $3, $4,
        $5, $6, $7
      )
    `,
    [
      lockId,
      product,
      `lock-${randomUUID()}`,
      `lock-fp-${randomUUID()}`,
      correlationId,
      createdAt,
      new Date("2026-08-15T00:02:00.000Z"),
    ],
  );
  const result = await database.query<{ readonly order_id: string }>(
    `
      INSERT INTO keycore_orders(
        product_id, price_lock_id, customer_amount_minor, currency, quantity,
        status, payment_status, procurement_status, fulfillment_status,
        risk_status, refund_status, record_version, idempotency_key,
        idempotency_fingerprint, correlation_id, created_at, updated_at
      )
      VALUES (
        $1, $2, 1300, 'EUR', 1, 'CREATED', 'NOT_STARTED', 'NOT_STARTED',
        'NOT_STARTED', 'NOT_EVALUATED', 'NOT_REQUESTED', 1, $3, $4, $5, $6, $6
      )
      RETURNING id::text AS order_id
    `,
    [
      product,
      lockId,
      `order-${randomUUID()}`,
      `order-fp-${randomUUID()}`,
      correlationId,
      createdAt,
    ],
  );
  return {
    correlationId,
    createdAt,
    currency: eur,
    customerAmount: money(1_300n, eur),
    fulfillmentStatus: "NOT_STARTED",
    id: orderId(result.rows[0]?.order_id ?? ""),
    idempotencyFingerprint: "order-fp",
    idempotencyKey: "order",
    paymentStatus: "NOT_STARTED",
    priceLockId: lockId,
    procurementStatus: "NOT_STARTED",
    productId: product,
    quantity: 1,
    recordVersion: 1,
    refundStatus: "NOT_REQUESTED",
    riskStatus: "NOT_EVALUATED",
    status: "CREATED",
    updatedAt: createdAt,
  };
};

const insertFixtureProduct = async (
  database: PostgresTestDatabase,
): Promise<ProductId> => {
  const result = await database.query<{ readonly product_id: string }>(
    `
      INSERT INTO products(product_type, title, platform, lifecycle, active, canonical_metadata_confidence)
      VALUES ('GAME', 'Payment Product', 'WINDOWS', 'IN_STOCK', true, 'HIGH')
      RETURNING id::text AS product_id
    `,
  );
  return productId(result.rows[0]?.product_id ?? "");
};

const withPaymentRepository = async <TResult>(
  schemaName: string,
  action: (repository: PostgresPaymentRepository) => Promise<TResult>,
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
      new PostgresPaymentRepository(new ClientBoundary(client)),
    );
  } finally {
    await client.end();
  }
};

const paymentCount = async (
  database: PostgresTestDatabase,
): Promise<number> => {
  const result = await database.query<{ readonly count: string }>(
    "SELECT count(*)::text AS count FROM order_payments",
  );
  return Number(result.rows[0]?.count ?? "0");
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

const required = <TValue>(value: TValue | undefined | null): TValue => {
  if (!value) {
    throw new Error("Expected test fixture value");
  }
  return value;
};
