import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { InMemoryFraudRiskRepository } from "../../../../infra/fraud/in-memory-fraud-risk-repository.js";
import {
  FraudRiskService,
  canonicalFraudRiskFacts,
  correlationId,
  currency,
  evaluateFraudRiskFacts,
  fraudRiskFactFingerprint,
  customerId,
  money,
  orderId,
  productId,
  riskFactsFromOrder,
  type AuditEvent,
  type FraudManualReviewAuthorityPort,
  type FraudRiskFacts,
  type FraudRiskRule,
  type KeyCoreOrder,
} from "../contracts.js";

const now = new Date("2026-08-27T09:00:00.000Z");
const leakageMarkers = [
  "KEYRANO_KS0901_PRODUCT_KEY_DO_NOT_LEAK",
  "KEYRANO_KS0901_STRIPE_SECRET_DO_NOT_LEAK",
  "KEYRANO_KS0901_KINGUIN_SECRET_DO_NOT_LEAK",
  "KEYRANO_KS0901_SESSION_DO_NOT_LEAK",
  "KEYRANO_KS0901_CLAIM_CODE_DO_NOT_LEAK",
  "KEYRANO_KS0901_RULE_SECRET_DO_NOT_LEAK",
] as const;

describe("fraud risk and manual review foundation", () => {
  it("allows normal trusted facts with persisted policy version and deterministic reasons", async () => {
    const harness = fraudHarness();
    const result = await harness.service.evaluateOrder({
      correlationId: correlationId("fraud-allow"),
      orderId: harness.orders.allow.id,
    });

    expect(result.status).toBe("EVALUATED");
    expect(
      result.status === "EVALUATED" ? result.evaluation : null,
    ).toMatchObject({
      decision: "ALLOW",
      policyVersion: "KS09_POLICY_V1",
      reasonCodes: ["RISK_POLICY_ALLOW"],
      riskScore: 0,
    });
    await expect(
      harness.service.isFraudCleared(harness.orders.allow.id),
    ).resolves.toMatchObject({
      status: "CLEARED",
    });
  });

  it("returns REVIEW for conservative review rules without overblocking unclaimed guest checkout", async () => {
    const harness = fraudHarness();
    const pending = await harness.service.evaluateOrder({
      correlationId: correlationId("fraud-pending-payment"),
      orderId: harness.orders.paymentPending.id,
    });
    const guest = await harness.service.evaluateOrder({
      correlationId: correlationId("fraud-guest"),
      orderId: harness.orders.guestCaptured.id,
    });

    expect(pending).toMatchObject({
      evaluation: {
        decision: "REVIEW",
        reasonCodes: ["PAYMENT_NOT_CONFIRMED"],
      },
      reviewCase: { source: "FRAUD", status: "OPEN" },
      status: "EVALUATED",
    });
    expect(guest).toMatchObject({
      evaluation: { decision: "ALLOW", reasonCodes: ["RISK_POLICY_ALLOW"] },
      status: "EVALUATED",
    });
  });

  it("returns DENY for severe trusted facts and preserves deterministic precedence", async () => {
    const harness = fraudHarness();
    const result = await harness.service.evaluateOrder({
      correlationId: correlationId("fraud-deny-wins"),
      orderId: harness.orders.failedPending.id,
    });

    expect(result).toMatchObject({
      evaluation: {
        decision: "DENY",
        reasonCodes: ["ORDER_STATE_INVALID", "PAYMENT_NOT_CONFIRMED"],
        riskScore: 100,
      },
      status: "EVALUATED",
    });
    await expect(
      harness.service.isFraudCleared(harness.orders.failedPending.id),
    ).resolves.toEqual({
      reasonCode: "FRAUD_DENIED",
      status: "BLOCKED",
    });
  });

  it("fails closed when facts are missing, repositories fail, or a rule throws", async () => {
    const harness = fraudHarness();
    await expect(
      harness.service.evaluateOrder({
        correlationId: correlationId("fraud-missing"),
        orderId: orderId("99999999-9999-4999-8999-999999999999"),
      }),
    ).resolves.toEqual({
      reasonCode: "RISK_FACTS_UNAVAILABLE",
      status: "UNAVAILABLE",
    });
    await expect(
      new FraudRiskService({
        repository: new ThrowingFraudRiskRepository(),
      }).isFraudCleared(harness.orders.allow.id),
    ).resolves.toEqual({
      reasonCode: "FRAUD_REPOSITORY_UNAVAILABLE",
      status: "BLOCKED",
    });
    const throwingRule: FraudRiskRule = {
      evaluate: () => {
        throw new Error(leakageMarkers.join(" "));
      },
      id: "THROWING_SYNTHETIC_RULE",
    };
    const throwing = await new FraudRiskService({
      repository: harness.repository,
      rules: [throwingRule],
    }).evaluateOrder({
      correlationId: correlationId("fraud-rule-throws"),
      orderId: harness.orders.allow.id,
    });
    expect(throwing).toMatchObject({
      evaluation: {
        decision: "REVIEW",
        reasonCodes: ["RISK_RULE_EXCEPTION"],
      },
      status: "EVALUATED",
    });
    expect(safeJson([throwing, harness.audit.events])).not.toMatch(
      /PRODUCT_KEY|STRIPE_SECRET|KINGUIN_SECRET|SESSION|CLAIM_CODE/iu,
    );
  });

  it("is idempotent for the same facts and creates a new evaluation after facts change", async () => {
    const harness = fraudHarness();
    const first = await harness.service.evaluateOrder({
      correlationId: correlationId("fraud-idempotent-1"),
      orderId: harness.orders.paymentPending.id,
    });
    const second = await harness.service.evaluateOrder({
      correlationId: correlationId("fraud-idempotent-2"),
      orderId: harness.orders.paymentPending.id,
    });
    expect(first.status).toBe("EVALUATED");
    expect(second.status).toBe("EVALUATED");
    expect(
      second.status === "EVALUATED" ? second.evaluation.riskDecisionId : null,
    ).toBe(
      first.status === "EVALUATED" ? first.evaluation.riskDecisionId : null,
    );
    harness.repository.addOrder({
      ...harness.orders.paymentPending,
      paymentStatus: "CAPTURED",
      riskStatus: "NOT_EVALUATED",
      updatedAt: new Date(now.getTime() + 1_000),
    });
    const changed = await harness.service.evaluateOrder({
      correlationId: correlationId("fraud-idempotent-changed"),
      orderId: harness.orders.paymentPending.id,
    });
    expect(changed).toMatchObject({
      evaluation: { decision: "ALLOW" },
      status: "EVALUATED",
    });
    expect(
      changed.status === "EVALUATED" ? changed.evaluation.riskDecisionId : null,
    ).not.toBe(
      first.status === "EVALUATED" ? first.evaluation.riskDecisionId : null,
    );
  });

  it("keeps concurrent REVIEW evaluation to one active fraud case", async () => {
    const harness = fraudHarness();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        harness.service.evaluateOrder({
          correlationId: correlationId(`fraud-concurrent-${index}`),
          orderId: harness.orders.paymentPending.id,
        }),
      ),
    );
    const ids = new Set(
      results.map((result) =>
        result.status === "EVALUATED" ? result.evaluation.riskDecisionId : "",
      ),
    );
    const caseIds = new Set(
      results.map((result) =>
        result.status === "EVALUATED" ? (result.reviewCase?.caseId ?? "") : "",
      ),
    );
    expect(ids.size).toBe(1);
    expect(caseIds.size).toBe(1);
  });

  it("requires trusted authority for review resolution and never performs downstream actions", async () => {
    const harness = fraudHarness();
    const review = await harness.service.evaluateOrder({
      correlationId: correlationId("fraud-review-open"),
      orderId: harness.orders.paymentPending.id,
    });
    if (review.status !== "EVALUATED" || !review.reviewCase) {
      throw new Error("expected review case");
    }
    await expect(
      harness.service.resolveManualReview({
        caseId: review.reviewCase.caseId,
        correlationId: correlationId("fraud-review-default-denied"),
        expectedFactFingerprint: review.evaluation.factFingerprint,
        resolution: "APPROVE",
      }),
    ).resolves.toEqual({
      reasonCode: "FRAUD_OPERATOR_AUTHORITY_DENIED",
      status: "DENIED",
    });

    const approvedService = new FraudRiskService({
      manualReviewAuthority: new TrustedFraudAuthority("operator:test"),
      repository: harness.repository,
    });
    const approved = await approvedService.resolveManualReview({
      caseId: review.reviewCase.caseId,
      correlationId: correlationId("fraud-review-approve"),
      expectedFactFingerprint: review.evaluation.factFingerprint,
      resolution: "APPROVE",
    });
    expect(approved).toMatchObject({
      reviewCase: {
        operatorReference: "operator:test",
        resolution: "APPROVED",
        status: "APPROVED",
      },
      status: "RESOLVED",
    });
    await expect(
      approvedService.isFraudCleared(harness.orders.paymentPending.id),
    ).resolves.toMatchObject({
      status: "CLEARED",
    });
    await expect(
      approvedService.resolveManualReview({
        caseId: review.reviewCase.caseId,
        correlationId: correlationId("fraud-review-replay"),
        expectedFactFingerprint: review.evaluation.factFingerprint,
        resolution: "APPROVE",
      }),
    ).resolves.toMatchObject({ status: "ALREADY_RESOLVED" });
    expect(harness.sideEffects).toEqual({
      decryptCalls: 0,
      deliveryCalls: 0,
      kinguinCalls: 0,
      stripeMutations: 0,
    });
  });

  it("keeps rejected manual review blocked", async () => {
    const harness = fraudHarness();
    const review = await harness.service.evaluateOrder({
      correlationId: correlationId("fraud-review-reject-open"),
      orderId: harness.orders.paymentPending.id,
    });
    if (review.status !== "EVALUATED" || !review.reviewCase) {
      throw new Error("expected review case");
    }
    const service = new FraudRiskService({
      manualReviewAuthority: new TrustedFraudAuthority("operator:reject"),
      repository: harness.repository,
    });
    await expect(
      service.resolveManualReview({
        caseId: review.reviewCase.caseId,
        correlationId: correlationId("fraud-review-reject"),
        expectedFactFingerprint: review.evaluation.factFingerprint,
        resolution: "REJECT",
      }),
    ).resolves.toMatchObject({
      reviewCase: { resolution: "REJECTED", status: "REJECTED" },
      status: "RESOLVED",
    });
    await expect(
      service.isFraudCleared(harness.orders.paymentPending.id),
    ).resolves.toEqual({
      reasonCode: "FRAUD_REVIEW_REQUIRED",
      status: "BLOCKED",
    });
  });

  it("does not let stale review approval authorize changed facts", async () => {
    const harness = fraudHarness();
    const review = await harness.service.evaluateOrder({
      correlationId: correlationId("fraud-stale-open"),
      orderId: harness.orders.paymentPending.id,
    });
    if (review.status !== "EVALUATED" || !review.reviewCase) {
      throw new Error("expected review case");
    }
    harness.repository.addOrder({
      ...harness.orders.paymentPending,
      paymentStatus: "CAPTURED",
      updatedAt: new Date(now.getTime() + 2_000),
    });
    await harness.service.evaluateOrder({
      correlationId: correlationId("fraud-stale-changed"),
      orderId: harness.orders.paymentPending.id,
    });
    const approvedService = new FraudRiskService({
      manualReviewAuthority: new TrustedFraudAuthority("operator:test"),
      repository: harness.repository,
    });

    await expect(
      approvedService.resolveManualReview({
        caseId: review.reviewCase.caseId,
        correlationId: correlationId("fraud-stale-approve"),
        expectedFactFingerprint: review.evaluation.factFingerprint,
        resolution: "APPROVE",
      }),
    ).resolves.toEqual({
      reasonCode: "FRAUD_REVIEW_STALE",
      status: "DENIED",
    });
  });

  it("does not treat approved stale facts as blanket permanent clearance", async () => {
    const harness = fraudHarness();
    const approvedService = new FraudRiskService({
      manualReviewAuthority: new TrustedFraudAuthority("operator:stale"),
      repository: harness.repository,
    });
    const review = await requireReview(
      harness.service,
      harness.orders.paymentPending.id,
      "fraud-stale-clear-open",
    );
    await approvedService.resolveManualReview({
      caseId: review.reviewCase.caseId,
      correlationId: correlationId("fraud-stale-clear-approve"),
      expectedFactFingerprint: review.evaluation.factFingerprint,
      resolution: "APPROVE",
    });
    await expect(
      approvedService.isFraudCleared(harness.orders.paymentPending.id),
    ).resolves.toMatchObject({ status: "CLEARED" });

    harness.repository.addOrder({
      ...harness.orders.paymentPending,
      paymentStatus: "CAPTURED",
      updatedAt: new Date(now.getTime() + 3_000),
    });

    await expect(
      approvedService.isFraudCleared(harness.orders.paymentPending.id),
    ).resolves.toEqual({
      reasonCode: "FRAUD_DECISION_MISSING",
      status: "BLOCKED",
    });
  });

  it("does not let an approved REVIEW override a newer DENY", async () => {
    const harness = fraudHarness();
    const service = new FraudRiskService({
      manualReviewAuthority: new TrustedFraudAuthority("operator:deny"),
      repository: harness.repository,
    });
    const review = await requireReview(
      harness.service,
      harness.orders.paymentPending.id,
      "fraud-approved-then-deny-open",
    );
    await service.resolveManualReview({
      caseId: review.reviewCase.caseId,
      correlationId: correlationId("fraud-approved-then-deny-approve"),
      expectedFactFingerprint: review.evaluation.factFingerprint,
      resolution: "APPROVE",
    });
    harness.repository.addOrder({
      ...harness.orders.paymentPending,
      paymentStatus: "PENDING",
      status: "FAILED",
      updatedAt: new Date(now.getTime() + 4_000),
    });
    const deny = await service.evaluateOrder({
      correlationId: correlationId("fraud-approved-then-deny-evaluate"),
      orderId: harness.orders.paymentPending.id,
    });

    expect(deny).toMatchObject({
      evaluation: { decision: "DENY" },
      status: "EVALUATED",
    });
    await expect(
      service.isFraudCleared(harness.orders.paymentPending.id),
    ).resolves.toEqual({
      reasonCode: "FRAUD_DENIED",
      status: "BLOCKED",
    });
  });

  it("requires a new current review case after approved REVIEW facts change to REVIEW again", async () => {
    const harness = fraudHarness();
    const service = new FraudRiskService({
      manualReviewAuthority: new TrustedFraudAuthority("operator:review"),
      repository: harness.repository,
    });
    const first = await requireReview(
      harness.service,
      harness.orders.paymentPending.id,
      "fraud-approved-then-review-open",
    );
    await service.resolveManualReview({
      caseId: first.reviewCase.caseId,
      correlationId: correlationId("fraud-approved-then-review-approve"),
      expectedFactFingerprint: first.evaluation.factFingerprint,
      resolution: "APPROVE",
    });
    harness.repository.addOrder({
      ...harness.orders.paymentPending,
      currency: currency("USD"),
      paymentStatus: "CAPTURED",
      status: "PAYMENT_CAPTURED",
      updatedAt: new Date(now.getTime() + 5_000),
    });
    const second = await service.evaluateOrder({
      correlationId: correlationId("fraud-approved-then-review-evaluate"),
      orderId: harness.orders.paymentPending.id,
    });

    expect(second).toMatchObject({
      evaluation: {
        decision: "REVIEW",
        reasonCodes: ["CURRENCY_UNSUPPORTED"],
      },
      reviewCase: { source: "FRAUD", status: "OPEN" },
      status: "EVALUATED",
    });
    expect(
      second.status === "EVALUATED" ? second.reviewCase?.caseId : null,
    ).not.toBe(first.reviewCase.caseId);
    await expect(
      service.isFraudCleared(harness.orders.paymentPending.id),
    ).resolves.toEqual({
      reasonCode: "FRAUD_REVIEW_REQUIRED",
      status: "BLOCKED",
    });
  });

  it("keeps review resolution immutable across replay and conflicting replay", async () => {
    const approvedHarness = fraudHarness();
    const approveService = new FraudRiskService({
      manualReviewAuthority: new TrustedFraudAuthority("operator:approve"),
      repository: approvedHarness.repository,
    });
    const approved = await requireReview(
      approvedHarness.service,
      approvedHarness.orders.paymentPending.id,
      "fraud-replay-approve-open",
    );
    await approveService.resolveManualReview({
      caseId: approved.reviewCase.caseId,
      correlationId: correlationId("fraud-replay-approve"),
      expectedFactFingerprint: approved.evaluation.factFingerprint,
      resolution: "APPROVE",
    });
    await expect(
      approveService.resolveManualReview({
        caseId: approved.reviewCase.caseId,
        correlationId: correlationId("fraud-replay-approve-reject"),
        expectedFactFingerprint: approved.evaluation.factFingerprint,
        resolution: "REJECT",
      }),
    ).resolves.toMatchObject({
      reviewCase: { resolution: "APPROVED", status: "APPROVED" },
      status: "ALREADY_RESOLVED",
    });

    const rejectedHarness = fraudHarness();
    const rejectService = new FraudRiskService({
      manualReviewAuthority: new TrustedFraudAuthority("operator:reject"),
      repository: rejectedHarness.repository,
    });
    const rejected = await requireReview(
      rejectedHarness.service,
      rejectedHarness.orders.paymentPending.id,
      "fraud-replay-reject-open",
    );
    await rejectService.resolveManualReview({
      caseId: rejected.reviewCase.caseId,
      correlationId: correlationId("fraud-replay-reject"),
      expectedFactFingerprint: rejected.evaluation.factFingerprint,
      resolution: "REJECT",
    });
    await expect(
      rejectService.resolveManualReview({
        caseId: rejected.reviewCase.caseId,
        correlationId: correlationId("fraud-replay-reject-approve"),
        expectedFactFingerprint: rejected.evaluation.factFingerprint,
        resolution: "APPROVE",
      }),
    ).resolves.toMatchObject({
      reviewCase: { resolution: "REJECTED", status: "REJECTED" },
      status: "ALREADY_RESOLVED",
    });
  });

  it("keeps concurrent APPROVE versus REJECT to one durable resolution", async () => {
    const harness = fraudHarness();
    const service = new FraudRiskService({
      manualReviewAuthority: new TrustedFraudAuthority("operator:race"),
      repository: harness.repository,
    });
    const review = await requireReview(
      harness.service,
      harness.orders.paymentPending.id,
      "fraud-resolution-race-open",
    );

    const results = await Promise.all([
      service.resolveManualReview({
        caseId: review.reviewCase.caseId,
        correlationId: correlationId("fraud-resolution-race-approve"),
        expectedFactFingerprint: review.evaluation.factFingerprint,
        resolution: "APPROVE",
      }),
      service.resolveManualReview({
        caseId: review.reviewCase.caseId,
        correlationId: correlationId("fraud-resolution-race-reject"),
        expectedFactFingerprint: review.evaluation.factFingerprint,
        resolution: "REJECT",
      }),
    ]);
    const finalStatuses = new Set(
      results.map((result) =>
        result.status === "DENIED"
          ? result.status
          : `${result.status}:${result.reviewCase.status}`,
      ),
    );

    expect(
      results.filter((result) => result.status === "RESOLVED"),
    ).toHaveLength(1);
    expect(finalStatuses.size).toBeGreaterThanOrEqual(1);
    const caseState = await harness.repository.findFraudReviewCaseById(
      review.reviewCase.caseId,
    );
    expect(
      caseState?.status === "APPROVED" || caseState?.status === "REJECTED",
    ).toBe(true);
  });

  it("keeps clearance guard fail-closed across the state matrix", async () => {
    const harness = fraudHarness();

    await expect(
      harness.service.isFraudCleared(harness.orders.paymentPending.id),
    ).resolves.toEqual({
      reasonCode: "FRAUD_DECISION_MISSING",
      status: "BLOCKED",
    });
    await harness.service.evaluateOrder({
      correlationId: correlationId("fraud-matrix-open"),
      orderId: harness.orders.paymentPending.id,
    });
    await expect(
      harness.service.isFraudCleared(harness.orders.paymentPending.id),
    ).resolves.toEqual({
      reasonCode: "FRAUD_REVIEW_REQUIRED",
      status: "BLOCKED",
    });
    await harness.service.evaluateOrder({
      correlationId: correlationId("fraud-matrix-deny"),
      orderId: harness.orders.failedPending.id,
    });
    await expect(
      harness.service.isFraudCleared(harness.orders.failedPending.id),
    ).resolves.toEqual({
      reasonCode: "FRAUD_DENIED",
      status: "BLOCKED",
    });
  });

  it("canonicalizes and fingerprints only stable material facts and policy version", () => {
    const facts = fraudFacts(harnessOrder());
    const sameFactsDifferentPropertyOrder: FraudRiskFacts = {
      orderId: facts.orderId,
      customerId: facts.customerId ?? null,
      customerVerificationState: facts.customerVerificationState ?? null,
      checkoutEmailSnapshotPresent: facts.checkoutEmailSnapshotPresent,
      orderAmountMinor: facts.orderAmountMinor,
      currency: facts.currency,
      orderStatus: facts.orderStatus,
      paymentStatus: facts.paymentStatus,
      orderRiskStatus: facts.orderRiskStatus,
      createdAt: new Date(facts.createdAt.toISOString()),
    };
    const baseFingerprint = fraudRiskFactFingerprint(facts);

    expect(fraudRiskFactFingerprint(sameFactsDifferentPropertyOrder)).toBe(
      baseFingerprint,
    );
    expect(canonicalFraudRiskFacts(facts)).toEqual(
      canonicalFraudRiskFacts(sameFactsDifferentPropertyOrder),
    );
    expect(fraudRiskFactFingerprint(facts, "KS09_POLICY_V2")).not.toBe(
      baseFingerprint,
    );

    const materialMutations: readonly FraudRiskFacts[] = [
      {
        ...facts,
        checkoutEmailSnapshotPresent: !facts.checkoutEmailSnapshotPresent,
      },
      { ...facts, currency: "USD" },
      {
        ...facts,
        customerId: customerId("22222222-2222-4222-8222-222222222222"),
      },
      { ...facts, customerVerificationState: "UNVERIFIED" },
      { ...facts, orderAmountMinor: facts.orderAmountMinor + 1n },
      { ...facts, orderRiskStatus: "REVIEW_REQUIRED" },
      { ...facts, orderStatus: "FAILED" },
      { ...facts, paymentStatus: "PENDING" },
      { ...facts, createdAt: new Date(facts.createdAt.getTime() + 1_000) },
    ];
    for (const mutation of materialMutations) {
      expect(fraudRiskFactFingerprint(mutation)).not.toBe(baseFingerprint);
    }
  });

  it("keeps rule precedence and reason projection deterministic independent of rule order", () => {
    const facts = fraudFacts(harnessOrder());
    const duplicateReview: FraudRiskRule = {
      evaluate: () => ({
        decision: "REVIEW",
        reasonCode: "PAYMENT_NOT_CONFIRMED",
        score: 30,
      }),
      id: "DUPLICATE_REVIEW",
    };
    const deny: FraudRiskRule = {
      evaluate: () => ({
        decision: "DENY",
        reasonCode: "ORDER_STATE_INVALID",
        score: 100,
      }),
      id: "DENY",
    };
    const review: FraudRiskRule = {
      evaluate: () => ({
        decision: "REVIEW",
        reasonCode: "PAYMENT_NOT_CONFIRMED",
        score: 70,
      }),
      id: "REVIEW",
    };

    for (const rules of [
      [deny, review, duplicateReview],
      [review, duplicateReview, deny],
      [duplicateReview, deny, review],
    ]) {
      expect(evaluateFraudRiskFacts(facts, { rules })).toEqual({
        decision: "DENY",
        reasonCodes: ["ORDER_STATE_INVALID", "PAYMENT_NOT_CONFIRMED"],
        riskScore: 100,
      });
    }
  });

  it("ignores request-supplied fake risk fields because the order repository is authoritative", async () => {
    const harness = fraudHarness();
    const requestBody = {
      customerId: customerId("99999999-9999-4999-8999-999999999999"),
      paymentStatus: "CAPTURED",
      riskDecision: "ALLOW",
      riskScore: 0,
    };
    const result = await harness.service.evaluateOrder({
      correlationId: correlationId(
        `fraud-request-${safeJson(requestBody).length}`,
      ),
      orderId: harness.orders.paymentPending.id,
    });

    expect(result).toMatchObject({
      evaluation: {
        decision: "REVIEW",
        reasonCodes: ["PAYMENT_NOT_CONFIRMED"],
      },
      status: "EVALUATED",
    });
  });
});

