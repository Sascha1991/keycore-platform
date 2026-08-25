import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  CustomerOrderIdentityService,
  PersistedCustomerOrderAuthorizationPort,
  StaticAuthenticatedCustomerPrincipalProvider,
  correlationId,
  orderId,
  productId,
  type CustomerId,
  type OrderId,
} from "../../packages/platform/src/contracts.js";
import { PostgresTestDatabase } from "./test-database.js";
import { PostgresCustomerOrderIdentityRepository } from "./customer-order-identity-repositories.js";
import { quoteIdentifier } from "./test-database.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const now = new Date("2026-08-25T00:00:00.000Z");

describePostgres("PostgresCustomerOrderIdentityRepository", () => {
  it("persists customer identity, immutable order ownership and fail-closed fulfillment authorization", async () => {
    const database = await initDatabase();
    try {
      const boundary = new TestTransactionBoundary(database);
      const repository = new PostgresCustomerOrderIdentityRepository(boundary);
      const service = new CustomerOrderIdentityService({
        now: () => now,
        repository,
      });
      const product = await insertProduct(database);
      const lock = await insertPriceLock(database, product);
      const targetOrder = await insertOrder(database, product, lock, {
        fulfillmentStatus: "PENDING",
        procurementStatus: "SUCCEEDED",
        status: "FULFILLMENT_PENDING",
      });
      const otherOrder = await insertOrder(
        database,
        product,
        await insertPriceLock(database, product),
        {
          fulfillmentStatus: "PENDING",
          procurementStatus: "SUCCEEDED",
          status: "FULFILLMENT_PENDING",
        },
      );

      const owner = requiredCustomer(
        await service.createCustomer({
          correlationId: correlationId("corr-pg-owner"),
          email: "Owner@Example.COM",
          emailVerificationState: "VERIFIED",
        }),
      );
      const ownerReplay = await service.createCustomer({
        correlationId: correlationId("corr-pg-owner"),
        email: "Owner@example.com",
        emailVerificationState: "VERIFIED",
      });
      expect(ownerReplay).toMatchObject({
        customer: { id: owner },
        status: "EXISTING",
      });
      const otherCustomer = requiredCustomer(
        await service.createCustomer({
          correlationId: correlationId("corr-pg-other"),
          email: "other@example.com",
          emailVerificationState: "VERIFIED",
        }),
      );

      await expect(
        service.bindIdentity({
          correlationId: correlationId("corr-pg-bind-id"),
          customerId: owner,
          provider: "TEST",
          providerSubject: "subject-1",
        }),
      ).resolves.toMatchObject({ status: "BOUND" });
      await expect(
        service.bindIdentity({
          correlationId: correlationId("corr-pg-bind-id"),
          customerId: otherCustomer,
          provider: "TEST",
          providerSubject: "subject-1",
        }),
      ).resolves.toEqual({ status: "IDENTITY_CONFLICT" });
      await expect(
        service.bindOrderOwnership({
          correlationId: correlationId("corr-pg-owner-bind"),
          customerId: owner,
          expectedOrderVersion: 0,
          orderId: targetOrder,
          trustedContext: trustedContext(),
        }),
      ).resolves.toMatchObject({ status: "STALE_WRITER" });
      await expect(
        service.bindOrderOwnership({
          correlationId: correlationId("corr-pg-owner-bind"),
          customerId: owner,
          expectedOrderVersion: 1,
          orderId: targetOrder,
          trustedContext: trustedContext(),
        }),
      ).resolves.toMatchObject({ status: "BOUND" });
      await expect(
        service.bindOrderOwnership({
          correlationId: correlationId("corr-pg-owner-bind"),
          customerId: otherCustomer,
          expectedOrderVersion: 2,
          orderId: targetOrder,
          trustedContext: trustedContext(),
        }),
      ).resolves.toMatchObject({ status: "OWNERSHIP_CONFLICT" });
      await expect(
        database.query(
          "UPDATE keycore_orders SET customer_id = $2 WHERE id = $1",
          [targetOrder, otherCustomer],
        ),
      ).rejects.toThrow("customer ownership is immutable");

      const fulfillmentId = await insertReadyFulfillment(database, targetOrder);
      const legacyFulfillmentId = await insertReadyFulfillment(database, null);
      const wrongOrderFulfillmentId = await insertReadyFulfillment(
        database,
        otherOrder,
      );
      const auth = authorization(repository, owner);

      await expect(
        auth.authorizeDelivery(authz(owner, targetOrder, fulfillmentId)),
      ).resolves.toEqual({ status: "AUTHORIZED" });
      await expect(
        auth.authorizeDelivery(authz(owner, targetOrder, legacyFulfillmentId)),
      ).resolves.toEqual({ status: "DENIED" });
      await expect(
        auth.authorizeDelivery(
          authz(owner, targetOrder, wrongOrderFulfillmentId),
        ),
      ).resolves.toEqual({ status: "DENIED" });
      await expect(
        authorization(repository, otherCustomer).authorizeDelivery(
          authz(owner, targetOrder, fulfillmentId),
        ),
      ).resolves.toEqual({ status: "DENIED" });
      await expect(
        service.bindOrderOwnership({
          correlationId: correlationId("corr-pg-owner-bind"),
          customerId: owner,
          expectedOrderVersion: 2,
          orderId: targetOrder,
          trustedContext: trustedContext(),
        }),
      ).resolves.toMatchObject({ status: "ALREADY_BOUND" });
    } finally {
      await database.cleanup();
    }
  }, 30_000);
});

