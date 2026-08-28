export type OperationalMetricName =
  | "catalog_sync_runs"
  | "catalog_sync_age_seconds"
  | "orders_by_state"
  | "paid_order_stuck"
  | "procurement_backlog"
  | "procurement_ambiguous"
  | "fulfillment_backlog"
  | "delivery_pending"
  | "fraud_review_backlog"
  | "support_case_backlog"
  | "supplier_claim_backlog"
  | "outbox_backlog"
  | "reconciliation_backlog"
  | "dead_letter_count"
  | "backup_age_seconds"
  | "restore_validation_failures";

export type OperationalMetricLabel =
  "status" | "operationType" | "providerType" | "queueName" | "reasonCode";

export interface OperationalMetric {
  readonly name: OperationalMetricName;
  readonly value: number;
  readonly labels: Readonly<Partial<Record<OperationalMetricLabel, string>>>;
  readonly observedAt: Date;
}

export interface OperationalMetricFactPort {
  collect(): Promise<readonly OperationalMetric[]>;
}

const metricNames = new Set<OperationalMetricName>([
  "catalog_sync_runs",
  "catalog_sync_age_seconds",
  "orders_by_state",
  "paid_order_stuck",
  "procurement_backlog",
  "procurement_ambiguous",
  "fulfillment_backlog",
  "delivery_pending",
  "fraud_review_backlog",
  "support_case_backlog",
  "supplier_claim_backlog",
  "outbox_backlog",
  "reconciliation_backlog",
  "dead_letter_count",
  "backup_age_seconds",
  "restore_validation_failures",
]);
const labelNames = new Set<OperationalMetricLabel>([
  "status",
  "operationType",
  "providerType",
  "queueName",
  "reasonCode",
]);
const safeLabelValue = /^[A-Z][A-Z0-9_]{0,63}$/u;

export class OperationalMetricsService {
  public constructor(private readonly facts: OperationalMetricFactPort) {}

  public async collect(): Promise<readonly OperationalMetric[]> {
    const metrics = await this.facts.collect();
    return metrics.map(validateMetric);
  }
}

const validateMetric = (metric: OperationalMetric): OperationalMetric => {
  if (
    !metricNames.has(metric.name) ||
    !Number.isFinite(metric.value) ||
    metric.value < 0 ||
    !(metric.observedAt instanceof Date) ||
    Number.isNaN(metric.observedAt.getTime())
  ) {
    throw new Error("Operational metric is invalid");
  }
  for (const [key, value] of Object.entries(metric.labels)) {
    if (
      !labelNames.has(key as OperationalMetricLabel) ||
      typeof value !== "string" ||
      !safeLabelValue.test(value)
    ) {
      throw new Error("Operational metric label is not allowlisted");
    }
  }
  return Object.freeze({
    ...metric,
    labels: Object.freeze({ ...metric.labels }),
  });
};

export type OperationalLogField =
  | "component"
  | "correlationId"
  | "durationMs"
  | "event"
  | "operation"
  | "reasonCode"
  | "result";

export interface OperationalLogSink {
  write(record: Readonly<Record<OperationalLogField, string | number>>): void;
}

const operationalLogValueAllowlists = {
  component: new Set([
    "BACKUP_RESTORE",
    "CATALOG",
    "DELIVERY",
    "FULFILLMENT",
    "OPERATIONS",
    "ORDERS",
    "PAYMENTS",
    "PROCUREMENT",
    "QUEUE",
    "SUPPLIER_CLAIM",
  ]),
  event: new Set([
    "BACKUP_VALIDATED",
    "CONTROL_CHANGED",
    "DELIVERY_BLOCKED",
    "DLQ_REPLAY",
    "HEALTH_CHECK",
    "OPERATION_BLOCKED",
    "RESTORE_VALIDATED",
  ]),
  operation: new Set([
    "BACKUP_VALIDATION",
    "CHECKOUT_CREATE",
    "CUSTOMER_KEY_DELIVERY",
    "DLQ_REPLAY",
    "PROCUREMENT_CREATE",
    "RESTORE_VALIDATION",
    "SUPPLIER_CLAIM_SUBMISSION",
    "SUPPLIER_KEY_RETRIEVAL",
  ]),
  reasonCode: new Set([
    "BACKUP_INTEGRITY_FAILED",
    "BACKUP_UNSAFE",
    "OPERATIONS_CONTROL_PAUSED",
    "OPERATIONS_CONTROL_UNAVAILABLE",
    "RECONCILIATION_REQUIRED",
    "RESTORE_INTEGRITY_FAILED",
    "RESTORE_TARGET_UNSAFE",
  ]),
  result: new Set(["ALLOWED", "DEGRADED", "DENIED", "FAILED", "SUCCEEDED"]),
} as const;

