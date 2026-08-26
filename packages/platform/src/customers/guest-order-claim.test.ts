import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { InMemoryGuestOrderClaimRepository } from "../../../../infra/customers/in-memory-guest-order-claim-repository.js";
import { InMemoryCustomerOrderIdentityRepository } from "../../../../infra/customers/in-memory-customer-order-identity-repository.js";
import { InMemoryCustomerRegistrationChallengeRepository } from "../../../../infra/customers/in-memory-customer-registration-repository.js";
import {
  CustomerOrderIdentityService,
  CustomerRegistrationService,
  FakeCustomerEmailVerificationDeliveryPort,
  FakeGuestOrderClaimDeliveryPort,
  GuestOrderClaimService,
  PersistedGuestOrderClaimAuthority,
  TrustedGuestOrderClaimIssuanceAuthority,
  correlationId,
  orderId,
  type AuditEvent,
  type AuditEventPort,
  type AuthenticatedCustomerPrincipal,
  type CorrelationId,
  type CustomerId,
  type EmailVerificationAuthorityPort,
  type GuestOrderClaimDeliveryPort,
  type GuestOrderClaimServiceOptions,
  type OrderId,
} from "../contracts.js";

const now = new Date("2026-08-26T14:00:00.000Z");
const claimMarker = "KEYRANO_KS0805_CLAIM_TOKEN_DO_NOT_LEAK_842913";
const sessionMarker = "KEYRANO_KS0805_SESSION_TOKEN_DO_NOT_LEAK_842913";
const productKeyMarker = "KEYRANO_KS0805_PRODUCT_KEY_DO_NOT_EMAIL_842913";
const realFulfillmentId = "fd61be5e-44ea-4914-98ae-c4404dc31779";

