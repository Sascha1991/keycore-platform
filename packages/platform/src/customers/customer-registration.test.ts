import { describe, expect, it } from "vitest";

import { InMemoryCustomerOrderIdentityRepository } from "../../../../infra/customers/in-memory-customer-order-identity-repository.js";
import { InMemoryCustomerRegistrationChallengeRepository } from "../../../../infra/customers/in-memory-customer-registration-repository.js";
import {
  CustomerOrderIdentityService,
  CustomerRegistrationService,
  FakeCustomerEmailVerificationDeliveryPort,
  correlationId,
  orderId,
  type AuditEvent,
  type AuthenticatedCustomerPrincipal,
  type CorrelationId,
  type CustomerId,
  type CustomerIdentityBindingAuthorityPort,
  type CustomerIdentityProvider,
  type CustomerEmailVerificationDeliveryPort,
  type CustomerOrderIdentityRepository,
  type GuestOrderClaimAuthorityPort,
  type KeyCoreCustomer,
  type OrderId,
} from "../contracts.js";

const leakMarker = "KEYCORE_TEST_REGISTRATION_TOKEN_DO_NOT_LEAK_98765";
const now = new Date("2026-08-25T12:00:00.000Z");
type VerificationDeliveryInput = Parameters<
  CustomerEmailVerificationDeliveryPort["sendVerificationChallenge"]
>[0];
type TestVerificationDelivery = CustomerEmailVerificationDeliveryPort & {
  readonly deliveries: readonly VerificationDeliveryInput[];
};

