import {
  customerId,
  currency,
  money,
  orderId,
  type FraudManualReviewCase,
  type FraudRiskEvaluation,
  type FraudRiskFacts,
  type FraudRiskReasonCode,
  type FraudRiskRepository,
  type OrderId,
} from "../../packages/platform/src/contracts.js";
import type {
  OrderPaymentStatus,
  OrderRiskStatus,
  OrderStatus,
} from "../../packages/platform/src/orders/order-orchestration.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface FraudEvaluationRow {
  readonly id: string;
  readonly order_id: string;
  readonly decision: FraudRiskEvaluation["decision"];
  readonly risk_score: number;
  readonly reason_codes: FraudRiskReasonCode[];
  readonly evaluated_at: Date;
  readonly policy_version: FraudRiskEvaluation["policyVersion"];
  readonly fact_fingerprint: string;
}

interface FraudReviewCaseRow {
  readonly id: string;
  readonly order_id: string;
  readonly source: "FRAUD";
  readonly status: FraudManualReviewCase["status"];
  readonly evaluation_id: string;
  readonly fact_fingerprint: string;
  readonly reason_codes: FraudRiskReasonCode[];
  readonly opened_at: Date;
  readonly resolved_at: Date | null;
  readonly resolution: FraudManualReviewCase["resolution"] | null;
  readonly operator_reference: string | null;
}

interface FraudFactRow {
  readonly id: string;
  readonly customer_id: string | null;
  readonly checkout_email_normalized: string | null;
  readonly customer_amount_minor: string;
  readonly currency: string;
  readonly status: OrderStatus;
  readonly payment_status: OrderPaymentStatus;
  readonly risk_status: OrderRiskStatus;
  readonly created_at: Date;
  readonly email_verification_state: "VERIFIED" | "UNVERIFIED" | null;
}

