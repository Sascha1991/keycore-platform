import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { InMemoryCustomerAuthSessionRepository } from "../../../../infra/customers/in-memory-customer-authentication-repository.js";
import { InMemoryCustomerOrderIdentityRepository } from "../../../../infra/customers/in-memory-customer-order-identity-repository.js";
import { InMemoryCustomerKeyDeliveryRepository } from "../../../../infra/fulfillment/in-memory-customer-key-delivery-repository.js";
import { InMemoryFulfillmentRepository } from "../../../../infra/fulfillment/in-memory-fulfillment-repository.js";
import {
  AuthenticatedCustomerDeliveryTransportHandler,
  CustomerAuthenticationService,
  CustomerKeyDeliveryService,
  CustomerOrderIdentityService,
  HmacDoubleSubmitCsrfPolicy,
  InMemoryAuthenticatedDeliveryRateLimiter,
  PersistedCustomerOrderAuthorizationPort,
  StaticAuthenticatedCustomerPrincipalProvider,
  authenticatedDeliveryCookiePolicy,
  correlationId,
  encryptFulfillmentSecret,
  fulfillmentEncryptionContext,
  orderId,
  parseAllowedOrigins,
  productId,
  supplierId,
  type AuditEvent,
  type AuditEventPort,
  type AuthenticatedCustomerDeliveryCsrfPolicy,
  type AuthenticatedCustomerDeliveryRateLimiter,
  type AuthenticatedDeliveryTransportRequest,
  type CorrelationId,
  type CustomerAuthenticationAuthorityPort,
  type CustomerDeliveryAuthorization,
  type CustomerKeyDeliveryError,
  type CustomerId,
  type CustomerIdentityBindingAuthorityPort,
  type CustomerKeyDeliveryPort,
  type CustomerKeyDeliveryPortResult,
  type EmailVerificationAuthorityPort,
  type FulfillmentOperation,
  type KeyManagementProvider,
  type OrderId,
  type OrderOwnershipBindingAuthorityPort,
  type VerifiedCustomerAuthenticationAssertion,
} from "../contracts.js";

const now = new Date("2026-08-25T12:00:00.000Z");
const allowedOrigin = "https://customer.example.test";
const csrfSecret = "0123456789abcdef0123456789abcdef";
const syntheticKey = "SYNTHETIC_CUSTOMER_DELIVERY_SECRET";
const realFulfillmentId = "fd61be5e-44ea-4914-98ae-c4404dc31779";

