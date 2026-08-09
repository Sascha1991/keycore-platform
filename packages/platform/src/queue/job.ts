import type { CorrelationId, IdempotencyKey, JobId } from "../contracts.js";

export type SafePayloadValue =
  | string
  | number
  | boolean
  | null
  | readonly SafePayloadValue[]
  | { readonly [key: string]: SafePayloadValue };

export type SafePayload = Readonly<Record<string, SafePayloadValue>>;

export interface JobAttempt {
  readonly attempt: number;
  readonly maxAttempts: number;
}

export interface JobEnvelope<TPayload extends SafePayload = SafePayload> {
  readonly jobId: JobId;
  readonly jobType: string;
  readonly schemaVersion: number;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: IdempotencyKey;
  readonly entityReferenceId?: string;
  readonly createdAt: Date;
  readonly attempt: JobAttempt;
  readonly payload: TPayload;
}

const forbiddenPayloadKeyParts = [
  ["product", "key"],
  ["plain", "text", "key"],
  ["decrypted", "key"],
  ["api", "secret"],
  ["password"],
  ["payment", "credential"],
] as const;

const normalizeKey = (key: string): string =>
  key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");

const isForbiddenKey = (key: string): boolean => {
  const normalized = normalizeKey(key);
  return forbiddenPayloadKeyParts.some((parts) =>
    normalized.includes(parts.join("")),
  );
};

export const validateSafePayload = (payload: SafePayload): SafePayload => {
  const visit = (value: SafePayloadValue, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }

    if (value !== null && typeof value === "object") {
      for (const [key, nestedValue] of Object.entries(value)) {
        if (isForbiddenKey(key)) {
          throw new Error(`Forbidden queue payload field: ${path}.${key}`);
        }
        visit(nestedValue, `${path}.${key}`);
      }
    }
  };

  visit(payload, "payload");
  return payload;
};

export const redactForLog = (payload: SafePayload): SafePayload => {
  validateSafePayload(payload);
  return {
    fieldCount: Object.keys(payload).length,
  };
};
