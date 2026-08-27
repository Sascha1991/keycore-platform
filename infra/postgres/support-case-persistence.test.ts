import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  SupportCaseService,
  correlationId,
  customerId,
  orderId,
  type AuthenticatedCustomerPrincipal,
  type CustomerId,
  type OrderId,
  type SupportOperatorAuthorityPort,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";
import { PostgresSupportCaseRepository } from "./support-case-repositories.js";
import { PostgresTestDatabase } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const now = new Date("2026-08-27T14:00:00.000Z");

describe.skipIf(!connectionString)("PostgresSupportCaseRepository", () => {
  it("persists customer-owned cases with SQL-scoped listing and internal-note hiding", async () => {
    await withDatabase(async (database) => {
      const fixture = await createSupportFixture(database);
      const service = supportService(database, true);
      const created = await service.createCustomerCase({
        category: "ORDER_STATUS",
        correlationId: correlationId("pg-support-create"),
        message: "Customer visible question",
        orderId: fixture.orderA,
        principal: principal(fixture.customerA),
      });
      const caseId = requireCreatedCaseId(created);

      await service.addOperatorNote({
        caseId,
        correlationId: correlationId("pg-support-note"),
        message: "Internal-only note",
        visibility: "INTERNAL",
      });

      const customerView = await service.getCustomerCase({
        caseId,
        principal: principal(fixture.customerA),
      });
      expect(JSON.stringify(customerView)).not.toContain("Internal-only note");
      await expect(
        service.getCustomerCase({
          caseId,
          principal: principal(fixture.customerB),
        }),
      ).resolves.toMatchObject({
        code: "RESOURCE_NOT_AVAILABLE",
        status: "FAILED",
      });
      const page = await service.listCustomerCases({
        principal: principal(fixture.customerA),
      });
      expect(page.status === "LISTED" ? page.page.items : []).toHaveLength(1);
    });
  });

  it("enforces message, event, and ownership persistence constraints", async () => {
    await withDatabase(async (database) => {
      const fixture = await createSupportFixture(database);
      const service = supportService(database);
      const created = await service.createCustomerCase({
        category: "ORDER_STATUS",
        correlationId: correlationId("pg-support-constraints"),
        message: "Valid customer message",
        orderId: fixture.orderA,
        principal: principal(fixture.customerA),
      });
      const caseId = requireCreatedCaseId(created);

      await expect(
        database.query(
          `
            INSERT INTO support_messages(
              id, case_id, author_type, visibility, body, created_at
            )
            VALUES ($1, $2, 'CUSTOMER', 'INTERNAL', 'not allowed', $3)
          `,
          [randomUUID(), caseId, now],
        ),
      ).rejects.toThrow();
      await expect(
        database.query(
          "UPDATE support_cases SET customer_id = $2 WHERE id = $1",
          [caseId, fixture.customerB],
        ),
      ).rejects.toThrow("Support case ownership and source are immutable");
      await expect(
        database.query(
          "UPDATE support_case_events SET actor_reference = 'changed' WHERE case_id = $1",
          [caseId],
        ),
      ).rejects.toThrow("Support case events are append-only");
    });
  });

  it("uses optimistic concurrency for status changes", async () => {
    await withDatabase(async (database) => {
      const fixture = await createSupportFixture(database);
      const service = supportService(database, true);
      const created = await service.createCustomerCase({
        category: "ORDER_STATUS",
        correlationId: correlationId("pg-support-concurrency"),
        message: "Need help",
        orderId: fixture.orderA,
        principal: principal(fixture.customerA),
      });
      const caseId = requireCreatedCaseId(created);
      const version =
        created.status === "CREATED" ? created.detail.case.recordVersion : 0;

      await expect(
        service.transitionCase({
          caseId,
          correlationId: correlationId("pg-support-resolve"),
          expectedVersion: version,
          nextStatus: "RESOLVED",
          resolutionCode: "INFORMATION_PROVIDED",
        }),
      ).resolves.toMatchObject({ status: "OK" });
      await expect(
        service.transitionCase({
          caseId,
          correlationId: correlationId("pg-support-stale"),
          expectedVersion: version,
          nextStatus: "CLOSED",
        }),
      ).resolves.toMatchObject({
        code: "STALE_VERSION",
        status: "FAILED",
      });
    });
  });

  it("links only exact-order dispute, fraud, and fulfillment references", async () => {
    await withDatabase(async (database) => {
      const fixture = await createSupportFixture(database);
      const service = supportService(database, true);
      const created = await service.createCustomerCase({
        category: "KEY_NOT_AVAILABLE",
        correlationId: correlationId("pg-support-link"),
        message: "Fulfillment problem",
        orderId: fixture.orderA,
        principal: principal(fixture.customerA),
      });
      const caseId = requireCreatedCaseId(created);
      const disputeId = await insertDisputeSnapshot(database, fixture.orderA);
      const fraudEvaluationId = await insertFraudEvaluation(
        database,
        fixture.orderA,
      );
      const fraudReviewId = await insertFraudReview(
        database,
        fixture.orderA,
        fraudEvaluationId,
      );
      const crossOrderFulfillmentId = await insertFulfillment(
        database,
        fixture.orderB,
      );

      await expect(
        service.linkReference({
          caseId,
          correlationId: correlationId("pg-link-dispute"),
          linkType: "DISPUTE_EVIDENCE",
          targetId: disputeId,
        }),
      ).resolves.toMatchObject({ status: "OK" });
      await expect(
        service.linkReference({
          caseId,
          correlationId: correlationId("pg-link-fraud"),
          linkType: "FRAUD_REVIEW",
          targetId: fraudReviewId,
        }),
      ).resolves.toMatchObject({ status: "OK" });
      await expect(
        service.linkReference({
          caseId,
          correlationId: correlationId("pg-link-cross-fulfillment"),
          linkType: "FULFILLMENT",
          targetId: crossOrderFulfillmentId,
        }),
      ).resolves.toMatchObject({
        code: "RESOURCE_NOT_AVAILABLE",
        status: "FAILED",
      });
    });
  });
});