const requireReview = async (
  service: FraudRiskService,
  requestedOrderId: ReturnType<typeof orderId>,
  marker: string,
) => {
  const result = await service.evaluateOrder({
    correlationId: correlationId(marker),
    orderId: requestedOrderId,
  });
  if (result.status !== "EVALUATED" || !result.reviewCase) {
    throw new Error("expected fraud review case");
  }
  return {
    evaluation: result.evaluation,
    reviewCase: result.reviewCase,
  };
};

const harnessOrder = (): KeyCoreOrder =>
  orderFixture("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
    checkoutEmailNormalized: "buyer@example.test",
    paymentStatus: "CAPTURED",
    riskStatus: "NOT_EVALUATED",
    status: "PAYMENT_CAPTURED",
  });

const fraudFacts = (order: KeyCoreOrder): FraudRiskFacts =>
  riskFactsFromOrder(order, "VERIFIED");

const fraudHarness = () => {
  const repository = new InMemoryFraudRiskRepository();
  const audit = new CapturingAudit();
  const customerA = customerId("11111111-1111-4111-8111-111111111111");
  repository.setCustomerVerification(customerA, "VERIFIED");
  const orders = {
    allow: orderFixture("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
      customerId: customerA,
      paymentStatus: "CAPTURED",
      riskStatus: "NOT_EVALUATED",
      status: "PAYMENT_CAPTURED",
    }),
    failedPending: orderFixture("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac", {
      paymentStatus: "PENDING",
      riskStatus: "NOT_EVALUATED",
      status: "FAILED",
    }),
    guestCaptured: orderFixture("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad", {
      checkoutEmailNormalized: "guest@example.test",
      customerId: null,
      paymentStatus: "CAPTURED",
      riskStatus: "NOT_EVALUATED",
      status: "PAYMENT_CAPTURED",
    }),
    paymentPending: orderFixture("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", {
      customerId: customerA,
      paymentStatus: "PENDING",
      riskStatus: "NOT_EVALUATED",
      status: "AWAITING_PAYMENT",
    }),
  };
  Object.values(orders).forEach((order) => repository.addOrder(order));
  return {
    audit,
    orders,
    repository,
    service: new FraudRiskService({
      audit,
      environment: "CI",
      now: () => now,
      repository,
    }),
    sideEffects: {
      decryptCalls: 0,
      deliveryCalls: 0,
      kinguinCalls: 0,
      stripeMutations: 0,
    },
  };
};

