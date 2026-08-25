import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { InMemoryCustomerAccountReadRepository } from "../../../../infra/customers/in-memory-customer-account-repository.js";
import type { AuditEvent } from "../domain/audit.js";
import {
  correlationId,
  currency,
  customerId,
  money,
  orderId,
  type AuthenticatedCustomerPrincipal,
  type CustomerAccountOrderProjection,
  type CustomerId,
  type OrderId,
} from "../contracts.js";
import {
  CustomerAccountService,
  customerAccountCacheHeaders,
} from "./customer-account.js";

const cursorSigningFixture = "customer-account-cursor-signing-fixture-32-bytes";
const now = new Date("2026-08-25T10:00:00.000Z");
const realFulfillmentId = "fd61be5e-44ea-4914-98ae-c4404dc31779";

describe("customer account foundation", () => {
  it("returns own account summary with masked email and no auth internals", async () => {
    const harness = accountHarness();
    const result = await harness.service.getAccountSummary({
      correlationId: correlationId("summary"),
      principal: principal(harness.customerA),
    });

    expect(result.status).toBe("OK");
    expect(result.status === "OK" ? result.account : null).toMatchObject({
      customerId: harness.customerA,
      emailMasked: "a******@example.test",
      emailVerificationState: "VERIFIED",
    });
    expect(JSON.stringify(result)).not.toContain("providerSubject");
    expect(JSON.stringify(result)).not.toContain("session");
    expect(harness.audit.events).toHaveLength(1);
    expect(harness.audit.events[0]?.eventType).toBe("CUSTOMER_ACCOUNT_VIEWED");
  });

  it("denies missing or test principals and never accepts request customerId authority", async () => {
    const harness = accountHarness();

    await expect(
      harness.service.getAccountSummary({
        correlationId: correlationId("missing"),
        principal: null,
      }),
    ).resolves.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
      status: "DENIED",
    });
    await expect(
      harness.service.listOwnedOrders({
        correlationId: correlationId("test-principal"),
        principal: principal(harness.customerA, "TEST"),
      }),
    ).resolves.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
      status: "DENIED",
    });

    const forgedBodyCustomerId = harness.customerB;
    const result = await harness.service.listOwnedOrders({
      correlationId: correlationId("raw-customer-id-ignored"),
      principal: principal(harness.customerA),
    });

    expect(forgedBodyCustomerId).not.toBe(harness.customerA);
    expect(result.status).toBe("OK");
    expect(result.status === "OK" ? result.page.orders : []).toHaveLength(4);
    expect(safeJson(result)).not.toContain(harness.customerB);
  });

  it("lists only owned orders with deterministic bounded cursor pagination", async () => {
    const harness = accountHarness();
    const page1 = await harness.service.listOwnedOrders({
      correlationId: correlationId("orders-page-1"),
      limit: 2,
      principal: principal(harness.customerA),
    });

    expect(page1.status).toBe("OK");
    if (page1.status !== "OK") {
      throw new Error("expected order page");
    }
    expect(page1.page.orders.map((order) => order.orderId)).toEqual([
      harness.orders.available.orderId,
      harness.orders.pending.orderId,
    ]);
    expect(page1.page.nextCursor).toBeDefined();
    expect(safeJson(page1)).not.toContain("supplier");
    expect(safeJson(page1)).not.toContain("GE1373B866F3");

    const nextCursor = page1.page.nextCursor;
    if (!nextCursor) {
      throw new Error("expected next cursor");
    }

    const page2 = await harness.service.listOwnedOrders({
      correlationId: correlationId("orders-page-2"),
      cursor: nextCursor,
      limit: 1000,
      principal: principal(harness.customerA),
    });

    expect(page2.status).toBe("OK");
    expect(page2.status === "OK" ? page2.page.orders.length : 0).toBe(2);
    expect(
      page2.status === "OK" ? page2.page.nextCursor : "unexpected",
    ).toBeUndefined();
  });

  it("rejects malformed and cross-customer cursors safely", async () => {
    const harness = accountHarness();
    const page = await harness.service.listOwnedOrders({
      correlationId: correlationId("cursor-source"),
      limit: 1,
      principal: principal(harness.customerA),
    });
    if (page.status !== "OK" || !page.page.nextCursor) {
      throw new Error("expected cursor");
    }

    await expect(
      harness.service.listOwnedOrders({
        correlationId: correlationId("bad-cursor"),
        cursor: "not-a-cursor",
        principal: principal(harness.customerA),
      }),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "DENIED" });
    await expect(
      harness.service.listOwnedOrders({
        correlationId: correlationId("cross-cursor"),
        cursor: page.page.nextCursor,
        principal: principal(harness.customerB),
      }),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "DENIED" });
  });

  it("returns owned order detail with safe key-vault, invoice, and activation metadata", async () => {
    const harness = accountHarness();
    const result = await harness.service.getOwnedOrderDetail({
      correlationId: correlationId("detail"),
      orderId: harness.orders.available.orderId,
      principal: principal(harness.customerA),
    });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") {
      throw new Error("expected order detail");
    }
    expect(result.order.status).toBe("READY");
    expect(result.order.fulfillment).toMatchObject({
      deliveryStatus: "AVAILABLE",
      hasEncryptedSecret: true,
      keyAccessAvailable: true,
      status: "KEY_AVAILABLE",
    });
    expect(result.order.invoice).toEqual({
      downloadAvailable: false,
      status: "NOT_AVAILABLE",
    });
    expect(result.order.activationInstructions).toEqual({
      instructionCode: "STEAM_ACTIVATION_CODE",
      platform: "STEAM",
      status: "AVAILABLE",
    });
    const serialized = safeJson(result);
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("wrapped");
    expect(serialized).not.toContain("nonce");
    expect(serialized).not.toContain("TEST-AAAAA-BBBBB-CCCCC");
    expect(harness.audit.events.map((event) => event.eventType)).toContain(
      "CUSTOMER_KEY_VAULT_VIEWED",
    );
  });

  it("uses the same unavailable result for wrong customer, unknown order, and unclaimed legacy order", async () => {
    const harness = accountHarness();
    const unknown = randomUUID();
    const wrongOwner = await harness.service.getOwnedOrderDetail({
      correlationId: correlationId("wrong-owner"),
      orderId: harness.orders.otherCustomer.orderId,
      principal: principal(harness.customerA),
    });
    const missing = await harness.service.getOwnedOrderDetail({
      correlationId: correlationId("unknown-order"),
      orderId: unknown,
      principal: principal(harness.customerA),
    });
    const legacy = await harness.service.getOwnedOrderDetail({
      correlationId: correlationId("legacy-order"),
      orderId: harness.orders.legacy.orderId,
      principal: principal(harness.customerA),
    });

    expect(wrongOwner).toEqual({
      code: "RESOURCE_NOT_AVAILABLE",
      status: "DENIED",
    });
    expect(missing).toEqual(wrongOwner);
    expect(legacy).toEqual(wrongOwner);
    expect(
      harness.audit.events.filter(
        (event) => event.eventType === "CUSTOMER_ORDER_VIEW_DENIED",
      ),
    ).toHaveLength(3);
  });

  it("maps key-vault states without decrypting, delivering, or consuming capabilities", async () => {
    const harness = accountHarness();
    const pending = await detail(harness, harness.orders.pending.orderId);
    const review = await detail(harness, harness.orders.manualReview.orderId);
    const delivered = await detail(harness, harness.orders.delivered.orderId);

    expect(pending.fulfillment).toMatchObject({
      keyAccessAvailable: false,
      status: "KEY_PENDING",
    });
    expect(review.fulfillment).toMatchObject({
      deliveryStatus: "ACTION_REQUIRED",
      keyAccessAvailable: false,
      status: "MANUAL_REVIEW_REQUIRED",
    });
    expect(delivered.fulfillment).toMatchObject({
      deliveryStatus: "DELIVERED",
      keyAccessAvailable: false,
      status: "DELIVERED",
    });
    expect(harness.decryptCalls).toBe(0);
    expect(harness.deliveryCalls).toBe(0);
    expect(harness.capabilityConsumptions).toBe(0);
  });

  it("keeps invoice metadata safe and title-only activation non-authoritative", async () => {
    const harness = accountHarness();
    const detailResult = await detail(
      harness,
      harness.orders.delivered.orderId,
    );

    expect(detailResult.invoice).toEqual({
      downloadAvailable: true,
      invoiceReference: "INV-SAFE-1",
      issuedAt: "2026-08-25T09:50:00.000Z",
      status: "AVAILABLE",
    });
    expect(detailResult.activationInstructions).toEqual({
      instructionCode: "GENERIC_SAFE_ACTIVATION",
      platform: "UNKNOWN",
      status: "NOT_AVAILABLE",
    });
    expect(safeJson(detailResult)).not.toContain("storage");
    expect(safeJson(detailResult)).not.toContain("tax");
  });

  it("keeps known real fulfillment inaccessible and untouched", async () => {
    const harness = accountHarness();
    const result = await harness.service.getOwnedOrderDetail({
      correlationId: correlationId("real-fulfillment"),
      orderId: harness.orders.realLegacy.orderId,
      principal: principal(harness.customerA),
    });

    expect(result).toEqual({
      code: "RESOURCE_NOT_AVAILABLE",
      status: "DENIED",
    });
    expect(harness.repositorySnapshot(realFulfillmentId)).toMatchObject({
      deliveredAt: null,
      deliveryState: "PENDING",
      fulfillmentId: realFulfillmentId,
      orderId: null,
      retrievalState: "RETRIEVED",
      status: "DELIVERY_PENDING",
    });
    expect(harness.decryptCalls).toBe(0);
    expect(harness.deliveryCalls).toBe(0);
  });

  it("uses private no-store cache headers for future account transport", () => {
    expect(customerAccountCacheHeaders["Cache-Control"]).toBe(
      "private, no-store",
    );
  });
});

