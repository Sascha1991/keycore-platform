import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  correlationId,
  customerId,
  orderLineId,
  type AuthenticatedCustomerPrincipal,
  type CorrelationId,
  type CustomerInvoiceAccessService,
  type CustomerAccountService,
  type CustomerOrderClaimResult,
  type CustomerId,
  type ProductKeyVaultService,
} from "../../packages/platform/src/contracts.js";
import { publishableStagingCatalog } from "./staging-catalog.js";
import {
  type StagingCheckoutPort,
  type StagingPaymentOutcome,
} from "./staging-checkout.js";

export interface StagingStorefrontRequest {
  readonly method: "GET" | "POST" | string;
  readonly path: string;
  readonly body: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly origin: string;
  readonly wpUserId?: string | undefined;
  readonly customerId?: string | undefined;
  readonly csrfVerified?: boolean | undefined;
  readonly remoteAddress?: string | undefined;
}

export interface StagingStorefrontResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface StagingGuestOrderClaimPort {
  claimGuestOrder(input: {
    readonly claimCode: string;
    readonly correlationId: CorrelationId;
    readonly principal: AuthenticatedCustomerPrincipal;
  }): Promise<CustomerOrderClaimResult>;
}

export interface StagingStorefrontBridgeOptions {
  readonly accountService: CustomerAccountService;
  readonly invoiceAccessService: CustomerInvoiceAccessService;
  readonly vaultService: ProductKeyVaultService;
  readonly checkout: StagingCheckoutPort;
  readonly guestOrderClaim: StagingGuestOrderClaimPort;
  readonly sharedSecret: string;
  readonly allowedOrigin: string;
  readonly identityMappings: ReadonlyMap<string, CustomerId>;
  readonly orderLines: ReadonlyMap<
    string,
    { customerId: CustomerId; orderLineId: string }
  >;
  readonly now?: (() => Date) | undefined;
  readonly maxClockSkewMs?: number | undefined;
  readonly revealLimit?: number | undefined;
  readonly revealWindowMs?: number | undefined;
  readonly claimLimit?: number | undefined;
  readonly claimWindowMs?: number | undefined;
}

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export class StagingStorefrontBridge {
  private readonly now: () => Date;
  private readonly maxClockSkewMs: number;
  private readonly revealLimit: number;
  private readonly revealWindowMs: number;
  private readonly claimLimit: number;
  private readonly claimWindowMs: number;
  private readonly revealBuckets = new Map<
    string,
    { startsAt: number; count: number }
  >();
  private readonly claimBuckets = new Map<
    string,
    { startsAt: number; count: number }
  >();

  public constructor(private readonly options: StagingStorefrontBridgeOptions) {
    if (Buffer.byteLength(options.sharedSecret, "utf8") < 32) {
      throw new Error("Staging storefront bridge secret is too short");
    }
    const allowed = parseOrigin(options.allowedOrigin);
    if (!allowed || !isAllowedStagingOrigin(allowed)) {
      throw new Error("Explicit KeyRaNo staging origin is required");
    }
    this.now = options.now ?? (() => new Date());
    this.maxClockSkewMs = options.maxClockSkewMs ?? 60_000;
    this.revealLimit = options.revealLimit ?? 5;
    this.revealWindowMs = options.revealWindowMs ?? 60_000;
    this.claimLimit = options.claimLimit ?? 5;
    this.claimWindowMs = options.claimWindowMs ?? 60_000;
  }

  public async handle(
    request: StagingStorefrontRequest,
  ): Promise<StagingStorefrontResponse> {
    const respond = (statusCode: number, payload: unknown) =>
      this.respond(statusCode, payload, request.signature);
    const authenticated = this.authenticateAdapter(request);
    if (!authenticated)
      return respond(403, { code: "ACCESS_DENIED", status: "ERROR" });

    if (request.method === "GET" && request.path === "/v1/catalog") {
      return respond(200, {
        products: publishableStagingCatalog().map((product) => ({
          activation: product.activation,
          currency: product.currency,
          description: product.description,
          platform: product.platform,
          priceMinor: product.priceMinor,
          publicationStatus: "PUBLISHABLE",
          publicReference: product.publicReference,
          region: product.region,
          title: product.title,
        })),
        status: "OK",
      });
    }

    const principal = this.resolvePrincipal(request);
    if (!principal) {
      return respond(401, {
        code: "AUTHENTICATION_REQUIRED",
        status: "ERROR",
      });
    }
    const requestCorrelationId = correlationId(`storefront-${randomUUID()}`);

    if (request.method === "POST" && request.path === "/v1/checkout") {
      if (!request.csrfVerified) {
        return respond(403, { code: "ACCESS_DENIED", status: "ERROR" });
      }
      const command = parseCheckoutBody(request.body);
      if (!command) {
        return respond(400, {
          code: "CHECKOUT_REQUEST_INVALID",
          status: "ERROR",
        });
      }
      const result = await this.options.checkout.checkout({
        ...command,
        customerId: principal.customerId,
      });
      const statusCode =
        result.status === "CAPTURED" || result.status === "IDEMPOTENT"
          ? 200
          : result.status === "FAILED"
            ? 402
            : result.status === "CANCELLED"
              ? 409
              : result.status === "DENIED"
                ? 422
                : 503;
      return respond(statusCode, result);
    }

    if (request.method === "POST" && request.path === "/v1/account/claim") {
      if (!request.csrfVerified) {
        return respond(403, { code: "ACCESS_DENIED", status: "ERROR" });
      }
      const command = parseGuestClaimBody(request.body);
      if (!command) {
        return respond(400, { code: "CLAIM_INVALID", status: "ERROR" });
      }
      if (!this.claimAllowed(principal.customerId)) {
        return respond(429, { code: "RATE_LIMITED", status: "ERROR" });
      }
      try {
        const result = await this.options.guestOrderClaim.claimGuestOrder({
          claimCode: command.claimCode,
          correlationId: requestCorrelationId,
          principal,
        });
        if (result.status !== "CLAIMED") {
          return respond(409, { code: "CLAIM_INVALID", status: "ERROR" });
        }
        return respond(200, { status: "CLAIMED" });
      } catch {
        return respond(503, {
          code: "TEMPORARILY_UNAVAILABLE",
          status: "ERROR",
        });
      }
    }

    if (request.method === "GET" && request.path === "/v1/account/orders") {
      const result = await this.options.accountService.listOwnedOrders({
        correlationId: requestCorrelationId,
        principal,
      });
      if (result.status !== "OK") return respond(404, unavailable());
      return respond(200, {
        orders: result.page.orders.map((order) => ({
          createdAt: order.createdAt,
          currency: order.currency,
          fulfillmentAvailable: order.fulfillmentAvailable,
          fulfillmentStatus: order.fulfillmentStatus,
          orderId: order.orderId,
          productTitle: order.productTitle ?? "Digitales Produkt",
          status: order.status,
          totalMinor: order.total.amountMinor.toString(),
        })),
        status: "OK",
      });
    }

    const match =
      /^\/v1\/account\/orders\/([0-9a-f-]{36})(\/(?:reveal|invoice))?$/iu.exec(
        request.path,
      );
    if (!match?.[1]) return respond(404, unavailable());
    const requestedOrderId = match[1];
    let detail;
    try {
      detail = await this.options.accountService.getOwnedOrderDetail({
        correlationId: requestCorrelationId,
        orderId: requestedOrderId,
        principal,
      });
    } catch {
      return respond(503, {
        code: "TEMPORARILY_UNAVAILABLE",
        status: "ERROR",
      });
    }
    if (detail.status !== "OK") return respond(404, unavailable());

    if (request.method === "GET" && !match[2]) {
      const order = detail.order;
      return respond(200, {
        order: {
          activationInstructions: order.activationInstructions,
          createdAt: order.createdAt,
          currency: order.currency,
          fulfillment: order.fulfillment,
          invoice: order.invoice,
          orderId: order.orderId,
          paymentStatus: order.paymentStatus,
          procurementStatus: order.procurementStatus,
          productTitle: order.productTitle ?? "Digitales Produkt",
          status: order.status,
          totalMinor: order.total.amountMinor.toString(),
          updatedAt: order.updatedAt,
        },
        status: "OK",
      });
    }

    if (request.method === "POST" && match[2] === "/invoice") {
      if (!request.csrfVerified) {
        return respond(403, { code: "ACCESS_DENIED", status: "ERROR" });
      }
      if (request.body !== "") {
        return respond(400, { code: "BAD_REQUEST", status: "ERROR" });
      }
      try {
        const result =
          await this.options.invoiceAccessService.getInvoiceDocument({
            correlationId: requestCorrelationId,
            orderId: requestedOrderId,
            principal,
          });
        if (result.status !== "OK") return respond(404, unavailable());
        return respond(200, {
          document: {
            body: Buffer.from(result.bytes).toString("base64"),
            contentType: result.contentType,
            encoding: "base64",
          },
          status: "AVAILABLE",
        });
      } catch {
        return respond(503, {
          code: "TEMPORARILY_UNAVAILABLE",
          status: "ERROR",
        });
      }
    }

    if (request.method !== "POST" || match[2] !== "/reveal") {
      return respond(404, unavailable());
    }
    if (!request.csrfVerified) {
      return respond(403, { code: "ACCESS_DENIED", status: "ERROR" });
    }
    if (!detail.order.fulfillment?.keyAccessAvailable) {
      return respond(409, { code: "KEY_NOT_AVAILABLE", status: "ERROR" });
    }
    if (!this.revealAllowed(principal.customerId, requestedOrderId)) {
      return respond(429, { code: "RATE_LIMITED", status: "ERROR" });
    }
    const binding = this.options.orderLines.get(requestedOrderId);
    if (!binding || binding.customerId !== principal.customerId) {
      return respond(404, unavailable());
    }

    let revealed: Uint8Array | null = null;
    try {
      revealed = await this.options.vaultService.retrieveForAuthorizedReveal({
        actor: { id: principal.customerId, type: "CUSTOMER" },
        correlationId: requestCorrelationId,
        customerId: principal.customerId,
        orderLineId: orderLineId(binding.orderLineId),
        reasonCode: "CUSTOMER_EXPLICIT_BROWSER_REVEAL",
      });
      const value = Buffer.from(revealed).toString("utf8");
      if (!value.startsWith("SYNTHETIC_"))
        throw new Error("Non-synthetic reveal blocked");
      return respond(200, { status: "REVEALED", value });
    } catch {
      return respond(404, unavailable());
    } finally {
      if (revealed)
        Buffer.from(
          revealed.buffer,
          revealed.byteOffset,
          revealed.byteLength,
        ).fill(0);
    }
  }

  private authenticateAdapter(request: StagingStorefrontRequest): boolean {
    const timestamp = Date.parse(request.timestamp);
    if (
      !Number.isFinite(timestamp) ||
      Math.abs(this.now().getTime() - timestamp) > this.maxClockSkewMs
    ) {
      return false;
    }
    const origin = parseOrigin(request.origin);
    if (!origin || origin !== parseOrigin(this.options.allowedOrigin))
      return false;
    const expected = signStagingStorefrontRequest(
      this.options.sharedSecret,
      request,
    );
    return constantTimeEqual(expected, request.signature);
  }

  private resolvePrincipal(request: StagingStorefrontRequest) {
    if (!request.wpUserId || !request.customerId) return null;
    const mapped = this.options.identityMappings.get(request.wpUserId);
    if (!mapped || mapped !== request.customerId) return null;
    return {
      authenticationContext: {
        assurance: "AUTHENTICATED" as const,
        provider: "WOOCOMMERCE" as const,
      },
      customerId: customerId(request.customerId),
    };
  }

  private revealAllowed(owner: CustomerId, order: string): boolean {
    const key = `${owner}:${order}`;
    const now = this.now().getTime();
    const current = this.revealBuckets.get(key);
    if (!current || now - current.startsAt >= this.revealWindowMs) {
      this.revealBuckets.set(key, { count: 1, startsAt: now });
      return true;
    }
    if (current.count >= this.revealLimit) return false;
    this.revealBuckets.set(key, {
      count: current.count + 1,
      startsAt: current.startsAt,
    });
    return true;
  }

  private claimAllowed(owner: CustomerId): boolean {
    const now = this.now().getTime();
    const current = this.claimBuckets.get(owner);
    if (!current || now - current.startsAt >= this.claimWindowMs) {
      this.claimBuckets.set(owner, { count: 1, startsAt: now });
      return true;
    }
    if (current.count >= this.claimLimit) return false;
    this.claimBuckets.set(owner, {
      count: current.count + 1,
      startsAt: current.startsAt,
    });
    return true;
  }

  private respond(
    statusCode: number,
    payload: unknown,
    requestSignature: string,
  ): StagingStorefrontResponse {
    const body = JSON.stringify(payload);
    const timestamp = this.now().toISOString();
    return {
      body,
      headers: {
        ...privateHeaders,
        "X-KeyRaNo-Response-Timestamp": timestamp,
        "X-KeyRaNo-Response-Signature": signStagingStorefrontResponse(
          this.options.sharedSecret,
          timestamp,
          statusCode,
          body,
          requestSignature,
        ),
      },
      statusCode,
    };
  }
}

