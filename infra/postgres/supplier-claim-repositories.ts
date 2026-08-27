import {
  orderId,
  type SupplierClaim,
  type SupplierClaimDetail,
  type SupplierClaimEvent,
  type SupplierClaimEvidenceLink,
  type SupplierClaimEvidenceReference,
  type SupplierClaimFulfillmentReference,
  type SupplierClaimOrderReference,
  type SupplierClaimProcurementReference,
  type SupplierClaimRepository,
  type SupplierClaimStatus,
  type SupplierClaimSubmissionOperation,
  type SupplierClaimSupportReference,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface ClaimRow {
  readonly id: string;
  readonly order_id: string;
  readonly support_case_id: string;
  readonly procurement_operation_id: string;
  readonly fulfillment_id: string | null;
  readonly supplier_id: string;
  readonly supplier_order_reference: string | null;
  readonly category: SupplierClaim["category"];
  readonly source: SupplierClaim["source"];
  readonly status: SupplierClaim["status"];
  readonly priority: SupplierClaim["priority"];
  readonly outcome: SupplierClaim["outcome"];
  readonly idempotency_key: string;
  readonly idempotency_fingerprint: string;
  readonly record_version: number;
  readonly correlation_id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly resolved_at: Date | null;
  readonly closed_at: Date | null;
}

interface EvidenceLinkRow {
  readonly id: string;
  readonly claim_id: string;
  readonly evidence_snapshot_id: string;
  readonly order_id: string;
  readonly created_at: Date;
}

interface ClaimEventRow {
  readonly id: string;
  readonly claim_id: string;
  readonly event_type: SupplierClaimEvent["eventType"];
  readonly actor_type: SupplierClaimEvent["actorType"];
  readonly actor_reference: string;
  readonly from_status: SupplierClaimEvent["fromStatus"];
  readonly to_status: SupplierClaimEvent["toStatus"];
  readonly evidence_snapshot_id: string | null;
  readonly submission_operation_id: string | null;
  readonly occurred_at: Date;
}

interface SubmissionRow {
  readonly id: string;
  readonly claim_id: string;
  readonly order_id: string;
  readonly supplier_id: string;
  readonly supplier_order_reference: string;
  readonly status: SupplierClaimSubmissionOperation["status"];
  readonly idempotency_reference: string;
  readonly payload_fingerprint: string;
  readonly supplier_claim_reference: string | null;
  readonly response_type: string | null;
  readonly record_version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly dispatched_at: Date | null;
  readonly confirmed_at: Date | null;
}

export class PostgresSupplierClaimRepository implements SupplierClaimRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async findOrder(
    requestedOrderId: SupplierClaim["orderId"],
  ): Promise<SupplierClaimOrderReference | null> {
    const result = await this.db.query<{ readonly id: string }>(
      "SELECT id::text FROM keycore_orders WHERE id = $1",
      [requestedOrderId],
    );
    return result.rows[0] ? { orderId: orderId(result.rows[0].id) } : null;
  }

  public async findSupportCase(
    id: string,
  ): Promise<SupplierClaimSupportReference | null> {
    const result = await this.db.query<{
      readonly id: string;
      readonly order_id: string | null;
      readonly category: string;
      readonly status: string;
    }>(
      "SELECT id::text, order_id::text, category, status FROM support_cases WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row
      ? {
          category: row.category,
          id: row.id,
          orderId: row.order_id ? orderId(row.order_id) : null,
          status: row.status,
        }
      : null;
  }

  public async findProcurementOperation(
    id: string,
  ): Promise<SupplierClaimProcurementReference | null> {
    const result = await this.db.query<{
      readonly id: string;
      readonly order_id: string;
      readonly supplier_id: string;
      readonly external_supplier_order_id: string | null;
      readonly status: string;
      readonly dispatch_state: string;
    }>(
      "SELECT id::text, order_id::text, supplier_id, external_supplier_order_id, status, dispatch_state FROM procurement_operations WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row
      ? {
          dispatchState: row.dispatch_state,
          externalSupplierOrderId: row.external_supplier_order_id,
          id: row.id,
          orderId: orderId(row.order_id),
          status: row.status,
          supplierId: row.supplier_id,
        }
      : null;
  }

  public async findFulfillment(
    id: string,
  ): Promise<SupplierClaimFulfillmentReference | null> {
    const result = await this.db.query<{
      readonly id: string;
      readonly order_id: string | null;
      readonly procurement_operation_id: string | null;
      readonly status: string;
      readonly retrieval_state: string;
      readonly delivery_state: string;
    }>(
      "SELECT id::text, order_id::text, procurement_operation_id::text, status, retrieval_state, delivery_state FROM fulfillment_operations WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row
      ? {
          deliveryState: row.delivery_state,
          id: row.id,
          orderId: row.order_id ? orderId(row.order_id) : null,
          procurementOperationId: row.procurement_operation_id,
          retrievalState: row.retrieval_state,
          status: row.status,
        }
      : null;
  }

  public async findEvidence(
    id: string,
  ): Promise<SupplierClaimEvidenceReference | null> {
    const result = await this.db.query<{
      readonly id: string;
      readonly order_id: string;
      readonly state: string;
    }>(
      "SELECT id::text, order_id::text, state FROM dispute_evidence_snapshots WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row
      ? { id: row.id, orderId: orderId(row.order_id), state: row.state }
      : null;
  }

  public async createClaim(input: {
    readonly claim: SupplierClaim;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | { readonly status: "CREATED"; readonly detail: SupplierClaimDetail }
    | { readonly status: "EXISTING"; readonly detail: SupplierClaimDetail }
    | { readonly status: "CONFLICT" }
  > {
    try {
      return await this.db.transaction(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 9005))",
          [input.claim.idempotencyKey],
        );
        const existing = await findClaimByIdempotency(
          client,
          input.claim.idempotencyKey,
        );
        if (existing) {
          if (
            existing.idempotencyFingerprint !==
            input.claim.idempotencyFingerprint
          )
            return { status: "CONFLICT" as const };
          return {
            detail: await requireDetail(client, existing.id),
            status: "EXISTING" as const,
          };
        }
        await client.query(
          `INSERT INTO supplier_claims(
            id, order_id, support_case_id, procurement_operation_id, fulfillment_id,
            supplier_id, supplier_order_reference, category, source, status,
            priority, outcome, idempotency_key, idempotency_fingerprint,
            record_version, correlation_id, created_at, updated_at, resolved_at, closed_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
          )`,
          claimValues(input.claim),
        );
        await insertEvent(client, input.event);
        return {
          detail: await requireDetail(client, input.claim.id),
          status: "CREATED" as const,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { status: "CONFLICT" };
      throw error;
    }
  }

  public async findClaim(id: string): Promise<SupplierClaimDetail | null> {
    return loadDetail(this.db, id);
  }

  public async transitionClaim(input: {
    readonly claimId: string;
    readonly expectedVersion: number;
    readonly nextStatus: SupplierClaimStatus;
    readonly outcome: SupplierClaim["outcome"];
    readonly now: Date;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | { readonly status: "UPDATED"; readonly detail: SupplierClaimDetail }
    | { readonly status: "NOT_FOUND" | "STALE_VERSION" }
  > {
    return this.db.transaction(async (client) => {
      const current = await findClaimForUpdate(client, input.claimId);
      if (!current) return { status: "NOT_FOUND" };
      if (
        current.recordVersion !== input.expectedVersion ||
        input.event.fromStatus !== current.status
      )
        return { status: "STALE_VERSION" };
      const result = await client.query<ClaimRow>(
        `UPDATE supplier_claims SET
          status = $3,
          outcome = $4,
          resolved_at = CASE WHEN $3 = 'RESOLVED' THEN $5 ELSE resolved_at END,
          closed_at = CASE WHEN $3 = 'CLOSED' THEN $5 ELSE NULL END,
          record_version = record_version + 1,
          updated_at = $5
        WHERE id = $1 AND record_version = $2
        RETURNING *`,
        [
          input.claimId,
          input.expectedVersion,
          input.nextStatus,
          input.outcome,
          input.now,
        ],
      );
      if (!result.rows[0]) return { status: "STALE_VERSION" };
      await insertEvent(client, input.event);
      return {
        detail: await requireDetail(client, input.claimId),
        status: "UPDATED",
      };
    });
  }

  public async linkEvidence(input: {
    readonly claimId: string;
    readonly link: SupplierClaimEvidenceLink;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | {
        readonly status: "LINKED" | "EXISTING";
        readonly detail: SupplierClaimDetail;
      }
    | { readonly status: "NOT_FOUND" }
  > {
    return this.db.transaction(async (client) => {
      const claim = await findClaimForUpdate(client, input.claimId);
      if (!claim) return { status: "NOT_FOUND" };
      const inserted = await client.query(
        `INSERT INTO supplier_claim_evidence_links(id, claim_id, evidence_snapshot_id, order_id, created_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (claim_id, evidence_snapshot_id) DO NOTHING
         RETURNING id`,
        [
          input.link.id,
          input.link.claimId,
          input.link.evidenceSnapshotId,
          input.link.orderId,
          input.link.createdAt,
        ],
      );
      if (inserted.rowCount === 0)
        return {
          detail: await requireDetail(client, input.claimId),
          status: "EXISTING",
        };
      await insertEvent(client, input.event);
      return {
        detail: await requireDetail(client, input.claimId),
        status: "LINKED",
      };
    });
  }

  public async prepareSubmission(input: {
    readonly operation: SupplierClaimSubmissionOperation;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | {
        readonly status: "PREPARED" | "EXISTING";
        readonly detail: SupplierClaimDetail;
      }
    | { readonly status: "NOT_FOUND" | "NOT_READY" }
  > {
    return this.db.transaction(async (client) => {
      const claim = await findClaimForUpdate(client, input.operation.claimId);
      if (!claim) return { status: "NOT_FOUND" };
      const existing = await findSubmission(client, input.operation.claimId);
      if (existing)
        return {
          detail: await requireDetail(client, input.operation.claimId),
          status: "EXISTING",
        };
      if (claim.status !== "READY_FOR_SUBMISSION")
        return { status: "NOT_READY" };
      await client.query(
        `INSERT INTO supplier_claim_submission_operations(
          id, claim_id, order_id, supplier_id, supplier_order_reference, status,
          idempotency_reference, payload_fingerprint, supplier_claim_reference,
          response_type, record_version, created_at, updated_at, dispatched_at, confirmed_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        submissionValues(input.operation),
      );
      await insertEvent(client, input.event);
      return {
        detail: await requireDetail(client, input.operation.claimId),
        status: "PREPARED",
      };
    });
  }

  public async acquireSubmission(input: {
    readonly claimId: string;
    readonly operationId: string;
    readonly expectedVersion: number;
    readonly now: Date;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | { readonly status: "ACQUIRED"; readonly detail: SupplierClaimDetail }
    | { readonly status: "NOT_FOUND" | "NOT_PREPARED" | "STALE_VERSION" }
  > {
    return this.db.transaction(async (client) => {
      const current = await findSubmissionForUpdate(client, input.claimId);
      if (!current || current.id !== input.operationId)
        return { status: "NOT_FOUND" };
      if (current.recordVersion !== input.expectedVersion)
        return { status: "STALE_VERSION" };
      if (current.status !== "PREPARED") return { status: "NOT_PREPARED" };
      await client.query(
        `UPDATE supplier_claim_submission_operations SET status = 'DISPATCHING', dispatched_at = $3,
          updated_at = $3, record_version = record_version + 1
         WHERE id = $1 AND record_version = $2`,
        [input.operationId, input.expectedVersion, input.now],
      );
      await insertEvent(client, input.event);
      return {
        detail: await requireDetail(client, input.claimId),
        status: "ACQUIRED",
      };
    });
  }

  public async completeSubmission(input: {
    readonly claimId: string;
    readonly operationId: string;
    readonly expectedVersion: number;
    readonly status: "CONFIRMED" | "AMBIGUOUS" | "FAILED";
    readonly supplierClaimReference: string | null;
    readonly responseType: string | null;
    readonly now: Date;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | { readonly status: "UPDATED"; readonly detail: SupplierClaimDetail }
    | { readonly status: "NOT_FOUND" | "STALE_VERSION" }
  > {
    return this.db.transaction(async (client) => {
      const current = await findSubmissionForUpdate(client, input.claimId);
      if (!current || current.id !== input.operationId)
        return { status: "NOT_FOUND" };
      if (
        current.recordVersion !== input.expectedVersion ||
        current.status !== "DISPATCHING"
      )
        return { status: "STALE_VERSION" };
      await client.query(
        `UPDATE supplier_claim_submission_operations SET status = $3,
          supplier_claim_reference = $4, response_type = $5,
          confirmed_at = CASE WHEN $3 = 'CONFIRMED' THEN $6 ELSE NULL END,
          updated_at = $6, record_version = record_version + 1
         WHERE id = $1 AND record_version = $2`,
        [
          input.operationId,
          input.expectedVersion,
          input.status,
          input.supplierClaimReference,
          input.responseType,
          input.now,
        ],
      );
      await insertEvent(client, input.event);
      return {
        detail: await requireDetail(client, input.claimId),
        status: "UPDATED",
      };
    });
  }
}

const claimValues = (claim: SupplierClaim): readonly unknown[] => [
  claim.id,
  claim.orderId,
  claim.supportCaseId,
  claim.procurementOperationId,
  claim.fulfillmentId,
  claim.supplierId,
  claim.supplierOrderReference,
  claim.category,
  claim.source,
  claim.status,
  claim.priority,
  claim.outcome,
  claim.idempotencyKey,
  claim.idempotencyFingerprint,
  claim.recordVersion,
  claim.correlationId,
  claim.createdAt,
  claim.updatedAt,
  claim.resolvedAt,
  claim.closedAt,
];
const submissionValues = (
  value: SupplierClaimSubmissionOperation,
): readonly unknown[] => [
  value.id,
  value.claimId,
  value.orderId,
  value.supplierId,
  value.supplierOrderReference,
  value.status,
  value.idempotencyReference,
  value.payloadFingerprint,
  value.supplierClaimReference,
  value.responseType,
  value.recordVersion,
  value.createdAt,
  value.updatedAt,
  value.dispatchedAt,
  value.confirmedAt,
];

const insertEvent = async (
  db: Queryable,
  event: SupplierClaimEvent,
): Promise<void> => {
  await db.query(
    `INSERT INTO supplier_claim_events(id, claim_id, event_type, actor_type, actor_reference, from_status, to_status, evidence_snapshot_id, submission_operation_id, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      event.id,
      event.claimId,
      event.eventType,
      event.actorType,
      event.actorReference,
      event.fromStatus,
      event.toStatus,
      event.evidenceSnapshotId,
      event.submissionOperationId,
      event.occurredAt,
    ],
  );
};

const findClaimByIdempotency = async (
  db: Queryable,
  key: string,
): Promise<SupplierClaim | null> => {
  const result = await db.query<ClaimRow>(
    "SELECT * FROM supplier_claims WHERE idempotency_key = $1",
    [key],
  );
  return result.rows[0] ? claimFromRow(result.rows[0]) : null;
};
const findClaimForUpdate = async (
  db: Queryable,
  id: string,
): Promise<SupplierClaim | null> => {
  const result = await db.query<ClaimRow>(
    "SELECT * FROM supplier_claims WHERE id = $1 FOR UPDATE",
    [id],
  );
  return result.rows[0] ? claimFromRow(result.rows[0]) : null;
};
const findSubmissionForUpdate = async (
  db: Queryable,
  claimId: string,
): Promise<SupplierClaimSubmissionOperation | null> => {
  const result = await db.query<SubmissionRow>(
    "SELECT * FROM supplier_claim_submission_operations WHERE claim_id = $1 FOR UPDATE",
    [claimId],
  );
  return result.rows[0] ? submissionFromRow(result.rows[0]) : null;
};
const findSubmission = async (
  db: Queryable,
  claimId: string,
): Promise<SupplierClaimSubmissionOperation | null> => {
  const result = await db.query<SubmissionRow>(
    "SELECT * FROM supplier_claim_submission_operations WHERE claim_id = $1",
    [claimId],
  );
  return result.rows[0] ? submissionFromRow(result.rows[0]) : null;
};

const loadDetail = async (
  db: Queryable,
  id: string,
): Promise<SupplierClaimDetail | null> => {
  const [claimResult, linksResult, eventsResult, submissionResult] =
    await Promise.all([
      db.query<ClaimRow>("SELECT * FROM supplier_claims WHERE id = $1", [id]),
      db.query<EvidenceLinkRow>(
        "SELECT * FROM supplier_claim_evidence_links WHERE claim_id = $1 ORDER BY created_at, id",
        [id],
      ),
      db.query<ClaimEventRow>(
        "SELECT * FROM supplier_claim_events WHERE claim_id = $1 ORDER BY occurred_at, id",
        [id],
      ),
      db.query<SubmissionRow>(
        "SELECT * FROM supplier_claim_submission_operations WHERE claim_id = $1",
        [id],
      ),
    ]);
  const row = claimResult.rows[0];
  if (!row) return null;
  return {
    claim: claimFromRow(row),
    evidenceLinks: linksResult.rows.map(linkFromRow),
    events: eventsResult.rows.map(eventFromRow),
    submission: submissionResult.rows[0]
      ? submissionFromRow(submissionResult.rows[0])
      : null,
  };
};
const requireDetail = async (
  db: Queryable,
  id: string,
): Promise<SupplierClaimDetail> => {
  const detail = await loadDetail(db, id);
  if (!detail) throw new Error("Supplier claim persistence lost its aggregate");
  return detail;
};

const claimFromRow = (row: ClaimRow): SupplierClaim => ({
  category: row.category,
  closedAt: row.closed_at,
  correlationId: row.correlation_id as SupplierClaim["correlationId"],
  createdAt: row.created_at,
  fulfillmentId: row.fulfillment_id,
  id: row.id,
  idempotencyFingerprint: row.idempotency_fingerprint,
  idempotencyKey: row.idempotency_key,
  orderId: orderId(row.order_id),
  outcome: row.outcome,
  priority: row.priority,
  procurementOperationId: row.procurement_operation_id,
  recordVersion: row.record_version,
  resolvedAt: row.resolved_at,
  source: row.source,
  status: row.status,
  supplierId: row.supplier_id,
  supplierOrderReference: row.supplier_order_reference,
  supportCaseId: row.support_case_id,
  updatedAt: row.updated_at,
});
const linkFromRow = (row: EvidenceLinkRow): SupplierClaimEvidenceLink => ({
  claimId: row.claim_id,
  createdAt: row.created_at,
  evidenceSnapshotId: row.evidence_snapshot_id,
  id: row.id,
  orderId: orderId(row.order_id),
});
const eventFromRow = (row: ClaimEventRow): SupplierClaimEvent => ({
  actorReference: row.actor_reference,
  actorType: row.actor_type,
  claimId: row.claim_id,
  eventType: row.event_type,
  evidenceSnapshotId: row.evidence_snapshot_id,
  fromStatus: row.from_status,
  id: row.id,
  occurredAt: row.occurred_at,
  submissionOperationId: row.submission_operation_id,
  toStatus: row.to_status,
});
const submissionFromRow = (
  row: SubmissionRow,
): SupplierClaimSubmissionOperation => ({
  claimId: row.claim_id,
  confirmedAt: row.confirmed_at,
  createdAt: row.created_at,
  dispatchedAt: row.dispatched_at,
  id: row.id,
  idempotencyReference: row.idempotency_reference,
  orderId: orderId(row.order_id),
  payloadFingerprint: row.payload_fingerprint,
  recordVersion: row.record_version,
  responseType: row.response_type,
  status: row.status,
  supplierClaimReference: row.supplier_claim_reference,
  supplierId: row.supplier_id,
  supplierOrderReference: row.supplier_order_reference,
  updatedAt: row.updated_at,
});

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { readonly code?: string }).code === "23505";