describe("CustomerRegistrationService", () => {
  it("accepts new and existing registration without public enumeration and creates only unverified customers", async () => {
    const harness = registrationHarness();

    await expect(
      harness.service.register({
        correlationId: correlationId("corr-register-new"),
        email: "Buyer@Example.COM",
      }),
    ).resolves.toEqual({ status: "REGISTRATION_ACCEPTED" });
    const customer =
      await harness.identityRepository.findCustomerByNormalizedEmail(
        "Buyer@example.com",
      );
    expect(customer).toMatchObject({
      emailNormalized: "Buyer@example.com",
      emailVerificationState: "UNVERIFIED",
    });
    expect(harness.delivery.deliveries).toHaveLength(1);

    await expect(
      harness.service.register({
        correlationId: correlationId("corr-register-existing"),
        email: "Buyer@example.com",
      }),
    ).resolves.toEqual({ status: "REGISTRATION_ACCEPTED" });
    expect(harness.delivery.deliveries).toHaveLength(2);
    expect(
      await harness.identityRepository.findCustomerByNormalizedEmail(
        "Buyer@example.com",
      ),
    ).toMatchObject({ id: customer?.id });
    expect(JSON.stringify(harness.audit.events)).not.toContain(
      "Buyer@example.com",
    );
  });

  it("reuses existing email normalization and denies malformed email safely", async () => {
    const harness = registrationHarness();
    await expect(
      harness.service.register({
        correlationId: correlationId("corr-register-plus"),
        email: "first.last+tag@gmail.com",
      }),
    ).resolves.toEqual({ status: "REGISTRATION_ACCEPTED" });
    await expect(
      harness.identityRepository.findCustomerByNormalizedEmail(
        "first.last+tag@gmail.com",
      ),
    ).resolves.toBeTruthy();
    await expect(
      harness.identityRepository.findCustomerByNormalizedEmail(
        "firstlast@gmail.com",
      ),
    ).resolves.toBeNull();
    await expect(
      harness.service.register({
        correlationId: correlationId("corr-register-invalid"),
        email: "not an email",
      }),
    ).resolves.toEqual({
      reasonCode: "INVALID_EMAIL",
      status: "REGISTRATION_DENIED",
    });
    expect(harness.delivery.deliveries).toHaveLength(1);
  });

  it("supports concurrent same-email registration with one customer and stable public response", async () => {
    const harness = registrationHarness();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        harness.service.register({
          correlationId: correlationId(`corr-register-race-${index}`),
          email: "race@example.com",
        }),
      ),
    );
    expect(results).toEqual(
      Array.from({ length: 10 }, () => ({ status: "REGISTRATION_ACCEPTED" })),
    );
    const customer =
      await harness.identityRepository.findCustomerByNormalizedEmail(
        "race@example.com",
      );
    expect(customer?.emailVerificationState).toBe("UNVERIFIED");
  });

  it("issues hash-only one-time verification challenges and verifies through trusted authority", async () => {
    const harness = registrationHarness({ tokenFactory: () => leakMarker });
    await harness.service.register({
      correlationId: correlationId("corr-register-token"),
      email: "verify@example.com",
    });
    const delivery = required(harness.delivery.deliveries[0]);
    expect(delivery.rawVerificationToken).toBe(leakMarker);
    expect(delivery.rawVerificationToken.length).toBeGreaterThanOrEqual(43);
    const inspection = await harness.service.inspectCustomerRegistration({
      customerId: delivery.customerId,
    });
    expect(inspection).toMatchObject({
      activeChallengeCount: 1,
      identityBindingCount: 0,
      verificationState: "UNVERIFIED",
    });
    expect(JSON.stringify(harness.audit.events)).not.toContain(leakMarker);
    expect(JSON.stringify(inspection)).not.toContain(leakMarker);

    await expect(
      harness.service.verifyEmail({
        correlationId: correlationId("corr-verify-token"),
        rawVerificationToken: leakMarker,
      }),
    ).resolves.toEqual({ status: "VERIFIED" });
    await expect(
      harness.identityRepository.findCustomerById(delivery.customerId),
    ).resolves.toMatchObject({ emailVerificationState: "VERIFIED" });
    expect(harness.emailAuthorityCalls).toBe(0);
  });

  it("collapses invalid, expired, consumed and concurrent verification failures", async () => {
    const harness = registrationHarness();
    await harness.service.register({
      correlationId: correlationId("corr-register-single-use"),
      email: "single@example.com",
    });
    const token = required(harness.delivery.deliveries[0]).rawVerificationToken;
    await expect(
      harness.service.verifyEmail({
        correlationId: correlationId("corr-invalid-token"),
        rawVerificationToken: "invalid token",
      }),
    ).resolves.toEqual({ status: "VERIFICATION_INVALID" });
    const race = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        harness.service.verifyEmail({
          correlationId: correlationId(`corr-verify-race-${index}`),
          rawVerificationToken: token,
        }),
      ),
    );
    expect(race.filter((result) => result.status === "VERIFIED")).toHaveLength(
      1,
    );
    expect(
      race.filter((result) => result.status === "VERIFICATION_INVALID"),
    ).toHaveLength(9);
    await expect(
      harness.service.verifyEmail({
        correlationId: correlationId("corr-verify-used"),
        rawVerificationToken: token,
      }),
    ).resolves.toEqual({ status: "VERIFICATION_INVALID" });

    let currentTime = now;
    const expired = registrationHarness({
      nowProvider: () => currentTime,
    });
    await expired.service.register({
      correlationId: correlationId("corr-register-expired"),
      email: "expired@example.com",
    });
    currentTime = new Date(now.getTime() + 901_000);
    await expect(
      expired.service.verifyEmail({
        correlationId: correlationId("corr-verify-expired"),
        rawVerificationToken: required(expired.delivery.deliveries[0])
          .rawVerificationToken,
      }),
    ).resolves.toEqual({ status: "VERIFICATION_INVALID" });
    await expect(
      expired.service.inspectCustomerRegistration({
        customerId: required(expired.delivery.deliveries[0]).customerId,
      }),
    ).resolves.toMatchObject({ activeChallengeCount: 0 });
  });

  it("revokes delivery-failed challenges so their tokens cannot verify", async () => {
    const delivery = new FailingVerificationDelivery("FAILED");
    const harness = registrationHarness({ delivery });
    await expect(
      harness.service.register({
        correlationId: correlationId("corr-register-delivery-failed"),
        email: "delivery-failed@example.com",
      }),
    ).resolves.toEqual({
      reasonCode: "DELIVERY_FAILED",
      status: "REGISTRATION_DENIED",
    });
    const failedDelivery = required(delivery.deliveries[0]);
    await expect(
      harness.service.verifyEmail({
        correlationId: correlationId("corr-verify-delivery-failed"),
        rawVerificationToken: failedDelivery.rawVerificationToken,
      }),
    ).resolves.toEqual({ status: "VERIFICATION_INVALID" });
    await expect(
      harness.service.inspectCustomerRegistration({
        customerId: failedDelivery.customerId,
      }),
    ).resolves.toMatchObject({ activeChallengeCount: 0 });
  });

  it("handles delivery exceptions without leaking tokens or leaving challenges usable", async () => {
    const delivery = new FailingVerificationDelivery("THROW");
    const harness = registrationHarness({ delivery });
    await expect(
      harness.service.register({
        correlationId: correlationId("corr-register-delivery-throws"),
        email: "delivery-throws@example.com",
      }),
    ).resolves.toEqual({
      reasonCode: "DELIVERY_FAILED",
      status: "REGISTRATION_DENIED",
    });
    const failedDelivery = required(delivery.deliveries[0]);
    expect(JSON.stringify(harness.audit.events)).not.toContain(
      failedDelivery.rawVerificationToken,
    );
    await expect(
      harness.service.verifyEmail({
        correlationId: correlationId("corr-verify-delivery-throws"),
        rawVerificationToken: failedDelivery.rawVerificationToken,
      }),
    ).resolves.toEqual({ status: "VERIFICATION_INVALID" });
  });

  it("does not leave a failed replacement challenge usable after reissue", async () => {
    const delivery = new SwitchableVerificationDelivery();
    const harness = registrationHarness({ delivery });
    await harness.service.register({
      correlationId: correlationId("corr-register-reissue-ok"),
      email: "failed-reissue@example.com",
    });
    const first = required(delivery.deliveries[0]);
    delivery.mode = "FAILED";
    await expect(
      harness.service.register({
        correlationId: correlationId("corr-register-reissue-failed"),
        email: "failed-reissue@example.com",
      }),
    ).resolves.toEqual({
      reasonCode: "DELIVERY_FAILED",
      status: "REGISTRATION_DENIED",
    });
    const second = required(delivery.deliveries[1]);
    await expect(
      harness.service.verifyEmail({
        correlationId: correlationId("corr-verify-old-reissue"),
        rawVerificationToken: first.rawVerificationToken,
      }),
    ).resolves.toEqual({ status: "VERIFICATION_INVALID" });
    await expect(
      harness.service.verifyEmail({
        correlationId: correlationId("corr-verify-failed-reissue"),
        rawVerificationToken: second.rawVerificationToken,
      }),
    ).resolves.toEqual({ status: "VERIFICATION_INVALID" });
  });

  it("keeps consumed tokens invalid if the later verification transition fails", async () => {
    const base = new InMemoryCustomerOrderIdentityRepository();
    const staleRepository = staleMarkEmailRepository(base);
    const challengeRepository =
      new InMemoryCustomerRegistrationChallengeRepository(base);
    const delivery = new FakeCustomerEmailVerificationDeliveryPort();
    const audit = new CollectingAudit();
    const service = new CustomerRegistrationService({
      audit,
      challengeRepository,
      delivery,
      identityRepository: staleRepository,
      identityService: new CustomerOrderIdentityService({
        audit,
        now: () => now,
        repository: base,
      }),
      now: () => now,
    });
    await service.register({
      correlationId: correlationId("corr-register-stale-verify"),
      email: "stale-verify@example.com",
    });
    const token = required(delivery.deliveries[0]).rawVerificationToken;
    await expect(
      service.verifyEmail({
        correlationId: correlationId("corr-verify-stale"),
        rawVerificationToken: token,
      }),
    ).resolves.toEqual({ status: "VERIFICATION_INVALID" });
    await expect(
      service.verifyEmail({
        correlationId: correlationId("corr-verify-stale-retry"),
        rawVerificationToken: token,
      }),
    ).resolves.toEqual({ status: "VERIFICATION_INVALID" });
  });

  it("invalidates prior challenges on reissue and prevents old-email verification after email change", async () => {
    const harness = registrationHarness();
    await harness.service.register({
      correlationId: correlationId("corr-register-reissue-1"),
      email: "change@example.com",
    });
    const first = required(harness.delivery.deliveries[0]);
    await harness.service.register({
      correlationId: correlationId("corr-register-reissue-2"),
      email: "change@example.com",
    });
    const second = required(harness.delivery.deliveries[1]);
    await expect(
      harness.service.verifyEmail({
        correlationId: correlationId("corr-verify-revoked"),
        rawVerificationToken: first.rawVerificationToken,
      }),
    ).resolves.toEqual({ status: "VERIFICATION_INVALID" });

    const customer = required(
      await harness.identityRepository.findCustomerById(second.customerId),
    );
    harness.identityRepository.replaceCustomer({
      ...customer,
      emailNormalized: "changed@example.com",
      recordVersion: customer.recordVersion + 1,
      updatedAt: now,
    });
    await expect(
      harness.service.verifyEmail({
        correlationId: correlationId("corr-verify-old-email"),
        rawVerificationToken: second.rawVerificationToken,
      }),
    ).resolves.toEqual({ status: "VERIFICATION_INVALID" });
  });

  it("links identities only for authenticated verified customers with trusted provider evidence", async () => {
    const harness = registrationHarness({
      identityBindingAuthority: new FakeIdentityAuthority("subject-1"),
    });
    const verified = await registerAndVerify(harness, "link@example.com");
    await expect(
      harness.service.linkExternalIdentity({
        correlationId: correlationId("corr-link-missing"),
        principal: null,
      }),
    ).resolves.toEqual({ status: "AUTHENTICATION_REQUIRED" });
    await expect(
      harness.service.linkExternalIdentity({
        correlationId: correlationId("corr-link-test"),
        principal: principal(verified, "TEST"),
      }),
    ).resolves.toEqual({ status: "AUTHENTICATION_UNTRUSTED" });

    const unverified = await registerOnly(harness, "unverified@example.com");
    await expect(
      harness.service.linkExternalIdentity({
        correlationId: correlationId("corr-link-unverified"),
        principal: principal(unverified),
      }),
    ).resolves.toEqual({ status: "EMAIL_NOT_VERIFIED" });
    await expect(
      harness.service.linkExternalIdentity({
        correlationId: correlationId("corr-link-bound"),
        principal: principal(verified),
      }),
    ).resolves.toEqual({ status: "BOUND" });
    await expect(
      harness.service.linkExternalIdentity({
        correlationId: correlationId("corr-link-idempotent"),
        principal: principal(verified),
      }),
    ).resolves.toEqual({ status: "ALREADY_BOUND" });

    const other = await registerAndVerify(harness, "other-link@example.com");
    await expect(
      harness.service.linkExternalIdentity({
        correlationId: correlationId("corr-link-conflict"),
        principal: principal(other),
      }),
    ).resolves.toEqual({ status: "IDENTITY_CONFLICT" });
    await expect(
      registrationHarness().service.linkExternalIdentity({
        correlationId: correlationId("corr-link-denied"),
        principal: principal(verified),
      }),
    ).resolves.toEqual({ status: "CUSTOMER_NOT_FOUND" });
  });

  it("does not claim orders by email equality and only trusted synthetic evidence can bind unowned orders", async () => {
    const targetOrder = orderId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
    const harness = registrationHarness({
      claimAuthority: new FakeClaimAuthority(targetOrder),
    });
    const owner = await registerAndVerify(harness, "claim@example.com");
    harness.identityRepository.addOrder({
      customerId: null,
      fulfillmentStatus: "PENDING",
      orderId: targetOrder,
      paymentStatus: "CAPTURED",
      procurementStatus: "SUCCEEDED",
      recordVersion: 1,
      status: "FULFILLMENT_PENDING",
      updatedAt: now,
    });
    await expect(
      registrationHarness().service.claimGuestOrder({
        correlationId: correlationId("corr-claim-email-only"),
        orderId: targetOrder,
        principal: principal(owner),
      }),
    ).resolves.toEqual({ status: "CUSTOMER_NOT_FOUND" });

    const race = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        harness.service.claimGuestOrder({
          correlationId: correlationId(`corr-claim-${index}`),
          orderId: targetOrder,
          principal: principal(owner),
        }),
      ),
    );
    expect(race.filter((result) => result.status === "CLAIMED")).toHaveLength(
      1,
    );
    expect(
      race.filter((result) => result.status === "ALREADY_OWNED"),
    ).toHaveLength(9);
    const other = await registerAndVerify(harness, "claim-other@example.com");
    await expect(
      harness.service.claimGuestOrder({
        correlationId: correlationId("corr-claim-conflict"),
        orderId: targetOrder,
        principal: principal(other),
      }),
    ).resolves.toEqual({ status: "OWNERSHIP_CONFLICT" });
  });

  it("keeps the known real fulfillment unclaimed and untouched", async () => {
    const harness = registrationHarness();
    const customer = await registerAndVerify(
      harness,
      "real-safety@example.com",
    );
    const realOrder = orderId("fd61be5e-44ea-4914-98ae-c4404dc31779");
    await expect(
      harness.service.claimGuestOrder({
        correlationId: correlationId("corr-real-claim-denied"),
        orderId: realOrder,
        principal: principal(customer),
      }),
    ).resolves.toEqual({ status: "CLAIM_DENIED" });
  });
});

