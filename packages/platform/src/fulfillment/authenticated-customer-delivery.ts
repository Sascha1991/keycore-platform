import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type {
  CorrelationId,
  CustomerId,
  OrderId,
} from "../domain/identifiers.js";
import { correlationId, orderId } from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import type { CustomerAuthenticationService } from "../customers/customer-authentication.js";
import type {
  CustomerKeyDeliveryExecuteResult,
  CustomerKeyDeliveryPrepareResult,
  CustomerKeyDeliveryService,
} from "./customer-key-delivery.js";

export type AuthenticatedDeliveryFailureCode =
  | "AUTHENTICATION_REQUIRED"
  | "ACCESS_DENIED"
  | "RESOURCE_NOT_AVAILABLE"
  | "DELIVERY_NOT_AVAILABLE"
  | "RATE_LIMITED"
  | "TEMPORARILY_UNAVAILABLE"
  | "BAD_REQUEST";

export interface AuthenticatedDeliveryTransportRequest {
  readonly method: "POST" | string;
  readonly contentType: string;
  readonly bodyByteLength: number;
  readonly sessionCredential?: string | null;
  readonly csrfHeader?: string | null;
  readonly csrfCookie?: string | null;
  readonly origin?: string | null;
  readonly remoteAddress?: string | null;
  readonly correlationIdHeader?: string | null;
  readonly body: {
    readonly orderId?: string;
    readonly fulfillmentReference?: string;
    readonly deliveryApprovalId?: string;
    readonly deliveryCapability?: string;
    readonly customerId?: string;
    readonly externalSupplierOrderId?: string;
    readonly supplierId?: string;
  };
}

export interface AuthenticatedDeliveryTransportResponse {
  readonly statusCode: 200 | 201 | 400 | 401 | 403 | 404 | 409 | 429 | 503;
  readonly body:
    | {
        readonly status: "AUTHORIZED";
        readonly deliveryApprovalId: string;
        readonly deliveryCapability: string;
        readonly expiresAt: string;
      }
    | {
        readonly status:
          | "DELIVERED"
          | "ALREADY_DELIVERED"
          | "IN_FLIGHT"
          | "MANUAL_REVIEW_REQUIRED";
        readonly fulfillmentId?: string;
      }
    | {
        readonly status: "ERROR";
        readonly code: AuthenticatedDeliveryFailureCode;
      };
  readonly headers: Readonly<Record<string, string>>;
}

export interface AuthenticatedCustomerDeliveryRateLimiter {
  check(input: {
    readonly key: string;
    readonly now: Date;
  }): Promise<{ readonly status: "ALLOWED" } | { readonly status: "LIMITED" }>;
}

export interface AuthenticatedCustomerDeliveryCsrfPolicy {
  validate(input: {
    readonly sessionCredential: string;
    readonly csrfHeader: string | null | undefined;
    readonly csrfCookie: string | null | undefined;
  }): { readonly status: "VALID" } | { readonly status: "INVALID" };
}

export interface AuthenticatedCustomerDeliveryTransportConfig {
  readonly allowedOrigins: readonly string[];
  readonly maxBodyBytes: number;
  readonly rateLimitWindowMs: number;
  readonly rateLimitMax: number;
}

export const authenticatedCustomerDeliveryConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): AuthenticatedCustomerDeliveryTransportConfig => ({
  allowedOrigins: parseAllowedOrigins(
    env.KEYCORE_CUSTOMER_ALLOWED_ORIGINS,
    deliveryEnvironmentFromEnv(env),
  ),
  maxBodyBytes: readPositiveInt(
    env.KEYCORE_CUSTOMER_DELIVERY_MAX_BODY_BYTES,
    4096,
    "KEYCORE_CUSTOMER_DELIVERY_MAX_BODY_BYTES",
  ),
  rateLimitMax: readPositiveInt(
    env.KEYCORE_CUSTOMER_DELIVERY_RATE_LIMIT_MAX,
    10,
    "KEYCORE_CUSTOMER_DELIVERY_RATE_LIMIT_MAX",
  ),
  rateLimitWindowMs: readPositiveInt(
    env.KEYCORE_CUSTOMER_DELIVERY_RATE_LIMIT_WINDOW_MS,
    60_000,
    "KEYCORE_CUSTOMER_DELIVERY_RATE_LIMIT_WINDOW_MS",
  ),
});

