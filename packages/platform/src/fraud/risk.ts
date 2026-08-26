import { createHash, randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type {
  CorrelationId,
  CustomerId,
  OrderId,
} from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import type {
  KeyCoreOrder,
  OrderPaymentStatus,
  OrderRiskStatus,
  OrderStatus,
} from "../orders/order-orchestration.js";

export const fraudRiskPolicyVersion = "KS09_POLICY_V1" as const;

export type FraudRiskDecision = "ALLOW" | "REVIEW" | "DENY";
export type FraudManualReviewStatus =
  "OPEN" | "APPROVED" | "REJECTED" | "CANCELLED";
export type FraudManualReviewResolution = "APPROVE" | "REJECT";

export type FraudRiskReasonCode =
  | "RISK_POLICY_ALLOW"
  | "PAYMENT_NOT_CONFIRMED"
  | "ORDER_STATE_INVALID"
  | "INVALID_ORDER_AMOUNT"
  | "CURRENCY_UNSUPPORTED"
  | "CUSTOMER_UNVERIFIED"
  | "MANUAL_REVIEW_POLICY_MATCH"
  | "RISK_RULE_EXCEPTION"
  | "RISK_FACTS_UNAVAILABLE";

export interface FraudRiskFacts {
  readonly orderId: OrderId;
  readonly customerId?: CustomerId | null;
  readonly customerVerificationState?:
    "VERIFIED" | "UNVERIFIED" | "UNKNOWN" | null;
  readonly checkoutEmailSnapshotPresent: boolean;
  readonly orderAmountMinor: bigint;
  readonly currency: string;
  readonly orderStatus: OrderStatus;
  readonly paymentStatus: OrderPaymentStatus;
  readonly orderRiskStatus: OrderRiskStatus;
  readonly createdAt: Date;
}

export interface FraudRiskEvaluation {
  readonly riskDecisionId: string;
  readonly orderId: OrderId;
  readonly decision: FraudRiskDecision;
  readonly riskScore: number;
  readonly reasonCodes: readonly FraudRiskReasonCode[];
  readonly evaluatedAt: Date;
  readonly policyVersion: typeof fraudRiskPolicyVersion;
  readonly factFingerprint: string;
}

export interface FraudManualReviewCase {
  readonly caseId: string;
  readonly orderId: OrderId;
  readonly source: "FRAUD";
  readonly status: FraudManualReviewStatus;
  readonly evaluationId: string;
  readonly factFingerprint: string;
  readonly reasonCodes: readonly FraudRiskReasonCode[];
  readonly openedAt: Date;
  readonly resolvedAt?: Date | null;
  readonly resolution?: "APPROVED" | "REJECTED" | null;
  readonly operatorReference?: string | null;
}

export interface FraudRiskRule {
  readonly id: string;
  evaluate(facts: FraudRiskFacts): FraudRiskRuleResult;
}

export type FraudRiskRuleResult =
  | { readonly decision: "ALLOW" }
  | {
      readonly decision: Exclude<FraudRiskDecision, "ALLOW">;
      readonly reasonCode: FraudRiskReasonCode;
      readonly score: number;
    };

export interface FraudRiskRepository {
  loadFacts(orderId: OrderId): Promise<FraudRiskFacts | null>;
  persistEvaluation(input: {
    readonly evaluation: FraudRiskEvaluation;
    readonly openReviewCase?: FraudManualReviewCase;
  }): Promise<{
    readonly evaluation: FraudRiskEvaluation;
    readonly reviewCase?: FraudManualReviewCase | null;
  }>;
  getCurrentEvaluation(orderId: OrderId): Promise<FraudRiskEvaluation | null>;
  findOpenFraudReviewCase(
    orderId: OrderId,
  ): Promise<FraudManualReviewCase | null>;
  findFraudReviewCaseById(
    caseId: string,
  ): Promise<FraudManualReviewCase | null>;
  findFraudReviewCaseForEvaluation(
    evaluationId: string,
  ): Promise<FraudManualReviewCase | null>;
  resolveFraudReviewCase(input: {
    readonly caseId: string;
    readonly expectedFactFingerprint: string;
    readonly resolution: Exclude<
      FraudManualReviewCase["resolution"],
      null | undefined
    >;
    readonly operatorReference: string;
    readonly now: Date;
  }): Promise<
    | {
        readonly status: "RESOLVED";
        readonly reviewCase: FraudManualReviewCase;
      }
    | {
        readonly status: "ALREADY_RESOLVED";
        readonly reviewCase: FraudManualReviewCase;
      }
    | { readonly status: "STALE_EVALUATION" | "NOT_FOUND" }
  >;
}

export interface FraudManualReviewAuthorityPort {
  authorizeResolution(input: {
    readonly caseId: string;
    readonly orderId: OrderId;
    readonly evaluationId: string;
    readonly factFingerprint: string;
    readonly requestedResolution: FraudManualReviewResolution;
    readonly correlationId: CorrelationId;
  }): Promise<
    | { readonly status: "AUTHORIZED"; readonly operatorReference: string }
    | { readonly status: "DENIED"; readonly reasonCode: string }
  >;
}

export class FailClosedFraudManualReviewAuthority implements FraudManualReviewAuthorityPort {
  public async authorizeResolution(): Promise<{
    readonly status: "DENIED";
    readonly reasonCode: string;
  }> {
    return {
      reasonCode: "FRAUD_OPERATOR_AUTHORITY_NOT_CONFIGURED",
      status: "DENIED",
    };
  }
}

export interface FraudRiskServiceOptions {
  readonly repository: FraudRiskRepository;
  readonly manualReviewAuthority?: FraudManualReviewAuthorityPort;
  readonly rules?: readonly FraudRiskRule[];
  readonly supportedCurrencies?: readonly string[];
  readonly audit?: AuditEventPort;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
}

export type FraudRiskEvaluationResult =
  | {
      readonly status: "EVALUATED";
      readonly evaluation: FraudRiskEvaluation;
      readonly reviewCase?: FraudManualReviewCase | null;
    }
  | {
      readonly status: "UNAVAILABLE";
      readonly reasonCode:
        "RISK_FACTS_UNAVAILABLE" | "RISK_REPOSITORY_UNAVAILABLE";
    };

export type FraudClearanceResult =
  | { readonly status: "CLEARED"; readonly evaluation: FraudRiskEvaluation }
  | {
      readonly status: "BLOCKED";
      readonly reasonCode:
        | "FRAUD_DECISION_MISSING"
        | "FRAUD_REVIEW_REQUIRED"
        | "FRAUD_DENIED"
        | "FRAUD_REPOSITORY_UNAVAILABLE";
    };

export type FraudManualReviewResolutionResult =
  | { readonly status: "RESOLVED"; readonly reviewCase: FraudManualReviewCase }
  | {
      readonly status: "ALREADY_RESOLVED";
      readonly reviewCase: FraudManualReviewCase;
    }
  | {
      readonly status: "DENIED";
      readonly reasonCode:
        | "FRAUD_OPERATOR_AUTHORITY_DENIED"
        | "FRAUD_REVIEW_NOT_FOUND"
        | "FRAUD_REVIEW_STALE"
        | "FRAUD_REPOSITORY_UNAVAILABLE";
    };

export class FraudRiskService {
  private readonly rules: readonly FraudRiskRule[];
  private readonly supportedCurrencies: ReadonlySet<string>;
  private readonly now: () => Date;
  private readonly environment: AuditEvent["environment"];
  private readonly manualReviewAuthority: FraudManualReviewAuthorityPort;

  public constructor(private readonly options: FraudRiskServiceOptions) {
    this.rules = options.rules ?? defaultFraudRiskRules;
    this.supportedCurrencies = new Set(options.supportedCurrencies ?? ["EUR"]);
    if (this.supportedCurrencies.size === 0) {
      throw new Error("Fraud risk supported currency configuration is invalid");
    }
    for (const currency of this.supportedCurrencies) {
      if (!/^[A-Z]{3}$/u.test(currency)) {
        throw new Error(
          "Fraud risk supported currency configuration is invalid",
        );
      }
    }
    this.now = options.now ?? (() => new Date());
    this.environment = options.environment ?? "LOCAL";
    this.manualReviewAuthority =
      options.manualReviewAuthority ??
      new FailClosedFraudManualReviewAuthority();
  }

  public async evaluateOrder(input: {
    readonly orderId: OrderId;
    readonly correlationId: CorrelationId;
  }): Promise<FraudRiskEvaluationResult> {
    let facts: FraudRiskFacts | null;
    try {
      facts = await this.options.repository.loadFacts(input.orderId);
    } catch {
      await this.auditSystemFailure(input.correlationId, input.orderId);
      return {
        reasonCode: "RISK_REPOSITORY_UNAVAILABLE",
        status: "UNAVAILABLE",
      };
    }
    if (!facts) {
      await this.auditSystemFailure(input.correlationId, input.orderId);
      return { reasonCode: "RISK_FACTS_UNAVAILABLE", status: "UNAVAILABLE" };
    }
    const result = evaluateFraudRiskFacts(facts, {
      rules: this.rules,
      supportedCurrencies: this.supportedCurrencies,
    });
    const evaluatedAt = this.now();
    const evaluation: FraudRiskEvaluation = {
      decision: result.decision,
      evaluatedAt,
      factFingerprint: fraudRiskFactFingerprint(facts),
      orderId: facts.orderId,
      policyVersion: fraudRiskPolicyVersion,
      reasonCodes: result.reasonCodes,
      riskDecisionId: randomUUID(),
      riskScore: result.riskScore,
    };
    const openReviewCase =
      evaluation.decision === "REVIEW"
        ? {
            caseId: randomUUID(),
            evaluationId: evaluation.riskDecisionId,
            factFingerprint: evaluation.factFingerprint,
            openedAt: evaluatedAt,
            orderId: facts.orderId,
            reasonCodes: evaluation.reasonCodes,
            source: "FRAUD" as const,
            status: "OPEN" as const,
          }
        : undefined;
    try {
      const persisted = await this.options.repository.persistEvaluation({
        evaluation,
        ...(openReviewCase ? { openReviewCase } : {}),
      });
      await this.auditEvaluation(input.correlationId, persisted.evaluation);
      if (persisted.reviewCase) {
        await this.auditReviewOpened(input.correlationId, persisted.reviewCase);
      }
      return {
        evaluation: persisted.evaluation,
        ...(persisted.reviewCase ? { reviewCase: persisted.reviewCase } : {}),
        status: "EVALUATED",
      };
    } catch {
      await this.auditSystemFailure(input.correlationId, input.orderId);
      return {
        reasonCode: "RISK_REPOSITORY_UNAVAILABLE",
        status: "UNAVAILABLE",
      };
    }
  }

  public async isFraudCleared(
    orderIdValue: OrderId,
  ): Promise<FraudClearanceResult> {
    try {
      const current =
        await this.options.repository.getCurrentEvaluation(orderIdValue);
      if (!current) {
        return { reasonCode: "FRAUD_DECISION_MISSING", status: "BLOCKED" };
      }
      if (current.decision === "ALLOW") {
        return { evaluation: current, status: "CLEARED" };
      }
      if (current.decision === "DENY") {
        return { reasonCode: "FRAUD_DENIED", status: "BLOCKED" };
      }
      const review =
        await this.options.repository.findOpenFraudReviewCase(orderIdValue);
      if (review) {
        return { reasonCode: "FRAUD_REVIEW_REQUIRED", status: "BLOCKED" };
      }
      const resolved =
        await this.options.repository.findFraudReviewCaseForEvaluation(
          current.riskDecisionId,
        );
      return resolved?.status === "APPROVED"
        ? { evaluation: current, status: "CLEARED" }
        : { reasonCode: "FRAUD_REVIEW_REQUIRED", status: "BLOCKED" };
    } catch {
      return { reasonCode: "FRAUD_REPOSITORY_UNAVAILABLE", status: "BLOCKED" };
    }
  }

  public async resolveManualReview(input: {
    readonly caseId: string;
    readonly resolution: FraudManualReviewResolution;
    readonly expectedFactFingerprint: string;
    readonly correlationId: CorrelationId;
  }): Promise<FraudManualReviewResolutionResult> {
    try {
      const openCase = await this.findCaseById(input.caseId);
      if (!openCase) {
        return { reasonCode: "FRAUD_REVIEW_NOT_FOUND", status: "DENIED" };
      }
      const current = await this.options.repository.getCurrentEvaluation(
        openCase.orderId,
      );
      if (
        !current ||
        current.factFingerprint !== openCase.factFingerprint ||
        input.expectedFactFingerprint !== openCase.factFingerprint
      ) {
        return { reasonCode: "FRAUD_REVIEW_STALE", status: "DENIED" };
      }
      const authorized = await this.manualReviewAuthority.authorizeResolution({
        caseId: openCase.caseId,
        correlationId: input.correlationId,
        evaluationId: openCase.evaluationId,
        factFingerprint: openCase.factFingerprint,
        orderId: openCase.orderId,
        requestedResolution: input.resolution,
      });
      if (authorized.status !== "AUTHORIZED") {
        return {
          reasonCode: "FRAUD_OPERATOR_AUTHORITY_DENIED",
          status: "DENIED",
        };
      }
      const result = await this.options.repository.resolveFraudReviewCase({
        caseId: openCase.caseId,
        expectedFactFingerprint: openCase.factFingerprint,
        now: this.now(),
        operatorReference: authorized.operatorReference,
        resolution: input.resolution === "APPROVE" ? "APPROVED" : "REJECTED",
      });
      if (result.status === "NOT_FOUND") {
        return { reasonCode: "FRAUD_REVIEW_NOT_FOUND", status: "DENIED" };
      }
      if (result.status === "STALE_EVALUATION") {
        return { reasonCode: "FRAUD_REVIEW_STALE", status: "DENIED" };
      }
      if (
        result.status === "RESOLVED" ||
        result.status === "ALREADY_RESOLVED"
      ) {
        await this.auditReviewResolved(input.correlationId, result.reviewCase);
        return { reviewCase: result.reviewCase, status: result.status };
      }
      return { reasonCode: "FRAUD_REVIEW_STALE", status: "DENIED" };
    } catch {
      return { reasonCode: "FRAUD_REPOSITORY_UNAVAILABLE", status: "DENIED" };
    }
  }

  private async findCaseById(
    caseId: string,
  ): Promise<FraudManualReviewCase | null> {
    return this.options.repository.findFraudReviewCaseById(caseId);
  }

  private async auditEvaluation(
    correlationId: CorrelationId,
    evaluation: FraudRiskEvaluation,
  ): Promise<void> {
    await this.audit({
      correlationId,
      entityId: evaluation.orderId,
      eventType: "FRAUD_RISK_EVALUATED",
      metadata: {
        decision: evaluation.decision,
        evaluationId: evaluation.riskDecisionId,
        factFingerprint: evaluation.factFingerprint,
        orderId: evaluation.orderId,
        policyVersion: evaluation.policyVersion,
        reasonCodes: evaluation.reasonCodes.join(","),
        riskScore: evaluation.riskScore,
      },
      outcome: "SUCCEEDED",
      reasonCode: evaluation.reasonCodes[0] ?? "RISK_POLICY_ALLOW",
    });
  }

  private async auditReviewOpened(
    correlationId: CorrelationId,
    reviewCase: FraudManualReviewCase,
  ): Promise<void> {
    await this.audit({
      correlationId,
      entityId: reviewCase.caseId,
      eventType: "FRAUD_MANUAL_REVIEW_OPENED",
      metadata: {
        caseId: reviewCase.caseId,
        evaluationId: reviewCase.evaluationId,
        orderId: reviewCase.orderId,
        reasonCodes: reviewCase.reasonCodes.join(","),
      },
      outcome: "SUCCEEDED",
      reasonCode: reviewCase.reasonCodes[0] ?? "MANUAL_REVIEW_POLICY_MATCH",
    });
  }

  private async auditReviewResolved(
    correlationId: CorrelationId,
    reviewCase: FraudManualReviewCase,
  ): Promise<void> {
    await this.audit({
      correlationId,
      entityId: reviewCase.caseId,
      eventType: "FRAUD_MANUAL_REVIEW_RESOLVED",
      metadata: {
        caseId: reviewCase.caseId,
        evaluationId: reviewCase.evaluationId,
        orderId: reviewCase.orderId,
        resolution: reviewCase.resolution ?? "UNKNOWN",
        safeOperatorReference: reviewCase.operatorReference ?? "UNKNOWN",
      },
      outcome: "SUCCEEDED",
      reasonCode: `FRAUD_REVIEW_${reviewCase.resolution ?? "UNKNOWN"}`,
    });
  }

  private async auditSystemFailure(
    correlationId: CorrelationId,
    orderIdValue: OrderId,
  ): Promise<void> {
    await this.audit({
      correlationId,
      entityId: orderIdValue,
      eventType: "FRAUD_RISK_EVALUATED",
      metadata: {
        orderId: orderIdValue,
        policyVersion: fraudRiskPolicyVersion,
      },
      outcome: "FAILED",
      reasonCode: "RISK_FACTS_UNAVAILABLE",
    });
  }

  private async audit(input: {
    readonly correlationId: CorrelationId;
    readonly entityId: string;
    readonly eventType: AuditEvent["eventType"];
    readonly outcome: AuditEvent["outcome"];
    readonly reasonCode: string;
    readonly metadata: Readonly<Record<string, string | number | boolean>>;
  }): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "fraud-risk-service", type: "SERVICE" },
      correlationId: input.correlationId,
      entity: { id: input.entityId, type: "FRAUD_RISK" },
      environment: this.environment,
      eventType: input.eventType,
      metadata: { reasonCode: input.reasonCode, ...input.metadata },
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }
}

