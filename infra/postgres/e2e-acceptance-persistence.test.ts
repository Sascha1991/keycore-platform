import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  CustomerOrderIdentityService,
  OrderOrchestrationService,
  PriceLockService,
  SupportCaseService,
  correlationId,
  currency,
  money,
  productId,
  type AuthenticatedCustomerPrincipal,
  type CorrelationId,
  type CustomerId,
  type EmailVerificationAuthorityPort,
  type KeyCoreOrder,
  type OrderId,
  type OrderOwnershipBindingAuthorityPort,
  type PricingService,
  type ProductId,
  type ProductPriceSelection,
  type SellPriceQuote,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";
import { PostgresCustomerOrderIdentityRepository } from "./customer-order-identity-repositories.js";
import { PostgresOrderRepository } from "./order-repositories.js";
import { PostgresPriceLockRepository } from "./price-lock-repositories.js";
import { PostgresSupportCaseRepository } from "./support-case-repositories.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const now = new Date("2026-08-28T12:00:00.000Z");
const eur = currency("EUR");

describe.skipIf(!connectionString)("KS-11-02 PostgreSQL E2E coherence", () => {
  it("E2E-PG-001 persists one coherent owned purchase and support journey", async () => {
    const database = await PostgresTestDatabase.initialize({
      connectionString,
      schemaName: `e2e_${randomUUID().replaceAll("-", "_")}`,
    });
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await client.query(
        `SET search_path TO ${quoteIdentifier(database.schemaName)}, public`,
      );
      const boundary = new ClientTransactionBoundary(client);
      const targetProductId = await insertProduct(boundary);
      const priceLocks = new PriceLockService({
        now: () => now,
        pricing: new FixturePricingService() as unknown as PricingService,
        repository: new PostgresPriceLockRepository(boundary),
      });
      const lock = await priceLocks.createPriceLock({
        correlationId: correlationId("e2e-pg-lock"),
        expiresAt: new Date(now.getTime() + 120_000),
        idempotencyKey: "e2e-pg-lock",
        quote: syntheticQuote(targetProductId),
      });
      if (!lock.lock) throw new Error("E2E PostgreSQL PriceLock missing");
      const orders = new OrderOrchestrationService({
        now: () => new Date(now.getTime() + 1_000),
        operationsControlGate: {
          evaluate: async () => ({ status: "ALLOWED" }),
        },
        priceLocks,
        repository: new PostgresOrderRepository(boundary),
      });
      const created = await orders.createOrder({
        checkoutEmailNormalized: "owned-e2e@example.test",
        correlationId: correlationId("e2e-pg-order"),
        idempotencyKey: "e2e-pg-order",
        priceLockId: lock.lock.id,
        productId: targetProductId,
        quantity: 1,
      });
      if (!created.order) throw new Error("E2E PostgreSQL order missing");
      const completed = await completeOrder(orders, created.order);

      const identityRepository = new PostgresCustomerOrderIdentityRepository(
        boundary,
      );
      const identity = new CustomerOrderIdentityService({
        emailVerificationAuthority: new TrustedEmailAuthority(),
        now: () => new Date(now.getTime() + 2_000),
        orderOwnershipAuthority: new TrustedOwnershipAuthority(),
        repository: identityRepository,
      });
      const customer = await identity.createCustomer({
        correlationId: correlationId("e2e-pg-customer"),
        email: "owned-e2e@example.test",
      });
      if (customer.status === "INVALID_EMAIL") {
        throw new Error("E2E PostgreSQL customer missing");
      }
      await expect(
        identity.markEmailVerified({
          correlationId: correlationId("e2e-pg-verify"),
          customerId: customer.customer.id,
          expectedCustomerVersion: customer.customer.recordVersion,
        }),
      ).resolves.toMatchObject({ status: "VERIFIED" });
      await expect(
        identity.bindOrderOwnership({
          correlationId: correlationId("e2e-pg-own"),
          customerId: customer.customer.id,
          expectedOrderVersion: completed.recordVersion,
          orderId: completed.id,
        }),
      ).resolves.toMatchObject({ status: "BOUND" });

      const support = new SupportCaseService({
        now: () => new Date(now.getTime() + 3_000),
        repository: new PostgresSupportCaseRepository(boundary),
      });
      await expect(
        support.createCustomerCase({
          category: "ORDER_STATUS",
          correlationId: correlationId("e2e-pg-support"),
          message: "Synthetic acceptance support request",
          orderId: completed.id,
          principal: principal(customer.customer.id),
        }),
      ).resolves.toMatchObject({ status: "CREATED" });

      await expect(count(boundary, "keycore_orders")).resolves.toBe(1);
      await expect(count(boundary, "order_transition_history")).resolves.toBe(
        10,
      );
      await expect(count(boundary, "outbox_events")).resolves.toBeGreaterThan(
        0,
      );
      await expect(count(boundary, "keycore_customers")).resolves.toBe(1);
      await expect(count(boundary, "support_cases")).resolves.toBe(1);
      await expect(count(boundary, "encrypted_key_records")).resolves.toBe(0);
      await expect(
        boundary.query(
          "SELECT customer_id::text AS customer_id FROM keycore_orders WHERE id = $1",
          [completed.id],
        ),
      ).resolves.toMatchObject({
        rows: [{ customer_id: customer.customer.id }],
      });
    } finally {
      await client.end();
      await database.cleanup();
    }
  }, 30_000);
});

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

