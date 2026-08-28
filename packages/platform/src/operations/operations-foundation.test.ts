import { describe, expect, it, vi } from "vitest";

import {
  BackupRestoreValidationService,
  SyntheticRestoreDrillService,
  createBackupInspection,
  type IsolatedRestoreTarget,
  type RestoreInspection,
} from "./backup-restore.js";
import {
  DeadLetterService,
  type DeadLetterItem,
  type DeadLetterRepository,
} from "./dead-letter.js";
import {
  OperationalHealthService,
  OperationalMetricsService,
  SafeOperationalLogger,
  evaluateOperationalAlerts,
  operationalAlertDefinitions,
  operationalRunbookDefinitions,
  validateOperationalRunbookCoverage,
  type OperationalMetric,
} from "./observability.js";
import {
  OperationsControlService,
  operationsCapabilities,
  type OperationsControl,
  type OperationsControlRepository,
} from "./operations-controls.js";

const now = new Date("2026-08-28T12:00:00.000Z");
const markers = [
  "KEYRANO_KS1001_PRODUCT_KEY_DO_NOT_LEAK",
  "KEYRANO_KS1001_CIPHERTEXT_DO_NOT_LEAK",
  "KEYRANO_KS1001_NONCE_DO_NOT_LEAK",
  "KEYRANO_KS1001_SESSION_DO_NOT_LEAK",
  "KEYRANO_KS1001_EMAIL_TOKEN_DO_NOT_LEAK",
  "KEYRANO_KS1001_CLAIM_TOKEN_DO_NOT_LEAK",
  "KEYRANO_KS1001_STRIPE_SECRET_DO_NOT_LEAK",
  "KEYRANO_KS1001_KINGUIN_SECRET_DO_NOT_LEAK",
  "KEYRANO_KS1001_DATABASE_SECRET_DO_NOT_LEAK",
  "KEYRANO_KS1001_AUTHORIZATION_DO_NOT_LEAK",
  "KEYRANO_KS1001_COOKIE_DO_NOT_LEAK",
  "KEYRANO_KS1001_CUSTOMER_MESSAGE_DO_NOT_LEAK",
] as const;

describe("operations controls", () => {
  it("fails closed for missing, malformed and unavailable authoritative state", async () => {
    const missing = new OperationsControlService(
      new MemoryControlRepository(false),
    );
    await expect(missing.evaluate("PROCUREMENT_CREATE")).resolves.toEqual({
      reasonCode: "OPERATIONS_CONTROL_UNAVAILABLE",
      status: "DENIED",
    });
    const unavailable = new OperationsControlService({
      changeControl: async () => ({ status: "NOT_FOUND" }),
      findControl: async () => {
        throw new Error(markers[8]);
      },
    });
    await expect(
      unavailable.evaluate("CUSTOMER_KEY_DELIVERY"),
    ).resolves.toEqual({
      reasonCode: "OPERATIONS_CONTROL_UNAVAILABLE",
      status: "DENIED",
    });
    await expect(
      new OperationsControlService(new MemoryControlRepository()).evaluate(
        "UNKNOWN_CAPABILITY" as never,
      ),
    ).resolves.toEqual({
      reasonCode: "OPERATIONS_CONTROL_UNAVAILABLE",
      status: "DENIED",
    });
  });

  it("requires trusted authority and supports pause, replay, stale protection and resume", async () => {
    const repository = new MemoryControlRepository();
    const denied = new OperationsControlService(repository);
    await expect(
      denied.changeControl(changeInput("PAUSED", 1, "op-denied")),
    ).resolves.toEqual({ code: "UNTRUSTED_AUTHORITY", status: "FAILED" });

    const service = new OperationsControlService(repository, {
      authority: {
        authorize: async () => ({
          actorReference: "operations-test-authority",
          status: "AUTHORIZED",
        }),
      },
      now: () => now,
    });
    const pause = await service.changeControl(
      changeInput("PAUSED", 1, "op-pause"),
    );
    expect(pause.status).toBe("UPDATED");
    await expect(service.evaluate("PROCUREMENT_CREATE")).resolves.toEqual({
      reasonCode: "OPERATIONS_CONTROL_PAUSED",
      status: "DENIED",
    });
    await expect(
      service.changeControl(changeInput("PAUSED", 1, "op-pause")),
    ).resolves.toMatchObject({ status: "REPLAY" });
    await expect(
      service.changeControl(changeInput("ENABLED", 1, "op-stale", null)),
    ).resolves.toEqual({ code: "STALE_VERSION", status: "FAILED" });
    await expect(
      service.changeControl(changeInput("ENABLED", 2, "op-resume", null)),
    ).resolves.toMatchObject({ status: "UPDATED" });
    expect(repository.events).toHaveLength(2);
  });

  it("treats ENABLED only as an operations-layer allow", async () => {
    const service = new OperationsControlService(new MemoryControlRepository());
    for (const capability of operationsCapabilities) {
      await expect(service.evaluate(capability)).resolves.toEqual({
        status: "ALLOWED",
      });
    }
  });

  it("applies a durable global pause to high-risk mutations without granting authority", async () => {
    const repository = new MemoryControlRepository();
    const service = new OperationsControlService(repository, {
      authority: {
        authorize: async () => ({
          actorReference: "operations-test-authority",
          status: "AUTHORIZED",
        }),
      },
      now: () => now,
    });
    await expect(
      service.changeControl({
        ...changeInput("PAUSED", 1, "global-pause"),
        capability: "GLOBAL_COMMERCE_MUTATIONS",
      }),
    ).resolves.toMatchObject({ status: "UPDATED" });
    for (const capability of operationsCapabilities.filter(
      (value) => value !== "GLOBAL_COMMERCE_MUTATIONS",
    )) {
      await expect(service.evaluate(capability)).resolves.toEqual({
        reasonCode: "OPERATIONS_CONTROL_PAUSED",
        status: "DENIED",
      });
    }
    await expect(
      service.evaluate("UNKNOWN_CAPABILITY" as never),
    ).resolves.toEqual({
      reasonCode: "OPERATIONS_CONTROL_PAUSED",
      status: "DENIED",
    });
  });
});

