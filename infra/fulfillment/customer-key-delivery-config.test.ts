import { describe, expect, it } from "vitest";

import { customerKeyDeliveryConfigFromEnv } from "./customer-key-delivery-config.js";

describe("customer key delivery runtime config", () => {
  it("uses safe local defaults with live delivery disabled", () => {
    expect(customerKeyDeliveryConfigFromEnv({})).toEqual({
      allowLiveCustomerKeyDelivery: false,
      approvalTtlMs: 300_000,
      deliveryLeaseStaleAfterMs: 60_000,
      protectedFulfillmentIds: [],
    });
  });

  it("requires positive integer timing values and explicit live gate", () => {
    expect(() =>
      customerKeyDeliveryConfigFromEnv({
        KEYCORE_DELIVERY_APPROVAL_TTL_MS: "0",
      }),
    ).toThrow("KEYCORE_DELIVERY_APPROVAL_TTL_MS_INVALID");
    expect(
      customerKeyDeliveryConfigFromEnv({
        KEYCORE_ALLOW_LIVE_CUSTOMER_KEY_DELIVERY: "true",
        KEYCORE_CUSTOMER_DELIVERY_PROTECTED_FULFILLMENT_IDS: "a, b",
        KEYCORE_DELIVERY_APPROVAL_TTL_MS: "1000",
        KEYCORE_DELIVERY_LEASE_STALE_AFTER_MS: "500",
      }),
    ).toEqual({
      allowLiveCustomerKeyDelivery: true,
      approvalTtlMs: 1_000,
      deliveryLeaseStaleAfterMs: 500,
      protectedFulfillmentIds: ["a", "b"],
    });
  });
});
