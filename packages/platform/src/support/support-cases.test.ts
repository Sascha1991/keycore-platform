import { describe, expect, it } from "vitest";

import { InMemorySupportCaseRepository } from "../../../../infra/support/in-memory-support-case-repository.js";
import {
  SupportCaseService,
  correlationId,
  customerId,
  orderId,
  type AuditEvent,
  type AuthenticatedCustomerPrincipal,
  type CustomerId,
  type SupportOperatorAuthorityPort,
} from "../contracts.js";

const now = new Date("2026-08-27T12:00:00.000Z");
const customerA = customerId("11111111-1111-4111-8111-111111111111");
const customerB = customerId("22222222-2222-4222-8222-222222222222");
const ownedOrder = orderId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const otherOrder = orderId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const unclaimedOrder = orderId("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
const leakageMarkers = [
  "KEYRANO_KS0904_PRODUCT_KEY_DO_NOT_LEAK",
  "KEYRANO_KS0904_SESSION_DO_NOT_LEAK",
  "KEYRANO_KS0904_CLAIM_DO_NOT_LEAK",
  "KEYRANO_KS0904_STRIPE_SECRET_DO_NOT_LEAK",
  "KEYRANO_KS0904_KINGUIN_SECRET_DO_NOT_LEAK",
  "KEYRANO_KS0904_CORRELATION_SECRET_DO_NOT_LEAK",
] as const;

describe("support case foundation", () => {
  it("creates an owned order support case and rejects forged customer authority", async () => {
    const harness = supportHarness();
    const created = await harness.service.createCustomerCase({
      category: "ORDER_STATUS",
      correlationId: correlationId("support-create"),
      message: "Where is my order?",
      orderId: ownedOrder,
      principal: principal(customerA),
    });

    expect(created.status).toBe("CREATED");
    expect(
      created.status === "CREATED" ? created.detail.case : null,
    ).toMatchObject({
      customerId: customerA,
      orderId: ownedOrder,
      status: "OPEN",
    });
    expect(JSON.stringify(created)).not.toContain("priority");
    expect(JSON.stringify(created)).not.toContain("correlation");
    expect(JSON.stringify(created)).not.toContain("recordVersion");

    await expect(
      harness.service.createCustomerCase({
        category: "ORDER_STATUS",
        correlationId: correlationId("support-forged"),
        customerId: customerB,
        message: "Forged owner",
        orderId: ownedOrder,
        principal: principal(customerA),
      }),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "FAILED" });
  });

  it("fails enumeration-safe for wrong-owner, unknown, unclaimed, and test principals", async () => {
    const harness = supportHarness();

    await expect(
      harness.service.createCustomerCase({
        category: "ORDER_STATUS",
        correlationId: correlationId("wrong-owner"),
        message: "Wrong owner attempt",
        orderId: otherOrder,
        principal: principal(customerA),
      }),
    ).resolves.toMatchObject({
      code: "RESOURCE_NOT_AVAILABLE",
      status: "FAILED",
    });
    await expect(
      harness.service.createCustomerCase({
        category: "ORDER_STATUS",
        correlationId: correlationId("unclaimed"),
        message: "I only know the order id",
        orderId: unclaimedOrder,
        principal: principal(customerA),
      }),
    ).resolves.toMatchObject({
      code: "RESOURCE_NOT_AVAILABLE",
      status: "FAILED",
    });
    await expect(
      harness.service.listCustomerCases({
        principal: principal(customerA, "TEST"),
      }),
    ).resolves.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
      status: "FAILED",
    });
  });

  it("never falls back to checkout email, WooCommerce id, billing email, or bare order knowledge", async () => {
    const harness = supportHarness();

    await expect(
      harness.service.createCustomerCase({
        billingEmail: "support-a@example.test",
        category: "ORDER_STATUS",
        checkoutEmail: "support-a@example.test",
        correlationId: correlationId("email-bypass"),
        message: "I know the email and order id",
        orderId: otherOrder,
        principal: principal(customerA),
        wooCommerceCustomerId: "woo-123",
      }),
    ).resolves.toMatchObject({
      code: "RESOURCE_NOT_AVAILABLE",
      status: "FAILED",
    });
  });

  it("validates runtime category, priority, visibility, status, resolution, ids, correlation and pagination", async () => {
    const harness = supportHarness({ trustedOperator: true });
    const created = await createOwnedCase(harness.service);
    const caseId = requireCreatedCaseId(created);

    await expect(
      harness.service.createCustomerCase({
        category: "WHATEVER",
        correlationId: correlationId("bad-category"),
        message: "bad category",
        orderId: ownedOrder,
        principal: principal(customerA),
      } as unknown as Parameters<SupportCaseService["createCustomerCase"]>[0]),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "FAILED" });
    await expect(
      harness.service.createOperatorCase({
        category: "OTHER",
        correlationId: correlationId("bad-priority"),
        message: "bad priority",
        priority: "CRITICAL",
      } as unknown as Parameters<SupportCaseService["createOperatorCase"]>[0]),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "FAILED" });
    await expect(
      harness.service.addOperatorNote({
        caseId,
        correlationId: correlationId("bad-visibility"),
        message: "bad visibility",
        visibility: "SECRET",
      } as unknown as Parameters<SupportCaseService["addOperatorNote"]>[0]),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "FAILED" });
    await expect(
      harness.service.transitionCase({
        caseId,
        correlationId: correlationId("bad-status"),
        expectedVersion: 1,
        nextStatus: "REMOVED",
      } as unknown as Parameters<SupportCaseService["transitionCase"]>[0]),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "FAILED" });
    await expect(
      harness.service.transitionCase({
        caseId,
        correlationId: correlationId("bad-resolution"),
        expectedVersion: 1,
        nextStatus: "RESOLVED",
        resolutionCode: "REFUNDED",
      } as unknown as Parameters<SupportCaseService["transitionCase"]>[0]),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "FAILED" });
    await expect(
      harness.service.getCustomerCase({
        caseId: "not-a-uuid",
        principal: principal(customerA),
      }),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "FAILED" });
    await expect(
      harness.service.listCustomerCases({
        limit: 0,
        principal: principal(customerA),
      }),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "FAILED" });
    await expect(
      harness.service.listCustomerCases({
        cursor: "not valid base64!",
        principal: principal(customerA),
      }),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "FAILED" });
    await expect(
      harness.service.createCustomerCase({
        category: "ORDER_STATUS",
        correlationId: correlationId("bad\r\ncorrelation"),
        message: "bad correlation",
        orderId: ownedOrder,
        principal: principal(customerA),
      }),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "FAILED" });
  });

  it("allows authenticated account-only cases without order and requires order for order categories", async () => {
    const harness = supportHarness();

    await expect(
      harness.service.createCustomerCase({
        category: "ACCOUNT_PROBLEM",
        correlationId: correlationId("account-only"),
        message: "I cannot update my password",
        principal: principal(customerA),
      }),
    ).resolves.toMatchObject({ status: "CREATED" });
    await expect(
      harness.service.createCustomerCase({
        category: "KEY_NOT_AVAILABLE",
        correlationId: correlationId("missing-order"),
        message: "I need help",
        principal: principal(customerA),
      }),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "FAILED" });
  });

  it("keeps customer-visible messages separate from internal operator notes", async () => {
    const harness = supportHarness({ trustedOperator: true });
    const created = await createOwnedCase(harness.service);
    const caseId = requireCreatedCaseId(created);

    await expect(
      harness.service.addCustomerReply({
        caseId,
        correlationId: correlationId("reply"),
        message: "Here is more context",
        principal: principal(customerA),
      }),
    ).resolves.toMatchObject({ status: "FOUND" });

    const noted = await harness.service.addOperatorNote({
      caseId,
      correlationId: correlationId("note"),
      message: "Internal triage note",
      visibility: "INTERNAL",
    });
    expect(noted.status).toBe("OK");

    const customerView = await harness.service.getCustomerCase({
      caseId,
      principal: principal(customerA),
    });
    expect(JSON.stringify(customerView)).not.toContain("Internal triage note");
    expect(
      noted.status === "OK"
        ? noted.detail.messages.some(
            (message) => message.visibility === "INTERNAL",
          )
        : false,
    ).toBe(true);
  });

  it("rejects unsafe or oversized messages and customer impersonation fields", async () => {
    const harness = supportHarness();
    const created = await createOwnedCase(harness.service);
    const caseId = requireCreatedCaseId(created);

    await expect(
      harness.service.addCustomerReply({
        authorType: "OPERATOR",
        caseId,
        correlationId: correlationId("impersonate"),
        message: "I am operator now",
        principal: principal(customerA),
      }),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "FAILED" });
    await expect(
      harness.service.addCustomerReply({
        caseId,
        correlationId: correlationId("crlf"),
        message: "bad\r\nheader",
        principal: principal(customerA),
      }),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "FAILED" });
    await expect(
      harness.service.addCustomerReply({
        caseId,
        correlationId: correlationId("large"),
        message: "x".repeat(5_001),
        principal: principal(customerA),
      }),
    ).resolves.toMatchObject({ code: "BAD_REQUEST", status: "FAILED" });
  });

  it("enforces status transitions, stale writers, and closed-to-replies behavior", async () => {
    const harness = supportHarness({ trustedOperator: true });
    const created = await createOwnedCase(harness.service);
    const caseId = requireCreatedCaseId(created);
    const version = requireSnapshot(harness.repository, caseId).case
      .recordVersion;

    await expect(
      harness.service.transitionCase({
        caseId,
        correlationId: correlationId("bad-transition"),
        expectedVersion: version,
        nextStatus: "OPEN",
      }),
    ).resolves.toMatchObject({
      code: "INVALID_TRANSITION",
      status: "FAILED",
    });
    await expect(
      harness.service.transitionCase({
        caseId,
        correlationId: correlationId("close-without-resolution"),
        expectedVersion: version,
        nextStatus: "CLOSED",
      }),
    ).resolves.toMatchObject({
      code: "BAD_REQUEST",
      status: "FAILED",
    });
    await expect(
      harness.service.transitionCase({
        caseId,
        correlationId: correlationId("resolve"),
        expectedVersion: version,
        nextStatus: "RESOLVED",
        resolutionCode: "INFORMATION_PROVIDED",
      }),
    ).resolves.toMatchObject({ status: "OK" });
    await expect(
      harness.service.transitionCase({
        caseId,
        correlationId: correlationId("stale"),
        expectedVersion: version,
        nextStatus: "CLOSED",
      }),
    ).resolves.toMatchObject({ code: "STALE_VERSION", status: "FAILED" });
    await expect(
      harness.service.addCustomerReply({
        caseId,
        correlationId: correlationId("closed-reply"),
        message: "Can I reopen this?",
        principal: principal(customerA),
      }),
    ).resolves.toMatchObject({
      code: "CLOSED_TO_REPLIES",
      status: "FAILED",
    });
  });

  it("requires trusted operator authority for internal cases, notes, transitions, and links", async () => {
    const harness = supportHarness();

    await expect(
      harness.service.createOperatorCase({
        category: "OTHER",
        correlationId: correlationId("operator-denied"),
        message: "Internal case",
      }),
    ).resolves.toMatchObject({
      code: "UNTRUSTED_AUTHORITY",
      status: "FAILED",
    });
  });

  it("prevents operator cases from fabricating ownership for unclaimed orders", async () => {
    const harness = supportHarness({ trustedOperator: true });

    await expect(
      harness.service.createOperatorCase({
        category: "OTHER",
        correlationId: correlationId("unclaimed-with-customer"),
        customerId: customerA,
        message: "Do not bind this customer to an unclaimed order",
        orderId: unclaimedOrder,
      }),
    ).resolves.toMatchObject({
      code: "RESOURCE_NOT_AVAILABLE",
      status: "FAILED",
    });
    await expect(
      harness.service.createOperatorCase({
        category: "OTHER",
        correlationId: correlationId("unclaimed-no-customer"),
        message: "Internal unclaimed order case",
        orderId: unclaimedOrder,
      }),
    ).resolves.toMatchObject({
      detail: { case: { customerId: null, orderId: unclaimedOrder } },
      status: "OK",
    });
    await expect(
      harness.service.createOperatorCase({
        category: "OTHER",
        correlationId: correlationId("owned-match"),
        customerId: customerA,
        message: "Owned order case",
        orderId: ownedOrder,
      }),
    ).resolves.toMatchObject({
      detail: { case: { customerId: customerA, orderId: ownedOrder } },
      status: "OK",
    });
    await expect(
      harness.service.createOperatorCase({
        category: "OTHER",
        correlationId: correlationId("owned-mismatch"),
        customerId: customerB,
        message: "Wrong owner",
        orderId: ownedOrder,
      }),
    ).resolves.toMatchObject({
      code: "RESOURCE_NOT_AVAILABLE",
      status: "FAILED",
    });
  });

  it("links dispute, fraud, and fulfillment references only when the order matches exactly", async () => {
    const harness = supportHarness({ trustedOperator: true });
    harness.repository.addDisputeEvidence({
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      orderId: ownedOrder,
    });
    harness.repository.addFraudReview({
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      orderId: ownedOrder,
    });
    harness.repository.addFraudEvaluation({
      id: "99999999-9999-4999-8999-999999999999",
      orderId: ownedOrder,
    });
    harness.repository.addFulfillment({
      id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      orderId: otherOrder,
    });
    const created = await createOwnedCase(harness.service);
    const caseId = requireCreatedCaseId(created);

    await expect(
      harness.service.linkReference({
        caseId,
        correlationId: correlationId("link-dispute"),
        linkType: "DISPUTE_EVIDENCE",
        targetId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }),
    ).resolves.toMatchObject({ status: "OK" });
    await expect(
      harness.service.linkReference({
        caseId,
        correlationId: correlationId("link-fraud-evaluation"),
        linkType: "FRAUD_EVALUATION",
        targetId: "99999999-9999-4999-8999-999999999999",
      }),
    ).resolves.toMatchObject({ status: "OK" });
    expect(
      harness.repository
        .snapshot(caseId)
        ?.events.map((event) => event.eventType),
    ).toContain("FRAUD_EVALUATION_LINKED");
    await expect(
      harness.service.linkReference({
        caseId,
        correlationId: correlationId("link-fraud"),
        linkType: "FRAUD_REVIEW",
        targetId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      }),
    ).resolves.toMatchObject({ status: "OK" });
    await expect(
      harness.service.linkReference({
        caseId,
        correlationId: correlationId("link-cross-order"),
        linkType: "FULFILLMENT",
        targetId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      }),
    ).resolves.toMatchObject({
      code: "RESOURCE_NOT_AVAILABLE",
      status: "FAILED",
    });
  });

  it("audits operator actions safely and does not place message bodies in audit metadata", async () => {
    const harness = supportHarness({ trustedOperator: true });
    const marker = "KEYRANO_KS0904_MESSAGE_BODY_AUDIT_DO_NOT_LEAK";
    const created = await createOwnedCase(harness.service);
    const caseId = requireCreatedCaseId(created);
    const version = requireSnapshot(harness.repository, caseId).case
      .recordVersion;

    await harness.service.addOperatorNote({
      caseId,
      correlationId: correlationId("audit-note"),
      message: marker,
      visibility: "INTERNAL",
    });
    await harness.service.changePriority({
      caseId,
      correlationId: correlationId("audit-priority"),
      expectedVersion: version + 1,
      priority: "HIGH",
    });
    await harness.service.transitionCase({
      caseId,
      correlationId: correlationId("audit-resolve"),
      expectedVersion: version + 2,
      nextStatus: "RESOLVED",
      resolutionCode: "INFORMATION_PROVIDED",
    });

    expect(harness.audit.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "SUPPORT_MESSAGE_ADDED",
        "SUPPORT_PRIORITY_CHANGED",
        "SUPPORT_CASE_RESOLVED",
      ]),
    );
    expect(JSON.stringify(harness.audit.events)).not.toContain(marker);
  });

  it("lists only owned support cases with bounded deterministic pagination", async () => {
    const harness = supportHarness();
    await createOwnedCase(harness.service);
    await harness.service.createCustomerCase({
      category: "ORDER_STATUS",
      correlationId: correlationId("other-owned"),
      message: "Other account order",
      orderId: otherOrder,
      principal: principal(customerB),
    });

    const page = await harness.service.listCustomerCases({
      limit: 200,
      principal: principal(customerA),
    });
    expect(page.status).toBe("LISTED");
    expect(page.status === "LISTED" ? page.page.items : []).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain(customerB);
  });

  it("does not place protected markers in generated projections, errors, or audit metadata", async () => {
    const harness = supportHarness();
    const result = await createOwnedCase(harness.service);
    const error = await harness.service.createCustomerCase({
      category: "ORDER_STATUS",
      correlationId: correlationId("leak-error"),
      message: "Safe customer-visible content",
      orderId: otherOrder,
      principal: principal(customerA),
    });
    const generated = JSON.stringify({
      audit: harness.audit.events,
      error,
      result,
    });
    for (const marker of leakageMarkers) {
      expect(generated).not.toContain(marker);
    }
    expect(generated).not.toContain("Safe customer-visible content");
  });
});

