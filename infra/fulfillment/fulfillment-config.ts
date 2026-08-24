import { DevelopmentKeyManagementProvider } from "../key-management/development-provider.js";

export interface FulfillmentRuntimeConfig {
  readonly controlledKeyRetrievalEnabled: boolean;
  readonly controlledKeyRetrievalMode:
    "DISABLED" | "CONTROLLED_VERIFICATION_ONE_TIME";
  readonly approvalTtlMs: number;
  readonly retrievalLeaseStaleAfterMs: number;
  readonly keyManagementProvider: DevelopmentKeyManagementProvider;
}

export const fulfillmentConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): FulfillmentRuntimeConfig => {
  const keyId = requiredSafeIdentifier(
    env.KEYCORE_FULFILLMENT_MASTER_KEY_ID,
    "KEYCORE_FULFILLMENT_MASTER_KEY_ID",
  );
  const masterKey = env.KEYCORE_FULFILLMENT_MASTER_KEY;
  validateBase64MasterKey(masterKey);
  return {
    approvalTtlMs: positiveIntegerEnv(
      env.KEYCORE_FULFILLMENT_APPROVAL_TTL_MS,
      300_000,
      "KEYCORE_FULFILLMENT_APPROVAL_TTL_MS",
    ),
    controlledKeyRetrievalEnabled:
      env.KEYCORE_ALLOW_KINGUIN_LIVE_KEY_RETRIEVAL === "true",
    controlledKeyRetrievalMode:
      env.KEYCORE_KINGUIN_CONTROLLED_KEY_RETRIEVAL_MODE ===
      "CONTROLLED_VERIFICATION_ONE_TIME"
        ? "CONTROLLED_VERIFICATION_ONE_TIME"
        : "DISABLED",
    keyManagementProvider: new DevelopmentKeyManagementProvider({
      environmentName: env.NODE_ENV ?? "local",
      masterKeyMaterialBase64: masterKey,
      masterKeyVersion: keyId,
    }),
    retrievalLeaseStaleAfterMs: positiveIntegerEnv(
      env.KEYCORE_FULFILLMENT_RETRIEVAL_LEASE_STALE_AFTER_MS,
      60_000,
      "KEYCORE_FULFILLMENT_RETRIEVAL_LEASE_STALE_AFTER_MS",
    ),
  };
};

export const validateControlledKeyRetrievalConfig = (
  env: Readonly<Record<string, string | undefined>>,
): FulfillmentRuntimeConfig => {
  const config = fulfillmentConfigFromEnv(env);
  if (!config.controlledKeyRetrievalEnabled) {
    throw new Error("KEYCORE_ALLOW_KINGUIN_LIVE_KEY_RETRIEVAL_REQUIRED");
  }
  if (
    config.controlledKeyRetrievalMode !== "CONTROLLED_VERIFICATION_ONE_TIME"
  ) {
    throw new Error("KEYCORE_KINGUIN_CONTROLLED_KEY_RETRIEVAL_MODE_REQUIRED");
  }
  return config;
};

const validateBase64MasterKey = (value: string | undefined): void => {
  if (!value) {
    throw new Error("KEYCORE_FULFILLMENT_MASTER_KEY_REQUIRED");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new Error("KEYCORE_FULFILLMENT_MASTER_KEY_INVALID");
  }
};

const requiredSafeIdentifier = (
  value: string | undefined,
  name: string,
): string => {
  if (!value || !/^[A-Za-z0-9_.:-]{1,120}$/u.test(value)) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
};

const positiveIntegerEnv = (
  value: string | undefined,
  fallback: number,
  name: string,
): number => {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name}_INVALID`);
  }
  return parsed;
};
