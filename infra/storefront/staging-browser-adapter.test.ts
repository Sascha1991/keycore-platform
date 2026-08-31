import { describe, expect, it } from "vitest";

import {
  signStagingStorefrontRequest,
  signStagingStorefrontResponse,
  type StagingStorefrontRequest,
} from "./staging-browser-adapter.js";
import {
  publishableStagingCatalog,
  stagingCatalog,
} from "./staging-catalog.js";
import {
  createStagingStorefrontRuntime,
  stagingCustomerAId,
  stagingCustomerBId,
  stagingFulfilledOrderId,
} from "./staging-storefront-runtime.js";
import type {
  StagingCheckoutCommand,
  StagingCheckoutPort,
} from "./staging-checkout.js";

const now = new Date("2026-08-30T12:00:00.000Z");
const origin = "https://staging.keyrano.de";
const sharedSecret = "staging-bridge-test-secret-with-32-bytes-minimum";
const syntheticValue = "SYNTHETIC_BROWSER_REVEAL_VALUE_NOT_FOR_SALE";
const masterKeyMaterialBase64 = Buffer.alloc(32, 0x42).toString("base64");

describe("staging storefront browser adapter", () => {
  it("publishes only deterministic eligible, available, positive-price products", async () => {
    const runtime = await harness();
    const response = await runtime.bridge.handle(
      signed({ method: "GET", path: "/v1/catalog" }),
    );
    const payload = json(response.body);

    expect(response.statusCode).toBe(200);
    expect(payload.products).toHaveLength(6);
    expect(publishableStagingCatalog()).toHaveLength(6);
    expect(stagingCatalog).toHaveLength(9);
    expect(response.body).not.toMatch(
      /supplier|blocked|review required|unavailable fixture/iu,
    );
  });

  it("returns owner-filtered account data without revealing the synthetic value", async () => {
    const runtime = await harness();
    const response = await runtime.bridge.handle(
      signed({
        customerId: stagingCustomerAId,
        method: "GET",
        path: "/v1/account/orders",
        wpUserId: "20",
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(json(response.body).orders).toHaveLength(2);
    expect(response.body).not.toContain(syntheticValue);
    expect(response.headers["Cache-Control"]).toBe("private, no-store");
  });

  it("reveals through the existing vault only after exact owner and explicit CSRF-protected action", async () => {
    const runtime = await harness();
    const response = await runtime.bridge.handle(
      signed({
        csrfVerified: true,
        customerId: stagingCustomerAId,
        method: "POST",
        path: `/v1/account/orders/${stagingFulfilledOrderId}/reveal`,
        wpUserId: "20",
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(json(response.body)).toEqual({
      status: "REVEALED",
      value: syntheticValue,
    });
    expect(response.headers["Cache-Control"]).toContain("no-store");
    expect(response.headers.Pragma).toBe("no-cache");
    expect(JSON.stringify(runtime.auditEvents)).not.toContain(syntheticValue);
    expect(
      runtime.auditEvents.some((event) => event.eventType === "KEY_REVEALED"),
    ).toBe(true);
  });

  it("denies anonymous, cross-owner and missing-CSRF reveal without ownership disclosure", async () => {
    for (const request of [
      signed({ csrfVerified: true, method: "POST", path: revealPath }),
      signed({
        csrfVerified: true,
        customerId: stagingCustomerBId,
        method: "POST",
        path: revealPath,
        wpUserId: "21",
      }),
      signed({
        customerId: stagingCustomerAId,
        method: "POST",
        path: revealPath,
        wpUserId: "20",
      }),
    ]) {
      const runtime = await harness();
      const response = await runtime.bridge.handle(request);
      expect([401, 403, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain(syntheticValue);
    }
  });

  it("keeps key plaintext absent from purchase detail and invoice metadata", async () => {
    const runtime = await harness();
    const response = await runtime.bridge.handle(
      signed({
        customerId: stagingCustomerAId,
        method: "GET",
        path: `/v1/account/orders/${stagingFulfilledOrderId}`,
        wpUserId: "20",
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("KR-SYNTHETIC-0001");
    expect(response.body).not.toContain(syntheticValue);
  });

  it("rate-limits repeated reveal and rejects stale, tampered, or arbitrary-origin adapter calls", async () => {
    const runtime = await harness();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await runtime.bridge.handle(ownerReveal())).statusCode).toBe(200);
    }
    expect((await runtime.bridge.handle(ownerReveal())).statusCode).toBe(429);

    const stale = signed({
      method: "GET",
      path: "/v1/catalog",
      timestamp: "2026-08-29T12:00:00.000Z",
    });
    expect((await runtime.bridge.handle(stale)).statusCode).toBe(403);

    const tampered = {
      ...signed({ method: "GET", path: "/v1/catalog" }),
      path: "/v1/account/orders",
    };
    expect((await runtime.bridge.handle(tampered)).statusCode).toBe(403);

    const arbitrary = signed({
      method: "GET",
      origin: "https://shop.example.com",
      path: "/v1/catalog",
    });
    expect((await runtime.bridge.handle(arbitrary)).statusCode).toBe(403);
  });

  it("signs responses so WordPress can reject a modified bridge payload", async () => {
    const runtime = await harness();
    const request = signed({ method: "GET", path: "/v1/catalog" });
    const response = await runtime.bridge.handle(request);
    const timestamp = response.headers["X-KeyRaNo-Response-Timestamp"] ?? "";
    expect(response.headers["X-KeyRaNo-Response-Signature"]).toBe(
      signStagingStorefrontResponse(
        sharedSecret,
        timestamp,
        response.statusCode,
        response.body,
        request.signature,
      ),
    );
  });

  it("accepts only an authenticated CSRF-protected exact checkout command", async () => {
    const checkout = new CapturingCheckout();
    const runtime = await harness(checkout);
    const body = JSON.stringify({
      checkoutCreatedAt: now.toISOString(),
      checkoutToken: "a".repeat(64),
      currency: "EUR",
      expectedTotalMinor: "1299",
      outcome: "SUCCESS",
      productReference: "synthetic-de-adventure",
      quantity: 1,
    });
    const response = await runtime.bridge.handle(
      signed({
        body,
        csrfVerified: true,
        customerId: stagingCustomerAId,
        method: "POST",
        path: "/v1/checkout",
        wpUserId: "20",
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(json(response.body)).toMatchObject({
      orderId: "20000000-0000-4000-8000-000000000099",
      status: "CAPTURED",
    });
    expect(checkout.commands).toEqual([
      expect.objectContaining({ customerId: stagingCustomerAId }),
    ]);
    expect(response.body).not.toContain(syntheticValue);

    for (const invalid of [
      signed({
        body,
        customerId: stagingCustomerAId,
        method: "POST",
        path: "/v1/checkout",
        wpUserId: "20",
      }),
      signed({
        body: JSON.stringify({ ...JSON.parse(body), unexpected: true }),
        csrfVerified: true,
        customerId: stagingCustomerAId,
        method: "POST",
        path: "/v1/checkout",
        wpUserId: "20",
      }),
      signed({
        body: "not-json",
        csrfVerified: true,
        customerId: stagingCustomerAId,
        method: "POST",
        path: "/v1/checkout",
        wpUserId: "20",
      }),
    ]) {
      expect(
        (await runtime.bridge.handle(invalid)).statusCode,
      ).toBeGreaterThanOrEqual(400);
    }
  });
});

const revealPath = `/v1/account/orders/${stagingFulfilledOrderId}/reveal`;

const harness = (checkout?: StagingCheckoutPort) =>
  createStagingStorefrontRuntime(
    {
      allowedOrigin: origin,
      customerAWpUserId: "20",
      customerBWpUserId: "21",
      masterKeyMaterialBase64,
      now: () => now,
      sharedSecret,
      syntheticKey: syntheticValue,
    },
    checkout ? { checkout } : {},
  );

const signed = (
  input: Partial<Omit<StagingStorefrontRequest, "signature">> &
    Pick<StagingStorefrontRequest, "method" | "path">,
): StagingStorefrontRequest => {
  const unsigned = {
    body: input.body ?? "",
    csrfVerified: input.csrfVerified ?? false,
    customerId: input.customerId,
    method: input.method,
    origin: input.origin ?? origin,
    path: input.path,
    timestamp: input.timestamp ?? now.toISOString(),
    wpUserId: input.wpUserId,
  };
  return {
    ...unsigned,
    signature: signStagingStorefrontRequest(sharedSecret, unsigned),
  };
};

const ownerReveal = () =>
  signed({
    csrfVerified: true,
    customerId: stagingCustomerAId,
    method: "POST",
    path: revealPath,
    wpUserId: "20",
  });

const json = (value: string): Readonly<Record<string, unknown>> =>
  JSON.parse(value) as Readonly<Record<string, unknown>>;

class CapturingCheckout implements StagingCheckoutPort {
  public readonly commands: StagingCheckoutCommand[] = [];

  public async checkout(command: StagingCheckoutCommand) {
    this.commands.push(command);
    return {
      orderId: "20000000-0000-4000-8000-000000000099",
      reasonCode: "CHECKOUT_PAYMENT_CAPTURED",
      status: "CAPTURED" as const,
    };
  }
}
