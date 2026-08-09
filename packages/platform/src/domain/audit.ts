import type { CorrelationId } from "./identifiers.js";

export const auditEventTypes = [
  "SECURITY",
  "FINANCIAL",
  "ADMIN",
  "SUPPLIER",
  "REFUND",
  "KEY_REVEAL",
  "HEALTH",
] as const;

export type AuditEventType = (typeof auditEventTypes)[number];

export const auditOutcomes = ["SUCCEEDED", "FAILED", "DENIED"] as const;

export type AuditOutcome = (typeof auditOutcomes)[number];

export type AuditMetadataValue = string | number | boolean | null;

export type AuditMetadata = Readonly<Record<string, AuditMetadataValue>>;

export interface AuditActor {
  readonly type: "CUSTOMER" | "ADMIN" | "SYSTEM" | "SUPPLIER";
  readonly id: string;
}

export interface AuditEntity {
  readonly type: string;
  readonly id: string;
}

export interface AuditEvent {
  readonly uuid: string;
  readonly eventType: AuditEventType;
  readonly timestampUtc: Date;
  readonly actor: AuditActor;
  readonly correlationId: CorrelationId;
  readonly entity: AuditEntity;
  readonly environment: "LOCAL" | "CI" | "STAGING" | "PRODUCTION";
  readonly outcome: AuditOutcome;
  readonly reasonCode: string;
  readonly metadata: AuditMetadata;
}

const forbiddenMetadataKeys = [
  ["product", "Key"].join(""),
  ["product", "_", "key"].join(""),
  ["plaintext", "Key"].join(""),
  ["plaintext", "_", "key"].join(""),
  ["api", "Secret"].join(""),
  "api_secret",
  "password",
  ["payment", "Credential"].join(""),
  "payment_credential",
] as const;

export const validateAuditMetadata = (
  metadata: AuditMetadata,
): AuditMetadata => {
  for (const key of Object.keys(metadata)) {
    if (
      forbiddenMetadataKeys.includes(
        key as (typeof forbiddenMetadataKeys)[number],
      )
    ) {
      throw new Error(`Audit metadata contains forbidden field: ${key}`);
    }
  }

  return metadata;
};