export class PostgresFraudRiskRepository implements FraudRiskRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async loadFacts(
    requestedOrderId: OrderId,
  ): Promise<FraudRiskFacts | null> {
    const result = await this.db.query<FraudFactRow>(
      `
        SELECT
          o.id::text,
          o.customer_id::text,
          o.checkout_email_normalized,
          o.customer_amount_minor,
          o.currency,
          o.status,
          o.payment_status,
          o.risk_status,
          o.created_at,
          c.email_verification_state
        FROM keycore_orders o
        LEFT JOIN keycore_customers c ON c.id = o.customer_id
        WHERE o.id = $1
        LIMIT 1
      `,
      [requestedOrderId],
    );
    const row = result.rows[0];
    return row ? factsFromRow(row) : null;
  }

  public async persistEvaluation(input: {
    readonly evaluation: FraudRiskEvaluation;
    readonly openReviewCase?: FraudManualReviewCase;
  }): Promise<{
    readonly evaluation: FraudRiskEvaluation;
    readonly reviewCase?: FraudManualReviewCase | null;
  }> {
    return this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 9001))",
        [input.evaluation.orderId],
      );
      const inserted = await client.query<FraudEvaluationRow>(
        `
          INSERT INTO fraud_risk_evaluations(
            id, order_id, decision, risk_score, reason_codes,
            evaluated_at, policy_version, fact_fingerprint
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (order_id, policy_version, fact_fingerprint)
          DO NOTHING
          RETURNING ${evaluationReturning}
        `,
        evaluationValues(input.evaluation),
      );
      const evaluation =
        inserted.rows[0] !== undefined
          ? evaluationFromRow(inserted.rows[0])
          : await findEvaluationByFingerprint(client, input.evaluation);
      if (!evaluation) {
        throw new Error("Expected fraud risk evaluation after persistence");
      }
      let reviewCase: FraudManualReviewCase | null = null;
      if (input.openReviewCase) {
        const existing = await findOpenCaseForEvaluation(
          client,
          evaluation.riskDecisionId,
        );
        if (existing) {
          reviewCase = existing;
        } else {
          const insertedCase = await client.query<FraudReviewCaseRow>(
            `
              INSERT INTO fraud_manual_review_cases(
                id, order_id, source, status, evaluation_id, fact_fingerprint,
                reason_codes, opened_at, resolved_at, resolution, operator_reference
              )
              VALUES ($1, $2, 'FRAUD', 'OPEN', $3, $4, $5, $6, NULL, NULL, NULL)
              ON CONFLICT DO NOTHING
              RETURNING ${caseReturning}
            `,
            [
              input.openReviewCase.caseId,
              evaluation.orderId,
              evaluation.riskDecisionId,
              evaluation.factFingerprint,
              [...evaluation.reasonCodes],
              input.openReviewCase.openedAt,
            ],
          );
          reviewCase =
            insertedCase.rows[0] !== undefined
              ? caseFromRow(insertedCase.rows[0])
              : await findOpenCaseForEvaluation(
                  client,
                  evaluation.riskDecisionId,
                );
        }
      }
      return {
        evaluation,
        ...(reviewCase ? { reviewCase } : {}),
      };
    });
  }

  public async getCurrentEvaluation(
    requestedOrderId: OrderId,
  ): Promise<FraudRiskEvaluation | null> {
    const result = await this.db.query<FraudEvaluationRow>(
      `
        SELECT ${evaluationReturning}
        FROM fraud_risk_evaluations
        WHERE order_id = $1
        ORDER BY evaluated_at DESC, id DESC
        LIMIT 1
      `,
      [requestedOrderId],
    );
    return result.rows[0] ? evaluationFromRow(result.rows[0]) : null;
  }

  public async findEvaluationByFingerprint(input: {
    readonly orderId: OrderId;
    readonly policyVersion: FraudRiskEvaluation["policyVersion"];
    readonly factFingerprint: string;
  }): Promise<FraudRiskEvaluation | null> {
    return findEvaluationByFingerprint(this.db, input);
  }

  public async findOpenFraudReviewCase(
    requestedOrderId: OrderId,
  ): Promise<FraudManualReviewCase | null> {
    return findOpenCase(this.db, requestedOrderId);
  }

  public async findFraudReviewCaseById(
    caseId: string,
  ): Promise<FraudManualReviewCase | null> {
    const result = await this.db.query<FraudReviewCaseRow>(
      `
        SELECT ${caseReturning}
        FROM fraud_manual_review_cases
        WHERE id = $1
          AND source = 'FRAUD'
        LIMIT 1
      `,
      [caseId],
    );
    return result.rows[0] ? caseFromRow(result.rows[0]) : null;
  }

  public async findFraudReviewCaseForEvaluation(
    evaluationId: string,
  ): Promise<FraudManualReviewCase | null> {
    const result = await this.db.query<FraudReviewCaseRow>(
      `
        SELECT ${caseReturning}
        FROM fraud_manual_review_cases
        WHERE evaluation_id = $1
          AND source = 'FRAUD'
        LIMIT 1
      `,
      [evaluationId],
    );
    return result.rows[0] ? caseFromRow(result.rows[0]) : null;
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
    return this.db.transaction(async (client) => {
      const locked = await client.query<FraudReviewCaseRow>(
        `
          SELECT ${caseReturning}
          FROM fraud_manual_review_cases
          WHERE id = $1
            AND source = 'FRAUD'
          FOR UPDATE
        `,
        [input.caseId],
      );
      const current = locked.rows[0] ? caseFromRow(locked.rows[0]) : null;
      if (!current) {
        return { status: "NOT_FOUND" };
      }
      if (current.factFingerprint !== input.expectedFactFingerprint) {
        return { status: "STALE_EVALUATION" };
      }
      if (current.status !== "OPEN") {
        return { reviewCase: current, status: "ALREADY_RESOLVED" };
      }
      const updated = await client.query<FraudReviewCaseRow>(
        `
          UPDATE fraud_manual_review_cases
          SET status = $2,
            resolution = $2,
            resolved_at = $3,
            operator_reference = $4
          WHERE id = $1
            AND status = 'OPEN'
            AND fact_fingerprint = $5
          RETURNING ${caseReturning}
        `,
        [
          input.caseId,
          input.resolution,
          input.now,
          input.operatorReference,
          input.expectedFactFingerprint,
        ],
      );
      return updated.rows[0]
        ? { reviewCase: caseFromRow(updated.rows[0]), status: "RESOLVED" }
        : { status: "STALE_EVALUATION" };
    });
  }
}