const detail = async (
  harness: ReturnType<typeof accountHarness>,
  requestedOrderId: OrderId,
) => {
  const result = await harness.service.getOwnedOrderDetail({
    correlationId: correlationId(`detail-${requestedOrderId}`),
    orderId: requestedOrderId,
    principal: principal(harness.customerA),
  });
  if (result.status !== "OK") {
    throw new Error("expected detail");
  }
  return result.order;
};

const accountHarness = () => {
  const repository = new InMemoryCustomerAccountReadRepository();
  const audit = new CollectingAudit();
  const customerA = customerId("11111111-1111-4111-8111-111111111111");
  const customerB = customerId("22222222-2222-4222-8222-222222222222");
  repository.addAccount({
    createdAt: new Date("2026-08-20T10:00:00.000Z"),
    customerId: customerA,
    emailMasked: "a******@example.test",
    emailVerificationState: "VERIFIED",
  });
  repository.addAccount({
    createdAt: new Date("2026-08-20T11:00:00.000Z"),
    customerId: customerB,
    emailMasked: "b******@example.test",
    emailVerificationState: "VERIFIED",
  });

  const orders = {
    available: orderFixture(customerA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", {
      createdAt: new Date("2026-08-25T09:00:00.000Z"),
      fulfillment: fulfillmentFixture("ffffffff-ffff-4fff-8fff-fffffffffff1", {
        encrypted: true,
        orderIdValue: orderId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"),
      }),
      productTitle: "Safe Structured Steam Game",
      activation: {
        instructionCode: "STEAM_ACTIVATION_CODE",
        platform: "STEAM",
        source: "STRUCTURED",
      },
    }),
    pending: orderFixture(customerA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", {
      createdAt: new Date("2026-08-25T08:00:00.000Z"),
      fulfillment: fulfillmentFixture("ffffffff-ffff-4fff-8fff-fffffffffff2", {
        encrypted: false,
        orderIdValue: orderId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"),
        retrievalState: "IN_FLIGHT",
        status: "RETRIEVAL_IN_FLIGHT",
      }),
    }),
    manualReview: orderFixture(
      customerA,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
      {
        createdAt: new Date("2026-08-25T07:00:00.000Z"),
        fulfillment: fulfillmentFixture(
          "ffffffff-ffff-4fff-8fff-fffffffffff3",
          {
            encrypted: true,
            orderIdValue: orderId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3"),
            retrievalState: "MANUAL_REVIEW_REQUIRED",
            status: "MANUAL_REVIEW_REQUIRED",
          },
        ),
      },
    ),
    delivered: orderFixture(customerA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", {
      createdAt: new Date("2026-08-25T06:00:00.000Z"),
      fulfillment: fulfillmentFixture("ffffffff-ffff-4fff-8fff-fffffffffff4", {
        deliveredAt: new Date("2026-08-25T09:55:00.000Z"),
        deliveryState: "DELIVERED",
        encrypted: true,
        orderIdValue: orderId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4"),
        status: "DELIVERED",
      }),
      invoice: {
        downloadAvailable: true,
        invoiceReference: "INV-SAFE-1",
        issuedAt: new Date("2026-08-25T09:50:00.000Z"),
        status: "AVAILABLE",
      },
      activation: {
        instructionCode: null,
        platform: null,
        source: "TITLE_ONLY",
      },
    }),
    otherCustomer: orderFixture(
      customerB,
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      {
        createdAt: new Date("2026-08-25T09:30:00.000Z"),
      },
    ),
    legacy: orderFixture(
      customerId("33333333-3333-4333-8333-333333333333"),
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      {
        createdAt: new Date("2026-08-24T09:30:00.000Z"),
      },
    ),
    realLegacy: orderFixture(
      customerId("44444444-4444-4444-8444-444444444444"),
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      {
        createdAt: new Date("2026-08-23T09:30:00.000Z"),
        fulfillment: fulfillmentFixture(realFulfillmentId, {
          encrypted: true,
          orderIdValue: null,
        }),
      },
    ),
  };
  Object.values(orders).forEach((order) => repository.addOrder(order));
  const service = new CustomerAccountService({
    audit,
    cursorSigningSecret: cursorSigningFixture,
    environment: "CI",
    now: () => now,
    repository,
  });
  return {
    audit,
    capabilityConsumptions: 0,
    customerA,
    customerB,
    decryptCalls: 0,
    deliveryCalls: 0,
    orders,
    repositorySnapshot: (fulfillmentId: string) =>
      Object.values(orders)
        .map((order) => order.fulfillment)
        .find((fulfillment) => fulfillment?.fulfillmentId === fulfillmentId),
    service,
  };
};