export class SafeOperationalLogger {
  public constructor(private readonly sink: OperationalLogSink) {}

  public write(input: Readonly<Record<string, unknown>>): void {
    const record: Partial<Record<OperationalLogField, string | number>> = {};
    for (const field of [
      "component",
      "event",
      "operation",
      "reasonCode",
      "result",
    ] as const) {
      const value = input[field];
      if (
        typeof value === "string" &&
        operationalLogValueAllowlists[field].has(value)
      )
        record[field] = value;
    }
    if (
      typeof input.correlationId === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.correlationId)
    ) {
      record.correlationId = input.correlationId;
    }
    if (
      typeof input.durationMs === "number" &&
      Number.isFinite(input.durationMs) &&
      input.durationMs >= 0
    ) {
      record.durationMs = input.durationMs;
    }
    this.sink.write(
      Object.freeze(record) as Readonly<
        Record<OperationalLogField, string | number>
      >,
    );
  }
}

export type DependencyHealth = "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
export type ReadinessRole =
  "READ_ONLY" | "DURABLE_MUTATION" | "EXTERNAL_MUTATION" | "QUEUE_WORKER";

export interface HealthProbe {
  readonly dependency: "POSTGRESQL" | "REDIS" | "SUPPLIER" | "PAYMENT";
  check(): Promise<DependencyHealth>;
}

export interface HealthReport {
  readonly liveness: "ALIVE";
  readonly readiness: "READY" | "DEGRADED" | "UNREADY";
  readonly dependencies: Readonly<Record<string, DependencyHealth>>;
}

export class OperationalHealthService {
  public constructor(private readonly probes: readonly HealthProbe[]) {}

  public async check(role: ReadinessRole): Promise<HealthReport> {
    const dependencies: Record<string, DependencyHealth> = {};
    for (const probe of this.probes) {
      try {
        dependencies[probe.dependency] = await probe.check();
      } catch {
        dependencies[probe.dependency] = "UNAVAILABLE";
      }
    }
    const postgres = dependencies.POSTGRESQL;
    const externalUnavailable = [
      dependencies.SUPPLIER,
      dependencies.PAYMENT,
    ].includes("UNAVAILABLE");
    const readiness =
      postgres !== "HEALTHY"
        ? "UNREADY"
        : role === "QUEUE_WORKER" && dependencies.REDIS !== "HEALTHY"
          ? "UNREADY"
          : role === "EXTERNAL_MUTATION" && externalUnavailable
            ? "UNREADY"
            : Object.values(dependencies).some((state) => state !== "HEALTHY")
              ? "DEGRADED"
              : "READY";
    return {
      dependencies: Object.freeze(dependencies),
      liveness: "ALIVE",
      readiness,
    };
  }
}

export type OperationalAlertCode =
  | "PAID_ORDER_STUCK"
  | "PROCUREMENT_BACKLOG_HIGH"
  | "PROCUREMENT_AMBIGUITY_HIGH"
  | "FULFILLMENT_PENDING_TOO_LONG"
  | "SUPPLIER_OUTAGE"
  | "OUTBOX_BACKLOG_HIGH"
  | "DEAD_LETTER_PRESENT"
  | "FRAUD_REVIEW_BACKLOG_HIGH"
  | "SUPPLIER_CLAIM_AMBIGUOUS"
  | "CATALOG_SYNC_STALE"
  | "BACKUP_STALE"
  | "RESTORE_VALIDATION_FAILED";

export interface OperationalAlertDefinition {
  readonly code: OperationalAlertCode;
  readonly metric: OperationalMetricName;
  readonly threshold: number;
  readonly windowSeconds: number;
  readonly severity: "WARNING" | "CRITICAL";
  readonly summary: string;
  readonly runbook: string;
}

