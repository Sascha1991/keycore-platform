import {
  orderId,
  type DisputeEvidenceAuthoritativeFacts,
  type DisputeEvidenceAuditFacts,
  type DisputeEvidenceDeliveryFacts,
  type DisputeEvidenceFulfillmentFacts,
  type DisputeEvidencePaymentFacts,
  type DisputeEvidenceProcurementFacts,
  type DisputeEvidenceRepository,
  type DisputeEvidenceSection,
  type DisputeEvidenceSnapshot,
  type DisputeEvidenceSnapshotState,
  type OrderId,
  type disputeEvidenceSchemaVersion,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface SnapshotRow {
  readonly id: string;
  readonly order_id: string;
  readonly version: number;
  readonly state: DisputeEvidenceSnapshotState;
  readonly schema_version: typeof disputeEvidenceSchemaVersion;
  readonly policy_version: typeof disputeEvidenceSchemaVersion;
  readonly fact_fingerprint: string;
  readonly sections: unknown;
  readonly created_at: Date;
  readonly finalized_at: Date | null;
}

interface OrderEvidenceRow {
  readonly id: string;
  readonly customer_id: string | null;
  readonly checkout_email_normalized: string | null;
  readonly customer_amount_minor: string;
  readonly currency: string;
  readonly status: string;
  readonly payment_status: string;
  readonly procurement_status: string;
  readonly fulfillment_status: string;
  readonly risk_status: string;
  readonly refund_status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly customer_email_normalized: string | null;
  readonly email_verification_state: string | null;
  readonly customer_created_at: Date | null;
  readonly customer_updated_at: Date | null;
}

interface PaymentEvidenceRow {
  readonly id: string;
  readonly provider: string;
  readonly external_payment_id: string | null;
  readonly amount_minor: string;
  readonly currency: string;
  readonly status: string;
  readonly reconciliation_required: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly last_provider_event_at: Date | null;
}

interface FraudEvidenceRow {
  readonly id: string;
  readonly decision: string;
  readonly risk_score: number;
  readonly reason_codes: string[];
  readonly evaluated_at: Date;
  readonly policy_version: string;
  readonly fact_fingerprint: string;
  readonly review_case_id: string | null;
  readonly review_status: string | null;
  readonly review_resolution: string | null;
  readonly review_opened_at: Date | null;
  readonly review_resolved_at: Date | null;
}

interface VelocityEvidenceRow {
  readonly evaluation_id: string;
  readonly window_id: string;
  readonly event_count: string;
  readonly amount_minor_total: string;
  readonly currency: string;
  readonly event_type: string;
}

interface ProcurementEvidenceRow {
  readonly id: string;
  readonly supplier_id: string;
  readonly external_supplier_order_id: string | null;
  readonly status: string;
  readonly dispatch_state: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly last_reconciled_at: Date | null;
}

interface FulfillmentEvidenceRow {
  readonly id: string;
  readonly supplier_id: string;
  readonly external_supplier_order_id: string;
  readonly status: string;
  readonly retrieval_state: string;
  readonly delivery_state: string;
  readonly encrypted_secret_id: string | null;
  readonly failure_reason_code: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly retrieved_at: Date | null;
  readonly delivered_at: Date | null;
}

interface DeliveryEvidenceRow {
  readonly id: string;
  readonly fulfillment_id: string;
  readonly channel: string;
  readonly status: string;
  readonly delivery_reference: string | null;
  readonly failure_reason_code: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly delivered_at: Date | null;
}

interface GuestClaimEvidenceRow {
  readonly claim_succeeded: boolean;
  readonly claimed_at: Date | null;
  readonly active_challenge_count: string;
}

interface AuditEvidenceRow {
  readonly event_type: string;
  readonly timestamp_utc: Date;
  readonly outcome: string;
  readonly reason_code: string;
}

export class PostgresDisputeEvidenceRepository implements DisputeEvidenceRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async loadAuthoritativeFacts(
    requestedOrderId: OrderId,
  ): Promise<DisputeEvidenceAuthoritativeFacts | null> {
    return this.db.transaction(async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const order = await loadOrder(client, requestedOrderId);
      if (!order) {
        return null;
      }
      const payment = await loadPayment(client, requestedOrderId);
      const fraud = await loadFraud(client, requestedOrderId);
      const velocity = fraud
        ? await loadVelocity(client, requestedOrderId, fraud.evaluationId)
        : null;
      return {
        audit: await loadAudit(client, requestedOrderId),
        customer: order.customer_id
          ? {
              checkoutEmailMatchesCustomer:
                order.checkout_email_normalized &&
                order.customer_email_normalized
                  ? order.checkout_email_normalized ===
                    order.customer_email_normalized
                  : null,
              createdAt: requireDate(order.customer_created_at),
              customerId: order.customer_id,
              emailVerificationState:
                order.email_verification_state ?? "UNKNOWN",
              updatedAt: requireDate(order.customer_updated_at),
            }
          : null,
        delivery: await loadDelivery(client, requestedOrderId),
        fraud,
        fulfillment: await loadFulfillment(client, requestedOrderId),
        guestClaim: await loadGuestClaim(client, requestedOrderId),
        invoice: null,
        order: {
          amountMinor: BigInt(order.customer_amount_minor),
          checkoutEmailSnapshotPresent: Boolean(
            order.checkout_email_normalized,
          ),
          createdAt: order.created_at,
          currency: order.currency,
          customerId: order.customer_id,
          fulfillmentStatus: order.fulfillment_status,
          orderId: orderId(order.id),
          paymentStatus: order.payment_status,
          procurementStatus: order.procurement_status,
          refundStatus: order.refund_status,
          riskStatus: order.risk_status,
          status: order.status,
          updatedAt: order.updated_at,
        },
        payment,
        procurement: await loadProcurement(client, requestedOrderId),
        velocity,
      };
    });
  }

  public async persistDraft(input: {
    readonly snapshot: DisputeEvidenceSnapshot;
  }): Promise<DisputeEvidenceSnapshot> {
    return this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 9003))",
        [input.snapshot.orderId],
      );
      const existing = await findByFingerprint(client, input.snapshot);
      if (existing) {
        return existing;
      }
      const versionResult = await client.query<{ readonly version: number }>(
        `
          SELECT COALESCE(max(version), 0) + 1 AS version
          FROM dispute_evidence_snapshots
          WHERE order_id = $1 AND schema_version = $2
        `,
        [input.snapshot.orderId, input.snapshot.schemaVersion],
      );
      const version = versionResult.rows[0]?.version ?? 1;
      const inserted = await client.query<SnapshotRow>(
        `
          INSERT INTO dispute_evidence_snapshots(
            id, order_id, version, state, schema_version, policy_version,
            fact_fingerprint, sections, created_at, finalized_at
          )
          VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7::jsonb, $8, NULL)
          ON CONFLICT (order_id, schema_version, fact_fingerprint)
          DO NOTHING
          RETURNING ${snapshotReturning}
        `,
        [
          input.snapshot.evidenceSnapshotId,
          input.snapshot.orderId,
          version,
          input.snapshot.schemaVersion,
          input.snapshot.policyVersion,
          input.snapshot.factFingerprint,
          JSON.stringify(serializeSections(input.snapshot.sections)),
          input.snapshot.createdAt,
        ],
      );
      return inserted.rows[0]
        ? snapshotFromRow(inserted.rows[0])
        : requireSnapshot(await findByFingerprint(client, input.snapshot));
    });
  }

  public async findSnapshotById(
    snapshotId: string,
  ): Promise<DisputeEvidenceSnapshot | null> {
    const result = await this.db.query<SnapshotRow>(
      `
        SELECT ${snapshotReturning}
        FROM dispute_evidence_snapshots
        WHERE id = $1
        LIMIT 1
      `,
      [snapshotId],
    );
    return result.rows[0] ? snapshotFromRow(result.rows[0]) : null;
  }

  public async finalizeSnapshot(input: {
    readonly snapshotId: string;
    readonly orderId: OrderId;
    readonly finalizedAt: Date;
  }): Promise<
    | {
        readonly status: "FINALIZED" | "ALREADY_FINALIZED";
        readonly snapshot: DisputeEvidenceSnapshot;
      }
    | { readonly status: "NOT_FOUND" | "ORDER_MISMATCH" | "NOT_FINALIZABLE" }
  > {
    return this.db.transaction(async (client) => {
      const current = await findByIdForUpdate(client, input.snapshotId);
      if (!current) {
        return { status: "NOT_FOUND" };
      }
      if (current.orderId !== input.orderId) {
        return { status: "ORDER_MISMATCH" };
      }
      if (current.state === "FINALIZED") {
        return { snapshot: current, status: "ALREADY_FINALIZED" };
      }
      if (current.state !== "DRAFT") {
        return { status: "NOT_FINALIZABLE" };
      }
      const updated = await client.query<SnapshotRow>(
        `
          UPDATE dispute_evidence_snapshots
          SET state = 'FINALIZED', finalized_at = $2
          WHERE id = $1 AND state = 'DRAFT'
          RETURNING ${snapshotReturning}
        `,
        [input.snapshotId, input.finalizedAt],
      );
      return {
        snapshot: snapshotFromRow(requireRow(updated.rows[0])),
        status: "FINALIZED",
      };
    });
  }
}

