import type {
  AuditEvent,
  AuditEventPort,
  AuditQueryPage,
  AuditQueryRepositoryPort,
  AuthorizedAuditQuery,
  CorrelationId,
  EncryptedKeyMaterial,
  SafePayload,
  StoredEncryptedKeyRecord,
} from "../../packages/platform/src/contracts.js";
import {
  orderLineId,
  validateAuditEvent,
  validateSafePayload,
} from "../../packages/platform/src/contracts.js";
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
    validateAuditEvent(event);
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

const mapAuditEventRow = (row: {
  readonly actor: AuditEvent["actor"];
  readonly correlation_id: string;
  readonly entity: AuditEvent["entity"];
  readonly environment: AuditEvent["environment"];
  readonly event_type: AuditEvent["eventType"];
  readonly id: string;
  readonly metadata: AuditEvent["metadata"];
  readonly outcome: AuditEvent["outcome"];
  readonly reason_code: string;
  readonly timestamp_utc: Date;
}): AuditEvent => ({
  actor: row.actor,
  correlationId: row.correlation_id as CorrelationId,
  entity: row.entity,
  environment: row.environment,
  eventType: row.event_type,
  metadata: row.metadata,
  outcome: row.outcome,
  reasonCode: row.reason_code,
  timestampUtc: row.timestamp_utc,
  uuid: row.id,
});

export class PostgresAuditQueryRepository implements AuditQueryRepositoryPort {
  public constructor(private readonly database: Queryable) {}

