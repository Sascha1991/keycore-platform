import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { InMemoryCustomerAccountReadRepository } from "../../../../infra/customers/in-memory-customer-account-repository.js";
import { InMemoryCustomerOrderIdentityRepository } from "../../../../infra/customers/in-memory-customer-order-identity-repository.js";
import { InMemoryCustomerKeyDeliveryRepository } from "../../../../infra/fulfillment/in-memory-customer-key-delivery-repository.js";
import { InMemoryFulfillmentRepository } from "../../../../infra/fulfillment/in-memory-fulfillment-repository.js";
import {
  CustomerAccountService,
  CustomerKeyAccessService,
  CustomerKeyDeliveryService,
  CustomerOrderIdentityService,
  PersistedCustomerOrderAuthorizationPort,
  correlationId,
  currency,
  encryptFulfillmentSecret,
  fulfillmentEncryptionContext,
  keyAccessAvailable,
  money,
  orderId,
  supplierId,
  type AuditEvent,
  type AuditEventPort,
  type AuthenticatedCustomerPrincipal,
  type AuthenticatedCustomerPrincipalProvider,
  type CorrelationId,
  type CustomerAccountFulfillmentProjection,
  type CustomerAccountOrderProjection,
  type CustomerDeliveryAuthorization,
  type CustomerId,
  type CustomerIdentityBindingAuthorityPort,
  type CustomerKeyDeliveryPort,
  type CustomerKeyDeliveryPortResult,
  type EmailVerificationAuthorityPort,
  type FulfillmentOperation,
  type KeyManagementProvider,
  type OrderId,
} from "../contracts.js";

const now = new Date("2026-08-26T10:00:00.000Z");
const markerSecret = "KEYCORE_KS0804_SYNTHETIC_PRODUCT_KEY_DO_NOT_USE_918273";
const realFulfillmentId = "fd61be5e-44ea-4914-98ae-c4404dc31779";