export const evaluateFraudRiskFacts = (
  facts: FraudRiskFacts,
  config: {
    readonly rules?: readonly FraudRiskRule[];
    readonly supportedCurrencies?: ReadonlySet<string>;
  } = {},
): {
  readonly decision: FraudRiskDecision;
  readonly reasonCodes: readonly FraudRiskReasonCode[];
  readonly riskScore: number;
} => {
  const supportedCurrencies = config.supportedCurrencies ?? new Set(["EUR"]);
  const results: Exclude<
    FraudRiskRuleResult,
    { readonly decision: "ALLOW" }
  >[] = [];
  for (const rule of config.rules ?? defaultFraudRiskRules) {
    try {
      const result = rule.evaluate(facts);
      if (result.decision !== "ALLOW") {
        results.push(result);
      }
    } catch {
      results.push({
        decision: "REVIEW",
        reasonCode: "RISK_RULE_EXCEPTION",
        score: 80,
      });
    }
  }
  if (!supportedCurrencies.has(facts.currency)) {
    results.push({
      decision: "REVIEW",
      reasonCode: "CURRENCY_UNSUPPORTED",
      score: 50,
    });
  }
  const sortedReasons = [
    ...new Set(results.map((result) => result.reasonCode)),
  ].sort();
  const decision = results.some((result) => result.decision === "DENY")
    ? "DENY"
    : results.some((result) => result.decision === "REVIEW")
      ? "REVIEW"
      : "ALLOW";
  return {
    decision,
    reasonCodes:
      sortedReasons.length > 0 ? sortedReasons : ["RISK_POLICY_ALLOW"],
    riskScore: Math.min(
      100,
      Math.max(0, ...results.map((result) => result.score), 0),
    ),
  };
};