const withDatabase = async (
  callback: (database: PostgresTestDatabase) => Promise<void>,
): Promise<void> => {
  const database = await PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `support_cases_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await callback(database);
  } finally {
    await database.cleanup();
  }
};

const supportService = (
  database: PostgresTestDatabase,
  trustedOperator = false,
): SupportCaseService =>
  new SupportCaseService({
    now: () => now,
    ...(trustedOperator
      ? { operatorAuthority: new TrustedSupportAuthority() }
      : {}),
    repository: new PostgresSupportCaseRepository(
      new TestTransactionBoundary(database),
    ),
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

const createSupportFixture = async (
  database: PostgresTestDatabase,
): Promise<{
  readonly customerA: CustomerId;
  readonly customerB: CustomerId;
  readonly orderA: OrderId;
  readonly orderB: OrderId;
}> => {
  const customerA = customerId(randomUUID());
  const customerB = customerId(randomUUID());
  await insertCustomer(database, customerA, "support-a@example.test");
  await insertCustomer(database, customerB, "support-b@example.test");
  const orderA = await insertOrder(
    database,
    customerA,
    "support-a@example.test",
  );
  const orderB = await insertOrder(
    database,
    customerB,
    "support-b@example.test",
  );
  return { customerA, customerB, orderA, orderB };
};

const insertCustomer = async (
  database: PostgresTestDatabase,
  id: CustomerId,
  email: string,
): Promise<void> => {
  await database.query(
    `
      INSERT INTO keycore_customers(
        id, email_normalized, email_verification_state, record_version,
        created_at, updated_at
      )
      VALUES ($1, $2, 'VERIFIED', 1, $3, $3)
    `,
    [id, email, now],
  );
};

const insertOrder = async (
  database: PostgresTestDatabase,
  owner: CustomerId,
  email: string,
): Promise<OrderId> => {
  const productId = randomUUID();
  const priceLockId = randomUUID();
  const createdOrderId = orderId(randomUUID());
  await database.query(
    "INSERT INTO products(id, product_type, title, platform) VALUES ($1, 'DIGITAL_KEY', 'Support Fixture', 'PC')",
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
        'CONSUMED', 1, $5, $6, 'pg-support-correlation', $7, $8)
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
        id, product_id, price_lock_id, customer_id, checkout_email_normalized,
        customer_amount_minor, currency, quantity, status, payment_status,
        procurement_status, fulfillment_status, risk_status, refund_status,
        record_version, idempotency_key, idempotency_fingerprint, correlation_id,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 2999, 'EUR', 1,
        'PAYMENT_CAPTURED', 'CAPTURED', 'NOT_STARTED', 'NOT_STARTED',
        'APPROVED', 'NOT_REQUESTED', 1, $6, $7, 'pg-support-order', $8, $8)
    `,
    [
      createdOrderId,
      productId,
      priceLockId,
      owner,
      email,
      `order-${createdOrderId}`,
      `fingerprint-${createdOrderId}`,
      now,
    ],
  );
  return createdOrderId;
};

