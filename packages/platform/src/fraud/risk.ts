import { createHash, createHmac, randomUUID } from "node:crypto";

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
export const fraudRiskVelocityPolicyVersion = "KS09_POLICY_V2" as const;

export type FraudRiskPolicyVersion = string;
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
  | "RISK_FACTS_UNAVAILABLE"
  | "VELOCITY_ORDER_COUNT_REVIEW"
  | "VELOCITY_ORDER_COUNT_DENY"
  | "VELOCITY_AMOUNT_REVIEW"
  | "VELOCITY_AMOUNT_DENY"
  | "VELOCITY_SIGNAL_UNAVAILABLE"
  | "VELOCITY_TIMESTAMP_ANOMALY";

export type FraudVelocitySubjectType = "CUSTOMER" | "CHECKOUT_EMAIL";
export type FraudVelocityEventType = "PAYMENT_CONFIRMED";
export type FraudVelocityWindowId = "PT15M" | "PT1H" | "PT24H";

export interface FraudVelocitySubject {
  readonly subjectType: FraudVelocitySubjectType;
  readonly subjectKey: string;
}

export interface FraudVelocityWindow {
  readonly id: FraudVelocityWindowId;
  readonly durationMs: number;
}

export interface FraudVelocityAggregate {
  readonly subjectType: FraudVelocitySubjectType;
  readonly eventType: FraudVelocityEventType;
  readonly window: FraudVelocityWindowId;
  readonly eventCount: number;
  readonly amountMinorTotal: bigint;
  readonly currency: string;
}

export interface FraudVelocityFacts {
  readonly evaluatedAt: Date;
  readonly subjects: readonly FraudVelocitySubject[];
  readonly aggregates: readonly FraudVelocityAggregate[];
  readonly hasFutureEventAnomaly: boolean;
  readonly status: "AVAILABLE" | "UNAVAILABLE";
}

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
  readonly velocity?: FraudVelocityFacts | null;
}

export interface FraudRiskEvaluation {
  readonly riskDecisionId: string;
  readonly orderId: OrderId;
  readonly decision: FraudRiskDecision;
  readonly riskScore: number;
  readonly reasonCodes: readonly FraudRiskReasonCode[];
  readonly evaluatedAt: Date;
  readonly policyVersion: FraudRiskPolicyVersion;
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
  findEvaluationByFingerprint(input: {
    readonly orderId: OrderId;
    readonly policyVersion: FraudRiskEvaluation["policyVersion"];
    readonly factFingerprint: string;
  }): Promise<FraudRiskEvaluation | null>;
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

export interface FraudVelocityRepository {
  recordOrderVelocityEvent(input: {
    readonly orderId: OrderId;
    readonly eventType: FraudVelocityEventType;
    readonly occurredAt: Date;
    readonly recordedAt: Date;
  }): Promise<{
    readonly status: "RECORDED" | "IDEMPOTENT" | "UNAVAILABLE";
    readonly subjectEventCount: number;
    readonly insertedEventCount: number;
  }>;
  loadVelocityFacts(input: {
    readonly orderId: OrderId;
    readonly evaluatedAt: Date;
    readonly windows: readonly FraudVelocityWindow[];
  }): Promise<FraudVelocityFacts | "UNAVAILABLE">;
}

export interface FraudVelocityThreshold {
  readonly review: number | bigint;
  readonly deny: number | bigint;
}

export interface FraudVelocityWindowThresholds {
  readonly window: FraudVelocityWindowId;
  readonly eventType: FraudVelocityEventType;
  readonly currency: string;
  readonly count?: FraudVelocityThreshold;
  readonly amountMinor?: FraudVelocityThreshold;
}

export interface FraudVelocityPolicy {
  readonly windows: readonly FraudVelocityWindow[];
  readonly thresholds: readonly FraudVelocityWindowThresholds[];
}

export interface FraudVelocityEventAuthorityPort {
  authorizePaymentConfirmedVelocityEvent(input: {
    readonly orderId: OrderId;
    readonly correlationId: CorrelationId;
  }): Promise<
    | {
        readonly status: "AUTHORIZED";
        readonly eventType: "PAYMENT_CONFIRMED";
        readonly occurredAt: Date;
      }
    | { readonly status: "DENIED"; readonly reasonCode: string }
  >;
}

export class FailClosedFraudVelocityEventAuthority implements FraudVelocityEventAuthorityPort {
  public async authorizePaymentConfirmedVelocityEvent(): Promise<{
    readonly status: "DENIED";
    readonly reasonCode: string;
  }> {
    return {
      reasonCode: "FRAUD_VELOCITY_EVENT_AUTHORITY_NOT_CONFIGURED",
      status: "DENIED",
    };
  }
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
  readonly velocity?: {
    readonly repository: FraudVelocityRepository;
    readonly policy: FraudVelocityPolicy;
    readonly eventAuthority?: FraudVelocityEventAuthorityPort;
  };
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
  private readonly policyVersion: FraudRiskPolicyVersion;
  private readonly velocityPolicy: FraudVelocityPolicy | undefined;