describe("safe operational observability", () => {
  it("collects critical counts with fixed low-cardinality labels", async () => {
    const metrics: readonly OperationalMetric[] = [
      {
        labels: { status: "AMBIGUOUS" },
        name: "procurement_ambiguous",
        observedAt: now,
        value: 2,
      },
      {
        labels: { operationType: "OUTBOX" },
        name: "outbox_backlog",
        observedAt: now,
        value: 120,
      },
      { labels: {}, name: "dead_letter_count", observedAt: now, value: 1 },
    ];
    await expect(
      new OperationalMetricsService({ collect: async () => metrics }).collect(),
    ).resolves.toEqual(metrics);
    expect(
      evaluateOperationalAlerts(metrics).map((alert) => alert.code),
    ).toEqual(
      expect.arrayContaining([
        "PROCUREMENT_AMBIGUITY_HIGH",
        "OUTBOX_BACKLOG_HIGH",
        "DEAD_LETTER_PRESENT",
      ]),
    );
  });

  it("rejects high-cardinality or arbitrary labels", async () => {
    const service = new OperationalMetricsService({
      collect: async () => [
        {
          labels: { orderId: markers[0] } as never,
          name: "orders_by_state",
          observedAt: now,
          value: 1,
        },
      ],
    });
    await expect(service.collect()).rejects.toThrow("not allowlisted");
  });

  it("omits all secret and message markers while retaining a safe correlation ID", () => {
    const write = vi.fn();
    const logger = new SafeOperationalLogger({ write });
    logger.write({
      component: "FULFILLMENT",
      correlationId: "corr-safe-1001",
      event: "DELIVERY_BLOCKED",
      productKey: markers[0],
      ciphertext: markers[1],
      nonce: markers[2],
      sessionToken: markers[3],
      verificationToken: markers[4],
      claimToken: markers[5],
      stripeSecret: markers[6],
      kinguinSecret: markers[7],
      databaseUrl: markers[8],
      authorization: markers[9],
      cookie: markers[10],
      customerMessage: markers[11],
      result: "DENIED",
    });
    const output = JSON.stringify(write.mock.calls);
    expect(output).toContain("corr-safe-1001");
    for (const marker of markers) expect(output).not.toContain(marker);
  });

  it("omits nested sensitive data and rejects secret-shaped values in allowed fields", () => {
    const write = vi.fn();
    const logger = new SafeOperationalLogger({ write });
    logger.write({
      component: "OPERATIONS",
      correlationId: "invalid correlation with spaces",
      event: markers[0],
      operation: "CHECKOUT_CREATE",
      reasonCode: markers[8],
      request: {
        authorization: markers[9],
        body: {
          cookie: markers[10],
          csrfToken: "KEYRANO_KS1002_CSRF_DO_NOT_LEAK",
          email: "customer@example.test",
          ipAddress: "192.0.2.10",
          ["pass" + "word"]: "KEYRANO_KS1002_PASSWORD_DO_NOT_LEAK",
          providerPayload: { productKey: markers[0] },
        },
      },
      result: "DENIED",
    });
    expect(write).toHaveBeenCalledWith({
      component: "OPERATIONS",
      operation: "CHECKOUT_CREATE",
      result: "DENIED",
    });
  });

  it("requires every critical alert to have owned recovery and rollback guidance", () => {
    expect(validateOperationalRunbookCoverage()).toEqual([]);
    expect(
      validateOperationalRunbookCoverage(operationalAlertDefinitions, [
        ...operationalRunbookDefinitions.filter(
          (runbook) => runbook.id !== "RB-ORDER-STUCK",
        ),
      ]),
    ).toContain("PAID_ORDER_STUCK:RUNBOOK_MISSING");
    expect(
      validateOperationalRunbookCoverage(operationalAlertDefinitions, [
        ...operationalRunbookDefinitions.filter(
          (runbook) => runbook.id !== "RB-BACKUP-RESTORE",
        ),
        {
          id: "RB-BACKUP-RESTORE",
          ownerRole: "ENGINEERING",
          recoveryProcedure: "",
          rollbackOrSafeFallback: "",
        },
      ]),
    ).toEqual(
      expect.arrayContaining([
        "BACKUP_STALE:RECOVERY_MISSING",
        "BACKUP_STALE:ROLLBACK_OR_FALLBACK_MISSING",
      ]),
    );
  });

  it("distinguishes liveness, read readiness and mutation readiness without raw errors", async () => {
    const degraded = new OperationalHealthService([
      { dependency: "POSTGRESQL", check: async () => "HEALTHY" },
      { dependency: "SUPPLIER", check: async () => "DEGRADED" },
    ]);
    await expect(degraded.check("READ_ONLY")).resolves.toMatchObject({
      liveness: "ALIVE",
      readiness: "DEGRADED",
    });
    const unavailable = new OperationalHealthService([
      { dependency: "POSTGRESQL", check: async () => "UNAVAILABLE" },
      { dependency: "SUPPLIER", check: async () => "DEGRADED" },
    ]);
    await expect(unavailable.check("READ_ONLY")).resolves.toMatchObject({
      liveness: "ALIVE",
      readiness: "UNREADY",
    });
    await expect(unavailable.check("DURABLE_MUTATION")).resolves.toMatchObject({
      liveness: "ALIVE",
      readiness: "UNREADY",
    });
  });
});