const snapshotReturning = `
  id::text, order_id::text, version, state, schema_version, policy_version,
  fact_fingerprint, sections, created_at, finalized_at
`;

const loadOrder = async (
  db: Queryable,
  requestedOrderId: OrderId,
): Promise<OrderEvidenceRow | null> => {
  const result = await db.query<OrderEvidenceRow>(
    `
      SELECT
        o.id::text, o.customer_id::text, o.checkout_email_normalized,
        o.customer_amount_minor, o.currency, o.status, o.payment_status,
        o.procurement_status, o.fulfillment_status, o.risk_status,
        o.refund_status, o.created_at, o.updated_at,
        c.email_normalized AS customer_email_normalized,
        c.email_verification_state, c.created_at AS customer_created_at,
        c.updated_at AS customer_updated_at
      FROM keycore_orders o
      LEFT JOIN keycore_customers c ON c.id = o.customer_id
      WHERE o.id = $1
      LIMIT 1
    `,
    [requestedOrderId],
  );
  return result.rows[0] ?? null;
};

const loadPayment = async (
  db: Queryable,
  requestedOrderId: OrderId,
): Promise<DisputeEvidencePaymentFacts | null> => {
  const result = await db.query<PaymentEvidenceRow>(
    `
      SELECT id::text, provider, external_payment_id, amount_minor, currency,
        status, reconciliation_required, created_at, updated_at,
        last_provider_event_at
      FROM order_payments
      WHERE order_id = $1
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `,
    [requestedOrderId],
  );
  const row = result.rows[0];
  return row
    ? {
        amountMinor: BigInt(row.amount_minor),
        createdAt: row.created_at,
        currency: row.currency,
        externalPaymentId: row.external_payment_id,
        lastProviderEventAt: row.last_provider_event_at,
        paymentId: row.id,
        provider: row.provider,
        reconciliationRequired: row.reconciliation_required,
        status: row.status,
        updatedAt: row.updated_at,
      }
    : null;
};

