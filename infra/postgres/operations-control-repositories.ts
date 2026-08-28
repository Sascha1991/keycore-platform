import type {
  OperationsCapability,
  OperationsControl,
  OperationsControlEvent,
  OperationsControlReasonCode,
  OperationsControlRepository,
  OperationsControlState,
} from "../../packages/platform/src/operations/operations-controls.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface ControlRow {
  readonly capability: string;
  readonly state: string;
  readonly reason_code: string | null;
  readonly record_version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface EventRow {
  readonly capability: string;
  readonly from_state: string;
  readonly to_state: string;
  readonly reason_code: string | null;
  readonly actor_reference: string;
  readonly correlation_id: string;
}

export class PostgresOperationsControlRepository implements OperationsControlRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async findControl(
    capability: OperationsCapability,
  ): Promise<OperationsControl | null> {
    const result = await this.db.query<ControlRow>(
      `SELECT capability, state, reason_code, record_version, created_at, updated_at
         FROM operations_controls
        WHERE capability = $1`,
      [capability],
    );
    return result.rows[0] ? hydrateControl(result.rows[0]) : null;
  }

  public async changeControl(input: {
    readonly capability: OperationsCapability;
    readonly desiredState: OperationsControlState;
    readonly reasonCode: OperationsControlReasonCode | null;
    readonly expectedVersion: number;
    readonly event: OperationsControlEvent;
  }): Promise<
    | {
        readonly status: "UPDATED" | "REPLAY";
        readonly control: OperationsControl;
      }
    | {
        readonly status: "STALE_VERSION" | "IDEMPOTENCY_CONFLICT" | "NOT_FOUND";
      }
  > {
    return this.db.transaction(async (client) => {
      const replay = await findEventByOperation(
        client,
        input.event.operationId,
      );
      if (replay) {
        const control = await findControl(client, input.capability);
        if (
          control &&
          replay.capability === input.capability &&
          replay.from_state === input.event.fromState &&
          replay.to_state === input.desiredState &&
          replay.reason_code === input.reasonCode &&
          replay.actor_reference === input.event.actorReference &&
          replay.correlation_id === input.event.correlationId
        ) {
          return { control, status: "REPLAY" as const };
        }
        return { status: "IDEMPOTENCY_CONFLICT" as const };
      }

      const current = await findControl(client, input.capability);
      if (!current) return { status: "NOT_FOUND" as const };
      if (current.recordVersion !== input.expectedVersion) {
        return { status: "STALE_VERSION" as const };
      }
      if (current.state === input.desiredState) {
        return { status: "IDEMPOTENCY_CONFLICT" as const };
      }

      const updated = await client.query<ControlRow>(
        `UPDATE operations_controls
            SET state = $2,
                reason_code = $3,
                record_version = record_version + 1,
                updated_at = $4
          WHERE capability = $1
            AND record_version = $5
        RETURNING capability, state, reason_code, record_version, created_at, updated_at`,
        [
          input.capability,
          input.desiredState,
          input.reasonCode,
          input.event.occurredAt,
          input.expectedVersion,
        ],
      );
      const row = updated.rows[0];
      if (!row) return { status: "STALE_VERSION" as const };
      await client.query(
        `INSERT INTO operations_control_events(
           id, capability, event_type, from_state, to_state, reason_code,
           actor_reference, operation_id, correlation_id, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          input.event.id,
          input.capability,
          input.event.eventType,
          input.event.fromState,
          input.event.toState,
          input.reasonCode,
          input.event.actorReference,
          input.event.operationId,
          input.event.correlationId,
          input.event.occurredAt,
        ],
      );
      return { control: hydrateControl(row), status: "UPDATED" as const };
    });
  }
}

const findControl = async (
  client: Queryable,
  capability: OperationsCapability,
): Promise<OperationsControl | null> => {
  const result = await client.query<ControlRow>(
    `SELECT capability, state, reason_code, record_version, created_at, updated_at
       FROM operations_controls
      WHERE capability = $1
      FOR UPDATE`,
    [capability],
  );
  return result.rows[0] ? hydrateControl(result.rows[0]) : null;
};

const findEventByOperation = async (
  client: Queryable,
  operationId: string,
): Promise<EventRow | null> => {
  const result = await client.query<EventRow>(
    `SELECT capability, from_state, to_state, reason_code, actor_reference, correlation_id
       FROM operations_control_events
      WHERE operation_id = $1`,
    [operationId],
  );
  return result.rows[0] ?? null;
};

const hydrateControl = (row: ControlRow): OperationsControl => ({
  capability: row.capability as OperationsCapability,
  createdAt: row.created_at,
  reasonCode: row.reason_code as OperationsControlReasonCode | null,
  recordVersion: row.record_version,
  state: row.state as OperationsControlState,
  updatedAt: row.updated_at,
});