export class AuthenticatedCustomerDeliveryTransportHandler {
  private readonly now: () => Date;
  private readonly environment: AuditEvent["environment"];
  private readonly allowedOrigins: ReadonlySet<string>;

  public constructor(
    private readonly options: {
      readonly sessionService: CustomerAuthenticationService;
      readonly deliveryService: CustomerKeyDeliveryService;
      readonly csrfPolicy: AuthenticatedCustomerDeliveryCsrfPolicy;
      readonly rateLimiter: AuthenticatedCustomerDeliveryRateLimiter;
      readonly config: AuthenticatedCustomerDeliveryTransportConfig;
      readonly audit?: AuditEventPort;
      readonly environment?: AuditEvent["environment"];
      readonly now?: () => Date;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.environment = options.environment ?? "LOCAL";
    this.allowedOrigins = new Set(
      options.config.allowedOrigins.map((origin) =>
        requiredOrigin(normalizeOrigin(origin, this.environment)),
      ),
    );
    if (
      options.config.allowedOrigins.length === 0 ||
      !Number.isSafeInteger(options.config.maxBodyBytes) ||
      options.config.maxBodyBytes <= 0 ||
      this.allowedOrigins.size === 0
    ) {
      throw new Error("Authenticated delivery transport config is invalid");
    }
  }

  public async prepareDelivery(
    request: AuthenticatedDeliveryTransportRequest,
  ): Promise<AuthenticatedDeliveryTransportResponse> {
    const common = await this.validateCommonRequest(request);
    if (common.status !== "VALID") {
      return this.error(common.statusCode, common.code);
    }
    const resource = parseResource(request);
    if (!resource) {
      return this.error(400, "BAD_REQUEST");
    }
    const principal = await this.resolvePrincipal(
      request,
      common.correlationId,
    );
    if (principal.status !== "AUTHENTICATED") {
      return this.error(401, "AUTHENTICATION_REQUIRED");
    }
    const limited = await this.rateLimiterAllows(
      principal.sessionId,
      resource.fulfillmentId,
      request.remoteAddress,
    );
    if (limited === "UNAVAILABLE") {
      return this.error(503, "TEMPORARILY_UNAVAILABLE");
    }
    if (limited === "LIMITED") {
      await this.auditDenied(
        common.correlationId,
        resource.fulfillmentId,
        "RATE_LIMITED",
      );
      return this.error(429, "RATE_LIMITED");
    }
    const result = await this.options.deliveryService.prepareDelivery({
      correlationId: common.correlationId,
      customerId: principal.customerId,
      fulfillmentId: resource.fulfillmentId,
      orderId: resource.orderId,
    });
    if (result.status !== "AUTHORIZED") {
      await this.auditDenied(
        common.correlationId,
        resource.fulfillmentId,
        "RESOURCE_NOT_AVAILABLE",
      );
      return this.mapPrepareFailure(result);
    }
    await this.auditEvent({
      correlationId: common.correlationId,
      eventType: "CUSTOMER_DELIVERY_AUTHORIZED",
      fulfillmentId: resource.fulfillmentId,
      outcome: "SUCCEEDED",
      reasonCode: result.reasonCode,
    });
    return {
      body: {
        deliveryCapability: required(result.oneTimeCapability),
        deliveryApprovalId: required(result.deliveryApprovalId),
        expiresAt: required(result.expiresAt),
        status: "AUTHORIZED",
      },
      headers: secretResponseHeaders,
      statusCode: 201,
    };
  }

  public async executeDelivery(
    request: AuthenticatedDeliveryTransportRequest,
  ): Promise<AuthenticatedDeliveryTransportResponse> {
    const common = await this.validateCommonRequest(request);
    if (common.status !== "VALID") {
      return this.error(common.statusCode, common.code);
    }
    const resource = parseResource(request);
    if (
      !resource ||
      !isSafeOpaqueId(request.body.deliveryApprovalId) ||
      !isSafeSecretInput(request.body.deliveryCapability)
    ) {
      return this.error(400, "BAD_REQUEST");
    }
    const principal = await this.resolvePrincipal(
      request,
      common.correlationId,
    );
    if (principal.status !== "AUTHENTICATED") {
      return this.error(401, "AUTHENTICATION_REQUIRED");
    }
    const limited = await this.rateLimiterAllows(
      principal.sessionId,
      resource.fulfillmentId,
      request.remoteAddress,
    );
    if (limited === "UNAVAILABLE") {
      return this.error(503, "TEMPORARILY_UNAVAILABLE");
    }
    if (limited === "LIMITED") {
      await this.auditDenied(
        common.correlationId,
        resource.fulfillmentId,
        "RATE_LIMITED",
      );
      return this.error(429, "RATE_LIMITED");
    }
    const result = await this.options.deliveryService.executeDelivery({
      capability: request.body.deliveryCapability,
      channel: "FAKE",
      correlationId: common.correlationId,
      customerId: principal.customerId,
      deliveryApprovalId: request.body.deliveryApprovalId,
      fulfillmentId: resource.fulfillmentId,
      orderId: resource.orderId,
    });
    return this.mapExecuteResult(common.correlationId, result);
  }

  private async validateCommonRequest(
    request: AuthenticatedDeliveryTransportRequest,
  ): Promise<
    | { readonly status: "VALID"; readonly correlationId: CorrelationId }
    | {
        readonly status: "INVALID";
        readonly statusCode: AuthenticatedDeliveryTransportResponse["statusCode"];
        readonly code: AuthenticatedDeliveryFailureCode;
      }
  > {
    if (
      request.method !== "POST" ||
      !isJsonContentType(request.contentType) ||
      !Number.isSafeInteger(request.bodyByteLength) ||
      request.bodyByteLength < 0 ||
      request.bodyByteLength > this.options.config.maxBodyBytes
    ) {
      return { code: "BAD_REQUEST", status: "INVALID", statusCode: 400 };
    }
    if (!request.sessionCredential) {
      return {
        code: "AUTHENTICATION_REQUIRED",
        status: "INVALID",
        statusCode: 401,
      };
    }
    if (!this.originAllowed(request.origin)) {
      return { code: "ACCESS_DENIED", status: "INVALID", statusCode: 403 };
    }
    let csrfResult:
      { readonly status: "VALID" } | { readonly status: "INVALID" };
    try {
      csrfResult = this.options.csrfPolicy.validate({
        csrfCookie: request.csrfCookie,
        csrfHeader: request.csrfHeader,
        sessionCredential: request.sessionCredential,
      });
    } catch {
      return { code: "ACCESS_DENIED", status: "INVALID", statusCode: 403 };
    }
    if (csrfResult.status !== "VALID") {
      return { code: "ACCESS_DENIED", status: "INVALID", statusCode: 403 };
    }
    return {
      correlationId: safeCorrelationId(request.correlationIdHeader),
      status: "VALID",
    };
  }

  private async resolvePrincipal(
    request: AuthenticatedDeliveryTransportRequest,
    correlationIdValue: CorrelationId,
  ): Promise<
    | {
        readonly status: "AUTHENTICATED";
        readonly customerId: CustomerId;
        readonly sessionId: string;
      }
    | { readonly status: "DENIED" }
  > {
    if (!request.sessionCredential) {
      return { status: "DENIED" };
    }
    const resolved = await this.options.sessionService.resolveSession({
      correlationId: correlationIdValue,
      rawSessionToken: request.sessionCredential,
    });
    return resolved.status === "AUTHENTICATED"
      ? {
          customerId: resolved.principal.customerId,
          sessionId: resolved.sessionId,
          status: "AUTHENTICATED",
        }
      : { status: "DENIED" };
  }

  private originAllowed(origin: string | null | undefined): boolean {
    if (!origin) {
      return false;
    }
    const normalized = normalizeOrigin(origin, this.environment);
    return Boolean(normalized && this.allowedOrigins.has(normalized));
  }

  private async rateLimiterAllows(
    sessionId: string,
    fulfillmentId: string,
    remoteAddress: string | null | undefined,
  ): Promise<"ALLOWED" | "LIMITED" | "UNAVAILABLE"> {
    const key = stableHash(
      JSON.stringify({
        fulfillmentId,
        remoteAddress: remoteAddress ?? null,
        sessionId,
      }),
    );
    try {
      const result = await this.options.rateLimiter.check({
        key,
        now: this.now(),
      });
      return result.status === "ALLOWED" ? "ALLOWED" : "LIMITED";
    } catch {
      return "UNAVAILABLE";
    }
  }

  private mapPrepareFailure(
    result: CustomerKeyDeliveryPrepareResult,
  ): AuthenticatedDeliveryTransportResponse {
    const code =
      result.reasonCode === "FULFILLMENT_LIVE_DELIVERY_DISABLED"
        ? "DELIVERY_NOT_AVAILABLE"
        : "RESOURCE_NOT_AVAILABLE";
    return this.error(code === "DELIVERY_NOT_AVAILABLE" ? 409 : 404, code);
  }

  private async mapExecuteResult(
    correlationIdValue: CorrelationId,
    result: CustomerKeyDeliveryExecuteResult,
  ): Promise<AuthenticatedDeliveryTransportResponse> {
    if (result.status === "DELIVERED") {
      await this.auditEvent({
        correlationId: correlationIdValue,
        eventType: "CUSTOMER_DELIVERY_COMPLETED",
        fulfillmentId: result.fulfillmentId ?? "unknown",
        outcome: "SUCCEEDED",
        reasonCode: result.reasonCode,
      });
      return {
        body: {
          ...optionalFulfillmentId(result.fulfillmentId),
          status: "DELIVERED",
        },
        headers: secretResponseHeaders,
        statusCode: 200,
      };
    }
    if (result.status === "ALREADY_DELIVERED") {
      return {
        body: {
          ...optionalFulfillmentId(result.fulfillmentId),
          status: "ALREADY_DELIVERED",
        },
        headers: secretResponseHeaders,
        statusCode: 409,
      };
    }
    if (result.status === "IN_FLIGHT") {
      return {
        body: {
          ...optionalFulfillmentId(result.fulfillmentId),
          status: "IN_FLIGHT",
        },
        headers: secretResponseHeaders,
        statusCode: 409,
      };
    }
    if (result.status === "MANUAL_REVIEW_REQUIRED") {
      await this.auditEvent({
        correlationId: correlationIdValue,
        eventType: "CUSTOMER_DELIVERY_MANUAL_REVIEW_REQUIRED",
        fulfillmentId: result.fulfillmentId ?? "unknown",
        outcome: "FAILED",
        reasonCode: result.reasonCode,
      });
      return {
        body: {
          ...optionalFulfillmentId(result.fulfillmentId),
          status: "MANUAL_REVIEW_REQUIRED",
        },
        headers: secretResponseHeaders,
        statusCode: 409,
      };
    }
    const code =
      result.status === "FAILED_RETRYABLE"
        ? "TEMPORARILY_UNAVAILABLE"
        : "DELIVERY_NOT_AVAILABLE";
    return this.error(code === "TEMPORARILY_UNAVAILABLE" ? 503 : 409, code);
  }

  private error(
    statusCode: AuthenticatedDeliveryTransportResponse["statusCode"],
    code: AuthenticatedDeliveryFailureCode,
  ): AuthenticatedDeliveryTransportResponse {
    return {
      body: { code, status: "ERROR" },
      headers: secretResponseHeaders,
      statusCode,
    };
  }

  private async auditDenied(
    correlationIdValue: CorrelationId,
    fulfillmentId: string,
    reasonCode: AuthenticatedDeliveryFailureCode,
  ): Promise<void> {
    await this.auditEvent({
      correlationId: correlationIdValue,
      eventType: "CUSTOMER_DELIVERY_DENIED",
      fulfillmentId,
      outcome: "DENIED",
      reasonCode,
    });
  }

  private async auditEvent(input: {
    readonly correlationId: CorrelationId;
    readonly fulfillmentId: string;
    readonly eventType: AuditEvent["eventType"];
    readonly outcome: AuditEvent["outcome"];
    readonly reasonCode: string;
  }): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "authenticated-customer-delivery", type: "SERVICE" },
      correlationId: input.correlationId,
      entity: { id: input.fulfillmentId, type: "FULFILLMENT_OPERATION" },
      environment: this.environment,
      eventType: input.eventType,
      metadata: {
        fulfillmentId: input.fulfillmentId,
        reasonCode: input.reasonCode,
      },
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }
}

