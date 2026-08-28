import { createHash } from "node:crypto";

export interface BackupManifestFacts {
  readonly backupId: string;
  readonly createdAt: Date;
  readonly schemaVersion: string;
  readonly migrationIdentity: string;
  readonly contentSha256: string;
  readonly encryptedFulfillmentRecords: number;
  readonly plaintextProductKeyFields: number;
  readonly embeddedMasterKeys: number;
  readonly embeddedDatabaseCredentials: number;
  readonly operationsControlRows: number;
  readonly operationsControlEvents: number;
  readonly operationsControlDigestSha256: string;
  readonly encryptedFulfillmentDigestSha256: string;
}

export interface BackupInspection extends BackupManifestFacts {
  readonly manifestSha256: string;
  readonly calculatedContentSha256: string;
}

export interface IsolatedRestoreTarget {
  readonly kind: "ISOLATED_SCHEMA";
  readonly identifier: string;
  readonly disposable: true;
}

export interface RestoreInspection {
  readonly target: IsolatedRestoreTarget;
  readonly restoredSchemaVersion: string;
  readonly restoredMigrationIdentity: string;
  readonly encryptedFulfillmentRecords: number;
  readonly plaintextProductKeyFields: number;
  readonly embeddedMasterKeys: number;
  readonly embeddedDatabaseCredentials: number;
  readonly operationsControlRows: number;
  readonly operationsControlEvents: number;
  readonly operationsControlDigestSha256: string;
  readonly encryptedFulfillmentDigestSha256: string;
  readonly externalMasterKeyAvailable: boolean;
}

export type BackupValidationResult =
  | {
      readonly status: "VALID";
      readonly backupId: string;
      readonly schemaVersion: string;
    }
  | {
      readonly status: "FAILED";
      readonly reasonCode: "BACKUP_UNSAFE" | "BACKUP_INTEGRITY_FAILED";
    };

export type RestoreValidationResult =
  | {
      readonly status: "VALID";
      readonly reasonCode:
        | "RESTORE_VALIDATED_EXTERNAL_KEY_AVAILABLE"
        | "RESTORE_VALIDATED_EXTERNAL_KEY_SEPARATE";
    }
  | {
      readonly status: "FAILED";
      readonly reasonCode:
        | "BACKUP_UNSAFE"
        | "BACKUP_INTEGRITY_FAILED"
        | "RESTORE_INTEGRITY_FAILED"
        | "RESTORE_TARGET_UNSAFE";
    };

export const createBackupInspection = (
  facts: BackupManifestFacts,
): BackupInspection => ({
  ...facts,
  calculatedContentSha256: facts.contentSha256,
  manifestSha256: manifestDigest(facts),
});

export class BackupRestoreValidationService {
  public validateBackup(inspection: BackupInspection): BackupValidationResult {
    if (
      !safeReference(inspection.backupId) ||
      !safeReference(inspection.schemaVersion) ||
      !safeReference(inspection.migrationIdentity) ||
      !sha256.test(inspection.calculatedContentSha256) ||
      !sha256.test(inspection.contentSha256) ||
      !sha256.test(inspection.encryptedFulfillmentDigestSha256) ||
      !sha256.test(inspection.manifestSha256) ||
      !sha256.test(inspection.operationsControlDigestSha256) ||
      !(inspection.createdAt instanceof Date) ||
      Number.isNaN(inspection.createdAt.getTime()) ||
      ![
        inspection.encryptedFulfillmentRecords,
        inspection.plaintextProductKeyFields,
        inspection.embeddedMasterKeys,
        inspection.embeddedDatabaseCredentials,
        inspection.operationsControlRows,
        inspection.operationsControlEvents,
      ].every(nonNegativeInteger) ||
      inspection.calculatedContentSha256 !== inspection.contentSha256 ||
      inspection.manifestSha256 !== manifestDigest(inspection)
    ) {
      return { reasonCode: "BACKUP_INTEGRITY_FAILED", status: "FAILED" };
    }
    if (
      inspection.plaintextProductKeyFields !== 0 ||
      inspection.embeddedMasterKeys !== 0 ||
      inspection.embeddedDatabaseCredentials !== 0
    ) {
      return { reasonCode: "BACKUP_UNSAFE", status: "FAILED" };
    }
    return {
      backupId: inspection.backupId,
      schemaVersion: inspection.schemaVersion,
      status: "VALID",
    };
  }

