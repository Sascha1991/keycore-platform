import type {
  AuditEvent,
  AuditEventPort,
  CorrelationId,
  SafePayload,
} from "../../packages/platform/src/contracts.js";
import { validateSafePayload } from "../../packages/platform/src/contracts.js";
import type { Queryable } from "./client.js";

export interface IdempotencyReservation {
  readonly scope: string;
  readonly key: string;
  readonly status: "STARTED" | "COMPLETED" | "FAILED";
  readonly orderLineId?: string;
  readonly providerEventId?: string;
}

export class PostgresAuditEventRepository implements AuditEventPort {
  public constructor(private readonly database: Queryable) {}

  public async append(event: AuditEvent): Promise<void> {
    await this.database.query(
      `
        INSERT INTO audit_events (
          id,
          event_type,
          timestamp_utc,
          actor,
          correlation_id,
          entity,
          environment,
          outcome,
          reason_code,
          metadata
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10::jsonb)
      `,
      [
        event.uuid,
        event.eventType,
        event.timestampUtc,
        JSON.stringify(event.actor),
        event.correlationId,
        JSON.stringify(event.entity),
        event.environment,
        event.outcome,
        event.reasonCode,
        JSON.stringify(event.metadata),
      ],
    );
  }
}

export class PostgresIdempotencyRepository {
  public constructor(private readonly database: Queryable) {}