const insertProduct = async (db: Queryable): Promise<ProductId> => {
  const result = await db.query<{ readonly id: string }>(
    `
      INSERT INTO products(
        product_type, title, platform, lifecycle, active,
        canonical_metadata_confidence
      )
      VALUES ('GAME', 'Synthetic E2E Product', 'WINDOWS', 'IN_STOCK', true, 'HIGH')
      RETURNING id::text
    `,
  );
  return productId(required(result.rows[0]).id);
};

const completeOrder = async (
  orders: OrderOrchestrationService,
  created: KeyCoreOrder,
): Promise<KeyCoreOrder> => {
  let order = await update(
    orders.markAwaitingPayment(command(created, "awaiting")),
  );
  order = await update(
    orders.transitionPayment({
      ...command(order, "authorized"),
      paymentStatus: "AUTHORIZED",
    }),
  );
  order = await update(
    orders.transitionPayment({
      ...command(order, "captured"),
      paymentStatus: "CAPTURED",
    }),
  );
  order = await update(
    orders.markRisk({ ...command(order, "risk"), riskStatus: "APPROVED" }),
  );
  order = await update(
    orders.markProcurementPending(command(order, "procurement-pending")),
  );
  order = await update(
    orders.beginProcurement(command(order, "procurement-begin")),
  );
  order = await update(
    orders.recordProcurementResult({
      ...command(order, "procurement-success"),
      procurementStatus: "SUCCEEDED",
    }),
  );
  order = await update(
    orders.markFulfillmentPending(command(order, "fulfillment-pending")),
  );
  return update(
    orders.recordFulfillmentResult({
      ...command(order, "fulfillment-success"),
      fulfillmentStatus: "SUCCEEDED",
    }),
  );
};

const command = (order: KeyCoreOrder, name: string) => ({
  correlationId: correlationId(`e2e-pg-${name}`),
  expectedVersion: order.recordVersion,
  orderId: order.id,
});

const update = async (
  resultPromise: Promise<{
    readonly status: string;
    readonly order?: KeyCoreOrder;
  }>,
): Promise<KeyCoreOrder> => {
  const result = await resultPromise;
  if (result.status !== "UPDATED" || !result.order) {
    throw new Error("E2E PostgreSQL transition failed");
  }
  return result.order;
};

const syntheticQuote = (targetProductId: ProductId): SellPriceQuote => ({
  acquisitionCost: money(1_000n, eur),
  calculatedAt: now,
  currency: eur,
  expectedProfit: money(300n, eur),
  hardMinimumProfit: money(50n, eur),
  hardMinimumSellPrice: money(100n, eur),
  knownFees: money(0n, eur),
  marginBasisPoints: 2_307n,
  markupBasisPoints: 3_000n,
  offerId: "e2e-pg-offer" as SellPriceQuote["offerId"],
  preRoundingPrice: money(1_300n, eur),
  pricingPolicyRecordVersion: 1,
  pricingPolicyVersion: "pricing-policy-v1",
  productId: targetProductId,
  sellPrice: money(1_300n, eur),
  sourceFingerprint: "e2e-pg-source",
  status: "QUOTED",
  taxAmount: money(0n, eur),
  taxPolicyVersion: "e2e-pg-tax-v1",
});

class FixturePricingService {
  public async quoteProduct(input: {
    readonly productId: ProductId;
  }): Promise<ProductPriceSelection> {
    const quote = syntheticQuote(input.productId);
    return {
      productId: input.productId,
      quotes: [quote],
      selectedQuote: quote,
      status: "QUOTED",
    };
  }
}

class TrustedEmailAuthority implements EmailVerificationAuthorityPort {
  public async verifiedEmailEvidence(input: {
    readonly customerId: CustomerId;
    readonly emailNormalized: string;
    readonly correlationId: CorrelationId;
  }) {
    return {
      evidence: {
        customerId: input.customerId,
        emailNormalized: input.emailNormalized,
        provider: "TEST" as const,
        providerEvidenceId: `e2e-pg-email-${input.correlationId}`,
        verifiedAt: now,
      },
      status: "AUTHORIZED" as const,
    };
  }
}

class TrustedOwnershipAuthority implements OrderOwnershipBindingAuthorityPort {
  public async verifiedOrderOwnership(input: { readonly orderId: OrderId }) {
    return {
      actorId: "e2e-pg-checkout",
      actorType: "SERVICE" as const,
      providerEvidenceId: `e2e-pg-ownership-${input.orderId}`,
      status: "AUTHORIZED" as const,
    };
  }
}

const principal = (id: CustomerId): AuthenticatedCustomerPrincipal => ({
  authenticationContext: { assurance: "AUTHENTICATED", provider: "TEST" },
  customerId: id,
});

const count = async (db: Queryable, table: string): Promise<number> => {
  if (!/^[a-z_]+$/u.test(table)) throw new Error("Unsafe E2E table name");
  const result = await db.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM ${table}`,
  );
  return Number.parseInt(required(result.rows[0]).count, 10);
};

const required = <TValue>(value: TValue | undefined): TValue => {
  if (!value) throw new Error("E2E PostgreSQL fixture missing");
  return value;
};