export class HmacDoubleSubmitCsrfPolicy implements AuthenticatedCustomerDeliveryCsrfPolicy {
  public constructor(private readonly secret: string) {
    if (Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("Customer delivery CSRF secret is too short");
    }
  }

  public createToken(sessionCredential: string): string {
    const nonce = randomBytes(16).toString("base64url");
    return `v1.${nonce}.${this.signature(sessionCredential, nonce)}`;
  }

  public validate(input: {
    readonly sessionCredential: string;
    readonly csrfHeader: string | null | undefined;
    readonly csrfCookie: string | null | undefined;
  }): { readonly status: "VALID" } | { readonly status: "INVALID" } {
    if (
      !input.csrfHeader ||
      !input.csrfCookie ||
      input.csrfHeader !== input.csrfCookie
    ) {
      return { status: "INVALID" };
    }
    const parts = input.csrfHeader.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
      return { status: "INVALID" };
    }
    const expected = this.signature(input.sessionCredential, parts[1]);
    return constantTimeEqual(expected, parts[2])
      ? { status: "VALID" }
      : { status: "INVALID" };
  }

  private signature(sessionCredential: string, nonce: string): string {
    return createHmac("sha256", this.secret)
      .update(`${stableHash(sessionCredential)}.${nonce}`)
      .digest("base64url");
  }
}

