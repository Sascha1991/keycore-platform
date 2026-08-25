import { describe, expect, it } from "vitest";

import { InMemoryCustomerAuthSessionRepository } from "../../../../infra/customers/in-memory-customer-authentication-repository.js";
import { InMemoryCustomerOrderIdentityRepository } from "../../../../infra/customers/in-memory-customer-order-identity-repository.js";
import {
  CustomerAuthenticationService,
  CustomerOrderIdentityService,
  CustomerSessionPrincipalProvider,
  PersistedCustomerOrderAuthorizationPort,
  correlationId,
  generateCustomerSessionToken,
  hashCustomerSessionToken,
  orderId,
  type AuditEventPort,
  type CorrelationId,
  type CustomerAuthenticationAuthorityPort,
  type CustomerId,
  type CustomerIdentityBinding,
  type CustomerIdentityBindingAuthorityPort,
  type EmailVerificationAuthorityPort,
  type OrderId,
  type OrderOwnershipBindingAuthorityPort,
  type VerifiedCustomerAuthenticationAssertion,
} from "../contracts.js";

const baseNow = new Date("2026-08-25T10:00:00.000Z");

describe("CustomerAuthenticationService", () => {
  it("creates a production principal only from a trusted assertion and bound identity", async () => {
    const fixture = await createVerifiedFixture("auth-subject-1");
    const audit = new CapturingAudit();
    const auth = authService(fixture, {
      assertion: assertion("auth-subject-1"),
      audit,
    });

    const created = await auth.createSession({
      correlationId: correlationId("corr-auth-create"),
    });

    expect(created).toMatchObject({
      customerId: fixture.customerId,
      status: "CREATED",
    });
    expect(
      created.status === "CREATED" && created.rawSessionToken,
    ).toHaveLength(43);
    expect(audit.serializedEvents()).not.toMatch(
      /sessionToken|token|hash|auth-subject-1|Owner@example/iu,
    );

    const resolved = await auth.resolveSession({
      correlationId: correlationId("corr-auth-resolve"),
      rawSessionToken:
        created.status === "CREATED" ? created.rawSessionToken : "",
    });
    expect(resolved).toMatchObject({
      principal: {
        authenticationContext: {
          assurance: "AUTHENTICATED",
          provider: "TEST",
        },
        customerId: fixture.customerId,
      },
      status: "AUTHENTICATED",
    });
  });

  it("fails closed for untrusted, email-only, request-customer and unbound authentication attempts", async () => {
    const fixture = await createVerifiedFixture("bound-subject");
    await expect(
      authService(fixture, { denied: true }).createSession({
        correlationId: correlationId("corr-auth-denied"),
      }),
    ).resolves.toMatchObject({ status: "AUTHENTICATION_FAILED" });
    await expect(
      authService(fixture, {
        assertion: assertion("missing-binding"),
      }).createSession({ correlationId: correlationId("corr-auth-unbound") }),
    ).resolves.toEqual({ status: "IDENTITY_UNBOUND" });
    await expect(
      authService(fixture, {
        assertion: {
          ...assertion("bound-subject"),
          assurance: "TEST",
        },
      }).createSession({ correlationId: correlationId("corr-auth-test") }),
    ).resolves.toEqual({ status: "INVALID_AUTHENTICATION_CONTEXT" });
    await expect(
      authService(fixture, {
        assertion: {
          ...assertion("Owner@example.com"),
          authContextId: "email-only",
        },
      }).createSession({ correlationId: correlationId("corr-auth-email") }),
    ).resolves.toEqual({ status: "IDENTITY_UNBOUND" });
  });

  it("resolves invalid, expired, idle and revoked tokens with stable invalid semantics", async () => {
    let now = baseNow;
    const fixture = await createVerifiedFixture("auth-subject-2");
    const auth = authService(fixture, {
      assertion: assertion("auth-subject-2", {
        expiresAt: new Date(baseNow.getTime() + 10_000),
      }),
      now: () => now,
    });
    const created = await auth.createSession({
      correlationId: correlationId("corr-auth-states"),
    });
    const token = requireToken(created);

    await expect(
      auth.resolveSession({
        correlationId: correlationId("corr-auth-malformed"),
        rawSessionToken: "not a token",
      }),
    ).resolves.toEqual({ reasonCode: "SESSION_INVALID", status: "INVALID" });

    now = new Date(baseNow.getTime() + 11_000);
    await expect(
      auth.resolveSession({
        correlationId: correlationId("corr-auth-expired"),
        rawSessionToken: token,
      }),
    ).resolves.toEqual({ reasonCode: "SESSION_EXPIRED", status: "EXPIRED" });

    now = baseNow;
    const idleAuth = authService(fixture, {
      assertion: assertion("auth-subject-2"),
      now: () => now,
    });
    const idle = await idleAuth.createSession({
      correlationId: correlationId("corr-auth-idle-create"),
    });
    now = new Date(baseNow.getTime() + 3_600_001);
    await expect(
      idleAuth.resolveSession({
        correlationId: correlationId("corr-auth-idle"),
        rawSessionToken: requireToken(idle),
      }),
    ).resolves.toEqual({
      reasonCode: "SESSION_IDLE_TIMEOUT",
      status: "IDLE_TIMEOUT",
    });

    now = baseNow;
    const revoked = await auth.createSession({
      correlationId: correlationId("corr-auth-revoke-create"),
    });
    const revokedToken = requireToken(revoked);
    await expect(
      auth.revokeSession({
        correlationId: correlationId("corr-auth-revoke"),
        rawSessionToken: revokedToken,
      }),
    ).resolves.toEqual({ status: "REVOKED" });
    await expect(
      auth.revokeSession({
        correlationId: correlationId("corr-auth-revoke-again"),
        rawSessionToken: revokedToken,
      }),
    ).resolves.toEqual({ status: "ALREADY_REVOKED" });
    await expect(
      auth.resolveSession({
        correlationId: correlationId("corr-auth-revoked"),
        rawSessionToken: revokedToken,
      }),
    ).resolves.toEqual({ reasonCode: "SESSION_REVOKED", status: "REVOKED" });
  });

  it("rotates tokens atomically and makes the old token unusable", async () => {
    const fixture = await createVerifiedFixture("rotate-subject");
    const auth = authService(fixture, {
      assertion: assertion("rotate-subject"),
    });
    const created = await auth.createSession({
      correlationId: correlationId("corr-auth-rotate-create"),
    });
    const oldToken = requireToken(created);

    const rotated = await auth.rotateSession({
      correlationId: correlationId("corr-auth-rotate"),
      rawSessionToken: oldToken,
    });

    expect(rotated).toMatchObject({ status: "ROTATED" });
    await expect(
      auth.resolveSession({
        correlationId: correlationId("corr-auth-old"),
        rawSessionToken: oldToken,
      }),
    ).resolves.toEqual({ reasonCode: "SESSION_INVALID", status: "INVALID" });
    await expect(
      auth.resolveSession({
        correlationId: correlationId("corr-auth-new"),
        rawSessionToken:
          rotated.status === "ROTATED" ? rotated.rawSessionToken : "",
      }),
    ).resolves.toMatchObject({ status: "AUTHENTICATED" });
  });

  it("supports revoke-all and conditional last-seen touching", async () => {
    let now = baseNow;
    const fixture = await createVerifiedFixture("touch-subject");
    const auth = authService(fixture, {
      assertion: assertion("touch-subject"),
      now: () => now,
    });
    const first = await auth.createSession({
      correlationId: correlationId("corr-auth-first"),
    });
    const second = await auth.createSession({
      correlationId: correlationId("corr-auth-second"),
    });
    const firstInspection = await auth.inspectSession({
      sessionId: requireSessionId(first),
    });
    await auth.resolveSession({
      correlationId: correlationId("corr-auth-touch-skip"),
      rawSessionToken: requireToken(first),
    });
    expect(
      await auth.inspectSession({ sessionId: requireSessionId(first) }),
    ).toMatchObject({ recordVersion: firstInspection?.recordVersion });

    now = new Date(baseNow.getTime() + 301_000);
    await auth.resolveSession({
      correlationId: correlationId("corr-auth-touch"),
      rawSessionToken: requireToken(first),
    });
    expect(
      (await auth.inspectSession({ sessionId: requireSessionId(first) }))
        ?.recordVersion,
    ).toBe((firstInspection?.recordVersion ?? 0) + 1);

    await expect(
      auth.revokeAllForCustomer({
        correlationId: correlationId("corr-auth-revoke-all"),
        customerId: fixture.customerId,
      }),
    ).resolves.toEqual({ revokedCount: 2, status: "REVOKED" });
    await expect(
      auth.resolveSession({
        correlationId: correlationId("corr-auth-revoked-all"),
        rawSessionToken: requireToken(second),
      }),
    ).resolves.toEqual({ reasonCode: "SESSION_REVOKED", status: "REVOKED" });
  });

  it("integrates with delivery authorization for synthetic fulfillment only", async () => {
    const fixture = await createVerifiedFixture("delivery-subject");
    const order = orderId("11111111-1111-4111-8111-111111111111");
    const fulfillmentId = "22222222-2222-4222-8222-222222222222";
    fixture.identityRepository.addOrder({
      customerId: fixture.customerId,
      fulfillmentStatus: "PENDING",
      orderId: order,
      paymentStatus: "CAPTURED",
      procurementStatus: "SUCCEEDED",
      recordVersion: 1,
      status: "FULFILLMENT_PENDING",
      updatedAt: baseNow,
    });
    fixture.identityRepository.addFulfillment({
      deliveryState: "PENDING",
      encryptedSecretId: "synthetic-encrypted-secret",
      fulfillmentId,
      orderId: order,
      retrievalState: "RETRIEVED",
      status: "DELIVERY_PENDING",
    });
    const auth = authService(fixture, {
      assertion: assertion("delivery-subject"),
    });
    const created = await auth.createSession({
      correlationId: correlationId("corr-auth-delivery"),
    });
    const deliveryAuth = new PersistedCustomerOrderAuthorizationPort({
      principalProvider: new CustomerSessionPrincipalProvider({
        correlationId: correlationId("corr-auth-delivery-principal"),
        rawSessionToken: requireToken(created),
        service: auth,
      }),
      repository: fixture.identityRepository,
    });

    await expect(
      deliveryAuth.authorizeDelivery({
        customerId: fixture.customerId,
        expiresAt: new Date(baseNow.getTime() + 60_000),
        fulfillmentId,
        issuedAt: baseNow,
        orderId: order,
        purpose: "customer-key-delivery",
        version: 1,
      }),
    ).resolves.toEqual({ status: "AUTHORIZED" });
  });

  it("uses 256-bit opaque tokens and deterministic hashes without exposing raw tokens from inspect", async () => {
    const token = generateCustomerSessionToken();
    expect(token).toHaveLength(43);
    expect(hashCustomerSessionToken(token)).toMatch(/^[a-f0-9]{64}$/u);

    const fixture = await createVerifiedFixture("inspect-subject");
    const auth = authService(fixture, {
      assertion: assertion("inspect-subject"),
    });
    const created = await auth.createSession({
      correlationId: correlationId("corr-auth-inspect"),
    });
    const inspection = await auth.inspectSession({
      sessionId: requireSessionId(created),
    });
    expect(JSON.stringify(inspection)).not.toContain(requireToken(created));
    expect(JSON.stringify(inspection)).not.toMatch(/[a-f0-9]{64}/u);
  });

  it("invalidates sessions when the authoritative identity binding disappears", async () => {
    const fixture = await createVerifiedFixture("removed-binding-subject");
    const auth = authService(fixture, {
      assertion: assertion("removed-binding-subject"),
    });
    const created = await auth.createSession({
      correlationId: correlationId("corr-auth-binding-create"),
    });
    const token = requireToken(created);
    await expect(
      auth.resolveSession({
        correlationId: correlationId("corr-auth-binding-valid"),
        rawSessionToken: token,
      }),
    ).resolves.toMatchObject({ status: "AUTHENTICATED" });

    fixture.identityRepository.removeIdentityBindingById(
      requireBindingId(
        await auth.inspectSession({ sessionId: requireSessionId(created) }),
      ),
    );

    await expect(
      auth.resolveSession({
        correlationId: correlationId("corr-auth-binding-missing"),
        rawSessionToken: token,
      }),
    ).resolves.toEqual({ reasonCode: "SESSION_INVALID", status: "INVALID" });
    await expect(
      new CustomerSessionPrincipalProvider({
        correlationId: correlationId("corr-auth-binding-principal"),
        rawSessionToken: token,
        service: auth,
      }).currentPrincipal(),
    ).resolves.toBeNull();
    const rotated = await auth.rotateSession({
      correlationId: correlationId("corr-auth-binding-rotate"),
      rawSessionToken: token,
    });
    expect(rotated).toEqual({
      reasonCode: "SESSION_INVALID",
      status: "INVALID",
    });
    expect("rawSessionToken" in rotated).toBe(false);
  });

  it("invalidates sessions when the binding customer or provider no longer matches", async () => {
    const fixture = await createVerifiedFixture("mismatch-subject");
    const other = await createCustomer(
      fixture.identityRepository,
      "other@example.com",
    );
    const auth = authService(fixture, {
      assertion: assertion("mismatch-subject"),
    });
    const customerMismatch = await auth.createSession({
      correlationId: correlationId("corr-auth-customer-mismatch-create"),
    });
    const bindingId = requireBindingId(
      await auth.inspectSession({
        sessionId: requireSessionId(customerMismatch),
      }),
    );
    const binding = await requireIdentityBinding(fixture, bindingId);
    fixture.identityRepository.replaceIdentityBinding({
      ...binding,
      customerId: other,
    });
    await expect(
      auth.resolveSession({
        correlationId: correlationId("corr-auth-customer-mismatch"),
        rawSessionToken: requireToken(customerMismatch),
      }),
    ).resolves.toEqual({ reasonCode: "SESSION_INVALID", status: "INVALID" });

    const providerFixture = await createVerifiedFixture(
      "provider-mismatch-subject",
    );
    const providerAuth = authService(providerFixture, {
      assertion: assertion("provider-mismatch-subject"),
    });
    const providerMismatch = await providerAuth.createSession({
      correlationId: correlationId("corr-auth-provider-mismatch-create"),
    });
    const providerBindingId = requireBindingId(
      await providerAuth.inspectSession({
        sessionId: requireSessionId(providerMismatch),
      }),
    );
    const providerBinding = await requireIdentityBinding(
      providerFixture,
      providerBindingId,
    );
    providerFixture.identityRepository.replaceIdentityBinding({
      ...providerBinding,
      provider: "WOOCOMMERCE",
      providerSubject: "provider-moved-subject",
    });
    await expect(
      providerAuth.resolveSession({
        correlationId: correlationId("corr-auth-provider-mismatch"),
        rawSessionToken: requireToken(providerMismatch),
      }),
    ).resolves.toEqual({ reasonCode: "SESSION_INVALID", status: "INVALID" });
  });

  it("invalidated sessions cannot authorize synthetic delivery or reach decrypt/delivery boundaries", async () => {
    const fixture = await createVerifiedFixture("blocked-delivery-subject");
    const order = orderId("33333333-3333-4333-8333-333333333333");
    const fulfillmentId = "44444444-4444-4444-8444-444444444444";
    fixture.identityRepository.addOrder({
      customerId: fixture.customerId,
      fulfillmentStatus: "PENDING",
      orderId: order,
      paymentStatus: "CAPTURED",
      procurementStatus: "SUCCEEDED",
      recordVersion: 1,
      status: "FULFILLMENT_PENDING",
      updatedAt: baseNow,
    });
    fixture.identityRepository.addFulfillment({
      deliveryState: "PENDING",
      encryptedSecretId: "synthetic-encrypted-secret",
      fulfillmentId,
      orderId: order,
      retrievalState: "RETRIEVED",
      status: "DELIVERY_PENDING",
    });
    const auth = authService(fixture, {
      assertion: assertion("blocked-delivery-subject"),
    });
    const created = await auth.createSession({
      correlationId: correlationId("corr-auth-blocked-delivery-create"),
    });
    fixture.identityRepository.removeIdentityBindingById(
      requireBindingId(
        await auth.inspectSession({ sessionId: requireSessionId(created) }),
      ),
    );

    const deliveryAuth = new PersistedCustomerOrderAuthorizationPort({
      principalProvider: new CustomerSessionPrincipalProvider({
        correlationId: correlationId("corr-auth-blocked-delivery-principal"),
        rawSessionToken: requireToken(created),
        service: auth,
      }),
      repository: fixture.identityRepository,
    });

    await expect(
      deliveryAuth.authorizeDelivery({
        customerId: fixture.customerId,
        expiresAt: new Date(baseNow.getTime() + 60_000),
        fulfillmentId,
        issuedAt: baseNow,
        orderId: order,
        purpose: "customer-key-delivery",
        version: 1,
      }),
    ).resolves.toEqual({ status: "DENIED" });
  });
});

