import type {
  FraudManualReviewCase,
  FraudRiskEvaluation,
  FraudRiskFacts,
  FraudRiskRepository,
  KeyCoreOrder,
  OrderId,
} from "../../packages/platform/src/contracts.js";
import { riskFactsFromOrder } from "../../packages/platform/src/contracts.js";

export class InMemoryFraudRiskRepository implements FraudRiskRepository {
  private readonly orders = new Map<OrderId, KeyCoreOrder>();
  private readonly customerVerification = new Map<
    string,
    "VERIFIED" | "UNVERIFIED" | "UNKNOWN"
  >();
  private readonly evaluations = new Map<string, FraudRiskEvaluation>();
  private readonly evaluationKeys = new Map<string, string>();
  private readonly evaluationSequence = new Map<string, number>();
  private readonly reviewCases = new Map<string, FraudManualReviewCase>();
  private sequence = 0;

  public addOrder(order: KeyCoreOrder): void {
    this.orders.set(order.id, order);
  }

  public setCustomerVerification(
    customerId: string,
    state: "VERIFIED" | "UNVERIFIED" | "UNKNOWN",
  ): void {
    this.customerVerification.set(customerId, state);
  }

  public async loadFacts(orderId: OrderId): Promise<FraudRiskFacts | null> {
    const order = this.orders.get(orderId);
    if (!order) {
      return null;
    }
    return riskFactsFromOrder(
      order,
      order.customerId
        ? (this.customerVerification.get(order.customerId) ?? "UNKNOWN")
        : null,
    );
  }

  public async persistEvaluation(input: {
    readonly evaluation: FraudRiskEvaluation;
    readonly openReviewCase?: FraudManualReviewCase;
  }): Promise<{
    readonly evaluation: FraudRiskEvaluation;
    readonly reviewCase?: FraudManualReviewCase | null;
  }> {
    const key = evaluationKey(input.evaluation);
    const existingId = this.evaluationKeys.get(key);
    const evaluation = existingId
      ? required(this.evaluations.get(existingId))
      : input.evaluation;
    if (!existingId) {
      this.evaluations.set(evaluation.riskDecisionId, evaluation);
      this.evaluationKeys.set(key, evaluation.riskDecisionId);
      this.evaluationSequence.set(evaluation.riskDecisionId, this.sequence);
      this.sequence += 1;
    }
    let reviewCase: FraudManualReviewCase | null = null;
    if (input.openReviewCase) {
      reviewCase =
        [...this.reviewCases.values()].find(
          (candidate) =>
            candidate.source === "FRAUD" &&
            candidate.evaluationId === evaluation.riskDecisionId &&
            candidate.status === "OPEN",
        ) ?? null;
      if (!reviewCase) {
        reviewCase = {
          ...input.openReviewCase,
          evaluationId: evaluation.riskDecisionId,
          factFingerprint: evaluation.factFingerprint,
        };
        this.reviewCases.set(reviewCase.caseId, reviewCase);
      }
    }
    return {
      evaluation,
      ...(reviewCase ? { reviewCase } : {}),
    };
  }

  public async getCurrentEvaluation(
    orderId: OrderId,
  ): Promise<FraudRiskEvaluation | null> {
    return (
      [...this.evaluations.values()]
        .filter((evaluation) => evaluation.orderId === orderId)
        .sort(
          (left, right) =>
            right.evaluatedAt.getTime() - left.evaluatedAt.getTime() ||
            (this.evaluationSequence.get(right.riskDecisionId) ?? 0) -
              (this.evaluationSequence.get(left.riskDecisionId) ?? 0),
        )[0] ?? null
    );
  }

  public async findEvaluationByFingerprint(input: {
    readonly orderId: OrderId;
    readonly policyVersion: FraudRiskEvaluation["policyVersion"];
    readonly factFingerprint: string;
  }): Promise<FraudRiskEvaluation | null> {
    return (
      [...this.evaluations.values()].find(
        (evaluation) =>
          evaluation.orderId === input.orderId &&
          evaluation.policyVersion === input.policyVersion &&
          evaluation.factFingerprint === input.factFingerprint,
      ) ?? null
    );
  }

  public async findOpenFraudReviewCase(
    orderId: OrderId,
  ): Promise<FraudManualReviewCase | null> {
    return (
      [...this.reviewCases.values()].find(
        (candidate) =>
          candidate.orderId === orderId &&
          candidate.source === "FRAUD" &&
          candidate.status === "OPEN",
      ) ?? null
    );
  }

  public async findFraudReviewCaseById(
    caseId: string,
  ): Promise<FraudManualReviewCase | null> {
    return this.reviewCases.get(caseId) ?? null;
  }

  public async findFraudReviewCaseForEvaluation(
    evaluationId: string,
  ): Promise<FraudManualReviewCase | null> {
    return (
      [...this.reviewCases.values()].find(
        (candidate) => candidate.evaluationId === evaluationId,
      ) ?? null
    );
  }

  public async resolveFraudReviewCase(input: {
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
  > {
    const current = this.reviewCases.get(input.caseId);
    if (!current) {
      return { status: "NOT_FOUND" };
    }
    if (current.factFingerprint !== input.expectedFactFingerprint) {
      return { status: "STALE_EVALUATION" };
    }
    if (current.status !== "OPEN") {
      return { reviewCase: current, status: "ALREADY_RESOLVED" };
    }
    const resolved: FraudManualReviewCase = {
      ...current,
      operatorReference: input.operatorReference,
      resolution: input.resolution,
      resolvedAt: input.now,
      status: input.resolution,
    };
    this.reviewCases.set(input.caseId, resolved);
    return { reviewCase: resolved, status: "RESOLVED" };
  }
}

const evaluationKey = (evaluation: FraudRiskEvaluation): string =>
  `${evaluation.orderId}:${evaluation.policyVersion}:${evaluation.factFingerprint}`;

const required = <TValue>(value: TValue | undefined): TValue => {
  if (value === undefined) {
    throw new Error("Expected in-memory fraud risk value");
  }
  return value;
};
