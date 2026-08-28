export interface BackupInspection {
  readonly backupId: string;
  readonly createdAt: Date;
  readonly integrityVerified: boolean;
  readonly schemaVersion: string;
  readonly encryptedFulfillmentRecords: number;
  readonly plaintextProductKeyFields: number;
  readonly embeddedMasterKeys: number;
  readonly embeddedDatabaseCredentials: number;
  readonly operationsControlRows: number;
  readonly operationsControlEvents: number;
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

export class BackupRestoreValidationService {
  public validateBackup(inspection: BackupInspection): BackupValidationResult {
    if (
      !inspection.integrityVerified ||
      !safeReference(inspection.backupId) ||
      !safeReference(inspection.schemaVersion) ||
      !(inspection.createdAt instanceof Date) ||
      Number.isNaN(inspection.createdAt.getTime()) ||
      ![
        inspection.encryptedFulfillmentRecords,
        inspection.plaintextProductKeyFields,
        inspection.embeddedMasterKeys,
        inspection.embeddedDatabaseCredentials,
        inspection.operationsControlRows,
        inspection.operationsControlEvents,
      ].every(nonNegativeInteger)
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
    readonly restoredSchemaVersion: string;
    readonly encryptedFulfillmentRecords: number;
    readonly operationsControlRows: number;
    readonly operationsControlEvents: number;
    readonly externalMasterKeyAvailable: boolean;
  }): { readonly status: "VALID" | "FAILED"; readonly reasonCode: string } {
    const backup = this.validateBackup(input.backup);
    if (backup.status === "FAILED") return backup;
    if (
      input.restoredSchemaVersion !== input.backup.schemaVersion ||
      ![
        input.encryptedFulfillmentRecords,
        input.operationsControlRows,
        input.operationsControlEvents,
      ].every(nonNegativeInteger) ||
      input.encryptedFulfillmentRecords !==
        input.backup.encryptedFulfillmentRecords ||
      input.operationsControlRows !== input.backup.operationsControlRows ||
      input.operationsControlEvents !== input.backup.operationsControlEvents
    ) {
      return { reasonCode: "RESTORE_INTEGRITY_FAILED", status: "FAILED" };
    }
    return {
      reasonCode: input.externalMasterKeyAvailable
        ? "RESTORE_VALIDATED_EXTERNAL_KEY_AVAILABLE"
        : "RESTORE_VALIDATED_EXTERNAL_KEY_SEPARATE",
      status: "VALID",
    };
  }
}

const safeReference = (value: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);

const nonNegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;
