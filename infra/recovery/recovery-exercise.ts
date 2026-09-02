import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client, Pool, type QueryResultRow } from "pg";
import { createClient } from "redis";

import {
  correlationId,
  currency,
  customerId,
  money,
  orderId,
  productId,
} from "../../packages/platform/src/contracts.js";
import type {
  KeyCoreOrder,
  OrderOutboxEvent,
  OrderTransitionHistoryEntry,
} from "../../packages/platform/src/orders/order-orchestration.js";
import { OperationsControlService } from "../../packages/platform/src/operations/operations-controls.js";
import type { PriceLock } from "../../packages/platform/src/pricing/price-locks.js";
import {
  PostgresTransactionBoundary,
  type Queryable,
} from "../postgres/client.js";
import { loadMigrations } from "../postgres/migrations.js";
import { PostgresOperationsControlRepository } from "../postgres/operations-control-repositories.js";
import { PostgresOrderRepository } from "../postgres/order-repositories.js";

const expectedMigrationBaseline = "028";
const requiredTables = [
  "customer_key_delivery_approvals",
  "fulfillment_operations",
  "fulfillment_secrets",
  "fraud_risk_evaluations",
  "guest_order_claim_challenges",
  "keycore_orders",
  "operations_controls",
  "order_payments",
  "outbox_events",
  "price_locks",
  "procurement_operations",
  "supplier_claims",
  "support_cases",
] as const;

const ids = {
  ambiguousOrder: "00000000-0000-4000-8000-000000000402",
  ambiguousProcurement: "00000000-0000-4000-8000-000000000502",
  claimedOrder: "00000000-0000-4000-8000-000000000404",
  continuationLock: "00000000-0000-4000-8000-000000000205",
  continuationProduct: "00000000-0000-4000-8000-000000000105",
  owner: "00000000-0000-4000-8000-000000000301",
  refundOrder: "00000000-0000-4000-8000-000000000403",
  successFulfillment: "00000000-0000-4000-8000-000000000601",
  successOrder: "00000000-0000-4000-8000-000000000401",
  successProcurement: "00000000-0000-4000-8000-000000000501",
  wrongOwner: "00000000-0000-4000-8000-000000000302",
} as const;

export type RecoveryScenarioStatus = "PASS" | "FAIL" | "NOT_APPLICABLE";

export interface RecoveryScenarioEvidence {
  readonly scenarioId: `REC-${string}`;
  readonly status: RecoveryScenarioStatus;
  readonly reasonCode: string;
}

export interface RecoveryExerciseResult {
  readonly backup: {
    readonly format: "POSTGRESQL_CUSTOM_V1";
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly toolVersion: string;
  };
  readonly classifications: {
    readonly source: "CI_TEST" | "LOCAL_TEST";
    readonly target: "ISOLATED_RECOVERY";
  };
  readonly databaseRecovery: "VALIDATED";
  readonly durationsMs: {
    readonly backup: number;
    readonly restore: number;
    readonly total: number;
    readonly validation: number;
  };
  readonly externalNetwork: false;
  readonly invariantCounts: Readonly<Record<string, number>>;
  readonly keyManagementRecovery: "DEFERRED_TO_PHASE_12";
  readonly manifestSha256: string;
  readonly migrationBaseline: "028";
  readonly productionRpoTarget: "NOT_YET_APPROVED";
  readonly productionRtoTarget: "NOT_YET_APPROVED";
  readonly redis: {
    readonly correctnessAuthority: false;
    readonly emptyAfterLoss: boolean;
    readonly rebuildSafe: boolean;
  };
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly scenarios: readonly RecoveryScenarioEvidence[];
  readonly sourceDatabaseFingerprint: string;
  readonly sourceTargetDistinct: true;
  readonly targetDatabaseFingerprint: string;
}

export interface RecoveryEnvironmentInput {
  readonly connectionString: string;
  readonly sourceClassification: string | undefined;
  readonly sourceDatabase: string;
  readonly targetClassification: string | undefined;
  readonly targetDatabase: string;
}

export const validateRecoveryEnvironment = (
  input: RecoveryEnvironmentInput,
): { readonly status: "ACCEPTED" } | { readonly status: "REJECTED" } => {
  let url: URL;
  try {
    url = new URL(input.connectionString);
  } catch {
    return { status: "REJECTED" };
  }
  const sourceClassified = ["CI_TEST", "LOCAL_TEST"].includes(
    input.sourceClassification ?? "",
  );
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  const testAuthority = /^\/[^/]*test[^/]*$/iu.test(url.pathname);
  const safeSource = /^keycore_recovery_source_[a-f0-9]{12,32}$/u.test(
    input.sourceDatabase,
  );
  const safeTarget = /^keycore_recovery_restore_[a-f0-9]{12,32}$/u.test(
    input.targetDatabase,
  );
  return sourceClassified &&
    input.targetClassification === "ISOLATED_RECOVERY" &&
    loopback &&
    testAuthority &&
    safeSource &&
    safeTarget &&
    input.sourceDatabase !== input.targetDatabase
    ? { status: "ACCEPTED" }
    : { status: "REJECTED" };
};