describe("guest order claim foundation", () => {
  it("issues a trusted guest claim challenge with hash-only persistence and no product key email", async () => {
    const harness = claimHarness({ tokenFactory: () => claimMarker });
    const guestOrder = addGuestOrder(harness, "buyer@example.com");

    const issued = await harness.claimService.issueGuestOrderClaim({
      checkoutEmail: "Buyer@Example.com",
      correlationId: correlationId("ks0805-issue"),
      orderId: guestOrder,
    });

    expect(issued).toEqual({ status: "ISSUED" });
    expect(harness.claimDelivery.deliveries).toHaveLength(1);
    expect(harness.claimDelivery.deliveries[0]).toMatchObject({
      emailNormalized: "Buyer@example.com",
      orderId: guestOrder,
      rawClaimCode: claimMarker,
    });
    expect(safeJson(harness.claimRepository.challenges)).not.toContain(
      claimMarker,
    );
    expect(safeJson(harness.claimRepository.challenges)).not.toContain(
      productKeyMarker,
    );
    expect(safeJson(harness.audit.events)).not.toContain(claimMarker);
    expect(safeJson(harness.audit.events)).not.toContain(sessionMarker);
    expect(safeJson(harness.audit.events)).not.toContain(productKeyMarker);
    expect(
      await harness.claimService.inspectOrderClaim({ orderId: guestOrder }),
    ).toMatchObject({
      activeClaimCount: 1,
      hasCheckoutEmailSnapshot: true,
      isOwned: false,
    });
  });

  it("denies untrusted, owned, missing-email and delivery-failed claim issuance safely", async () => {
    const untrusted = claimHarness({ trustedIssuance: false });
    const untrustedOrder = addGuestOrder(untrusted, "buyer@example.com");
    await expect(
      untrusted.claimService.issueGuestOrderClaim({
        checkoutEmail: "buyer@example.com",
        correlationId: correlationId("ks0805-untrusted-issue"),
        orderId: untrustedOrder,
      }),
    ).resolves.toMatchObject({ status: "CLAIM_ISSUE_DENIED" });
    expect(untrusted.claimDelivery.deliveries).toHaveLength(0);

    const owned = claimHarness();
    const owner = await registerAndVerify(owned, "owner@example.com");
    const ownedOrder = addGuestOrder(owned, "owner@example.com", owner);
    await expect(
      owned.claimService.issueGuestOrderClaim({
        checkoutEmail: "owner@example.com",
        correlationId: correlationId("ks0805-owned-issue"),
        orderId: ownedOrder,
      }),
    ).resolves.toMatchObject({ status: "ORDER_NOT_CLAIMABLE" });

    const missingEmail = claimHarness();
    const missingEmailOrder = addGuestOrder(missingEmail, null);
    await expect(
      missingEmail.claimService.issueGuestOrderClaim({
        checkoutEmail: "",
        correlationId: correlationId("ks0805-missing-email"),
        orderId: missingEmailOrder,
      }),
    ).resolves.toMatchObject({ status: "ORDER_NOT_CLAIMABLE" });

    const failed = claimHarness({
      claimDelivery: new FailingGuestOrderClaimDeliveryPort("FAILED"),
      tokenFactory: () => claimMarker,
    });
    const failedOrder = addGuestOrder(failed, "buyer@example.com");
    await expect(
      failed.claimService.issueGuestOrderClaim({
        checkoutEmail: "buyer@example.com",
        correlationId: correlationId("ks0805-delivery-failed"),
        orderId: failedOrder,
      }),
    ).resolves.toMatchObject({ status: "DELIVERY_FAILED" });
    expect(
      [...failed.claimRepository.challenges.values()][0]?.revokedAt,
    ).toEqual(now);
  });

  it("claims only with authenticated verified matching email plus active claim code", async () => {
    const harness = claimHarness({ tokenFactory: () => claimMarker });
    const guestOrder = addGuestOrder(harness, "buyer@example.com");
    const buyer = await registerAndVerify(harness, "buyer@example.com");
    const wrong = await registerAndVerify(harness, "wrong@example.com");
    await issue(harness, guestOrder, "buyer@example.com");

    await expect(
      harness.registrationService.claimGuestOrder({
        claimCode: claimMarker,
        correlationId: correlationId("ks0805-stolen-wrong-email"),
        principal: principal(wrong),
      }),
    ).resolves.toEqual({ status: "CLAIM_DENIED" });
    expect(
      await harness.identityRepository.inspectOrderOwnership(guestOrder),
    ).toMatchObject({ ownerCustomerId: null });

    await expect(
      harness.registrationService.claimGuestOrder({
        claimCode: claimMarker,
        correlationId: correlationId("ks0805-claim-success"),
        principal: principal(buyer),
      }),
    ).resolves.toEqual({ orderId: guestOrder, status: "CLAIMED" });
    expect(
      await harness.identityRepository.inspectOrderOwnership(guestOrder),
    ).toMatchObject({
      ownerCustomerId: buyer,
      ownershipBound: true,
    });
    await expect(
      harness.registrationService.claimGuestOrder({
        claimCode: claimMarker,
        correlationId: correlationId("ks0805-claim-replay"),
        principal: principal(buyer),
      }),
    ).resolves.toEqual({ status: "CLAIM_DENIED" });
  });

  it("denies missing, unverified, invalid, expired, revoked and context-only claims", async () => {
    const harness = claimHarness({ tokenFactory: () => claimMarker });
    const guestOrder = addGuestOrder(harness, "buyer@example.com");
    const unverified = await registerOnly(harness, "buyer@example.com");
    await issue(harness, guestOrder, "buyer@example.com");

    for (const input of [
      { principal: null, status: "AUTHENTICATION_REQUIRED" },
      { principal: principal(unverified), status: "EMAIL_NOT_VERIFIED" },
    ] as const) {
      await expect(
        harness.registrationService.claimGuestOrder({
          claimCode: claimMarker,
          correlationId: correlationId(`ks0805-denied-${input.status}`),
          principal: input.principal,
        }),
      ).resolves.toEqual({ status: input.status });
    }
    await expect(
      harness.registrationService.claimGuestOrder({
        claimCode: "invalid-claim-code-with-enough-entropy",
        correlationId: correlationId("ks0805-invalid-code"),
        orderId: guestOrder,
        principal: principal(unverified),
      }),
    ).resolves.toEqual({ status: "EMAIL_NOT_VERIFIED" });

    const verified = await registerAndVerify(
      claimHarness(),
      "other@example.com",
    );
    await expect(
      claimHarness().registrationService.claimGuestOrder({
        claimCode: claimMarker,
        correlationId: correlationId("ks0805-email-only"),
        orderId: guestOrder,
        principal: principal(verified),
      }),
    ).resolves.toEqual({ status: "CUSTOMER_NOT_FOUND" });

    const reissue = claimHarness({
      tokenSequence: [
        "first-claim-code-with-enough-entropy-842913",
        "second-claim-code-with-enough-entropy-842913",
      ],
    });
    const reissueOrder = addGuestOrder(reissue, "buyer@example.com");
    const reissueBuyer = await registerAndVerify(reissue, "buyer@example.com");
    await issue(reissue, reissueOrder, "buyer@example.com");
    await issue(reissue, reissueOrder, "buyer@example.com");
    await expect(
      reissue.registrationService.claimGuestOrder({
        claimCode: "first-claim-code-with-enough-entropy-842913",
        correlationId: correlationId("ks0805-revoked-code"),
        principal: principal(reissueBuyer),
      }),
    ).resolves.toEqual({ status: "CLAIM_DENIED" });
    await expect(
      reissue.registrationService.claimGuestOrder({
        claimCode: "second-claim-code-with-enough-entropy-842913",
        correlationId: correlationId("ks0805-reissued-code"),
        principal: principal(reissueBuyer),
      }),
    ).resolves.toEqual({ orderId: reissueOrder, status: "CLAIMED" });
  });

  it("allows only one concurrent claim with one active code and never touches real fulfillment", async () => {
    const harness = claimHarness({ tokenFactory: () => claimMarker });
    const guestOrder = addGuestOrder(harness, "buyer@example.com");
    const buyer = await registerAndVerify(harness, "buyer@example.com");
    await issue(harness, guestOrder, "buyer@example.com");

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        harness.registrationService.claimGuestOrder({
          claimCode: claimMarker,
          correlationId: correlationId(`ks0805-concurrent-${index}`),
          principal: principal(buyer),
        }),
      ),
    );

    expect(
      results.filter((result) => result.status === "CLAIMED"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "CLAIM_DENIED"),
    ).toHaveLength(9);
    expect(
      await harness.identityRepository.inspectOrderOwnership(guestOrder),
    ).toMatchObject({ ownerCustomerId: buyer });
    expect(safeJson({ audit: harness.audit.events })).not.toContain(
      claimMarker,
    );
    expect(safeJson({ audit: harness.audit.events })).not.toContain(
      productKeyMarker,
    );

    const real = claimHarness();
    await expect(
      real.claimService.issueGuestOrderClaim({
        checkoutEmail: "real@example.com",
        correlationId: correlationId("ks0805-real-untouched"),
        orderId: orderId(realFulfillmentId),
      }),
    ).resolves.toMatchObject({ status: "ORDER_NOT_CLAIMABLE" });
  });
});

