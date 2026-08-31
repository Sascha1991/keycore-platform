import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  correlationId,
  customerId,
  type CustomerId,
} from "../../packages/platform/src/contracts.js";
import {
  createPostgresStagingCheckout,
  type StagingCheckoutResult,
} from "../storefront/staging-checkout.js";
import { PostgresCustomerAccountReadRepository } from "./customer-account-repositories.js";
import { seedSyntheticStagingCheckoutData } from "./staging-checkout-seed.js";
import { stagingGuestOrderId } from "./staging-checkout-seed.js";
import { createPostgresStagingGuestOrderClaim } from "../storefront/staging-guest-claim.js";
import { PostgresTestDatabase } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const now = new Date("2026-08-31T18:00:00.000Z");
const customerA = customerId("10000000-0000-4000-8000-000000000001");
const customerB = customerId("10000000-0000-4000-8000-000000000002");
const guestClaimCode = "SYNTHETIC_CLAIM_POSTGRES_UAT_015_123456";

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
        await expect(countCheckoutOrders(database)).resolves.toBe(1);
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
        await expect(countCheckoutOrders(database)).resolves.toBe(1);
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
        await expect(countCheckoutOrders(database)).resolves.toBe(0);

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
          WHERE id <> $1
          ORDER BY payment_status
        `,
          [stagingGuestOrderId],
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

    it("claims the deterministic guest fixture once and persists ownership across adapters", async () => {
      await withDatabase(async (database) => {
        const firstAdapter = createPostgresStagingGuestOrderClaim(database);
        await expect(
          firstAdapter.claimGuestOrder({
            claimCode: guestClaimCode,
            correlationId: correlationId("staging-claim-wrong-customer"),
            principal: principal(customerB),
          }),
        ).resolves.toEqual({ status: "CLAIM_DENIED" });

        await expect(
          firstAdapter.claimGuestOrder({
            claimCode: guestClaimCode,
            correlationId: correlationId("staging-claim-customer-a"),
            principal: principal(customerA),
          }),
        ).resolves.toEqual({ orderId: stagingGuestOrderId, status: "CLAIMED" });

        const account = new PostgresCustomerAccountReadRepository(database);
        const customerAPage = await account.listOwnedOrders({
          customerId: customerA,
          limit: 20,
        });
        expect(customerAPage.orders.map((order) => order.orderId)).toContain(
          stagingGuestOrderId,
        );
        await expect(
          account.findOwnedOrderDetail({
            customerId: customerB,
            orderId: stagingGuestOrderId,
          }),
        ).resolves.toBeNull();

        const laterSessionAdapter =
          createPostgresStagingGuestOrderClaim(database);
        await expect(
          laterSessionAdapter.claimGuestOrder({
            claimCode: guestClaimCode,
            correlationId: correlationId("staging-claim-replay"),
            principal: principal(customerA),
          }),
        ).resolves.toEqual({ status: "CLAIM_DENIED" });

        const reseed = await seedSyntheticStagingCheckoutData(database, {
          deploymentId: "staging-checkout-test",
          environment: "STAGING",
          guestClaimCode,
        });
        expect(reseed.guestClaimFixture).toBe("CONSUMED");
        await expect(
          seedSyntheticStagingCheckoutData(database, {
            deploymentId: "staging-checkout-test",
            environment: "STAGING",
            guestClaimCode: "SYNTHETIC_DIFFERENT_CLAIM_CODE_654321",
          }),
        ).rejects.toThrow("STAGING_GUEST_CLAIM_FIXTURE_IDENTITY_CONFLICT");
        await expect(
          count(database, "guest_order_claim_challenges"),
        ).resolves.toBe(1);
        const persisted = await database.query<{
          readonly customer_id: string;
          readonly token_hash: string;
          readonly audit: string;
        }>(
          `
            SELECT o.customer_id::text, c.token_hash,
              COALESCE((SELECT jsonb_agg(metadata)::text FROM audit_events), '[]') AS audit
            FROM keycore_orders o
            JOIN guest_order_claim_challenges c ON c.order_id = o.id
            WHERE o.id = $1
            GROUP BY o.customer_id, c.token_hash
          `,
          [stagingGuestOrderId],
        );
        expect(persisted.rows[0]?.customer_id).toBe(customerA);
        expect(persisted.rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/u);
        expect(JSON.stringify(persisted.rows)).not.toContain(guestClaimCode);
      });
    }, 30_000);
  },
);

const principal = (customer: CustomerId) => ({
  authenticationContext: {
    assurance: "AUTHENTICATED" as const,
    provider: "WOOCOMMERCE" as const,
  },
  customerId: customer,
});

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

const countCheckoutOrders = async (
  database: PostgresTestDatabase,
): Promise<number> => {
  const result = await database.query<{ readonly count: string }>(
    "SELECT count(*)::text AS count FROM keycore_orders WHERE id <> $1",
    [stagingGuestOrderId],
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
      guestClaimCode,
    });
    await callback(database);
  } finally {
    await database.cleanup();
  }
};