export class InMemoryAuthenticatedDeliveryRateLimiter implements AuthenticatedCustomerDeliveryRateLimiter {
  private readonly buckets = new Map<
    string,
    { readonly startsAt: number; readonly count: number }
  >();

  public constructor(
    private readonly config: {
      readonly windowMs: number;
      readonly max: number;
    },
  ) {
    if (
      !Number.isSafeInteger(config.windowMs) ||
      config.windowMs <= 0 ||
      !Number.isSafeInteger(config.max) ||
      config.max <= 0
    ) {
      throw new Error("Customer delivery rate limiter config is invalid");
    }
  }

  public async check(input: {
    readonly key: string;
    readonly now: Date;
  }): Promise<{ readonly status: "ALLOWED" } | { readonly status: "LIMITED" }> {
    const nowMs = input.now.getTime();
    const current = this.buckets.get(input.key);
    if (!current || nowMs - current.startsAt >= this.config.windowMs) {
      this.buckets.set(input.key, { count: 1, startsAt: nowMs });
      return { status: "ALLOWED" };
    }
    if (current.count >= this.config.max) {
      return { status: "LIMITED" };
    }
    this.buckets.set(input.key, {
      count: current.count + 1,
      startsAt: current.startsAt,
    });
    return { status: "ALLOWED" };
  }
}