describe("CustomerKeyAccessService", () => {
  it("connects account metadata to secure delivery with a synthetic key only at the delivery boundary", async () => {
    const harness = await keyAccessHarness();
    const accountService = new CustomerAccountService({
      cursorSigningSecret: "customer-key-access-cursor-secret-32",
      repository: harness.accountRepository,
    });

    const detail = await accountService.getOwnedOrderDetail({
      correlationId: correlationId("ks0804-detail"),
      orderId: harness.orderId,
      principal: harness.principal,
    });
    expect(detail).toMatchObject({
      order: {
        fulfillment: {
          keyAccessAvailable: true,
          status: "KEY_AVAILABLE",
        },
      },
      status: "OK",
    });
    expect(harness.keyProvider.unwraps).toBe(0);
    expect(harness.deliveryPort.calls).toHaveLength(0);

    const prepared = await harness.keyAccessService.prepareKeyAccess({
      correlationId: correlationId("ks0804-prepare"),
      fulfillmentReference: harness.fulfillment.id,
      orderId: harness.orderId,
      principal: harness.principal,
    });
    expect(prepared).toMatchObject({ status: "AUTHORIZED" });
    expect(safeJson(harness.deliveryRepository.approvals)).not.toContain(
      prepared.status === "AUTHORIZED" ? prepared.deliveryCapability : "",
    );
    expect(harness.keyProvider.unwraps).toBe(0);
    expect(harness.deliveryPort.calls).toHaveLength(0);

    const delivered = await harness.keyAccessService.executeKeyAccess({
      correlationId: correlationId("ks0804-execute"),
      deliveryApprovalId:
        prepared.status === "AUTHORIZED" ? prepared.deliveryApprovalId : "",
      deliveryCapability:
        prepared.status === "AUTHORIZED" ? prepared.deliveryCapability : "",
      fulfillmentReference: harness.fulfillment.id,
      orderId: harness.orderId,
      principal: harness.principal,
    });

    expect(delivered).toMatchObject({ status: "DELIVERED" });
    expect(harness.deliveryPort.calls).toHaveLength(1);
    expect(harness.deliveryPort.lastPlaintextSeen).toBe(markerSecret);
    expect(harness.keyProvider.unwraps).toBe(1);
    expect(harness.supplierCalls).toBe(0);
    expect(
      safeJson({
        audit: harness.audit.events,
        deliveryRepository: harness.deliveryRepository,
        result: delivered,
      }),
    ).not.toContain(markerSecret);
    expect(
      safeJson({
        audit: harness.audit.events,
        deliveryRepository: harness.deliveryRepository,
      }),
    ).not.toMatch(
      /deliveryCapability|session|token|ciphertext|nonce|wrapped/iu,
    );
  });

  it("keeps wrong-owner, unknown, unclaimed and mismatched fulfillment access enumeration-safe with zero decrypt", async () => {
    for (const options of [
      { owner: "other" as const },
      { accountFulfillmentOrder: "mismatch" as const },
      { fulfillmentInIdentity: "mismatch" as const },
      { includeAccountFulfillment: false },
      {
        fulfillmentId: realFulfillmentId,
        accountFulfillmentOrder: "unclaimed" as const,
      },
    ]) {
      const harness = await keyAccessHarness(options);
      const result = await harness.keyAccessService.prepareKeyAccess({
        correlationId: correlationId("ks0804-denied"),
        fulfillmentReference: harness.fulfillment.id,
        orderId: harness.orderId,
        principal: harness.principal,
      });

      expect(result).toMatchObject({
        code: "RESOURCE_NOT_AVAILABLE",
        status: "DENIED",
      });
      expect(harness.keyProvider.unwraps).toBe(0);
      expect(harness.deliveryPort.calls).toHaveLength(0);
      expect(harness.supplierCalls).toBe(0);
      if (harness.fulfillment.id === realFulfillmentId) {
        expect(harness.accountFulfillmentSnapshot()).toMatchObject({
          deliveryState: "PENDING",
          fulfillmentId: realFulfillmentId,
          orderId: null,
        });
      }
    }
  });

  it("denies non-ready, manual-review, invalid-principal and unverified states before decrypt", async () => {
    for (const options of [
      { fulfillmentState: "manual-review" as const },
      { fulfillmentState: "not-retrieved" as const },
      { principalMode: "missing" as const },
      { verifiedCustomer: false },
    ]) {
      const harness = await keyAccessHarness(options);
      const result = await harness.keyAccessService.prepareKeyAccess({
        correlationId: correlationId("ks0804-not-available"),
        fulfillmentReference: harness.fulfillment.id,
        orderId: harness.orderId,
        principal: harness.principal,
      });

      expect(result.status).toBe("DENIED");
      expect(result.status === "DENIED" ? result.code : "unexpected").toMatch(
        /AUTHENTICATION_REQUIRED|KEY_ACCESS_NOT_AVAILABLE|RESOURCE_NOT_AVAILABLE/u,
      );
      expect(harness.keyProvider.unwraps).toBe(0);
      expect(harness.deliveryPort.calls).toHaveLength(0);
      expect(harness.supplierCalls).toBe(0);
    }
  });

  it("preserves one-time capability replay, concurrency and stale in-flight manual-review semantics", async () => {
    const concurrent = await keyAccessHarness();
    const prepared = await prepare(concurrent);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => execute(concurrent, prepared)),
    );

    expect(
      results.filter((result) => result.status === "DELIVERED"),
    ).toHaveLength(1);
    expect(concurrent.deliveryPort.calls).toHaveLength(1);
    expect(concurrent.keyProvider.unwraps).toBe(1);
    await expect(execute(concurrent, prepared)).resolves.toMatchObject({
      status: "ALREADY_DELIVERED",
    });

    const inFlight = await keyAccessHarness({
      deliveryPort: new HangingDeliveryPort(),
    });
    const inFlightPrepared = await prepare(inFlight);
    void execute(inFlight, inFlightPrepared);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(execute(inFlight, inFlightPrepared)).resolves.toMatchObject({
      status: "IN_FLIGHT",
    });

    const stale = await keyAccessHarness({
      deliveryLeaseStaleAfterMs: 1,
      deliveryPort: new HangingDeliveryPort(),
      executeNow: () => new Date(now.getTime() + 5_000),
    });
    const stalePrepared = await prepare(stale);
    void execute(stale, stalePrepared);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(
      execute(stale, stalePrepared, stale.executeService),
    ).resolves.toMatchObject({
      status: "MANUAL_REVIEW_REQUIRED",
    });
  });

  it("re-checks current persisted authorization after stale account metadata and before decrypt", async () => {
    const harness = await keyAccessHarness();
    const accountService = new CustomerAccountService({
      cursorSigningSecret: "customer-key-access-cursor-secret-32",
      repository: harness.accountRepository,
    });

    await expect(
      accountService.getOwnedOrderDetail({
        correlationId: correlationId("ks0804-stale-detail"),
        orderId: harness.orderId,
        principal: harness.principal,
      }),
    ).resolves.toMatchObject({
      order: { fulfillment: { keyAccessAvailable: true } },
      status: "OK",
    });

    const prepared = await prepare(harness);
    expect(prepared.status).toBe("AUTHORIZED");
    const encryptedSecretId = harness.fulfillment.encryptedSecretId;
    if (!encryptedSecretId) {
      throw new Error("Expected KS-08-04 stale-state encrypted secret fixture");
    }

    harness.identityRepository.addFulfillment({
      deliveryState: "PENDING",
      encryptedSecretId,
      fulfillmentId: harness.fulfillment.id,
      orderId: orderId(randomUUID()),
      retrievalState: "RETRIEVED",
      status: "DELIVERY_PENDING",
    });

    await expect(execute(harness, prepared)).resolves.toMatchObject({
      code: "CONFLICT",
      status: "DENIED",
    });
    expect(harness.keyProvider.unwraps).toBe(0);
    expect(harness.deliveryPort.calls).toHaveLength(0);
    expect(harness.supplierCalls).toBe(0);
  });

  it("fails closed for cross-customer sessions, capability context mismatch and order/fulfillment confusion", async () => {
    const crossCustomer = await keyAccessHarness();
    const prepared = await prepare(crossCustomer);
    crossCustomer.authorizationPrincipalProvider.setPrincipal({
      authenticationContext: {
        assurance: "AUTHENTICATED",
        provider: "TEST",
      },
      customerId: crossCustomer.otherCustomerId,
    });

    await expect(execute(crossCustomer, prepared)).resolves.toMatchObject({
      code: "CONFLICT",
      status: "DENIED",
    });
    expect(crossCustomer.keyProvider.unwraps).toBe(0);
    expect(crossCustomer.deliveryPort.calls).toHaveLength(0);

    const confused = await keyAccessHarness();
    const otherOwnedOrder = orderId(randomUUID());
    const otherFulfillment = fulfillmentFixture(otherOwnedOrder);
    confused.accountRepository.addOrder({
      activation: null,
      createdAt: now,
      currency: currency("EUR"),
      customerId: confused.customerId,
      fulfillment: accountFulfillment(
        otherFulfillment,
        otherOwnedOrder,
        "ready",
      ),
      fulfillmentStatus: "PENDING",
      invoice: null,
      orderId: otherOwnedOrder,
      paymentStatus: "CAPTURED",
      procurementStatus: "SUCCEEDED",
      productTitle: "Second owned synthetic product",
      refundStatus: "NOT_REQUESTED",
      status: "FULFILLMENT_PENDING",
      total: money(1999n, currency("EUR")),
      updatedAt: now,
    });

    await expect(
      confused.keyAccessService.prepareKeyAccess({
        correlationId: correlationId("ks0804-confused-pairing"),
        fulfillmentReference: otherFulfillment.id,
        orderId: confused.orderId,
        principal: confused.principal,
      }),
    ).resolves.toMatchObject({
      code: "RESOURCE_NOT_AVAILABLE",
      status: "DENIED",
    });
    expect(confused.keyProvider.unwraps).toBe(0);
    expect(confused.deliveryPort.calls).toHaveLength(0);
  });

  it("does not leak synthetic key, session or capability material through denied and failure observations", async () => {
    const capabilityMarker =
      "KS0804CapabilityMarker_abcdefghijklmnopqrstuvwxyzABCDEFGHI";
    const sessionMarker =
      "KEYCORE_KS0804_HARDENING_SESSION_TOKEN_DO_NOT_LEAK_731946";
    const harness = await keyAccessHarness();
    const prepared = await prepare(harness);
    const delivered = await execute(harness, prepared);
    const replay = await execute(harness, prepared);
    const wrongCapability = await harness.keyAccessService.executeKeyAccess({
      correlationId: correlationId("ks0804-wrong-capability"),
      deliveryApprovalId:
        prepared.status === "AUTHORIZED" ? prepared.deliveryApprovalId : "",
      deliveryCapability: capabilityMarker,
      fulfillmentReference: harness.fulfillment.id,
      orderId: harness.orderId,
      principal: harness.principal,
    });

    const observable = safeJson({
      audit: harness.audit.events,
      deliveryRepository: harness.deliveryRepository,
      delivered,
      replay,
      sessionMarkerHashOnly: sessionMarker.length,
      wrongCapability,
    });
    expect(observable).not.toContain(markerSecret);
    expect(observable).not.toContain(sessionMarker);
    expect(observable).not.toContain(capabilityMarker);
    expect(observable).not.toMatch(
      /deliveryCapability|sessionCredential|ciphertext|nonce|wrapped/iu,
    );
    expect(harness.deliveryPort.calls).toHaveLength(1);
    expect(harness.supplierCalls).toBe(0);
  });

  it("does not let WooCommerce-style authority fields or title text affect eligibility", async () => {
    const harness = await keyAccessHarness({
      productTitle: "Steam key activation says use title only",
    });
    const wooInput = {
      billingEmail: "buyer@example.test",
      customerId: harness.customerId,
      externalSupplierOrderId: "K-ORDER-123",
      wooCommerceCustomerId: "123",
    };

    expect(
      keyAccessAvailable({
        fulfillment: harness.accountFulfillmentSnapshot(),
        orderCustomerId: harness.customerId,
        orderId: orderId(harness.orderId),
        principalCustomerId: harness.customerId,
      }),
    ).toBe(true);
    expect(safeJson(wooInput)).toContain("buyer@example.test");
    const prepared = await prepare(harness);
    expect(prepared.status).toBe("AUTHORIZED");
    expect(harness.supplierCalls).toBe(0);
  });
});