const registrationHarness = (
  options: {
    readonly identityBindingAuthority?: CustomerIdentityBindingAuthorityPort;
    readonly claimAuthority?: GuestOrderClaimAuthorityPort;
    readonly delivery?: TestVerificationDelivery;
    readonly tokenFactory?: () => string;
    readonly nowProvider?: () => Date;
    readonly nowSequence?: readonly Date[];
  } = {},
) => {
  const identityRepository = new InMemoryCustomerOrderIdentityRepository();
  const challengeRepository =
    new InMemoryCustomerRegistrationChallengeRepository(identityRepository);
  const delivery: TestVerificationDelivery =
    options.delivery ?? new FakeCustomerEmailVerificationDeliveryPort();
  const audit = new CollectingAudit();
  let nowCalls = 0;
  const nowProvider =
    options.nowProvider ?? (() => options.nowSequence?.[nowCalls++] ?? now);
  const identityService = new CustomerOrderIdentityService({
    audit,
    now: nowProvider,
    repository: identityRepository,
  });
  let emailAuthorityCalls = 0;
  const service = new CustomerRegistrationService({
    audit,
    challengeRepository,
    delivery,
    identityRepository,
    identityService,
    now: nowProvider,
    ...(options.claimAuthority
      ? { claimAuthority: options.claimAuthority }
      : {}),
    ...(options.identityBindingAuthority
      ? { identityBindingAuthority: options.identityBindingAuthority }
      : {}),
    ...(options.tokenFactory ? { tokenFactory: options.tokenFactory } : {}),
  });
  return {
    audit,
    challengeRepository,
    delivery,
    get emailAuthorityCalls() {
      return emailAuthorityCalls;
    },
    identityRepository,
    service,
  };
};

