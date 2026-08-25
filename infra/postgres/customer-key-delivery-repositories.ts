import {
  customerId,
  orderId,
  validateSafePayload,
  type CustomerKeyDeliveryApproval,
  type CustomerKeyDeliveryAttempt,
  type CustomerKeyDeliveryOutboxEvent,
  type CustomerKeyDeliveryReasonCode,
  type CustomerKeyDeliveryRepository,
  type CustomerKeyDeliveryStatus,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface ApprovalRow {
  readonly id: string;
  readonly fulfillment_id: string;
  readonly order_id: string;
  readonly customer_id: string;
  readonly purpose: "customer-key-delivery";
  readonly version: number;
  readonly token_hash: string;
  readonly context_fingerprint: string;
  readonly status: CustomerKeyDeliveryApproval["status"];
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly correlation_id: string;
  readonly record_version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface AttemptRow {
  readonly id: string;
  readonly approval_id: string;
  readonly fulfillment_id: string;
  readonly order_id: string;
  readonly customer_id: string;
  readonly channel: CustomerKeyDeliveryAttempt["channel"];
  readonly status: CustomerKeyDeliveryAttempt["status"];
  readonly execution_token: string | null;
  readonly started_at: Date | null;
  readonly delivered_at: Date | null;
  readonly delivery_reference: string | null;
  readonly failure_reason_code: CustomerKeyDeliveryReasonCode | null;
  readonly correlation_id: string;
  readonly record_version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresCustomerKeyDeliveryRepository implements CustomerKeyDeliveryRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async createApproval(input: {
    readonly approval: CustomerKeyDeliveryApproval;
    readonly now: Date;
  }) {
    return this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 7005))",
        [
          [
            input.approval.fulfillmentId,
            input.approval.orderId,
            input.approval.customerId,
          ].join(":"),
        ],
      );
      const existing = await findActiveApproval(client, input.approval);
      if (existing) {
        return { approval: existing, status: "EXISTING" as const };
      }
      const inserted = await client.query<ApprovalRow>(
        `
          INSERT INTO customer_key_delivery_approvals(
            id, fulfillment_id, order_id, customer_id, purpose, version,
            token_hash, context_fingerprint, status, issued_at, expires_at,
            consumed_at, correlation_id, record_version, created_at, updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11, $12, $13, $14, $15, $16
          )
          RETURNING ${approvalReturning}
        `,
        approvalValues(input.approval),
      );
      return {
        approval: approvalFromRow(requireApprovalRow(inserted.rows[0])),
        status: "CREATED" as const,
      };
    });
  }

  public async claimDelivery(input: {
    readonly approvalId: string;
    readonly tokenHash: string;
    readonly contextFingerprint: string;
    readonly channel: CustomerKeyDeliveryAttempt["channel"];
    readonly executionToken: string;
    readonly staleStartedBefore: Date;
    readonly now: Date;
  }) {
    return this.db.transaction(async (client) => {
      const approval = await findApprovalForUpdate(client, input.approvalId);
      if (!approval) {
        return { status: "NOT_FOUND" as const };
      }
      const latest = await findLatestAttempt(client, approval.fulfillmentId);
      if (latest?.status === "DELIVERED") {
        return {
          approval,
          attempt: latest,
          status: "ALREADY_DELIVERED" as const,
        };
      }
      if (
        latest?.status === "DELIVERY_IN_FLIGHT" &&
        latest.startedAt &&
        latest.startedAt > input.staleStartedBefore
      ) {
        return { approval, attempt: latest, status: "IN_FLIGHT" as const };
      }
      if (latest?.status === "DELIVERY_IN_FLIGHT") {
        const reviewed = await markAttemptFailed(client, {
          attemptId: latest.id,
          executionToken: latest.executionToken ?? "",
          now: input.now,
          reasonCode: "FULFILLMENT_DELIVERY_OUTCOME_UNKNOWN",
          status: "MANUAL_REVIEW_REQUIRED",
        });
        return {
          approval,
          attempt: reviewed ?? latest,
          status: "MANUAL_REVIEW_REQUIRED" as const,
        };
      }
      if (approval.contextFingerprint !== input.contextFingerprint) {
        return { approval, status: "CONTEXT_MISMATCH" as const };
      }
      if (approval.tokenHash !== input.tokenHash) {
        return { approval, status: "TOKEN_INVALID" as const };
      }
      if (approval.expiresAt <= input.now || approval.status !== "AUTHORIZED") {
        return { approval, status: "EXPIRED" as const };
      }
      const consumedResult = await client.query<ApprovalRow>(
        `
          UPDATE customer_key_delivery_approvals
          SET status = 'CONSUMED',
            consumed_at = $2,
            record_version = record_version + 1,
            updated_at = $2
          WHERE id = $1 AND status = 'AUTHORIZED'
          RETURNING ${approvalReturning}
        `,
        [approval.id, input.now],
      );
      const consumed = approvalFromRow(
        requireApprovalRow(consumedResult.rows[0]),
      );
      const inserted = await client.query<AttemptRow>(
        `
          INSERT INTO customer_key_delivery_attempts(
            approval_id, fulfillment_id, order_id, customer_id, channel,
            status, execution_token, started_at, delivered_at,
            delivery_reference, failure_reason_code, correlation_id,
            record_version, created_at, updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, 'DELIVERY_IN_FLIGHT',
            $6, $7, NULL, NULL, NULL, $8, 1, $7, $7
          )
          RETURNING ${attemptReturning}
        `,
        [
          consumed.id,
          consumed.fulfillmentId,
          consumed.orderId,
          consumed.customerId,
          input.channel,
          input.executionToken,
          input.now,
          consumed.correlationId,
        ],
      );
      return {
        approval: consumed,
        attempt: attemptFromRow(requireAttemptRow(inserted.rows[0])),
        status: "CLAIMED" as const,
      };
    });
  }

  public async markDelivered(input: {
    readonly attemptId: string;
    readonly executionToken: string;
    readonly deliveredAt: Date;
    readonly deliveryReference: string;
    readonly outbox: CustomerKeyDeliveryOutboxEvent;
  }): Promise<CustomerKeyDeliveryAttempt | null> {
    validateSafePayload(input.outbox.payload);
    return this.db.transaction(async (client) => {
      const current = await findAttemptForUpdate(client, input.attemptId);
      if (
        !current ||
        current.executionToken !== input.executionToken ||
        current.status !== "DELIVERY_IN_FLIGHT"
      ) {
        return null;
      }
      const fulfillment = await client.query(
        `
          UPDATE fulfillment_operations
          SET status = 'DELIVERED',
            delivery_state = 'DELIVERED',
            delivered_at = $2,
            record_version = record_version + 1,
            updated_at = $2
          WHERE id = $1
            AND status = 'DELIVERY_PENDING'
            AND retrieval_state = 'RETRIEVED'
            AND delivery_state = 'PENDING'
            AND encrypted_secret_id IS NOT NULL
          RETURNING id
        `,
        [current.fulfillmentId, input.deliveredAt],
      );
      if (!fulfillment.rows[0]) {
        return null;
      }
      const updated = await client.query<AttemptRow>(
        `
          UPDATE customer_key_delivery_attempts
          SET status = 'DELIVERED',
            execution_token = NULL,
            delivered_at = $3,
            delivery_reference = $4,
            record_version = record_version + 1,
            updated_at = $3
          WHERE id = $1
            AND execution_token = $2
            AND status = 'DELIVERY_IN_FLIGHT'
          RETURNING ${attemptReturning}
        `,
        [
          input.attemptId,
          input.executionToken,
          input.deliveredAt,
          input.deliveryReference,
        ],
      );
      if (!updated.rows[0]) {
        throw new Error(
          "Delivery attempt update failed after fulfillment delivery",
        );
      }
      await insertOutbox(client, input.outbox);
      return attemptFromRow(updated.rows[0]);
    });
  }

  public async markFailed(input: {
    readonly attemptId: string;
    readonly executionToken: string;
    readonly status: Extract<
      CustomerKeyDeliveryStatus,
      | "FAILED_RETRYABLE"
      | "FAILED_TERMINAL"
      | "AMBIGUOUS"
      | "MANUAL_REVIEW_REQUIRED"
    >;
    readonly reasonCode: CustomerKeyDeliveryReasonCode;
    readonly now: Date;
  }): Promise<CustomerKeyDeliveryAttempt | null> {
    return markAttemptFailed(this.db, input);
  }

  public findLatestAttemptByFulfillmentId(
    fulfillmentId: string,
  ): Promise<CustomerKeyDeliveryAttempt | null> {
    return findLatestAttempt(this.db, fulfillmentId);
  }
}

