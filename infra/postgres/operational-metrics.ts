import type {
  OperationalMetric,
  OperationalMetricFactPort,
  OperationalMetricName,
} from "../../packages/platform/src/operations/observability.js";
import type { Queryable } from "./client.js";

interface CountRow {
  readonly label: string;
  readonly value: string;
}

export class PostgresOperationalMetricFacts implements OperationalMetricFactPort {
  public constructor(
    private readonly db: Queryable,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async collect(): Promise<readonly OperationalMetric[]> {
    const observedAt = this.now();
    const definitions = [
      [
        "catalog_sync_runs",
        "SELECT status AS label, count(*)::text AS value FROM catalog_sync_runs GROUP BY status",
      ],
      [
        "catalog_sync_age_seconds",
        "SELECT 'SUCCEEDED' AS label, floor(extract(epoch FROM (statement_timestamp() - max(completed_at))))::text AS value FROM catalog_sync_runs WHERE status = 'SUCCEEDED' HAVING max(completed_at) IS NOT NULL",
      ],
      [
        "orders_by_state",
        "SELECT status AS label, count(*)::text AS value FROM keycore_orders GROUP BY status",
      ],
      [
        "paid_order_stuck",
        "SELECT 'PENDING' AS label, count(*)::text AS value FROM keycore_orders WHERE payment_status = 'CAPTURED' AND procurement_status IN ('NOT_STARTED','PENDING','IN_PROGRESS','FAILED_RETRYABLE') AND updated_at < statement_timestamp() - interval '15 minutes' HAVING count(*) > 0",
      ],
      [
        "procurement_backlog",
        "SELECT status AS label, count(*)::text AS value FROM procurement_operations WHERE status IN ('PENDING','READY','IN_FLIGHT','FAILED_RETRYABLE') GROUP BY status",
      ],
      [
        "procurement_ambiguous",
        "SELECT status AS label, count(*)::text AS value FROM procurement_operations WHERE status IN ('AMBIGUOUS','RECONCILIATION_REQUIRED') GROUP BY status",
      ],
      [
        "fulfillment_backlog",
        "SELECT status AS label, count(*)::text AS value FROM fulfillment_operations WHERE status IN ('PENDING','READY','RETRIEVAL_IN_FLIGHT','FAILED_RETRYABLE','AMBIGUOUS','MANUAL_REVIEW_REQUIRED') GROUP BY status",
      ],
      [
        "delivery_pending",
        "SELECT status AS label, count(*)::text AS value FROM customer_key_delivery_attempts WHERE status IN ('PENDING','AUTHORIZED','DELIVERY_IN_FLIGHT','FAILED_RETRYABLE','AMBIGUOUS','MANUAL_REVIEW_REQUIRED') GROUP BY status",
      ],
      [
        "fraud_review_backlog",
        "SELECT status AS label, count(*)::text AS value FROM fraud_manual_review_cases WHERE status = 'OPEN' GROUP BY status",
      ],
      [
        "support_case_backlog",
        "SELECT status AS label, count(*)::text AS value FROM support_cases WHERE status NOT IN ('RESOLVED','CLOSED') GROUP BY status",
      ],
      [
        "supplier_claim_backlog",
        "SELECT status AS label, count(*)::text AS value FROM supplier_claims WHERE status NOT IN ('RESOLVED','CLOSED') GROUP BY status",
      ],
      [
        "outbox_backlog",
        "SELECT status AS label, count(*)::text AS value FROM outbox_events WHERE status <> 'PUBLISHED' GROUP BY status",
      ],
      [
        "reconciliation_backlog",
        "SELECT state AS label, count(*)::text AS value FROM reconciliation_records WHERE state <> 'COMPLETED' GROUP BY state",
      ],
      [
        "dead_letter_count",
        "SELECT state AS label, count(*)::text AS value FROM dead_letter_items WHERE state <> 'RESOLVED' GROUP BY state",
      ],
    ] as const satisfies readonly (readonly [OperationalMetricName, string])[];

    const metrics: OperationalMetric[] = [];
    for (const [name, sql] of definitions) {
      const result = await this.db.query<CountRow>(sql);
      for (const row of result.rows) {
        metrics.push({
          labels: { status: row.label },
          name,
          observedAt,
          value: Number.parseInt(row.value, 10),
        });
      }
    }
    return metrics;
  }
}
