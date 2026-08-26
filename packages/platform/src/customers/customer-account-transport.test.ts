import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { InMemoryCustomerAccountReadRepository } from "../../../../infra/customers/in-memory-customer-account-repository.js";
import { InMemoryCustomerAuthSessionRepository } from "../../../../infra/customers/in-memory-customer-authentication-repository.js";
import { InMemoryCustomerOrderIdentityRepository } from "../../../../infra/customers/in-memory-customer-order-identity-repository.js";
import { InMemoryCustomerRegistrationChallengeRepository } from "../../../../infra/customers/in-memory-customer-registration-repository.js";
import { InMemoryCustomerKeyDeliveryRepository } from "../../../../infra/fulfillment/in-memory-customer-key-delivery-repository.js";
import { InMemoryFulfillmentRepository } from "../../../../infra/fulfillment/in-memory-fulfillment-repository.js";
import {
  CustomerAccountService,
  CustomerAccountTransportHandler,
  type CustomerAccountTransportRequest,
  CustomerAuthenticationService,
  CustomerKeyAccessService,
  CustomerKeyDeliveryService,
  CustomerOrderIdentityService,
  CustomerRegistrationService,
  FakeCustomerEmailVerificationDeliveryPort,
  FailClosedGuestOrderClaimAuthority,
  HmacDoubleSubmitCsrfPolicy,
  InMemoryAuthenticatedDeliveryRateLimiter,
  PersistedCustomerOrderAuthorizationPort,
  StaticAuthenticatedCustomerPrincipalProvider,
  correlationId,
  currency,
  customerAccountTransportCookiePolicy,
  customerId,
  encryptFulfillmentSecret,
  extractCustomerAccountSessionCredential,
  fulfillmentEncryptionContext,
  money,
  orderId,
  productId,
  supplierId,
  woocommerceCustomerAccountTrustBoundary,
  type AuditEvent,
  type AuditEventPort,
  type AuthenticatedCustomerDeliveryRateLimiter,
  type AuthenticatedCustomerPrincipal,
  type CorrelationId,
  type CustomerAccountOrderProjection,
  type CustomerAuthenticationAuthorityPort,
  type CustomerDeliveryAuthorization,
  type CustomerId,
  type GuestOrderClaimAuthorityPort,
  type GuestOrderClaimEvidence,
  type CustomerIdentityBindingAuthorityPort,
  type CustomerIdentityProvider,
  type CustomerKeyDeliveryPort,
  type CustomerKeyDeliveryPortResult,
  type EmailVerificationAuthorityPort,
  type FulfillmentOperation,
  type KeyManagementProvider,
  type OrderId,
  type VerifiedCustomerAuthenticationAssertion,
} from "../contracts.js";

const now = new Date("2026-08-26T09:00:00.000Z");
const allowedOrigin = "https://account.example.test";
const csrfSecret = "customer-account-csrf-fixture-secret-32";
const cursorSigningSecret = "customer-account-transport-cursor-secret-32";
const verificationToken = "KEYCORE_KS0803_VERIFY_TOKEN_DO_NOT_LEAK_918273";
const sessionMarker =
  "KEYCORE_KS0803_SESSION_TOKEN_DO_NOT_LEAK_918273_abcdefghi";
const internalFailureMarker =
  "SQL constraint customer_sessions_token_hash_key C:\\secret\\stack TRACE_MARKER provider-error";
const keyAccessMarker =
  "KEYCORE_KS0804_SYNTHETIC_PRODUCT_KEY_DO_NOT_USE_918273";
const guestClaimCode = "KEYRANO_KS0805_CLAIM_CODE_DO_NOT_LEAK_842913";
const realFulfillmentId = "fd61be5e-44ea-4914-98ae-c4404dc31779";