const initDatabase = async (): Promise<PostgresTestDatabase> =>
  PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `customer_identity_${randomUUID().replaceAll("-", "_")}`,
  });

class TestTransactionBoundary implements TransactionalQueryable {
  public constructor(private readonly database: PostgresTestDatabase) {}

  public query<TResult extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<TResult>> {
    return this.database.query<TResult>(sql, values);
  }

  public async transaction<TResult>(
    callback: (client: Queryable) => Promise<TResult>,
  ): Promise<TResult> {
    if (!connectionString) {
      throw new Error("KEYCORE_TEST_DATABASE_URL is required");
    }
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await client.query(
        `SET search_path TO ${quoteIdentifier(this.database.schemaName)}, public`,
      );
      await client.query("BEGIN");
      const queryable: Queryable = {
        query: async <TRow extends QueryResultRow = QueryResultRow>(
          sql: string,
          values?: readonly unknown[],
        ): Promise<QueryResult<TRow>> =>
          client.query<TRow>(sql, values ? [...values] : undefined),
      };
      const result = await callback(queryable);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  }
}

const insertProduct = async (
  database: PostgresTestDatabase,
): Promise<ReturnType<typeof productId>> => {
  const result = await database.query<{ readonly id: string }>(
    `
      INSERT INTO products(product_type, title, platform, lifecycle, active, canonical_metadata_confidence)
      VALUES ('GAME', 'Customer Identity Fixture', 'WINDOWS', 'IN_STOCK', true, 'HIGH')
      RETURNING id::text
    `,
  );
  return productId(required(result.rows[0]).id);
};

const insertPriceLock = async (
  database: PostgresTestDatabase,
  targetProductId: ReturnType<typeof productId>,
): Promise<string> => {
  const id = randomUUID();
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
        $1, $2, 'EUR', 1300, $3, $4, 'pricing-policy-v1', 1,
        'tax-v1', 'fee-v1', 'CONSUMED', 1, $5, $6, $7, $8, $9
      )
    `,
    [
      id,
      targetProductId,
      `quote-${id}`,
      `source-${id}`,
      `idem-${id}`,
      `fingerprint-${id}`,
      "corr-pg-customer-identity",
      now,
      new Date(now.getTime() + 60_000),
    ],
  );
  return id;
};

const insertOrder = async (
  database: PostgresTestDatabase,
  targetProductId: ReturnType<typeof productId>,
  lockId: string,
  state: {
    readonly status: string;
    readonly procurementStatus: string;
    readonly fulfillmentStatus: string;
  },
): Promise<OrderId> => {
  const id = orderId(randomUUID());
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
        $1, $2, $3, 1300, 'EUR', 1, $4, 'CAPTURED', $5, $6,
        'APPROVED', 'NOT_REQUESTED', 1, $7, $8, $9, $10, $10
      )
    `,
    [
      id,
      targetProductId,
      lockId,
      state.status,
      state.procurementStatus,
      state.fulfillmentStatus,
      `order-idem-${id}`,
      `order-fingerprint-${id}`,
      "corr-pg-customer-identity",
      now,
    ],
  );
  return id;
};