const claimHarness = (
  options: {
    readonly trustedIssuance?: boolean;
    readonly claimDelivery?: CapturingGuestOrderClaimDeliveryPort;
    readonly tokenFactory?: () => string;
    readonly tokenSequence?: readonly string[];
  } = {},
) => {
  const identityRepository = new InMemoryCustomerOrderIdentityRepository();
  const claimRepository = new InMemoryGuestOrderClaimRepository(
    identityRepository,
  );
  const audit = new CollectingAudit();
  const claimDelivery =
    options.claimDelivery ?? new FakeGuestOrderClaimDeliveryPort();
  let tokenIndex = 0;
  const claimOptions: GuestOrderClaimServiceOptions = {
    audit,
    claimTtlMs: 604_800_000,
    delivery: claimDelivery,
    environment: "CI",
    now: () => now,
    repository: claimRepository,
    ...(options.trustedIssuance === false
      ? {}
      : { issuanceAuthority: new TrustedGuestOrderClaimIssuanceAuthority() }),
    ...(options.tokenFactory || options.tokenSequence
      ? {
          tokenFactory:
            options.tokenFactory ??
            (() =>
              options.tokenSequence?.[
                Math.min(tokenIndex++, options.tokenSequence.length - 1)
              ] ?? claimMarker),
        }
      : {}),
  };
  const claimService = new GuestOrderClaimService(claimOptions);
  const registrationService = new CustomerRegistrationService({
    audit,
    challengeRepository: new InMemoryCustomerRegistrationChallengeRepository(
      identityRepository,
    ),
    claimAuthority: new PersistedGuestOrderClaimAuthority({
      now: () => now,
      repository: claimRepository,
    }),
    delivery: new FakeCustomerEmailVerificationDeliveryPort(),
    environment: "CI",
    identityRepository,
    identityService: new CustomerOrderIdentityService({
      audit,
      now: () => now,
      repository: identityRepository,
    }),
    now: () => now,
  });
  return {
    audit,
    claimDelivery,
    claimRepository,
    claimService,
    identityRepository,
    registrationService,
  };
};

