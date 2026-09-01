import { describe, expect, it } from "vitest";

import type {
  CustomerAccountReadRepository,
  CustomerInvoiceDocumentProvider,
} from "../../packages/platform/src/contracts.js";

import {
  signStagingStorefrontRequest,
  signStagingStorefrontResponse,
  type StagingGuestOrderClaimPort,
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

  it("serves a deterministic synthetic PDF only to the authenticated owner", async () => {
    const runtime = await harness();
    const first = await runtime.bridge.handle(ownerInvoice());
    const second = await runtime.bridge.handle(ownerInvoice());
    const payload = json(first.body);
    const document = payload.document as Record<string, string>;
    const pdf = Buffer.from(document.body ?? "", "base64").toString("ascii");

    expect(first.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    expect(document.contentType).toBe("application/pdf");
    expect(document.encoding).toBe("base64");
    expect(pdf).toContain("%PDF-1.4");
    expect(pdf).toContain("KR-SYNTHETIC-0001");
    expect(pdf).toContain("Neonpfad: Berlin");
    expect(pdf).toContain("Nicht rechtsgueltig");
    expect(first.headers["Cache-Control"]).toBe("private, no-store");
    expect(first.headers.Pragma).toBe("no-cache");
    expect(first.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(first.body).not.toMatch(
      /SYNTHETIC_BROWSER_REVEAL|claim|password|token|secret|credential/iu,
    );
    expect(
      runtime.auditEvents.some(
        (event) => event.eventType === "CUSTOMER_INVOICE_DOCUMENT_VIEWED",
      ),
    ).toBe(true);
  });

  it("denies anonymous, unmapped, cross-owner and unavailable invoice access uniformly", async () => {
    const requests = [
      signed({ csrfVerified: true, method: "POST", path: invoicePath }),
      signed({
        csrfVerified: true,
        customerId: stagingCustomerAId,
        method: "POST",
        path: invoicePath,
        wpUserId: "999",
      }),
      signed({
        csrfVerified: true,
        customerId: stagingCustomerBId,
        method: "POST",
        path: invoicePath,
        wpUserId: "21",
      }),
      signed({
        csrfVerified: true,
        customerId: stagingCustomerAId,
        method: "POST",
        path: `/v1/account/orders/20000000-0000-4000-8000-000000000002/invoice`,
        wpUserId: "20",
      }),
    ];
    for (const request of requests) {
      const response = await (await harness()).bridge.handle(request);
      expect([401, 404]).toContain(response.statusCode);
      expect(response.body).not.toContain("KR-SYNTHETIC-0001");
    }
  });

  it("rejects invoice route tampering, unexpected bodies, missing CSRF and invalid signatures", async () => {
    const runtime = await harness();
    for (const request of [
      signed({
        customerId: stagingCustomerAId,
        method: "POST",
        path: invoicePath,
        wpUserId: "20",
      }),
      signed({
        body: JSON.stringify({ invoiceId: "../../private/invoice.pdf" }),
        csrfVerified: true,
        customerId: stagingCustomerAId,
        method: "POST",
        path: invoicePath,
        wpUserId: "20",
      }),
      signed({
        csrfVerified: true,
        customerId: stagingCustomerAId,
        method: "POST",
        path: `${invoicePath}/../../private`,
        wpUserId: "20",
      }),
    ]) {
      const response = await runtime.bridge.handle(request);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain("KR-SYNTHETIC-0001");
    }
    const tampered = { ...ownerInvoice(), signature: "invalid-signature" };
    expect((await runtime.bridge.handle(tampered)).statusCode).toBe(403);
  });

  it("fails closed for invoice mapping mismatch, malformed documents, provider outage and PostgreSQL outage", async () => {
    for (const provider of [
      new FixedInvoiceProvider({ status: "NOT_AVAILABLE" }),
      new FixedInvoiceProvider({
        bytes: Buffer.from("<html>unsafe</html>"),
        contentType: "text/html",
        status: "AVAILABLE",
      }),
    ]) {
      const runtime = await harness(undefined, {
        invoiceDocumentProvider: provider,
      });
      const response = await runtime.bridge.handle(ownerInvoice());
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("unsafe");
    }

    const unavailable = await harness(undefined, {
      invoiceDocumentProvider: new ThrowingInvoiceProvider(),
    });
    expect((await unavailable.bridge.handle(ownerInvoice())).statusCode).toBe(
      503,
    );

    const databaseOutage = await harness(undefined, {
      accountRepository: new ThrowingAccountRepository(),
    });
    const response = await databaseOutage.bridge.handle(ownerInvoice());
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe(
      '{"code":"TEMPORARILY_UNAVAILABLE","status":"ERROR"}',
    );
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

  it("claims through the existing application boundary without returning the claim secret", async () => {
    const guestClaim = new CapturingGuestClaim();
    const runtime = await harness(undefined, { guestOrderClaim: guestClaim });
    const claimCode = "SYNTHETIC_CLAIM_BROWSER_TEST_123456";
    const response = await runtime.bridge.handle(
      signed({
        body: JSON.stringify({ claimCode }),
        csrfVerified: true,
        customerId: stagingCustomerAId,
        method: "POST",
        path: "/v1/account/claim",
        wpUserId: "20",
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(json(response.body)).toEqual({ status: "CLAIMED" });
    expect(response.body).not.toContain(claimCode);
    expect(guestClaim.claims).toHaveLength(1);
    expect(guestClaim.claims[0]?.principal.customerId).toBe(stagingCustomerAId);
  });

  it("fails claim closed for invalid schema, CSRF, identity, replay and backend outage", async () => {
    const guestClaim = new CapturingGuestClaim();
    const validBody = JSON.stringify({
      claimCode: "SYNTHETIC_CLAIM_BROWSER_TEST_123456",
    });
    for (const request of [
      signed({ body: validBody, method: "POST", path: "/v1/account/claim" }),
      signed({
        body: validBody,
        customerId: stagingCustomerAId,
        method: "POST",
        path: "/v1/account/claim",
        wpUserId: "20",
      }),
      signed({
        body: JSON.stringify({ claimCode: "short" }),
        csrfVerified: true,
        customerId: stagingCustomerAId,
        method: "POST",
        path: "/v1/account/claim",
        wpUserId: "20",
      }),
      signed({
        body: JSON.stringify({ claimCode: "a".repeat(32), orderId: "hidden" }),
        csrfVerified: true,
        customerId: stagingCustomerAId,
        method: "POST",
        path: "/v1/account/claim",
        wpUserId: "20",
      }),
    ]) {
      const response = await (
        await harness(undefined, { guestOrderClaim: guestClaim })
      ).bridge.handle(request);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }

    guestClaim.result = { status: "CLAIM_DENIED" };
    const replay = await (
      await harness(undefined, { guestOrderClaim: guestClaim })
    ).bridge.handle(ownerClaim(validBody));
    expect(replay.statusCode).toBe(409);
    expect(replay.body).toBe('{"code":"CLAIM_INVALID","status":"ERROR"}');

    guestClaim.throwOnClaim = true;
    const outage = await (
      await harness(undefined, { guestOrderClaim: guestClaim })
    ).bridge.handle(ownerClaim(validBody));
    expect(outage.statusCode).toBe(503);
    expect(outage.body).not.toContain(validBody);
  });

  it("rate-limits claim attempts per mapped customer", async () => {
    const guestClaim = new CapturingGuestClaim();
    guestClaim.result = { status: "CLAIM_DENIED" };
    const runtime = await harness(undefined, { guestOrderClaim: guestClaim });
    const body = JSON.stringify({ claimCode: "a".repeat(32) });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await runtime.bridge.handle(ownerClaim(body))).statusCode).toBe(
        409,
      );
    }
    expect((await runtime.bridge.handle(ownerClaim(body))).statusCode).toBe(
      429,
    );
    expect(guestClaim.claims).toHaveLength(5);
  });
});

const revealPath = `/v1/account/orders/${stagingFulfilledOrderId}/reveal`;
const invoicePath = `/v1/account/orders/${stagingFulfilledOrderId}/invoice`;

const harness = (
  checkout?: StagingCheckoutPort,
  dependencies: Parameters<typeof createStagingStorefrontRuntime>[1] = {},
) =>
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
    { ...dependencies, ...(checkout ? { checkout } : {}) },
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

const ownerClaim = (body: string) =>
  signed({
    body,
    csrfVerified: true,
    customerId: stagingCustomerAId,
    method: "POST",
    path: "/v1/account/claim",
    wpUserId: "20",
  });

const ownerInvoice = () =>
  signed({
    csrfVerified: true,
    customerId: stagingCustomerAId,
    method: "POST",
    path: invoicePath,
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

class CapturingGuestClaim implements StagingGuestOrderClaimPort {
  public readonly claims: Parameters<
    StagingGuestOrderClaimPort["claimGuestOrder"]
  >[0][] = [];
  public result: Awaited<
    ReturnType<StagingGuestOrderClaimPort["claimGuestOrder"]>
  > = {
    orderId: stagingFulfilledOrderId,
    status: "CLAIMED",
  };
  public throwOnClaim = false;

  public async claimGuestOrder(
    input: Parameters<StagingGuestOrderClaimPort["claimGuestOrder"]>[0],
  ) {
    this.claims.push(input);
    if (this.throwOnClaim) throw new Error("synthetic backend outage");
    return this.result;
  }
}

class FixedInvoiceProvider implements CustomerInvoiceDocumentProvider {
  public constructor(
    private readonly result: Awaited<
      ReturnType<CustomerInvoiceDocumentProvider["getDocument"]>
    >,
  ) {}
  public async getDocument() {
    return this.result;
  }
}

class ThrowingInvoiceProvider implements CustomerInvoiceDocumentProvider {
  public async getDocument(): ReturnType<
    CustomerInvoiceDocumentProvider["getDocument"]
  > {
    throw new Error("synthetic document store outage");
  }
}

class ThrowingAccountRepository implements CustomerAccountReadRepository {
  public findAccountSummary(): ReturnType<
    CustomerAccountReadRepository["findAccountSummary"]
  > {
    return Promise.reject(new Error("synthetic PostgreSQL outage"));
  }
  public listOwnedOrders(): ReturnType<
    CustomerAccountReadRepository["listOwnedOrders"]
  > {
    return Promise.reject(new Error("synthetic PostgreSQL outage"));
  }
  public findOwnedOrderDetail(): ReturnType<
    CustomerAccountReadRepository["findOwnedOrderDetail"]
  > {
    return Promise.reject(new Error("synthetic PostgreSQL outage"));
  }
}