export const operationalAlertDefinitions: readonly OperationalAlertDefinition[] =
  [
    {
      code: "PAID_ORDER_STUCK",
      metric: "paid_order_stuck",
      threshold: 1,
      severity: "CRITICAL",
      summary: "Paid orders await procurement",
      runbook: "RB-ORDER-STUCK",
      windowSeconds: 900,
    },
    {
      code: "PROCUREMENT_BACKLOG_HIGH",
      metric: "procurement_backlog",
      threshold: 25,
      severity: "WARNING",
      summary: "Procurement backlog is high",
      runbook: "RB-SUPPLIER-OUTAGE",
      windowSeconds: 900,
    },
    {
      code: "PROCUREMENT_AMBIGUITY_HIGH",
      metric: "procurement_ambiguous",
      threshold: 1,
      severity: "CRITICAL",
      summary: "Procurement requires reconciliation",
      runbook: "RB-SUPPLIER-OUTAGE",
      windowSeconds: 0,
    },
    {
      code: "FULFILLMENT_PENDING_TOO_LONG",
      metric: "fulfillment_backlog",
      threshold: 10,
      severity: "WARNING",
      summary: "Fulfillment backlog is high",
      runbook: "RB-KEY-RETRIEVAL",
      windowSeconds: 1800,
    },
    {
      code: "SUPPLIER_OUTAGE",
      metric: "procurement_backlog",
      threshold: 50,
      severity: "CRITICAL",
      summary: "Supplier operations may be unavailable",
      runbook: "RB-SUPPLIER-OUTAGE",
      windowSeconds: 300,
    },
    {
      code: "OUTBOX_BACKLOG_HIGH",
      metric: "outbox_backlog",
      threshold: 100,
      severity: "CRITICAL",
      summary: "Outbox backlog is high",
      runbook: "RB-QUEUE-BACKLOG",
      windowSeconds: 600,
    },
    {
      code: "DEAD_LETTER_PRESENT",
      metric: "dead_letter_count",
      threshold: 1,
      severity: "WARNING",
      summary: "Dead-letter work needs review",
      runbook: "RB-DEAD-LETTER",
      windowSeconds: 0,
    },
    {
      code: "FRAUD_REVIEW_BACKLOG_HIGH",
      metric: "fraud_review_backlog",
      threshold: 25,
      severity: "WARNING",
      summary: "Fraud review backlog is high",
      runbook: "RB-FRAUD-REVIEW",
      windowSeconds: 3600,
    },
    {
      code: "SUPPLIER_CLAIM_AMBIGUOUS",
      metric: "supplier_claim_backlog",
      threshold: 1,
      severity: "CRITICAL",
      summary: "Supplier claim submission is ambiguous",
      runbook: "RB-SUPPLIER-CLAIM",
      windowSeconds: 0,
    },
    {
      code: "CATALOG_SYNC_STALE",
      metric: "catalog_sync_age_seconds",
      threshold: 86400,
      severity: "WARNING",
      summary: "Catalog synchronization is stale",
      runbook: "RB-CATALOG-SYNC",
      windowSeconds: 86400,
    },
    {
      code: "BACKUP_STALE",
      metric: "backup_age_seconds",
      threshold: 86400,
      severity: "CRITICAL",
      summary: "Backup validation is stale",
      runbook: "RB-BACKUP-RESTORE",
      windowSeconds: 86400,
    },
    {
      code: "RESTORE_VALIDATION_FAILED",
      metric: "restore_validation_failures",
      threshold: 1,
      severity: "CRITICAL",
      summary: "Restore validation failed",
      runbook: "RB-BACKUP-RESTORE",
      windowSeconds: 0,
    },
  ] as const;

export const evaluateOperationalAlerts = (
  metrics: readonly OperationalMetric[],
  definitions = operationalAlertDefinitions,
): readonly OperationalAlertDefinition[] =>
  definitions.filter((definition) =>
    metrics.some(
      (metric) =>
        metric.name === definition.metric &&
        metric.value >= definition.threshold,
    ),
  );

export type OperationalOwnerRole =
  "ENGINEERING" | "FINANCE_OPERATIONS" | "OPERATIONS" | "SECURITY";

