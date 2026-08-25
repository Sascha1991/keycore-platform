import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { InMemoryCustomerOrderIdentityRepository } from "../../../../infra/customers/in-memory-customer-order-identity-repository.js";
import {
  CustomerOrderIdentityService,
  FailClosedProductionPrincipalProvider,
  PersistedCustomerOrderAuthorizationPort,
  StaticAuthenticatedCustomerPrincipalProvider,
  isSafeProviderSubject,
  maskCustomerEmail,
  normalizeCustomerEmail,
  type CustomerIdentityBindingAuthorityPort,
  type CustomerOrderIdentityServiceOptions,
  type EmailVerificationAuthorityPort,
  type OrderOwnershipBindingAuthorityPort,
} from "./customer-order-identity.js";
import {
  correlationId,
  customerId,
  orderId,
  type CustomerId,
  type CorrelationId,
  type OrderId,
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
    expect(isSafeProviderSubject("Subject-Exact.Case")).toBe(true);
    expect(isSafeProviderSubject(" Subject-Exact.Case")).toBe(false);
    expect(isSafeProviderSubject("subject\nbreak")).toBe(false);
  });

  it("normal customer creation is always unverified and replay cannot elevate it", async () => {
    const { service } = identityFixture();

    const first = await service.createCustomer({
      correlationId: correlationId("corr-customer-create"),
      email: "buyer@example.com",
    });
    const replay = await service.createCustomer({
      correlationId: correlationId("corr-customer-create"),
      email: "buyer@example.com",
    });

    expect(first).toMatchObject({
      customer: { emailVerificationState: "UNVERIFIED" },
      status: "CREATED",
    });
    expect(replay).toMatchObject({
      customer: {
        emailVerificationState: "UNVERIFIED",
        id: requiredCustomer(first),
      },
      status: "EXISTING",
    });
  });

  it("requires trusted verification evidence for UNVERIFIED to VERIFIED", async () => {
    const denied = identityFixture();
    const deniedCustomer = requiredCustomer(
      await denied.service.createCustomer({
        correlationId: correlationId("corr-verify-denied"),
        email: "verify-denied@example.com",
      }),
    );
    await expect(
      denied.service.markEmailVerified({
        correlationId: correlationId("corr-verify-denied"),
        customerId: deniedCustomer,
        expectedCustomerVersion: 1,
      }),
    ).resolves.toEqual({ status: "UNTRUSTED_AUTHORITY" });
    await expect(
      denied.repository.findCustomerById(deniedCustomer),
    ).resolves.toMatchObject({
      emailVerificationState: "UNVERIFIED",
    });

    const trusted = identityFixture({
      emailVerificationAuthority: new FakeEmailVerificationAuthority(),
    });
    const verifiedCustomer = requiredCustomer(
      await trusted.service.createCustomer({
        correlationId: correlationId("corr-verify-trusted"),
        email: "verify@example.com",
      }),
    );
    await expect(
      trusted.service.markEmailVerified({
        correlationId: correlationId("corr-verify-trusted"),
        customerId: verifiedCustomer,
        expectedCustomerVersion: 0,
      }),
    ).resolves.toMatchObject({ status: "STALE_WRITER" });
    await expect(
      trusted.service.markEmailVerified({
        correlationId: correlationId("corr-verify-trusted"),
        customerId: verifiedCustomer,
        expectedCustomerVersion: 1,
      }),
    ).resolves.toMatchObject({
      customer: { emailVerificationState: "VERIFIED", recordVersion: 2 },
      status: "VERIFIED",
    });
    await expect(
      trusted.service.markEmailVerified({
        correlationId: correlationId("corr-verify-trusted"),
        customerId: verifiedCustomer,
        expectedCustomerVersion: 2,
      }),
    ).resolves.toMatchObject({ status: "ALREADY_VERIFIED" });
  });

  it("requires provider authority for external identity binding", async () => {
    const noAuthority = identityFixture();
    const customer = requiredCustomer(
      await noAuthority.service.createCustomer({
        correlationId: correlationId("corr-id-no-authority"),
        email: "identity@example.com",
      }),
    );

    await expect(
      noAuthority.service.bindIdentity({
        correlationId: correlationId("corr-id-no-authority"),
        customerId: customer,
      }),
    ).resolves.toEqual({ status: "UNTRUSTED_AUTHORITY" });

    const trusted = identityFixture({
      identityBindingAuthority: new FakeIdentityBindingAuthority(
        "TEST",
        "Subject-Exact.Case",
      ),
    });
    const first = requiredCustomer(
      await trusted.service.createCustomer({
        correlationId: correlationId("corr-id-trusted"),
        email: "identity-owner@example.com",
      }),
    );
    const second = requiredCustomer(
      await trusted.service.createCustomer({
        correlationId: correlationId("corr-id-trusted-2"),
        email: "identity-other@example.com",
      }),
    );

    await expect(
      trusted.service.bindIdentity({
        correlationId: correlationId("corr-id-trusted"),
        customerId: first,
      }),
    ).resolves.toMatchObject({ status: "BOUND" });
    await expect(
      trusted.service.bindIdentity({
        correlationId: correlationId("corr-id-trusted"),
        customerId: first,
      }),
    ).resolves.toMatchObject({ status: "ALREADY_BOUND" });
    await expect(
      trusted.service.bindIdentity({
        correlationId: correlationId("corr-id-trusted-2"),
        customerId: second,
      }),
    ).resolves.toEqual({ status: "IDENTITY_CONFLICT" });
  });

  it("requires ownership authority and keeps ownership immutable", async () => {
    const noAuthority = identityFixture();
    const customer = requiredCustomer(
      await noAuthority.service.createCustomer({
        correlationId: correlationId("corr-owner-1"),
        email: "owner@example.com",
      }),
    );
    const ownedOrderId = addSyntheticOrder(noAuthority.repository);

    await expect(
      noAuthority.service.bindOrderOwnership({
        correlationId: correlationId("corr-owner-bind"),
        customerId: customer,
        expectedOrderVersion: 3,
        orderId: ownedOrderId,
      }),
    ).resolves.toEqual({ status: "UNTRUSTED_AUTHORITY" });

    const trusted = identityFixture({
      orderOwnershipAuthority: new FakeOrderOwnershipAuthority(),
    });
    const firstCustomer = requiredCustomer(
      await trusted.service.createCustomer({
        correlationId: correlationId("corr-owner-trusted-1"),
        email: "trusted-owner@example.com",
      }),
    );
    const secondCustomer = requiredCustomer(
      await trusted.service.createCustomer({
        correlationId: correlationId("corr-owner-trusted-2"),
        email: "trusted-other@example.com",
      }),
    );
    const order = addSyntheticOrder(trusted.repository);

    await expect(
      trusted.service.bindOrderOwnership({
        correlationId: correlationId("corr-owner-bind"),
        customerId: firstCustomer,
        expectedOrderVersion: 2,
        orderId: order,
      }),
    ).resolves.toMatchObject({ status: "STALE_WRITER" });
    await expect(
      trusted.service.bindOrderOwnership({
        correlationId: correlationId("corr-owner-bind"),
        customerId: firstCustomer,
        expectedOrderVersion: 3,
        orderId: order,
      }),
    ).resolves.toMatchObject({ status: "BOUND" });
    await expect(
      trusted.service.bindOrderOwnership({
        correlationId: correlationId("corr-owner-bind"),
        customerId: firstCustomer,
        expectedOrderVersion: 4,
        orderId: order,
      }),
    ).resolves.toMatchObject({ status: "ALREADY_BOUND" });
    await expect(
      trusted.service.bindOrderOwnership({
        correlationId: correlationId("corr-owner-bind"),
        customerId: secondCustomer,
        expectedOrderVersion: 4,
        orderId: order,
      }),
    ).resolves.toMatchObject({ status: "OWNERSHIP_CONFLICT" });
  });

  it("authorizes delivery only for accepted principal, verified owner, linked order and ready fulfillment", async () => {
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
      authorization(repository, owner, "AUTHENTICATED").authorizeDelivery(
        authz(owner, targetOrder, fulfillmentId),
      ),
    ).resolves.toEqual({ status: "AUTHORIZED" });
    await expect(
      authorization(repository, owner, "TEST").authorizeDelivery(
        authz(owner, targetOrder, fulfillmentId),
      ),
    ).resolves.toEqual({ status: "DENIED" });
    await expect(
      authorization(repository, owner, "TEST", true).authorizeDelivery(
        authz(owner, targetOrder, fulfillmentId),
      ),
    ).resolves.toEqual({ status: "AUTHORIZED" });
    await expect(
      authorization(
        repository,
        wrongCustomer,
        "AUTHENTICATED",
      ).authorizeDelivery(authz(owner, targetOrder, fulfillmentId)),
    ).resolves.toEqual({ status: "DENIED" });
    await expect(
      new PersistedCustomerOrderAuthorizationPort({
        principalProvider: new FailClosedProductionPrincipalProvider(),
        repository,
      }).authorizeDelivery(authz(owner, targetOrder, fulfillmentId)),
    ).resolves.toEqual({ status: "DENIED" });
  });

  it("keeps authorization before delivery so denied owners never trigger plaintext delivery", async () => {
    const deliver = vi.fn();
    const repository = new InMemoryCustomerOrderIdentityRepository();
    const owner = customerId(randomUUID());
    const auth = authorization(repository, owner, "AUTHENTICATED");

    await expect(
      auth.authorizeDelivery(authz(owner, orderId(randomUUID()), randomUUID())),
    ).resolves.toEqual({ status: "DENIED" });
    expect(deliver).not.toHaveBeenCalled();
  });
});