export const authenticatedDeliveryCookiePolicy =
  "HttpOnly; Secure; SameSite=Lax; Path=/";

export const secretResponseHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export const parseAllowedOrigins = (
  raw: string | undefined,
  environment: AuditEvent["environment"] = "PRODUCTION",
): readonly string[] => {
  if (!raw) {
    throw new Error("KEYCORE_CUSTOMER_ALLOWED_ORIGINS_REQUIRED");
  }
  const origins = raw
    .split(",")
    .map((origin) => normalizeOrigin(origin.trim(), environment))
    .filter((origin): origin is string => Boolean(origin));
  if (origins.length === 0 || origins.some((origin) => origin === "*")) {
    throw new Error("KEYCORE_CUSTOMER_ALLOWED_ORIGINS_INVALID");
  }
  return [...new Set(origins)].sort();
};

const parseResource = (
  request: AuthenticatedDeliveryTransportRequest,
): { readonly orderId: OrderId; readonly fulfillmentId: string } | null => {
  if (
    !isSafeUuid(request.body.orderId) ||
    !isSafeUuid(request.body.fulfillmentReference) ||
    request.body.externalSupplierOrderId ||
    request.body.supplierId ||
    request.body.customerId
  ) {
    return null;
  }
  return {
    fulfillmentId: request.body.fulfillmentReference,
    orderId: orderId(request.body.orderId),
  };
};