const prepare = (harness: Awaited<ReturnType<typeof keyAccessHarness>>) =>
  harness.keyAccessService.prepareKeyAccess({
    correlationId: correlationId("ks0804-prepare-shared"),
    fulfillmentReference: harness.fulfillment.id,
    orderId: harness.orderId,
    principal: harness.principal,
  });

const execute = (
  harness: Awaited<ReturnType<typeof keyAccessHarness>>,
  prepared: Awaited<ReturnType<typeof prepare>>,
  service = harness.keyAccessService,
) =>
  service.executeKeyAccess({
    correlationId: correlationId("ks0804-execute-shared"),
    deliveryApprovalId:
      prepared.status === "AUTHORIZED" ? prepared.deliveryApprovalId : "",
    deliveryCapability:
      prepared.status === "AUTHORIZED" ? prepared.deliveryCapability : "",
    fulfillmentReference: harness.fulfillment.id,
    orderId: harness.orderId,
    principal: harness.principal,
  });

const keyAccessHarness = async (
  options: {
    readonly owner?: "session" | "other";
    readonly principalMode?: "valid" | "missing";
    readonly verifiedCustomer?: boolean;
    readonly removeIdentityBinding?: boolean;
    readonly includeAccountFulfillment?: boolean;
    readonly accountFulfillmentOrder?: "owned" | "mismatch" | "unclaimed";
    readonly fulfillmentInIdentity?: "owned" | "mismatch";
    readonly fulfillmentState?: "ready" | "manual-review" | "not-retrieved";
    readonly fulfillmentId?: string;
    readonly productTitle?: string;
    readonly deliveryPort?: FakeDeliveryPort;
    readonly deliveryLeaseStaleAfterMs?: number;
    readonly executeNow?: () => Date;
  } = {},
) => {
  const audit = new CapturingAudit();
  const identityRepository = new InMemoryCustomerOrderIdentityRepository();
  const subject = `ks0804-${randomUUID()}`;
  const created = await createCustomer(identityRepository, subject, {
    verified: options.verifiedCustomer !== false,
  });
  if (options.removeIdentityBinding) {
    identityRepository.removeIdentityBindingById(created.bindingId);
  }
  const other = await createCustomer(
    identityRepository,
    `other-${randomUUID()}`,
    {
      verified: true,
    },
  );
  const owner =
    options.owner === "other" ? other.customerId : created.customerId;
  const order = orderId(randomUUID());
  const mismatchOrder = orderId(randomUUID());
  const fulfillmentRepository = new InMemoryFulfillmentRepository();
  const deliveryRepository = new InMemoryCustomerKeyDeliveryRepository(
    fulfillmentRepository,
  );
  const keyProvider = new CountingKeyProvider("ks0804-mk-v1");
  const fulfillment = fulfillmentFixture(order, options.fulfillmentId);
  const material = await encryptFulfillmentSecret(
    Buffer.from(markerSecret, "utf8"),
    fulfillmentEncryptionContext(fulfillment),
    keyProvider,
  );
  await fulfillmentRepository.createIdempotent({ now, operation: fulfillment });
  await fulfillmentRepository.markRetrieved({
    executionToken: fulfillment.retrievalExecutionToken ?? "",
    fulfillmentId: fulfillment.id,
    material,
    now,
  });
  const retrieved = await fulfillmentRepository.findById(fulfillment.id);
  if (!retrieved?.encryptedSecretId) {
    throw new Error("Expected KS-08-04 retrieved fulfillment fixture");
  }
  const accountRepository = new InMemoryCustomerAccountReadRepository();
  accountRepository.addAccount({
    createdAt: now,
    customerId: created.customerId,
    emailMasked: "k******@example.test",
    emailVerificationState:
      options.verifiedCustomer === false ? "UNVERIFIED" : "VERIFIED",
  });
  accountRepository.addOrder({
    activation: {
      instructionCode: "STEAM_STRUCTURED_ACTIVATION",
      platform: "STEAM",
      source: "STRUCTURED",
    },
    createdAt: now,
    currency: currency("EUR"),
    customerId: owner,
    fulfillment:
      options.includeAccountFulfillment === false
        ? null
        : accountFulfillment(
            retrieved,
            options.accountFulfillmentOrder === "mismatch"
              ? mismatchOrder
              : options.accountFulfillmentOrder === "unclaimed"
                ? null
                : order,
            options.fulfillmentState ?? "ready",
          ),
    fulfillmentStatus: "PENDING",
    invoice: { downloadAvailable: false, status: "PENDING" },
    orderId: order,
    paymentStatus: "CAPTURED",
    procurementStatus: "SUCCEEDED",
    productTitle: options.productTitle ?? "Synthetic KS-08-04 Product",
    refundStatus: "NOT_REQUESTED",
    status: "FULFILLMENT_PENDING",
    total: money(999n, currency("EUR")),
    updatedAt: now,
  });
  identityRepository.addOrder({
    customerId: owner,
    fulfillmentStatus: "PENDING",
    orderId: order,
    paymentStatus: "CAPTURED",
    procurementStatus: "SUCCEEDED",
    recordVersion: 1,
    status: "FULFILLMENT_PENDING",
    updatedAt: now,
  });
  identityRepository.addFulfillment({
    deliveryState:
      options.fulfillmentState === "manual-review"
        ? "MANUAL_REVIEW_REQUIRED"
        : "PENDING",
    encryptedSecretId: retrieved.encryptedSecretId,
    fulfillmentId: fulfillment.id,
    orderId:
      options.fulfillmentInIdentity === "mismatch" ? mismatchOrder : order,
    retrievalState:
      options.fulfillmentState === "not-retrieved"
        ? "NOT_STARTED"
        : "RETRIEVED",
    status:
      options.fulfillmentState === "manual-review"
        ? "MANUAL_REVIEW_REQUIRED"
        : "DELIVERY_PENDING",
  });
  const principal: AuthenticatedCustomerPrincipal | null =
    options.principalMode === "missing"
      ? null
      : {
          authenticationContext: {
            assurance: "AUTHENTICATED",
            provider: "TEST",
          },
          customerId: created.customerId,
        };
  const deliveryPort = options.deliveryPort ?? new FakeDeliveryPort();
  const authorizationPrincipalProvider =
    new MutableAuthenticatedCustomerPrincipalProvider(principal);
  const commonDelivery = {
    approvalTtlMs: 300_000,
    audit,
    deliveryLeaseStaleAfterMs: options.deliveryLeaseStaleAfterMs ?? 60_000,
    deliveryPort,
    deliveryRepository,
    environment: "CI" as const,
    fulfillmentRepository,
    keyManagementProvider: keyProvider,
    orderAuthorization: new PersistedCustomerOrderAuthorizationPort({
      audit,
      environment: "CI",
      principalProvider: authorizationPrincipalProvider,
      repository: identityRepository,
    }),
    protectedFulfillmentIds: [realFulfillmentId],
  };
  const deliveryService = new CustomerKeyDeliveryService({
    ...commonDelivery,
    now: () => now,
  });
  const keyAccessService = new CustomerKeyAccessService({
    accountRepository,
    audit,
    deliveryService,
    environment: "CI",
    now: () => now,
  });
  const executeDeliveryService = new CustomerKeyDeliveryService({
    ...commonDelivery,
    now: options.executeNow ?? (() => now),
  });
  const executeService = new CustomerKeyAccessService({
    accountRepository,
    audit,
    deliveryService: executeDeliveryService,
    environment: "CI",
    now: options.executeNow ?? (() => now),
  });
  return {
    accountFulfillmentSnapshot: () =>
      requiredAccountFulfillment(
        (
          accountRepository as unknown as {
            readonly orders?: Map<OrderId, CustomerAccountOrderProjection>;
          }
        ).orders?.get(order)?.fulfillment,
      ),
    accountRepository,
    audit,
    authorizationPrincipalProvider,
    customerId: created.customerId,
    deliveryPort,
    deliveryRepository,
    executeService,
    fulfillment: retrieved,
    identityRepository,
    keyAccessService,
    keyProvider,
    orderId: order,
    otherCustomerId: other.customerId,
    principal,
    supplierCalls: 0,
  };
};