const principal = (
  id: CustomerId,
  assurance: "AUTHENTICATED" | "TEST" = "AUTHENTICATED",
): AuthenticatedCustomerPrincipal => ({
  authenticationContext: { assurance, provider: "TEST" },
  customerId: id,
});

const orderFixture = (
  owner: CustomerId,
  id: string,
  options: {
    readonly createdAt: Date;
    readonly fulfillment?: CustomerAccountOrderProjection["fulfillment"];
    readonly invoice?: CustomerAccountOrderProjection["invoice"];
    readonly activation?: CustomerAccountOrderProjection["activation"];
    readonly productTitle?: string;
  },
): CustomerAccountOrderProjection => ({
  createdAt: options.createdAt,
  currency: currency("EUR"),
  customerId: owner,
  fulfillment: options.fulfillment ?? null,
  fulfillmentStatus: "PENDING",
  invoice: options.invoice ?? null,
  activation: options.activation ?? null,
  orderId: orderId(id),
  paymentStatus: "CAPTURED",
  procurementStatus: "SUCCEEDED",
  productTitle: options.productTitle ?? "Synthetic Product",
  refundStatus: "NOT_REQUESTED",
  status: "FULFILLMENT_PENDING",
  total: money(1999n, currency("EUR")),
  updatedAt: options.createdAt,
});