const approvalReturning = `
  id::text, fulfillment_id::text, order_id::text, customer_id, purpose,
  version, token_hash, context_fingerprint, status, issued_at, expires_at,
  consumed_at, correlation_id, record_version, created_at, updated_at
`;

const attemptReturning = `
  id::text, approval_id::text, fulfillment_id::text, order_id::text,
  customer_id, channel, status, execution_token::text, started_at,
  delivered_at, delivery_reference, failure_reason_code, correlation_id,
  record_version, created_at, updated_at
`;

const approvalValues = (
  approval: CustomerKeyDeliveryApproval,
): readonly unknown[] => [
  approval.id,
  approval.fulfillmentId,
  approval.orderId,
  approval.customerId,
  approval.purpose,
  approval.version,
  approval.tokenHash,
  approval.contextFingerprint,
  approval.status,
  approval.issuedAt,
  approval.expiresAt,
  approval.consumedAt ?? null,
  approval.correlationId,
  approval.recordVersion,
  approval.createdAt,
  approval.updatedAt,
];

const findActiveApproval = async (
  db: Queryable,
  approval: Pick<
    CustomerKeyDeliveryApproval,
    "fulfillmentId" | "orderId" | "customerId"
  >,
): Promise<CustomerKeyDeliveryApproval | null> => {
  const result = await db.query<ApprovalRow>(
    `
      SELECT ${approvalReturning}
      FROM customer_key_delivery_approvals
      WHERE fulfillment_id = $1
        AND order_id = $2
        AND customer_id = $3
        AND status = 'AUTHORIZED'
    `,
    [approval.fulfillmentId, approval.orderId, approval.customerId],
  );
  return result.rows[0] ? approvalFromRow(result.rows[0]) : null;
};