describe("AuthenticatedCustomerDeliveryTransportHandler", () => {
  it("performs synthetic authenticated capability-backed delivery exactly once", async () => {
    const harness = await deliveryHarness();
    const prepared = await harness.handler.prepareDelivery(
      harness.request({ mode: "prepare" }),
    );
    expect(prepared).toMatchObject({
      body: { status: "AUTHORIZED" },
      statusCode: 201,
    });

    const delivered = await harness.handler.executeDelivery(
      harness.request({
        deliveryApprovalId:
          prepared.body.status === "AUTHORIZED"
            ? prepared.body.deliveryApprovalId
            : "",
        deliveryCapability:
          prepared.body.status === "AUTHORIZED"
            ? prepared.body.deliveryCapability
            : "",
        mode: "execute",
      }),
    );

    expect(delivered).toMatchObject({
      body: { status: "DELIVERED" },
      headers: { "Cache-Control": "no-store" },
      statusCode: 200,
    });
    expect(harness.deliveryPort.calls).toHaveLength(1);
    expect(harness.deliveryPort.lastPlaintextSeen).toBe(syntheticKey);
    expect(harness.keyProvider.unwraps).toBe(1);
    expect(JSON.stringify(harness.audit.events)).not.toMatch(
      /SYNTHETIC_CUSTOMER_DELIVERY_SECRET|deliveryCapability|csrf|sessionCredential|token|hash/iu,
    );
  });

  it("denies bad authentication, object authorization, csrf, origin and capability before decrypt or delivery", async () => {
    const harness = await deliveryHarness();
    const prepared = await harness.handler.prepareDelivery(
      harness.request({ mode: "prepare" }),
    );
    const approvalId =
      prepared.body.status === "AUTHORIZED"
        ? prepared.body.deliveryApprovalId
        : "";
    const deniedRequests = [
      harness.request({ mode: "execute", sessionCredential: null }),
      harness.request({ mode: "execute", sessionCredential: "malformed" }),
      harness.request({ csrfHeader: "bad", mode: "execute" }),
      harness.request({ mode: "execute", origin: "https://evil.example.test" }),
      harness.request({
        deliveryApprovalId: approvalId,
        deliveryCapability: "wrong-wrong-wrong-wrong-wrong-wrong-wrong-wrong",
        mode: "execute",
      }),
      harness.request({
        body: {
          ...harness.baseBody(),
          customerId: "00000000-0000-4000-8000-000000000000",
          externalSupplierOrderId: "SYNTHETIC-SUPPLIER-ORDER",
        },
        mode: "execute",
      }),
    ];

    for (const request of deniedRequests) {
      const result = await harness.handler.executeDelivery(request);
      expect([400, 401, 403, 404, 409]).toContain(result.statusCode);
    }
    expect(harness.deliveryPort.calls).toHaveLength(0);
    expect(harness.keyProvider.unwraps).toBe(0);

    const wrongOwner = await deliveryHarness({ owner: "other" });
    await expect(
      wrongOwner.handler.prepareDelivery(
        wrongOwner.request({ mode: "prepare" }),
      ),
    ).resolves.toMatchObject({
      body: { code: "RESOURCE_NOT_AVAILABLE", status: "ERROR" },
      statusCode: 404,
    });
    expect(wrongOwner.deliveryPort.calls).toHaveLength(0);
    expect(wrongOwner.keyProvider.unwraps).toBe(0);
  });

  it("denies revoked, expired, idle-expired and missing-binding sessions", async () => {
    for (const mode of [
      "revoked",
      "expired",
      "idle",
      "missing-binding",
    ] as const) {
      const harness = await deliveryHarness({ sessionMode: mode });
      await expect(
        harness.handler.prepareDelivery(harness.request({ mode: "prepare" })),
      ).resolves.toMatchObject({
        body: { code: "AUTHENTICATION_REQUIRED", status: "ERROR" },
        statusCode: 401,
      });
      expect(harness.deliveryPort.calls).toHaveLength(0);
      expect(harness.keyProvider.unwraps).toBe(0);
    }
  });

  it("preserves replay and concurrent claim safety", async () => {
    const harness = await deliveryHarness();
    const prepared = await harness.handler.prepareDelivery(
      harness.request({ mode: "prepare" }),
    );
    const approvalId =
      prepared.body.status === "AUTHORIZED"
        ? prepared.body.deliveryApprovalId
        : "";
    const capability =
      prepared.body.status === "AUTHORIZED"
        ? prepared.body.deliveryCapability
        : "";

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        harness.handler.executeDelivery(
          harness.request({
            deliveryApprovalId: approvalId,
            deliveryCapability: capability,
            mode: "execute",
          }),
        ),
      ),
    );

    expect(results.filter((result) => result.statusCode === 200)).toHaveLength(
      1,
    );
    expect(harness.deliveryPort.calls).toHaveLength(1);
    expect(harness.keyProvider.unwraps).toBe(1);
    await expect(
      harness.handler.executeDelivery(
        harness.request({
          deliveryApprovalId: approvalId,
          deliveryCapability: capability,
          mode: "execute",
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 409 });
  });

  it("enforces rate limits and protected real fulfillment guard without decrypting", async () => {
    const limited = await deliveryHarness({ rateLimitMax: 1 });
    await limited.handler.prepareDelivery(limited.request({ mode: "prepare" }));
    await expect(
      limited.handler.prepareDelivery(limited.request({ mode: "prepare" })),
    ).resolves.toMatchObject({
      body: { code: "RATE_LIMITED", status: "ERROR" },
      statusCode: 429,
    });

    const protectedHarness = await deliveryHarness({
      fulfillmentId: realFulfillmentId,
      protectedFulfillmentIds: [realFulfillmentId],
    });
    await expect(
      protectedHarness.handler.prepareDelivery(
        protectedHarness.request({ mode: "prepare" }),
      ),
    ).resolves.toMatchObject({
      body: { code: "DELIVERY_NOT_AVAILABLE", status: "ERROR" },
      statusCode: 409,
    });
    expect(protectedHarness.deliveryPort.calls).toHaveLength(0);
    expect(protectedHarness.keyProvider.unwraps).toBe(0);
  });

  it("defines strict transport policy for session cookies, origin and csrf", () => {
    expect(authenticatedDeliveryCookiePolicy).toContain("HttpOnly");
    expect(authenticatedDeliveryCookiePolicy).toContain("Secure");
    expect(authenticatedDeliveryCookiePolicy).toContain("SameSite=Lax");
    expect(() =>
      new HmacDoubleSubmitCsrfPolicy("short").createToken("session"),
    ).toThrow("CSRF secret is too short");
    expect(parseAllowedOrigins("http://localhost:3000", "LOCAL")).toEqual([
      "http://localhost:3000",
    ]);
    expect(() =>
      parseAllowedOrigins("http://localhost:3000", "PRODUCTION"),
    ).toThrow("KEYCORE_CUSTOMER_ALLOWED_ORIGINS_INVALID");
    expect(() =>
      parseAllowedOrigins("http://example.com", "PRODUCTION"),
    ).toThrow("KEYCORE_CUSTOMER_ALLOWED_ORIGINS_INVALID");
    expect(
      parseAllowedOrigins("https://configured.example", "PRODUCTION"),
    ).toEqual(["https://configured.example"]);
    expect(() => parseAllowedOrigins("*", "PRODUCTION")).toThrow(
      "KEYCORE_CUSTOMER_ALLOWED_ORIGINS_INVALID",
    );
    expect(() => parseAllowedOrigins("not-an-origin", "PRODUCTION")).toThrow(
      "KEYCORE_CUSTOMER_ALLOWED_ORIGINS_INVALID",
    );
  });

  it("denies invalid origin and csrf before session resolution", async () => {
    const invalidOrigin = await deliveryHarness();
    await expect(
      invalidOrigin.handler.prepareDelivery(
        invalidOrigin.request({
          mode: "prepare",
          origin: "https://evil.example.test",
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
    expect(invalidOrigin.sessionService.resolveCalls).toBe(0);
    expect(invalidOrigin.keyProvider.unwraps).toBe(0);
    expect(invalidOrigin.deliveryPort.calls).toHaveLength(0);

    const invalidCsrf = await deliveryHarness();
    await expect(
      invalidCsrf.handler.prepareDelivery(
        invalidCsrf.request({ csrfHeader: "bad", mode: "prepare" }),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
    expect(invalidCsrf.sessionService.resolveCalls).toBe(0);
    expect(invalidCsrf.keyProvider.unwraps).toBe(0);
    expect(invalidCsrf.deliveryPort.calls).toHaveLength(0);
  });

  it("fails closed when csrf policy or rate limiter fails", async () => {
    const csrfFailure = await deliveryHarness({
      csrfPolicy: new ThrowingCsrfPolicy(),
    });
    await expect(
      csrfFailure.handler.prepareDelivery(
        csrfFailure.request({ mode: "prepare" }),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
    expect(csrfFailure.sessionService.resolveCalls).toBe(0);
    expect(csrfFailure.keyProvider.unwraps).toBe(0);
    expect(csrfFailure.deliveryPort.calls).toHaveLength(0);

    const limiterFailure = await deliveryHarness({
      rateLimiter: new ThrowingRateLimiter(),
    });
    await expect(
      limiterFailure.handler.prepareDelivery(
        limiterFailure.request({ mode: "prepare" }),
      ),
    ).resolves.toMatchObject({
      body: { code: "TEMPORARILY_UNAVAILABLE", status: "ERROR" },
      statusCode: 503,
    });
    expect(limiterFailure.keyProvider.unwraps).toBe(0);
    expect(limiterFailure.deliveryPort.calls).toHaveLength(0);
  });

  it("validates body length, json content type parameters and limiter key privacy", async () => {
    const capturedLimiter = new CapturingRateLimiter();
    const harness = await deliveryHarness({ rateLimiter: capturedLimiter });
    await expect(
      harness.handler.prepareDelivery(
        harness.request({ bodyByteLength: -1, mode: "prepare" }),
      ),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      harness.handler.prepareDelivery(
        harness.request({
          bodyByteLength: Number.MAX_SAFE_INTEGER + 1,
          mode: "prepare",
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      harness.handler.prepareDelivery(
        harness.request({ contentType: "text/plain", mode: "prepare" }),
      ),
    ).resolves.toMatchObject({ statusCode: 400 });

    await expect(
      harness.handler.prepareDelivery(
        harness.request({
          contentType: "application/json; charset=utf-8",
          mode: "prepare",
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 201 });
    expect(capturedLimiter.keys).toHaveLength(1);
    expect(capturedLimiter.keys[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(capturedLimiter.serialized()).not.toContain(
      harness.sessionCredential,
    );
  });
});

const deliveryHarness = async (
  options: {
    readonly owner?: "session" | "other";
    readonly sessionMode?:
      "valid" | "revoked" | "expired" | "idle" | "missing-binding";
    readonly rateLimitMax?: number;
    readonly fulfillmentId?: string;
    readonly protectedFulfillmentIds?: readonly string[];
    readonly environment?: "LOCAL" | "CI" | "STAGING" | "PRODUCTION";
    readonly allowedOrigins?: readonly string[];
    readonly csrfPolicy?: AuthenticatedCustomerDeliveryCsrfPolicy;
    readonly rateLimiter?: AuthenticatedCustomerDeliveryRateLimiter;
  } = {},
) => {
  const identityRepository = new InMemoryCustomerOrderIdentityRepository();
  const subject = `subject-${randomUUID()}`;
  const sessionCustomer = await createCustomer(identityRepository, subject);
  const otherCustomer = await createCustomer(
    identityRepository,
    `other-${randomUUID()}`,
  );
  const ownerCustomer =
    options.owner === "other"
      ? otherCustomer.customerId
      : sessionCustomer.customerId;
  const fulfillmentRepository = new InMemoryFulfillmentRepository();
  const deliveryRepository = new InMemoryCustomerKeyDeliveryRepository(
    fulfillmentRepository,
  );
  const order = orderId(randomUUID());
  identityRepository.addOrder({
    customerId: ownerCustomer,
    fulfillmentStatus: "PENDING",
    orderId: order,
    paymentStatus: "CAPTURED",
    procurementStatus: "SUCCEEDED",
    recordVersion: 1,
    status: "FULFILLMENT_PENDING",
    updatedAt: now,
  });
  const fulfillment = fulfillmentFixture(order, options.fulfillmentId);
  const keyProvider = new CountingKeyProvider("transport-mk-v1");
  const material = await encryptFulfillmentSecret(
    Buffer.from(syntheticKey, "utf8"),
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
    throw new Error("Expected retrieved fulfillment fixture");
  }
  identityRepository.addFulfillment({
    deliveryState: "PENDING",
    encryptedSecretId: retrieved.encryptedSecretId,
    fulfillmentId: fulfillment.id,
    orderId: order,
    retrievalState: "RETRIEVED",
    status: "DELIVERY_PENDING",
  });
  const authRepository = new InMemoryCustomerAuthSessionRepository({
    findCustomerById: (id) => identityRepository.findCustomerById(id),
    findIdentityBindingById: (id) =>
      identityRepository.findIdentityBindingById(id),
    findIdentityBindingByProviderSubject: (input) =>
      identityRepository.findIdentityBindingByProviderSubject(input),
  });
  let authNow = now;
  const sessionService = new InstrumentedCustomerAuthenticationService({
    authority: new FakeAuthenticationAuthority(
      assertion(subject, {
        expiresAt:
          options.sessionMode === "expired"
            ? new Date(now.getTime() + 1)
            : new Date(now.getTime() + 28_800_000),
      }),
    ),
    now: () => authNow,
    repository: authRepository,
  });
  const createdSession = await sessionService.createSession({
    correlationId: correlationId("transport-session-create"),
  });
  const sessionCredential = requireSessionToken(createdSession);
  if (options.sessionMode === "expired" || options.sessionMode === "idle") {
    authNow = new Date(now.getTime() + 28_800_001);
  }
  if (options.sessionMode === "revoked") {
    await sessionService.revokeSession({
      correlationId: correlationId("transport-session-revoke"),
      rawSessionToken: sessionCredential,
    });
  }
  if (options.sessionMode === "missing-binding") {
    identityRepository.removeIdentityBindingById(sessionCustomer.bindingId);
  }
  const csrf = new HmacDoubleSubmitCsrfPolicy(csrfSecret);
  const csrfToken = csrf.createToken(sessionCredential);
  const deliveryPort = new FakeDeliveryPort();
  const audit = new CapturingAudit();
  const principalProvider = new StaticAuthenticatedCustomerPrincipalProvider({
    authenticationContext: { assurance: "AUTHENTICATED", provider: "TEST" },
    customerId: sessionCustomer.customerId,
  });
  const deliveryService = new CustomerKeyDeliveryService({
    approvalTtlMs: 300_000,
    audit,
    deliveryLeaseStaleAfterMs: 60_000,
    deliveryPort,
    deliveryRepository,
    environment: "CI",
    fulfillmentRepository,
    keyManagementProvider: keyProvider,
    orderAuthorization: new PersistedCustomerOrderAuthorizationPort({
      principalProvider,
      repository: identityRepository,
    }),
    protectedFulfillmentIds: options.protectedFulfillmentIds ?? [],
    now: () => now,
  });
  const environment = options.environment ?? "CI";
  const rateLimiter =
    options.rateLimiter ??
    new InMemoryAuthenticatedDeliveryRateLimiter({
      max: options.rateLimitMax ?? 100,
      windowMs: 60_000,
    });
  const handler = new AuthenticatedCustomerDeliveryTransportHandler({
    audit,
    config: {
      allowedOrigins: options.allowedOrigins ?? [allowedOrigin],
      maxBodyBytes: 4096,
      rateLimitMax: options.rateLimitMax ?? 100,
      rateLimitWindowMs: 60_000,
    },
    csrfPolicy: options.csrfPolicy ?? csrf,
    deliveryService,
    environment,
    now: () => now,
    rateLimiter,
    sessionService,
  });
  return {
    audit,
    baseBody: () => ({
      fulfillmentReference: fulfillment.id,
      orderId: order,
    }),
    deliveryPort,
    fulfillment,
    handler,
    keyProvider,
    sessionCredential,
    sessionService,
    request: (input: {
      readonly mode: "prepare" | "execute";
      readonly sessionCredential?: string | null;
      readonly csrfHeader?: string | null;
      readonly origin?: string | null;
      readonly contentType?: string;
      readonly bodyByteLength?: number;
      readonly deliveryApprovalId?: string;
      readonly deliveryCapability?: string;
      readonly body?: AuthenticatedDeliveryTransportRequest["body"];
    }): AuthenticatedDeliveryTransportRequest => ({
      body:
        input.body ??
        (input.mode === "execute"
          ? {
              deliveryApprovalId: input.deliveryApprovalId ?? "approval",
              deliveryCapability: input.deliveryCapability ?? "missing",
              fulfillmentReference: fulfillment.id,
              orderId: order,
            }
          : { fulfillmentReference: fulfillment.id, orderId: order }),
      bodyByteLength: input.bodyByteLength ?? 256,
      contentType: input.contentType ?? "application/json",
      correlationIdHeader: "corr-transport",
      csrfCookie: csrfToken,
      csrfHeader: input.csrfHeader === undefined ? csrfToken : input.csrfHeader,
      method: "POST",
      origin: input.origin === undefined ? allowedOrigin : input.origin,
      remoteAddress: "203.0.113.9",
      sessionCredential:
        input.sessionCredential === undefined
          ? sessionCredential
          : input.sessionCredential,
    }),
  };
};

const createCustomer = async (
  repository: InMemoryCustomerOrderIdentityRepository,
  providerSubject: string,
) => {
  const service = new CustomerOrderIdentityService({
    emailVerificationAuthority: new FakeEmailVerificationAuthority(),
    identityBindingAuthority: new FakeIdentityBindingAuthority(providerSubject),
    now: () => now,
    orderOwnershipAuthority: new FakeOrderOwnershipAuthority(),
    repository,
  });
  const created = await service.createCustomer({
    correlationId: correlationId(`corr-customer-${providerSubject}`),
    email: `${providerSubject}@example.com`,
  });
  if (!("customer" in created)) {
    throw new Error("Expected customer fixture");
  }
  await service.markEmailVerified({
    correlationId: correlationId(`corr-verify-${providerSubject}`),
    customerId: created.customer.id,
    expectedCustomerVersion: 1,
  });
  const binding = await service.bindIdentity({
    correlationId: correlationId(`corr-bind-${providerSubject}`),
    customerId: created.customer.id,
  });
  if (!("binding" in binding)) {
    throw new Error("Expected binding fixture");
  }
  return { bindingId: binding.binding.id, customerId: created.customer.id };
};

const fulfillmentFixture = (
  fixtureOrderId: OrderId,
  id: string = randomUUID(),
): FulfillmentOperation => ({
  approvalExpiresAt: new Date(now.getTime() + 300_000),
  controlledProcurementApprovalId: null,
  correlationId: correlationId("transport-fulfillment"),
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
  supplierItemReference: productId(randomUUID()),
  tokenHash: "a".repeat(64),
  updatedAt: now,
});

const assertion = (
  providerSubject: string,
  overrides: Partial<VerifiedCustomerAuthenticationAssertion> = {},
): VerifiedCustomerAuthenticationAssertion => ({
  assurance: "AUTHENTICATED",
  authContextId: `transport-auth-${providerSubject.slice(0, 8)}`,
  authenticatedAt: now,
  expiresAt: new Date(now.getTime() + 28_800_000),
  provider: "TEST",
  providerSubject,
  ...overrides,
});

class FakeAuthenticationAuthority implements CustomerAuthenticationAuthorityPort {
  public constructor(
    private readonly authAssertion: VerifiedCustomerAuthenticationAssertion,
  ) {}

  public async verifiedAuthenticationAssertion() {
    return { assertion: this.authAssertion, status: "AUTHORIZED" as const };
  }
}

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

class FakeOrderOwnershipAuthority implements OrderOwnershipBindingAuthorityPort {
  public async verifiedOrderOwnership(input: {
    readonly orderId: OrderId;
    readonly customerId: CustomerId;
    readonly correlationId: CorrelationId;
  }) {
    return {
      actorId: `owner:${input.customerId}:${input.orderId}`,
      actorType: "SERVICE" as const,
      providerEvidenceId: `ownership:${input.correlationId}`,
      status: "AUTHORIZED" as const,
    };
  }
}

class FakeDeliveryPort implements CustomerKeyDeliveryPort {
  public readonly calls: CustomerDeliveryAuthorization[] = [];
  public lastPlaintextSeen: string | null = null;

  public constructor(private readonly failure?: CustomerKeyDeliveryError) {}

  public async deliver(input: {
    readonly authorization: CustomerDeliveryAuthorization;
    readonly plaintext: Buffer;
  }): Promise<CustomerKeyDeliveryPortResult> {
    this.calls.push(input.authorization);
    this.lastPlaintextSeen = input.plaintext.toString("utf8");
    if (this.failure) {
      throw this.failure;
    }
    return {
      channel: "FAKE",
      deliveredAt: now,
      deliveryReference: `transport-delivery-${this.calls.length}`,
      status: "DELIVERED",
    };
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
      throw new Error("wrong transport key");
    }
    return Buffer.from(request.wrappedDataKey).map((byte) => byte ^ 0xa5);
  }

  public async getKeyVersionMetadata() {
    return { provider: "memory", version: this.keyId };
  }
}

class CapturingAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class InstrumentedCustomerAuthenticationService extends CustomerAuthenticationService {
  public resolveCalls = 0;

  public override async resolveSession(
    input: Parameters<CustomerAuthenticationService["resolveSession"]>[0],
  ): ReturnType<CustomerAuthenticationService["resolveSession"]> {
    this.resolveCalls += 1;
    return super.resolveSession(input);
  }
}

class ThrowingCsrfPolicy implements AuthenticatedCustomerDeliveryCsrfPolicy {
  public validate(): never {
    throw new Error("synthetic csrf outage");
  }
}

class ThrowingRateLimiter implements AuthenticatedCustomerDeliveryRateLimiter {
  public async check(): Promise<never> {
    throw new Error("synthetic limiter outage");
  }
}

class CapturingRateLimiter implements AuthenticatedCustomerDeliveryRateLimiter {
  public readonly keys: string[] = [];

  public async check(input: {
    readonly key: string;
    readonly now: Date;
  }): Promise<{ readonly status: "ALLOWED" }> {
    this.keys.push(input.key);
    return { status: "ALLOWED" };
  }

  public serialized(): string {
    return JSON.stringify(this.keys);
  }
}

const requireSessionToken = (
  result: Awaited<ReturnType<CustomerAuthenticationService["createSession"]>>,
): string => {
  if (result.status !== "CREATED") {
    throw new Error("Expected session fixture");
  }
  return result.rawSessionToken;
};