export const defaultFraudRiskRules: readonly FraudRiskRule[] = [
  {
    evaluate: (facts) =>
      facts.orderAmountMinor <= 0n
        ? { decision: "DENY", reasonCode: "INVALID_ORDER_AMOUNT", score: 100 }
        : { decision: "ALLOW" },
    id: "RISK_AMOUNT_VALID",
  },
  {
    evaluate: (facts) =>
      facts.orderStatus === "CANCELLED" ||
      facts.orderStatus === "FAILED" ||
      facts.orderStatus === "REFUNDED"
        ? { decision: "DENY", reasonCode: "ORDER_STATE_INVALID", score: 100 }
        : { decision: "ALLOW" },
    id: "RISK_ORDER_STATE_VALID",
  },
  {
    evaluate: (facts) =>
      facts.paymentStatus !== "CAPTURED"
        ? { decision: "REVIEW", reasonCode: "PAYMENT_NOT_CONFIRMED", score: 70 }
        : { decision: "ALLOW" },
    id: "RISK_PAYMENT_CAPTURED",
  },
  {
    evaluate: (facts) =>
      facts.customerId && facts.customerVerificationState === "UNVERIFIED"
        ? { decision: "REVIEW", reasonCode: "CUSTOMER_UNVERIFIED", score: 40 }
        : { decision: "ALLOW" },
    id: "RISK_CUSTOMER_VERIFICATION",
  },
  {
    evaluate: (facts) =>
      facts.orderRiskStatus === "REVIEW_REQUIRED"
        ? {
            decision: "REVIEW",
            reasonCode: "MANUAL_REVIEW_POLICY_MATCH",
            score: 80,
          }
        : facts.orderRiskStatus === "REJECTED"
          ? { decision: "DENY", reasonCode: "ORDER_STATE_INVALID", score: 100 }
          : { decision: "ALLOW" },
    id: "RISK_EXISTING_ORDER_RISK_STATUS",
  },
];

