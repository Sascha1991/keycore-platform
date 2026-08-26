import { describe, expect, it } from "vitest";

import { InMemoryCustomerAccountReadRepository } from "../../../../infra/customers/in-memory-customer-account-repository.js";
import {
  CustomerActivationInstructionsService,
  correlationId,
  currency,
  customerId,
  money,
  orderId,
  type ActivationInstructionRegistryEntry,
  type AuditEvent,
  type AuthenticatedCustomerPrincipal,
  type CustomerAccountOrderProjection,
  type CustomerId,
} from "../contracts.js";

const now = new Date("2026-08-26T10:15:00.000Z");
const productKeyLeakMarker = "KEYRANO-KS0806-PRODUCT-KEY-DO-NOT-LEAK";

describe("customer activation instructions foundation", () => {
  it("returns curated instructions only for structured activation metadata", async () => {
    const harness = activationHarness();
    const result = await harness.service.getActivationInstructions({
      correlationId: correlationId("activation-owned"),
      orderId: harness.structuredOrder.orderId,
      principal: principal(harness.customerA),
    });

    expect(result.status).toBe("OK");
    if (result.status !== "OK") {
      throw new Error("expected activation instructions");
    }
    expect(result.instructions).toMatchObject({
      instructionCode: "STEAM_ACTIVATION_CODE",
      platform: "STEAM",
      status: "AVAILABLE",
      title: "Steam activation",
      version: 1,
    });
    expect(result.instructions.steps.length).toBeGreaterThan(0);
    expect(safeJson(result)).not.toContain(productKeyLeakMarker);
    expect(harness.audit.events.at(-1)).toMatchObject({
      eventType: "CUSTOMER_ACTIVATION_INSTRUCTIONS_VIEWED",
      outcome: "SUCCEEDED",
    });
  });

  it("does not infer authoritative instructions from title-only or missing metadata", async () => {
    const harness = activationHarness();
    const titleOnly = await harness.service.getActivationInstructions({
      correlationId: correlationId("activation-title-only"),
      orderId: harness.titleOnlyOrder.orderId,
      principal: principal(harness.customerA),
    });
    const missing = await harness.service.getActivationInstructions({
      correlationId: correlationId("activation-missing"),
      orderId: harness.missingOrder.orderId,
      principal: principal(harness.customerA),
    });

    expect(titleOnly.status === "OK" ? titleOnly.instructions : null).toEqual({
      instructionCode: "GENERIC_SAFE_ACTIVATION",
      platform: "UNKNOWN",
      status: "NOT_AVAILABLE",
      steps: [],
      title: "Activation instructions are not available yet.",
      version: 1,
    });
    expect(missing.status === "OK" ? missing.instructions : null).toEqual(
      titleOnly.status === "OK" ? titleOnly.instructions : null,
    );
  });

  it("fails closed for wrong owner, missing order, malformed ID and test principals", async () => {
    const harness = activationHarness();
    await expect(
      harness.service.getActivationInstructions({
        correlationId: correlationId("activation-wrong-owner"),
        orderId: harness.otherOrder.orderId,
        principal: principal(harness.customerA),
      }),
    ).resolves.toEqual({
      code: "RESOURCE_NOT_AVAILABLE",
      status: "DENIED",
    });
    await expect(
      harness.service.getActivationInstructions({
        correlationId: correlationId("activation-bad-id"),
        orderId: "not-a-uuid",
        principal: principal(harness.customerA),
      }),
    ).resolves.toEqual({
      code: "RESOURCE_NOT_AVAILABLE",
      status: "DENIED",
    });
    await expect(
      harness.service.getActivationInstructions({
        correlationId: correlationId("activation-test-principal"),
        orderId: harness.structuredOrder.orderId,
        principal: principal(harness.customerA, "TEST"),
      }),
    ).resolves.toEqual({
      code: "AUTHENTICATION_REQUIRED",
      status: "DENIED",
    });
  });

  it("rejects unsafe registry content before it can reach a customer response", () => {
    const repository = new InMemoryCustomerAccountReadRepository();
    const unsafeEntries: readonly ActivationInstructionRegistryEntry[] = [
      {
        helpUrl: "javascript:alert(1)",
        instructionCode: "STEAM_ACTIVATION_CODE",
        platform: "STEAM",
        steps: [{ body: "Use Steam", label: "Open" }],
        title: "Steam activation",
        version: 1,
      },
    ];

    expect(
      () =>
        new CustomerActivationInstructionsService({
          registry: unsafeEntries,
          repository,
        }),
    ).toThrow("Activation instruction help URL is invalid");
  });
});

const activationHarness = () => {
  const repository = new InMemoryCustomerAccountReadRepository();
  const audit = new CollectingAudit();
  const customerA = customerId("11111111-1111-4111-8111-111111111111");
  const customerB = customerId("22222222-2222-4222-8222-222222222222");
  const structuredOrder = orderFixture(
    customerA,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    {
      activation: {
        instructionCode: "STEAM_ACTIVATION_CODE",
        platform: "STEAM",
        source: "STRUCTURED",
      },
    },
  );
  const titleOnlyOrder = orderFixture(
    customerA,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
    {
      activation: { source: "TITLE_ONLY" },
      productTitle: `Steam Edition ${productKeyLeakMarker}`,
    },
  );
  const missingOrder = orderFixture(
    customerA,
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac",
    {},
  );
  const otherOrder = orderFixture(
    customerB,
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    {
      activation: {
        instructionCode: "STEAM_ACTIVATION_CODE",
        platform: "STEAM",
        source: "STRUCTURED",
      },
    },
  );
  [structuredOrder, titleOnlyOrder, missingOrder, otherOrder].forEach((order) =>
    repository.addOrder(order),
  );
  return {
    audit,
    customerA,
    missingOrder,
    otherOrder,
    service: new CustomerActivationInstructionsService({
      audit,
      environment: "CI",
      now: () => now,
      repository,
    }),
    structuredOrder,
    titleOnlyOrder,
  };
};

const orderFixture = (
  owner: CustomerId,
  id: string,
  options: {
    readonly activation?: CustomerAccountOrderProjection["activation"];
    readonly productTitle?: string;
  },
): CustomerAccountOrderProjection => ({
  activation: options.activation ?? null,
  createdAt: now,
  currency: currency("EUR"),
  customerId: owner,
  fulfillment: null,
  fulfillmentStatus: "PENDING",
  invoice: null,
  orderId: orderId(id),
  paymentStatus: "CAPTURED",
  procurementStatus: "SUCCEEDED",
  productTitle: options.productTitle ?? "Synthetic activation product",
  refundStatus: "NOT_REQUESTED",
  status: "FULFILLMENT_PENDING",
  total: money(2599n, currency("EUR")),
  updatedAt: now,
});

const principal = (
  id: CustomerId,
  assurance: "AUTHENTICATED" | "TEST" = "AUTHENTICATED",
): AuthenticatedCustomerPrincipal => ({
  authenticationContext: { assurance, provider: "TEST" },
  customerId: id,
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