const parseGuestClaimBody = (
  body: string,
): { readonly claimCode: string } | null => {
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 1 ||
      typeof record.claimCode !== "string" ||
      record.claimCode.length < 16 ||
      record.claimCode.length > 128
    ) {
      return null;
    }
    return { claimCode: record.claimCode };
  } catch {
    return null;
  }
};

export const signStagingStorefrontRequest = (
  secret: string,
  request: Omit<StagingStorefrontRequest, "signature">,
): string =>
  createHmac("sha256", secret)
    .update(
      [
        request.timestamp,
        request.method,
        request.path,
        request.origin,
        request.wpUserId ?? "",
        request.customerId ?? "",
        request.csrfVerified ? "1" : "0",
        createHash("sha256").update(request.body).digest("hex"),
      ].join("\n"),
    )
    .digest("base64url");

export const signStagingStorefrontResponse = (
  secret: string,
  timestamp: string,
  statusCode: number,
  body: string,
  requestSignature: string,
): string =>
  createHmac("sha256", secret)
    .update(
      `${timestamp}\n${statusCode}\n${requestSignature}\n${createHash("sha256").update(body).digest("hex")}`,
    )
    .digest("base64url");

const parseOrigin = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
      ? null
      : url.origin.toLowerCase();
  } catch {
    return null;
  }
};

