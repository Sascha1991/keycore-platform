import type { CorrelationId } from "./identifiers.js";

export const auditEventTypes = [
  "KEY_STORED",
  "KEY_REVEALED",
  "KEY_ACCESS_DENIED",
  "KEY_REWRAPPED",
  "KEY_RETIRED",
  "REGION_DECISION_CHANGED",
  "PRICE_GATE_CHANGED",
  "ADMIN_ACTION",
  "APPROVAL_RECORDED",
  "AUTH_SECURITY_EVENT",
  "SYSTEM_DEGRADATION",
  "AUDIT_QUERY_EXECUTED",
  "AUDIT_QUERY_DENIED",
  "SUPPLIER_SELECTION_COMPLETED",
  "SUPPLIER_SELECTION_FAILED",
  "SUPPLIER_FALLBACK_BLOCKED",
  "HEALTH",
] as const;

export type PrefixAuditEventType =
  | `CATALOG_${string}`
  | `CUSTOMER_${string}`
  | `FULFILLMENT_${string}`
  | `ORDER_${string}`
  | `PAYMENT_${string}`
  | `PRICING_${string}`
  | `PROCUREMENT_${string}`
  | `REFUND_${string}`
  | `STOREFRONT_${string}`;

export type AuditEventType =
  (typeof auditEventTypes)[number] | PrefixAuditEventType;

export const auditOutcomes = ["SUCCEEDED", "FAILED", "DENIED"] as const;

export type AuditOutcome = (typeof auditOutcomes)[number];

export type AuditMetadataPrimitive = string | number | boolean | null;

export type AuditMetadataValue =
  | AuditMetadataPrimitive
  | readonly AuditMetadataValue[]
  | { readonly [key: string]: AuditMetadataValue };

export type AuditMetadata = Readonly<Record<string, AuditMetadataValue>>;

export interface AuditActor {
  readonly type: "CUSTOMER" | "ADMIN" | "SYSTEM" | "SERVICE";
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

const maxAuditMetadataDepth = 5;
const maxAuditMetadataStringLength = 1_024;
const maxAuditMetadataSerializedBytes = 8_192;
const maxAuditMetadataArrayLength = 50;
const maxAuditMetadataObjectKeys = 50;

const forbiddenExactMetadataKeys = new Set([
  "apikey",
  "authenticationtag",
  "cardnumber",
  "cvc",
  "cvv",
  "dataencryptionkey",
  "decryptedkey",
  "dek",
  "iv",
  "masterkey",
  "nonce",
  "paymentcredential",
  "plaintextkey",
  ["product", "key"].join(""),
  "rawkey",
  "wrappeddataencryptionkey",
]);

const forbiddenContainedMetadataKeys = [
  "authorization",
  "ciphertext",
  "cookie",
  "credential",
  "password",
  "secret",
  "session",
  "token",
] as const;

const forbiddenBodyMetadataKeys = new Set([
  "rawrequest",
  "rawresponse",
  "request",
  "requestbody",
  "response",
  "responsebody",
]);

const normalizeMetadataKey = (key: string): string =>
  key.toLowerCase().replace(/[^a-z0-9]/gu, "");

const isPlainObject = (
  value: unknown,
): value is Record<string, AuditMetadataValue> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const isForbiddenMetadataKey = (key: string): boolean => {
  const normalizedKey = normalizeMetadataKey(key);

  return (
    forbiddenExactMetadataKeys.has(normalizedKey) ||
    forbiddenBodyMetadataKeys.has(normalizedKey) ||
    forbiddenContainedMetadataKeys.some((forbidden) =>
      normalizedKey.includes(forbidden),
    )
  );
};

const validateAuditMetadataValue = (
  value: unknown,
  path: string,
  depth: number,
): void => {
  if (depth > maxAuditMetadataDepth) {
    throw new Error(`Audit metadata exceeds maximum nesting at ${path}`);
  }

  if (value === null) {
    return;
  }

  if (typeof value === "string") {
    if (value.length > maxAuditMetadataStringLength) {
      throw new Error(`Audit metadata string is too large at ${path}`);
    }
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Audit metadata number is not JSON-safe at ${path}`);
    }
    return;
  }

  if (typeof value === "boolean") {
    return;
  }

  if (typeof value === "bigint" || typeof value === "function") {
    throw new Error(`Audit metadata contains non-JSON value at ${path}`);
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    throw new Error(`Audit metadata contains binary value at ${path}`);
  }

  if (value instanceof Uint8Array || value instanceof Error) {
    throw new Error(`Audit metadata contains unsafe value at ${path}`);
  }

  if (Array.isArray(value)) {
    if (value.length > maxAuditMetadataArrayLength) {
      throw new Error(`Audit metadata array is too large at ${path}`);
    }

    value.forEach((item, index) => {
      validateAuditMetadataValue(item, `${path}[${index}]`, depth + 1);
    });
    return;
  }

  if (!isPlainObject(value)) {
    throw new Error(`Audit metadata contains unsupported object at ${path}`);
  }

  validateAuditMetadataObject(value, path, depth + 1);
};

const validateAuditMetadataObject = (
  metadata: Record<string, unknown>,
  path: string,
  depth: number,
): void => {
  const keys = Object.keys(metadata);
  if (keys.length > maxAuditMetadataObjectKeys) {
    throw new Error(`Audit metadata object has too many fields at ${path}`);
  }

  for (const key of keys) {
    if (isForbiddenMetadataKey(key)) {
      throw new Error(`Audit metadata contains forbidden field: ${key}`);
    }

    validateAuditMetadataValue(metadata[key], `${path}.${key}`, depth);
  }
};

export const validateAuditMetadata = (
  metadata: AuditMetadata,
): AuditMetadata => {
  if (!isPlainObject(metadata)) {
    throw new Error("Audit metadata must be a JSON object");
  }

  validateAuditMetadataObject(metadata, "metadata", 0);

  const serializedMetadata = JSON.stringify(metadata);
  if (
    Buffer.byteLength(serializedMetadata, "utf8") >
    maxAuditMetadataSerializedBytes
  ) {
    throw new Error("Audit metadata payload is too large");
  }

  return metadata;
};

export const validateAuditEventType = (eventType: string): AuditEventType => {
  if ((auditEventTypes as readonly string[]).includes(eventType)) {
    return eventType as AuditEventType;
  }

  if (
    /^(CATALOG|CUSTOMER|FULFILLMENT|ORDER|PAYMENT|PRICING|PROCUREMENT|REFUND|STOREFRONT)_[A-Z0-9_]+$/u.test(
      eventType,
    )
  ) {
    return eventType as AuditEventType;
  }

  throw new Error(`Unsupported audit event type: ${eventType}`);
};

export const validateAuditEvent = (event: AuditEvent): AuditEvent => {
  validateAuditEventType(event.eventType);
  validateAuditMetadata(event.metadata);

  if (
    !event.uuid ||
    !event.timestampUtc ||
    Number.isNaN(event.timestampUtc.getTime())
  ) {
    throw new Error("Audit event requires a durable UUID and UTC timestamp");
  }

  if (
    !event.actor.id ||
    !event.actor.type ||
    !event.entity.id ||
    !event.entity.type
  ) {
    throw new Error("Audit event requires actor and entity context");
  }

  return event;
};
