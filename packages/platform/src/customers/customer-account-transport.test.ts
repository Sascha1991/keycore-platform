import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { InMemoryCustomerAccountReadRepository } from "../../../../infra/customers/in-memory-customer-account-repository.js";
import { InMemoryCustomerAuthSessionRepository } from "../../../../infra/customers/in-memory-customer-authentication-repository.js";
import { InMemoryCustomerOrderIdentityRepository } from "../../../../infra/customers/in-memory-customer-order-identity-repository.js";
import { InMemoryCustomerRegistrationChallengeRepository } from "../../../../infra/customers/in-memory-customer-registration-repository.js";
import {
  CustomerAccountService,
  CustomerAccountTransportHandler,
  type CustomerAccountTransportRequest,
  CustomerAuthenticationService,
  CustomerOrderIdentityService,
  CustomerRegistrationService,
  FakeCustomerEmailVerificationDeliveryPort,
  HmacDoubleSubmitCsrfPolicy,
  InMemoryAuthenticatedDeliveryRateLimiter,
  correlationId,
  currency,
  customerAccountTransportCookiePolicy,
  customerId,
  money,
  orderId,
  woocommerceCustomerAccountTrustBoundary,
  type AuditEvent,
  type AuditEventPort,
  type AuthenticatedCustomerDeliveryRateLimiter,
  type CorrelationId,
  type CustomerAccountOrderProjection,
  type CustomerAuthenticationAuthorityPort,
  type CustomerId,
  type CustomerIdentityBindingAuthorityPort,
  type CustomerIdentityProvider,
  type EmailVerificationAuthorityPort,
  type OrderId,
  type VerifiedCustomerAuthenticationAssertion,
} from "../contracts.js";

const now = new Date("2026-08-26T09:00:00.000Z");
const allowedOrigin = "https://account.example.test";
const csrfSecret = "customer-account-csrf-fixture-secret-32";
const cursorSigningSecret = "customer-account-transport-cursor-secret-32";
const verificationToken =
  "CUSTOMER_ACCOUNT_TRANSPORT_TOKEN_01234567890123456789";
const realFulfillmentId = "fd61be5e-44ea-4914-98ae-c4404dc31779";

