import type {
  DeadLetterItem,
  DeadLetterRepository,
  DeadLetterState,
  DeadLetterWorkType,
} from "../../packages/platform/src/operations/dead-letter.js";
import type { TransactionalQueryable } from "./client.js";

interface Row {
  readonly id: string;
  readonly work_type: string;
  readonly safe_reference_id: string;
  readonly attempt_count: number;
  readonly reason_code: string;
  readonly correlation_id: string;
  readonly state: string;
  readonly first_failed_at: Date;
  readonly last_failed_at: Date;
  readonly resolved_at: Date | null;
  readonly record_version: number;
}

const columns = `id::text, work_type, safe_reference_id, attempt_count, reason_code,
  correlation_id, state, first_failed_at, last_failed_at, resolved_at, record_version`;

export class PostgresDeadLetterRepository implements DeadLetterRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async createOrIncrement(
    input: DeadLetterItem,
  ): Promise<DeadLetterItem> {
    const result = await this.db.query<Row>(
      `INSERT INTO dead_letter_items(
         id, work_type, safe_reference_id, attempt_count, reason_code, correlation_id,
         state, first_failed_at, last_failed_at, resolved_at, record_version
       ) VALUES ($1,$2,$3,$4,$5,$6,'OPEN',$7,$7,NULL,1)
       ON CONFLICT (work_type, safe_reference_id) DO UPDATE
         SET attempt_count = GREATEST(dead_letter_items.attempt_count, EXCLUDED.attempt_count),
             reason_code = EXCLUDED.reason_code,
             correlation_id = EXCLUDED.correlation_id,
             last_failed_at = EXCLUDED.last_failed_at,
             state = 'OPEN', resolved_at = NULL,
             record_version = dead_letter_items.record_version + 1
       RETURNING ${columns}`,
      [
        input.id,
        input.workType,
        input.safeReferenceId,
        input.attemptCount,
        input.reasonCode,
        input.correlationId,
        input.lastFailedAt,
      ],
    );
    return hydrate(requireRow(result.rows[0]));
  }

  public async findById(id: string): Promise<DeadLetterItem | null> {
    const result = await this.db.query<Row>(
      `SELECT ${columns} FROM dead_letter_items WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? hydrate(result.rows[0]) : null;
  }

  public claimReplay(input: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly now: Date;
  }): Promise<DeadLetterItem | null> {
    return this.transition(
      input.id,
      input.expectedVersion,
      "REPLAYING",
      input.now,
    );
  }

  public resolveReplay(input: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly now: Date;
  }): Promise<DeadLetterItem | null> {
    return this.transition(
      input.id,
      input.expectedVersion,
      "RESOLVED",
      input.now,
    );
  }

  public async releaseReplay(input: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly now: Date;
  }): Promise<DeadLetterItem | null> {
    const result = await this.db.query<Row>(
      `UPDATE dead_letter_items
          SET state = 'OPEN', attempt_count = attempt_count + 1,
              last_failed_at = $3, record_version = record_version + 1
        WHERE id = $1 AND record_version = $2 AND state = 'REPLAYING'
      RETURNING ${columns}`,
      [input.id, input.expectedVersion, input.now],
    );
    return result.rows[0] ? hydrate(result.rows[0]) : null;
  }

  private async transition(
    id: string,
    version: number,
    state: Extract<DeadLetterState, "REPLAYING" | "RESOLVED">,
    now: Date,
  ): Promise<DeadLetterItem | null> {
    const expectedState = state === "REPLAYING" ? "OPEN" : "REPLAYING";
    const result = await this.db.query<Row>(
      `UPDATE dead_letter_items
          SET state = $2, resolved_at = CASE WHEN $2 = 'RESOLVED' THEN $4 ELSE NULL END,
              record_version = record_version + 1
        WHERE id = $1 AND record_version = $3 AND state = $5
      RETURNING ${columns}`,
      [id, state, version, now, expectedState],
    );
    return result.rows[0] ? hydrate(result.rows[0]) : null;
  }
}

const hydrate = (row: Row): DeadLetterItem => ({
  attemptCount: row.attempt_count,
  correlationId: row.correlation_id,
  firstFailedAt: row.first_failed_at,
  id: row.id,
  lastFailedAt: row.last_failed_at,
  reasonCode: row.reason_code,
  recordVersion: row.record_version,
  resolvedAt: row.resolved_at,
  safeReferenceId: row.safe_reference_id,
  state: row.state as DeadLetterState,
  workType: row.work_type as DeadLetterWorkType,
});

const requireRow = (row: Row | undefined): Row => {
  if (!row) throw new Error("Dead-letter persistence failed");
  return row;
};