export const fraudRiskFactFingerprint = (facts: FraudRiskFacts): string =>
  createHash("sha256")
    .update(JSON.stringify(canonicalFraudRiskFacts(facts)), "utf8")
    .digest("hex");

export const canonicalFraudRiskFacts = (facts: FraudRiskFacts) => ({
  checkoutEmailSnapshotPresent: facts.checkoutEmailSnapshotPresent,
  createdAt: facts.createdAt.toISOString(),
  currency: facts.currency,
  customerId: facts.customerId ?? null,
  customerVerificationState: facts.customerVerificationState ?? null,
  orderAmountMinor: facts.orderAmountMinor.toString(),
  orderId: facts.orderId,
  orderRiskStatus: facts.orderRiskStatus,
  orderStatus: facts.orderStatus,
  paymentStatus: facts.paymentStatus,
  policyVersion: fraudRiskPolicyVersion,
});

export const riskFactsFromOrder = (
  order: KeyCoreOrder,
  customerVerificationState?: FraudRiskFacts["customerVerificationState"],
): FraudRiskFacts => ({
  checkoutEmailSnapshotPresent: Boolean(order.checkoutEmailNormalized),
  createdAt: order.createdAt,
  currency: order.currency,
  customerId: order.customerId ?? null,
  customerVerificationState:
    order.customerId === null || order.customerId === undefined
      ? null
      : (customerVerificationState ?? "UNKNOWN"),
  orderAmountMinor: order.customerAmount.amountMinor,
  orderId: order.id,
  orderRiskStatus: order.riskStatus,
  orderStatus: order.status,
  paymentStatus: order.paymentStatus,
});