const createVerifiedFixture = async (providerSubject: string) => {
  const identityRepository = new InMemoryCustomerOrderIdentityRepository();
  const identityService = new CustomerOrderIdentityService({
    emailVerificationAuthority: new FakeEmailVerificationAuthority(),
    identityBindingAuthority: new FakeIdentityBindingAuthority(providerSubject),
    now: () => baseNow,
    orderOwnershipAuthority: new FakeOrderOwnershipAuthority(),
    repository: identityRepository,
  });
  const created = await identityService.createCustomer({
    correlationId: correlationId("corr-customer-create"),
    email: "Owner@example.com",
  });
  const targetCustomerId = "customer" in created ? created.customer.id : null;
  if (!targetCustomerId) {
    throw new Error("Expected customer fixture");
  }
  await identityService.markEmailVerified({
    correlationId: correlationId("corr-customer-verify"),
    customerId: targetCustomerId,
    expectedCustomerVersion: 1,
  });
  await identityService.bindIdentity({
    correlationId: correlationId("corr-customer-bind"),
    customerId: targetCustomerId,
  });
  const authRepository = new InMemoryCustomerAuthSessionRepository({
    findCustomerById: (id) => identityRepository.findCustomerById(id),
    findIdentityBindingById: (id) =>
      identityRepository.findIdentityBindingById(id),
    findIdentityBindingByProviderSubject: (input) =>
      identityRepository.findIdentityBindingByProviderSubject(input),
  });
  return {
    authRepository,
    customerId: targetCustomerId,
    identityRepository,
  };
};