const loadFraud = async (
  db: Queryable,
  requestedOrderId: OrderId,
): Promise<DisputeEvidenceAuthoritativeFacts["fraud"]> => {
  const result = await db.query<FraudEvidenceRow>(
    `
      SELECT
        e.id::text, e.decision, e.risk_score, e.reason_codes,
        e.evaluated_at, e.policy_version, e.fact_fingerprint,
        c.id::text AS review_case_id, c.status AS review_status,
        c.resolution AS review_resolution, c.opened_at AS review_opened_at,
        c.resolved_at AS review_resolved_at
      FROM fraud_risk_evaluations e
      LEFT JOIN fraud_manual_review_cases c
        ON c.evaluation_id = e.id AND c.source = 'FRAUD'
      WHERE e.order_id = $1
      ORDER BY e.evaluated_at DESC, e.id DESC
      LIMIT 1
    `,
    [requestedOrderId],
  );
  const row = result.rows[0];
  return row
    ? {
        decision: row.decision,
        evaluatedAt: row.evaluated_at,
        evaluationId: row.id,
        factFingerprint: row.fact_fingerprint,
        fraudPolicyVersion: row.policy_version,
        reasonCodes: row.reason_codes,
        reviewCaseId: row.review_case_id,
        reviewOpenedAt: row.review_opened_at,
        reviewResolution: row.review_resolution,
        reviewResolvedAt: row.review_resolved_at,
        reviewStatus: row.review_status,
        riskScore: row.risk_score,
      }
    : null;
};

