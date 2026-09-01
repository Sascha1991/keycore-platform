import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  customerId,
  type CustomerId,
} from "../../packages/platform/src/contracts.js";
import {
  createPostgresStagingCheckout,
  type StagingCheckoutResult,
} from "../storefront/staging-checkout.js";
import { PostgresCustomerAccountReadRepository } from "./customer-account-repositories.js";
import { seedSyntheticStagingCheckoutData } from "./staging-checkout-seed.js";
import { PostgresTestDatabase } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const now = new Date("2026-08-31T18:00:00.000Z");
const customerA = customerId("10000000-0000-4000-8000-000000000001");
const customerB = customerId("10000000-0000-4000-8000-000000000002");

describe.skipIf(!connectionString)(
  "staging customer checkout persistence",
  () => {
    it("creates one captured owned order and replays without duplication or key material", async () => {
      await withDatabase(async (database) => {
        const checkout = createPostgresStagingCheckout(database, {
          now: () => now,
        });
        const command = checkoutCommand(customerA, "1", "SUCCESS");
        const first = await checkout.checkout(command);
        const replay = await checkout.checkout(command);

        expect(first).toMatchObject({ status: "CAPTURED" });
        expect(replay).toEqual({
          orderId: requiredOrderId(first),
          reasonCode: "CHECKOUT_IDEMPOTENT_REPLAY",
          status: "IDEMPOTENT",
        });
        await expect(
          checkout.checkout({ ...command, customerId: customerB }),
        ).resolves.toEqual({
          reasonCode: "ORDER_IDEMPOTENCY_CONFLICT",
          status: "RECONCILIATION_REQUIRED",
        });
        await expect(count(database, "keycore_orders")).resolves.toBe(1);
        await expect(count(database, "order_payments")).resolves.toBe(1);
        await expect(count(database, "external_event_receipts")).resolves.toBe(
          1,
        );
        await expect(count(database, "encrypted_key_records")).resolves.toBe(0);
        await expect(count(database, "fulfillment_operations")).resolves.toBe(
          0,
        );

        const account = new PostgresCustomerAccountReadRepository(database);
        const page = await account.listOwnedOrders({
          customerId: customerA,
          limit: 10,
        });
        expect(page.orders).toHaveLength(1);
        const ownedOrder = page.orders[0];
        if (!ownedOrder) throw new Error("Owned checkout order missing");
        expect(ownedOrder).toMatchObject({
          customerId: customerA,
          fulfillment: null,
          fulfillmentStatus: "NOT_STARTED",
          paymentStatus: "CAPTURED",
          procurementStatus: "NOT_STARTED",
          productTitle: "Neonpfad: Berlin",
        });
        await expect(
          account.findOwnedOrderDetail({
            customerId: customerB,
            orderId: ownedOrder.orderId,
          }),
        ).resolves.toBeNull();

        const serialized = JSON.stringify(
          { first, page, replay },
          (_key, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value,
        );
        expect(serialized).not.toMatch(/product.?key|ciphertext|synthetic_/iu);
      });
    }, 30_000);

    it("keeps concurrent duplicate submission bounded to one order and payment", async () => {
      await withDatabase(async (database) => {
        const checkout = createPostgresStagingCheckout(database, {
          now: () => now,
        });
        const command = checkoutCommand(customerA, "2", "SUCCESS");
        const results = await Promise.all([
          checkout.checkout(command),
          checkout.checkout(command),
        ]);
        expect(results.some((result) => result.status === "CAPTURED")).toBe(
          true,
        );
        await expect(count(database, "keycore_orders")).resolves.toBe(1);
        await expect(count(database, "order_payments")).resolves.toBe(1);
        const retry = await checkout.checkout(command);
        expect(retry.status).toBe("IDEMPOTENT");
      });
    }, 30_000);

    it("fails closed for tampering and preserves failure and cancellation states", async () => {
      await withDatabase(async (database) => {
        const checkout = createPostgresStagingCheckout(database, {
          now: () => now,
        });
        const valid = checkoutCommand(customerA, "3", "SUCCESS");
        for (const invalid of [
          { ...valid, expectedTotalMinor: "1" },
          { ...valid, currency: "USD" },
          { ...valid, quantity: 2 },
          { ...valid, productReference: "unknown-product" },
          {
            ...valid,
            checkoutCreatedAt: new Date(
              now.getTime() - 31 * 60 * 1_000,
            ).toISOString(),
          },
          { ...valid, checkoutToken: "invalid" },
        ]) {
          await expect(checkout.checkout(invalid)).resolves.toEqual({
            reasonCode: "CHECKOUT_REQUEST_INVALID",
            status: "DENIED",
          });
        }
        await expect(count(database, "keycore_orders")).resolves.toBe(0);

        const failed = await checkout.checkout(
          checkoutCommand(customerA, "4", "FAILURE"),
        );
        const cancelled = await checkout.checkout(
          checkoutCommand(customerA, "5", "CANCEL"),
        );
        expect(failed.status).toBe("FAILED");
        expect(cancelled.status).toBe("CANCELLED");
        const rows = await database.query<{
          readonly payment_status: string;
          readonly procurement_status: string;
          readonly fulfillment_status: string;
        }>(
          `
          SELECT payment_status, procurement_status, fulfillment_status
          FROM keycore_orders
          ORDER BY payment_status
        `,
        );
        expect(rows.rows).toEqual([
          {
            fulfillment_status: "NOT_STARTED",
            payment_status: "CANCELLED",
            procurement_status: "NOT_STARTED",
          },
          {
            fulfillment_status: "NOT_STARTED",
            payment_status: "FAILED",
            procurement_status: "NOT_STARTED",
          },
        ]);
        await expect(count(database, "fulfillment_operations")).resolves.toBe(
          0,
        );
        await expect(count(database, "encrypted_key_records")).resolves.toBe(0);
      });
    }, 30_000);
  },
);

const checkoutCommand = (
  customer: CustomerId,
  tokenSuffix: string,
  outcome: "SUCCESS" | "FAILURE" | "CANCEL",
) => ({
  checkoutCreatedAt: now.toISOString(),
  checkoutToken: tokenSuffix.padStart(64, "a"),
  currency: "EUR",
  customerId: customer,
  expectedTotalMinor: "1299",
  outcome,
  productReference: "synthetic-de-adventure",
  quantity: 1,
});

const requiredOrderId = (result: StagingCheckoutResult): string => {
  if (!("orderId" in result)) throw new Error("Checkout order ID missing");
  return result.orderId;
};

const count = async (
  database: PostgresTestDatabase,
  table: string,
): Promise<number> => {
  if (!/^[a-z_]+$/u.test(table)) throw new Error("Unsafe table name");
  const result = await database.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM ${table}`,
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
};

const withDatabase = async (
  callback: (database: PostgresTestDatabase) => Promise<void>,
): Promise<void> => {
  const database = await PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `staging_checkout_${randomUUID().replaceAll("-", "")}`,
  });
  try {
    await seedSyntheticStagingCheckoutData(database, {
      deploymentId: "staging-checkout-test",
      environment: "STAGING",
    });
    await callback(database);
  } finally {
    await database.cleanup();
  }
};