const insertReadyFulfillment = async (
  database: PostgresTestDatabase,
  linkedOrderId: OrderId | null,
): Promise<string> => {
  const fulfillmentId = randomUUID();
  await database.query(
    `
      INSERT INTO fulfillment_operations(
        id, order_id, supplier_id, external_supplier_order_id,
        expected_quantity, status, retrieval_state, delivery_state,
        encrypted_secret_id, record_version, correlation_id, created_at,
        updated_at, retrieved_at
      )
      VALUES (
        $1, $2, 'supplier-test', $3, 1, 'DELIVERY_PENDING', 'RETRIEVED',
        'PENDING', NULL, 1, 'corr-pg-customer-identity', $4, $4, $4
      )
    `,
    [fulfillmentId, linkedOrderId, `external-${fulfillmentId}`, now],
  );
  const secret = await database.query<{ readonly id: string }>(
    `
      INSERT INTO fulfillment_secrets(
        fulfillment_id, ciphertext, encryption_nonce, encryption_tag,
        wrapped_data_encryption_key, encryption_key_id, encryption_version,
        encryption_algorithm, created_at
      )
      VALUES (
        $1, decode('abcdef', 'hex'), decode('000000000000000000000000', 'hex'),
        decode('00000000000000000000000000000000', 'hex'),
        decode('abcdef', 'hex'), 'test-key-id', 1, 'AES-256-GCM-v1', $2
      )
      RETURNING id::text
    `,
    [fulfillmentId, now],
  );
  await database.query(
    "UPDATE fulfillment_operations SET encrypted_secret_id = $2 WHERE id = $1",
    [fulfillmentId, required(secret.rows[0]).id],
  );
  return fulfillmentId;
};

const authorization = (
  repository: PostgresCustomerOrderIdentityRepository,
  principalCustomerId: CustomerId,
): PersistedCustomerOrderAuthorizationPort =>
  new PersistedCustomerOrderAuthorizationPort({
    principalProvider: new StaticAuthenticatedCustomerPrincipalProvider({
      authenticationContext: { assurance: "TEST", provider: "TEST" },
      customerId: principalCustomerId,
    }),
    repository,
  });

const authz = (
  requestedCustomerId: CustomerId,
  requestedOrderId: OrderId,
  fulfillmentId: string,
) => ({
  customerId: requestedCustomerId,
  expiresAt: new Date(now.getTime() + 60_000),
  fulfillmentId,
  issuedAt: now,
  orderId: requestedOrderId,
  purpose: "customer-key-delivery" as const,
  version: 1 as const,
});

const trustedContext = () => ({
  actorId: "checkout-service",
  actorType: "SERVICE" as const,
  reasonCode: "ORDER_OWNERSHIP_INITIAL_BINDING" as const,
});

const requiredCustomer = (
  result: Awaited<ReturnType<CustomerOrderIdentityService["createCustomer"]>>,
): CustomerId => {
  if (!("customer" in result)) {
    throw new Error("Expected customer test fixture");
  }
  return result.customer.id;
};

const required = <TValue>(value: TValue | undefined): TValue => {
  if (!value) {
    throw new Error("Expected PostgreSQL customer identity fixture");
  }
  return value;
};
