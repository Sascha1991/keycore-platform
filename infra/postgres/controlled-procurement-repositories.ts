import {
  currency,
  money,
  supplierOfferId,
  supplierProductId,
} from "../../packages/platform/src/contracts.js";
import type {
  ControlledClaimResult,
  ControlledProcurementApproval,
  ControlledProcurementApprovalRepository,
  ControlledProcurementStatus,
} from "../suppliers/kinguin/kinguin-controlled-live-procurement.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface ControlledApprovalRow {
  readonly id: string;
  readonly mode: "CONTROLLED_VERIFICATION";
  readonly supplier_id: "kinguin";
  readonly supplier_product_id: string;
  readonly supplier_offer_id: string;
  readonly product_title: string | null;
  readonly quantity: 1;
  readonly maximum_acquisition_amount_minor: string;
  readonly current_acquisition_amount_minor: string;
  readonly currency: string;
  readonly purchase_request_fingerprint: string;
  readonly order_external_id: string;
  readonly token_hash: string;
  readonly status: ControlledProcurementStatus;
  readonly dispatch_state: ControlledProcurementApproval["dispatchState"];
  readonly external_supplier_order_id: string | null;
  readonly supplier_status: string | null;
  readonly response_fingerprint: string | null;
  readonly failure_reason_code: string | null;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly claimed_at: Date | null;
  readonly dispatch_started_at: Date | null;
  readonly completed_at: Date | null;
  readonly record_version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresControlledProcurementApprovalRepository implements ControlledProcurementApprovalRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async create(
    input: ControlledProcurementApproval,
  ): Promise<ControlledProcurementApproval> {
    try {
      const result = await this.db.query<ControlledApprovalRow>(
        `
          INSERT INTO controlled_procurement_approvals(
            id, mode, supplier_id, supplier_product_id, supplier_offer_id,
            product_title, quantity, maximum_acquisition_amount_minor,
            current_acquisition_amount_minor, currency,
            purchase_request_fingerprint, order_external_id, token_hash,
            status, dispatch_state, external_supplier_order_id,
            supplier_status, response_fingerprint, failure_reason_code,
            expires_at, consumed_at, claimed_at, dispatch_started_at,
            completed_at, record_version, created_at, updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22, $23, $24, $25, $26, $27
          )
          RETURNING ${returning}
        `,
        values(input),
      );
      return fromRow(requireRow(result.rows[0]));
    } catch {
      throw new Error("CONTROLLED_APPROVAL_CONFLICT");
    }
  }

  public async findById(
    approvalId: string,
  ): Promise<ControlledProcurementApproval | null> {
    return findById(this.db, approvalId);
  }

  public async cancel(input: {
    readonly approvalId: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null> {
    return this.transition(
      input.approvalId,
      input.now,
      { status: "CANCELLED" },
      "status IN ('PENDING_APPROVAL', 'APPROVED') AND dispatch_state = 'NOT_DISPATCHED'",
    );
  }

  public async claim(input: {
    readonly approvalId: string;
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<ControlledClaimResult> {
    const result = await this.db.query<ControlledApprovalRow>(
      `
        UPDATE controlled_procurement_approvals
        SET status = 'CONSUMED',
          dispatch_state = 'CLAIMED',
          consumed_at = $3,
          claimed_at = $3,
          record_version = record_version + 1,
          updated_at = $3
        WHERE id = $1
          AND token_hash = $2
          AND status = 'APPROVED'
          AND dispatch_state = 'NOT_DISPATCHED'
          AND expires_at > $3
        RETURNING ${returning}
      `,
      [input.approvalId, input.tokenHash, input.now],
    );
    if (result.rows[0]) {
      return { approval: fromRow(result.rows[0]), status: "CLAIMED" };
    }
    const current = await findById(this.db, input.approvalId);
    if (!current) {
      return { status: "APPROVAL_NOT_FOUND" };
    }
    if (current.expiresAt.getTime() <= input.now.getTime()) {
      const expired = await this.patch(input.approvalId, input.now, {
        status: "EXPIRED",
      });
      return { approval: expired ?? current, status: "APPROVAL_EXPIRED" };
    }
    if (current.status === "CANCELLED") {
      return { approval: current, status: "APPROVAL_CANCELLED" };
    }
    if (current.tokenHash !== input.tokenHash) {
      return { approval: current, status: "TOKEN_INVALID" };
    }
    return { approval: current, status: "APPROVAL_ALREADY_CONSUMED" };
  }

  public async markDispatchStarted(input: {
    readonly approvalId: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null> {
    return this.transition(
      input.approvalId,
      input.now,
      {
        dispatchStartedAt: input.now,
        dispatchState: "DISPATCH_STARTED",
        status: "CONSUMED",
      },
      "status = 'CONSUMED' AND dispatch_state = 'CLAIMED'",
    );
  }

  public async markConfirmed(input: {
    readonly approvalId: string;
    readonly externalSupplierOrderId: string;
    readonly source?: "RECONCILIATION";
    readonly supplierStatus: string;
    readonly responseFingerprint: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null> {
    return this.transition(
      input.approvalId,
      input.now,
      {
        completedAt: input.now,
        dispatchState: "DISPATCH_CONFIRMED",
        externalSupplierOrderId: input.externalSupplierOrderId,
        responseFingerprint: input.responseFingerprint,
        status: "PROCUREMENT_CONFIRMED",
        supplierStatus: input.supplierStatus,
      },
      input.source === "RECONCILIATION"
        ? "status = 'AMBIGUOUS' AND dispatch_state = 'DISPATCH_AMBIGUOUS'"
        : "status = 'CONSUMED' AND dispatch_state = 'DISPATCH_STARTED'",
    );
  }

  public async markRejected(input: {
    readonly approvalId: string;
    readonly reasonCode: string;
    readonly responseFingerprint?: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null> {
    return this.transition(
      input.approvalId,
      input.now,
      {
        completedAt: input.now,
        dispatchState: "DISPATCH_REJECTED",
        failureReasonCode: input.reasonCode,
        responseFingerprint: input.responseFingerprint ?? null,
        status: "PROCUREMENT_REJECTED",
      },
      "status = 'CONSUMED' AND dispatch_state = 'DISPATCH_STARTED'",
    );
  }

  public async markAmbiguous(input: {
    readonly approvalId: string;
    readonly reasonCode: string;
    readonly externalSupplierOrderId?: string;
    readonly responseFingerprint?: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null> {
    return this.transition(
      input.approvalId,
      input.now,
      {
        dispatchState: "DISPATCH_AMBIGUOUS",
        externalSupplierOrderId: input.externalSupplierOrderId ?? null,
        failureReasonCode: input.reasonCode,
        responseFingerprint: input.responseFingerprint ?? null,
        status: "AMBIGUOUS",
      },
      "status = 'CONSUMED' AND dispatch_state = 'DISPATCH_STARTED'",
    );
  }

  public async markManualReview(input: {
    readonly approvalId: string;
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null> {
    return this.transition(
      input.approvalId,
      input.now,
      {
        failureReasonCode: input.reasonCode,
        status: "MANUAL_REVIEW_REQUIRED",
      },
      "status NOT IN ('PROCUREMENT_CONFIRMED', 'PROCUREMENT_REJECTED', 'AMBIGUOUS')",
    );
  }

  private async transition(
    approvalId: string,
    now: Date,
    patch: Partial<ControlledProcurementApproval>,
    predicateSql: string,
  ): Promise<ControlledProcurementApproval | null> {
    const current = await findById(this.db, approvalId);
    if (!current) {
      return null;
    }
    const next = {
      ...current,
      ...patch,
      recordVersion: current.recordVersion + 1,
      updatedAt: now,
    };
    const result = await this.db.query<ControlledApprovalRow>(
      `
        UPDATE controlled_procurement_approvals
        SET status = $2,
          dispatch_state = $3,
          external_supplier_order_id = $4,
          supplier_status = $5,
          response_fingerprint = $6,
          failure_reason_code = $7,
          consumed_at = $8,
          claimed_at = $9,
          dispatch_started_at = $10,
          completed_at = $11,
          record_version = record_version + 1,
          updated_at = $12
        WHERE id = $1
          AND record_version = $13
          AND ${predicateSql}
        RETURNING ${returning}
      `,
      [
        approvalId,
        next.status,
        next.dispatchState,
        next.externalSupplierOrderId ?? null,
        next.supplierStatus ?? null,
        next.responseFingerprint ?? null,
        next.failureReasonCode ?? null,
        next.consumedAt ?? null,
        next.claimedAt ?? null,
        next.dispatchStartedAt ?? null,
        next.completedAt ?? null,
        now,
        current.recordVersion,
      ],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  private async patch(
    approvalId: string,
    now: Date,
    patch: Partial<ControlledProcurementApproval>,
  ): Promise<ControlledProcurementApproval | null> {
    return this.transition(
      approvalId,
      now,
      patch,
      "record_version = record_version",
    );
  }
}

const returning = `
  id::text, mode, supplier_id, supplier_product_id, supplier_offer_id,
  product_title, quantity, maximum_acquisition_amount_minor::text,
  current_acquisition_amount_minor::text, currency,
  purchase_request_fingerprint, order_external_id, token_hash, status,
  dispatch_state, external_supplier_order_id, supplier_status,
  response_fingerprint, failure_reason_code, expires_at, consumed_at,
  claimed_at, dispatch_started_at, completed_at, record_version,
  created_at, updated_at
`;

const findById = async (
  db: Queryable,
  approvalId: string,
): Promise<ControlledProcurementApproval | null> => {
  const result = await db.query<ControlledApprovalRow>(
    `
      SELECT ${returning}
      FROM controlled_procurement_approvals
      WHERE id = $1
    `,
    [approvalId],
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
};

const values = (
  approval: ControlledProcurementApproval,
): readonly unknown[] => [
  approval.approvalId,
  approval.mode,
  approval.supplierId,
  approval.supplierProductId,
  approval.supplierOfferId,
  approval.productTitle ?? null,
  approval.quantity,
  approval.maximumAcquisitionAmount.amountMinor.toString(),
  approval.currentAcquisitionAmount.amountMinor.toString(),
  approval.maximumAcquisitionAmount.currency,
  approval.purchaseRequestFingerprint,
  approval.orderExternalId,
  approval.tokenHash,
  approval.status,
  approval.dispatchState,
  approval.externalSupplierOrderId ?? null,
  approval.supplierStatus ?? null,
  approval.responseFingerprint ?? null,
  approval.failureReasonCode ?? null,
  approval.expiresAt,
  approval.consumedAt ?? null,
  approval.claimedAt ?? null,
  approval.dispatchStartedAt ?? null,
  approval.completedAt ?? null,
  approval.recordVersion,
  approval.createdAt,
  approval.updatedAt,
];

const fromRow = (
  row: ControlledApprovalRow,
): ControlledProcurementApproval => ({
  approvalId: row.id,
  claimedAt: row.claimed_at,
  completedAt: row.completed_at,
  consumedAt: row.consumed_at,
  createdAt: row.created_at,
  currentAcquisitionAmount: money(
    BigInt(row.current_acquisition_amount_minor),
    currency(row.currency),
  ),
  dispatchStartedAt: row.dispatch_started_at,
  dispatchState: row.dispatch_state,
  expiresAt: row.expires_at,
  externalSupplierOrderId: row.external_supplier_order_id,
  failureReasonCode: row.failure_reason_code,
  maximumAcquisitionAmount: money(
    BigInt(row.maximum_acquisition_amount_minor),
    currency(row.currency),
  ),
  mode: row.mode,
  orderExternalId: row.order_external_id,
  purchaseRequestFingerprint: row.purchase_request_fingerprint,
  quantity: row.quantity,
  recordVersion: row.record_version,
  responseFingerprint: row.response_fingerprint,
  status: row.status,
  supplierId: row.supplier_id,
  supplierOfferId: supplierOfferId(row.supplier_offer_id),
  supplierProductId: supplierProductId(row.supplier_product_id),
  supplierStatus: row.supplier_status,
  tokenHash: row.token_hash,
  updatedAt: row.updated_at,
  ...(row.product_title ? { productTitle: row.product_title } : {}),
});

const requireRow = (
  row: ControlledApprovalRow | undefined,
): ControlledApprovalRow => {
  if (!row) {
    throw new Error("Expected controlled procurement approval row");
  }
  return row;
};