const orderFixture = (
  id: string,
  overrides: Partial<KeyCoreOrder>,
): KeyCoreOrder => ({
  checkoutEmailNormalized: null,
  correlationId: correlationId(`fraud-order-${id}`),
  createdAt: now,
  currency: currency("EUR"),
  customerAmount: money(2999n, currency("EUR")),
  customerId: customerId("11111111-1111-4111-8111-111111111111"),
  fulfillmentStatus: "NOT_STARTED",
  id: orderId(id),
  idempotencyFingerprint: randomUUID(),
  idempotencyKey: `fraud-order-${id}`,
  paymentStatus: "CAPTURED",
  priceLockId: randomUUID(),
  procurementStatus: "NOT_STARTED",
  productId: productId(randomUUID()),
  quantity: 1,
  recordVersion: 1,
  refundStatus: "NOT_REQUESTED",
  riskStatus: "NOT_EVALUATED",
  status: "PAYMENT_CAPTURED",
  updatedAt: now,
  ...overrides,
});

class TrustedFraudAuthority implements FraudManualReviewAuthorityPort {
  public constructor(private readonly operatorReference: string) {}

  public async authorizeResolution(): Promise<{
    readonly status: "AUTHORIZED";
    readonly operatorReference: string;
  }> {
    return {
      operatorReference: this.operatorReference,
      status: "AUTHORIZED",
    };
  }
}

class CapturingAudit {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class ThrowingFraudRiskRepository extends InMemoryFraudRiskRepository {
  public override async loadFacts(): Promise<null> {
    throw new Error(leakageMarkers.join(" "));
  }
}

const safeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, child) =>
    typeof child === "bigint" ? child.toString() : child,
  );