export interface OperationalRunbookDefinition {
  readonly id: string;
  readonly ownerRole: OperationalOwnerRole;
  readonly recoveryProcedure: string;
  readonly rollbackOrSafeFallback: string;
}

export const operationalRunbookDefinitions: readonly OperationalRunbookDefinition[] =
  [
    {
      id: "RB-SUPPLIER-OUTAGE",
      ownerRole: "OPERATIONS",
      recoveryProcedure: "RECONCILE_AND_VERIFY_PROVIDER_RECOVERY",
      rollbackOrSafeFallback: "NO_AUTOMATIC_ROLLBACK_RECONCILE_FIRST",
    },
    {
      id: "RB-ORDER-STUCK",
      ownerRole: "OPERATIONS",
      recoveryProcedure: "RESTORE_DEPENDENCY_AND_REPLAY_IDEMPOTENT_WORK",
      rollbackOrSafeFallback: "PRESERVE_ORDER_TRUTH_AND_ESCALATE",
    },
    {
      id: "RB-KEY-RETRIEVAL",
      ownerRole: "SECURITY",
      recoveryProcedure: "RECONCILE_AND_VERIFY_ENCRYPTED_STATE",
      rollbackOrSafeFallback: "NO_BULK_DECRYPTION_OR_BLIND_RETRIEVAL",
    },
    {
      id: "RB-QUEUE-BACKLOG",
      ownerRole: "ENGINEERING",
      recoveryProcedure: "RESTORE_DEPENDENCIES_AND_BOUNDED_REPLAY",
      rollbackOrSafeFallback: "PRESERVE_DURABLE_OUTBOX_TRUTH",
    },
    {
      id: "RB-DEAD-LETTER",
      ownerRole: "OPERATIONS",
      recoveryProcedure: "AUTHORIZED_BOUNDED_IDEMPOTENT_REPLAY",
      rollbackOrSafeFallback: "AMBIGUOUS_WORK_RECONCILES_FIRST",
    },
    {
      id: "RB-CATALOG-SYNC",
      ownerRole: "OPERATIONS",
      recoveryProcedure: "RESTORE_READ_ONLY_IMPORT_AND_REVALIDATE",
      rollbackOrSafeFallback: "KEEP_UNCERTAIN_OFFERS_UNPUBLISHED",
    },
    {
      id: "RB-FRAUD-REVIEW",
      ownerRole: "FINANCE_OPERATIONS",
      recoveryProcedure: "RESTORE_REVIEW_CAPACITY_AND_VERIFY_CURRENT_FACTS",
      rollbackOrSafeFallback: "KEEP_UNCLEARED_ORDERS_BLOCKED",
    },
    {
      id: "RB-SUPPLIER-CLAIM",
      ownerRole: "OPERATIONS",
      recoveryProcedure: "RECONCILE_EXISTING_SUBMISSION",
      rollbackOrSafeFallback: "NO_AUTOMATIC_ROLLBACK_RECONCILE_FIRST",
    },
    {
      id: "RB-BACKUP-RESTORE",
      ownerRole: "ENGINEERING",
      recoveryProcedure: "RESTORE_ONLY_TO_ISOLATED_TARGET_AND_VALIDATE",
      rollbackOrSafeFallback: "ABANDON_DISPOSABLE_TARGET_ON_FAILURE",
    },
  ] as const;

export const validateOperationalRunbookCoverage = (
  alerts: readonly OperationalAlertDefinition[] = operationalAlertDefinitions,
  runbooks: readonly OperationalRunbookDefinition[] = operationalRunbookDefinitions,
): readonly string[] => {
  const issues: string[] = [];
  const byId = new Map(runbooks.map((runbook) => [runbook.id, runbook]));
  for (const alert of alerts.filter((item) => item.severity === "CRITICAL")) {
    const runbook = byId.get(alert.runbook);
    if (!runbook) {
      issues.push(`${alert.code}:RUNBOOK_MISSING`);
      continue;
    }
    if (!runbook.ownerRole) issues.push(`${alert.code}:OWNER_ROLE_MISSING`);
    if (!runbook.recoveryProcedure)
      issues.push(`${alert.code}:RECOVERY_MISSING`);
    if (!runbook.rollbackOrSafeFallback)
      issues.push(`${alert.code}:ROLLBACK_OR_FALLBACK_MISSING`);
  }
  return issues;
};