  public async query(request: AuthorizedAuditQuery): Promise<AuditQueryPage> {
    const values: unknown[] = [];
    const predicates: string[] = [];
    const addValue = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (request.filters.fromTimestampUtc) {
      predicates.push(
        `timestamp_utc >= ${addValue(request.filters.fromTimestampUtc)}`,
      );
    }

    if (request.filters.toTimestampUtc) {
      predicates.push(
        `timestamp_utc <= ${addValue(request.filters.toTimestampUtc)}`,
      );
    }

    if (request.filters.eventType) {
      predicates.push(`event_type = ${addValue(request.filters.eventType)}`);
    }

    if (request.filters.correlationId) {
      predicates.push(
        `correlation_id = ${addValue(request.filters.correlationId)}`,
      );
    }

    if (request.filters.entity) {
      predicates.push(
        `entity->>'type' = ${addValue(request.filters.entity.type)}`,
      );
      predicates.push(`entity->>'id' = ${addValue(request.filters.entity.id)}`);
    }

    if (request.filters.actor) {
      predicates.push(
        `actor->>'type' = ${addValue(request.filters.actor.type)}`,
      );
      predicates.push(`actor->>'id' = ${addValue(request.filters.actor.id)}`);
    }

    if (request.filters.outcome) {
      predicates.push(`outcome = ${addValue(request.filters.outcome)}`);
    }

    if (request.filters.reasonCode) {
      predicates.push(`reason_code = ${addValue(request.filters.reasonCode)}`);
    }

    if (request.cursor) {
      predicates.push(
        `(timestamp_utc, id) > (${addValue(request.cursor.timestampUtc)}, ${addValue(request.cursor.uuid)}::uuid)`,
      );
    }

    const whereClause =
      predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
    const limit = request.pageSize + 1;
    const result = await this.database.query<{
      actor: AuditEvent["actor"];
      correlation_id: string;
      entity: AuditEvent["entity"];
      environment: AuditEvent["environment"];
      event_type: AuditEvent["eventType"];
      id: string;
      metadata: AuditEvent["metadata"];
      outcome: AuditEvent["outcome"];
      reason_code: string;
      timestamp_utc: Date;
    }>(
      `
        SELECT
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
        FROM audit_events
        ${whereClause}
        ORDER BY timestamp_utc ASC, id ASC
        LIMIT ${addValue(limit)}
      `,
      values,
    );

    const rows = result.rows.slice(0, request.pageSize);
    const events = rows.map(mapAuditEventRow);
    const lastEvent = events.at(-1);

    if (result.rows.length > request.pageSize && lastEvent) {
      return {
        events,
        nextCursor: {
          timestampUtc: lastEvent.timestampUtc,
          uuid: lastEvent.uuid,
        },
      };
    }

    return { events };
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

const toBuffer = (value: Uint8Array): Buffer =>
  Buffer.from(value.buffer, value.byteOffset, value.byteLength);

const mapEncryptedKeyRecord = (row: {
  readonly algorithm: string;
  readonly authentication_tag: Buffer;
  readonly ciphertext: Buffer;
  readonly created_at: Date;
  readonly id: string;
  readonly key_version: string;
  readonly nonce: Buffer;
  readonly order_line_id: string;
  readonly retired_at: Date | null;
  readonly rotated_at: Date | null;
  readonly wrapped_data_encryption_key: Buffer;
}): StoredEncryptedKeyRecord => ({
  algorithm: row.algorithm as EncryptedKeyMaterial["algorithm"],
  authenticationTag: row.authentication_tag,
  ciphertext: row.ciphertext,
  createdAt: row.created_at,
  id: row.id,
  keyVersion: row.key_version,
  nonce: row.nonce,
  orderLineId: orderLineId(row.order_line_id),
  retiredAt: row.retired_at,
  rotatedAt: row.rotated_at,
  wrappedDataEncryptionKey: row.wrapped_data_encryption_key,
});

export class PostgresEncryptedKeyRepository {
  public constructor(private readonly database: Queryable) {}

  public async store(request: {
    readonly orderLineId: StoredEncryptedKeyRecord["orderLineId"];
    readonly material: EncryptedKeyMaterial;
  }): Promise<StoredEncryptedKeyRecord> {
    const result = await this.database.query<{
      algorithm: string;
      authentication_tag: Buffer;
      ciphertext: Buffer;
      created_at: Date;
      id: string;
      key_version: string;
      nonce: Buffer;
      order_line_id: string;
      retired_at: Date | null;
      rotated_at: Date | null;
      wrapped_data_encryption_key: Buffer;
    }>(
      `
        INSERT INTO encrypted_key_records(
          order_line_id,
          ciphertext,
          nonce,
          authentication_tag,
          wrapped_data_encryption_key,
          algorithm,
          key_version
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `,
      [
        request.orderLineId,
        toBuffer(request.material.ciphertext),
        toBuffer(request.material.nonce),
        toBuffer(request.material.authenticationTag),
        toBuffer(request.material.wrappedDataEncryptionKey),
        request.material.algorithm,
        request.material.keyVersion,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Encrypted key record storage failed");
    }

    return mapEncryptedKeyRecord(row);
  }

  public async findById(id: string): Promise<StoredEncryptedKeyRecord | null> {
    const result = await this.database.query<{
      algorithm: string;
      authentication_tag: Buffer;
      ciphertext: Buffer;
      created_at: Date;
      id: string;
      key_version: string;
      nonce: Buffer;
      order_line_id: string;
      retired_at: Date | null;
      rotated_at: Date | null;
      wrapped_data_encryption_key: Buffer;
    }>("SELECT * FROM encrypted_key_records WHERE id = $1", [id]);

    const row = result.rows[0];
    return row ? mapEncryptedKeyRecord(row) : null;
  }

  public async findActiveByOrderLineId(
    id: StoredEncryptedKeyRecord["orderLineId"],
  ): Promise<StoredEncryptedKeyRecord | null> {
    const result = await this.database.query<{
      algorithm: string;
      authentication_tag: Buffer;
      ciphertext: Buffer;
      created_at: Date;
      id: string;
      key_version: string;
      nonce: Buffer;
      order_line_id: string;
      retired_at: Date | null;
      rotated_at: Date | null;
      wrapped_data_encryption_key: Buffer;
    }>(
      `
        SELECT *
        FROM encrypted_key_records
        WHERE order_line_id = $1 AND retired_at IS NULL
      `,
      [id],
    );

    const row = result.rows[0];
    return row ? mapEncryptedKeyRecord(row) : null;
  }

  public async rewrap(
    id: string,
    request: {
      readonly wrappedDataEncryptionKey: Uint8Array;
      readonly keyVersion: string;
      readonly rotatedAt: Date;
    },
  ): Promise<StoredEncryptedKeyRecord> {
    const result = await this.database.query<{
      algorithm: string;
      authentication_tag: Buffer;
      ciphertext: Buffer;
      created_at: Date;
      id: string;
      key_version: string;
      nonce: Buffer;
      order_line_id: string;
      retired_at: Date | null;
      rotated_at: Date | null;
      wrapped_data_encryption_key: Buffer;
    }>(
      `
        UPDATE encrypted_key_records
        SET wrapped_data_encryption_key = $2,
            key_version = $3,
            rotated_at = $4
        WHERE id = $1 AND retired_at IS NULL
        RETURNING *
      `,
      [
        id,
        toBuffer(request.wrappedDataEncryptionKey),
        request.keyVersion,
        request.rotatedAt,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Encrypted key record rewrap failed");
    }

    return mapEncryptedKeyRecord(row);
  }

  public async retire(id: string, retiredAt: Date): Promise<void> {
    await this.database.query(
      "UPDATE encrypted_key_records SET retired_at = $2 WHERE id = $1",
      [id, retiredAt],
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