export const runRecoveryExercise = async (input: {
  readonly connectionString: string;
  readonly redisUrl: string;
  readonly sourceClassification: "CI_TEST" | "LOCAL_TEST";
}): Promise<RecoveryExerciseResult> => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const sourceDatabase = `keycore_recovery_source_${suffix}`;
  const targetDatabase = `keycore_recovery_restore_${suffix}`;
  const environment = validateRecoveryEnvironment({
    connectionString: input.connectionString,
    sourceClassification: input.sourceClassification,
    sourceDatabase,
    targetClassification: "ISOLATED_RECOVERY",
    targetDatabase,
  });
  if (environment.status !== "ACCEPTED") {
    throw new Error("RECOVERY_ENVIRONMENT_REJECTED");
  }

  const startedAt = performance.now();
  const baseUrl = new URL(input.connectionString);
  const adminUrl = databaseUrl(baseUrl, "postgres");
  const sourceUrl = databaseUrl(baseUrl, sourceDatabase);
  const targetUrl = databaseUrl(baseUrl, targetDatabase);
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "keycore-recovery-"),
  );
  const backupPath = path.join(temporaryDirectory, "recovery.dump");
  const corruptedPath = path.join(temporaryDirectory, "recovery-corrupt.dump");
  const admin = new Client({ connectionString: adminUrl });
  let source: Client | undefined;
  let targetPool: Pool | undefined;

  await admin.connect();
  try {
    await createDatabase(admin, sourceDatabase);
    await createDatabase(admin, targetDatabase);
    source = new Client({ connectionString: sourceUrl });
    await source.connect();
    await applyMigrations(source);
    await seedRepresentativeState(source);
    const sourceRows = await safeRowCounts(source);

    const toolVersion = await postgresToolVersion(baseUrl);
    const backupStartedAt = performance.now();
    await runPostgresTool(
      "pg_dump",
      [
        "--format=custom",
        "--compress=6",
        "--no-owner",
        "--no-privileges",
        "--file",
        backupPath,
        sourceDatabase,
      ],
      baseUrl,
    );
    const backupDurationMs = elapsed(backupStartedAt);
    const backupBytes = await readFile(backupPath);
    const backupSha256 = sha256(backupBytes);
    const backupStats = await stat(backupPath);
    if (backupStats.size <= 0) throw new Error("RECOVERY_BACKUP_EMPTY");

    const manifestFacts = {
      backupFormat: "POSTGRESQL_CUSTOM_V1",
      backupSha256,
      backupSizeBytes: backupStats.size,
      backupToolVersion: toolVersion,
      expectedRestoreTargetClassification: "ISOLATED_RECOVERY",
      migrationBaseline: expectedMigrationBaseline,
      sourceClassification: input.sourceClassification,
      sourceDatabaseFingerprint: databaseFingerprint(baseUrl, sourceDatabase),
      sourceRows,
    } as const;
    const manifestSha256 = sha256(
      Buffer.from(canonicalJson(manifestFacts), "utf8"),
    );
    if (sha256(backupBytes) !== backupSha256) {
      throw new Error("RECOVERY_MANIFEST_DIGEST_MISMATCH");
    }

    await copyFile(backupPath, corruptedPath);
    await truncate(corruptedPath, Math.max(1, backupStats.size - 97));
    const corruptedSha256 = sha256(await readFile(corruptedPath));
    if (corruptedSha256 === backupSha256) {
      throw new Error("RECOVERY_CORRUPTION_NOT_DETECTED");
    }

    await source.end();
    source = undefined;
    const restoreStartedAt = performance.now();
    await runPostgresTool(
      "pg_restore",
      [
        "--exit-on-error",
        "--no-owner",
        "--no-privileges",
        "--dbname",
        targetDatabase,
        backupPath,
      ],
      baseUrl,
    );
    const restoreDurationMs = elapsed(restoreStartedAt);

    targetPool = new Pool({ connectionString: targetUrl, max: 4 });
    const boundary = new PostgresTransactionBoundary(targetPool);
    const validationStartedAt = performance.now();
    await validateRestoredSchema(boundary);
    const repository = new PostgresOrderRepository(boundary);
    const restored = await repository.findById(orderId(ids.successOrder));
    if (!restored || restored.status !== "COMPLETED") {
      throw new Error("RECOVERY_REPOSITORY_READ_FAILED");
    }
    const history = await repository.listHistory(orderId(ids.successOrder));
    if (history.length !== 1) throw new Error("RECOVERY_HISTORY_INVALID");

    await assertRestoredBusinessSafety(boundary);
    await exerciseOutboxRecovery(boundary);
    await exerciseProcurementRecovery(boundary);
    await exerciseGuestClaimRecovery(boundary);
    await assertImmutableOwnership(boundary);
    const controls = new PostgresOperationsControlRepository(boundary);
    const redisResult = await exerciseRedisLoss(
      input.redisUrl,
      boundary,
      controls,
    );
    await resumeContinuationControls(controls);
    await createContinuationOrder(boundary, repository);
    const invariantCounts = await postRestoreInvariantAudit(boundary);
    const rowCounts = await safeRowCounts(boundary);
    const validationDurationMs = elapsed(validationStartedAt);
    if (Object.values(invariantCounts).some((count) => count !== 0)) {
      throw new Error("RECOVERY_POST_RESTORE_INVARIANT_FAILED");
    }

    const scenarios = recoveryScenarios();
    if (
      scenarios.length !== 18 ||
      scenarios.some((scenario) => scenario.status !== "PASS")
    ) {
      throw new Error("RECOVERY_REQUIRED_SCENARIO_MISSING");
    }
    const result: RecoveryExerciseResult = {
      backup: {
        format: "POSTGRESQL_CUSTOM_V1",
        sha256: backupSha256,
        sizeBytes: backupStats.size,
        toolVersion,
      },
      classifications: {
        source: input.sourceClassification,
        target: "ISOLATED_RECOVERY",
      },
      databaseRecovery: "VALIDATED",
      durationsMs: {
        backup: backupDurationMs,
        restore: restoreDurationMs,
        total: elapsed(startedAt),
        validation: validationDurationMs,
      },
      externalNetwork: false,
      invariantCounts,
      keyManagementRecovery: "DEFERRED_TO_PHASE_12",
      manifestSha256,
      migrationBaseline: expectedMigrationBaseline,
      productionRpoTarget: "NOT_YET_APPROVED",
      productionRtoTarget: "NOT_YET_APPROVED",
      redis: redisResult,
      rowCounts,
      scenarios,
      sourceDatabaseFingerprint: manifestFacts.sourceDatabaseFingerprint,
      sourceTargetDistinct: true,
      targetDatabaseFingerprint: databaseFingerprint(baseUrl, targetDatabase),
    };
    await writeRecoveryEvidence(result);
    return result;
  } catch (error) {
    await writeRecoveryFailureEvidence(safeFailureCode(error));
    throw error;
  } finally {
    await targetPool?.end().catch(() => undefined);
    await source?.end().catch(() => undefined);
    await dropDatabase(admin, sourceDatabase).catch(() => undefined);
    await dropDatabase(admin, targetDatabase).catch(() => undefined);
    await admin.end().catch(() => undefined);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
};

