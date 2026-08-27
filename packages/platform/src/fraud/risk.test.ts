import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { InMemoryFraudRiskRepository } from "../../../../infra/fraud/in-memory-fraud-risk-repository.js";
import {
  FraudRiskService,
  canonicalFraudRiskFacts,
  correlationId,
  currency,
  defaultFraudVelocityWindows,
  emailVelocitySubjectKey,
  evaluateFraudRiskFacts,
  fraudRiskFactFingerprint,
  fraudRiskVelocityPolicyVersion,
  customerId,
  money,
  orderId,
  productId,
  riskFactsFromOrder,
  validateFraudVelocityPolicy,
  type AuditEvent,
  type FraudVelocityFacts,
  type FraudVelocityEventAuthorityPort,
  type FraudVelocityPolicy,
  type FraudVelocitySubjectType,
  type FraudVelocityWindowId,
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
const velocityLeakageMarkers = [
  "KEYRANO_KS0902_RAW_EMAIL_DO_NOT_LEAK@example.test",
  "KEYRANO_KS0902_PRODUCT_KEY_DO_NOT_LEAK",
  "KEYRANO_KS0902_STRIPE_SECRET_DO_NOT_LEAK",
  "KEYRANO_KS0902_KINGUIN_SECRET_DO_NOT_LEAK",
  "KEYRANO_KS0902_SESSION_DO_NOT_LEAK",
  "KEYRANO_KS0902_CLAIM_CODE_DO_NOT_LEAK",
  "KEYRANO_KS0902_CORRELATION_SECRET_DO_NOT_LEAK",
] as const;
const velocityCorrelationTestKey = "test-velocity-correlation-key-000001";

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

describe("fraud velocity limits", () => {
  it("derives deterministic pseudonymous checkout-email subjects without raw email fallback", () => {
    const same = emailVelocitySubjectKey(
      velocityCorrelationTestKey,
      "buyer@example.test",
    );
    expect(
      emailVelocitySubjectKey(velocityCorrelationTestKey, "buyer@example.test"),
    ).toBe(same);
    expect(
      emailVelocitySubjectKey(velocityCorrelationTestKey, "other@example.test"),
    ).not.toBe(same);
    expect(same).toMatch(/^v1:[a-f0-9]{64}$/u);
    expect(same).not.toContain("buyer@example.test");
    expect(() =>
      emailVelocitySubjectKey("short", "buyer@example.test"),
    ).toThrow("Invalid fraud velocity correlation secret");
  });

  it("correlates customer and checkout-email subjects without exposing raw email", async () => {
    const repository = new InMemoryFraudRiskRepository({
      velocityCorrelationSecret: velocityCorrelationTestKey,
    });
    const sharedCustomer = customerId("44444444-4444-4444-8444-444444444444");
    const otherCustomer = customerId("55555555-5555-4555-8555-555555555555");
    const sameCustomerA = orderFixture("eeeeeeee-eeee-4eee-8eee-eeeeeeeeee01", {
      customerId: sharedCustomer,
    });
    const sameCustomerB = orderFixture("eeeeeeee-eeee-4eee-8eee-eeeeeeeeee02", {
      customerId: sharedCustomer,
    });
    const differentCustomer = orderFixture(
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee03",
      {
        customerId: otherCustomer,
      },
    );
    const sameEmailA = orderFixture("eeeeeeee-eeee-4eee-8eee-eeeeeeeeee04", {
      checkoutEmailNormalized: "same@example.test",
      customerId: null,
    });
    const sameEmailB = orderFixture("eeeeeeee-eeee-4eee-8eee-eeeeeeeeee05", {
      checkoutEmailNormalized: "same@example.test",
      customerId: null,
    });
    const differentEmail = orderFixture(
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeee06",
      {
        checkoutEmailNormalized: "different@example.test",
        customerId: null,
      },
    );
    for (const order of [
      sameCustomerA,
      sameCustomerB,
      differentCustomer,
      sameEmailA,
      sameEmailB,
      differentEmail,
    ]) {
      repository.addOrder(order);
    }
    await repository.recordOrderVelocityEvent({
      eventType: "PAYMENT_CONFIRMED",
      occurredAt: now,
      orderId: sameCustomerA.id,
      recordedAt: now,
    });
    await repository.recordOrderVelocityEvent({
      eventType: "PAYMENT_CONFIRMED",
      occurredAt: now,
      orderId: sameEmailA.id,
      recordedAt: now,
    });

    const sameCustomerFacts = await repository.loadVelocityFacts({
      evaluatedAt: now,
      orderId: sameCustomerB.id,
      windows: defaultFraudVelocityWindows,
    });
    const differentCustomerFacts = await repository.loadVelocityFacts({
      evaluatedAt: now,
      orderId: differentCustomer.id,
      windows: defaultFraudVelocityWindows,
    });
    const sameEmailFacts = await repository.loadVelocityFacts({
      evaluatedAt: now,
      orderId: sameEmailB.id,
      windows: defaultFraudVelocityWindows,
    });
    const differentEmailFacts = await repository.loadVelocityFacts({
      evaluatedAt: now,
      orderId: differentEmail.id,
      windows: defaultFraudVelocityWindows,
    });

    expect(findAggregate(sameCustomerFacts, "CUSTOMER", "PT24H")).toMatchObject(
      { amountMinorTotal: 2999n, eventCount: 1 },
    );
    expect(
      findAggregate(differentCustomerFacts, "CUSTOMER", "PT24H"),
    ).toMatchObject({ amountMinorTotal: 0n, eventCount: 0 });
    expect(
      findAggregate(sameEmailFacts, "CHECKOUT_EMAIL", "PT24H"),
    ).toMatchObject({ amountMinorTotal: 2999n, eventCount: 1 });
    expect(
      findAggregate(differentEmailFacts, "CHECKOUT_EMAIL", "PT24H"),
    ).toMatchObject({ amountMinorTotal: 0n, eventCount: 0 });
    expect(safeJson(sameEmailFacts)).not.toContain("same@example.test");
    expect(safeJson(sameEmailFacts)).toContain(
      emailVelocitySubjectKey(velocityCorrelationTestKey, "same@example.test"),
    );
  });

  it("records trusted velocity events idempotently and applies KS09_POLICY_V2 thresholds", async () => {
    const harness = velocityHarness();
    await expect(
      harness.service.recordVelocityEventForOrder({
        correlationId: correlationId("velocity-record-a"),
        orderId: harness.orders.customerA1.id,
      }),
    ).resolves.toEqual({
      insertedEventCount: 1,
      status: "RECORDED",
      subjectEventCount: 1,
    });
    await expect(
      harness.service.recordVelocityEventForOrder({
        correlationId: correlationId("velocity-record-a-replay"),
        orderId: harness.orders.customerA1.id,
      }),
    ).resolves.toEqual({
      insertedEventCount: 0,
      status: "IDEMPOTENT",
      subjectEventCount: 1,
    });

    const allow = await harness.service.evaluateOrder({
      correlationId: correlationId("velocity-allow"),
      orderId: harness.orders.customerA1.id,
    });
    expect(allow).toMatchObject({
      evaluation: {
        decision: "ALLOW",
        policyVersion: fraudRiskVelocityPolicyVersion,
        reasonCodes: ["RISK_POLICY_ALLOW"],
      },
      status: "EVALUATED",
    });

    await harness.service.recordVelocityEventForOrder({
      correlationId: correlationId("velocity-record-b"),
      orderId: harness.orders.customerA2.id,
    });
    const review = await harness.service.evaluateOrder({
      correlationId: correlationId("velocity-review"),
      orderId: harness.orders.customerA1.id,
    });
    expect(review).toMatchObject({
      evaluation: {
        decision: "REVIEW",
        reasonCodes: ["VELOCITY_AMOUNT_REVIEW", "VELOCITY_ORDER_COUNT_REVIEW"],
      },
      reviewCase: { source: "FRAUD", status: "OPEN" },
      status: "EVALUATED",
    });

    await harness.service.recordVelocityEventForOrder({
      correlationId: correlationId("velocity-record-c"),
      orderId: harness.orders.customerA3.id,
    });
    const deny = await harness.service.evaluateOrder({
      correlationId: correlationId("velocity-deny"),
      orderId: harness.orders.customerA1.id,
    });
    expect(deny).toMatchObject({
      evaluation: {
        decision: "DENY",
        reasonCodes: ["VELOCITY_AMOUNT_DENY", "VELOCITY_ORDER_COUNT_DENY"],
      },
      status: "EVALUATED",
    });
  });

  it("does not record velocity events for orders without captured payment", async () => {
    const harness = velocityHarness();
    harness.repository.addOrder({
      ...harness.orders.customerA1,
      paymentStatus: "PENDING",
      status: "AWAITING_PAYMENT",
    });

    await expect(
      harness.service.recordVelocityEventForOrder({
        correlationId: correlationId("velocity-uncaptured-payment"),
        orderId: harness.orders.customerA1.id,
      }),
    ).resolves.toEqual({
      reasonCode: "VELOCITY_SIGNAL_UNAVAILABLE",
      status: "UNAVAILABLE",
    });
  });

  it("fails closed when no supported authoritative velocity subject exists", async () => {
    const repository = new InMemoryFraudRiskRepository({
      velocityCorrelationSecret: velocityCorrelationTestKey,
    });
    const legacyGuest = orderFixture("cccccccc-cccc-4ccc-8ccc-cccccccccc01", {
      checkoutEmailNormalized: null,
      customerId: null,
    });
    repository.addOrder(legacyGuest);
    const service = new FraudRiskService({
      now: () => now,
      repository,
      velocity: {
        eventAuthority: new TrustedVelocityEventAuthority(now),
        policy: velocityPolicy(),
        repository,
      },
    });

    await expect(
      repository.loadVelocityFacts({
        evaluatedAt: now,
        orderId: legacyGuest.id,
        windows: defaultFraudVelocityWindows,
      }),
    ).resolves.toBe("UNAVAILABLE");
    const result = await service.evaluateOrder({
      correlationId: correlationId("velocity-no-subject"),
      orderId: legacyGuest.id,
    });

    expect(result).toMatchObject({
      evaluation: {
        decision: "REVIEW",
        reasonCodes: ["VELOCITY_SIGNAL_UNAVAILABLE"],
      },
      status: "EVALUATED",
    });
  });

  it("invalidates stale velocity clearance when another trusted event changes the aggregate", async () => {
    const harness = velocityHarness();
    await harness.service.recordVelocityEventForOrder({
      correlationId: correlationId("velocity-stale-record-a"),
      orderId: harness.orders.customerA1.id,
    });
    await harness.service.evaluateOrder({
      correlationId: correlationId("velocity-stale-allow"),
      orderId: harness.orders.customerA1.id,
    });
    await expect(
      harness.service.isFraudCleared(harness.orders.customerA1.id),
    ).resolves.toMatchObject({ status: "CLEARED" });

    await harness.service.recordVelocityEventForOrder({
      correlationId: correlationId("velocity-stale-record-b"),
      orderId: harness.orders.customerA2.id,
    });

    await expect(
      harness.service.isFraudCleared(harness.orders.customerA1.id),
    ).resolves.toEqual({
      reasonCode: "FRAUD_DECISION_MISSING",
      status: "BLOCKED",
    });
  });

  it("invalidates clearance and approved review when rolling velocity events age out", async () => {
    const allowHarness = velocityHarness();
    allowHarness.eventAuthority.occurredAt = new Date(
      now.getTime() - 24 * 60 * 60 * 1000 + 1_000,
    );
    await allowHarness.service.recordVelocityEventForOrder({
      correlationId: correlationId("velocity-aging-record"),
      orderId: allowHarness.orders.customerA1.id,
    });
    await allowHarness.service.evaluateOrder({
      correlationId: correlationId("velocity-aging-allow"),
      orderId: allowHarness.orders.customerA1.id,
    });
    await expect(
      allowHarness.service.isFraudCleared(allowHarness.orders.customerA1.id),
    ).resolves.toMatchObject({ status: "CLEARED" });
    allowHarness.now = new Date(now.getTime() + 2_000);
    await expect(
      allowHarness.service.isFraudCleared(allowHarness.orders.customerA1.id),
    ).resolves.toEqual({
      reasonCode: "FRAUD_DECISION_MISSING",
      status: "BLOCKED",
    });

    const reviewHarness = velocityHarness({
      manualReviewAuthority: new TrustedFraudAuthority("operator:velocity"),
    });
    await reviewHarness.service.recordVelocityEventForOrder({
      correlationId: correlationId("velocity-aging-review-record-a"),
      orderId: reviewHarness.orders.customerA1.id,
    });
    await reviewHarness.service.recordVelocityEventForOrder({
      correlationId: correlationId("velocity-aging-review-record-b"),
      orderId: reviewHarness.orders.customerA2.id,
    });
    const review = await requireReview(
      reviewHarness.service,
      reviewHarness.orders.customerA1.id,
      "velocity-aging-review-open",
    );
    await reviewHarness.service.resolveManualReview({
      caseId: review.reviewCase.caseId,
      correlationId: correlationId("velocity-aging-review-approve"),
      expectedFactFingerprint: review.evaluation.factFingerprint,
      resolution: "APPROVE",
    });
    await expect(
      reviewHarness.service.isFraudCleared(reviewHarness.orders.customerA1.id),
    ).resolves.toMatchObject({ status: "CLEARED" });
    reviewHarness.now = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1);
    await expect(
      reviewHarness.service.isFraudCleared(reviewHarness.orders.customerA1.id),
    ).resolves.toEqual({
      reasonCode: "FRAUD_DECISION_MISSING",
      status: "BLOCKED",
    });
  });

  it("keeps window boundaries, currency isolation and future timestamp anomalies safe", async () => {
    const harness = velocityHarness();
    harness.eventAuthority.occurredAt = new Date(
      now.getTime() - 15 * 60 * 1000,
    );
    await harness.service.recordVelocityEventForOrder({
      correlationId: correlationId("velocity-boundary-in"),
      orderId: harness.orders.customerA1.id,
    });
    harness.eventAuthority.occurredAt = new Date(
      now.getTime() - 15 * 60 * 1000 - 1,
    );
    await harness.service.recordVelocityEventForOrder({
      correlationId: correlationId("velocity-boundary-out"),
      orderId: harness.orders.customerA2.id,
    });
    await harness.repository.recordOrderVelocityEvent({
      eventType: "PAYMENT_CONFIRMED",
      occurredAt: new Date(now.getTime() + 1),
      orderId: harness.orders.customerA3.id,
      recordedAt: new Date(now.getTime() + 1),
    });
    harness.eventAuthority.occurredAt = now;
    const result = await harness.service.evaluateOrder({
      correlationId: correlationId("velocity-anomaly"),
      orderId: harness.orders.customerA1.id,
    });

    expect(result).toMatchObject({
      evaluation: {
        decision: "REVIEW",
      },
      status: "EVALUATED",
    });
    expect(
      result.status === "EVALUATED" ? result.evaluation.reasonCodes : [],
    ).toContain("VELOCITY_TIMESTAMP_ANOMALY");
  });

  it("fails closed when checkout-email velocity requires an unavailable correlation secret", async () => {
    const repository = new InMemoryFraudRiskRepository();
    const guest = orderFixture("cccccccc-cccc-4ccc-8ccc-cccccccccccc", {
      checkoutEmailNormalized: velocityLeakageMarkers[0],
      customerId: null,
    });
    repository.addOrder(guest);
    const service = new FraudRiskService({
      repository,
      velocity: { policy: velocityPolicy(), repository },
    });

    const result = await service.evaluateOrder({
      correlationId: correlationId("velocity-secret-missing"),
      orderId: guest.id,
    });
    expect(result).toMatchObject({
      evaluation: {
        decision: "REVIEW",
        reasonCodes: ["VELOCITY_SIGNAL_UNAVAILABLE"],
      },
      status: "EVALUATED",
    });
    expect(safeJson(result)).not.toMatch(
      /RAW_EMAIL|PRODUCT_KEY|STRIPE_SECRET|KINGUIN_SECRET|SESSION|CLAIM_CODE|CORRELATION_SECRET/iu,
    );
  });

  it("requires trusted event authority and rejects arbitrary timestamp input", async () => {
    const repository = new InMemoryFraudRiskRepository({
      velocityCorrelationSecret: velocityCorrelationTestKey,
    });
    const order = orderFixture("cccccccc-cccc-4ccc-8ccc-cccccccccc02", {});
    repository.addOrder(order);
    const noAuthorityService = new FraudRiskService({
      now: () => now,
      repository,
      velocity: { policy: velocityPolicy(), repository },
    });
    await expect(
      noAuthorityService.recordVelocityEventForOrder({
        correlationId: correlationId("velocity-no-authority"),
        orderId: order.id,
      }),
    ).resolves.toEqual({
      reasonCode: "VELOCITY_SIGNAL_UNAVAILABLE",
      status: "UNAVAILABLE",
    });

    const service = new FraudRiskService({
      now: () => now,
      repository,
      velocity: {
        eventAuthority: new TrustedVelocityEventAuthority(
          new Date(now.getTime() + 1),
        ),
        policy: velocityPolicy(),
        repository,
      },
    });
    await expect(
      service.recordVelocityEventForOrder({
        correlationId: correlationId("velocity-future-authority"),
        orderId: order.id,
      }),
    ).resolves.toEqual({
      reasonCode: "VELOCITY_SIGNAL_UNAVAILABLE",
      status: "UNAVAILABLE",
    });
  });

  it("handles guest to customer partial idempotency without misleading counts", async () => {
    const repository = new InMemoryFraudRiskRepository({
      velocityCorrelationSecret: velocityCorrelationTestKey,
    });
    const eventAuthority = new TrustedVelocityEventAuthority(now);
    const guest = orderFixture("cccccccc-cccc-4ccc-8ccc-cccccccccc03", {
      checkoutEmailNormalized: "claim@example.test",
      customerId: null,
    });
    repository.addOrder(guest);
    const service = new FraudRiskService({
      now: () => now,
      repository,
      velocity: { eventAuthority, policy: velocityPolicy(), repository },
    });

    await expect(
      service.recordVelocityEventForOrder({
        correlationId: correlationId("velocity-guest-record"),
        orderId: guest.id,
      }),
    ).resolves.toEqual({
      insertedEventCount: 1,
      status: "RECORDED",
      subjectEventCount: 1,
    });
    repository.addOrder({
      ...guest,
      customerId: customerId("66666666-6666-4666-8666-666666666666"),
    });
    await expect(
      service.recordVelocityEventForOrder({
        correlationId: correlationId("velocity-guest-claimed-record"),
        orderId: guest.id,
      }),
    ).resolves.toEqual({
      insertedEventCount: 1,
      status: "RECORDED",
      subjectEventCount: 2,
    });
    await expect(
      service.recordVelocityEventForOrder({
        correlationId: correlationId("velocity-guest-claimed-replay"),
        orderId: guest.id,
      }),
    ).resolves.toEqual({
      insertedEventCount: 0,
      status: "IDEMPOTENT",
      subjectEventCount: 2,
    });
  });

  it("fails closed when the velocity repository cannot load aggregates", async () => {
    const repository = new InMemoryFraudRiskRepository();
    const order = orderFixture("cccccccc-cccc-4ccc-8ccc-cccccccccccd", {});
    repository.addOrder(order);
    const service = new FraudRiskService({
      repository,
      velocity: {
        policy: velocityPolicy(),
        repository: new ThrowingVelocityRepository(),
      },
    });

    const result = await service.evaluateOrder({
      correlationId: correlationId("velocity-repository-failure"),
      orderId: order.id,
    });

    expect(result).toMatchObject({
      evaluation: {
        decision: "REVIEW",
        reasonCodes: ["VELOCITY_SIGNAL_UNAVAILABLE"],
      },
      status: "EVALUATED",
    });
  });

  it("fails closed for incomplete, duplicate or malformed velocity facts", async () => {
    const order = orderFixture("cccccccc-cccc-4ccc-8ccc-cccccccccc04", {});
    const repository = new InMemoryFraudRiskRepository();
    repository.addOrder(order);
    const malformedFacts: FraudVelocityFacts = {
      aggregates: [
        {
          amountMinorTotal: 0n,
          currency: "EUR",
          eventCount: 0,
          eventType: "PAYMENT_CONFIRMED",
          subjectType: "CUSTOMER",
          window: "PT24H",
        },
      ],
      evaluatedAt: now,
      hasFutureEventAnomaly: false,
      status: "AVAILABLE",
      subjects: [
        { subjectKey: order.customerId ?? "", subjectType: "CUSTOMER" },
      ],
    };
    for (const velocityFacts of [
      malformedFacts,
      {
        ...malformedFacts,
        aggregates: [
          ...malformedFacts.aggregates,
          ...malformedFacts.aggregates,
        ],
      },
      {
        ...malformedFacts,
        aggregates: malformedFacts.aggregates.map((aggregate) => ({
          ...aggregate,
          eventCount: Number.MAX_SAFE_INTEGER + 1,
        })),
      },
    ]) {
      const service = new FraudRiskService({
        now: () => now,
        repository,
        velocity: {
          policy: velocityPolicy(),
          repository: new StaticVelocityRepository(velocityFacts),
        },
      });
      await expect(
        service.evaluateOrder({
          correlationId: correlationId(
            `velocity-malformed-${safeJson(velocityFacts).length}`,
          ),
          orderId: order.id,
        }),
      ).resolves.toMatchObject({
        evaluation: {
          decision: "REVIEW",
          reasonCodes: ["VELOCITY_SIGNAL_UNAVAILABLE"],
        },
        status: "EVALUATED",
      });
    }
  });

  it("rejects invalid velocity policy configuration", () => {
    expect(() =>
      validateFraudVelocityPolicy(
        velocityPolicy({ count: { deny: 1, review: 2 } }),
      ),
    ).toThrow("Invalid fraud velocity threshold configuration");
    expect(() =>
      validateFraudVelocityPolicy(
        velocityPolicy({ window: { durationMs: 0, id: "PT15M" } }),
      ),
    ).toThrow("Invalid fraud velocity window configuration");
    expect(() =>
      validateFraudVelocityPolicy({
        thresholds: [
          ...velocityPolicy().thresholds,
          ...velocityPolicy().thresholds,
        ],
        windows: [...defaultFraudVelocityWindows],
      }),
    ).toThrow("Invalid fraud velocity threshold configuration");
    expect(() =>
      validateFraudVelocityPolicy(
        velocityPolicy({
          window: { durationMs: 24 * 60 * 60 * 1000, id: "PT15M" },
        }),
      ),
    ).toThrow("Invalid fraud velocity window configuration");
    expect(() =>
      validateFraudVelocityPolicy(
        velocityPolicy({ count: { deny: 0, review: 0 } }),
      ),
    ).toThrow("Invalid fraud velocity threshold configuration");
  });

  it("deep-freezes validated velocity policy against caller mutation", async () => {
    const policy = velocityPolicy();
    const harness = velocityHarness({ policy });
    await harness.service.recordVelocityEventForOrder({
      correlationId: correlationId("velocity-freeze-record-a"),
      orderId: harness.orders.customerA1.id,
    });
    const threshold = policy.thresholds[0];
    if (!threshold?.count) {
      throw new Error("expected velocity count threshold");
    }
    (threshold.count as { review: number | bigint }).review = 99;
    await harness.service.recordVelocityEventForOrder({
      correlationId: correlationId("velocity-freeze-record-b"),
      orderId: harness.orders.customerA2.id,
    });

    await expect(
      harness.service.evaluateOrder({
        correlationId: correlationId("velocity-freeze-review"),
        orderId: harness.orders.customerA1.id,
      }),
    ).resolves.toMatchObject({
      evaluation: {
        decision: "REVIEW",
        reasonCodes: ["VELOCITY_AMOUNT_REVIEW", "VELOCITY_ORDER_COUNT_REVIEW"],
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

const velocityHarness = (
  options: {
    readonly manualReviewAuthority?: FraudManualReviewAuthorityPort;
    readonly policy?: FraudVelocityPolicy;
  } = {},
) => {
  const repository = new InMemoryFraudRiskRepository({
    velocityCorrelationSecret: velocityCorrelationTestKey,
  });
  const eventAuthority = new TrustedVelocityEventAuthority(now);
  const sharedCustomer = customerId("33333333-3333-4333-8333-333333333333");
  repository.setCustomerVerification(sharedCustomer, "VERIFIED");
  const orders = {
    customerA1: orderFixture("dddddddd-dddd-4ddd-8ddd-dddddddddd01", {
      createdAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
      customerId: sharedCustomer,
    }),
    customerA2: orderFixture("dddddddd-dddd-4ddd-8ddd-dddddddddd02", {
      createdAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
      customerId: sharedCustomer,
    }),
    customerA3: orderFixture("dddddddd-dddd-4ddd-8ddd-dddddddddd03", {
      createdAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
      customerId: sharedCustomer,
    }),
  };
  const state = { now };
  Object.values(orders).forEach((order) => repository.addOrder(order));
  return {
    eventAuthority,
    get now() {
      return state.now;
    },
    set now(value: Date) {
      state.now = value;
    },
    orders,
    repository,
    service: new FraudRiskService({
      ...(options.manualReviewAuthority
        ? { manualReviewAuthority: options.manualReviewAuthority }
        : {}),
      now: () => state.now,
      repository,
      velocity: {
        eventAuthority,
        policy: options.policy ?? velocityPolicy(),
        repository,
      },
    }),
  };
};

const velocityPolicy = (
  overrides: {
    readonly amountMinor?: FraudVelocityPolicy["thresholds"][number]["amountMinor"];
    readonly count?: FraudVelocityPolicy["thresholds"][number]["count"];
    readonly currency?: string;
    readonly window?: FraudVelocityPolicy["windows"][number];
  } = {},
): FraudVelocityPolicy => ({
  thresholds: [
    {
      amountMinor: overrides.amountMinor ?? { deny: 8_000n, review: 5_000n },
      count: overrides.count ?? { deny: 3, review: 2 },
      currency: overrides.currency ?? "EUR",
      eventType: "PAYMENT_CONFIRMED",
      window: overrides.window?.id ?? "PT24H",
    },
  ],
  windows: overrides.window
    ? [overrides.window]
    : [...defaultFraudVelocityWindows],
});

const findAggregate = (
  facts: FraudVelocityFacts | "UNAVAILABLE",
  subjectType: FraudVelocitySubjectType,
  window: FraudVelocityWindowId,
) => {
  if (facts === "UNAVAILABLE") {
    throw new Error("expected velocity facts");
  }
  const aggregate = facts.aggregates.find(
    (candidate) =>
      candidate.subjectType === subjectType && candidate.window === window,
  );
  if (!aggregate) {
    throw new Error("expected velocity aggregate");
  }
  return aggregate;
};

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

class TrustedVelocityEventAuthority implements FraudVelocityEventAuthorityPort {
  public constructor(public occurredAt: Date) {}

  public async authorizePaymentConfirmedVelocityEvent(): Promise<{
    readonly status: "AUTHORIZED";
    readonly eventType: "PAYMENT_CONFIRMED";
    readonly occurredAt: Date;
  }> {
    return {
      eventType: "PAYMENT_CONFIRMED",
      occurredAt: this.occurredAt,
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

class ThrowingVelocityRepository extends InMemoryFraudRiskRepository {
  public override async loadVelocityFacts(): Promise<"UNAVAILABLE"> {
    throw new Error(velocityLeakageMarkers.join(" "));
  }
}

class StaticVelocityRepository extends InMemoryFraudRiskRepository {
  public constructor(private readonly facts: FraudVelocityFacts) {
    super();
  }

  public override async loadVelocityFacts(): Promise<FraudVelocityFacts> {
    return this.facts;
  }
}

const safeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, child) =>
    typeof child === "bigint" ? child.toString() : child,
  );
