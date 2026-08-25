export interface CustomerKeyDeliveryRuntimeConfig {
  readonly approvalTtlMs: number;
  readonly deliveryLeaseStaleAfterMs: number;
  readonly allowLiveCustomerKeyDelivery: boolean;
  readonly protectedFulfillmentIds: readonly string[];
}

const defaultApprovalTtlMs = 300_000;
const defaultDeliveryLeaseStaleAfterMs = 60_000;

export const customerKeyDeliveryConfigFromEnv = (
  env: NodeJS.ProcessEnv,
): CustomerKeyDeliveryRuntimeConfig => ({
  allowLiveCustomerKeyDelivery:
    env.KEYCORE_ALLOW_LIVE_CUSTOMER_KEY_DELIVERY === "true",
  approvalTtlMs: positiveIntegerFromEnv(
    env.KEYCORE_DELIVERY_APPROVAL_TTL_MS,
    "KEYCORE_DELIVERY_APPROVAL_TTL_MS",
    defaultApprovalTtlMs,
  ),
  deliveryLeaseStaleAfterMs: positiveIntegerFromEnv(
    env.KEYCORE_DELIVERY_LEASE_STALE_AFTER_MS,
    "KEYCORE_DELIVERY_LEASE_STALE_AFTER_MS",
    defaultDeliveryLeaseStaleAfterMs,
  ),
  protectedFulfillmentIds: splitList(
    env.KEYCORE_CUSTOMER_DELIVERY_PROTECTED_FULFILLMENT_IDS,
  ),
});

const positiveIntegerFromEnv = (
  value: string | undefined,
  name: string,
  fallback: number,
): number => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name}_INVALID`);
  }
  return parsed;
};

const splitList = (value: string | undefined): readonly string[] =>
  value
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0) ?? [];
