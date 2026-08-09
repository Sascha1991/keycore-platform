import type {
  AuditEvent,
  AuditEventPort,
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