const identityFixture = (
  options: Omit<CustomerOrderIdentityServiceOptions, "repository" | "now"> = {},
): {
  readonly repository: InMemoryCustomerOrderIdentityRepository;
  readonly service: CustomerOrderIdentityService;
} => {
  const repository = new InMemoryCustomerOrderIdentityRepository();
  return {
    repository,
    service: new CustomerOrderIdentityService({
      now: () => now,
      repository,
      ...options,
    }),
  };
};

const addSyntheticOrder = (
  repository: InMemoryCustomerOrderIdentityRepository,
): OrderId => {
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
  return ownedOrderId;
};

const authorization = (
  repository: InMemoryCustomerOrderIdentityRepository,
  principalCustomerId: CustomerId,
  assurance: "TEST" | "AUTHENTICATED",
  allowTestPrincipal = false,
): PersistedCustomerOrderAuthorizationPort =>
  new PersistedCustomerOrderAuthorizationPort({
    allowTestPrincipal,
    principalProvider: new StaticAuthenticatedCustomerPrincipalProvider({
      authenticationContext: { assurance, provider: "TEST" },
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

class FakeEmailVerificationAuthority implements EmailVerificationAuthorityPort {
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
        providerEvidenceId: `email-evidence:${input.correlationId}`,
        verifiedAt: now,
      },
      status: "AUTHORIZED" as const,
    };
  }
}

class FakeIdentityBindingAuthority implements CustomerIdentityBindingAuthorityPort {
  public constructor(
    private readonly provider: "TEST",
    private readonly providerSubject: string,
  ) {}

  public async verifiedIdentitySubject(input: {
    readonly customerId: CustomerId;
    readonly correlationId: CorrelationId;
  }) {
    return {
      provider: this.provider,
      providerEvidenceId: `identity-evidence:${input.customerId}:${input.correlationId}`,
      providerSubject: this.providerSubject,
      status: "AUTHORIZED" as const,
    };
  }
}

class FakeOrderOwnershipAuthority implements OrderOwnershipBindingAuthorityPort {
  public async verifiedOrderOwnership(input: {
    readonly orderId: OrderId;
    readonly customerId: CustomerId;
    readonly correlationId: CorrelationId;
  }) {
    return {
      actorId: "checkout-service",
      actorType: "SERVICE" as const,
      providerEvidenceId: `ownership-evidence:${input.customerId}:${input.orderId}:${input.correlationId}`,
      status: "AUTHORIZED" as const,
    };
  }
}

const requiredCustomer = (
  result: Awaited<ReturnType<CustomerOrderIdentityService["createCustomer"]>>,
): CustomerId => {
  if (!("customer" in result)) {
    throw new Error("Expected customer test fixture");
  }
  return result.customer.id;
};