const loadVelocity = async (
  db: Queryable,
  requestedOrderId: OrderId,
  evaluationId: string,
): Promise<DisputeEvidenceAuthoritativeFacts["velocity"]> => {
  const result = await db.query<VelocityEvidenceRow>(
    `
      SELECT
        $2::text AS evaluation_id,
        'PT24H'::text AS window_id,
        count(*)::text AS event_count,
        COALESCE(sum(amount_minor), 0)::text AS amount_minor_total,
        currency,
        event_type
      FROM fraud_velocity_events
      WHERE order_id = $1
      GROUP BY currency, event_type
      ORDER BY event_type, currency
    `,
    [requestedOrderId, evaluationId],
  );
  return result.rows.length > 0
    ? {
        aggregates: result.rows.map((row) => ({
          amountMinorTotal: BigInt(row.amount_minor_total),
          currency: row.currency,
          eventCount: Number(row.event_count),
          eventType: row.event_type,
          window: row.window_id,
        })),
        evaluationId,
      }
    : null;
};

const loadProcurement = async (
  db: Queryable,
  requestedOrderId: OrderId,
): Promise<readonly DisputeEvidenceProcurementFacts[]> => {
  const result = await db.query<ProcurementEvidenceRow>(
    `
      SELECT id::text, supplier_id, external_supplier_order_id, status,
        dispatch_state, created_at, updated_at, last_reconciled_at
      FROM procurement_operations
      WHERE order_id = $1
      ORDER BY created_at, id
    `,
    [requestedOrderId],
  );
  return result.rows.map((row) => ({
    completedAt: row.last_reconciled_at,
    createdAt: row.created_at,
    dispatchState: row.dispatch_state,
    externalSupplierOrderId: row.external_supplier_order_id,
    procurementOperationId: row.id,
    status: row.status,
    supplierId: row.supplier_id,
    updatedAt: row.updated_at,
  }));
};

const loadFulfillment = async (
  db: Queryable,
  requestedOrderId: OrderId,
): Promise<readonly DisputeEvidenceFulfillmentFacts[]> => {
  const result = await db.query<FulfillmentEvidenceRow>(
    `
      SELECT id::text, supplier_id, external_supplier_order_id, status,
        retrieval_state, delivery_state, encrypted_secret_id::text,
        failure_reason_code, created_at, updated_at, retrieved_at, delivered_at
      FROM fulfillment_operations
      WHERE order_id = $1
      ORDER BY created_at, id
    `,
    [requestedOrderId],
  );
  return result.rows.map((row) => ({
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    deliveryState: row.delivery_state,
    encryptedSecretPresent: Boolean(row.encrypted_secret_id),
    externalSupplierOrderId: row.external_supplier_order_id,
    failureReasonCode: row.failure_reason_code,
    fulfillmentId: row.id,
    retrievalState: row.retrieval_state,
    retrievedAt: row.retrieved_at,
    status: row.status,
    supplierId: row.supplier_id,
    updatedAt: row.updated_at,
  }));
};

const loadDelivery = async (
  db: Queryable,
  requestedOrderId: OrderId,
): Promise<readonly DisputeEvidenceDeliveryFacts[]> => {
  const result = await db.query<DeliveryEvidenceRow>(
    `
      SELECT id::text, fulfillment_id::text, channel, status,
        delivery_reference, failure_reason_code, created_at, updated_at,
        delivered_at
      FROM customer_key_delivery_attempts
      WHERE order_id = $1
      ORDER BY created_at, id
    `,
    [requestedOrderId],
  );
  return result.rows.map((row) => ({
    attemptId: row.id,
    channel: row.channel,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    deliveryReferencePresent: Boolean(row.delivery_reference),
    failureReasonCode: row.failure_reason_code,
    fulfillmentId: row.fulfillment_id,
    status: row.status,
    updatedAt: row.updated_at,
  }));
};

const loadGuestClaim = async (
  db: Queryable,
  requestedOrderId: OrderId,
): Promise<DisputeEvidenceAuthoritativeFacts["guestClaim"]> => {
  const result = await db.query<GuestClaimEvidenceRow>(
    `
      SELECT
        EXISTS (
          SELECT 1 FROM guest_order_claim_challenges
          WHERE order_id = $1 AND consumed_at IS NOT NULL
        ) AS claim_succeeded,
        (
          SELECT max(consumed_at) FROM guest_order_claim_challenges
          WHERE order_id = $1 AND consumed_at IS NOT NULL
        ) AS claimed_at,
        (
          SELECT count(*)::text FROM guest_order_claim_challenges
          WHERE order_id = $1 AND consumed_at IS NULL AND revoked_at IS NULL
        ) AS active_challenge_count
    `,
    [requestedOrderId],
  );
  const row = result.rows[0];
  if (!row || (!row.claim_succeeded && row.active_challenge_count === "0")) {
    return null;
  }
  return {
    activeChallengeCount: Number(row.active_challenge_count),
    claimedAt: row.claimed_at,
    claimSucceeded: row.claim_succeeded,
  };
};