const createCustomer = async (
  repository: InMemoryCustomerOrderIdentityRepository,
  providerSubject: string,
  options: { readonly verified: boolean },
) => {
  const service = new CustomerOrderIdentityService({
    emailVerificationAuthority: new FakeEmailVerificationAuthority(),
    identityBindingAuthority: new FakeIdentityBindingAuthority(providerSubject),
    now: () => now,
    repository,
  });
  const created = await service.createCustomer({
    correlationId: correlationId(`ks0804-create-${providerSubject}`),
    email: `${providerSubject}@example.test`,
  });
  if (!("customer" in created)) {
    throw new Error("Expected KS-08-04 customer fixture");
  }
  if (options.verified) {
    await service.markEmailVerified({
      correlationId: correlationId(`ks0804-verify-${providerSubject}`),
      customerId: created.customer.id,
      expectedCustomerVersion: 1,
    });
  }
  const binding = await service.bindIdentity({
    correlationId: correlationId(`ks0804-bind-${providerSubject}`),
    customerId: created.customer.id,
  });
  if (!("binding" in binding)) {
    throw new Error("Expected KS-08-04 binding fixture");
  }
  return { bindingId: binding.binding.id, customerId: created.customer.id };
};

const accountFulfillment = (
  fulfillment: FulfillmentOperation,
  fixtureOrderId: OrderId | null,
  state: "ready" | "manual-review" | "not-retrieved",
): CustomerAccountFulfillmentProjection => ({
  deliveredAt: null,
  deliveryState: "PENDING",
  fulfillmentId: fulfillment.id,
  hasEncryptedSecret: Boolean(fulfillment.encryptedSecretId),
  orderId: fixtureOrderId,
  retrievedAt: state === "not-retrieved" ? null : now,
  retrievalState: state === "not-retrieved" ? "NOT_STARTED" : "RETRIEVED",
  status:
    state === "manual-review" ? "MANUAL_REVIEW_REQUIRED" : "DELIVERY_PENDING",
});