const addGuestOrder = (
  harness: ReturnType<typeof claimHarness>,
  checkoutEmailNormalized: string | null,
  owner: CustomerId | null = null,
): OrderId => {
  const id = orderId(randomUUID());
  harness.identityRepository.addOrder({
    checkoutEmailNormalized,
    customerId: owner,
    fulfillmentStatus: "PENDING",
    orderId: id,
    paymentStatus: "CAPTURED",
    procurementStatus: "SUCCEEDED",
    recordVersion: 1,
    status: "FULFILLMENT_PENDING",
    updatedAt: now,
  });
  return id;
};

const issue = (
  harness: ReturnType<typeof claimHarness>,
  order: OrderId,
  email: string,
) =>
  harness.claimService.issueGuestOrderClaim({
    checkoutEmail: email,
    correlationId: correlationId(`ks0805-issue-${order}`),
    orderId: order,
  });

const registerOnly = async (
  harness: ReturnType<typeof claimHarness>,
  email: string,
): Promise<CustomerId> => {
  await harness.registrationService.register({
    correlationId: correlationId(`ks0805-register-${email}`),
    email,
  });
  const customer =
    await harness.identityRepository.findCustomerByNormalizedEmail(email);
  if (!customer) {
    throw new Error("Expected KS-08-05 customer fixture");
  }
  return customer.id;
};

const registerAndVerify = async (
  harness: ReturnType<typeof claimHarness>,
  email: string,
): Promise<CustomerId> => {
  const id = await registerOnly(harness, email);
  const service = new CustomerOrderIdentityService({
    emailVerificationAuthority: new FakeEmailVerificationAuthority(),
    now: () => now,
    repository: harness.identityRepository,
  });
  await service.markEmailVerified({
    correlationId: correlationId(`ks0805-verify-${email}`),
    customerId: id,
    expectedCustomerVersion: 1,
  });
  return id;
};

const principal = (id: CustomerId): AuthenticatedCustomerPrincipal => ({
  authenticationContext: { assurance: "AUTHENTICATED", provider: "TEST" },
  customerId: id,
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
        providerEvidenceId: `ks0805-email:${input.correlationId}`,
        verifiedAt: now,
      },
      status: "AUTHORIZED" as const,
    };
  }
}

class FailingGuestOrderClaimDeliveryPort implements GuestOrderClaimDeliveryPort {
  public readonly deliveries: Parameters<
    GuestOrderClaimDeliveryPort["sendGuestOrderClaim"]
  >[0][] = [];

  public constructor(private readonly mode: "FAILED" | "THROW") {}

  public async sendGuestOrderClaim(
    input: Parameters<GuestOrderClaimDeliveryPort["sendGuestOrderClaim"]>[0],
  ) {
    this.deliveries.push(input);
    if (this.mode === "THROW") {
      throw new Error("synthetic claim delivery failure");
    }
    return { status: "FAILED" as const };
  }
}

type CapturingGuestOrderClaimDeliveryPort = GuestOrderClaimDeliveryPort & {
  readonly deliveries: readonly Parameters<
    GuestOrderClaimDeliveryPort["sendGuestOrderClaim"]
  >[0][];
};

class CollectingAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const safeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, child) =>
    typeof child === "bigint" ? child.toString() : child,
  );