  public constructor(private readonly options: FraudRiskServiceOptions) {
    this.velocityPolicy = options.velocity
      ? validateFraudVelocityPolicy(options.velocity.policy)
      : undefined;
    this.policyVersion = options.velocity
      ? fraudRiskVelocityPolicyVersion
      : fraudRiskPolicyVersion;
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
    const evaluatedAt = this.now();
    facts = await this.attachVelocityFacts(facts, evaluatedAt);
    const result = evaluateFraudRiskFacts(facts, {
      rules: this.rules,
      supportedCurrencies: this.supportedCurrencies,
      ...(this.velocityPolicy ? { velocityPolicy: this.velocityPolicy } : {}),
    });
    const evaluation: FraudRiskEvaluation = {
      decision: result.decision,
      evaluatedAt,
      factFingerprint: fraudRiskFactFingerprint(facts, this.policyVersion),
      orderId: facts.orderId,
      policyVersion: this.policyVersion,
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

  public async recordVelocityEventForOrder(input: {
    readonly orderId: OrderId;
    readonly correlationId: CorrelationId;
  }): Promise<
    | {
        readonly status: "RECORDED" | "IDEMPOTENT";
        readonly subjectEventCount: number;
        readonly insertedEventCount: number;
      }
    | {
        readonly status: "UNAVAILABLE";
        readonly reasonCode: "VELOCITY_SIGNAL_UNAVAILABLE";
      }
  > {
    if (!this.options.velocity) {
      return {
        reasonCode: "VELOCITY_SIGNAL_UNAVAILABLE",
        status: "UNAVAILABLE",
      };
    }
    try {
      const authorized = await (
        this.options.velocity.eventAuthority ??
        new FailClosedFraudVelocityEventAuthority()
      ).authorizePaymentConfirmedVelocityEvent({
        correlationId: input.correlationId,
        orderId: input.orderId,
      });
      if (authorized.status !== "AUTHORIZED") {
        return {
          reasonCode: "VELOCITY_SIGNAL_UNAVAILABLE",
          status: "UNAVAILABLE",
        };
      }
      const recordedAt = this.now();
      if (
        authorized.eventType !== "PAYMENT_CONFIRMED" ||
        !isValidVelocityTimestamp(authorized.occurredAt) ||
        !isValidVelocityTimestamp(recordedAt) ||
        authorized.occurredAt.getTime() > recordedAt.getTime()
      ) {
        return {
          reasonCode: "VELOCITY_SIGNAL_UNAVAILABLE",
          status: "UNAVAILABLE",
        };
      }
      const result =
        await this.options.velocity.repository.recordOrderVelocityEvent({
          eventType: authorized.eventType,
          occurredAt: authorized.occurredAt,
          orderId: input.orderId,
          recordedAt,
        });
      if (result.status === "UNAVAILABLE") {
        return {
          reasonCode: "VELOCITY_SIGNAL_UNAVAILABLE",
          status: "UNAVAILABLE",
        };
      }
      await this.audit({
        correlationId: input.correlationId,
        entityId: input.orderId,
        eventType: "FRAUD_VELOCITY_EVENT_RECORDED",
        metadata: {
          eventType: authorized.eventType,
          insertedEventCount: result.insertedEventCount,
          orderId: input.orderId,
          policyVersion: this.policyVersion,
          subjectEventCount: result.subjectEventCount,
        },
        outcome: "SUCCEEDED",
        reasonCode: result.status,
      });
      return {
        insertedEventCount: result.insertedEventCount,
        status: result.status,
        subjectEventCount: result.subjectEventCount,
      };
    } catch {
      return {
        reasonCode: "VELOCITY_SIGNAL_UNAVAILABLE",
        status: "UNAVAILABLE",
      };
    }
  }

  public async isFraudCleared(
    orderIdValue: OrderId,
  ): Promise<FraudClearanceResult> {
    try {
      const current =
        await this.loadCurrentAuthoritativeEvaluation(orderIdValue);
      if (!current) {
        return { reasonCode: "FRAUD_DECISION_MISSING", status: "BLOCKED" };
      }
      if (current.decision === "ALLOW") {
        return { evaluation: current, status: "CLEARED" };
      }
      if (current.decision === "DENY") {
        return { reasonCode: "FRAUD_DENIED", status: "BLOCKED" };
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
      const current = await this.loadCurrentAuthoritativeEvaluation(
        openCase.orderId,
      );
      if (
        !current ||
        current.riskDecisionId !== openCase.evaluationId ||
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

  private async loadCurrentAuthoritativeEvaluation(
    orderIdValue: OrderId,
  ): Promise<FraudRiskEvaluation | null> {
    const facts = await this.options.repository.loadFacts(orderIdValue);
    if (!facts) {
      return null;
    }
    const evaluatedAt = this.now();
    const factsWithVelocity = await this.attachVelocityFacts(
      facts,
      evaluatedAt,
    );
    const factFingerprint = fraudRiskFactFingerprint(
      factsWithVelocity,
      this.policyVersion,
    );
    return this.options.repository.findEvaluationByFingerprint({
      factFingerprint,
      orderId: orderIdValue,
      policyVersion: this.policyVersion,
    });
  }

  private async attachVelocityFacts(
    facts: FraudRiskFacts,
    evaluatedAt: Date,
  ): Promise<FraudRiskFacts> {
    if (!this.options.velocity || !this.velocityPolicy) {
      return facts;
    }
    let velocity: FraudVelocityFacts | "UNAVAILABLE";
    try {
      velocity = await this.options.velocity.repository.loadVelocityFacts({
        evaluatedAt,
        orderId: facts.orderId,
        windows: this.velocityPolicy.windows,
      });
    } catch {
      velocity = "UNAVAILABLE";
    }
    const normalized =
      velocity === "UNAVAILABLE"
        ? unavailableVelocityFacts(evaluatedAt)
        : validateVelocityFactsForPolicy(velocity, facts, this.velocityPolicy);
    return { ...facts, velocity: normalized };
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
        policyVersion: this.policyVersion,
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
    try {
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
    } catch {
      // Audit is best-effort in KS-09-01; authoritative fraud state remains in persistence.
    }
  }
}

export const evaluateFraudRiskFacts = (
  facts: FraudRiskFacts,
  config: {
    readonly rules?: readonly FraudRiskRule[];
    readonly supportedCurrencies?: ReadonlySet<string>;
    readonly velocityPolicy?: FraudVelocityPolicy;
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
  if (
    config.velocityPolicy &&
    (!facts.velocity || facts.velocity.status === "UNAVAILABLE")
  ) {
    results.push({
      decision: "REVIEW",
      reasonCode: "VELOCITY_SIGNAL_UNAVAILABLE",
      score: 85,
    });
  }
  if (facts.velocity?.hasFutureEventAnomaly) {
    results.push({
      decision: "REVIEW",
      reasonCode: "VELOCITY_TIMESTAMP_ANOMALY",
      score: 85,
    });
  }
  if (facts.velocity && config.velocityPolicy) {
    results.push(
      ...evaluateVelocityThresholds(facts.velocity, config.velocityPolicy),
    );
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

export const defaultFraudVelocityWindows: readonly FraudVelocityWindow[] = [
  { durationMs: 15 * 60 * 1000, id: "PT15M" },
  { durationMs: 60 * 60 * 1000, id: "PT1H" },
  { durationMs: 24 * 60 * 60 * 1000, id: "PT24H" },
];

export const validateFraudVelocityPolicy = (
  policy: FraudVelocityPolicy,
): FraudVelocityPolicy => {
  const windowIds = new Set<FraudVelocityWindowId>();
  for (const window of policy.windows) {
    if (
      !Number.isSafeInteger(window.durationMs) ||
      canonicalVelocityWindowDurations[window.id] !== window.durationMs
    ) {
      throw new Error("Invalid fraud velocity window configuration");
    }
    windowIds.add(window.id);
  }
  if (windowIds.size !== policy.windows.length || windowIds.size === 0) {
    throw new Error("Invalid fraud velocity window configuration");
  }
  const thresholdKeys = new Set<string>();
  for (const threshold of policy.thresholds) {
    if (
      !windowIds.has(threshold.window) ||
      threshold.eventType !== "PAYMENT_CONFIRMED"
    ) {
      throw new Error("Invalid fraud velocity threshold configuration");
    }
    if (!/^[A-Z]{3}$/u.test(threshold.currency)) {
      throw new Error("Invalid fraud velocity threshold configuration");
    }
    if (!threshold.count && !threshold.amountMinor) {
      throw new Error("Invalid fraud velocity threshold configuration");
    }
    const thresholdKey = `${threshold.window}:${threshold.eventType}:${threshold.currency}`;
    if (thresholdKeys.has(thresholdKey)) {
      throw new Error("Invalid fraud velocity threshold configuration");
    }
    thresholdKeys.add(thresholdKey);
    validateThreshold(threshold.count);
    validateThreshold(threshold.amountMinor);
  }
  return deepFreezeFraudVelocityPolicy({
    thresholds: policy.thresholds.map((threshold) => ({
      ...threshold,
      ...(threshold.amountMinor
        ? { amountMinor: { ...threshold.amountMinor } }
        : {}),
      ...(threshold.count ? { count: { ...threshold.count } } : {}),
    })),
    windows: policy.windows.map((window) => ({ ...window })),
  });
};

const canonicalVelocityWindowDurations: Record<FraudVelocityWindowId, number> =
  {
    PT15M: 15 * 60 * 1000,
    PT1H: 60 * 60 * 1000,
    PT24H: 24 * 60 * 60 * 1000,
  };

const validateThreshold = (
  threshold: FraudVelocityThreshold | undefined,
): void => {
  if (!threshold) {
    return;
  }
  const review = toSafeThresholdBigInt(threshold.review);
  const deny = toSafeThresholdBigInt(threshold.deny);
  if (review <= 0n || deny <= 0n || review > deny) {
    throw new Error("Invalid fraud velocity threshold configuration");
  }
};

const toSafeThresholdBigInt = (value: number | bigint): bigint => {
  if (typeof value === "bigint") {
    return value;
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error("Invalid fraud velocity threshold configuration");
  }
  return BigInt(value);
};

const deepFreezeFraudVelocityPolicy = (
  policy: FraudVelocityPolicy,
): FraudVelocityPolicy => {
  for (const threshold of policy.thresholds) {
    if (threshold.count) {
      Object.freeze(threshold.count);
    }
    if (threshold.amountMinor) {
      Object.freeze(threshold.amountMinor);
    }
    Object.freeze(threshold);
  }
  for (const window of policy.windows) {
    Object.freeze(window);
  }
  Object.freeze(policy.thresholds);
  Object.freeze(policy.windows);
  return Object.freeze(policy);
};

const unavailableVelocityFacts = (evaluatedAt: Date): FraudVelocityFacts => ({
  aggregates: [],
  evaluatedAt,
  hasFutureEventAnomaly: false,
  status: "UNAVAILABLE",
  subjects: [],
});

const validateVelocityFactsForPolicy = (
  velocity: FraudVelocityFacts,
  facts: FraudRiskFacts,
  policy: FraudVelocityPolicy,
): FraudVelocityFacts => {
  if (
    velocity.status !== "AVAILABLE" ||
    velocity.subjects.length === 0 ||
    !isValidVelocityTimestamp(velocity.evaluatedAt)
  ) {
    return unavailableVelocityFacts(velocity.evaluatedAt);
  }
  const subjectTypes = new Set<string>();
  const subjectKeys = new Set<string>();
  for (const subject of velocity.subjects) {
    if (
      (subject.subjectType !== "CUSTOMER" &&
        subject.subjectType !== "CHECKOUT_EMAIL") ||
      subjectTypes.has(subject.subjectType) ||
      subjectKeys.has(`${subject.subjectType}:${subject.subjectKey}`) ||
      subject.subjectKey.trim().length === 0
    ) {
      return unavailableVelocityFacts(velocity.evaluatedAt);
    }
    subjectTypes.add(subject.subjectType);
    subjectKeys.add(`${subject.subjectType}:${subject.subjectKey}`);
  }
  const aggregateKeys = new Set<string>();
  for (const aggregate of velocity.aggregates) {
    const key = `${aggregate.subjectType}:${aggregate.eventType}:${aggregate.window}:${aggregate.currency}`;
    if (
      aggregate.eventType !== "PAYMENT_CONFIRMED" ||
      !subjectTypes.has(aggregate.subjectType) ||
      !policy.windows.some((window) => window.id === aggregate.window) ||
      aggregate.currency !== facts.currency ||
      aggregate.eventCount < 0 ||
      !Number.isSafeInteger(aggregate.eventCount) ||
      aggregate.amountMinorTotal < 0n ||
      aggregateKeys.has(key)
    ) {
      return unavailableVelocityFacts(velocity.evaluatedAt);
    }
    aggregateKeys.add(key);
  }
  const expectedKeys = new Set<string>();
  for (const subject of velocity.subjects) {
    for (const window of policy.windows) {
      expectedKeys.add(
        `${subject.subjectType}:PAYMENT_CONFIRMED:${window.id}:${facts.currency}`,
      );
    }
  }
  if (
    aggregateKeys.size !== expectedKeys.size ||
    [...expectedKeys].some((key) => !aggregateKeys.has(key))
  ) {
    return unavailableVelocityFacts(velocity.evaluatedAt);
  }
  return velocity;
};

const isValidVelocityTimestamp = (value: Date): boolean =>
  value instanceof Date && Number.isFinite(value.getTime());

const evaluateVelocityThresholds = (
  velocity: FraudVelocityFacts,
  policy: FraudVelocityPolicy,
): Exclude<FraudRiskRuleResult, { readonly decision: "ALLOW" }>[] => {
  const results: Exclude<
    FraudRiskRuleResult,
    { readonly decision: "ALLOW" }
  >[] = [];
  for (const aggregate of velocity.aggregates) {
    const threshold = policy.thresholds.find(
      (candidate) =>
        candidate.currency === aggregate.currency &&
        candidate.eventType === aggregate.eventType &&
        candidate.window === aggregate.window,
    );
    if (!threshold) {
      continue;
    }
    if (threshold.count) {
      const count = BigInt(aggregate.eventCount);
      if (count >= toSafeThresholdBigInt(threshold.count.deny)) {
        results.push({
          decision: "DENY",
          reasonCode: "VELOCITY_ORDER_COUNT_DENY",
          score: 100,
        });
      } else if (count >= toSafeThresholdBigInt(threshold.count.review)) {
        results.push({
          decision: "REVIEW",
          reasonCode: "VELOCITY_ORDER_COUNT_REVIEW",
          score: 80,
        });
      }
    }
    if (threshold.amountMinor) {
      if (
        aggregate.amountMinorTotal >=
        toSafeThresholdBigInt(threshold.amountMinor.deny)
      ) {
        results.push({
          decision: "DENY",
          reasonCode: "VELOCITY_AMOUNT_DENY",
          score: 100,
        });
      } else if (
        aggregate.amountMinorTotal >=
        toSafeThresholdBigInt(threshold.amountMinor.review)
      ) {
        results.push({
          decision: "REVIEW",
          reasonCode: "VELOCITY_AMOUNT_REVIEW",
          score: 80,
        });
      }
    }
  }
  return results;
};

export const fraudRiskFactFingerprint = (
  facts: FraudRiskFacts,
  policyVersion: FraudRiskEvaluation["policyVersion"] = fraudRiskPolicyVersion,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify(canonicalFraudRiskFacts(facts, policyVersion)),
      "utf8",
    )
    .digest("hex");

export const canonicalFraudRiskFacts = (
  facts: FraudRiskFacts,
  policyVersion: FraudRiskEvaluation["policyVersion"] = fraudRiskPolicyVersion,
) => ({
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
  policyVersion,
  velocity: facts.velocity ? canonicalVelocityFacts(facts.velocity) : null,
});

export const canonicalVelocityFacts = (velocity: FraudVelocityFacts) => ({
  aggregates: velocity.aggregates
    .map((aggregate) => ({
      amountMinorTotal: aggregate.amountMinorTotal.toString(),
      currency: aggregate.currency,
      eventCount: aggregate.eventCount,
      eventType: aggregate.eventType,
      subjectType: aggregate.subjectType,
      window: aggregate.window,
    }))
    .sort((left, right) =>
      `${left.subjectType}:${left.eventType}:${left.window}:${left.currency}`.localeCompare(
        `${right.subjectType}:${right.eventType}:${right.window}:${right.currency}`,
      ),
    ),
  hasFutureEventAnomaly: velocity.hasFutureEventAnomaly,
  status: velocity.status,
  subjects: velocity.subjects
    .map((subject) => ({ ...subject }))
    .sort((left, right) =>
      `${left.subjectType}:${left.subjectKey}`.localeCompare(
        `${right.subjectType}:${right.subjectKey}`,
      ),
    ),
});

export const emailVelocitySubjectKey = (
  secret: string,
  emailNormalized: string,
): string => {
  if (secret.length < 32) {
    throw new Error("Invalid fraud velocity correlation secret");
  }
  return `v1:${createHmac("sha256", secret)
    .update(emailNormalized, "utf8")
    .digest("hex")}`;
};

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