const fulfillmentFixture = (
  fixtureOrderId: OrderId,
  id: string = randomUUID(),
): FulfillmentOperation => ({
  approvalExpiresAt: new Date(now.getTime() + 300_000),
  controlledProcurementApprovalId: null,
  correlationId: correlationId("ks0804-fulfillment"),
  createdAt: now,
  deliveryState: "NOT_READY",
  expectedQuantity: 1,
  externalSupplierOrderId: "synthetic-supplier-order",
  id,
  orderId: fixtureOrderId,
  procurementOperationId: randomUUID(),
  recordVersion: 1,
  retrievalExecutionToken: randomUUID(),
  retrievalStartedAt: now,
  retrievalState: "IN_FLIGHT",
  status: "RETRIEVAL_IN_FLIGHT",
  supplierId: supplierId("mock-supplier"),
  supplierItemReference: "ks0804-supplier-item",
  tokenHash: "a".repeat(64),
  updatedAt: now,
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
        providerEvidenceId: `email:${input.correlationId}`,
        verifiedAt: now,
      },
      status: "AUTHORIZED" as const,
    };
  }
}

class FakeIdentityBindingAuthority implements CustomerIdentityBindingAuthorityPort {
  public constructor(private readonly providerSubject: string) {}

  public async verifiedIdentitySubject() {
    return {
      provider: "TEST" as const,
      providerEvidenceId: `identity:${this.providerSubject}`,
      providerSubject: this.providerSubject,
      status: "AUTHORIZED" as const,
    };
  }
}