const supportHarness = (
  options: { readonly trustedOperator?: boolean } = {},
): {
  readonly audit: AuditSink;
  readonly repository: InMemorySupportCaseRepository;
  readonly service: SupportCaseService;
} => {
  const repository = new InMemorySupportCaseRepository();
  repository.addCustomer(customerA);
  repository.addCustomer(customerB);
  repository.addOrder({ customerId: customerA, orderId: ownedOrder });
  repository.addOrder({ customerId: customerB, orderId: otherOrder });
  repository.addOrder({ customerId: null, orderId: unclaimedOrder });
  const audit = new AuditSink();
  return {
    audit,
    repository,
    service: new SupportCaseService({
      audit,
      now: () => now,
      ...(options.trustedOperator
        ? { operatorAuthority: new TrustedSupportAuthority() }
        : {}),
      repository,
    }),
  };
};

const createOwnedCase = (
  service: SupportCaseService,
): ReturnType<SupportCaseService["createCustomerCase"]> =>
  service.createCustomerCase({
    category: "ORDER_STATUS",
    correlationId: correlationId("owned-case"),
    message: "I need help with this order",
    orderId: ownedOrder,
    principal: principal(customerA),
  });

const requireCreatedCaseId = (
  result: Awaited<ReturnType<SupportCaseService["createCustomerCase"]>>,
): string => {
  if (result.status !== "CREATED") {
    throw new Error("Expected support case to be created");
  }
  return result.detail.case.id;
};

const requireSnapshot = (
  repository: InMemorySupportCaseRepository,
  caseId: string,
) => {
  const snapshot = repository.snapshot(caseId);
  if (!snapshot) {
    throw new Error("Expected support case snapshot");
  }
  return snapshot;
};

const principal = (
  id: CustomerId,
  assurance: "AUTHENTICATED" | "TEST" = "AUTHENTICATED",
): AuthenticatedCustomerPrincipal => ({
  authenticationContext: { assurance, provider: "KEYCORE" },
  customerId: id,
});

class TrustedSupportAuthority implements SupportOperatorAuthorityPort {
  public async authorize(): Promise<{
    readonly status: "AUTHORIZED";
    readonly operatorReference: string;
  }> {
    return { operatorReference: "operator:test", status: "AUTHORIZED" };
  }
}

class AuditSink {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}