const auditAllowlist = new Set([
  "ORDER_CREATED",
  "PAYMENT_CAPTURED",
  "FRAUD_RISK_EVALUATED",
  "FRAUD_MANUAL_REVIEW_RESOLVED",
  "CUSTOMER_GUEST_ORDER_CLAIMED",
  "FULFILLMENT_KEY_RETRIEVED",
  "FULFILLMENT_DELIVERY_COMPLETED",
  "CUSTOMER_KEY_ACCESS_GRANTED",
]);

const loadAudit = async (
  db: Queryable,
  requestedOrderId: OrderId,
): Promise<readonly DisputeEvidenceAuditFacts[]> => {
  const result = await db.query<AuditEvidenceRow>(
    `
      SELECT event_type, timestamp_utc, outcome, reason_code
      FROM audit_events
      WHERE entity->>'id' = $1
        AND event_type = ANY($2::text[])
      ORDER BY timestamp_utc, id
      LIMIT 25
    `,
    [requestedOrderId, [...auditAllowlist]],
  );
  return result.rows.map((row) => ({
    eventType: row.event_type,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    timestampUtc: row.timestamp_utc,
  }));
};

const findByFingerprint = async (
  db: Queryable,
  snapshot: DisputeEvidenceSnapshot,
): Promise<DisputeEvidenceSnapshot | null> => {
  const result = await db.query<SnapshotRow>(
    `
      SELECT ${snapshotReturning}
      FROM dispute_evidence_snapshots
      WHERE order_id = $1
        AND schema_version = $2
        AND fact_fingerprint = $3
      LIMIT 1
    `,
    [snapshot.orderId, snapshot.schemaVersion, snapshot.factFingerprint],
  );
  return result.rows[0] ? snapshotFromRow(result.rows[0]) : null;
};

const findByIdForUpdate = async (
  db: Queryable,
  snapshotId: string,
): Promise<DisputeEvidenceSnapshot | null> => {
  const result = await db.query<SnapshotRow>(
    `
      SELECT ${snapshotReturning}
      FROM dispute_evidence_snapshots
      WHERE id = $1
      FOR UPDATE
    `,
    [snapshotId],
  );
  return result.rows[0] ? snapshotFromRow(result.rows[0]) : null;
};

const snapshotFromRow = (row: SnapshotRow): DisputeEvidenceSnapshot => ({
  createdAt: row.created_at,
  evidenceSnapshotId: row.id,
  factFingerprint: row.fact_fingerprint,
  finalizedAt: row.finalized_at,
  orderId: orderId(row.order_id),
  policyVersion: row.policy_version,
  schemaVersion: row.schema_version,
  sections: parseSections(row.sections),
  state: row.state,
  version: row.version,
});

const serializeSections = (
  sections: readonly DisputeEvidenceSection[],
): unknown =>
  sections.map((section) => ({
    ...section,
    facts: section.facts.map((fact) => ({
      ...fact,
      observedAt: fact.observedAt?.toISOString() ?? null,
    })),
  }));

const parseSections = (sections: unknown): readonly DisputeEvidenceSection[] =>
  (sections as DisputeEvidenceSection[]).map((section) => ({
    ...section,
    facts: section.facts.map((fact) => ({
      ...fact,
      observedAt: fact.observedAt ? new Date(fact.observedAt) : null,
    })),
  }));

const requireSnapshot = (
  snapshot: DisputeEvidenceSnapshot | null,
): DisputeEvidenceSnapshot => {
  if (!snapshot) {
    throw new Error("Expected dispute evidence snapshot");
  }
  return snapshot;
};

const requireRow = <TRow>(row: TRow | undefined): TRow => {
  if (!row) {
    throw new Error("Expected dispute evidence row");
  }
  return row;
};

const requireDate = (date: Date | null): Date => {
  if (!date) {
    throw new Error("Expected dispute evidence customer date");
  }
  return date;
};