const registerOnly = async (
  harness: ReturnType<typeof registrationHarness>,
  email: string,
): Promise<CustomerId> => {
  await harness.service.register({
    correlationId: correlationId(`corr-register-${email}`),
    email,
  });
  return required(required(harness.delivery.deliveries.at(-1)).customerId);
};

const registerAndVerify = async (
  harness: ReturnType<typeof registrationHarness>,
  email: string,
): Promise<CustomerId> => {
  const id = await registerOnly(harness, email);
  await harness.service.verifyEmail({
    correlationId: correlationId(`corr-verify-${email}`),
    rawVerificationToken: required(harness.delivery.deliveries.at(-1))
      .rawVerificationToken,
  });
  return id;
};

class FakeIdentityAuthority implements CustomerIdentityBindingAuthorityPort {
  public constructor(private readonly providerSubject: string) {}

  public async verifiedIdentitySubject(input: {
    readonly customerId: CustomerId;
    readonly correlationId: CorrelationId;
  }) {
    return {
      provider: "TEST" as CustomerIdentityProvider,
      providerEvidenceId: `identity:${input.correlationId}`,
      providerSubject: this.providerSubject,
      status: "AUTHORIZED" as const,
    };
  }
}

class FakeClaimAuthority implements GuestOrderClaimAuthorityPort {
  public constructor(private readonly order: OrderId) {}