const fulfillmentFixture = (
  fulfillmentId: string,
  options: {
    readonly orderIdValue: OrderId | null;
    readonly encrypted: boolean;
    readonly status?:
      | "DELIVERY_PENDING"
      | "RETRIEVAL_IN_FLIGHT"
      | "MANUAL_REVIEW_REQUIRED"
      | "DELIVERED";
    readonly retrievalState?:
      "RETRIEVED" | "IN_FLIGHT" | "MANUAL_REVIEW_REQUIRED";
    readonly deliveryState?: "PENDING" | "DELIVERED";
    readonly deliveredAt?: Date | null;
  },
): NonNullable<CustomerAccountOrderProjection["fulfillment"]> => ({
  deliveredAt: options.deliveredAt ?? null,
  deliveryState: options.deliveryState ?? "PENDING",
  fulfillmentId,
  hasEncryptedSecret: options.encrypted,
  orderId: options.orderIdValue,
  retrievedAt:
    options.retrievalState === "IN_FLIGHT"
      ? null
      : new Date("2026-08-25T08:30:00.000Z"),
  retrievalState: options.retrievalState ?? "RETRIEVED",
  status: options.status ?? "DELIVERY_PENDING",
});

class CollectingAudit {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const safeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, child) =>
    typeof child === "bigint" ? child.toString() : child,
  );