describe("CustomerAccountTransportHandler", () => {
  it("resolves session to principal and returns account summary, owned history and safe order detail", async () => {
    const harness = await transportHarness();

    const summary = await harness.handler.getAccountSummary(
      harness.request("GET", { route: "summary" }),
    );
    const history = await harness.handler.listOwnedOrders(
      harness.request("GET", {
        query: { limit: "2" },
        route: "history",
      }),
    );
    const detailRequest = harness.request("GET", {
      path: { orderId: String(harness.ownedOrder) },
      route: "detail",
    });
    const detail = await harness.handler.getOwnedOrderDetail(detailRequest);

    expect(summary).toMatchObject({
      body: {
        account: {
          customerId: harness.customerId,
          emailMasked: "b******@example.test",
        },
        apiVersion: "v1",
        status: "OK",
      },
      headers: { "Cache-Control": "private, no-store" },
      statusCode: 200,
    });
    expect(history.statusCode).toBe(200);
    expect(detail).toMatchObject({
      body: {
        order: {
          fulfillment: {
            hasEncryptedSecret: true,
            keyAccessAvailable: true,
            status: "KEY_AVAILABLE",
          },
          orderId: harness.ownedOrder,
        },
        status: "OK",
      },
      statusCode: 200,
    });
    expect(safeJson([summary, history, detail])).not.toMatch(
      /providerSubject|sessionCredential|supplier|GE1373B866F3|TEST-AAAAA-BBBBB-CCCCC/iu,
    );
    expect(harness.accountRepository.detailCalls).toBe(1);
    expect(harness.deliveryCalls).toBe(0);
    expect(harness.decryptCalls).toBe(0);
  });

  it("denies missing, malformed, expired and revoked sessions without account reads", async () => {
    for (const mode of [
      "missing",
      "malformed",
      "expired",
      "revoked",
    ] as const) {
      const harness = await transportHarness({ sessionMode: mode });
      const response = await harness.handler.getAccountSummary(
        harness.request("GET", { route: `session-${mode}` }),
      );

      expect(response).toMatchObject({
        body: { code: "AUTHENTICATION_REQUIRED", status: "ERROR" },
        statusCode: 401,
      });
      expect(harness.accountRepository.summaryCalls).toBe(0);
    }
  });

  it("rejects invalid reads and forged authority fields before session resolution", async () => {
    const harness = await transportHarness();
    const invalids = [
      harness.request("POST", { route: "bad-method" }),
      harness.request("GET", { body: { customerId: harness.otherCustomerId } }),
      harness.request("GET", { body: { supplierOrderId: "GE1373B866F3" } }),
      harness.request("GET", { bodyByteLength: 1 }),
      harness.request("GET", { origin: "https://evil.example.test" }),
    ];

    for (const request of invalids) {
      const response = await harness.handler.getAccountSummary(request);
      expect(response.statusCode).toBe(400);
    }
    await expect(
      harness.handler.listOwnedOrders(
        harness.request("GET", { query: { limit: "0" }, route: "bad-limit" }),
      ),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      harness.handler.getOwnedOrderDetail(
        harness.request("GET", {
          path: { orderId: "not-a-uuid" },
          route: "bad-order",
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 400 });
    expect(harness.sessionService.resolveCalls).toBe(0);
    expect(harness.accountRepository.summaryCalls).toBe(0);
  });

  it("keeps wrong-owner, unknown and legacy real fulfillment unavailable and never reveals keys", async () => {
    const harness = await transportHarness();
    const responses = await Promise.all([
      harness.handler.getOwnedOrderDetail(
        harness.request("GET", {
          path: { orderId: String(harness.wrongOwnerOrder) },
          route: "wrong-owner",
        }),
      ),
      harness.handler.getOwnedOrderDetail(
        harness.request("GET", {
          path: { orderId: String(randomUUID()) },
          route: "unknown",
        }),
      ),
      harness.handler.getOwnedOrderDetail(
        harness.request("GET", {
          path: { orderId: String(harness.legacyRealOrder) },
          route: "legacy-real",
        }),
      ),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      404, 404, 404,
    ]);
    expect(
      responses.map((response) =>
        response.body.status === "ERROR" ? response.body.code : "unexpected",
      ),
    ).toEqual([
      "RESOURCE_NOT_AVAILABLE",
      "RESOURCE_NOT_AVAILABLE",
      "RESOURCE_NOT_AVAILABLE",
    ]);
    expect(
      harness.accountRepository.fulfillmentSnapshot(realFulfillmentId),
    ).toMatchObject({
      deliveredAt: null,
      deliveryState: "PENDING",
      fulfillmentId: realFulfillmentId,
      orderId: null,
      retrievalState: "RETRIEVED",
    });
    expect(harness.decryptCalls).toBe(0);
    expect(harness.deliveryCalls).toBe(0);
  });

  it("accepts registration with enumeration-safe response and creates no session", async () => {
    const harness = await transportHarness();

    const first = await harness.handler.register(
      harness.request("POST", { body: { email: "new@example.test" } }),
    );
    const existing = await harness.handler.register(
      harness.request("POST", { body: { email: "new@example.test" } }),
    );

    expect(first).toMatchObject({
      body: { status: "REGISTRATION_ACCEPTED" },
      statusCode: 202,
    });
    expect(existing).toMatchObject({
      body: { status: "REGISTRATION_ACCEPTED" },
      statusCode: 202,
    });
    expect(safeJson([first, existing])).not.toMatch(
      /customerId|existing|session/iu,
    );
    expect(harness.delivery.deliveries).toHaveLength(2);
    expect(harness.sessionService.createdSessionCount).toBe(1);
  });

  it("maps registration limiter and delivery failures safely", async () => {
    const limited = await transportHarness({
      rateLimiter: new AlwaysLimitedRateLimiter(),
    });
    await expect(
      limited.handler.register(
        limited.request("POST", { body: { email: "limited@example.test" } }),
      ),
    ).resolves.toMatchObject({
      body: { code: "RATE_LIMITED", status: "ERROR" },
      statusCode: 429,
    });

    const unavailable = await transportHarness({
      rateLimiter: new ThrowingRateLimiter(),
    });
    await expect(
      unavailable.handler.register(
        unavailable.request("POST", {
          body: { email: "unavailable@example.test" },
        }),
      ),
    ).resolves.toMatchObject({
      body: { code: "TEMPORARILY_UNAVAILABLE", status: "ERROR" },
      statusCode: 503,
    });
  });

  it("verifies email by secret POST token without echoing or auditing token values", async () => {
    const harness = await transportHarness({
      registrationTokenFactory: () => verificationToken,
    });
    await harness.handler.register(
      harness.request("POST", { body: { email: "verify@example.test" } }),
    );
    const verified = await harness.handler.verifyEmail(
      harness.request("POST", {
        body: { verificationToken },
        route: "verify",
      }),
    );
    const invalid = await harness.handler.verifyEmail(
      harness.request("POST", {
        body: { verificationToken },
        route: "verify-consumed",
      }),
    );

    expect(verified).toMatchObject({
      body: { status: "VERIFIED" },
      headers: { "Referrer-Policy": "no-referrer" },
      statusCode: 200,
    });
    expect(invalid).toMatchObject({
      body: { status: "VERIFICATION_INVALID" },
      statusCode: 400,
    });
    expect(safeJson([verified, invalid, harness.audit.events])).not.toContain(
      verificationToken,
    );
  });

  it("links identity only through authenticated verified principal and trusted adapter evidence", async () => {
    const harness = await transportHarness({
      identitySubjectForLinking: "trusted-link-subject",
    });

    await expect(
      harness.handler.linkIdentity(
        harness.request("POST", { body: {}, route: "link" }),
      ),
    ).resolves.toMatchObject({ body: { status: "BOUND" }, statusCode: 200 });
    await expect(
      harness.handler.linkIdentity(
        harness.request("POST", {
          body: { providerSubject: "raw-forged-subject" },
          route: "raw-provider",
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 400 });

    const missing = await transportHarness({ sessionMode: "missing" });
    await expect(
      missing.handler.linkIdentity(
        missing.request("POST", { body: {}, route: "missing-link" }),
      ),
    ).resolves.toMatchObject({ statusCode: 401 });

    const unverified = await transportHarness({ verifiedCustomer: false });
    await expect(
      unverified.handler.linkIdentity(
        unverified.request("POST", { body: {}, route: "unverified-link" }),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
  });

  it("does not trust WooCommerce email-only input for authentication, linking, claiming or account access", async () => {
    const harness = await transportHarness({ sessionMode: "missing" });
    const wooInput = {
      customerId: harness.customerId,
      email: "buyer@example.test",
      providerSubject: "woocommerce-user-123",
    };

    await expect(
      harness.handler.getAccountSummary(
        harness.request("GET", { body: wooInput, route: "woo-summary" }),
      ),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      harness.handler.linkIdentity(
        harness.request("POST", { body: wooInput, route: "woo-link" }),
      ),
    ).resolves.toMatchObject({ statusCode: 400 });
    expect(woocommerceCustomerAccountTrustBoundary).toEqual({
      emailOnlyAuthentication: "DENIED",
      emailOnlyIdentityLinking: "DENIED",
      emailOnlyOrderClaim: "DENIED",
      sourceOfTruth: "KEYCORE",
    });
    expect(harness.accountRepository.summaryCalls).toBe(0);
    expect(harness.identityRepository.orderOwnershipBindingCount).toBe(0);
  });

  it("defines secure browser cookie and explicit production origin policy", () => {
    expect(customerAccountTransportCookiePolicy).toContain("HttpOnly");
    expect(customerAccountTransportCookiePolicy).toContain("Secure");
    expect(customerAccountTransportCookiePolicy).toContain("SameSite=Lax");
    expect(customerAccountTransportCookiePolicy).toContain("Path=/");
    expect(
      () =>
        new CustomerAccountTransportHandler({
          ...handlerOptionsFixture(),
          config: { allowedOrigins: ["*"], maxBodyBytes: 4096 },
          environment: "PRODUCTION",
        }),
    ).toThrow("origin is invalid");
  });
});

const transportHarness = async (
  options: {
    readonly sessionMode?:
      "valid" | "missing" | "malformed" | "expired" | "revoked";
    readonly verifiedCustomer?: boolean;
    readonly identitySubjectForLinking?: string;
    readonly registrationTokenFactory?: () => string;
    readonly rateLimiter?: AuthenticatedCustomerDeliveryRateLimiter;
  } = {},
) => {
  const audit = new CapturingAudit();
  const identityRepository = new CountingCustomerOrderIdentityRepository();
  const accountRepository = new CountingCustomerAccountReadRepository();
  const subject = `subject-${randomUUID()}`;
  const otherSubject = `other-${randomUUID()}`;
  const created = await createCustomer(identityRepository, subject, {
    verified: options.verifiedCustomer !== false,
  });
  const other = await createCustomer(identityRepository, otherSubject, {
    verified: true,
  });
  accountRepository.addAccount({
    createdAt: now,
    customerId: created.customerId,
    emailMasked: "b******@example.test",
    emailVerificationState:
      options.verifiedCustomer === false ? "UNVERIFIED" : "VERIFIED",
  });
  const ownedOrder = orderId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
  const wrongOwnerOrder = orderId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const legacyRealOrder = orderId("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  accountRepository.addOrder(
    orderFixture(created.customerId, ownedOrder, {
      fulfillment: fulfillmentFixture(
        "ffffffff-ffff-4fff-8fff-fffffffffff1",
        ownedOrder,
      ),
    }),
  );
  accountRepository.addOrder(
    orderFixture(other.customerId, wrongOwnerOrder, {}),
  );
  accountRepository.addOrder(
    orderFixture(
      customerId("33333333-3333-4333-8333-333333333333"),
      legacyRealOrder,
      {
        fulfillment: fulfillmentFixture(realFulfillmentId, null),
      },
    ),
  );

  const authRepository = new InMemoryCustomerAuthSessionRepository({
    findCustomerById: (id) => identityRepository.findCustomerById(id),
    findIdentityBindingById: (id) =>
      identityRepository.findIdentityBindingById(id),
    findIdentityBindingByProviderSubject: (input) =>
      identityRepository.findIdentityBindingByProviderSubject(input),
  });
  let authNow = now;
  const sessionService = new InstrumentedCustomerAuthenticationService({
    authority: new FakeAuthenticationAuthority(assertion(subject)),
    now: () => authNow,
    repository: authRepository,
  });
  const createdSession = await sessionService.createSession({
    correlationId: correlationId("customer-account-transport-session"),
  });
  const sessionToken =
    createdSession.status === "CREATED" ? createdSession.rawSessionToken : "";
  if (options.sessionMode === "expired") {
    authNow = new Date(now.getTime() + 28_800_001);
  }
  if (options.sessionMode === "revoked") {
    await sessionService.revokeSession({
      correlationId: correlationId("customer-account-transport-revoke"),
      rawSessionToken: sessionToken,
    });
  }
  const csrf = new HmacDoubleSubmitCsrfPolicy(csrfSecret);
  const csrfToken = csrf.createToken(sessionToken);
  const delivery = new FakeCustomerEmailVerificationDeliveryPort();
  const registrationService = new CustomerRegistrationService({
    audit,
    challengeRepository: new InMemoryCustomerRegistrationChallengeRepository(
      identityRepository,
    ),
    delivery,
    identityBindingAuthority: new FakeIdentityAuthority(
      options.identitySubjectForLinking ?? `link-${randomUUID()}`,
    ),
    identityRepository,
    identityService: new CustomerOrderIdentityService({
      audit,
      now: () => now,
      repository: identityRepository,
    }),
    now: () => now,
    ...(options.registrationTokenFactory
      ? { tokenFactory: options.registrationTokenFactory }
      : {}),
  });
  const handler = new CustomerAccountTransportHandler({
    accountService: new CustomerAccountService({
      audit,
      cursorSigningSecret,
      environment: "CI",
      now: () => now,
      repository: accountRepository,
    }),
    config: { allowedOrigins: [allowedOrigin], maxBodyBytes: 4096 },
    csrfPolicy: csrf,
    environment: "CI",
    now: () => now,
    rateLimiter:
      options.rateLimiter ??
      new InMemoryAuthenticatedDeliveryRateLimiter({
        max: 100,
        windowMs: 60_000,
      }),
    registrationService,
    sessionService,
  });
  return {
    accountRepository,
    audit,
    customerId: created.customerId,
    decryptCalls: 0,
    delivery,
    deliveryCalls: 0,
    handler,
    identityRepository,
    legacyRealOrder,
    otherCustomerId: other.customerId,
    ownedOrder,
    sessionService,
    wrongOwnerOrder,
    request: (
      method: "GET" | "POST",
      input: {
        readonly route?: string;
        readonly body?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly path?: Readonly<Record<string, string>>;
        readonly bodyByteLength?: number;
        readonly origin?: string | null;
      } = {},
    ): CustomerAccountTransportRequest => ({
      bodyByteLength:
        input.bodyByteLength ??
        (method === "GET" ? 0 : safeJson(input.body ?? {}).length),
      correlationIdHeader: `corr-${input.route ?? method.toLowerCase()}`,
      csrfCookie: csrfToken,
      csrfHeader: csrfToken,
      method,
      origin: input.origin === undefined ? allowedOrigin : input.origin,
      remoteAddress: "203.0.113.11",
      sessionCredential:
        options.sessionMode === "missing"
          ? null
          : options.sessionMode === "malformed"
            ? "not a session"
            : sessionToken,
      ...(input.body ? { body: input.body } : {}),
      ...(method === "POST" ? { contentType: "application/json" } : {}),
      ...(input.path ? { path: input.path } : {}),
      ...(input.query ? { query: input.query } : {}),
    }),
  };
};

const handlerOptionsFixture = () => {
  const identityRepository = new InMemoryCustomerOrderIdentityRepository();
  const sessionService = new CustomerAuthenticationService({
    repository: new InMemoryCustomerAuthSessionRepository({
      findCustomerById: (id) => identityRepository.findCustomerById(id),
      findIdentityBindingById: (id) =>
        identityRepository.findIdentityBindingById(id),
      findIdentityBindingByProviderSubject: (input) =>
        identityRepository.findIdentityBindingByProviderSubject(input),
    }),
  });
  const accountRepository = new InMemoryCustomerAccountReadRepository();
  const identityService = new CustomerOrderIdentityService({
    repository: identityRepository,
  });
  return {
    accountService: new CustomerAccountService({
      cursorSigningSecret,
      repository: accountRepository,
    }),
    csrfPolicy: new HmacDoubleSubmitCsrfPolicy(csrfSecret),
    rateLimiter: new InMemoryAuthenticatedDeliveryRateLimiter({
      max: 1,
      windowMs: 60_000,
    }),
    registrationService: new CustomerRegistrationService({
      challengeRepository: new InMemoryCustomerRegistrationChallengeRepository(
        identityRepository,
      ),
      delivery: new FakeCustomerEmailVerificationDeliveryPort(),
      identityRepository,
      identityService,
    }),
    sessionService,
  };
};

const createCustomer = async (
  repository: InMemoryCustomerOrderIdentityRepository,
  providerSubject: string,
  options: { readonly verified: boolean },
): Promise<{ readonly customerId: CustomerId }> => {
  const service = new CustomerOrderIdentityService({
    emailVerificationAuthority: new FakeEmailVerificationAuthority(),
    identityBindingAuthority: new FakeIdentityAuthority(providerSubject),
    now: () => now,
    repository,
  });
  const created = await service.createCustomer({
    correlationId: correlationId(`create-${providerSubject}`),
    email: `${providerSubject}@example.test`,
  });
  if (!("customer" in created)) {
    throw new Error("Expected customer fixture");
  }
  if (options.verified) {
    await service.markEmailVerified({
      correlationId: correlationId(`verify-${providerSubject}`),
      customerId: created.customer.id,
      expectedCustomerVersion: 1,
    });
  }
  await service.bindIdentity({
    correlationId: correlationId(`bind-${providerSubject}`),
    customerId: created.customer.id,
  });
  return { customerId: created.customer.id };
};

const orderFixture = (
  owner: CustomerId,
  fixtureOrderId: OrderId,
  options: {
    readonly fulfillment?: CustomerAccountOrderProjection["fulfillment"];
  },
): CustomerAccountOrderProjection => ({
  createdAt: now,
  currency: currency("EUR"),
  customerId: owner,
  fulfillment: options.fulfillment ?? null,
  fulfillmentStatus: "PENDING",
  invoice: null,
  activation: null,
  orderId: fixtureOrderId,
  paymentStatus: "CAPTURED",
  procurementStatus: "SUCCEEDED",
  productTitle: "Synthetic Account Transport Product",
  refundStatus: "NOT_REQUESTED",
  status: "FULFILLMENT_PENDING",
  total: money(1299n, currency("EUR")),
  updatedAt: now,
});

const fulfillmentFixture = (
  fulfillmentId: string,
  fixtureOrderId: OrderId | null,
): NonNullable<CustomerAccountOrderProjection["fulfillment"]> => ({
  deliveredAt: null,
  deliveryState: "PENDING",
  fulfillmentId,
  hasEncryptedSecret: true,
  orderId: fixtureOrderId,
  retrievedAt: now,
  retrievalState: "RETRIEVED",
  status: "DELIVERY_PENDING",
});

const assertion = (
  providerSubject: string,
): VerifiedCustomerAuthenticationAssertion => ({
  assurance: "AUTHENTICATED",
  authContextId: `account-transport-${providerSubject.slice(0, 8)}`,
  authenticatedAt: now,
  expiresAt: new Date(now.getTime() + 28_800_000),
  provider: "TEST",
  providerSubject,
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

class FakeIdentityAuthority implements CustomerIdentityBindingAuthorityPort {
  public constructor(private readonly providerSubject: string) {}

  public async verifiedIdentitySubject() {
    return {
      provider: "TEST" as CustomerIdentityProvider,
      providerEvidenceId: `identity:${this.providerSubject}`,
      providerSubject: this.providerSubject,
      status: "AUTHORIZED" as const,
    };
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
  public createdSessionCount = 0;

  public override async createSession(
    input: Parameters<CustomerAuthenticationService["createSession"]>[0],
  ): ReturnType<CustomerAuthenticationService["createSession"]> {
    this.createdSessionCount += 1;
    return super.createSession(input);
  }

  public override async resolveSession(
    input: Parameters<CustomerAuthenticationService["resolveSession"]>[0],
  ): ReturnType<CustomerAuthenticationService["resolveSession"]> {
    this.resolveCalls += 1;
    return super.resolveSession(input);
  }
}

class CountingCustomerAccountReadRepository extends InMemoryCustomerAccountReadRepository {
  public summaryCalls = 0;
  public detailCalls = 0;
  private readonly fulfillments = new Map<
    string,
    NonNullable<CustomerAccountOrderProjection["fulfillment"]>
  >();

  public override addOrder(order: CustomerAccountOrderProjection): void {
    super.addOrder(order);
    if (order.fulfillment) {
      this.fulfillments.set(order.fulfillment.fulfillmentId, order.fulfillment);
    }
  }

  public override async findAccountSummary(
    input: Parameters<
      InMemoryCustomerAccountReadRepository["findAccountSummary"]
    >[0],
  ): ReturnType<InMemoryCustomerAccountReadRepository["findAccountSummary"]> {
    this.summaryCalls += 1;
    return super.findAccountSummary(input);
  }

  public override async findOwnedOrderDetail(
    input: Parameters<
      InMemoryCustomerAccountReadRepository["findOwnedOrderDetail"]
    >[0],
  ): ReturnType<InMemoryCustomerAccountReadRepository["findOwnedOrderDetail"]> {
    this.detailCalls += 1;
    return super.findOwnedOrderDetail(input);
  }

  public fulfillmentSnapshot(fulfillmentId: string) {
    return this.fulfillments.get(fulfillmentId) ?? null;
  }
}

class CountingCustomerOrderIdentityRepository extends InMemoryCustomerOrderIdentityRepository {
  public orderOwnershipBindingCount = 0;

  public override async bindOrderOwnership(
    input: Parameters<
      InMemoryCustomerOrderIdentityRepository["bindOrderOwnership"]
    >[0],
  ): ReturnType<InMemoryCustomerOrderIdentityRepository["bindOrderOwnership"]> {
    this.orderOwnershipBindingCount += 1;
    return super.bindOrderOwnership(input);
  }
}

class AlwaysLimitedRateLimiter implements AuthenticatedCustomerDeliveryRateLimiter {
  public async check(): Promise<{ readonly status: "LIMITED" }> {
    return { status: "LIMITED" };
  }
}

class ThrowingRateLimiter implements AuthenticatedCustomerDeliveryRateLimiter {
  public async check(): Promise<never> {
    throw new Error("synthetic limiter outage");
  }
}

const safeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, child) =>
    typeof child === "bigint" ? child.toString() : child,
  );