const safeCorrelationId = (raw: string | null | undefined): CorrelationId => {
  if (raw && /^[A-Za-z0-9._:-]{1,96}$/u.test(raw)) {
    return correlationId(raw);
  }
  return correlationId(`cust-delivery-${randomUUID()}`);
};

const normalizeOrigin = (
  origin: string,
  environment: AuditEvent["environment"],
): string | null => {
  try {
    const parsed = new URL(origin);
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.pathname !== "/"
    ) {
      return null;
    }
    if (parsed.protocol === "https:") {
      return parsed.origin;
    }
    if (
      parsed.protocol !== "http:" ||
      !localHttpOriginsAllowed(environment) ||
      parsed.hostname !== "localhost"
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
};

const localHttpOriginsAllowed = (
  environment: AuditEvent["environment"],
): boolean => environment === "LOCAL" || environment === "CI";

const isJsonContentType = (contentType: string): boolean => {
  const [mediaType = "", ...parameters] = contentType
    .split(";")
    .map((part) => part.trim().toLowerCase());
  return (
    mediaType === "application/json" &&
    parameters.every((parameter) => /^charset=[a-z0-9._-]+$/u.test(parameter))
  );
};

const deliveryEnvironmentFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): AuditEvent["environment"] => {
  const raw = env.KEYCORE_ENVIRONMENT ?? env.NODE_ENV;
  return raw === "PRODUCTION" ||
    raw === "STAGING" ||
    raw === "CI" ||
    raw === "LOCAL"
    ? raw
    : "PRODUCTION";
};

const readPositiveInt = (
  raw: string | undefined,
  fallback: number,
  name: string,
): number => {
  if (raw === undefined) {
    return fallback;
  }
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new Error(`${name}_INVALID`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name}_INVALID`);
  }
  return parsed;
};

const isSafeUuid = (value: string | undefined): value is string =>
  Boolean(
    value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    ),
  );

const isSafeOpaqueId = (value: string | undefined): value is string =>
  Boolean(value && /^[A-Za-z0-9_-]{1,128}$/u.test(value));

const isSafeSecretInput = (value: string | undefined): value is string =>
  Boolean(value && /^[A-Za-z0-9_-]{43,128}$/u.test(value));

const stableHash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const required = (value: string | undefined): string => {
  if (!value) {
    throw new Error("Expected authenticated delivery value");
  }
  return value;
};

const requiredOrigin = (value: string | null): string => {
  if (!value) {
    throw new Error("Authenticated delivery origin is invalid");
  }
  return value;
};

const optionalFulfillmentId = (
  fulfillmentId: string | undefined,
): { readonly fulfillmentId?: string } =>
  fulfillmentId ? { fulfillmentId } : {};
