import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  customerId,
  orderId,
  productId,
  type CustomerId,
  type OrderId,
  type ProductId,
} from "../../packages/platform/src/contracts.js";
import { PostgresCustomerAccountReadRepository } from "./customer-account-repositories.js";
import { PostgresTestDatabase } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const now = new Date("2026-08-25T10:00:00.000Z");

describePostgres("PostgresCustomerAccountReadRepository", () => {
  it("filters account order reads by customer ownership at SQL boundary", async () => {
    const database = await initDatabase();
    try {
      const repository = new PostgresCustomerAccountReadRepository(database);
      const owner = await insertCustomer(database, "owner@example.test");
      const other = await insertCustomer(database, "other@example.test");
      const product = await insertProduct(database);
      const first = await insertOrder(database, product, owner, {
        createdAt: new Date("2026-08-25T09:00:00.000Z"),
      });
      const second = await insertOrder(database, product, owner, {
        createdAt: new Date("2026-08-25T08:00:00.000Z"),
      });
      const otherOrder = await insertOrder(database, product, other, {
        createdAt: new Date("2026-08-25T09:30:00.000Z"),
      });
      const legacy = await insertOrder(database, product, null, {
        createdAt: new Date("2026-08-25T07:00:00.000Z"),
      });
      const fulfillment = await insertReadyFulfillment(database, first);
      await insertReadyFulfillment(database, legacy);

      await expect(repository.findAccountSummary(owner)).resolves.toMatchObject(
        {
          customerId: owner,
          emailMasked: "o****@example.test",
          emailVerificationState: "VERIFIED",
        },
      );
      const page = await repository.listOwnedOrders({
        customerId: owner,
        limit: 1,
      });

      expect(page.orders.map((order) => order.orderId)).toEqual([first]);
      expect(page.nextCursor).toEqual({
        createdAt: new Date("2026-08-25T09:00:00.000Z"),
        orderId: first,
      });
      expect(safeJson(page)).not.toContain(otherOrder);
      expect(safeJson(page)).not.toContain("GE1373B866F3");

      const nextPage = await repository.listOwnedOrders({
        after: required(page.nextCursor),
        customerId: owner,
        limit: 100,
      });
      expect(nextPage.orders.map((order) => order.orderId)).toEqual([second]);
      await expect(
        repository.findOwnedOrderDetail({ customerId: owner, orderId: first }),
      ).resolves.toMatchObject({
        fulfillment: {
          fulfillmentId: fulfillment,
          hasEncryptedSecret: true,
          retrievalState: "RETRIEVED",
        },
        orderId: first,
      });
      await expect(
        repository.findOwnedOrderDetail({
          customerId: owner,
          orderId: otherOrder,
        }),
      ).resolves.toBeNull();
      await expect(
        repository.findOwnedOrderDetail({ customerId: owner, orderId: legacy }),
      ).resolves.toBeNull();
    } finally {
      await database.cleanup();
    }
  }, 30_000);
});

const initDatabase = async (): Promise<PostgresTestDatabase> =>
  PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `customer_account_${randomUUID().replaceAll("-", "_")}`,
  });

const insertCustomer = async (
  database: PostgresTestDatabase,
  email: string,
): Promise<CustomerId> => {
  const id = customerId(randomUUID());
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
  return id;
};

const insertProduct = async (
  database: PostgresTestDatabase,
): Promise<ProductId> => {
  const result = await database.query<{ readonly id: string }>(
    `
      INSERT INTO products(
        product_type, title, platform, lifecycle, active,
        canonical_metadata_confidence
      )
      VALUES (
        'GAME', 'Customer Account Product', 'WINDOWS', 'IN_STOCK', true, 'HIGH'
      )
      RETURNING id::text
    `,
  );
  return productId(required(result.rows[0]).id);
};

const insertPriceLock = async (
  database: PostgresTestDatabase,
  targetProductId: ProductId,
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
        $1, $2, 'EUR', 1999, $3, $4, 'pricing-policy-v1', 1,
        'tax-v1', 'fee-v1', 'CONSUMED', 1, $5, $6,
        'corr-customer-account-pg', $7, $8
      )
    `,
    [
      id,
      targetProductId,
      `quote-${id}`,
      `source-${id}`,
      `idem-${id}`,
      `fingerprint-${id}`,
      now,
      new Date(now.getTime() + 60_000),
    ],
  );
  return id;
};

const insertOrder = async (
  database: PostgresTestDatabase,
  targetProductId: ProductId,
  owner: CustomerId | null,
  options: { readonly createdAt: Date },
): Promise<OrderId> => {
  const id = orderId(randomUUID());
  await database.query(
    `
      INSERT INTO keycore_orders(
        id, product_id, price_lock_id, customer_id, customer_amount_minor,
        currency, quantity, status, payment_status, procurement_status,
        fulfillment_status, risk_status, refund_status, record_version,
        idempotency_key, idempotency_fingerprint, correlation_id,
        created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, 1999, 'EUR', 1, 'FULFILLMENT_PENDING',
        'CAPTURED', 'SUCCEEDED', 'PENDING', 'APPROVED', 'NOT_REQUESTED',
        1, $5, $6, 'corr-customer-account-pg', $7, $7
      )
    `,
    [
      id,
      targetProductId,
      await insertPriceLock(database, targetProductId),
      owner,
      `order-idem-${id}`,
      `order-fingerprint-${id}`,
      options.createdAt,
    ],
  );
  return id;
};

const insertReadyFulfillment = async (
  database: PostgresTestDatabase,
  linkedOrder: OrderId | null,
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
        $1, $2, 'kinguin', 'GE1373B866F3', 1, 'DELIVERY_PENDING',
        'RETRIEVED', 'PENDING', NULL, 1, 'corr-customer-account-pg',
        $3, $3, $3
      )
    `,
    [fulfillmentId, linkedOrder, now],
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
        decode('abcdef', 'hex'), 'test-customer-account-key', 1,
        'AES-256-GCM-v1', $2
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

const required = <TValue>(value: TValue | undefined | null): TValue => {
  if (!value) {
    throw new Error("Expected customer account PostgreSQL fixture");
  }
  return value;
};

const safeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, child) =>
    typeof child === "bigint" ? child.toString() : child,
  );