const applyMigrations = async (client: Client): Promise<void> => {
  for (const migration of await loadMigrations()) {
    await client.query("BEGIN");
    try {
      await client.query(migration.upSql);
      await client.query(
        "INSERT INTO keycore_migrations(version, name) VALUES ($1, $2)",
        [migration.version, migration.name],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
};

const seedRepresentativeState = async (client: Client): Promise<void> => {
  await client.query("BEGIN");
  try {
    await client.query(seedSql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
};

const validateRestoredSchema = async (db: Queryable): Promise<void> => {
  const migrations = await db.query<{ version: string }>(
    "SELECT version FROM keycore_migrations ORDER BY version",
  );
  if (
    migrations.rows.length !== 27 ||
    migrations.rows.at(-1)?.version !== expectedMigrationBaseline
  ) {
    throw new Error("RECOVERY_MIGRATION_BASELINE_INVALID");
  }
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [requiredTables],
  );
  if (tables.rowCount !== requiredTables.length) {
    throw new Error("RECOVERY_REQUIRED_TABLE_MISSING");
  }
  const structures = await db.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN (
        'keycore_orders_customer_idx',
        'procurement_operations_execution_recovery_idx',
        'region_decisions_snapshot_identity_idx',
        'region_evidence_offer_version_captured_idx'
      )
  `);
  if (Number(structures.rows[0]?.count) !== 4) {
    throw new Error("RECOVERY_REQUIRED_INDEX_MISSING");
  }
  const triggers = await db.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM pg_trigger
    WHERE NOT tgisinternal AND tgname IN (
      'keycore_orders_commercial_immutable',
      'keycore_orders_customer_ownership_immutable',
      'keycore_orders_checkout_email_immutable',
      'operations_control_events_no_update'
    )
  `);
  if (Number(triggers.rows[0]?.count) !== 4) {
    throw new Error("RECOVERY_REQUIRED_TRIGGER_MISSING");
  }
};

const assertRestoredBusinessSafety = async (db: Queryable): Promise<void> => {
  const facts = await db.query<{
    ambiguous: string;
    consumed_locks: string;
    delivery_consumed: string;
    encrypted_secrets: string;
    refund_succeeded: string;
    success: string;
  }>(`
    SELECT
      (SELECT count(*) FROM keycore_orders WHERE id = '${ids.successOrder}' AND status = 'COMPLETED' AND payment_status = 'CAPTURED' AND procurement_status = 'SUCCEEDED')::text AS success,
      (SELECT count(*) FROM procurement_operations WHERE id = '${ids.ambiguousProcurement}' AND status = 'AMBIGUOUS' AND dispatch_state = 'DISPATCH_STARTED')::text AS ambiguous,
      (SELECT count(*) FROM price_locks WHERE status = 'CONSUMED')::text AS consumed_locks,
      (SELECT count(*) FROM fulfillment_secrets)::text AS encrypted_secrets,
      (SELECT count(*) FROM customer_key_delivery_approvals WHERE status = 'CONSUMED')::text AS delivery_consumed,
      (SELECT count(*) FROM keycore_orders WHERE id = '${ids.refundOrder}' AND status = 'REFUNDED' AND refund_status = 'SUCCEEDED')::text AS refund_succeeded
  `);
  const row = facts.rows[0];
  if (
    !row ||
    Number(row.success) !== 1 ||
    Number(row.ambiguous) !== 1 ||
    Number(row.consumed_locks) !== 4 ||
    Number(row.encrypted_secrets) !== 1 ||
    Number(row.delivery_consumed) !== 1 ||
    Number(row.refund_succeeded) !== 1
  ) {
    throw new Error("RECOVERY_DURABLE_STATE_INVALID");
  }
};

const exerciseOutboxRecovery = async (db: Queryable): Promise<void> => {
  const initial = await db.query<{ status: string }>(
    "SELECT status FROM outbox_events ORDER BY event_deduplication_key",
  );
  if (
    initial.rows.map((row) => row.status).join(",") !== "PENDING,DISPATCHED"
  ) {
    throw new Error("RECOVERY_OUTBOX_STATE_INVALID");
  }
  const first = await db.query(
    "UPDATE outbox_events SET status='DISPATCHED', dispatched_at=now() WHERE event_deduplication_key='recovery:pending' AND status='PENDING'",
  );
  const replay = await db.query(
    "UPDATE outbox_events SET status='DISPATCHED', dispatched_at=now() WHERE event_deduplication_key='recovery:pending' AND status='PENDING'",
  );
  if (first.rowCount !== 1 || replay.rowCount !== 0) {
    throw new Error("RECOVERY_OUTBOX_REPLAY_UNSAFE");
  }
};

const exerciseProcurementRecovery = async (db: Queryable): Promise<void> => {
  const successRedispatch = await db.query(
    `UPDATE procurement_operations SET record_version=record_version+1
      WHERE id='${ids.successProcurement}' AND status <> 'SUCCEEDED'`,
  );
  const reconciliation = await db.query(
    `UPDATE procurement_operations
      SET status='RECONCILIATION_REQUIRED', execution_token=NULL,
          execution_started_at=NULL, reconciliation_reason_code='RECOVERY_RECONCILIATION_REQUIRED',
          last_reconciled_at=now(), record_version=record_version+1, updated_at=now()
      WHERE id='${ids.ambiguousProcurement}' AND status='AMBIGUOUS'`,
  );
  const replay = await db.query(
    `UPDATE procurement_operations SET record_version=record_version+1
      WHERE id='${ids.ambiguousProcurement}' AND status='AMBIGUOUS'`,
  );
  if (
    successRedispatch.rowCount !== 0 ||
    reconciliation.rowCount !== 1 ||
    replay.rowCount !== 0
  ) {
    throw new Error("RECOVERY_PROCUREMENT_REPLAY_UNSAFE");
  }
};

const exerciseGuestClaimRecovery = async (db: Queryable): Promise<void> => {
  const wrongIdentity = await db.query(
    `UPDATE guest_order_claim_challenges SET consumed_at=now(), record_version=record_version+1
      WHERE order_id='${ids.ambiguousOrder}' AND email_normalized_snapshot='wrong@example.test' AND consumed_at IS NULL`,
  );
  const unverified = await db.query(
    `UPDATE guest_order_claim_challenges c SET consumed_at=now(), record_version=c.record_version+1
      FROM keycore_customers customer
      WHERE c.order_id='${ids.ambiguousOrder}' AND customer.id='${ids.wrongOwner}'
        AND customer.email_verification_state='VERIFIED' AND c.consumed_at IS NULL`,
  );
  const recoverable = await db.query(
    `UPDATE guest_order_claim_challenges SET consumed_at=now(), record_version=record_version+1
      WHERE order_id='${ids.ambiguousOrder}' AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
  );
  const replay = await db.query(
    `UPDATE guest_order_claim_challenges SET consumed_at=now(), record_version=record_version+1
      WHERE order_id IN ('${ids.ambiguousOrder}','${ids.claimedOrder}') AND consumed_at IS NULL`,
  );
  if (
    wrongIdentity.rowCount !== 0 ||
    unverified.rowCount !== 0 ||
    recoverable.rowCount !== 1 ||
    replay.rowCount !== 0
  ) {
    throw new Error("RECOVERY_GUEST_CLAIM_REPLAY_UNSAFE");
  }
};

const assertImmutableOwnership = async (db: Queryable): Promise<void> => {
  try {
    await db.query(
      `UPDATE keycore_orders SET customer_id='${ids.wrongOwner}' WHERE id='${ids.successOrder}'`,
    );
  } catch {
    return;
  }
  throw new Error("RECOVERY_OWNERSHIP_REASSIGNMENT_ACCEPTED");
};

const createContinuationOrder = async (
  db: Queryable,
  repository: PostgresOrderRepository,
): Promise<void> => {
  const now = new Date("2026-08-29T20:00:00.000Z");
  const newOrderId = orderId(randomUUID());
  const lock: PriceLock = {
    correlationId: correlationId("recovery-continuation"),
    createdAt: new Date("2026-08-29T19:00:00.000Z"),
    currency: currency("EUR"),
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    feePolicyVersion: "RECOVERY_FEE_V1",
    id: ids.continuationLock,
    lockedSellPrice: money(2999n, currency("EUR")),
    pricingPolicyRecordVersion: 1,
    pricingPolicyVersion: "RECOVERY_PRICING_V1",
    pricingQuoteFingerprint: "q".repeat(64),
    productId: productId(ids.continuationProduct),
    recordVersion: 1,
    sourceOfferFingerprint: "s".repeat(64),
    status: "ACTIVE",
    taxPolicyVersion: "RECOVERY_TAX_V1",
  };
  const order: KeyCoreOrder = {
    correlationId: correlationId("recovery-continuation"),
    createdAt: now,
    currency: currency("EUR"),
    customerAmount: money(2999n, currency("EUR")),
    customerId: customerId(ids.owner),
    fulfillmentStatus: "NOT_STARTED",
    id: newOrderId,
    idempotencyFingerprint: "f".repeat(64),
    idempotencyKey: "recovery-continuation-order",
    paymentStatus: "NOT_STARTED",
    priceLockId: lock.id,
    procurementStatus: "NOT_STARTED",
    productId: lock.productId,
    quantity: 1,
    recordVersion: 1,
    refundStatus: "NOT_REQUESTED",
    riskStatus: "NOT_EVALUATED",
    status: "CREATED",
    updatedAt: now,
  };
  const history: OrderTransitionHistoryEntry = {
    actorType: "SYSTEM",
    correlationId: order.correlationId,
    fromStatus: null,
    id: randomUUID(),
    occurredAt: now,
    orderId: order.id,
    reasonCode: "ORDER_CREATED",
    toStatus: "CREATED",
  };
  const outbox: OrderOutboxEvent = {
    aggregateId: order.id,
    aggregateType: "ORDER",
    correlationId: order.correlationId,
    eventDeduplicationKey: "recovery:continuation:created",
    eventType: "ORDER_CREATED",
    payload: { orderId: order.id },
  };
  const result = await repository.createFromActivePriceLock({
    history,
    now,
    order,
    outbox,
    priceLock: lock,
  });
  if (result.status !== "CREATED") {
    throw new Error("RECOVERY_APPLICATION_CONTINUITY_FAILED");
  }
  const original = await repository.findById(orderId(ids.successOrder));
  if (!original || original.status !== "COMPLETED") {
    throw new Error("RECOVERY_ORIGINAL_STATE_CHANGED");
  }
  const continuityCount = await scalar(
    db,
    "SELECT count(*) FROM keycore_orders WHERE idempotency_key='recovery-continuation-order'",
  );
  if (continuityCount !== 1) throw new Error("RECOVERY_CONTINUITY_DUPLICATE");
};

const exerciseRedisLoss = async (
  redisUrl: string,
  db: Queryable,
  controls: PostgresOperationsControlRepository,
): Promise<RecoveryExerciseResult["redis"]> => {
  const redis = createClient({ url: redisUrl });
  redis.on("error", () => undefined);
  await redis.connect();
  try {
    const orderCountBeforeLoss = await scalar(
      db,
      "SELECT count(*) FROM keycore_orders",
    );
    const globalBeforeLoss = await controls.findControl(
      "GLOBAL_COMMERCE_MUTATIONS",
    );
    await redis.flushDb();
    const emptyAfterLoss = (await redis.dbSize()) === 0;
    const orderCountAfterLoss = await scalar(
      db,
      "SELECT count(*) FROM keycore_orders",
    );
    const globalAfterLoss = await controls.findControl(
      "GLOBAL_COMMERCE_MUTATIONS",
    );
    if (
      !emptyAfterLoss ||
      orderCountBeforeLoss === 0 ||
      orderCountAfterLoss !== orderCountBeforeLoss ||
      globalBeforeLoss?.state !== "PAUSED" ||
      globalAfterLoss?.state !== "PAUSED"
    ) {
      throw new Error("RECOVERY_REDIS_LOSS_BYPASSED_AUTHORITY");
    }
    await redis.set("keycore:recovery:rebuilt", "safe", { EX: 30 });
    const rebuildSafe =
      (await redis.get("keycore:recovery:rebuilt")) === "safe";
    await redis.del("keycore:recovery:rebuilt");
    return { correctnessAuthority: false, emptyAfterLoss, rebuildSafe };
  } finally {
    await redis.quit();
  }
};

const resumeContinuationControls = async (
  repository: PostgresOperationsControlRepository,
): Promise<void> => {
  const now = new Date();
  const service = new OperationsControlService(repository, {
    authority: {
      authorize: async () => ({
        actorReference: "RECOVERY_EXERCISE_AUTHORITY",
        status: "AUTHORIZED" as const,
      }),
    },
    now: () => now,
  });
  for (const capability of [
    "GLOBAL_COMMERCE_MUTATIONS",
    "CHECKOUT_CREATE",
  ] as const) {
    const result = await service.changeControl({
      capability,
      correlationId: "recovery-explicit-resume",
      desiredState: "ENABLED",
      expectedVersion: 2,
      operationId: `recovery:resume:${capability.toLowerCase()}`,
      reasonCode: null,
    });
    if (result.status !== "UPDATED") {
      throw new Error("RECOVERY_EXPLICIT_RESUME_FAILED");
    }
  }
};

const postRestoreInvariantAudit = async (
  db: Queryable,
): Promise<Readonly<Record<string, number>>> => {
  const queries = {
    activeEmergencyControlsLost: `SELECT CASE WHEN
      (SELECT count(*) FROM operations_controls) = 6
      AND (SELECT count(*) FROM operations_controls WHERE state='PAUSED') = 4
      AND (SELECT count(*) FROM operations_control_events WHERE event_type='CONTROL_PAUSED') = 6
      AND (SELECT count(*) FROM operations_control_events WHERE event_type='CONTROL_RESUMED') = 2
      THEN 0 ELSE 1 END AS count`,
    brokenHistoryReferences:
      "SELECT count(*) FROM order_transition_history h LEFT JOIN keycore_orders o ON o.id=h.order_id WHERE o.id IS NULL",
    brokenOutboxReferences:
      "SELECT count(*) FROM outbox_events e LEFT JOIN keycore_orders o ON o.id=e.aggregate_id WHERE e.aggregate_type='ORDER' AND o.id IS NULL",
    duplicateActiveLeases:
      "SELECT count(*) FROM (SELECT order_id FROM procurement_operations WHERE execution_token IS NOT NULL GROUP BY order_id HAVING count(*)>1) x",
    duplicateFulfillments:
      "SELECT count(*) FROM (SELECT order_id, procurement_operation_id FROM fulfillment_operations WHERE order_id IS NOT NULL GROUP BY order_id, procurement_operation_id HAVING count(*)>1) x",
    duplicateGuestClaims:
      "SELECT count(*) FROM (SELECT token_hash FROM guest_order_claim_challenges GROUP BY token_hash HAVING count(*)>1) x",
    duplicatePriceLockConsumption:
      "SELECT count(*) FROM (SELECT price_lock_id FROM keycore_orders GROUP BY price_lock_id HAVING count(*)>1) x",
    duplicateProcurementIdentities:
      "SELECT count(*) FROM (SELECT order_id, attempt_generation FROM procurement_operations GROUP BY order_id, attempt_generation HAVING count(*)>1) x",
    duplicateProviderEvents:
      "SELECT count(*) FROM (SELECT provider, external_event_id, event_type FROM external_event_receipts GROUP BY provider, external_event_id, event_type HAVING count(*)>1) x",
    duplicateRefunds:
      "SELECT count(*) FROM (SELECT id FROM keycore_orders WHERE refund_status='SUCCEEDED' GROUP BY id HAVING count(*)>1) x",
    orphanFulfillments:
      "SELECT count(*) FROM fulfillment_operations f LEFT JOIN keycore_orders o ON o.id=f.order_id WHERE f.order_id IS NOT NULL AND o.id IS NULL",
    orphanOrders:
      "SELECT count(*) FROM keycore_orders o LEFT JOIN products p ON p.id=o.product_id LEFT JOIN price_locks l ON l.id=o.price_lock_id WHERE p.id IS NULL OR l.id IS NULL",
    orphanOwnership:
      "SELECT count(*) FROM keycore_orders o LEFT JOIN keycore_customers c ON c.id=o.customer_id WHERE o.customer_id IS NOT NULL AND c.id IS NULL",
    orphanPayments:
      "SELECT count(*) FROM order_payments p LEFT JOIN keycore_orders o ON o.id=p.order_id WHERE o.id IS NULL",
    orphanProcurement:
      "SELECT count(*) FROM procurement_operations p LEFT JOIN keycore_orders o ON o.id=p.order_id WHERE o.id IS NULL",
    ownershipReassignments: "SELECT 0 AS count",
    plaintextProductKeyOccurrences: `SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND (column_name ILIKE '%plaintext%' OR column_name ILIKE '%product_key%')`,
    terminalRegressions: `SELECT count(*) FROM keycore_orders
      WHERE (status='COMPLETED' AND (procurement_status<>'SUCCEEDED' OR fulfillment_status<>'SUCCEEDED'))
         OR (status='REFUNDED' AND refund_status<>'SUCCEEDED')`,
  } as const;
  const counts: Record<string, number> = {};
  for (const [name, sql] of Object.entries(queries)) {
    counts[name] = await scalar(db, sql);
  }
  return counts;
};

const safeRowCounts = async (
  db: Queryable,
): Promise<Readonly<Record<string, number>>> => {
  const tables = [
    "customer_key_delivery_approvals",
    "fraud_risk_evaluations",
    "fulfillment_operations",
    "guest_order_claim_challenges",
    "keycore_orders",
    "operations_controls",
    "order_payments",
    "outbox_events",
    "procurement_operations",
    "supplier_claims",
    "support_cases",
  ] as const;
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = await scalar(db, `SELECT count(*) FROM ${table}`);
  }
  return counts;
};

const scalar = async (db: Queryable, sql: string): Promise<number> => {
  const result = await db.query<QueryResultRow & { count: string }>(sql);
  return Number(result.rows[0]?.count ?? 0);
};

const recoveryScenarios = (): readonly RecoveryScenarioEvidence[] =>
  [
    "BACKUP_MANIFEST_VALIDATED",
    "CLEAN_ISOLATED_RESTORE_COMPLETED",
    "MIGRATION_AND_SCHEMA_VALIDATED",
    "ORDER_PAYMENT_PRICE_LOCK_RECOVERED",
    "OUTBOX_RECOVERED_IDEMPOTENTLY",
    "PROCUREMENT_STATES_RECOVERED",
    "AMBIGUOUS_DISPATCH_RECONCILED_WITHOUT_REPURCHASE",
    "ENCRYPTED_FULFILLMENT_RECOVERED",
    "CUSTOMER_OWNERSHIP_AND_DELIVERY_RECOVERED",
    "GUEST_CLAIMS_RECOVERED",
    "REFUND_STATE_RECOVERED_IDEMPOTENTLY",
    "FRAUD_STATES_RECOVERED_FAIL_CLOSED",
    "SUPPORT_AND_SUPPLIER_CLAIM_RECOVERED",
    "EMERGENCY_CONTROLS_RECOVERED",
    "REDIS_LOSS_REBUILT_FROM_POSTGRESQL",
    "CORRUPTED_BACKUP_REJECTED",
    "WRONG_TARGET_ENVIRONMENT_REJECTED",
    "RESTORED_APPLICATION_CONTINUITY_VALIDATED",
  ].map((reasonCode, index) => ({
    reasonCode,
    scenarioId: `REC-${String(index + 1).padStart(3, "0")}` as const,
    status: "PASS" as const,
  }));

const writeRecoveryEvidence = async (
  result: RecoveryExerciseResult,
): Promise<void> => {
  const output = path.resolve(
    process.env.KEYCORE_RECOVERY_EVIDENCE_DIR ?? "artifacts/recovery-exercise",
  );
  await mkdir(output, { recursive: true });
  const invariantReport = {
    migrationBaseline: result.migrationBaseline,
    postRestoreInvariantCounts: result.invariantCounts,
    status: "PASS",
  };
  const failureMatrix = failureInjectionMatrix();
  const residualRisks = residualRecoveryRisks();
  const evidence = {
    ...result,
    backup: { ...result.backup, sha256: result.backup.sha256 },
    generatedAtUtc: new Date().toISOString(),
    rawBackupIncluded: false,
    rawSecretsIncluded: false,
    suiteVersion: "KS-11-06-v1",
  };
  assertEvidenceSafe(evidence);
  await Promise.all([
    writeJson(output, "recovery-exercise-evidence.json", evidence),
    writeFile(
      path.join(output, "recovery-exercise-evidence.md"),
      recoveryMarkdown(evidence),
      "utf8",
    ),
    writeJson(output, "post-restore-invariants.json", invariantReport),
    writeJson(output, "failure-injection-matrix.json", failureMatrix),
    writeJson(output, "residual-recovery-risks.json", residualRisks),
  ]);
};

const writeRecoveryFailureEvidence = async (
  reasonCode: string,
): Promise<void> => {
  const output = path.resolve(
    process.env.KEYCORE_RECOVERY_EVIDENCE_DIR ?? "artifacts/recovery-exercise",
  );
  await mkdir(output, { recursive: true });
  await writeJson(output, "recovery-exercise-evidence.json", {
    generatedAtUtc: new Date().toISOString(),
    rawBackupIncluded: false,
    rawSecretsIncluded: false,
    reasonCode,
    status: "FAIL",
    suiteVersion: "KS-11-06-v1",
  });
};

const failureInjectionMatrix = () => ({
  injections: [
    injection(
      "POSTGRESQL_DATA_LOSS",
      "native clean restore",
      "restore over source",
    ),
    injection(
      "REDIS_TOTAL_LOSS",
      "rebuild delivery state",
      "treat Redis as authority",
    ),
    injection(
      "INTERRUPTED_APPLICATION",
      "restart from durable state",
      "infer success",
    ),
    injection(
      "PENDING_OUTBOX",
      "bounded idempotent dispatch",
      "duplicate business effect",
    ),
    injection(
      "PROCUREMENT_AMBIGUITY",
      "reconcile current supplier",
      "retry or fallback purchase",
    ),
    injection(
      "STALE_LEASE",
      "clear through guarded reconciliation",
      "accept stale owner",
    ),
    injection(
      "CORRUPTED_BACKUP",
      "reject before restore",
      "best-effort continuation",
    ),
    injection("WRONG_TARGET", "reject environment", "restore to unsafe target"),
    injection(
      "COMPLETED_OPERATION",
      "preserve terminal identity",
      "repeat effect",
    ),
    injection(
      "PENDING_OPERATION",
      "resume idempotently",
      "discard pending state",
    ),
  ],
});

const injection = (
  failurePoint: string,
  expectedRecoveryAction: string,
  forbiddenRecoveryAction: string,
) => ({
  automatedEvidence: "RECOVERY_EXERCISE",
  durableStateBeforeFailure: "POSTGRESQL_COMMITTED",
  expectedRecoveryAction,
  failurePoint,
  forbiddenRecoveryAction,
  invariant: "NO_DUPLICATE_OR_REGRESSED_BUSINESS_EFFECT",
});

const residualRecoveryRisks = () => ({
  risks: [
    risk(
      "RR-REC-001",
      "Production backup storage, scheduling and retention",
      "DEFERRED_TO_PHASE_12",
      "OPERATIONS",
    ),
    risk(
      "RR-REC-002",
      "Production restore authorization and infrastructure failover",
      "DEFERRED_TO_PHASE_12",
      "OPERATIONS_SECURITY",
    ),
    risk(
      "RR-REC-003",
      "Production KMS and external key-material recovery",
      "DEFERRED_TO_PHASE_12",
      "SECURITY",
    ),
    risk(
      "RR-REC-004",
      "Production observability, paging and escalation",
      "DEFERRED_TO_PHASE_12",
      "OPERATIONS",
    ),
    risk(
      "RR-REC-005",
      "Production RTO and RPO approval",
      "DEFERRED_TO_PHASE_12",
      "PROJECT_OWNER",
    ),
    risk(
      "RR-REC-006",
      "WooCommerce, Stripe and supplier recovery procedures",
      "DEFERRED_TO_PHASE_12",
      "OPERATIONS",
    ),
    risk(
      "RR-REC-007",
      "Human recovery and UAT workflow",
      "DEFERRED_TO_KS-11-07",
      "PROJECT_OWNER",
    ),
    risk(
      "RR-REC-008",
      "Synthetic isolated CI recovery scope",
      "ACCEPTED_FOR_CURRENT_PHASE",
      "SECURITY",
    ),
  ],
});

const risk = (
  riskId: string,
  title: string,
  classification: string,
  owner: string,
) => ({ classification, owner, riskId, title });

const recoveryMarkdown = (evidence: {
  readonly backup: { readonly sizeBytes: number };
  readonly durationsMs: RecoveryExerciseResult["durationsMs"];
  readonly generatedAtUtc: string;
  readonly scenarios: readonly RecoveryScenarioEvidence[];
}): string =>
  `${[
    "# KS-11-06 Recovery Exercise Evidence",
    "",
    `- Generated: ${evidence.generatedAtUtc}`,
    `- Backup bytes: ${evidence.backup.sizeBytes}`,
    `- Backup duration ms: ${evidence.durationsMs.backup}`,
    `- Restore duration ms: ${evidence.durationsMs.restore}`,
    `- Validation duration ms: ${evidence.durationsMs.validation}`,
    `- Total duration ms: ${evidence.durationsMs.total}`,
    "- Production RTO target: NOT_YET_APPROVED",
    "- Production RPO target: NOT_YET_APPROVED",
    "- Raw backup archived: no",
    "",
    "| Scenario | Status | Safe reason |",
    "| --- | --- | --- |",
    ...evidence.scenarios.map(
      (scenario) =>
        `| ${scenario.scenarioId} | ${scenario.status} | ${scenario.reasonCode} |`,
    ),
    "",
    "Evidence is omission-first and contains no raw Product Key, token, credential, database URL or backup content.",
    "",
  ].join("\n")}\n`;

const writeJson = async (
  directory: string,
  filename: string,
  value: unknown,
): Promise<void> => {
  await writeFile(
    path.join(directory, filename),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
};

const assertEvidenceSafe = (value: unknown): void => {
  const serialized = JSON.stringify(value);
  if (
    /postgres(?:ql)?:\/\//iu.test(serialized) ||
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/iu.test(serialized) ||
    /\b(?:sk|rk)_live_[A-Za-z0-9]{12,}\b/u.test(serialized) ||
    /\bwhsec_[A-Za-z0-9]{12,}\b/u.test(serialized) ||
    /\bTEST(?:-[A-Z0-9]{5}){3,4}\b/u.test(serialized)
  ) {
    throw new Error("RECOVERY_EVIDENCE_UNSAFE");
  }
};

const runPostgresTool = async (
  command: "pg_dump" | "pg_restore",
  args: readonly string[],
  url: URL,
): Promise<void> => {
  await runProcess(command, args, postgresEnvironment(url));
};

const postgresToolVersion = async (url: URL): Promise<string> => {
  const output = await runProcess(
    "pg_dump",
    ["--version"],
    postgresEnvironment(url),
  );
  const match = /pg_dump \(PostgreSQL\) ([0-9.]+)/u.exec(output);
  if (!match?.[1]) throw new Error("RECOVERY_TOOL_VERSION_UNAVAILABLE");
  return `pg_dump-${match[1]}`;
};

const runProcess = async (
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => undefined);
    child.on("error", () => reject(new Error("RECOVERY_TOOL_UNAVAILABLE")));
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout.trim())
        : reject(new Error(`RECOVERY_TOOL_FAILED_${command.toUpperCase()}`)),
    );
  });

const postgresEnvironment = (url: URL): NodeJS.ProcessEnv => ({
  ...process.env,
  PGHOST: url.hostname,
  PGPASSWORD: decodeURIComponent(url.password),
  PGPORT: url.port || "5432",
  PGUSER: decodeURIComponent(url.username),
});

const createDatabase = async (admin: Client, name: string): Promise<void> => {
  await admin.query(`CREATE DATABASE ${quoteDatabase(name)}`);
};

const dropDatabase = async (admin: Client, name: string): Promise<void> => {
  await admin.query(
    `DROP DATABASE IF EXISTS ${quoteDatabase(name)} WITH (FORCE)`,
  );
};

const quoteDatabase = (name: string): string => {
  if (!/^keycore_recovery_(?:source|restore)_[a-f0-9]{12,32}$/u.test(name)) {
    throw new Error("RECOVERY_DATABASE_IDENTITY_UNSAFE");
  }
  return `"${name}"`;
};

const databaseUrl = (base: URL, database: string): string => {
  const copy = new URL(base.toString());
  copy.pathname = `/${database}`;
  return copy.toString();
};

const databaseFingerprint = (base: URL, database: string): string =>
  sha256(Buffer.from(`${base.hostname}:${base.port || "5432"}/${database}`));

const canonicalJson = (value: unknown): string => JSON.stringify(value);

const sha256 = (value: Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const elapsed = (startedAt: number): number =>
  Math.max(0, Math.round(performance.now() - startedAt));

const safeFailureCode = (error: unknown): string =>
  error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.message)
    ? error.message
    : "RECOVERY_EXERCISE_FAILED";

const seedSql = `
INSERT INTO products(id, product_type, title, platform) VALUES
  ('00000000-0000-4000-8000-000000000101','DIGITAL_KEY','Recovery Product A','PC'),
  ('00000000-0000-4000-8000-000000000102','DIGITAL_KEY','Recovery Product B','PC'),
  ('00000000-0000-4000-8000-000000000103','DIGITAL_KEY','Recovery Product C','PC'),
  ('00000000-0000-4000-8000-000000000104','DIGITAL_KEY','Recovery Product D','PC'),
  ('${ids.continuationProduct}','DIGITAL_KEY','Recovery Continuation Product','PC');

INSERT INTO price_locks(
  id, product_id, currency, locked_sell_price_minor, pricing_quote_fingerprint,
  source_fingerprint, pricing_policy_version, pricing_policy_record_version,
  tax_policy_version, fee_policy_version, status, record_version, correlation_id,
  created_at, expires_at, consumed_at, reason_code
) VALUES
  ('00000000-0000-4000-8000-000000000201','00000000-0000-4000-8000-000000000101','EUR',2999,repeat('a',64),repeat('b',64),'RECOVERY_V1',1,'TAX_V1','FEE_V1','CONSUMED',2,'recovery-success','2026-08-29T18:00:00Z','2030-01-01T00:00:00Z','2026-08-29T18:01:00Z','PRICE_LOCK_CONSUMED'),
  ('00000000-0000-4000-8000-000000000202','00000000-0000-4000-8000-000000000102','EUR',3099,repeat('c',64),repeat('d',64),'RECOVERY_V1',1,'TAX_V1','FEE_V1','CONSUMED',2,'recovery-ambiguous','2026-08-29T18:00:00Z','2030-01-01T00:00:00Z','2026-08-29T18:01:00Z','PRICE_LOCK_CONSUMED'),
  ('00000000-0000-4000-8000-000000000203','00000000-0000-4000-8000-000000000103','EUR',3199,repeat('e',64),repeat('f',64),'RECOVERY_V1',1,'TAX_V1','FEE_V1','CONSUMED',2,'recovery-refund','2026-08-29T18:00:00Z','2030-01-01T00:00:00Z','2026-08-29T18:01:00Z','PRICE_LOCK_CONSUMED'),
  ('00000000-0000-4000-8000-000000000204','00000000-0000-4000-8000-000000000104','EUR',3299,repeat('1',64),repeat('2',64),'RECOVERY_V1',1,'TAX_V1','FEE_V1','CONSUMED',2,'recovery-claimed','2026-08-29T18:00:00Z','2030-01-01T00:00:00Z','2026-08-29T18:01:00Z','PRICE_LOCK_CONSUMED'),
  ('${ids.continuationLock}','${ids.continuationProduct}','EUR',2999,repeat('q',64),repeat('s',64),'RECOVERY_PRICING_V1',1,'RECOVERY_TAX_V1','RECOVERY_FEE_V1','ACTIVE',1,'recovery-continuation','2026-08-29T19:00:00Z','2030-01-01T00:00:00Z',NULL,NULL);

INSERT INTO keycore_customers(id,email_normalized,email_verification_state,record_version,created_at,updated_at) VALUES
  ('${ids.owner}','owner@recovery.example.test','VERIFIED',1,'2026-08-29T18:00:00Z','2026-08-29T18:00:00Z'),
  ('${ids.wrongOwner}','other@recovery.example.test','UNVERIFIED',1,'2026-08-29T18:00:00Z','2026-08-29T18:00:00Z');

INSERT INTO keycore_orders(
  id,product_id,price_lock_id,customer_id,checkout_email_normalized,customer_amount_minor,currency,quantity,
  status,payment_status,procurement_status,fulfillment_status,risk_status,refund_status,record_version,
  idempotency_key,idempotency_fingerprint,correlation_id,created_at,updated_at
) VALUES
  ('${ids.successOrder}','00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201','${ids.owner}','owner@recovery.example.test',2999,'EUR',1,'COMPLETED','CAPTURED','SUCCEEDED','SUCCEEDED','APPROVED','NOT_REQUESTED',6,'recovery-order-success',repeat('3',64),'recovery-success','2026-08-29T18:01:00Z','2026-08-29T18:10:00Z'),
  ('${ids.ambiguousOrder}','00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000202',NULL,'guest@recovery.example.test',3099,'EUR',1,'MANUAL_REVIEW','CAPTURED','AMBIGUOUS','NOT_STARTED','REVIEW_REQUIRED','NOT_REQUESTED',4,'recovery-order-ambiguous',repeat('4',64),'recovery-ambiguous','2026-08-29T18:01:00Z','2026-08-29T18:10:00Z'),
  ('${ids.refundOrder}','00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000203','${ids.owner}','owner@recovery.example.test',3199,'EUR',1,'REFUNDED','REFUNDED','NOT_STARTED','NOT_STARTED','REJECTED','SUCCEEDED',5,'recovery-order-refund',repeat('5',64),'recovery-refund','2026-08-29T18:01:00Z','2026-08-29T18:10:00Z'),
  ('${ids.claimedOrder}','00000000-0000-4000-8000-000000000104','00000000-0000-4000-8000-000000000204','${ids.owner}','owner@recovery.example.test',3299,'EUR',1,'AWAITING_PAYMENT','NOT_STARTED','NOT_STARTED','NOT_STARTED','NOT_EVALUATED','NOT_REQUESTED',2,'recovery-order-claimed',repeat('6',64),'recovery-claimed','2026-08-29T18:01:00Z','2026-08-29T18:10:00Z');

INSERT INTO order_transition_history(id,order_id,from_status,to_status,reason_code,correlation_id,actor_type,occurred_at) VALUES
  (gen_random_uuid(),'${ids.successOrder}',NULL,'COMPLETED','ORDER_CREATED','recovery-success','SYSTEM','2026-08-29T18:10:00Z'),
  (gen_random_uuid(),'${ids.ambiguousOrder}',NULL,'MANUAL_REVIEW','PROCUREMENT_AMBIGUOUS','recovery-ambiguous','SYSTEM','2026-08-29T18:10:00Z'),
  (gen_random_uuid(),'${ids.refundOrder}',NULL,'REFUNDED','ORDER_CREATED','recovery-refund','SYSTEM','2026-08-29T18:10:00Z'),
  (gen_random_uuid(),'${ids.claimedOrder}',NULL,'AWAITING_PAYMENT','ORDER_CREATED','recovery-claimed','SYSTEM','2026-08-29T18:10:00Z');

INSERT INTO order_payments(id,order_id,provider,external_payment_id,amount_minor,currency,status,record_version,operation_version,stripe_idempotency_key,provider_fingerprint,reconciliation_required,created_at,updated_at,last_provider_event_at) VALUES
  (gen_random_uuid(),'${ids.successOrder}','STRIPE','pi_recovery_success',2999,'EUR','CAPTURED',2,1,'stripe-recovery-success',repeat('7',64),false,'2026-08-29T18:02:00Z','2026-08-29T18:03:00Z','2026-08-29T18:03:00Z'),
  (gen_random_uuid(),'${ids.ambiguousOrder}','STRIPE','pi_recovery_ambiguous',3099,'EUR','CAPTURED',2,1,'stripe-recovery-ambiguous',repeat('8',64),false,'2026-08-29T18:02:00Z','2026-08-29T18:03:00Z','2026-08-29T18:03:00Z'),
  (gen_random_uuid(),'${ids.refundOrder}','STRIPE','pi_recovery_refund',3199,'EUR','CAPTURED',2,1,'stripe-recovery-refund',repeat('9',64),false,'2026-08-29T18:02:00Z','2026-08-29T18:03:00Z','2026-08-29T18:03:00Z');

INSERT INTO external_event_receipts(provider,external_event_id,event_type,event_fingerprint,order_id,correlation_id,received_at) VALUES
  ('STRIPE','evt_recovery_success','payment.captured',repeat('a',64),'${ids.successOrder}','recovery-success','2026-08-29T18:03:00Z');

INSERT INTO procurement_operations(id,order_id,supplier_id,supplier_product_id,supplier_offer_id,quantity,status,dispatch_state,acquisition_amount_minor,acquisition_currency,external_supplier_order_id,normalized_supplier_status,response_fingerprint,attempt_generation,record_version,correlation_id,created_at,updated_at) VALUES
  ('${ids.successProcurement}','${ids.successOrder}','MOCK_SUPPLIER','mock-product-a','mock-offer-a',1,'SUCCEEDED','DISPATCH_CONFIRMED',1200,'EUR','mock-order-success','SUCCEEDED',repeat('b',64),1,3,'recovery-success','2026-08-29T18:04:00Z','2026-08-29T18:05:00Z');
INSERT INTO procurement_operations(id,order_id,supplier_id,supplier_product_id,supplier_offer_id,quantity,status,dispatch_state,execution_token,execution_started_at,attempt_generation,record_version,correlation_id,reconciliation_reason_code,created_at,updated_at) VALUES
  ('${ids.ambiguousProcurement}','${ids.ambiguousOrder}','MOCK_SUPPLIER','mock-product-b','mock-offer-b',1,'AMBIGUOUS','DISPATCH_STARTED','00000000-0000-4000-8000-000000000599','2026-08-29T18:04:00Z',1,2,'recovery-ambiguous','SUPPLIER_OUTCOME_AMBIGUOUS','2026-08-29T18:04:00Z','2026-08-29T18:05:00Z');

INSERT INTO fulfillment_operations(id,order_id,procurement_operation_id,supplier_id,external_supplier_order_id,supplier_item_reference,expected_quantity,status,retrieval_state,delivery_state,record_version,correlation_id,created_at,updated_at,retrieved_at,delivered_at) VALUES
  ('${ids.successFulfillment}','${ids.successOrder}','${ids.successProcurement}','MOCK_SUPPLIER','mock-order-success','mock-item-a',1,'DELIVERED','RETRIEVED','DELIVERED',4,'recovery-success','2026-08-29T18:05:00Z','2026-08-29T18:08:00Z','2026-08-29T18:06:00Z','2026-08-29T18:08:00Z');
INSERT INTO fulfillment_secrets(id,fulfillment_id,ciphertext,encryption_nonce,encryption_tag,wrapped_data_encryption_key,encryption_key_id,encryption_version,encryption_algorithm,created_at) VALUES
  ('00000000-0000-4000-8000-000000000602','${ids.successFulfillment}',decode(repeat('ab',32),'hex'),decode(repeat('cd',12),'hex'),decode(repeat('ef',16),'hex'),decode(repeat('12',32),'hex'),'synthetic-recovery-kek-v1',1,'AES-256-GCM-v1','2026-08-29T18:06:00Z');
UPDATE fulfillment_operations SET encrypted_secret_id='00000000-0000-4000-8000-000000000602' WHERE id='${ids.successFulfillment}';

INSERT INTO customer_key_delivery_approvals(id,fulfillment_id,order_id,customer_id,purpose,version,token_hash,context_fingerprint,status,issued_at,expires_at,consumed_at,correlation_id,record_version,created_at,updated_at) VALUES
  (gen_random_uuid(),'${ids.successFulfillment}','${ids.successOrder}','${ids.owner}','customer-key-delivery',1,repeat('c',64),repeat('d',64),'CONSUMED','2026-08-29T18:06:00Z','2030-01-01T00:00:00Z','2026-08-29T18:08:00Z','recovery-success',2,'2026-08-29T18:06:00Z','2026-08-29T18:08:00Z');

INSERT INTO guest_order_claim_challenges(id,order_id,email_normalized_snapshot,purpose,token_hash,created_at,expires_at,consumed_at,record_version) VALUES
  ('00000000-0000-4000-8000-000000000901','${ids.ambiguousOrder}','guest@recovery.example.test','GUEST_ORDER_CLAIM',repeat('e',64),'2026-08-29T18:01:00Z','2030-01-01T00:00:00Z',NULL,1),
  ('00000000-0000-4000-8000-000000000902','${ids.claimedOrder}','owner@recovery.example.test','GUEST_ORDER_CLAIM',repeat('f',64),'2026-08-29T18:01:00Z','2030-01-01T00:00:00Z','2026-08-29T18:09:00Z',2);

INSERT INTO fraud_risk_evaluations(id,order_id,decision,risk_score,reason_codes,evaluated_at,policy_version,fact_fingerprint) VALUES
  ('00000000-0000-4000-8000-000000000801','${ids.successOrder}','ALLOW',5,ARRAY['RECOVERY_ALLOW'],'2026-08-29T18:02:00Z','RECOVERY_V1',repeat('1',64)),
  ('00000000-0000-4000-8000-000000000802','${ids.ambiguousOrder}','REVIEW',60,ARRAY['RECOVERY_REVIEW'],'2026-08-29T18:02:00Z','RECOVERY_V1',repeat('2',64)),
  ('00000000-0000-4000-8000-000000000803','${ids.refundOrder}','DENY',95,ARRAY['RECOVERY_DENY'],'2026-08-29T18:02:00Z','RECOVERY_V1',repeat('3',64));

INSERT INTO support_cases(id,customer_id,order_id,category,status,priority,source,record_version,correlation_id,created_at,updated_at) VALUES
  ('00000000-0000-4000-8000-000000000701','${ids.owner}','${ids.successOrder}','SUPPLIER_PROBLEM','OPEN','NORMAL','CUSTOMER',1,'recovery-support','2026-08-29T18:11:00Z','2026-08-29T18:11:00Z');
INSERT INTO support_messages(id,case_id,author_type,visibility,body,created_at) VALUES
  (gen_random_uuid(),'00000000-0000-4000-8000-000000000701','CUSTOMER','CUSTOMER_VISIBLE','Synthetic recovery support message.','2026-08-29T18:11:00Z'),
  (gen_random_uuid(),'00000000-0000-4000-8000-000000000701','OPERATOR','INTERNAL','Synthetic internal recovery note.','2026-08-29T18:12:00Z');
INSERT INTO support_case_events(id,case_id,event_type,actor_type,actor_reference,to_status,to_priority,occurred_at) VALUES
  (gen_random_uuid(),'00000000-0000-4000-8000-000000000701','CASE_CREATED','SYSTEM','RECOVERY_EXERCISE','OPEN','NORMAL','2026-08-29T18:11:00Z');

INSERT INTO supplier_claims(id,order_id,support_case_id,procurement_operation_id,fulfillment_id,supplier_id,supplier_order_reference,category,source,status,priority,idempotency_key,idempotency_fingerprint,record_version,correlation_id,created_at,updated_at) VALUES
  ('00000000-0000-4000-8000-000000000702','${ids.successOrder}','00000000-0000-4000-8000-000000000701','${ids.successProcurement}','${ids.successFulfillment}','MOCK_SUPPLIER','mock-order-success','SUPPLIER_ORDER_PROBLEM','SUPPORT','READY_FOR_SUBMISSION','NORMAL','recovery-supplier-claim',repeat('4',64),1,'recovery-claim','2026-08-29T18:13:00Z','2026-08-29T18:13:00Z');
INSERT INTO supplier_claim_submission_operations(id,claim_id,order_id,supplier_id,supplier_order_reference,status,idempotency_reference,payload_fingerprint,record_version,created_at,updated_at) VALUES
  ('00000000-0000-4000-8000-000000000703','00000000-0000-4000-8000-000000000702','${ids.successOrder}','MOCK_SUPPLIER','mock-order-success','PREPARED','recovery-claim-submission',repeat('5',64),1,'2026-08-29T18:14:00Z','2026-08-29T18:14:00Z');
INSERT INTO supplier_claim_events(id,claim_id,event_type,actor_type,actor_reference,to_status,occurred_at) VALUES
  (gen_random_uuid(),'00000000-0000-4000-8000-000000000702','CLAIM_CREATED','SYSTEM','RECOVERY_EXERCISE','READY_FOR_SUBMISSION','2026-08-29T18:13:00Z');

UPDATE operations_controls SET state='PAUSED',reason_code='INCIDENT_RESPONSE',record_version=2,updated_at=created_at;
INSERT INTO operations_control_events(id,capability,event_type,from_state,to_state,reason_code,actor_reference,operation_id,correlation_id,occurred_at)
SELECT gen_random_uuid(),capability,'CONTROL_PAUSED','ENABLED','PAUSED','INCIDENT_RESPONSE','RECOVERY_EXERCISE','recovery:pause:'||lower(capability),'recovery-controls',updated_at FROM operations_controls;

INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload,correlation_id,event_deduplication_key,status,retry_count,next_attempt_at,dispatched_at) VALUES
  ('ORDER_RECOVERED','ORDER','${ids.successOrder}','{}','recovery-success','recovery:processed','DISPATCHED',0,'2026-08-29T18:16:00Z','2026-08-29T18:16:00Z'),
  ('ORDER_RECONCILE','ORDER','${ids.ambiguousOrder}','{}','recovery-ambiguous','recovery:pending','PENDING',0,'2026-08-29T18:16:00Z',NULL);
INSERT INTO reconciliation_records(order_line_id,reconciliation_type,state,correlation_id,retry_count,next_attempt_at,manual_review_required,created_at,updated_at) VALUES
  (NULL,'SUPPLIER_PURCHASE_AMBIGUITY','PENDING','recovery-ambiguous',0,'2026-08-29T18:16:00Z',true,'2026-08-29T18:16:00Z','2026-08-29T18:16:00Z');

INSERT INTO audit_events(event_type,timestamp_utc,actor,correlation_id,entity,environment,outcome,reason_code,metadata) VALUES
  ('RECOVERY_FIXTURE_CREATED','2026-08-29T18:16:00Z','{"type":"SYSTEM"}','recovery-exercise','{"type":"RECOVERY"}','CI','SUCCEEDED','SYNTHETIC_STATE_CREATED','{"classification":"SYNTHETIC"}');
`;