  public async reserve(reservation: IdempotencyReservation): Promise<void> {
    await this.database.query(
      `
        INSERT INTO idempotency_records (
          scope,
          idempotency_key,
          order_line_id,
          provider_event_id,
          status
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        reservation.scope,
        reservation.key,
        reservation.orderLineId ?? null,
        reservation.providerEventId ?? null,
        reservation.status,
      ],
    );
  }
}

export interface OutboxCreateRequest {
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: SafePayload;
  readonly correlationId: CorrelationId;
  readonly eventDeduplicationKey: string;
}

export interface OutboxRecord extends OutboxCreateRequest {
  readonly id: string;
  readonly status:
    "PENDING" | "CLAIMED" | "PUBLISHED" | "FAILED" | "MANUAL_REVIEW";
  readonly retryCount: number;
  readonly nextAttemptAt: Date;
  readonly lastErrorClassification: string | null;
}

const mapOutboxRecord = (row: {
  readonly aggregate_id: string;
  readonly aggregate_type: string;
  readonly correlation_id: string;
  readonly event_deduplication_key: string;
  readonly event_type: string;
  readonly id: string;
  readonly last_error_classification: string | null;
  readonly next_attempt_at: Date;
  readonly payload: SafePayload;
  readonly retry_count: number;
  readonly status: OutboxRecord["status"];
}): OutboxRecord => ({
  aggregateId: row.aggregate_id,
  aggregateType: row.aggregate_type,
  correlationId: row.correlation_id as CorrelationId,
  eventDeduplicationKey: row.event_deduplication_key,
  eventType: row.event_type,
  id: row.id,
  lastErrorClassification: row.last_error_classification,
  nextAttemptAt: row.next_attempt_at,
  payload: row.payload,
  retryCount: row.retry_count,
  status: row.status,
});

export class PostgresOutboxRepository {
  public constructor(private readonly database: Queryable) {}

  public async enqueue(request: OutboxCreateRequest): Promise<OutboxRecord> {
    validateSafePayload(request.payload);
    const result = await this.database.query<{
      aggregate_id: string;
      aggregate_type: string;
      correlation_id: string;
      event_deduplication_key: string;
      event_type: string;
      id: string;
      last_error_classification: string | null;
      next_attempt_at: Date;
      payload: SafePayload;
      retry_count: number;
      status: OutboxRecord["status"];
    }>(
      `
        INSERT INTO outbox_events(
          event_type,
          aggregate_type,
          aggregate_id,
          payload,
          correlation_id,
          event_deduplication_key
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        RETURNING *
      `,
      [
        request.eventType,
        request.aggregateType,
        request.aggregateId,
        JSON.stringify(request.payload),
        request.correlationId,
        request.eventDeduplicationKey,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Outbox enqueue failed");
    }

    return mapOutboxRecord(row);
  }

  public async claimDue(
    limit: number,
    now: Date,
  ): Promise<readonly OutboxRecord[]> {
    const result = await this.database.query<{
      aggregate_id: string;
      aggregate_type: string;
      correlation_id: string;
      event_deduplication_key: string;
      event_type: string;
      id: string;
      last_error_classification: string | null;
      next_attempt_at: Date;
      payload: SafePayload;
      retry_count: number;
      status: OutboxRecord["status"];
    }>(
      `
        WITH due AS (
          SELECT id
          FROM outbox_events
          WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= $1
          ORDER BY next_attempt_at, created_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox_events
        SET status = 'CLAIMED'
        WHERE id IN (SELECT id FROM due)
        RETURNING *
      `,
      [now, limit],
    );

    return result.rows.map(mapOutboxRecord);
  }

  public async markPublished(id: string, now: Date): Promise<void> {
    await this.database.query(
      "UPDATE outbox_events SET status = 'PUBLISHED', dispatched_at = $2 WHERE id = $1",
      [id, now],
    );
  }

  public async scheduleRetry(
    id: string,
    retryCount: number,
    nextAttemptAt: Date,
    classification: string,
  ): Promise<void> {
    await this.database.query(
      `
        UPDATE outbox_events
        SET status = 'FAILED',
            retry_count = $2,
            next_attempt_at = $3,
            last_error_classification = $4
        WHERE id = $1
      `,
      [id, retryCount, nextAttemptAt, classification],
    );
  }

  public async markManualReview(
    id: string,
    classification: string,
  ): Promise<void> {
    await this.database.query(
      `
        UPDATE outbox_events
        SET status = 'MANUAL_REVIEW',
            last_error_classification = $2
        WHERE id = $1
      `,
      [id, classification],
    );
  }
}

export interface ReconciliationCreateRequest {
  readonly orderLineId?: string;
  readonly reconciliationType: string;
  readonly correlationId: CorrelationId;
}

export interface ReconciliationRecord extends ReconciliationCreateRequest {
  readonly id: string;
  readonly state:
    "PENDING" | "CLAIMED" | "COMPLETED" | "FAILED" | "MANUAL_REVIEW";
  readonly retryCount: number;
  readonly nextAttemptAt: Date;
  readonly lastErrorClassification: string | null;
  readonly manualReviewRequired: boolean;
}

const mapReconciliationRecord = (row: {
  readonly correlation_id: string;
  readonly id: string;
  readonly last_error_classification: string | null;
  readonly manual_review_required: boolean;
  readonly next_attempt_at: Date;
  readonly order_line_id: string | null;
  readonly reconciliation_type: string;
  readonly retry_count: number;
  readonly state: ReconciliationRecord["state"];
}): ReconciliationRecord => {
  const record: ReconciliationRecord = {
    correlationId: row.correlation_id as CorrelationId,
    id: row.id,
    lastErrorClassification: row.last_error_classification,
    manualReviewRequired: row.manual_review_required,
    nextAttemptAt: row.next_attempt_at,
    reconciliationType: row.reconciliation_type,
    retryCount: row.retry_count,
    state: row.state,
  };

  if (row.order_line_id !== null) {
    return {
      ...record,
      orderLineId: row.order_line_id,
    };
  }

  return record;
};

export class PostgresReconciliationRepository {
  public constructor(private readonly database: Queryable) {}

  public async create(
    request: ReconciliationCreateRequest,
  ): Promise<ReconciliationRecord> {
    const result = await this.database.query<{
      correlation_id: string;
      id: string;
      last_error_classification: string | null;
      manual_review_required: boolean;
      next_attempt_at: Date;
      order_line_id: string | null;
      reconciliation_type: string;
      retry_count: number;
      state: ReconciliationRecord["state"];
    }>(
      `
        INSERT INTO reconciliation_records(
          order_line_id,
          reconciliation_type,
          state,
          correlation_id
        )
        VALUES ($1, $2, 'PENDING', $3)
        RETURNING *
      `,
      [
        request.orderLineId ?? null,
        request.reconciliationType,
        request.correlationId,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Reconciliation creation failed");
    }

    return mapReconciliationRecord(row);
  }

  public async claimDue(
    limit: number,
    now: Date,
  ): Promise<readonly ReconciliationRecord[]> {
    const result = await this.database.query<{
      correlation_id: string;
      id: string;
      last_error_classification: string | null;
      manual_review_required: boolean;
      next_attempt_at: Date;
      order_line_id: string | null;
      reconciliation_type: string;
      retry_count: number;
      state: ReconciliationRecord["state"];
    }>(
      `
        WITH due AS (
          SELECT id
          FROM reconciliation_records
          WHERE state IN ('PENDING', 'FAILED') AND next_attempt_at <= $1
          ORDER BY next_attempt_at, created_at
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        UPDATE reconciliation_records
        SET state = 'CLAIMED'
        WHERE id IN (SELECT id FROM due)
        RETURNING *
      `,
      [now, limit],
    );

    return result.rows.map(mapReconciliationRecord);
  }

  public async complete(id: string): Promise<void> {
    await this.database.query(
      "UPDATE reconciliation_records SET state = 'COMPLETED', updated_at = now() WHERE id = $1",
      [id],
    );
  }

  public async fail(
    id: string,
    retryCount: number,
    nextAttemptAt: Date,
    classification: string,
  ): Promise<void> {
    await this.database.query(
      `
        UPDATE reconciliation_records
        SET state = 'FAILED',
            retry_count = $2,
            next_attempt_at = $3,
            last_error_classification = $4,
            updated_at = now()
        WHERE id = $1
      `,
      [id, retryCount, nextAttemptAt, classification],
    );
  }

  public async escalateManualReview(
    id: string,
    classification: string,
  ): Promise<void> {
    await this.database.query(
      `
        UPDATE reconciliation_records
        SET state = 'MANUAL_REVIEW',
            manual_review_required = true,
            last_error_classification = $2,
            updated_at = now()
        WHERE id = $1
      `,
      [id, classification],
    );
  }
}
