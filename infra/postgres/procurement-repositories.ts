import {
  currency,
  idempotencyKey,
  money,
  orderId,
  supplierId,
  supplierOfferId,
  supplierProductId,
  type CorrelationId,
  type OrderId,
} from "../../packages/platform/src/contracts.js";
import type {
  ProcurementCreateResult,
  ProcurementLeaseResult,
  ProcurementOperation,
  ProcurementOperationRepository,
  ProcurementOperationStatus,
} from "../../packages/platform/src/procurement/supplier-procurement.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface ProcurementRow {
  readonly id: string;
  readonly order_id: string;
  readonly supplier_id: string;
  readonly supplier_product_id: string;
  readonly supplier_offer_id: string;
  readonly quantity: number;
  readonly status: ProcurementOperation["status"];
  readonly dispatch_state: ProcurementOperation["dispatchState"];
  readonly acquisition_amount_minor: string | null;
  readonly acquisition_currency: string | null;
  readonly external_supplier_order_id: string | null;
  readonly normalized_supplier_status: string | null;
  readonly response_fingerprint: string | null;
  readonly execution_token: string | null;
  readonly execution_started_at: Date | null;
  readonly attempt_generation: number;
  readonly record_version: number;
  readonly correlation_id: string;
  readonly last_reconciled_at: Date | null;
  readonly reconciliation_reason_code: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresProcurementOperationRepository implements ProcurementOperationRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async findById(
    operationId: string,
  ): Promise<ProcurementOperation | null> {
    return findById(this.db, operationId);
  }

  public async listByOrder(
    requestedOrderId: OrderId,
  ): Promise<readonly ProcurementOperation[]> {
    const result = await this.db.query<ProcurementRow>(
      `
        SELECT ${procurementReturning}
        FROM procurement_operations
        WHERE order_id = $1
        ORDER BY attempt_generation, created_at, id
      `,
      [requestedOrderId],
    );
    return result.rows.map(procurementFromRow);
  }

  public async createNextAttempt(input: {
    readonly operation: ProcurementOperation;
    readonly now: Date;
  }): Promise<ProcurementCreateResult> {
    return this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 7003))",
        [input.operation.orderId],
      );
      const existing = await listByOrder(client, input.operation.orderId);
      const blocking = existing.find((operation) =>
        [
          "PENDING",
          "READY",
          "IN_FLIGHT",
          "AMBIGUOUS",
          "RECONCILIATION_REQUIRED",
        ].includes(operation.status),
      );
      if (blocking) {
        return { operation: blocking, status: "EXISTING" };
      }
      const succeeded = existing.find(
        (operation) => operation.status === "SUCCEEDED",
      );
      if (succeeded) {
        return { operation: succeeded, status: "BLOCKED" };
      }
      const nextGeneration =
        Math.max(
          0,
          ...existing.map((operation) => operation.attemptGeneration),
        ) + 1;
      const operation = {
        ...input.operation,
        attemptGeneration: nextGeneration,
        clientIdempotencyReference: idempotencyKey(
          `keycore:procurement:${input.operation.orderId}:${input.operation.supplierId}:g${nextGeneration}`,
        ),
      };
      const inserted = await client.query<ProcurementRow>(
        `
          INSERT INTO procurement_operations(
            id, order_id, supplier_id, supplier_product_id, supplier_offer_id,
            quantity, status, dispatch_state, acquisition_amount_minor,
            acquisition_currency, external_supplier_order_id,
            normalized_supplier_status, response_fingerprint, execution_token,
            execution_started_at, attempt_generation, record_version,
            correlation_id, last_reconciled_at, reconciliation_reason_code,
            created_at, updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22
          )
          RETURNING ${procurementReturning}
        `,
        procurementValues(operation),
      );
      const row = inserted.rows[0];
      if (!row) {
        throw new Error("Expected procurement insert to return a row");
      }
      return { operation: procurementFromRow(row), status: "CREATED" };
    });
  }

  public async acquireExecutionLease(input: {
    readonly operationId: string;
    readonly executionToken: string;
    readonly staleStartedBefore: Date;
    readonly now: Date;
  }): Promise<ProcurementLeaseResult> {
    const updated = await this.db.query<ProcurementRow>(
      `
        UPDATE procurement_operations
        SET status = 'IN_FLIGHT',
          execution_token = $2,
          execution_started_at = $3,
          record_version = record_version + 1,
          updated_at = $3
        WHERE id = $1
          AND (
            (
              execution_token IS NULL
              AND dispatch_state = 'NOT_DISPATCHED'
              AND status IN ('READY', 'PENDING', 'FAILED_RETRYABLE')
            )
            OR (
              execution_token IS NOT NULL
              AND execution_started_at <= $4
              AND dispatch_state = 'NOT_DISPATCHED'
              AND status = 'IN_FLIGHT'
            )
          )
        RETURNING ${procurementReturning}
      `,
      [
        input.operationId,
        input.executionToken,
        input.now,
        input.staleStartedBefore,
      ],
    );
    const updatedRow = updated.rows[0];
    if (updatedRow) {
      return {
        operation: procurementFromRow(updatedRow),
        status: "ACQUIRED",
      };
    }

    const current = await findById(this.db, input.operationId);
    if (!current) {
      return { status: "NOT_ELIGIBLE" };
    }
    if (
      current.status === "IN_FLIGHT" &&
      current.dispatchState === "DISPATCH_STARTED"
    ) {
      if (
        current.executionStartedAt &&
        current.executionStartedAt.getTime() >
          input.staleStartedBefore.getTime()
      ) {
        return { operation: current, status: "IN_FLIGHT" };
      }
      return { operation: current, status: "STALE_DISPATCH_STARTED" };
    }
    if (current.executionToken && current.status === "IN_FLIGHT") {
      return { operation: current, status: "IN_FLIGHT" };
    }
    return { operation: current, status: "NOT_ELIGIBLE" };
  }

  public async markDispatchStarted(input: {
    readonly operationId: string;
    readonly executionToken: string;
    readonly now: Date;
  }): Promise<ProcurementOperation | null> {
    return this.updateOwned(input, {
      dispatchState: "DISPATCH_STARTED",
      status: "IN_FLIGHT",
    });
  }

  public async markSucceeded(input: {
    readonly operationId: string;
    readonly executionToken: string;
    readonly externalSupplierOrderId: string;
    readonly normalizedSupplierStatus: string;
    readonly responseFingerprint: string;
    readonly acquisitionAmount: NonNullable<
      ProcurementOperation["acquisitionAmount"]
    >;
    readonly now: Date;
  }): Promise<ProcurementOperation | null> {
    return this.updateOwned(input, {
      acquisitionAmount: input.acquisitionAmount,
      dispatchState: "DISPATCH_CONFIRMED",
      executionStartedAt: null,
      executionToken: null,
      externalSupplierOrderId: input.externalSupplierOrderId,
      normalizedSupplierStatus: input.normalizedSupplierStatus,
      responseFingerprint: input.responseFingerprint,
      status: "SUCCEEDED",
    });
  }

  public async markFailed(input: {
    readonly operationId: string;
    readonly executionToken: string;
    readonly status: "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "AMBIGUOUS";
    readonly reasonCode: string;
    readonly externalSupplierOrderId?: string | null;
    readonly responseFingerprint?: string | null;
    readonly now: Date;
  }): Promise<ProcurementOperation | null> {
    return this.updateOwned(input, {
      executionStartedAt: null,
      executionToken: null,
      externalSupplierOrderId: input.externalSupplierOrderId ?? null,
      reconciliationReasonCode: input.reasonCode,
      responseFingerprint: input.responseFingerprint ?? null,
      status: input.status,
    });
  }

  public async markReconciliation(input: {
    readonly operationId: string;
    readonly status:
      "SUCCEEDED" | "FAILED_TERMINAL" | "AMBIGUOUS" | "RECONCILIATION_REQUIRED";
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<ProcurementOperation | null> {
    const result = await this.db.query<ProcurementRow>(
      `
        UPDATE procurement_operations
        SET status = $2,
          execution_token = NULL,
          execution_started_at = NULL,
          last_reconciled_at = $3,
          reconciliation_reason_code = $4,
          record_version = record_version + 1,
          updated_at = $3
        WHERE id = $1
        RETURNING ${procurementReturning}
      `,
      [input.operationId, input.status, input.now, input.reasonCode],
    );
    return result.rows[0] ? procurementFromRow(result.rows[0]) : null;
  }

  private async updateOwned(
    input: {
      readonly operationId: string;
      readonly executionToken: string;
      readonly now: Date;
    },
    patch: Partial<ProcurementOperation>,
  ): Promise<ProcurementOperation | null> {
    const current = await this.findById(input.operationId);
    if (!current || current.executionToken !== input.executionToken) {
      return null;
    }
    const next: ProcurementOperation = {
      ...current,
      ...patch,
      recordVersion: current.recordVersion + 1,
      updatedAt: input.now,
    };
    const result = await this.db.query<ProcurementRow>(
      `
        UPDATE procurement_operations
        SET status = $3,
          dispatch_state = $4,
          acquisition_amount_minor = $5,
          acquisition_currency = $6,
          external_supplier_order_id = $7,
          normalized_supplier_status = $8,
          response_fingerprint = $9,
          execution_token = $10,
          execution_started_at = $11,
          reconciliation_reason_code = COALESCE($12, reconciliation_reason_code),
          record_version = record_version + 1,
          updated_at = $13
        WHERE id = $1 AND execution_token = $2 AND status = 'IN_FLIGHT'
        RETURNING ${procurementReturning}
      `,
      [
        input.operationId,
        input.executionToken,
        next.status,
        next.dispatchState,
        next.acquisitionAmount?.amountMinor.toString() ?? null,
        next.acquisitionAmount?.currency ?? null,
        next.externalSupplierOrderId ?? null,
        next.normalizedSupplierStatus ?? null,
        next.responseFingerprint ?? null,
        next.executionToken ?? null,
        next.executionStartedAt ?? null,
        next.reconciliationReasonCode ?? null,
        input.now,
      ],
    );
    return result.rows[0] ? procurementFromRow(result.rows[0]) : null;
  }
}

const procurementReturning = `
  id::text, order_id::text, supplier_id, supplier_product_id,
  supplier_offer_id, quantity, status, dispatch_state,
  acquisition_amount_minor::text, acquisition_currency,
  external_supplier_order_id, normalized_supplier_status, response_fingerprint,
  execution_token::text, execution_started_at, attempt_generation,
  record_version, correlation_id, last_reconciled_at,
  reconciliation_reason_code, created_at, updated_at
`;

const procurementValues = (
  operation: ProcurementOperation,
): readonly unknown[] => [
  operation.id,
  operation.orderId,
  operation.supplierId,
  operation.supplierProductId,
  operation.supplierOfferId,
  operation.quantity,
  operation.status,
  operation.dispatchState,
  operation.acquisitionAmount?.amountMinor.toString() ?? null,
  operation.acquisitionAmount?.currency ?? null,
  operation.externalSupplierOrderId ?? null,
  operation.normalizedSupplierStatus ?? null,
  operation.responseFingerprint ?? null,
  operation.executionToken ?? null,
  operation.executionStartedAt ?? null,
  operation.attemptGeneration,
  operation.recordVersion,
  operation.correlationId,
  operation.lastReconciledAt ?? null,
  operation.reconciliationReasonCode ?? null,
  operation.createdAt,
  operation.updatedAt,
];

const listByOrder = async (
  db: Queryable,
  requestedOrderId: OrderId,
): Promise<readonly ProcurementOperation[]> => {
  const result = await db.query<ProcurementRow>(
    `
      SELECT ${procurementReturning}
      FROM procurement_operations
      WHERE order_id = $1
      ORDER BY attempt_generation, created_at, id
    `,
    [requestedOrderId],
  );
  return result.rows.map(procurementFromRow);
};

const findById = async (
  db: Queryable,
  operationId: string,
): Promise<ProcurementOperation | null> => {
  const result = await db.query<ProcurementRow>(
    `
      SELECT ${procurementReturning}
      FROM procurement_operations
      WHERE id = $1
    `,
    [operationId],
  );
  return result.rows[0] ? procurementFromRow(result.rows[0]) : null;
};

const procurementFromRow = (row: ProcurementRow): ProcurementOperation => {
  const acquisitionAmount =
    row.acquisition_amount_minor && row.acquisition_currency
      ? money(
          BigInt(row.acquisition_amount_minor),
          currency(row.acquisition_currency),
        )
      : null;
  return {
    ...(acquisitionAmount ? { acquisitionAmount } : {}),
    attemptGeneration: row.attempt_generation,
    clientIdempotencyReference: idempotencyKey(
      `keycore:procurement:${row.order_id}:${row.supplier_id}:g${row.attempt_generation}`,
    ),
    correlationId: row.correlation_id as CorrelationId,
    createdAt: row.created_at,
    dispatchState: row.dispatch_state,
    ...(row.execution_started_at
      ? { executionStartedAt: row.execution_started_at }
      : {}),
    ...(row.execution_token ? { executionToken: row.execution_token } : {}),
    ...(row.external_supplier_order_id
      ? { externalSupplierOrderId: row.external_supplier_order_id }
      : {}),
    id: row.id,
    ...(row.last_reconciled_at
      ? { lastReconciledAt: row.last_reconciled_at }
      : {}),
    ...(row.normalized_supplier_status
      ? { normalizedSupplierStatus: row.normalized_supplier_status }
      : {}),
    orderId: orderId(row.order_id),
    quantity: row.quantity,
    recordVersion: row.record_version,
    ...(row.reconciliation_reason_code
      ? { reconciliationReasonCode: row.reconciliation_reason_code }
      : {}),
    ...(row.response_fingerprint
      ? { responseFingerprint: row.response_fingerprint }
      : {}),
    status: row.status as ProcurementOperationStatus,
    supplierId: supplierId(row.supplier_id),
    supplierOfferId: supplierOfferId(row.supplier_offer_id),
    supplierProductId: supplierProductId(row.supplier_product_id),
    updatedAt: row.updated_at,
  };
};
