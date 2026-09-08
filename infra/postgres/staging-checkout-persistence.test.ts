import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  correlationId,
  customerId,
  FakeGuestOrderClaimDeliveryPort,
  orderId,
  type CustomerId,
  type GuestOrderClaimDeliveryPort,
} from "../../packages/platform/src/contracts.js";
import {
  createPostgresStagingCheckout,
  type StagingCheckoutResult,
} from "../storefront/staging-checkout.js";
import { PostgresCustomerAccountReadRepository } from "./customer-account-repositories.js";
import { seedSyntheticStagingCheckoutData } from "./staging-checkout-seed.js";
import { stagingGuestOrderId } from "./staging-checkout-seed.js";
import { createPostgresStagingGuestOrderClaim } from "../storefront/staging-guest-claim.js";
import { PostgresStagingDelayedFulfillment } from "../storefront/staging-delayed-fulfillment.js";
import type { StagingReadinessNotificationPort } from "../storefront/staging-mailpit.js";
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

    it("creates an unowned guest order and delivers one fresh hash-only claim after capture", async () => {
      await withDatabase(async (database) => {
        const delivery = new FakeGuestOrderClaimDeliveryPort();
        const checkout = createPostgresStagingCheckout(database, {
          guestCheckoutEmailNormalized: "guest-checkout@example.test",
          guestClaimDelivery: delivery,
          now: () => now,
        });
        const command = {
          ...checkoutCommand(customerA, "6", "SUCCESS"),
          checkoutEmailNormalized: "guest-checkout@example.test",
          checkoutMode: "GUEST" as const,
        };
        const { customerId, ...guestCommand } = command;
        expect(customerId).toBe(customerA);
        const first = await checkout.checkout(guestCommand);
        const replay = await checkout.checkout(guestCommand);

        expect(first).toMatchObject({
          claimDeliveryStatus: "ACCEPTED",
          status: "CAPTURED",
        });
        expect(replay).toMatchObject({
          claimDeliveryStatus: "ACCEPTED",
          status: "IDEMPOTENT",
        });
        expect(delivery.deliveries).toHaveLength(1);
        expect(delivery.deliveries[0]?.rawClaimCode).not.toBe(guestClaimCode);
        expect(JSON.stringify({ first, replay })).not.toContain(
          delivery.deliveries[0]?.rawClaimCode,
        );
        const persisted = await database.query<{
          readonly active: string;
          readonly customer_id: string | null;
          readonly token_hash: string;
        }>(
          `SELECT o.customer_id::text,
             count(*) FILTER (WHERE c.consumed_at IS NULL AND c.revoked_at IS NULL AND c.expires_at > $2)::text AS active,
             max(c.token_hash) AS token_hash
           FROM keycore_orders o
           JOIN guest_order_claim_challenges c ON c.order_id = o.id
           WHERE o.id = $1
           GROUP BY o.customer_id`,
          [requiredOrderId(first), now],
        );
        expect(persisted.rows[0]).toMatchObject({
          active: "1",
          customer_id: null,
        });
        expect(persisted.rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/u);
      });
    }, 30_000);

    it("revokes a fresh guest claim when the private delivery sink fails", async () => {
      await withDatabase(async (database) => {
        const checkout = createPostgresStagingCheckout(database, {
          guestCheckoutEmailNormalized: "guest-checkout@example.test",
          guestClaimDelivery: new UnavailableGuestClaimDelivery(),
          now: () => now,
        });
        const accountCommand = checkoutCommand(customerA, "8", "SUCCESS");
        const { customerId, ...common } = accountCommand;
        expect(customerId).toBe(customerA);
        const result = await checkout.checkout({
          ...common,
          checkoutEmailNormalized: "guest-checkout@example.test",
          checkoutMode: "GUEST",
        });

        expect(result).toMatchObject({
          claimDeliveryStatus: "UNAVAILABLE",
          status: "CAPTURED",
        });
        const persisted = await database.query<{
          readonly active: string;
          readonly customer_id: string | null;
          readonly revoked: string;
        }>(
          `SELECT o.customer_id::text,
             count(*) FILTER (WHERE c.consumed_at IS NULL AND c.revoked_at IS NULL AND c.expires_at > $2)::text AS active,
             count(*) FILTER (WHERE c.revoked_at IS NOT NULL)::text AS revoked
           FROM keycore_orders o
           JOIN guest_order_claim_challenges c ON c.order_id = o.id
           WHERE o.id = $1
           GROUP BY o.customer_id`,
          [requiredOrderId(result), now],
        );
        expect(persisted.rows[0]).toEqual({
          active: "0",
          customer_id: null,
          revoked: "1",
        });
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

    it("completes one authorized delayed fulfillment with one encrypted secret and notification", async () => {
      await withDatabase(async (database) => {
        const checkout = createPostgresStagingCheckout(database, {
          now: () => now,
        });
        const created = await checkout.checkout(
          checkoutCommand(customerA, "7", "SUCCESS"),
        );
        const notifications = new CapturingReadinessNotifications();
        const fulfillment = new PostgresStagingDelayedFulfillment({
          database,
          masterKeyMaterialBase64: Buffer.alloc(32, 9).toString("base64"),
          masterKeyVersion: "staging-test-fulfillment-v1",
          notification: notifications,
          now: () => now,
          syntheticKey: "SYNTHETIC_DELAYED_UAT_VALUE",
        });
        const input = {
          correlationId: correlationId("staging-delayed-fulfillment"),
          orderId: orderId(requiredOrderId(created)),
          principal: {
            adminId: "a1000000-0000-4000-8000-000000000001",
            assurance: "STAGING_SYNTHETIC" as const,
            displayName: "Synthetic Operator",
            expiresAt: new Date(now.getTime() + 60_000),
            roles: ["OPERATIONS" as const],
          },
        };
        const results = await Promise.all([
          fulfillment.complete(input),
          fulfillment.complete(input),
        ]);

        expect(results.map((result) => result.status).sort()).toEqual([
          "ALREADY_COMPLETED",
          "COMPLETED",
        ]);
        expect(notifications.messages).toHaveLength(1);
        expect(JSON.stringify(notifications.messages)).not.toContain(
          "SYNTHETIC_DELAYED_UAT_VALUE",
        );
        const persisted = await database.query<{
          readonly fulfillment_count: string;
          readonly fulfillment_status: string;
          readonly secret_count: string;
          readonly status: string;
        }>(
          `SELECT o.status, o.fulfillment_status,
             (SELECT count(*)::text FROM fulfillment_operations f WHERE f.order_id = o.id) AS fulfillment_count,
             (SELECT count(*)::text FROM fulfillment_secrets s JOIN fulfillment_operations f ON f.id = s.fulfillment_id WHERE f.order_id = o.id) AS secret_count
           FROM keycore_orders o WHERE o.id = $1`,
          [requiredOrderId(created)],
        );
        expect(persisted.rows[0]).toEqual({
          fulfillment_count: "1",
          fulfillment_status: "SUCCEEDED",
          secret_count: "1",
          status: "COMPLETED",
        });
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
  checkoutMode: "ACCOUNT" as const,
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

class CapturingReadinessNotifications implements StagingReadinessNotificationPort {
  public readonly messages: Parameters<
    StagingReadinessNotificationPort["sendReady"]
  >[0][] = [];

  public async sendReady(
    input: Parameters<StagingReadinessNotificationPort["sendReady"]>[0],
  ) {
    this.messages.push(input);
    return { status: "ACCEPTED" as const };
  }
}

class UnavailableGuestClaimDelivery implements GuestOrderClaimDeliveryPort {
  public async sendGuestOrderClaim(): Promise<{ readonly status: "FAILED" }> {
    return { status: "FAILED" };
  }
}

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