const evaluationReturning = `
  id::text,
  order_id::text,
  decision,
  risk_score,
  reason_codes,
  evaluated_at,
  policy_version,
  fact_fingerprint
`;

const caseReturning = `
  id::text,
  order_id::text,
  source,
  status,
  evaluation_id::text,
  fact_fingerprint,
  reason_codes,
  opened_at,
  resolved_at,
  resolution,
  operator_reference
`;

const findEvaluationByFingerprint = async (
  db: Queryable,
  input: {
    readonly orderId: OrderId;
    readonly policyVersion: FraudRiskEvaluation["policyVersion"];
    readonly factFingerprint: string;
  },
): Promise<FraudRiskEvaluation | null> => {
  const result = await db.query<FraudEvaluationRow>(
    `
      SELECT ${evaluationReturning}
      FROM fraud_risk_evaluations
      WHERE order_id = $1
        AND policy_version = $2
        AND fact_fingerprint = $3
      LIMIT 1
    `,
    [input.orderId, input.policyVersion, input.factFingerprint],
  );
  return result.rows[0] ? evaluationFromRow(result.rows[0]) : null;
};

const findOpenCase = async (
  db: Queryable,
  requestedOrderId: OrderId,
): Promise<FraudManualReviewCase | null> => {
  const result = await db.query<FraudReviewCaseRow>(
    `
      SELECT ${caseReturning}
      FROM fraud_manual_review_cases
      WHERE order_id = $1
        AND source = 'FRAUD'
        AND status = 'OPEN'
      LIMIT 1
    `,
    [requestedOrderId],
  );
  return result.rows[0] ? caseFromRow(result.rows[0]) : null;
};

const findOpenCaseForEvaluation = async (
  db: Queryable,
  evaluationId: string,
): Promise<FraudManualReviewCase | null> => {
  const result = await db.query<FraudReviewCaseRow>(
    `
      SELECT ${caseReturning}
      FROM fraud_manual_review_cases
      WHERE evaluation_id = $1
        AND source = 'FRAUD'
        AND status = 'OPEN'
      LIMIT 1
    `,
    [evaluationId],
  );
  return result.rows[0] ? caseFromRow(result.rows[0]) : null;
};

const factsFromRow = (row: FraudFactRow): FraudRiskFacts => ({
  checkoutEmailSnapshotPresent: Boolean(row.checkout_email_normalized),
  createdAt: row.created_at,
  currency: row.currency,
  customerId: row.customer_id ? customerId(row.customer_id) : null,
  customerVerificationState: row.customer_id
    ? (row.email_verification_state ?? "UNKNOWN")
    : null,
  orderAmountMinor: money(
    BigInt(row.customer_amount_minor),
    currency(row.currency),
  ).amountMinor,
  orderId: orderId(row.id),
  orderRiskStatus: row.risk_status,
  orderStatus: row.status,
  paymentStatus: row.payment_status,
});

const evaluationValues = (
  evaluation: FraudRiskEvaluation,
): readonly unknown[] => [
  evaluation.riskDecisionId,
  evaluation.orderId,
  evaluation.decision,
  evaluation.riskScore,
  [...evaluation.reasonCodes],
  evaluation.evaluatedAt,
  evaluation.policyVersion,
  evaluation.factFingerprint,
];

const evaluationFromRow = (row: FraudEvaluationRow): FraudRiskEvaluation => ({
  decision: row.decision,
  evaluatedAt: row.evaluated_at,
  factFingerprint: row.fact_fingerprint,
  orderId: orderId(row.order_id),
  policyVersion: row.policy_version,
  reasonCodes: row.reason_codes,
  riskDecisionId: row.id,
  riskScore: row.risk_score,
});

const caseFromRow = (row: FraudReviewCaseRow): FraudManualReviewCase => ({
  caseId: row.id,
  evaluationId: row.evaluation_id,
  factFingerprint: row.fact_fingerprint,
  openedAt: row.opened_at,
  orderId: orderId(row.order_id),
  reasonCodes: row.reason_codes,
  ...(row.operator_reference
    ? { operatorReference: row.operator_reference }
    : {}),
  ...(row.resolution ? { resolution: row.resolution } : {}),
  ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  source: row.source,
  status: row.status,
});