  public async verifiedGuestOrderClaim(input: {
    readonly principal: AuthenticatedCustomerPrincipal;
    readonly orderId: OrderId;
    readonly correlationId: CorrelationId;
  }) {
    return input.orderId === this.order
      ? {
          evidence: {
            actorId: "synthetic-claim-test",
            actorType: "SERVICE" as const,
            customerId: input.principal.customerId,
            expectedOrderVersion: 1,
            orderId: input.orderId,
            providerEvidenceId: `claim:${input.correlationId}`,
          },
          status: "AUTHORIZED" as const,
        }
      : { reasonCode: "NO_TRUSTED_CLAIM_EVIDENCE", status: "DENIED" as const };
  }
}

class FailingVerificationDelivery implements CustomerEmailVerificationDeliveryPort {
  public readonly deliveries: Parameters<
    CustomerEmailVerificationDeliveryPort["sendVerificationChallenge"]
  >[0][] = [];

  public constructor(private readonly mode: "FAILED" | "THROW") {}

  public async sendVerificationChallenge(
    input: Parameters<
      CustomerEmailVerificationDeliveryPort["sendVerificationChallenge"]
    >[0],
  ): Promise<{ readonly status: "ACCEPTED" } | { readonly status: "FAILED" }> {
    this.deliveries.push(input);
    if (this.mode === "THROW") {
      throw new Error("synthetic delivery failure");
    }
    return { status: "FAILED" };
  }
}