const createCustomer = async (
  identityRepository: InMemoryCustomerOrderIdentityRepository,
  email: string,
): Promise<CustomerId> => {
  const service = new CustomerOrderIdentityService({
    emailVerificationAuthority: new FakeEmailVerificationAuthority(),
    identityBindingAuthority: new FakeIdentityBindingAuthority("unused"),
    now: () => baseNow,
    orderOwnershipAuthority: new FakeOrderOwnershipAuthority(),
    repository: identityRepository,
  });
  const created = await service.createCustomer({
    correlationId: correlationId(`corr-customer-${email}`),
    email,
  });
  if (!("customer" in created)) {
    throw new Error("Expected customer fixture");
  }
  return created.customer.id;
};

const authService = (
  fixture: Awaited<ReturnType<typeof createVerifiedFixture>>,
  options: {
    readonly assertion?: VerifiedCustomerAuthenticationAssertion;
    readonly denied?: boolean;
    readonly audit?: AuditEventPort;
    readonly now?: () => Date;
  },
): CustomerAuthenticationService =>
  new CustomerAuthenticationService({
    ...(options.audit ? { audit: options.audit } : {}),
    authority: new FakeAuthenticationAuthority(options),
    now: options.now ?? (() => baseNow),
    repository: fixture.authRepository,
  });

