import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  FraudRiskService,
  correlationId,
  defaultFraudVelocityWindows,
  orderId,
  type FraudVelocityEventAuthorityPort,
  type FraudVelocityPolicy,
  type OrderId,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";
import { PostgresFraudRiskRepository } from "./fraud-risk-repositories.js";
import { PostgresTestDatabase } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const now = new Date("2026-08-27T10:00:00.000Z");
const velocityCorrelationTestKey = "test-velocity-correlation-key-000001";

describe.skipIf(!connectionString)("PostgresFraudRiskRepository", () => {
  it("persists idempotent evaluations, re-evaluates changed facts and keeps one open fraud case", async () => {
    await withDatabase(async (database) => {
      const order = await createOrder(database, {
        paymentStatus: "PENDING",
        status: "AWAITING_PAYMENT",
      });
      const service = new FraudRiskService({
        now: () => now,
        repository: repository(database),
      });

      const first = await service.evaluateOrder({
        correlationId: correlationId("pg-fraud-first"),
        orderId: order,
      });
      const repeated = await service.evaluateOrder({
        correlationId: correlationId("pg-fraud-repeated"),
        orderId: order,
      });
      expect(first).toMatchObject({
        evaluation: {
          decision: "REVIEW",
          reasonCodes: ["PAYMENT_NOT_CONFIRMED"],
        },
        reviewCase: { status: "OPEN" },
        status: "EVALUATED",
      });
      expect(
        repeated.status === "EVALUATED"
          ? repeated.evaluation.riskDecisionId
          : null,
      ).toBe(
        first.status === "EVALUATED" ? first.evaluation.riskDecisionId : null,
      );

      const concurrent = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          service.evaluateOrder({
            correlationId: correlationId(`pg-fraud-concurrent-${index}`),
            orderId: order,
          }),
        ),
      );
      expect(
        new Set(
          concurrent.map((result) =>
            result.status === "EVALUATED"
              ? result.evaluation.riskDecisionId
              : "",
          ),
        ).size,
      ).toBe(1);
      const cases = await database.query<{ readonly count: string }>(
        "SELECT count(*) FROM fraud_manual_review_cases WHERE order_id = $1 AND status = 'OPEN'",
        [order],
      );
      expect(cases.rows[0]?.count).toBe("1");

      await database.query(
        `
          UPDATE keycore_orders
          SET payment_status = 'CAPTURED',
            status = 'PAYMENT_CAPTURED',
            updated_at = $2
          WHERE id = $1
        `,
        [order, new Date(now.getTime() + 1_000)],
      );
      const changed = await service.evaluateOrder({
        correlationId: correlationId("pg-fraud-changed"),
        orderId: order,
      });
      expect(changed).toMatchObject({
        evaluation: { decision: "ALLOW", reasonCodes: ["RISK_POLICY_ALLOW"] },
        status: "EVALUATED",
      });
      expect(
        changed.status === "EVALUATED"
          ? changed.evaluation.riskDecisionId
          : null,
      ).not.toBe(
        first.status === "EVALUATED" ? first.evaluation.riskDecisionId : null,
      );
    });
  });

  it("enforces safe persistence constraints", async () => {
    await withDatabase(async (database) => {
      const order = await createOrder(database, {
        paymentStatus: "CAPTURED",
        status: "PAYMENT_CAPTURED",
      });
      await expect(
        database.query(
          `
            INSERT INTO fraud_risk_evaluations(
              id, order_id, decision, risk_score, reason_codes,
              evaluated_at, policy_version, fact_fingerprint
            )
            VALUES ($1, $2, 'ALLOW', 101, ARRAY['RISK_POLICY_ALLOW'], $3, 'KS09_POLICY_V1', $4)
          `,
          [randomUUID(), order, now, "a".repeat(64)],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `
            INSERT INTO fraud_risk_evaluations(
              id, order_id, decision, risk_score, reason_codes,
              evaluated_at, policy_version, fact_fingerprint
            )
            VALUES ($1, $2, 'ALLOW', 0, ARRAY['RISK_POLICY_ALLOW'], $3, 'KS09_POLICY_V1', 'not-a-hash')
          `,
          [randomUUID(), order, now],
        ),
      ).rejects.toThrow();
    });
  });

  it("enforces velocity event constraints and concurrent idempotency", async () => {
    await withDatabase(async (database) => {
      const order = await createOrder(database, {
        checkoutEmailNormalized: "velocity-concurrent@example.test",
        paymentStatus: "CAPTURED",
        status: "PAYMENT_CAPTURED",
      });
      const service = new FraudRiskService({
        now: () => now,
        repository: repository(database, velocityCorrelationTestKey),
        velocity: {
          eventAuthority: new TrustedVelocityEventAuthority(now),
          policy: velocityPolicy(),
          repository: repository(database, velocityCorrelationTestKey),
        },
      });

      const concurrent = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          service.recordVelocityEventForOrder({
            correlationId: correlationId(`pg-velocity-concurrent-${index}`),
            orderId: order,
          }),
        ),
      );
      expect(
        concurrent.filter((result) => result.status === "RECORDED"),
      ).toHaveLength(1);
      expect(
        concurrent.filter((result) => result.status === "IDEMPOTENT"),
      ).toHaveLength(5);
      await expect(
        database.query(
          `
            INSERT INTO fraud_velocity_events(
              id, event_type, order_id, subject_type, subject_key,
              amount_minor, currency, occurred_at, recorded_at
            )
            VALUES ($1, 'PAYMENT_CONFIRMED', $2, 'CHECKOUT_EMAIL',
              'velocity-concurrent@example.test', 1, 'EUR', $3, $3)
          `,
          [randomUUID(), order, now],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          `
            INSERT INTO fraud_velocity_events(
              id, event_type, order_id, subject_type, subject_key,
              amount_minor, currency, occurred_at, recorded_at
            )
            VALUES ($1, 'PAYMENT_CONFIRMED', $2, 'CUSTOMER',
              'safe-subject-key', -1, 'EUR', $3, $3)
          `,
          [randomUUID(), order, now],
        ),
      ).rejects.toThrow();

      const persisted = await database.query<{ readonly count: string }>(
        "SELECT count(*)::text FROM fraud_velocity_events WHERE order_id = $1",
        [order],
      );
      expect(persisted.rows[0]?.count).toBe("1");
    });
  });

  it("fails closed without a velocity correlation secret and avoids partial event persistence", async () => {
    await withDatabase(async (database) => {
      const customer = await createCustomer(
        database,
        "velocity-owner@example.test",
      );
      const order = await createOrder(database, {
        checkoutEmailNormalized: "velocity-missing-correlation@example.test",
        customerId: customer,
        paymentStatus: "CAPTURED",
        status: "PAYMENT_CAPTURED",
      });

      await expect(
        repository(database).recordOrderVelocityEvent({
          eventType: "PAYMENT_CONFIRMED",
          occurredAt: now,
          orderId: order,
          recordedAt: now,
        }),
      ).resolves.toEqual({
        insertedEventCount: 0,
        status: "UNAVAILABLE",
        subjectEventCount: 0,
      });

      const persisted = await database.query<{ readonly count: string }>(
        "SELECT count(*)::text FROM fraud_velocity_events WHERE order_id = $1",
        [order],
      );
      expect(persisted.rows[0]?.count).toBe("0");
    });
  });

  it("opens a new current review case after changed facts while retaining stale review history", async () => {
    await withDatabase(async (database) => {
      const order = await createOrder(database, {
        paymentStatus: "PENDING",
        status: "AWAITING_PAYMENT",
      });
      const service = new FraudRiskService({
        now: () => now,
        repository: repository(database),
      });
      const first = await service.evaluateOrder({
        correlationId: correlationId("pg-fraud-review-history-first"),
        orderId: order,
      });
      if (first.status !== "EVALUATED" || !first.reviewCase) {
        throw new Error("expected first fraud review case");
      }

      await database.query(
        `
          UPDATE keycore_orders
          SET payment_status = 'CAPTURED',
            status = 'PAYMENT_CAPTURED',
            risk_status = 'REVIEW_REQUIRED',
            updated_at = $2
          WHERE id = $1
        `,
        [order, new Date(now.getTime() + 2_000)],
      );
      const second = await service.evaluateOrder({
        correlationId: correlationId("pg-fraud-review-history-second"),
        orderId: order,
      });

      expect(second).toMatchObject({
        evaluation: {
          decision: "REVIEW",
          reasonCodes: ["MANUAL_REVIEW_POLICY_MATCH"],
        },
        reviewCase: { status: "OPEN" },
        status: "EVALUATED",
      });
      expect(
        second.status === "EVALUATED" ? second.reviewCase?.caseId : null,
      ).not.toBe(first.reviewCase.caseId);
      const cases = await database.query<{ readonly count: string }>(
        "SELECT count(*) FROM fraud_manual_review_cases WHERE order_id = $1 AND source = 'FRAUD'",
        [order],
      );
      expect(cases.rows[0]?.count).toBe("2");
    });
  });

  it("persists velocity events idempotently with pseudonymous subjects and windowed aggregates", async () => {
    await withDatabase(async (database) => {
      const first = await createOrder(database, {
        checkoutEmailNormalized: "velocity@example.test",
        createdAt: new Date(now.getTime() - 60 * 60 * 1000),
        paymentStatus: "CAPTURED",
        status: "PAYMENT_CAPTURED",
      });
      const second = await createOrder(database, {
        checkoutEmailNormalized: "velocity@example.test",
        createdAt: new Date(now.getTime() - 60 * 60 * 1000),
        paymentStatus: "CAPTURED",
        status: "PAYMENT_CAPTURED",
      });
      const service = new FraudRiskService({
        now: () => now,
        repository: repository(database, velocityCorrelationTestKey),
        velocity: {
          eventAuthority: new TrustedVelocityEventAuthority(now),
          policy: velocityPolicy(),
          repository: repository(database, velocityCorrelationTestKey),
        },
      });

      await expect(
        service.recordVelocityEventForOrder({
          correlationId: correlationId("pg-velocity-first"),
          orderId: first,
        }),
      ).resolves.toEqual({
        insertedEventCount: 1,
        status: "RECORDED",
        subjectEventCount: 1,
      });
      await expect(
        service.recordVelocityEventForOrder({
          correlationId: correlationId("pg-velocity-first-replay"),
          orderId: first,
        }),
      ).resolves.toEqual({
        insertedEventCount: 0,
        status: "IDEMPOTENT",
        subjectEventCount: 1,
      });
      await repository(
        database,
        velocityCorrelationTestKey,
      ).recordOrderVelocityEvent({
        eventType: "PAYMENT_CONFIRMED",
        occurredAt: new Date(now.getTime() - 15 * 60 * 1000),
        orderId: second,
        recordedAt: now,
      });

      const persisted = await database.query<{
        readonly count: string;
        readonly raw_email_count: string;
      }>(
        `
          SELECT
            count(*)::text,
            count(*) FILTER (WHERE subject_key = 'velocity@example.test')::text AS raw_email_count
          FROM fraud_velocity_events
        `,
      );
      expect(persisted.rows[0]).toEqual({ count: "2", raw_email_count: "0" });

      const review = await service.evaluateOrder({
        correlationId: correlationId("pg-velocity-review"),
        orderId: first,
      });
      expect(review).toMatchObject({
        evaluation: {
          decision: "REVIEW",
          policyVersion: "KS09_POLICY_V2",
          reasonCodes: [
            "VELOCITY_AMOUNT_REVIEW",
            "VELOCITY_ORDER_COUNT_REVIEW",
          ],
        },
        status: "EVALUATED",
      });
    });
  });
});