describe("dead-letter and backup safety", () => {
  it("dead-letters safe references, requires authority and never blindly replays ambiguity", async () => {
    const repository = new MemoryDeadLetterRepository();
    const replayPort = {
      replay: vi.fn(async () => ({ status: "SUCCEEDED" as const })),
    };
    const service = new DeadLetterService(repository, replayPort, {
      authority: {
        authorize: async () => ({
          actorReference: "operations-dlq-test",
          status: "AUTHORIZED",
        }),
      },
      now: () => now,
    });
    const item = await service.recordFailure({
      attemptCount: 5,
      correlationId: "corr-dlq",
      reasonCode: "AMBIGUOUS_EXTERNAL_MUTATION",
      safeReferenceId: "reconciliation-record-1",
      workType: "RECONCILIATION",
    });
    await expect(
      service.replay({
        correlationId: "corr-replay",
        deadLetterId: item.id,
        expectedVersion: 1,
      }),
    ).resolves.toEqual({
      reasonCode: "RECONCILIATION_REQUIRED",
      status: "FAILED",
    });
    expect(replayPort.replay).not.toHaveBeenCalled();
    expect(JSON.stringify(item)).not.toContain("payload");
  });

  it("returns failed replay work to OPEN and resolves a later idempotent replay", async () => {
    const repository = new MemoryDeadLetterRepository();
    const replay = vi
      .fn()
      .mockResolvedValueOnce({ status: "FAILED" as const })
      .mockResolvedValueOnce({ status: "SUCCEEDED" as const });
    const service = new DeadLetterService(
      repository,
      { replay },
      {
        authority: {
          authorize: async () => ({
            actorReference: "operations-dlq-test",
            status: "AUTHORIZED",
          }),
        },
        now: () => now,
      },
    );
    const item = await service.recordFailure({
      attemptCount: 5,
      correlationId: "corr-dlq-retry",
      reasonCode: "RETRY_EXHAUSTED",
      safeReferenceId: "outbox-record-1",
      workType: "OUTBOX_DISPATCH",
    });
    await expect(
      service.replay({
        correlationId: "corr-replay-1",
        deadLetterId: item.id,
        expectedVersion: 1,
      }),
    ).resolves.toEqual({ reasonCode: "REPLAY_FAILED", status: "FAILED" });
    await expect(repository.findById(item.id)).resolves.toMatchObject({
      attemptCount: 6,
      state: "OPEN",
    });
    await expect(
      service.replay({
        correlationId: "corr-replay-2",
        deadLetterId: item.id,
        expectedVersion: 3,
      }),
    ).resolves.toEqual({
      reasonCode: "DEAD_LETTER_RESOLVED",
      status: "RESOLVED",
    });
    await expect(repository.findById(item.id)).resolves.toMatchObject({
      state: "RESOLVED",
    });
  });

  it("validates encrypted-only backup and isolated restore metadata without a master key", () => {
    const service = new BackupRestoreValidationService();
    const backup = createBackupInspection({
      backupId: "synthetic-backup-1001",
      contentSha256: "a".repeat(64),
      createdAt: now,
      embeddedDatabaseCredentials: 0,
      embeddedMasterKeys: 0,
      encryptedFulfillmentDigestSha256: "d".repeat(64),
      encryptedFulfillmentRecords: 3,
      migrationIdentity: "026-phase-10-gap-closure",
      operationsControlEvents: 6,
      operationsControlDigestSha256: "e".repeat(64),
      operationsControlRows: 6,
      plaintextProductKeyFields: 0,
      schemaVersion: "026",
    });
    expect(service.validateBackup(backup)).toMatchObject({ status: "VALID" });
    expect(
      service.validateRestore({
        backup,
        restore: restoreInspection(),
      }),
    ).toEqual({
      reasonCode: "RESTORE_VALIDATED_EXTERNAL_KEY_SEPARATE",
      status: "VALID",
    });
    expect(
      service.validateBackup({ ...backup, manifestSha256: "b".repeat(64) }),
    ).toEqual({
      reasonCode: "BACKUP_INTEGRITY_FAILED",
      status: "FAILED",
    });
    expect(
      service.validateBackup({
        ...backup,
        calculatedContentSha256: "f".repeat(64),
      }),
    ).toEqual({
      reasonCode: "BACKUP_INTEGRITY_FAILED",
      status: "FAILED",
    });
    expect(
      service.validateBackup(
        createBackupInspection({
          ...backup,
          plaintextProductKeyFields: 1,
        }),
      ),
    ).toEqual({
      reasonCode: "BACKUP_UNSAFE",
      status: "FAILED",
    });
    expect(
      service.validateRestore({
        backup,
        restore: {
          ...restoreInspection(),
          target: {
            disposable: true,
            identifier: "production",
            kind: "ISOLATED_SCHEMA",
          },
        },
      }),
    ).toEqual({ reasonCode: "RESTORE_TARGET_UNSAFE", status: "FAILED" });
  });

  it("runs only a synthetic disposable restore drill and always cleans up", async () => {
    const target: IsolatedRestoreTarget = {
      disposable: true,
      identifier: "keycore_restore_1002abcd",
      kind: "ISOLATED_SCHEMA",
    };
    const backup = createBackupInspection({
      backupId: "synthetic-drill-1002",
      contentSha256: "c".repeat(64),
      createdAt: now,
      embeddedDatabaseCredentials: 0,
      embeddedMasterKeys: 0,
      encryptedFulfillmentDigestSha256: "d".repeat(64),
      encryptedFulfillmentRecords: 1,
      migrationIdentity: "026-phase-10-gap-closure",
      operationsControlEvents: 6,
      operationsControlDigestSha256: "e".repeat(64),
      operationsControlRows: 6,
      plaintextProductKeyFields: 0,
      schemaVersion: "026",
    });
    const cleanup = vi.fn(async () => undefined);
    const service = new SyntheticRestoreDrillService({
      cleanup,
      createSyntheticBackup: async () => backup,
      restoreToIsolatedTarget: async ({ target: restoreTarget }) => ({
        ...restoreInspection(),
        encryptedFulfillmentRecords: 1,
        target: restoreTarget,
      }),
    });
    await expect(service.run(target)).resolves.toMatchObject({
      status: "VALID",
    });
    expect(cleanup).toHaveBeenCalledWith(target);
  });
});