class FakeDeliveryPort implements CustomerKeyDeliveryPort {
  public readonly calls: CustomerDeliveryAuthorization[] = [];
  public lastPlaintextSeen: string | null = null;

  public async deliver(input: {
    readonly authorization: CustomerDeliveryAuthorization;
    readonly plaintext: Buffer;
  }): Promise<CustomerKeyDeliveryPortResult> {
    this.calls.push(input.authorization);
    this.lastPlaintextSeen = input.plaintext.toString("utf8");
    return {
      channel: "FAKE",
      deliveredAt: now,
      deliveryReference: `ks0804-delivery-${this.calls.length}`,
      status: "DELIVERED",
    };
  }
}

class HangingDeliveryPort extends FakeDeliveryPort {
  public override async deliver(input: {
    readonly authorization: CustomerDeliveryAuthorization;
    readonly plaintext: Buffer;
  }): Promise<CustomerKeyDeliveryPortResult> {
    this.calls.push(input.authorization);
    this.lastPlaintextSeen = input.plaintext.toString("utf8");
    return new Promise(() => undefined);
  }
}

class CountingKeyProvider implements KeyManagementProvider {
  public unwraps = 0;

  public constructor(private readonly keyId: string) {}

  public async activeMasterKeyVersion(): Promise<string> {
    return this.keyId;
  }