const withDatabase = async (
  callback: (database: PostgresTestDatabase) => Promise<void>,
): Promise<void> => {
  const database = await PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `fraud_risk_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await callback(database);
  } finally {
    await database.cleanup();
  }
};

const repository = (
  database: PostgresTestDatabase,
  velocityCorrelationSecret?: string,
): PostgresFraudRiskRepository =>
  new PostgresFraudRiskRepository(new TestTransactionBoundary(database), {
    ...(velocityCorrelationSecret ? { velocityCorrelationSecret } : {}),
  });

class TestTransactionBoundary implements TransactionalQueryable {
  public constructor(private readonly database: PostgresTestDatabase) {}

  public async query<TResult extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) {
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

const createOrder = async (
  database: PostgresTestDatabase,
  input: {
    readonly status: string;
    readonly paymentStatus: string;
    readonly checkoutEmailNormalized?: string | null;
    readonly customerId?: string | null;
    readonly createdAt?: Date;
  },
): Promise<OrderId> => {
  const productId = randomUUID();
  const priceLockId = randomUUID();
  const createdOrderId = orderId(randomUUID());
  const createdAt = input.createdAt ?? now;
  await database.query(
    "INSERT INTO products(id, product_type, title, platform) VALUES ($1, 'DIGITAL_KEY', 'Fraud Fixture', 'PC')",
    [productId],
  );
  await database.query(
    `
      INSERT INTO price_locks(
        id, product_id, currency, locked_sell_price_minor, pricing_quote_fingerprint,
        source_fingerprint, pricing_policy_version, pricing_policy_record_version,
        tax_policy_version, fee_policy_version, status, record_version,
        idempotency_key, idempotency_fingerprint, correlation_id, created_at, expires_at
      )
      VALUES ($1, $2, 'EUR', 2999, $3, $4, 'pricing-v1', 1, 'tax-v1', 'fee-v1',
        'CONSUMED', 1, $5, $6, 'pg-fraud-correlation', $7, $8)
    `,
    [
      priceLockId,
      productId,
      `quote-${priceLockId}`,
      `source-${priceLockId}`,
      `lock-${priceLockId}`,
      `fingerprint-${priceLockId}`,
      createdAt,
      new Date(now.getTime() + 60_000),
    ],
  );
  await database.query(
    `
      INSERT INTO keycore_orders(
        id, product_id, price_lock_id, customer_id, checkout_email_normalized, customer_amount_minor, currency,
        quantity, status, payment_status, procurement_status, fulfillment_status,
        risk_status, refund_status, record_version, idempotency_key,
        idempotency_fingerprint, correlation_id, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 2999, 'EUR', 1, $6, $7, 'NOT_STARTED', 'NOT_STARTED',
        'NOT_EVALUATED', 'NOT_REQUESTED', 1, $8, $9, 'pg-fraud-order', $10, $10)
    `,
    [
      createdOrderId,
      productId,
      priceLockId,
      input.customerId ?? null,
      input.checkoutEmailNormalized ?? null,
      input.status,
      input.paymentStatus,
      `order-${createdOrderId}`,
      `fingerprint-${createdOrderId}`,
      createdAt,
    ],
  );
  return createdOrderId;
};

const createCustomer = async (
  database: PostgresTestDatabase,
  emailNormalized: string,
): Promise<string> => {
  const id = randomUUID();
  await database.query(
    `
      INSERT INTO keycore_customers(
        id, email_normalized, email_verification_state, record_version,
        created_at, updated_at
      )
      VALUES ($1, $2, 'VERIFIED', 1, $3, $3)
    `,
    [id, emailNormalized, now],
  );
  return id;
};

const velocityPolicy = (): FraudVelocityPolicy => ({
  thresholds: [
    {
      amountMinor: { deny: 8_000n, review: 5_000n },
      count: { deny: 3, review: 2 },
      currency: "EUR",
      eventType: "PAYMENT_CONFIRMED",
      window: "PT24H",
    },
  ],
  windows: [...defaultFraudVelocityWindows],
});

class TrustedVelocityEventAuthority implements FraudVelocityEventAuthorityPort {
  public constructor(private readonly occurredAt: Date) {}

  public async authorizePaymentConfirmedVelocityEvent(): Promise<{
    readonly status: "AUTHORIZED";
    readonly eventType: "PAYMENT_CONFIRMED";
    readonly occurredAt: Date;
  }> {
    return {
      eventType: "PAYMENT_CONFIRMED",
      occurredAt: this.occurredAt,
      status: "AUTHORIZED",
    };
  }
}