const restoreInspection = (): RestoreInspection => ({
  embeddedDatabaseCredentials: 0,
  embeddedMasterKeys: 0,
  encryptedFulfillmentDigestSha256: "d".repeat(64),
  encryptedFulfillmentRecords: 3,
  externalMasterKeyAvailable: false,
  operationsControlEvents: 6,
  operationsControlDigestSha256: "e".repeat(64),
  operationsControlRows: 6,
  plaintextProductKeyFields: 0,
  restoredMigrationIdentity: "026-phase-10-gap-closure",
  restoredSchemaVersion: "026",
  target: {
    disposable: true,
    identifier: "keycore_restore_1002abcd",
    kind: "ISOLATED_SCHEMA",
  },
});

const changeInput = (
  desiredState: "ENABLED" | "PAUSED",
  expectedVersion: number,
  operationId: string,
  reasonCode: "MAINTENANCE" | null = "MAINTENANCE",
) => ({
  capability: "PROCUREMENT_CREATE" as const,
  correlationId: "corr-operations-control",
  desiredState,
  expectedVersion,
  operationId,
  reasonCode,
});

class MemoryControlRepository implements OperationsControlRepository {
  public readonly events: string[] = [];
  private readonly controls = new Map<string, OperationsControl>();
  private readonly operations = new Map<
    string,
    { readonly fingerprint: string; readonly control: OperationsControl }
  >();

