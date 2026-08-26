import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  FraudRiskService,
  correlationId,
  orderId,
  type OrderId,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";
import { PostgresFraudRiskRepository } from "./fraud-risk-repositories.js";
import { PostgresTestDatabase } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const now = new Date("2026-08-27T10:00:00.000Z");

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
): PostgresFraudRiskRepository =>
  new PostgresFraudRiskRepository(new TestTransactionBoundary(database));

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
  },
): Promise<OrderId> => {
  const productId = randomUUID();
  const priceLockId = randomUUID();
  const createdOrderId = orderId(randomUUID());
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
      now,
      new Date(now.getTime() + 60_000),
    ],
  );
  await database.query(
    `
      INSERT INTO keycore_orders(
        id, product_id, price_lock_id, customer_amount_minor, currency,
        quantity, status, payment_status, procurement_status, fulfillment_status,
        risk_status, refund_status, record_version, idempotency_key,
        idempotency_fingerprint, correlation_id, created_at, updated_at
      )
      VALUES ($1, $2, $3, 2999, 'EUR', 1, $4, $5, 'NOT_STARTED', 'NOT_STARTED',
        'NOT_EVALUATED', 'NOT_REQUESTED', 1, $6, $7, 'pg-fraud-order', $8, $8)
    `,
    [
      createdOrderId,
      productId,
      priceLockId,
      input.status,
      input.paymentStatus,
      `order-${createdOrderId}`,
      `fingerprint-${createdOrderId}`,
      now,
    ],
  );
  return createdOrderId;
};