describe("CustomerAccountTransportHandler", () => {
  it("resolves session to principal and returns account summary, owned history and safe order detail", async () => {
    const harness = await transportHarness();

    const summary = await harness.handler.getAccountSummary(
      harness.request("GET", { route: "summary" }),
    );
    const history = await harness.handler.listOwnedOrders(
      harness.request("GET", {
        query: { limit: "2" },
        route: "history",
      }),
    );
    const detailRequest = harness.request("GET", {
      path: { orderId: String(harness.ownedOrder) },
      route: "detail",
    });
    const detail = await harness.handler.getOwnedOrderDetail(detailRequest);

    expect(summary).toMatchObject({
      body: {
        account: {
          customerId: harness.customerId,
          emailMasked: "b******@example.test",
        },
        apiVersion: "v1",
        status: "OK",
      },
      headers: { "Cache-Control": "private, no-store" },
      statusCode: 200,
    });
    expect(history.statusCode).toBe(200);
    expect(detail).toMatchObject({
      body: {
        order: {
          fulfillment: {
            hasEncryptedSecret: true,
            keyAccessAvailable: true,
            status: "KEY_AVAILABLE",
          },
          orderId: harness.ownedOrder,
        },
        status: "OK",
      },
      statusCode: 200,
    });
    expect(safeJson([summary, history, detail])).not.toMatch(
      /providerSubject|sessionCredential|supplier|GE1373B866F3|TEST-AAAAA-BBBBB-CCCCC/iu,
    );
    expect(harness.accountRepository.detailCalls).toBe(1);
    expect(harness.deliveryCalls).toBe(0);
    expect(harness.decryptCalls).toBe(0);
  });

  it("denies missing, malformed, expired and revoked sessions without account reads", async () => {
    for (const mode of [
      "missing",
      "malformed",
      "expired",
      "revoked",
    ] as const) {
      const harness = await transportHarness({ sessionMode: mode });
      const response = await harness.handler.getAccountSummary(
        harness.request("GET", { route: `session-${mode}` }),
      );

      expect(response).toMatchObject({
        body: { code: "AUTHENTICATION_REQUIRED", status: "ERROR" },
        statusCode: 401,
      });
      expect(harness.accountRepository.summaryCalls).toBe(0);
    }
  });

  it("fails closed on duplicate, conflicting, empty, whitespace and oversized credentials", async () => {
    const harness = await transportHarness();
    const valid = harness.sessionCredential;
    expect(
      extractCustomerAccountSessionCredential({
        credentialSources: { authorizationHeader: [`Bearer ${valid}`] },
      }),
    ).toEqual({ sessionCredential: valid, status: "OK" });

    const invalidInputs = [
      { sessionCredential: "" },
      { sessionCredential: ` ${valid}` },
      { sessionCredential: `${valid} ` },
      { sessionCredential: "x".repeat(129) },
      { credentialSources: { sessionCookie: [valid, valid] } },
      {
        credentialSources: {
          authorizationHeader: [`Bearer ${valid}`],
          sessionHeader: ["different-session-token-that-is-long-enough-abcdef"],
        },
      },
      { credentialSources: { authorizationHeader: [`Bearer ${valid} extra`] } },
    ] satisfies Pick<
      CustomerAccountTransportRequest,
      "credentialSources" | "sessionCredential"
    >[];

    for (const input of invalidInputs) {
      expect(extractCustomerAccountSessionCredential(input).status).not.toBe(
        "OK",
      );
      const requestInput = {
        credentialSources: input.credentialSources,
        route: "ambiguous-credential",
        ...("sessionCredential" in input
          ? { sessionCredential: input.sessionCredential }
          : {}),
      };
      const response = await harness.handler.getAccountSummary(
        harness.request("GET", requestInput),
      );
      expect(response.statusCode).toBe(401);
    }
    expect(harness.accountRepository.summaryCalls).toBe(0);
  });

  it("rejects invalid reads and forged authority fields before session resolution", async () => {
    const harness = await transportHarness();
    const invalids = [
      harness.request("POST", { route: "bad-method" }),
      harness.request("GET", { body: { customerId: harness.otherCustomerId } }),
      harness.request("GET", { body: { supplierOrderId: "GE1373B866F3" } }),
      harness.request("GET", { bodyByteLength: 1 }),
    ];

    for (const request of invalids) {
      const response = await harness.handler.getAccountSummary(request);
      expect(response.statusCode).toBe(400);
    }
    await expect(
      harness.handler.getAccountSummary(
        harness.request("GET", { origin: "https://evil.example.test" }),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      harness.handler.listOwnedOrders(
        harness.request("GET", { query: { limit: "0" }, route: "bad-limit" }),
      ),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      harness.handler.getOwnedOrderDetail(
        harness.request("GET", {
          path: { orderId: "not-a-uuid" },
          route: "bad-order",
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 400 });
    expect(harness.sessionService.resolveCalls).toBe(0);
    expect(harness.accountRepository.summaryCalls).toBe(0);
  });

  it("reuses exact origin normalization and rejects deceptive production origins", async () => {
    const allowed = await transportHarness({
      allowedOrigins: ["https://keyrano.de"],
      environment: "PRODUCTION",
    });
    await expect(
      allowed.handler.getAccountSummary(
        allowed.request("GET", {
          origin: "https://keyrano.de",
          route: "origin-ok",
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 200 });

    for (const origin of [
      "http://keyrano.de",
      "https://keyrano.de.attacker.example",
      "https://attacker.example/keyrano.de",
      "not an origin",
    ]) {
      const harness = await transportHarness({
        allowedOrigins: ["https://keyrano.de"],
        environment: "PRODUCTION",
      });
      await expect(
        harness.handler.getAccountSummary(
          harness.request("GET", { origin, route: `origin-${origin}` }),
        ),
      ).resolves.toMatchObject({
        body: { code: "ACCESS_DENIED", status: "ERROR" },
        statusCode: 403,
      });
      expect(harness.sessionService.resolveCalls).toBe(0);
    }

    await expect(
      transportHarness({
        allowedOrigins: ["http://localhost:3000"],
        environment: "PRODUCTION",
      }),
    ).rejects.toThrow("origin is invalid");
    await expect(
      transportHarness({
        allowedOrigins: ["http://localhost:3000"],
        environment: "CI",
      }),
    ).resolves.toBeTruthy();
  });

  it("validates mutation content type and body size before limiter or domain mutation", async () => {
    for (const invalidRequest of [
      { contentType: "text/plain" },
      { contentType: "application/json; bad parameter" },
      { bodyByteLength: -1 },
      { bodyByteLength: 1.5 },
      { bodyByteLength: Number.NaN },
      { bodyByteLength: Number.POSITIVE_INFINITY },
      { bodyByteLength: Number.MAX_SAFE_INTEGER + 1 },
      { bodyByteLength: 4097 },
    ]) {
      const limiter = new CapturingRateLimiter();
      const harness = await transportHarness({ rateLimiter: limiter });
      await expect(
        harness.handler.register(
          harness.request("POST", {
            body: { email: "body-check@example.test" },
            ...invalidRequest,
          }),
        ),
      ).resolves.toMatchObject({ statusCode: 400 });
      expect(limiter.keys).toHaveLength(0);
      expect(harness.delivery.deliveries).toHaveLength(0);
    }

    const harness = await transportHarness();
    await expect(
      harness.handler.register(
        harness.request("POST", {
          body: { email: "charset@example.test" },
          contentType: "application/json; charset=utf-8",
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 202 });
  });

  it("rejects security-sensitive DTO fields on mutation paths", async () => {
    for (const field of [
      "customerId",
      "providerSubject",
      "supplierId",
      "externalSupplierOrderId",
      "fulfillmentId",
      "orderOwner",
      "verificationState",
      "emailVerificationState",
      "authenticatedPrincipal",
      "sessionPrincipal",
      "deliveryCapability",
    ]) {
      const harness = await transportHarness();
      await expect(
        harness.handler.register(
          harness.request("POST", {
            body: { email: "strict@example.test", [field]: "forged" },
            route: `strict-${field}`,
          }),
        ),
      ).resolves.toMatchObject({ statusCode: 400 });
      expect(harness.delivery.deliveries).toHaveLength(0);
    }
  });

  it("keeps wrong-owner, unknown and legacy real fulfillment unavailable and never reveals keys", async () => {
    const harness = await transportHarness();
    const responses = await Promise.all([
      harness.handler.getOwnedOrderDetail(
        harness.request("GET", {
          path: { orderId: String(harness.wrongOwnerOrder) },
          route: "wrong-owner",
        }),
      ),
      harness.handler.getOwnedOrderDetail(
        harness.request("GET", {
          path: { orderId: String(randomUUID()) },
          route: "unknown",
        }),
      ),
      harness.handler.getOwnedOrderDetail(
        harness.request("GET", {
          path: { orderId: String(harness.legacyRealOrder) },
          route: "legacy-real",
        }),
      ),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      404, 404, 404,
    ]);
    expect(
      responses.map((response) =>
        response.body.status === "ERROR" ? response.body.code : "unexpected",
      ),
    ).toEqual([
      "RESOURCE_NOT_AVAILABLE",
      "RESOURCE_NOT_AVAILABLE",
      "RESOURCE_NOT_AVAILABLE",
    ]);
    expect(
      harness.accountRepository.fulfillmentSnapshot(realFulfillmentId),
    ).toMatchObject({
      deliveredAt: null,
      deliveryState: "PENDING",
      fulfillmentId: realFulfillmentId,
      orderId: null,
      retrievalState: "RETRIEVED",
    });
    expect(harness.decryptCalls).toBe(0);
    expect(harness.deliveryCalls).toBe(0);
  });

  it("accepts registration with enumeration-safe response and creates no session", async () => {
    const harness = await transportHarness();

    const first = await harness.handler.register(
      harness.request("POST", { body: { email: "new@example.test" } }),
    );
    const existing = await harness.handler.register(
      harness.request("POST", { body: { email: "new@example.test" } }),
    );

    expect(first).toMatchObject({
      body: { status: "REGISTRATION_ACCEPTED" },
      statusCode: 202,
    });
    expect(existing).toMatchObject({
      body: { status: "REGISTRATION_ACCEPTED" },
      statusCode: 202,
    });
    expect(safeJson([first, existing])).not.toMatch(
      /customerId|existing|session/iu,
    );
    expect(harness.delivery.deliveries).toHaveLength(2);
    expect(harness.sessionService.createdSessionCount).toBe(1);
  });

  it("maps registration limiter and delivery failures safely", async () => {
    const limited = await transportHarness({
      rateLimiter: new AlwaysLimitedRateLimiter(),
    });
    await expect(
      limited.handler.register(
        limited.request("POST", { body: { email: "limited@example.test" } }),
      ),
    ).resolves.toMatchObject({
      body: { code: "RATE_LIMITED", status: "ERROR" },
      statusCode: 429,
    });

    const unavailable = await transportHarness({
      rateLimiter: new ThrowingRateLimiter(),
    });
    await expect(
      unavailable.handler.register(
        unavailable.request("POST", {
          body: { email: "unavailable@example.test" },
        }),
      ),
    ).resolves.toMatchObject({
      body: { code: "TEMPORARILY_UNAVAILABLE", status: "ERROR" },
      statusCode: 503,
    });
  });

  it("verifies email by secret POST token without echoing or auditing token values", async () => {
    const harness = await transportHarness({
      registrationTokenFactory: () => verificationToken,
    });
    await harness.handler.register(
      harness.request("POST", { body: { email: "verify@example.test" } }),
    );
    const verified = await harness.handler.verifyEmail(
      harness.request("POST", {
        body: { verificationToken },
        route: "verify",
      }),
    );
    const invalid = await harness.handler.verifyEmail(
      harness.request("POST", {
        body: { verificationToken },
        route: "verify-consumed",
      }),
    );

    expect(verified).toMatchObject({
      body: { status: "VERIFIED" },
      headers: { "Referrer-Policy": "no-referrer" },
      statusCode: 200,
    });
    expect(invalid).toMatchObject({
      body: { status: "VERIFICATION_INVALID" },
      statusCode: 400,
    });
    expect(safeJson([verified, invalid, harness.audit.events])).not.toContain(
      verificationToken,
    );
  });

  it("does not leak verification token through denial and failure paths", async () => {
    const originDenied = await transportHarness();
    const originDeniedResponse = await originDenied.handler.verifyEmail(
      originDenied.request("POST", {
        body: { verificationToken },
        origin: "https://evil.example.test",
        route: "verify-origin-denied",
      }),
    );
    const limited = await transportHarness({
      rateLimiter: new AlwaysLimitedRateLimiter(),
    });
    const limitedResponse = await limited.handler.verifyEmail(
      limited.request("POST", {
        body: { verificationToken },
        route: "verify-rate-limited",
      }),
    );
    const failed = await transportHarness({
      throwingChallengeRepository: true,
    });
    const failedResponse = await failed.handler.verifyEmail(
      failed.request("POST", {
        body: { verificationToken },
        route: "verify-internal-failure",
      }),
    );

    expect(originDeniedResponse.statusCode).toBe(403);
    expect(limitedResponse.statusCode).toBe(429);
    expect(failedResponse).toMatchObject({
      body: { code: "TEMPORARILY_UNAVAILABLE", status: "ERROR" },
      statusCode: 503,
    });
    expect(
      safeJson([
        originDeniedResponse,
        limitedResponse,
        failedResponse,
        originDenied.audit.events,
        limited.audit.events,
        failed.audit.events,
      ]),
    ).not.toContain(verificationToken);
  });

  it("does not expose raw session credentials in limiter keys, responses or audit", async () => {
    const limiter = new CapturingRateLimiter();
    const harness = await transportHarness({
      rateLimiter: limiter,
      sessionTokenFactory: () => sessionMarker,
    });
    const response = await harness.handler.linkIdentity(
      harness.request("POST", { body: {}, route: "session-leak" }),
    );

    expect(response.statusCode).toBe(200);
    expect(
      safeJson([response, limiter.keys, harness.audit.events]),
    ).not.toContain(sessionMarker);
    expect(limiter.keys).toHaveLength(1);
    expect(limiter.keys[0]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("sanitizes invalid correlation IDs and redacts internal failures", async () => {
    const harness = await transportHarness({ throwingAccountRepository: true });
    const response = await harness.handler.getAccountSummary(
      harness.request("GET", {
        correlationIdHeader: `bad\r\nx:${internalFailureMarker}`,
        route: "redacted",
      }),
    );

    expect(response).toMatchObject({
      body: { code: "TEMPORARILY_UNAVAILABLE", status: "ERROR" },
      statusCode: 503,
    });
    expect(
      response.body.status === "ERROR" ? response.body.correlationId : "",
    ).toMatch(/^customer-account-account-summary-/u);
    expect(safeJson(response)).not.toMatch(
      /SQL constraint|C:\\secret|TRACE_MARKER|provider-error/iu,
    );
  });

  it("links identity only through authenticated verified principal and trusted adapter evidence", async () => {
    const harness = await transportHarness({
      identitySubjectForLinking: "trusted-link-subject",
    });

    await expect(
      harness.handler.linkIdentity(
        harness.request("POST", { body: {}, route: "link" }),
      ),
    ).resolves.toMatchObject({ body: { status: "BOUND" }, statusCode: 200 });
    await expect(
      harness.handler.linkIdentity(
        harness.request("POST", {
          body: { providerSubject: "raw-forged-subject" },
          route: "raw-provider",
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 400 });

    const missing = await transportHarness({ sessionMode: "missing" });
    await expect(
      missing.handler.linkIdentity(
        missing.request("POST", { body: {}, route: "missing-link" }),
      ),
    ).resolves.toMatchObject({ statusCode: 401 });

    const unverified = await transportHarness({ verifiedCustomer: false });
    await expect(
      unverified.handler.linkIdentity(
        unverified.request("POST", { body: {}, route: "unverified-link" }),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
  });

  it("does not trust WooCommerce email-only input for authentication, linking, claiming or account access", async () => {
    const harness = await transportHarness({ sessionMode: "missing" });
    const wooInput = {
      customerId: harness.customerId,
      email: "buyer@example.test",
      providerSubject: "woocommerce-user-123",
    };

    await expect(
      harness.handler.getAccountSummary(
        harness.request("GET", { body: wooInput, route: "woo-summary" }),
      ),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      harness.handler.linkIdentity(
        harness.request("POST", { body: wooInput, route: "woo-link" }),
      ),
    ).resolves.toMatchObject({ statusCode: 400 });
    expect(woocommerceCustomerAccountTrustBoundary).toEqual({
      emailOnlyAuthentication: "DENIED",
      emailOnlyIdentityLinking: "DENIED",
      emailOnlyOrderClaim: "DENIED",
      sourceOfTruth: "KEYCORE",
    });
    expect(harness.accountRepository.summaryCalls).toBe(0);
    expect(harness.identityRepository.orderOwnershipBindingCount).toBe(0);
  });

  it("claims guest orders only through authenticated POST, CSRF, limiter and claim code", async () => {
    const limiter = new CapturingRateLimiter();
    const harness = await transportHarness({
      claimCode: guestClaimCode,
      rateLimiter: limiter,
    });
    const claimed = await harness.handler.claimGuestOrder(
      harness.request("POST", {
        body: {
          claimCode: guestClaimCode,
          orderId: String(harness.guestOrder),
        },
        route: "claim-guest-order",
      }),
    );
    expect(claimed).toMatchObject({
      body: {
        orderId: harness.guestOrder,
        status: "ORDER_CLAIMED",
      },
      headers: { "Cache-Control": "no-store" },
      statusCode: 200,
    });
    expect(limiter.keys).toHaveLength(1);
    expect(
      safeJson([claimed, limiter.keys, harness.audit.events]),
    ).not.toContain(guestClaimCode);
    expect(harness.identityRepository.orderOwnershipBindingCount).toBe(1);
    expect(harness.keyAccessKeyProvider.unwraps).toBe(0);
    expect(harness.keyAccessDeliveryPort.calls).toHaveLength(0);

    for (const request of [
      { origin: "https://evil.example.test", statusCode: 403 },
      { csrfHeader: "bad", statusCode: 403 },
      {
        body: {
          claimCode: guestClaimCode,
          customerId: harness.otherCustomerId,
        },
        statusCode: 400,
      },
    ]) {
      const denied = await transportHarness({ claimCode: guestClaimCode });
      const response = await denied.handler.claimGuestOrder(
        denied.request("POST", {
          body: {
            claimCode: guestClaimCode,
            orderId: String(denied.guestOrder),
            ...(request.body ?? {}),
          },
          route: "claim-denied",
          ...("csrfHeader" in request
            ? { csrfHeader: request.csrfHeader }
            : {}),
          ...("origin" in request ? { origin: request.origin } : {}),
        }),
      );
      expect(response.statusCode).toBe(request.statusCode);
      expect(denied.identityRepository.orderOwnershipBindingCount).toBe(0);
      expect(denied.keyAccessKeyProvider.unwraps).toBe(0);
    }

    const limited = await transportHarness({
      claimCode: guestClaimCode,
      rateLimiter: new AlwaysLimitedRateLimiter(),
    });
    await expect(
      limited.handler.claimGuestOrder(
        limited.request("POST", {
          body: {
            claimCode: guestClaimCode,
            orderId: String(limited.guestOrder),
          },
          route: "claim-limited",
        }),
      ),
    ).resolves.toMatchObject({
      body: { code: "RATE_LIMITED", status: "ERROR" },
      statusCode: 429,
    });
    expect(limited.identityRepository.orderOwnershipBindingCount).toBe(0);
  });

  it("preserves account pagination semantics and delegates opaque cursor validation", async () => {
    for (const invalidLimit of [
      "0",
      "-1",
      "1.5",
      "NaN",
      "Infinity",
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      const harness = await transportHarness();
      await expect(
        harness.handler.listOwnedOrders(
          harness.request("GET", {
            query: { limit: invalidLimit },
            route: `limit-${invalidLimit}`,
          }),
        ),
      ).resolves.toMatchObject({ statusCode: 400 });
      expect(harness.accountRepository.listCalls).toEqual([]);
    }

    const harness = await transportHarness();
    await harness.handler.listOwnedOrders(
      harness.request("GET", {
        query: { limit: "1000" },
        route: "limit-clamp",
      }),
    );
    expect(harness.accountRepository.listCalls).toEqual([100]);
    await expect(
      harness.handler.listOwnedOrders(
        harness.request("GET", {
          query: { cursor: "../not-opaque" },
          route: "bad-cursor",
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 400 });
  });

  it("prepares and executes explicit key access through the secure delivery boundary", async () => {
    const harness = await transportHarness();
    const body = {
      fulfillmentReference: harness.ownedFulfillmentId,
      orderId: String(harness.ownedOrder),
    };

    const prepared = await harness.handler.prepareKeyAccess(
      harness.request("POST", { body, route: "prepare-key-access" }),
    );
    expect(prepared).toMatchObject({
      body: { status: "KEY_ACCESS_AUTHORIZED" },
      statusCode: 201,
    });
    expect(harness.keyAccessKeyProvider.unwraps).toBe(0);
    expect(harness.keyAccessDeliveryPort.calls).toHaveLength(0);

    const delivered = await harness.handler.executeKeyAccess(
      harness.request("POST", {
        body: {
          ...body,
          deliveryApprovalId:
            prepared.body.status === "KEY_ACCESS_AUTHORIZED"
              ? prepared.body.deliveryApprovalId
              : "",
          deliveryCapability:
            prepared.body.status === "KEY_ACCESS_AUTHORIZED"
              ? prepared.body.deliveryCapability
              : "",
        },
        route: "execute-key-access",
      }),
    );

    expect(delivered).toMatchObject({
      body: { status: "KEY_DELIVERED" },
      statusCode: 200,
    });
    expect(harness.keyAccessDeliveryPort.calls).toHaveLength(1);
    expect(harness.keyAccessDeliveryPort.lastPlaintextSeen).toBe(
      keyAccessMarker,
    );
    expect(harness.keyAccessKeyProvider.unwraps).toBe(1);
    expect(safeJson([prepared, delivered, harness.audit.events])).not.toContain(
      keyAccessMarker,
    );
  });

  it("denies key access origin, csrf, limiter and authority-field failures before decrypt", async () => {
    for (const request of [
      { origin: "https://evil.example.test" },
      { csrfHeader: "bad" },
      { body: { customerId: "forged", orderId: "forged" } },
    ]) {
      const harness = await transportHarness();
      const requestInput = {
        body: {
          fulfillmentReference: harness.ownedFulfillmentId,
          orderId: String(harness.ownedOrder),
          ...(request.body ?? {}),
        },
        route: "deny-key-access",
        ...("csrfHeader" in request ? { csrfHeader: request.csrfHeader } : {}),
        ...("origin" in request ? { origin: request.origin } : {}),
      };
      await expect(
        harness.handler.prepareKeyAccess(harness.request("POST", requestInput)),
      ).resolves.toMatchObject({
        statusCode: request.origin || request.csrfHeader ? 403 : 400,
      });
      expect(harness.keyAccessKeyProvider.unwraps).toBe(0);
      expect(harness.keyAccessDeliveryPort.calls).toHaveLength(0);
    }

    const limited = await transportHarness({
      rateLimiter: new AlwaysLimitedRateLimiter(),
    });
    await expect(
      limited.handler.prepareKeyAccess(
        limited.request("POST", {
          body: {
            fulfillmentReference: limited.ownedFulfillmentId,
            orderId: String(limited.ownedOrder),
          },
          route: "rate-limited-key-access",
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 429 });
    expect(limited.keyAccessKeyProvider.unwraps).toBe(0);
    expect(limited.keyAccessDeliveryPort.calls).toHaveLength(0);
  });

  it("defines secure browser cookie and explicit production origin policy", () => {
    expect(customerAccountTransportCookiePolicy).toContain("HttpOnly");
    expect(customerAccountTransportCookiePolicy).toContain("Secure");
    expect(customerAccountTransportCookiePolicy).toContain("SameSite=Lax");
    expect(customerAccountTransportCookiePolicy).toContain("Path=/");
    expect(
      () =>
        new CustomerAccountTransportHandler({
          ...handlerOptionsFixture(),
          config: { allowedOrigins: ["*"], maxBodyBytes: 4096 },
          environment: "PRODUCTION",
        }),
    ).toThrow("origin is invalid");
  });
});

const transportHarness = async (
  options: {
    readonly sessionMode?:
      "valid" | "missing" | "malformed" | "expired" | "revoked";
    readonly verifiedCustomer?: boolean;
    readonly identitySubjectForLinking?: string;
    readonly registrationTokenFactory?: () => string;
    readonly sessionTokenFactory?: () => string;
    readonly rateLimiter?: AuthenticatedCustomerDeliveryRateLimiter;
    readonly environment?: "LOCAL" | "CI" | "STAGING" | "PRODUCTION";
    readonly allowedOrigins?: readonly string[];
    readonly throwingAccountRepository?: boolean;
    readonly throwingChallengeRepository?: boolean;
    readonly claimCode?: string;
  } = {},
) => {
  const audit = new CapturingAudit();
  const identityRepository = new CountingCustomerOrderIdentityRepository();
  const accountRepository = new CountingCustomerAccountReadRepository(
    options.throwingAccountRepository === true,
  );
  const subject = `subject-${randomUUID()}`;
  const otherSubject = `other-${randomUUID()}`;
  const created = await createCustomer(identityRepository, subject, {
    verified: options.verifiedCustomer !== false,
  });
  const other = await createCustomer(identityRepository, otherSubject, {
    verified: true,
  });
  accountRepository.addAccount({
    createdAt: now,
    customerId: created.customerId,
    emailMasked: "b******@example.test",
    emailVerificationState:
      options.verifiedCustomer === false ? "UNVERIFIED" : "VERIFIED",
  });
  const ownedOrder = orderId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
  const ownedFulfillmentId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
  const wrongOwnerOrder = orderId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  const legacyRealOrder = orderId("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  const guestOrder = orderId("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  accountRepository.addOrder(
    orderFixture(created.customerId, ownedOrder, {
      fulfillment: fulfillmentFixture(ownedFulfillmentId, ownedOrder),
    }),
  );
  accountRepository.addOrder(
    orderFixture(other.customerId, wrongOwnerOrder, {}),
  );
  accountRepository.addOrder(
    orderFixture(
      customerId("33333333-3333-4333-8333-333333333333"),
      legacyRealOrder,
      {
        fulfillment: fulfillmentFixture(realFulfillmentId, null),
      },
    ),
  );

  const authRepository = new InMemoryCustomerAuthSessionRepository({
    findCustomerById: (id) => identityRepository.findCustomerById(id),
    findIdentityBindingById: (id) =>
      identityRepository.findIdentityBindingById(id),
    findIdentityBindingByProviderSubject: (input) =>
      identityRepository.findIdentityBindingByProviderSubject(input),
  });
  let authNow = now;
  const sessionService = new InstrumentedCustomerAuthenticationService({
    authority: new FakeAuthenticationAuthority(assertion(subject)),
    now: () => authNow,
    repository: authRepository,
    ...(options.sessionTokenFactory
      ? { tokenFactory: options.sessionTokenFactory }
      : {}),
  });
  const createdSession = await sessionService.createSession({
    correlationId: correlationId("customer-account-transport-session"),
  });
  const sessionToken =
    createdSession.status === "CREATED" ? createdSession.rawSessionToken : "";
  if (options.sessionMode === "expired") {
    authNow = new Date(now.getTime() + 28_800_001);
  }
  if (options.sessionMode === "revoked") {
    await sessionService.revokeSession({
      correlationId: correlationId("customer-account-transport-revoke"),
      rawSessionToken: sessionToken,
    });
  }
  const csrf = new HmacDoubleSubmitCsrfPolicy(csrfSecret);
  const csrfToken = csrf.createToken(sessionToken);
  const fulfillmentRepository = new InMemoryFulfillmentRepository();
  const deliveryRepository = new InMemoryCustomerKeyDeliveryRepository(
    fulfillmentRepository,
  );
  const keyAccessKeyProvider = new CountingKeyProvider(
    "ks0804-transport-mk-v1",
  );
  const keyAccessFulfillment = fulfillmentOperationFixture(
    ownedOrder,
    ownedFulfillmentId,
  );
  const keyAccessMaterial = await encryptFulfillmentSecret(
    Buffer.from(keyAccessMarker, "utf8"),
    fulfillmentEncryptionContext(keyAccessFulfillment),
    keyAccessKeyProvider,
  );
  await fulfillmentRepository.createIdempotent({
    now,
    operation: keyAccessFulfillment,
  });
  await fulfillmentRepository.markRetrieved({
    executionToken: keyAccessFulfillment.retrievalExecutionToken ?? "",
    fulfillmentId: keyAccessFulfillment.id,
    material: keyAccessMaterial,
    now,
  });
  const retrievedFulfillment =
    await fulfillmentRepository.findById(ownedFulfillmentId);
  if (!retrievedFulfillment?.encryptedSecretId) {
    throw new Error("Expected KS-08-04 transport fulfillment fixture");
  }
  identityRepository.addOrder({
    customerId: created.customerId,
    checkoutEmailNormalized: "buyer@example.test",
    fulfillmentStatus: "PENDING",
    orderId: ownedOrder,
    paymentStatus: "CAPTURED",
    procurementStatus: "SUCCEEDED",
    recordVersion: 1,
    status: "FULFILLMENT_PENDING",
    updatedAt: now,
  });
  identityRepository.addOrder({
    checkoutEmailNormalized: "buyer@example.test",
    customerId: null,
    fulfillmentStatus: "PENDING",
    orderId: guestOrder,
    paymentStatus: "CAPTURED",
    procurementStatus: "SUCCEEDED",
    recordVersion: 1,
    status: "FULFILLMENT_PENDING",
    updatedAt: now,
  });
  identityRepository.addFulfillment({
    deliveryState: "PENDING",
    encryptedSecretId: retrievedFulfillment.encryptedSecretId,
    fulfillmentId: ownedFulfillmentId,
    orderId: ownedOrder,
    retrievalState: "RETRIEVED",
    status: "DELIVERY_PENDING",
  });
  const principalProvider = new StaticAuthenticatedCustomerPrincipalProvider({
    authenticationContext: { assurance: "AUTHENTICATED", provider: "TEST" },
    customerId: created.customerId,
  });
  const keyAccessDeliveryPort = new FakeKeyAccessDeliveryPort();
  const keyAccessService = new CustomerKeyAccessService({
    accountRepository,
    audit,
    deliveryService: new CustomerKeyDeliveryService({
      approvalTtlMs: 300_000,
      audit,
      deliveryLeaseStaleAfterMs: 60_000,
      deliveryPort: keyAccessDeliveryPort,
      deliveryRepository,
      environment: "CI",
      fulfillmentRepository,
      keyManagementProvider: keyAccessKeyProvider,
      now: () => now,
      orderAuthorization: new PersistedCustomerOrderAuthorizationPort({
        audit,
        environment: "CI",
        principalProvider,
        repository: identityRepository,
      }),
      protectedFulfillmentIds: [realFulfillmentId],
    }),
    environment: "CI",
    now: () => now,
  });
  const delivery = new FakeCustomerEmailVerificationDeliveryPort();
  const registrationService = new CustomerRegistrationService({
    audit,
    challengeRepository: options.throwingChallengeRepository
      ? new ThrowingChallengeRepository()
      : new InMemoryCustomerRegistrationChallengeRepository(identityRepository),
    delivery,
    identityBindingAuthority: new FakeIdentityAuthority(
      options.identitySubjectForLinking ?? `link-${randomUUID()}`,
    ),
    identityRepository,
    identityService: new CustomerOrderIdentityService({
      audit,
      now: () => now,
      repository: identityRepository,
    }),
    now: () => now,
    claimAuthority: options.claimCode
      ? new FakeGuestOrderClaimAuthority({
          claimCode: options.claimCode,
          customerId: created.customerId,
          orderId: guestOrder,
        })
      : new FailClosedGuestOrderClaimAuthority(),
    ...(options.registrationTokenFactory
      ? { tokenFactory: options.registrationTokenFactory }
      : {}),
  });
  const handler = new CustomerAccountTransportHandler({
    accountService: new CustomerAccountService({
      audit,
      cursorSigningSecret,
      environment: "CI",
      now: () => now,
      repository: accountRepository,
    }),
    keyAccessService,
    config: {
      allowedOrigins: options.allowedOrigins ?? [allowedOrigin],
      maxBodyBytes: 4096,
    },
    csrfPolicy: csrf,
    environment: options.environment ?? "CI",
    now: () => now,
    rateLimiter:
      options.rateLimiter ??
      new InMemoryAuthenticatedDeliveryRateLimiter({
        max: 100,
        windowMs: 60_000,
      }),
    registrationService,
    sessionService,
  });
  return {
    accountRepository,
    audit,
    customerId: created.customerId,
    decryptCalls: 0,
    delivery,
    deliveryCalls: 0,
    handler,
    guestOrder,
    identityRepository,
    legacyRealOrder,
    keyAccessDeliveryPort,
    keyAccessKeyProvider,
    otherCustomerId: other.customerId,
    ownedFulfillmentId,
    ownedOrder,
    sessionCredential: sessionToken,
    sessionService,
    wrongOwnerOrder,
    request: (
      method: "GET" | "POST",
      input: {
        readonly route?: string;
        readonly body?: Readonly<Record<string, unknown>>;
        readonly query?: Readonly<Record<string, string>>;
        readonly path?: Readonly<Record<string, string>>;
        readonly bodyByteLength?: number;
        readonly contentType?: string;
        readonly correlationIdHeader?: string;
        readonly credentialSources?: CustomerAccountTransportRequest["credentialSources"];
        readonly csrfHeader?: string | null;
        readonly origin?: string | null;
        readonly sessionCredential?: string | null;
      } = {},
    ): CustomerAccountTransportRequest => ({
      bodyByteLength:
        input.bodyByteLength ??
        (method === "GET" ? 0 : safeJson(input.body ?? {}).length),
      correlationIdHeader:
        input.correlationIdHeader ??
        `corr-${input.route ?? method.toLowerCase()}`,
      csrfCookie: csrfToken,
      csrfHeader: input.csrfHeader === undefined ? csrfToken : input.csrfHeader,
      method,
      origin: input.origin === undefined ? allowedOrigin : input.origin,
      remoteAddress: "203.0.113.11",
      sessionCredential:
        input.sessionCredential === undefined
          ? options.sessionMode === "missing"
            ? null
            : options.sessionMode === "malformed"
              ? "not a session"
              : sessionToken
          : input.sessionCredential,
      ...(input.body ? { body: input.body } : {}),
      ...(input.credentialSources
        ? { credentialSources: input.credentialSources }
        : {}),
      ...(method === "POST"
        ? { contentType: input.contentType ?? "application/json" }
        : {}),
      ...(input.path ? { path: input.path } : {}),
      ...(input.query ? { query: input.query } : {}),
    }),
  };
};

const handlerOptionsFixture = () => {
  const identityRepository = new InMemoryCustomerOrderIdentityRepository();
  const sessionService = new CustomerAuthenticationService({
    repository: new InMemoryCustomerAuthSessionRepository({
      findCustomerById: (id) => identityRepository.findCustomerById(id),
      findIdentityBindingById: (id) =>
        identityRepository.findIdentityBindingById(id),
      findIdentityBindingByProviderSubject: (input) =>
        identityRepository.findIdentityBindingByProviderSubject(input),
    }),
  });
  const accountRepository = new InMemoryCustomerAccountReadRepository();
  const identityService = new CustomerOrderIdentityService({
    repository: identityRepository,
  });
  return {
    accountService: new CustomerAccountService({
      cursorSigningSecret,
      repository: accountRepository,
    }),
    csrfPolicy: new HmacDoubleSubmitCsrfPolicy(csrfSecret),
    rateLimiter: new InMemoryAuthenticatedDeliveryRateLimiter({
      max: 1,
      windowMs: 60_000,
    }),
    registrationService: new CustomerRegistrationService({
      challengeRepository: new InMemoryCustomerRegistrationChallengeRepository(
        identityRepository,
      ),
      delivery: new FakeCustomerEmailVerificationDeliveryPort(),
      identityRepository,
      identityService,
    }),
    sessionService,
  };
};

const createCustomer = async (
  repository: InMemoryCustomerOrderIdentityRepository,
  providerSubject: string,
  options: { readonly verified: boolean },
): Promise<{ readonly customerId: CustomerId }> => {
  const service = new CustomerOrderIdentityService({
    emailVerificationAuthority: new FakeEmailVerificationAuthority(),
    identityBindingAuthority: new FakeIdentityAuthority(providerSubject),
    now: () => now,
    repository,
  });
  const created = await service.createCustomer({
    correlationId: correlationId(`create-${providerSubject}`),
    email: `${providerSubject}@example.test`,
  });
  if (!("customer" in created)) {
    throw new Error("Expected customer fixture");
  }
  if (options.verified) {
    await service.markEmailVerified({
      correlationId: correlationId(`verify-${providerSubject}`),
      customerId: created.customer.id,
      expectedCustomerVersion: 1,
    });
  }
  await service.bindIdentity({
    correlationId: correlationId(`bind-${providerSubject}`),
    customerId: created.customer.id,
  });
  return { customerId: created.customer.id };
};

const orderFixture = (
  owner: CustomerId,
  fixtureOrderId: OrderId,
  options: {
    readonly fulfillment?: CustomerAccountOrderProjection["fulfillment"];
  },
): CustomerAccountOrderProjection => ({
  createdAt: now,
  currency: currency("EUR"),
  customerId: owner,
  fulfillment: options.fulfillment ?? null,
  fulfillmentStatus: "PENDING",
  invoice: null,
  activation: null,
  orderId: fixtureOrderId,
  paymentStatus: "CAPTURED",
  procurementStatus: "SUCCEEDED",
  productTitle: "Synthetic Account Transport Product",
  refundStatus: "NOT_REQUESTED",
  status: "FULFILLMENT_PENDING",
  total: money(1299n, currency("EUR")),
  updatedAt: now,
});

const fulfillmentFixture = (
  fulfillmentId: string,
  fixtureOrderId: OrderId | null,
): NonNullable<CustomerAccountOrderProjection["fulfillment"]> => ({
  deliveredAt: null,
  deliveryState: "PENDING",
  fulfillmentId,
  hasEncryptedSecret: true,
  orderId: fixtureOrderId,
  retrievedAt: now,
  retrievalState: "RETRIEVED",
  status: "DELIVERY_PENDING",
});

const fulfillmentOperationFixture = (
  fixtureOrderId: OrderId,
  fulfillmentId: string,
): FulfillmentOperation => ({
  approvalExpiresAt: new Date(now.getTime() + 300_000),
  controlledProcurementApprovalId: null,
  correlationId: correlationId("ks0804-account-transport-fulfillment"),
  createdAt: now,
  deliveryState: "NOT_READY",
  expectedQuantity: 1,
  externalSupplierOrderId: "synthetic-ks0804-supplier-order",
  id: fulfillmentId,
  orderId: fixtureOrderId,
  procurementOperationId: randomUUID(),
  recordVersion: 1,
  retrievalExecutionToken: randomUUID(),
  retrievalStartedAt: now,
  retrievalState: "IN_FLIGHT",
  status: "RETRIEVAL_IN_FLIGHT",
  supplierId: supplierId("mock-supplier"),
  supplierItemReference: productId(randomUUID()),
  tokenHash: "a".repeat(64),
  updatedAt: now,
});

const assertion = (
  providerSubject: string,
): VerifiedCustomerAuthenticationAssertion => ({
  assurance: "AUTHENTICATED",
  authContextId: `account-transport-${providerSubject.slice(0, 8)}`,
  authenticatedAt: now,
  expiresAt: new Date(now.getTime() + 28_800_000),
  provider: "TEST",
  providerSubject,
});

class FakeAuthenticationAuthority implements CustomerAuthenticationAuthorityPort {
  public constructor(
    private readonly authAssertion: VerifiedCustomerAuthenticationAssertion,
  ) {}

  public async verifiedAuthenticationAssertion() {
    return { assertion: this.authAssertion, status: "AUTHORIZED" as const };
  }
}

class FakeEmailVerificationAuthority implements EmailVerificationAuthorityPort {
  public async verifiedEmailEvidence(input: {
    readonly customerId: CustomerId;
    readonly emailNormalized: string;
    readonly correlationId: CorrelationId;
  }) {
    return {
      evidence: {
        customerId: input.customerId,
        emailNormalized: input.emailNormalized,
        provider: "TEST" as const,
        providerEvidenceId: `email:${input.correlationId}`,
        verifiedAt: now,
      },
      status: "AUTHORIZED" as const,
    };
  }
}

class FakeIdentityAuthority implements CustomerIdentityBindingAuthorityPort {
  public constructor(private readonly providerSubject: string) {}

  public async verifiedIdentitySubject() {
    return {
      provider: "TEST" as CustomerIdentityProvider,
      providerEvidenceId: `identity:${this.providerSubject}`,
      providerSubject: this.providerSubject,
      status: "AUTHORIZED" as const,
    };
  }
}

class FakeGuestOrderClaimAuthority implements GuestOrderClaimAuthorityPort {
  public constructor(
    private readonly expected: {
      readonly claimCode: string;
      readonly customerId: CustomerId;
      readonly orderId: OrderId;
    },
  ) {}

  public async verifiedGuestOrderClaim(input: {
    readonly principal: AuthenticatedCustomerPrincipal;
    readonly claimCode: string;
    readonly orderId?: OrderId;
    readonly correlationId: CorrelationId;
  }) {
    if (
      input.claimCode !== this.expected.claimCode ||
      input.principal.customerId !== this.expected.customerId ||
      (input.orderId !== undefined && input.orderId !== this.expected.orderId)
    ) {
      return { reasonCode: "CLAIM_INVALID", status: "DENIED" as const };
    }
    return {
      evidence: {
        actorId: "transport-guest-claim",
        actorType: "SERVICE",
        customerId: this.expected.customerId,
        expectedOrderVersion: 1,
        orderId: this.expected.orderId,
        providerEvidenceId: `transport-claim:${input.correlationId}`,
      } satisfies GuestOrderClaimEvidence,
      status: "AUTHORIZED" as const,
    };
  }
}

class CapturingAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class InstrumentedCustomerAuthenticationService extends CustomerAuthenticationService {
  public resolveCalls = 0;
  public createdSessionCount = 0;

  public override async createSession(
    input: Parameters<CustomerAuthenticationService["createSession"]>[0],
  ): ReturnType<CustomerAuthenticationService["createSession"]> {
    this.createdSessionCount += 1;
    return super.createSession(input);
  }

  public override async resolveSession(
    input: Parameters<CustomerAuthenticationService["resolveSession"]>[0],
  ): ReturnType<CustomerAuthenticationService["resolveSession"]> {
    this.resolveCalls += 1;
    return super.resolveSession(input);
  }
}

class CountingCustomerAccountReadRepository extends InMemoryCustomerAccountReadRepository {
  public summaryCalls = 0;
  public detailCalls = 0;
  public readonly listCalls: number[] = [];
  private readonly fulfillments = new Map<
    string,
    NonNullable<CustomerAccountOrderProjection["fulfillment"]>
  >();

  public constructor(private readonly throwOnSummary = false) {
    super();
  }

  public override addOrder(order: CustomerAccountOrderProjection): void {
    super.addOrder(order);
    if (order.fulfillment) {
      this.fulfillments.set(order.fulfillment.fulfillmentId, order.fulfillment);
    }
  }

  public override async findAccountSummary(
    input: Parameters<
      InMemoryCustomerAccountReadRepository["findAccountSummary"]
    >[0],
  ): ReturnType<InMemoryCustomerAccountReadRepository["findAccountSummary"]> {
    this.summaryCalls += 1;
    if (this.throwOnSummary) {
      throw new Error(internalFailureMarker);
    }
    return super.findAccountSummary(input);
  }

  public override async listOwnedOrders(
    input: Parameters<
      InMemoryCustomerAccountReadRepository["listOwnedOrders"]
    >[0],
  ): ReturnType<InMemoryCustomerAccountReadRepository["listOwnedOrders"]> {
    this.listCalls.push(input.limit);
    return super.listOwnedOrders(input);
  }

  public override async findOwnedOrderDetail(
    input: Parameters<
      InMemoryCustomerAccountReadRepository["findOwnedOrderDetail"]
    >[0],
  ): ReturnType<InMemoryCustomerAccountReadRepository["findOwnedOrderDetail"]> {
    this.detailCalls += 1;
    return super.findOwnedOrderDetail(input);
  }

  public fulfillmentSnapshot(fulfillmentId: string) {
    return this.fulfillments.get(fulfillmentId) ?? null;
  }
}

class CountingCustomerOrderIdentityRepository extends InMemoryCustomerOrderIdentityRepository {
  public orderOwnershipBindingCount = 0;

  public override async bindOrderOwnership(
    input: Parameters<
      InMemoryCustomerOrderIdentityRepository["bindOrderOwnership"]
    >[0],
  ): ReturnType<InMemoryCustomerOrderIdentityRepository["bindOrderOwnership"]> {
    this.orderOwnershipBindingCount += 1;
    return super.bindOrderOwnership(input);
  }
}

class AlwaysLimitedRateLimiter implements AuthenticatedCustomerDeliveryRateLimiter {
  public async check(): Promise<{ readonly status: "LIMITED" }> {
    return { status: "LIMITED" };
  }
}

class ThrowingRateLimiter implements AuthenticatedCustomerDeliveryRateLimiter {
  public async check(): Promise<never> {
    throw new Error("synthetic limiter outage");
  }
}

class CapturingRateLimiter implements AuthenticatedCustomerDeliveryRateLimiter {
  public readonly keys: string[] = [];

  public async check(input: {
    readonly key: string;
    readonly now: Date;
  }): Promise<{ readonly status: "ALLOWED" }> {
    this.keys.push(input.key);
    return { status: "ALLOWED" };
  }
}

class FakeKeyAccessDeliveryPort implements CustomerKeyDeliveryPort {
  public readonly calls: CustomerDeliveryAuthorization[] = [];
  public lastPlaintextSeen: string | null = null;

  public async deliver(input: {
    readonly authorization: CustomerDeliveryAuthorization;
    readonly plaintext: Buffer;
  }): Promise<CustomerKeyDeliveryPortResult> {
    this.calls.push(input.authorization);
    this.lastPlaintextSeen = input.plaintext.toString("utf8");
    return {
      channel: "FAKE",
      deliveredAt: now,
      deliveryReference: `ks0804-transport-delivery-${this.calls.length}`,
      status: "DELIVERED",
    };
  }
}

class CountingKeyProvider implements KeyManagementProvider {
  public unwraps = 0;

  public constructor(private readonly keyId: string) {}

  public async activeMasterKeyVersion(): Promise<string> {
    return this.keyId;
  }

  public async wrapDataKey(request: { readonly dataKey: Uint8Array }) {
    return {
      keyVersion: this.keyId,
      wrappedDataKey: Buffer.from(request.dataKey).map((byte) => byte ^ 0xa5),
    };
  }

  public async unwrapDataKey(request: {
    readonly wrappedDataKey: Uint8Array;
    readonly keyVersion: string;
  }) {
    this.unwraps += 1;
    if (request.keyVersion !== this.keyId) {
      throw new Error("wrong KS-08-04 transport key");
    }
    return Buffer.from(request.wrappedDataKey).map((byte) => byte ^ 0xa5);
  }

  public async getKeyVersionMetadata() {
    return { provider: "memory", version: this.keyId };
  }
}

class ThrowingChallengeRepository extends InMemoryCustomerRegistrationChallengeRepository {
  public constructor() {
    super(new InMemoryCustomerOrderIdentityRepository());
  }

  public override async consumeChallenge(): Promise<never> {
    throw new Error(`${internalFailureMarker} ${verificationToken}`);
  }
}

const safeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, child) =>
    typeof child === "bigint" ? child.toString() : child,
  );