const insertDisputeSnapshot = async (
  database: PostgresTestDatabase,
  order: OrderId,
): Promise<string> => {
  const id = randomUUID();
  await database.query(
    `
      INSERT INTO dispute_evidence_snapshots(
        id, order_id, version, state, schema_version, policy_version,
        fact_fingerprint, sections, created_at, finalized_at
      )
      VALUES ($1, $2, 1, 'DRAFT', 'KS_DISPUTE_EVIDENCE_V1',
        'KS_DISPUTE_EVIDENCE_V1', $3, '[{"type":"ORDER","status":"AVAILABLE","facts":[]}]'::jsonb, $4, NULL)
    `,
    [id, order, "a".repeat(64), now],
  );
  return id;
};

const insertFraudEvaluation = async (
  database: PostgresTestDatabase,
  order: OrderId,
): Promise<string> => {
  const id = randomUUID();
  await database.query(
    `
      INSERT INTO fraud_risk_evaluations(
        id, order_id, decision, risk_score, reason_codes, evaluated_at,
        policy_version, fact_fingerprint
      )
      VALUES ($1, $2, 'REVIEW', 50, ARRAY['MANUAL_REVIEW_POLICY_MATCH'], $3,
        'KS09_POLICY_V1', $4)
    `,
    [id, order, now, "b".repeat(64)],
  );
  return id;
};

const insertFraudReview = async (
  database: PostgresTestDatabase,
  order: OrderId,
  evaluationId: string,
): Promise<string> => {
  const id = randomUUID();
  await database.query(
    `
      INSERT INTO fraud_manual_review_cases(
        id, order_id, source, status, evaluation_id, fact_fingerprint,
        reason_codes, opened_at
      )
      VALUES ($1, $2, 'FRAUD', 'OPEN', $3, $4,
        ARRAY['MANUAL_REVIEW_POLICY_MATCH'], $5)
    `,
    [id, order, evaluationId, "b".repeat(64), now],
  );
  return id;
};

const insertFulfillment = async (
  database: PostgresTestDatabase,
  order: OrderId,
): Promise<string> => {
  const id = randomUUID();
  await database.query(
    `
      INSERT INTO fulfillment_operations(
        id, order_id, procurement_operation_id, supplier_id, external_supplier_order_id,
        expected_quantity, status, retrieval_state, delivery_state, record_version,
        correlation_id, created_at, updated_at, controlled_procurement_approval_id,
        token_hash
      )
      VALUES ($1, $2, NULL, 'supplier-pg-support', 'external-pg-support',
        1, 'PENDING', 'NOT_STARTED', 'NOT_READY', 1, 'pg-support-fulfillment',
        $3, $3, NULL, $4)
    `,
    [id, order, now, "a".repeat(64)],
  );
  return id;
};

const requireCreatedCaseId = (
  result: Awaited<ReturnType<SupportCaseService["createCustomerCase"]>>,
): string => {
  if (result.status !== "CREATED") {
    throw new Error("Expected support case to be created");
  }
  return result.detail.case.id;
};

const principal = (id: CustomerId): AuthenticatedCustomerPrincipal => ({
  authenticationContext: { assurance: "AUTHENTICATED", provider: "KEYCORE" },
  customerId: id,
});

class TrustedSupportAuthority implements SupportOperatorAuthorityPort {
  public async authorize(): Promise<{
    readonly status: "AUTHORIZED";
    readonly operatorReference: string;
  }> {
    return { operatorReference: "operator:pg-support", status: "AUTHORIZED" };
  }
}