const assertion = (
  providerSubject: string,
  overrides: Partial<VerifiedCustomerAuthenticationAssertion> = {},
): VerifiedCustomerAuthenticationAssertion => ({
  assurance: "AUTHENTICATED",
  authContextId: `auth-context-${Math.abs(hashText(providerSubject))}`,
  authenticatedAt: baseNow,
  expiresAt: new Date(baseNow.getTime() + 28_800_000),
  provider: "TEST",
  providerSubject,
  ...overrides,
});

class FakeAuthenticationAuthority implements CustomerAuthenticationAuthorityPort {
  public constructor(
    private readonly options: {
      readonly assertion?: VerifiedCustomerAuthenticationAssertion;
      readonly denied?: boolean;
    },
  ) {}

  public async verifiedAuthenticationAssertion(input: {
    readonly correlationId: CorrelationId;
  }) {
    if (this.options.denied) {
      return {
        reasonCode: `DENIED_${input.correlationId}`,
        status: "DENIED" as const,
      };
    }
    return {
      assertion: this.options.assertion ?? assertion("default-subject"),
      status: "AUTHORIZED" as const,
    };
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
        verifiedAt: baseNow,
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

class CapturingAudit implements AuditEventPort {
  private readonly events: unknown[] = [];

  public async append(event: unknown): Promise<void> {
    this.events.push(event);
  }

  public serializedEvents(): string {
    return JSON.stringify(this.events);
  }
}

const requireToken = (
  result: Awaited<ReturnType<CustomerAuthenticationService["createSession"]>>,
): string => {
  if (result.status !== "CREATED") {
    throw new Error("Expected created auth fixture");
  }
  return result.rawSessionToken;
};

const hashText = (value: string): number => {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return hash;
};

const requireSessionId = (
  result: Awaited<ReturnType<CustomerAuthenticationService["createSession"]>>,
): string => {
  if (result.status !== "CREATED") {
    throw new Error("Expected created auth fixture");
  }
  return result.sessionId;
};

const requireBindingId = (
  inspection: Awaited<
    ReturnType<CustomerAuthenticationService["inspectSession"]>
  >,
): string => {
  if (!inspection) {
    throw new Error("Expected session inspection fixture");
  }
  return inspection.identityBindingId;
};

const requireIdentityBinding = async (
  fixture: Awaited<ReturnType<typeof createVerifiedFixture>>,
  bindingId: string,
): Promise<CustomerIdentityBinding> => {
  const binding =
    await fixture.identityRepository.findIdentityBindingById(bindingId);
  if (!binding) {
    throw new Error("Expected identity binding fixture");
  }
  return binding;
};