  public async wrapDataKey(request: { readonly dataKey: Uint8Array }) {
    return {
      keyVersion: this.keyId,
      wrappedDataKey: Buffer.from(request.dataKey).map((byte) => byte ^ 0xa5),
    };
  }

  public async unwrapDataKey(request: {
    readonly wrappedDataKey: Uint8Array;
    readonly keyVersion: string;
  }) {
    this.unwraps += 1;
    if (request.keyVersion !== this.keyId) {
      throw new Error("wrong KS-08-04 key");
    }
    return Buffer.from(request.wrappedDataKey).map((byte) => byte ^ 0xa5);
  }

  public async getKeyVersionMetadata() {
    return { provider: "memory", version: this.keyId };
  }
}

class MutableAuthenticatedCustomerPrincipalProvider implements AuthenticatedCustomerPrincipalProvider {
  public constructor(
    private principal: AuthenticatedCustomerPrincipal | null,
  ) {}

  public setPrincipal(principal: AuthenticatedCustomerPrincipal | null): void {
    this.principal = principal;
  }

  public async currentPrincipal(): Promise<AuthenticatedCustomerPrincipal | null> {
    return this.principal;
  }
}

class CapturingAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const requiredAccountFulfillment = (
  fulfillment: CustomerAccountFulfillmentProjection | null | undefined,
): CustomerAccountFulfillmentProjection => {
  if (!fulfillment) {
    throw new Error("Expected account fulfillment fixture");
  }
  return fulfillment;
};

const safeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, child) =>
    typeof child === "bigint" ? child.toString() : child,
  );