const isAllowedStagingOrigin = (origin: string): boolean =>
  origin === "https://staging.keyrano.de" ||
  origin === "https://staging.example.invalid" ||
  /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/u.test(origin);

const constantTimeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const unavailable = () => ({ code: "RESOURCE_NOT_AVAILABLE", status: "ERROR" });

const parseCheckoutBody = (
  body: string,
): {
  readonly checkoutCreatedAt: string;
  readonly checkoutToken: string;
  readonly currency: string;
  readonly expectedTotalMinor: string;
  readonly outcome: StagingPaymentOutcome;
  readonly productReference: string;
  readonly quantity: number;
} | null => {
  try {
    const value = JSON.parse(body) as unknown;
    if (!isRecord(value)) return null;
    const expectedKeys = [
      "checkoutCreatedAt",
      "checkoutToken",
      "currency",
      "expectedTotalMinor",
      "outcome",
      "productReference",
      "quantity",
    ];
    if (
      Object.keys(value).sort().join("\n") !== expectedKeys.sort().join("\n") ||
      typeof value.checkoutCreatedAt !== "string" ||
      typeof value.checkoutToken !== "string" ||
      typeof value.currency !== "string" ||
      typeof value.expectedTotalMinor !== "string" ||
      !isPaymentOutcome(value.outcome) ||
      typeof value.productReference !== "string" ||
      typeof value.quantity !== "number"
    ) {
      return null;
    }
    return {
      checkoutCreatedAt: value.checkoutCreatedAt,
      checkoutToken: value.checkoutToken,
      currency: value.currency,
      expectedTotalMinor: value.expectedTotalMinor,
      outcome: value.outcome,
      productReference: value.productReference,
      quantity: value.quantity,
    };
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPaymentOutcome = (value: unknown): value is StagingPaymentOutcome =>
  value === "SUCCESS" || value === "FAILURE" || value === "CANCEL";
