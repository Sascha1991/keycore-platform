import {
  orderId,
  supplierId,
  type FulfillmentEncryptedSecretMaterial,
  type FulfillmentOperation,
  type FulfillmentReasonCode,
  type FulfillmentRepository,
  type FulfillmentSecretRecord,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface FulfillmentRow {
  readonly id: string;
  readonly order_id: string | null;
  readonly procurement_operation_id: string | null;
  readonly controlled_procurement_approval_id: string | null;
  readonly supplier_id: string;
  readonly external_supplier_order_id: string;
  readonly supplier_item_reference: string | null;
  readonly expected_quantity: number;
  readonly status: FulfillmentOperation["status"];
  readonly retrieval_state: FulfillmentOperation["retrievalState"];
  readonly delivery_state: FulfillmentOperation["deliveryState"];
  readonly token_hash: string | null;
  readonly approval_expires_at: Date | null;
  readonly retrieval_execution_token: string | null;
  readonly retrieval_started_at: Date | null;
  readonly encrypted_secret_id: string | null;
  readonly failure_reason_code: FulfillmentReasonCode | null;
  readonly record_version: number;
  readonly correlation_id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly retrieved_at: Date | null;
  readonly delivered_at: Date | null;
}

interface SecretRow {
  readonly id: string;
  readonly fulfillment_id: string;
  readonly ciphertext: Buffer;
  readonly encryption_nonce: Buffer;
  readonly encryption_tag: Buffer;
  readonly wrapped_data_encryption_key: Buffer;
  readonly encryption_key_id: string;
  readonly encryption_version: number;
  readonly encryption_algorithm: string;
  readonly created_at: Date;
}

export class PostgresFulfillmentRepository implements FulfillmentRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async createIdempotent(input: {
    readonly operation: FulfillmentOperation;
    readonly now: Date;
  }): Promise<
    | { readonly status: "CREATED"; readonly operation: FulfillmentOperation }
    | { readonly status: "EXISTING"; readonly operation: FulfillmentOperation }
  > {
    return this.db.transaction(async (client) => {
      const key =
        input.operation.controlledProcurementApprovalId ??
        `${input.operation.orderId ?? "no-order"}:${input.operation.procurementOperationId ?? "no-procurement"}`;
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 7004))",
        [key],
      );
      const existing = input.operation.controlledProcurementApprovalId
        ? await findByControlledProcurementApprovalId(
            client,
            input.operation.controlledProcurementApprovalId,
          )
        : input.operation.orderId && input.operation.procurementOperationId
          ? await findByOrderProcurement(
              client,
              input.operation.orderId,
              input.operation.procurementOperationId,
            )
          : null;
      if (existing) {
        return { operation: existing, status: "EXISTING" };
      }
      const result = await client.query<FulfillmentRow>(
        `
          INSERT INTO fulfillment_operations(
            id, order_id, procurement_operation_id,
            controlled_procurement_approval_id, supplier_id,
            external_supplier_order_id, supplier_item_reference,
            expected_quantity, status, retrieval_state, delivery_state,
            token_hash, approval_expires_at, retrieval_execution_token,
            retrieval_started_at, encrypted_secret_id, failure_reason_code,
            record_version, correlation_id, created_at, updated_at,
            retrieved_at, delivered_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22, $23
          )
          RETURNING ${fulfillmentReturning}
        `,
        operationValues(input.operation),
      );
      return {
        operation: fromRow(requireRow(result.rows[0])),
        status: "CREATED",
      };
    });
  }

  public async findById(
    fulfillmentId: string,
  ): Promise<FulfillmentOperation | null> {
    return findById(this.db, fulfillmentId);
  }

  public async findByControlledProcurementApprovalId(
    approvalId: string,
  ): Promise<FulfillmentOperation | null> {
    return findByControlledProcurementApprovalId(this.db, approvalId);
  }

  public async acquireRetrievalLease(input: {
    readonly fulfillmentId: string;
    readonly tokenHash: string;
    readonly executionToken: string;
    readonly staleStartedBefore: Date;
    readonly now: Date;
  }): Promise<
    | { readonly status: "ACQUIRED"; readonly operation: FulfillmentOperation }
    | { readonly status: "IN_FLIGHT"; readonly operation: FulfillmentOperation }
    | {
        readonly status: "ALREADY_RETRIEVED";
        readonly operation: FulfillmentOperation;
      }
    | { readonly status: "EXPIRED"; readonly operation: FulfillmentOperation }
    | {
        readonly status: "TOKEN_INVALID";
        readonly operation: FulfillmentOperation;
      }
    | {
        readonly status: "NOT_ELIGIBLE";
        readonly operation?: FulfillmentOperation;
      }
  > {
    const result = await this.db.query<FulfillmentRow>(
      `
        UPDATE fulfillment_operations
        SET status = 'RETRIEVAL_IN_FLIGHT',
          retrieval_state = 'IN_FLIGHT',
          retrieval_execution_token = $2,
          retrieval_started_at = $3,
          record_version = record_version + 1,
          updated_at = $3
        WHERE id = $1
          AND token_hash = $4
          AND approval_expires_at > $3
          AND encrypted_secret_id IS NULL
          AND (
            status = 'READY'
            OR (
              status = 'FAILED_RETRYABLE'
              AND (
                retrieval_execution_token IS NULL
                OR retrieval_started_at <= $5
              )
            )
          )
        RETURNING ${fulfillmentReturning}
      `,
      [
        input.fulfillmentId,
        input.executionToken,
        input.now,
        input.tokenHash,
        input.staleStartedBefore,
      ],
    );
    if (result.rows[0]) {
      return { operation: fromRow(result.rows[0]), status: "ACQUIRED" };
    }
    const current = await findById(this.db, input.fulfillmentId);
    if (!current) {
      return { status: "NOT_ELIGIBLE" };
    }
    if (current.encryptedSecretId) {
      return { operation: current, status: "ALREADY_RETRIEVED" };
    }
    if (current.tokenHash !== input.tokenHash) {
      return { operation: current, status: "TOKEN_INVALID" };
    }
    if (
      current.approvalExpiresAt &&
      current.approvalExpiresAt.getTime() <= input.now.getTime()
    ) {
      return { operation: current, status: "EXPIRED" };
    }
    if (
      current.retrievalExecutionToken &&
      current.retrievalStartedAt &&
      current.retrievalStartedAt.getTime() > input.staleStartedBefore.getTime()
    ) {
      return { operation: current, status: "IN_FLIGHT" };
    }
    return { operation: current, status: "NOT_ELIGIBLE" };
  }

  public async markRetrieved(input: {
    readonly fulfillmentId: string;
    readonly executionToken: string;
    readonly material: FulfillmentEncryptedSecretMaterial;
    readonly now: Date;
  }): Promise<FulfillmentOperation | null> {
    return this.db.transaction(async (client) => {
      const current = await findById(client, input.fulfillmentId);
      if (
        !current ||
        current.retrievalExecutionToken !== input.executionToken ||
        current.encryptedSecretId
      ) {
        return null;
      }
      const secret = await client.query<SecretRow>(
        `
          INSERT INTO fulfillment_secrets(
            fulfillment_id, ciphertext, encryption_nonce, encryption_tag,
            wrapped_data_encryption_key, encryption_key_id,
            encryption_version, encryption_algorithm, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING *
        `,
        [
          input.fulfillmentId,
          toBuffer(input.material.ciphertext),
          toBuffer(input.material.nonce),
          toBuffer(input.material.authenticationTag),
          toBuffer(input.material.wrappedDataEncryptionKey),
          input.material.encryptionKeyId,
          input.material.encryptionVersion,
          input.material.algorithm,
          input.now,
        ],
      );
      const secretId = requireSecretRow(secret.rows[0]).id;
      const updated = await client.query<FulfillmentRow>(
        `
          UPDATE fulfillment_operations
          SET status = 'DELIVERY_PENDING',
            retrieval_state = 'RETRIEVED',
            delivery_state = 'PENDING',
            retrieval_execution_token = NULL,
            retrieval_started_at = NULL,
            encrypted_secret_id = $3,
            retrieved_at = $4,
            record_version = record_version + 1,
            updated_at = $4
          WHERE id = $1
            AND retrieval_execution_token = $2
            AND encrypted_secret_id IS NULL
          RETURNING ${fulfillmentReturning}
        `,
        [input.fulfillmentId, input.executionToken, secretId, input.now],
      );
      return updated.rows[0] ? fromRow(updated.rows[0]) : null;
    });
  }

  public async markFailed(input: {
    readonly fulfillmentId: string;
    readonly executionToken: string;
    readonly status:
      | "FAILED_RETRYABLE"
      | "FAILED_TERMINAL"
      | "AMBIGUOUS"
      | "MANUAL_REVIEW_REQUIRED";
    readonly reasonCode: FulfillmentReasonCode;
    readonly now: Date;
  }): Promise<FulfillmentOperation | null> {
    const result = await this.db.query<FulfillmentRow>(
      `
        UPDATE fulfillment_operations
        SET status = $3,
          retrieval_state = $3,
          retrieval_execution_token = NULL,
          retrieval_started_at = NULL,
          failure_reason_code = $4,
          record_version = record_version + 1,
          updated_at = $5
        WHERE id = $1
          AND retrieval_execution_token = $2
          AND encrypted_secret_id IS NULL
        RETURNING ${fulfillmentReturning}
      `,
      [
        input.fulfillmentId,
        input.executionToken,
        input.status,
        input.reasonCode,
        input.now,
      ],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  public async markDelivered(input: {
    readonly fulfillmentId: string;
    readonly now: Date;
  }): Promise<FulfillmentOperation | null> {
    const result = await this.db.query<FulfillmentRow>(
      `
        UPDATE fulfillment_operations
        SET status = 'DELIVERED',
          delivery_state = 'DELIVERED',
          delivered_at = $2,
          record_version = record_version + 1,
          updated_at = $2
        WHERE id = $1
          AND status = 'DELIVERY_PENDING'
          AND encrypted_secret_id IS NOT NULL
        RETURNING ${fulfillmentReturning}
      `,
      [input.fulfillmentId, input.now],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  public async findSecretByFulfillmentId(
    fulfillmentId: string,
  ): Promise<FulfillmentSecretRecord | null> {
    const result = await this.db.query<SecretRow>(
      "SELECT * FROM fulfillment_secrets WHERE fulfillment_id = $1",
      [fulfillmentId],
    );
    return result.rows[0] ? secretFromRow(result.rows[0]) : null;
  }
}

const fulfillmentReturning = `
  id::text, order_id::text, procurement_operation_id::text,
  controlled_procurement_approval_id::text, supplier_id,
  external_supplier_order_id, supplier_item_reference, expected_quantity,
  status, retrieval_state, delivery_state, token_hash, approval_expires_at,
  retrieval_execution_token::text, retrieval_started_at,
  encrypted_secret_id::text, failure_reason_code, record_version,
  correlation_id, created_at, updated_at, retrieved_at, delivered_at
`;

const operationValues = (
  operation: FulfillmentOperation,
): readonly unknown[] => [
  operation.id,
  operation.orderId ?? null,
  operation.procurementOperationId ?? null,
  operation.controlledProcurementApprovalId ?? null,
  operation.supplierId,
  operation.externalSupplierOrderId,
  operation.supplierItemReference ?? null,
  operation.expectedQuantity,
  operation.status,
  operation.retrievalState,
  operation.deliveryState,
  operation.tokenHash ?? null,
  operation.approvalExpiresAt ?? null,
  operation.retrievalExecutionToken ?? null,
  operation.retrievalStartedAt ?? null,
  operation.encryptedSecretId ?? null,
  operation.failureReasonCode ?? null,
  operation.recordVersion,
  operation.correlationId,
  operation.createdAt,
  operation.updatedAt,
  operation.retrievedAt ?? null,
  operation.deliveredAt ?? null,
];

const findById = async (
  db: Queryable,
  fulfillmentId: string,
): Promise<FulfillmentOperation | null> => {
  const result = await db.query<FulfillmentRow>(
    `SELECT ${fulfillmentReturning} FROM fulfillment_operations WHERE id = $1`,
    [fulfillmentId],
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
};

const findByControlledProcurementApprovalId = async (
  db: Queryable,
  approvalId: string,
): Promise<FulfillmentOperation | null> => {
  const result = await db.query<FulfillmentRow>(
    `
      SELECT ${fulfillmentReturning}
      FROM fulfillment_operations
      WHERE controlled_procurement_approval_id = $1
    `,
    [approvalId],
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
};

const findByOrderProcurement = async (
  db: Queryable,
  requestedOrderId: string,
  procurementOperationId: string,
): Promise<FulfillmentOperation | null> => {
  const result = await db.query<FulfillmentRow>(
    `
      SELECT ${fulfillmentReturning}
      FROM fulfillment_operations
      WHERE order_id = $1 AND procurement_operation_id = $2
    `,
    [requestedOrderId, procurementOperationId],
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
};

const fromRow = (row: FulfillmentRow): FulfillmentOperation => ({
  approvalExpiresAt: row.approval_expires_at,
  controlledProcurementApprovalId: row.controlled_procurement_approval_id,
  correlationId: row.correlation_id as FulfillmentOperation["correlationId"],
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  deliveryState: row.delivery_state,
  encryptedSecretId: row.encrypted_secret_id,
  expectedQuantity: row.expected_quantity,
  externalSupplierOrderId: row.external_supplier_order_id,
  failureReasonCode: row.failure_reason_code,
  id: row.id,
  orderId: row.order_id ? orderId(row.order_id) : null,
  procurementOperationId: row.procurement_operation_id,
  recordVersion: row.record_version,
  retrievedAt: row.retrieved_at,
  retrievalExecutionToken: row.retrieval_execution_token,
  retrievalStartedAt: row.retrieval_started_at,
  retrievalState: row.retrieval_state,
  status: row.status,
  supplierId: supplierId(row.supplier_id),
  supplierItemReference: row.supplier_item_reference,
  tokenHash: row.token_hash,
  updatedAt: row.updated_at,
});

const secretFromRow = (row: SecretRow): FulfillmentSecretRecord => ({
  algorithm: row.encryption_algorithm as FulfillmentSecretRecord["algorithm"],
  authenticationTag: row.encryption_tag,
  ciphertext: row.ciphertext,
  createdAt: row.created_at,
  encryptionKeyId: row.encryption_key_id,
  encryptionVersion:
    row.encryption_version as FulfillmentSecretRecord["encryptionVersion"],
  fulfillmentId: row.fulfillment_id,
  id: row.id,
  nonce: row.encryption_nonce,
  wrappedDataEncryptionKey: row.wrapped_data_encryption_key,
});

const toBuffer = (value: Uint8Array): Buffer =>
  Buffer.from(value.buffer, value.byteOffset, value.byteLength);

const requireRow = (row: FulfillmentRow | undefined): FulfillmentRow => {
  if (!row) {
    throw new Error("Expected fulfillment operation row");
  }
  return row;
};

const requireSecretRow = (row: SecretRow | undefined): SecretRow => {
  if (!row) {
    throw new Error("Expected fulfillment secret row");
  }
  return row;
};