const findApprovalForUpdate = async (
  db: Queryable,
  approvalId: string,
): Promise<CustomerKeyDeliveryApproval | null> => {
  const result = await db.query<ApprovalRow>(
    `
      SELECT ${approvalReturning}
      FROM customer_key_delivery_approvals
      WHERE id = $1
      FOR UPDATE
    `,
    [approvalId],
  );
  return result.rows[0] ? approvalFromRow(result.rows[0]) : null;
};

const findAttemptForUpdate = async (
  db: Queryable,
  attemptId: string,
): Promise<CustomerKeyDeliveryAttempt | null> => {
  const result = await db.query<AttemptRow>(
    `
      SELECT ${attemptReturning}
      FROM customer_key_delivery_attempts
      WHERE id = $1
      FOR UPDATE
    `,
    [attemptId],
  );
  return result.rows[0] ? attemptFromRow(result.rows[0]) : null;
};

const findLatestAttempt = async (
  db: Queryable,
  fulfillmentId: string,
): Promise<CustomerKeyDeliveryAttempt | null> => {
  const result = await db.query<AttemptRow>(
    `
      SELECT ${attemptReturning}
      FROM customer_key_delivery_attempts
      WHERE fulfillment_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [fulfillmentId],
  );
  return result.rows[0] ? attemptFromRow(result.rows[0]) : null;
};

const markAttemptFailed = async (
  db: Queryable,
  input: {
    readonly attemptId: string;
    readonly executionToken: string;
    readonly status: Extract<
      CustomerKeyDeliveryStatus,
      | "FAILED_RETRYABLE"
      | "FAILED_TERMINAL"
      | "AMBIGUOUS"
      | "MANUAL_REVIEW_REQUIRED"
    >;
    readonly reasonCode: CustomerKeyDeliveryReasonCode;
    readonly now: Date;
  },
): Promise<CustomerKeyDeliveryAttempt | null> => {
  const result = await db.query<AttemptRow>(
    `
      UPDATE customer_key_delivery_attempts
      SET status = $3,
        execution_token = NULL,
        failure_reason_code = $4,
        record_version = record_version + 1,
        updated_at = $5
      WHERE id = $1
        AND execution_token = $2
        AND status = 'DELIVERY_IN_FLIGHT'
      RETURNING ${attemptReturning}
    `,
    [
      input.attemptId,
      input.executionToken,
      input.status,
      input.reasonCode,
      input.now,
    ],
  );
  return result.rows[0] ? attemptFromRow(result.rows[0]) : null;
};

const insertOutbox = async (
  db: Queryable,
  event: CustomerKeyDeliveryOutboxEvent,
): Promise<void> => {
  await db.query(
    `
      INSERT INTO outbox_events(
        event_type, aggregate_type, aggregate_id, payload, correlation_id,
        event_deduplication_key, status, retry_count, next_attempt_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'PENDING', 0, now())
      ON CONFLICT (event_deduplication_key) DO NOTHING
    `,
    [
      event.eventType,
      event.aggregateType,
      event.aggregateId,
      JSON.stringify(event.payload),
      event.correlationId,
      event.eventDeduplicationKey,
    ],
  );
};

const approvalFromRow = (row: ApprovalRow): CustomerKeyDeliveryApproval => ({
  consumedAt: row.consumed_at,
  contextFingerprint: row.context_fingerprint,
  correlationId:
    row.correlation_id as CustomerKeyDeliveryApproval["correlationId"],
  createdAt: row.created_at,
  customerId: customerId(row.customer_id),
  expiresAt: row.expires_at,
  fulfillmentId: row.fulfillment_id,
  id: row.id,
  issuedAt: row.issued_at,
  orderId: orderId(row.order_id),
  purpose: row.purpose,
  recordVersion: row.record_version,
  status: row.status,
  tokenHash: row.token_hash,
  updatedAt: row.updated_at,
  version: 1,
});

const attemptFromRow = (row: AttemptRow): CustomerKeyDeliveryAttempt => ({
  approvalId: row.approval_id,
  channel: row.channel,
  correlationId:
    row.correlation_id as CustomerKeyDeliveryAttempt["correlationId"],
  createdAt: row.created_at,
  customerId: customerId(row.customer_id),
  deliveredAt: row.delivered_at,
  deliveryReference: row.delivery_reference,
  executionToken: row.execution_token,
  failureReasonCode: row.failure_reason_code,
  fulfillmentId: row.fulfillment_id,
  id: row.id,
  orderId: orderId(row.order_id),
  recordVersion: row.record_version,
  startedAt: row.started_at,
  status: row.status,
  updatedAt: row.updated_at,
});

const requireApprovalRow = (row: ApprovalRow | undefined): ApprovalRow => {
  if (!row) {
    throw new Error("Expected customer delivery approval row");
  }
  return row;
};

const requireAttemptRow = (row: AttemptRow | undefined): AttemptRow => {
  if (!row) {
    throw new Error("Expected customer delivery attempt row");
  }
  return row;
};