class SwitchableVerificationDelivery implements CustomerEmailVerificationDeliveryPort {
  public readonly deliveries: Parameters<
    CustomerEmailVerificationDeliveryPort["sendVerificationChallenge"]
  >[0][] = [];
  public mode: "ACCEPTED" | "FAILED" = "ACCEPTED";

  public async sendVerificationChallenge(
    input: Parameters<
      CustomerEmailVerificationDeliveryPort["sendVerificationChallenge"]
    >[0],
  ): Promise<{ readonly status: "ACCEPTED" } | { readonly status: "FAILED" }> {
    this.deliveries.push(input);
    return { status: this.mode };
  }
}

const staleMarkEmailRepository = (
  base: InMemoryCustomerOrderIdentityRepository,
): CustomerOrderIdentityRepository => ({
  authorizeFulfillmentForCustomer: (input) =>
    base.authorizeFulfillmentForCustomer(input),
  bindIdentity: (input) => base.bindIdentity(input),
  bindOrderOwnership: (input) => base.bindOrderOwnership(input),
  createCustomer: (input) => base.createCustomer(input),
  findCustomerById: (id) => base.findCustomerById(id),
  findCustomerByNormalizedEmail: (email) =>
    base.findCustomerByNormalizedEmail(email),
  inspectCustomer: (id) => base.inspectCustomer(id),
  inspectOrderOwnership: (id) => base.inspectOrderOwnership(id),
  markEmailVerified: async (input) => ({
    customer:
      (await base.findCustomerById(input.customerId)) ??
      ({
        createdAt: now,
        emailNormalized: "missing@example.com",
        emailVerificationState: "UNVERIFIED",
        id: input.customerId,
        recordVersion: input.expectedCustomerVersion,
        updatedAt: now,
      } satisfies KeyCoreCustomer),
    status: "STALE_WRITER" as const,
  }),
});

class CollectingAudit {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const principal = (
  id: CustomerId,
  assurance: "AUTHENTICATED" | "TEST" = "AUTHENTICATED",
): AuthenticatedCustomerPrincipal => ({
  authenticationContext: { assurance, provider: "TEST" },
  customerId: id,
});

const required = <TValue>(value: TValue | null | undefined): TValue => {
  if (!value) {
    throw new Error("Expected customer registration test fixture");
  }
  return value;
};