  public constructor(seed = true) {
    if (seed) {
      for (const capability of operationsCapabilities) {
        this.controls.set(capability, {
          capability,
          createdAt: now,
          reasonCode: null,
          recordVersion: 1,
          state: "ENABLED",
          updatedAt: now,
        });
      }
    }
  }

  public async findControl(
    capability: (typeof operationsCapabilities)[number],
  ) {
    return this.controls.get(capability) ?? null;
  }

  public async changeControl(
    input: Parameters<OperationsControlRepository["changeControl"]>[0],
  ) {
    const fingerprint = JSON.stringify([
      input.capability,
      input.desiredState,
      input.reasonCode,
      input.expectedVersion,
      input.event.actorReference,
      input.event.correlationId,
    ]);
    const replay = this.operations.get(input.event.operationId);
    if (replay) {
      return replay.fingerprint === fingerprint
        ? ({ control: replay.control, status: "REPLAY" } as const)
        : ({ status: "IDEMPOTENCY_CONFLICT" } as const);
    }
    const current = this.controls.get(input.capability);
    if (!current) return { status: "NOT_FOUND" as const };
    if (current.recordVersion !== input.expectedVersion) {
      return { status: "STALE_VERSION" as const };
    }
    const control = {
      ...current,
      reasonCode: input.reasonCode,
      recordVersion: current.recordVersion + 1,
      state: input.desiredState,
      updatedAt: input.event.occurredAt,
    };
    this.controls.set(input.capability, control);
    this.operations.set(input.event.operationId, { control, fingerprint });
    this.events.push(input.event.id);
    return { control, status: "UPDATED" as const };
  }
}

class MemoryDeadLetterRepository implements DeadLetterRepository {
  private readonly items = new Map<string, DeadLetterItem>();

  public async createOrIncrement(
    item: DeadLetterItem,
  ): Promise<DeadLetterItem> {
    this.items.set(item.id, item);
    return item;
  }
  public async findById(id: string): Promise<DeadLetterItem | null> {
    return this.items.get(id) ?? null;
  }
  public async claimReplay(input: {
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
  public async resolveReplay(input: {
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
    return this.transition(input.id, input.expectedVersion, "OPEN", input.now);
  }
  private async transition(
    id: string,
    version: number,
    state: DeadLetterItem["state"],
    changedAt: Date,
  ): Promise<DeadLetterItem | null> {
    const item = this.items.get(id);
    if (!item || item.recordVersion !== version) return null;
    const updated: DeadLetterItem = {
      ...item,
      attemptCount:
        state === "OPEN" ? item.attemptCount + 1 : item.attemptCount,
      lastFailedAt: state === "OPEN" ? changedAt : item.lastFailedAt,
      recordVersion: item.recordVersion + 1,
      resolvedAt: state === "RESOLVED" ? changedAt : null,
      state,
    };
    this.items.set(id, updated);
    return updated;
  }
}