  public validateRestore(input: {
    readonly backup: BackupInspection;
    readonly restore: RestoreInspection;
  }): RestoreValidationResult {
    const backup = this.validateBackup(input.backup);
    if (backup.status === "FAILED") return backup;
    if (!isIsolatedTarget(input.restore.target)) {
      return { reasonCode: "RESTORE_TARGET_UNSAFE", status: "FAILED" };
    }
    if (
      input.restore.restoredSchemaVersion !== input.backup.schemaVersion ||
      input.restore.restoredMigrationIdentity !==
        input.backup.migrationIdentity ||
      ![
        input.restore.encryptedFulfillmentRecords,
        input.restore.plaintextProductKeyFields,
        input.restore.embeddedMasterKeys,
        input.restore.embeddedDatabaseCredentials,
        input.restore.operationsControlRows,
        input.restore.operationsControlEvents,
      ].every(nonNegativeInteger) ||
      input.restore.encryptedFulfillmentRecords !==
        input.backup.encryptedFulfillmentRecords ||
      input.restore.operationsControlRows !==
        input.backup.operationsControlRows ||
      input.restore.operationsControlEvents !==
        input.backup.operationsControlEvents ||
      input.restore.operationsControlDigestSha256 !==
        input.backup.operationsControlDigestSha256 ||
      input.restore.encryptedFulfillmentDigestSha256 !==
        input.backup.encryptedFulfillmentDigestSha256 ||
      input.restore.plaintextProductKeyFields !== 0 ||
      input.restore.embeddedMasterKeys !== 0 ||
      input.restore.embeddedDatabaseCredentials !== 0
    ) {
      return { reasonCode: "RESTORE_INTEGRITY_FAILED", status: "FAILED" };
    }
    return {
      reasonCode: input.restore.externalMasterKeyAvailable
        ? "RESTORE_VALIDATED_EXTERNAL_KEY_AVAILABLE"
        : "RESTORE_VALIDATED_EXTERNAL_KEY_SEPARATE",
      status: "VALID",
    };
  }
}

export interface SyntheticRestoreDrillPort {
  createSyntheticBackup(): Promise<BackupInspection>;
  restoreToIsolatedTarget(input: {
    readonly backup: BackupInspection;
    readonly target: IsolatedRestoreTarget;
  }): Promise<RestoreInspection>;
  cleanup(target: IsolatedRestoreTarget): Promise<void>;
}

export class SyntheticRestoreDrillService {
  public constructor(
    private readonly port: SyntheticRestoreDrillPort,
    private readonly validator = new BackupRestoreValidationService(),
  ) {}

  public async run(
    target: IsolatedRestoreTarget,
  ): Promise<RestoreValidationResult> {
    if (!isIsolatedTarget(target)) {
      return { reasonCode: "RESTORE_TARGET_UNSAFE", status: "FAILED" };
    }
    try {
      const backup = await this.port.createSyntheticBackup();
      const backupResult = this.validator.validateBackup(backup);
      if (backupResult.status === "FAILED") return backupResult;
      const restore = await this.port.restoreToIsolatedTarget({
        backup,
        target,
      });
      return this.validator.validateRestore({ backup, restore });
    } finally {
      await this.port.cleanup(target);
    }
  }
}

const isIsolatedTarget = (target: IsolatedRestoreTarget): boolean =>
  target.kind === "ISOLATED_SCHEMA" &&
  target.disposable === true &&
  /^keycore_restore_[a-z0-9]{8,64}$/u.test(target.identifier);

const manifestDigest = (facts: BackupManifestFacts): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        backupId: facts.backupId,
        contentSha256: facts.contentSha256,
        createdAt: facts.createdAt.toISOString(),
        embeddedDatabaseCredentials: facts.embeddedDatabaseCredentials,
        embeddedMasterKeys: facts.embeddedMasterKeys,
        encryptedFulfillmentDigestSha256:
          facts.encryptedFulfillmentDigestSha256,
        encryptedFulfillmentRecords: facts.encryptedFulfillmentRecords,
        migrationIdentity: facts.migrationIdentity,
        operationsControlEvents: facts.operationsControlEvents,
        operationsControlDigestSha256: facts.operationsControlDigestSha256,
        operationsControlRows: facts.operationsControlRows,
        plaintextProductKeyFields: facts.plaintextProductKeyFields,
        schemaVersion: facts.schemaVersion,
      }),
    )
    .digest("hex");

const safeReference = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);

const sha256 = /^[a-f0-9]{64}$/u;

const nonNegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;
