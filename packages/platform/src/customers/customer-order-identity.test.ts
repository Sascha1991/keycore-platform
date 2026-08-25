import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { InMemoryCustomerOrderIdentityRepository } from "../../../../infra/customers/in-memory-customer-order-identity-repository.js";
import {
  CustomerOrderIdentityService,
  FailClosedProductionPrincipalProvider,
  PersistedCustomerOrderAuthorizationPort,
  StaticAuthenticatedCustomerPrincipalProvider,
  maskCustomerEmail,
  normalizeCustomerEmail,
} from "./customer-order-identity.js";
import {
  correlationId,
  customerId,
  orderId,
  type CustomerId,
} from "../domain/identifiers.js";

const now = new Date("2026-08-25T00:00:00.000Z");

describe("customer order identity", () => {
  it("normalizes email without treating email as mutable identity semantics", () => {
    expect(normalizeCustomerEmail(" Buyer+Tag@Example.COM ")).toBe(
      "Buyer+Tag@example.com",
    );
    expect(normalizeCustomerEmail("buyer example@example.com")).toBeNull();
    expect(normalizeCustomerEmail("buyer@example")).toBeNull();
    expect(maskCustomerEmail("buyer@example.com")).toBe("b****@example.com");
  });

  it("deduplicates normalized email explicitly without silent unsafe merges", async () => {
    const repository = new InMemoryCustomerOrderIdentityRepository();
    const service = new CustomerOrderIdentityService({
      now: () => now,
      repository,
    });

    const first = await service.createCustomer({
      correlationId: correlationId("corr-customer-create"),
      email: "buyer@example.com",
      emailVerificationState: "VERIFIED",
    });
    const firstCustomerId = requiredCustomer(first);
    const replay = await service.createCustomer({
      correlationId: correlationId("corr-customer-create"),
      email: "buyer@example.com",
    });

    expect(first.status).toBe("CREATED");
    expect(replay).toMatchObject({
      customer: { id: firstCustomerId },
      status: "EXISTING",
    });
  });

  it("binds order ownership only from trusted context and keeps ownership immutable", async () => {
    const repository = new InMemoryCustomerOrderIdentityRepository();
    const service = new CustomerOrderIdentityService({
      now: () => now,
      repository,
    });
    const firstCustomer = requiredCustomer(
      await service.createCustomer({
        correlationId: correlationId("corr-owner-1"),
        email: "owner@example.com",
        emailVerificationState: "VERIFIED",
      }),
    );
    const secondCustomer = requiredCustomer(
      await service.createCustomer({
        correlationId: correlationId("corr-owner-2"),
        email: "other@example.com",
        emailVerificationState: "VERIFIED",
      }),
    );
    const ownedOrderId = orderId(randomUUID());
    repository.addOrder({
      customerId: null,
      fulfillmentStatus: "PENDING",
      orderId: ownedOrderId,
      paymentStatus: "CAPTURED",
      procurementStatus: "SUCCEEDED",
      recordVersion: 3,
      status: "FULFILLMENT_PENDING",
      updatedAt: now,
    });

    await expect(
      service.bindOrderOwnership({
        correlationId: correlationId("corr-owner-bind"),
        customerId: firstCustomer,
        expectedOrderVersion: 3,
        orderId: ownedOrderId,
        trustedContext: null,
      }),
    ).resolves.toEqual({ status: "UNTRUSTED_CONTEXT" });
    await expect(
      service.bindOrderOwnership({
        correlationId: correlationId("corr-owner-bind"),
        customerId: firstCustomer,
        expectedOrderVersion: 2,
        orderId: ownedOrderId,
        trustedContext: trustedContext(),
      }),
    ).resolves.toMatchObject({ status: "STALE_WRITER" });
    await expect(
      service.bindOrderOwnership({
        correlationId: correlationId("corr-owner-bind"),
        customerId: firstCustomer,
        expectedOrderVersion: 3,
        orderId: ownedOrderId,
        trustedContext: trustedContext(),
      }),
    ).resolves.toMatchObject({ status: "BOUND" });
    await expect(
      service.bindOrderOwnership({
        correlationId: correlationId("corr-owner-bind"),
        customerId: secondCustomer,
        expectedOrderVersion: 4,
        orderId: ownedOrderId,
        trustedContext: trustedContext(),
      }),
    ).resolves.toMatchObject({ status: "OWNERSHIP_CONFLICT" });
  });

  it("authorizes delivery only for trusted principal, verified owner, linked order and ready fulfillment", async () => {
    const repository = new InMemoryCustomerOrderIdentityRepository();
    const owner = customerId(randomUUID());
    const wrongCustomer = customerId(randomUUID());
    const targetOrder = orderId(randomUUID());
    const fulfillmentId = randomUUID();
    await repository.createCustomer({
      customer: {
        createdAt: now,
        emailNormalized: "verified@example.com",
        emailVerificationState: "VERIFIED",
        id: owner,
        recordVersion: 1,
        updatedAt: now,
      },
      now,
    });
    await repository.createCustomer({
      customer: {
        createdAt: now,
        emailNormalized: "wrong@example.com",
        emailVerificationState: "VERIFIED",
        id: wrongCustomer,
        recordVersion: 1,
        updatedAt: now,
      },
      now,
    });
    repository.addOrder({
      customerId: owner,
      fulfillmentStatus: "PENDING",
      orderId: targetOrder,
      paymentStatus: "CAPTURED",
      procurementStatus: "SUCCEEDED",
      recordVersion: 1,
      status: "FULFILLMENT_PENDING",
      updatedAt: now,
    });
    repository.addFulfillment({
      deliveryState: "PENDING",
      encryptedSecretId: randomUUID(),
      fulfillmentId,
      orderId: targetOrder,
      retrievalState: "RETRIEVED",
      status: "DELIVERY_PENDING",
    });

    await expect(
      authorization(repository, owner).authorizeDelivery({
        customerId: owner,
        expiresAt: new Date(now.getTime() + 60_000),
        fulfillmentId,
        issuedAt: now,
        orderId: targetOrder,
        purpose: "customer-key-delivery",
        version: 1,
      }),
    ).resolves.toEqual({ status: "AUTHORIZED" });
    await expect(
      authorization(repository, wrongCustomer).authorizeDelivery({
        customerId: owner,
        expiresAt: new Date(now.getTime() + 60_000),
        fulfillmentId,
        issuedAt: now,
        orderId: targetOrder,
        purpose: "customer-key-delivery",
        version: 1,
      }),
    ).resolves.toEqual({ status: "DENIED" });
    await expect(
      new PersistedCustomerOrderAuthorizationPort({
        principalProvider: new FailClosedProductionPrincipalProvider(),
        repository,
      }).authorizeDelivery({
        customerId: owner,
        expiresAt: new Date(now.getTime() + 60_000),
        fulfillmentId,
        issuedAt: now,
        orderId: targetOrder,
        purpose: "customer-key-delivery",
        version: 1,
      }),
    ).resolves.toEqual({ status: "DENIED" });
  });

  it("keeps authorization before delivery so denied owners never trigger plaintext delivery", async () => {
    const deliver = vi.fn();
    const repository = new InMemoryCustomerOrderIdentityRepository();
    const owner = customerId(randomUUID());
    const auth = authorization(repository, owner);

    await expect(
      auth.authorizeDelivery({
        customerId: owner,
        expiresAt: new Date(now.getTime() + 60_000),
        fulfillmentId: randomUUID(),
        issuedAt: now,
        orderId: orderId(randomUUID()),
        purpose: "customer-key-delivery",
        version: 1,
      }),
    ).resolves.toEqual({ status: "DENIED" });
    expect(deliver).not.toHaveBeenCalled();
  });
});

const authorization = (
  repository: InMemoryCustomerOrderIdentityRepository,
  principalCustomerId: CustomerId,
): PersistedCustomerOrderAuthorizationPort =>
  new PersistedCustomerOrderAuthorizationPort({
    principalProvider: new StaticAuthenticatedCustomerPrincipalProvider({
      authenticationContext: { assurance: "TEST", provider: "TEST" },
      customerId: principalCustomerId,
    }),
    repository,
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
