import { createHash, randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type { CorrelationId } from "../domain/identifiers.js";
import { correlationId } from "../domain/identifiers.js";
import type { CustomerAuthenticationService } from "./customer-authentication.js";
import type {
  CustomerAccountService,
  CustomerAccountFailureCode,
  CustomerOrderDetail,
  CustomerOrderHistoryPage,
  CustomerAccountSummary,
} from "./customer-account.js";
import type {
  CustomerRegistrationService,
  CustomerEmailVerificationPublicResult,
  CustomerIdentityLinkResult,
  CustomerRegistrationResult,
} from "./customer-registration.js";
import type { AuthenticatedCustomerPrincipal } from "./customer-order-identity.js";
import type {
  AuthenticatedCustomerDeliveryCsrfPolicy,
  AuthenticatedCustomerDeliveryRateLimiter,
} from "../fulfillment/authenticated-customer-delivery.js";
import {
  normalizeCustomerTransportOrigin,
  parseAllowedOrigins,
} from "../fulfillment/authenticated-customer-delivery.js";

export const customerAccountTransportApiVersion = "v1" as const;

export type CustomerAccountTransportFailureCode =
  | "BAD_REQUEST"
  | "AUTHENTICATION_REQUIRED"
  | "ACCESS_DENIED"
  | "RESOURCE_NOT_AVAILABLE"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "TEMPORARILY_UNAVAILABLE";

export interface CustomerAccountTransportRequest {
  readonly method: "GET" | "POST" | string;
  readonly contentType?: string | null;
  readonly bodyByteLength: number;
  readonly sessionCredential?: string | null;
  readonly credentialSources?: CustomerAccountCredentialSources;
  readonly csrfHeader?: string | null;
  readonly csrfCookie?: string | null;
  readonly origin?: string | null;
  readonly remoteAddress?: string | null;
  readonly correlationIdHeader?: string | null;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly path?: Readonly<Record<string, string | undefined>>;
  readonly body?: Readonly<Record<string, unknown>>;
}

export interface CustomerAccountCredentialSources {
  readonly sessionCookie?: readonly string[];
  readonly authorizationHeader?: readonly string[];
  readonly sessionHeader?: readonly string[];
}

export interface CustomerAccountTransportResponse {
  readonly statusCode: 200 | 202 | 400 | 401 | 403 | 404 | 409 | 429 | 503;
  readonly headers: Readonly<Record<string, string>>;
  readonly body:
    | {
        readonly status: "OK";
        readonly apiVersion: typeof customerAccountTransportApiVersion;
        readonly account: CustomerAccountSummary;
      }
    | {
        readonly status: "OK";
        readonly apiVersion: typeof customerAccountTransportApiVersion;
        readonly page: CustomerOrderHistoryPage;
      }
    | {
        readonly status: "OK";
        readonly apiVersion: typeof customerAccountTransportApiVersion;
        readonly order: CustomerOrderDetail;
      }
    | {
        readonly status: "REGISTRATION_ACCEPTED";
        readonly apiVersion: typeof customerAccountTransportApiVersion;
      }
    | {
        readonly status: CustomerEmailVerificationPublicResult["status"];
        readonly apiVersion: typeof customerAccountTransportApiVersion;
      }
    | {
        readonly status: Extract<
          CustomerIdentityLinkResult["status"],
          "BOUND" | "ALREADY_BOUND"
        >;
        readonly apiVersion: typeof customerAccountTransportApiVersion;
      }
    | {
        readonly status: "ERROR";
        readonly apiVersion: typeof customerAccountTransportApiVersion;
        readonly code: CustomerAccountTransportFailureCode;
        readonly correlationId: CorrelationId;
      };
}

export interface CustomerAccountTransportConfig {
  readonly allowedOrigins: readonly string[];
  readonly maxBodyBytes: number;
}

export const customerAccountTransportConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): CustomerAccountTransportConfig => ({
  allowedOrigins: parseAllowedOrigins(
    env.KEYCORE_CUSTOMER_ALLOWED_ORIGINS,
    customerTransportEnvironmentFromEnv(env),
  ),
  maxBodyBytes: readPositiveInt(
    env.KEYCORE_CUSTOMER_ACCOUNT_MAX_BODY_BYTES,
    4096,
    "KEYCORE_CUSTOMER_ACCOUNT_MAX_BODY_BYTES",
  ),
});

export class CustomerAccountTransportHandler {
  private readonly now: () => Date;
  private readonly environment: AuditEvent["environment"];
  private readonly allowedOrigins: ReadonlySet<string>;

  public constructor(
    private readonly options: {
      readonly sessionService: CustomerAuthenticationService;
      readonly accountService: CustomerAccountService;
      readonly registrationService: CustomerRegistrationService;
      readonly csrfPolicy: AuthenticatedCustomerDeliveryCsrfPolicy;
      readonly rateLimiter: AuthenticatedCustomerDeliveryRateLimiter;
      readonly config: CustomerAccountTransportConfig;
      readonly environment?: AuditEvent["environment"];
      readonly now?: () => Date;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.environment = options.environment ?? "LOCAL";
    this.allowedOrigins = new Set(
      options.config.allowedOrigins.map((origin) =>
        requiredOrigin(
          normalizeCustomerTransportOrigin(origin, this.environment),
        ),
      ),
    );
    if (
      this.allowedOrigins.size === 0 ||
      !Number.isSafeInteger(options.config.maxBodyBytes) ||
      options.config.maxBodyBytes <= 0
    ) {
      throw new Error("Customer account transport config is invalid");
    }
  }

  public async getAccountSummary(
    request: CustomerAccountTransportRequest,
  ): Promise<CustomerAccountTransportResponse> {
    const common = this.validateReadRequest(request, "account-summary");
    if (common.status !== "VALID") {
      return common.response;
    }
    const principal = await this.resolvePrincipal(
      common.sessionCredential,
      common.correlationId,
    );
    if (!principal) {
      return this.error(401, "AUTHENTICATION_REQUIRED", common.correlationId);
    }
    const result = await this.safeAccountCall(
      this.options.accountService.getAccountSummary({
        correlationId: common.correlationId,
        principal,
      }),
      common.correlationId,
    );
    if (result.status === "TRANSPORT_FAILURE") {
      return result.response;
    }
    if (result.status !== "OK") {
      return this.mapAccountFailure(result.code, common.correlationId);
    }
    return {
      body: {
        account: result.account,
        apiVersion: customerAccountTransportApiVersion,
        status: "OK",
      },
      headers: accountReadHeaders,
      statusCode: 200,
    };
  }

  public async listOwnedOrders(
    request: CustomerAccountTransportRequest,
  ): Promise<CustomerAccountTransportResponse> {
    const common = this.validateReadRequest(request, "order-history");
    if (common.status !== "VALID") {
      return common.response;
    }
    const limit = parseLimit(request.query?.limit);
    if (limit === "INVALID") {
      return this.error(400, "BAD_REQUEST", common.correlationId);
    }
    const cursor = request.query?.cursor;
    if (cursor !== undefined && !isSafeCursor(cursor)) {
      return this.error(400, "BAD_REQUEST", common.correlationId);
    }
    const principal = await this.resolvePrincipal(
      common.sessionCredential,
      common.correlationId,
    );
    if (!principal) {
      return this.error(401, "AUTHENTICATION_REQUIRED", common.correlationId);
    }
    const result = await this.safeAccountCall(
      this.options.accountService.listOwnedOrders({
        correlationId: common.correlationId,
        ...(cursor ? { cursor } : {}),
        ...(limit === undefined ? {} : { limit }),
        principal,
      }),
      common.correlationId,
    );
    if (result.status === "TRANSPORT_FAILURE") {
      return result.response;
    }
    if (result.status !== "OK") {
      return this.mapAccountFailure(result.code, common.correlationId);
    }
    return {
      body: {
        apiVersion: customerAccountTransportApiVersion,
        page: result.page,
        status: "OK",
      },
      headers: accountReadHeaders,
      statusCode: 200,
    };
  }

  public async getOwnedOrderDetail(
    request: CustomerAccountTransportRequest,
  ): Promise<CustomerAccountTransportResponse> {
    const common = this.validateReadRequest(request, "order-detail");
    if (common.status !== "VALID") {
      return common.response;
    }
    const rawOrderId = request.path?.orderId;
    if (!isSafeUuid(rawOrderId)) {
      return this.error(400, "BAD_REQUEST", common.correlationId);
    }
    const principal = await this.resolvePrincipal(
      common.sessionCredential,
      common.correlationId,
    );
    if (!principal) {
      return this.error(401, "AUTHENTICATION_REQUIRED", common.correlationId);
    }
    const result = await this.safeAccountCall(
      this.options.accountService.getOwnedOrderDetail({
        correlationId: common.correlationId,
        orderId: rawOrderId,
        principal,
      }),
      common.correlationId,
    );
    if (result.status === "TRANSPORT_FAILURE") {
      return result.response;
    }
    if (result.status !== "OK") {
      return this.mapAccountFailure(result.code, common.correlationId);
    }
    return {
      body: {
        apiVersion: customerAccountTransportApiVersion,
        order: result.order,
        status: "OK",
      },
      headers: accountReadHeaders,
      statusCode: 200,
    };
  }

  public async register(
    request: CustomerAccountTransportRequest,
  ): Promise<CustomerAccountTransportResponse> {
    const common = await this.validatePublicMutation(request, "register");
    if (common.status !== "VALID") {
      return common.response;
    }
    const email = request.body?.email;
    if (typeof email !== "string" || !onlyFields(request.body, ["email"])) {
      return this.error(400, "BAD_REQUEST", common.correlationId);
    }
    const limited = await this.rateLimiterAllows("register", email, request);
    if (limited !== "ALLOWED") {
      return this.limiterError(limited, common.correlationId);
    }
    const result = await this.safeRegistrationCall(
      this.options.registrationService.register({
        correlationId: common.correlationId,
        email,
        ...(request.remoteAddress
          ? { ipHash: stableHash(request.remoteAddress) }
          : {}),
      }),
      common.correlationId,
    );
    if (result.status === "TRANSPORT_FAILURE") {
      return result.response;
    }
    if (result.status === "REGISTRATION_ACCEPTED") {
      return {
        body: {
          apiVersion: customerAccountTransportApiVersion,
          status: "REGISTRATION_ACCEPTED",
        },
        headers: mutationHeaders,
        statusCode: 202,
      };
    }
    return this.mapRegistrationFailure(result, common.correlationId);
  }

  public async verifyEmail(
    request: CustomerAccountTransportRequest,
  ): Promise<CustomerAccountTransportResponse> {
    const common = await this.validatePublicMutation(request, "verify-email");
    if (common.status !== "VALID") {
      return common.response;
    }
    const token = request.body?.verificationToken;
    if (
      typeof token !== "string" ||
      !onlyFields(request.body, ["verificationToken"])
    ) {
      return this.error(400, "BAD_REQUEST", common.correlationId);
    }
    const limited = await this.rateLimiterAllows(
      "verify-email",
      stableHash(token),
      request,
    );
    if (limited !== "ALLOWED") {
      return this.limiterError(limited, common.correlationId);
    }
    const result = await this.safeVerificationCall(
      this.options.registrationService.verifyEmail({
        correlationId: common.correlationId,
        rawVerificationToken: token,
      }),
      common.correlationId,
    );
    if (result.status === "TRANSPORT_FAILURE") {
      return result.response;
    }
    return {
      body: {
        apiVersion: customerAccountTransportApiVersion,
        status: result.status,
      },
      headers: verificationHeaders,
      statusCode: result.status === "VERIFIED" ? 200 : 400,
    };
  }

  public async linkIdentity(
    request: CustomerAccountTransportRequest,
  ): Promise<CustomerAccountTransportResponse> {
    const common = await this.validateAuthenticatedMutation(
      request,
      "link-identity",
    );
    if (common.status !== "VALID") {
      return common.response;
    }
    if (!onlyFields(request.body, [])) {
      return this.error(400, "BAD_REQUEST", common.correlationId);
    }
    const principal = await this.resolvePrincipal(
      common.sessionCredential,
      common.correlationId,
    );
    if (!principal) {
      return this.error(401, "AUTHENTICATION_REQUIRED", common.correlationId);
    }
    const limited = await this.rateLimiterAllows(
      "link-identity",
      common.sessionCredential,
      request,
    );
    if (limited !== "ALLOWED") {
      return this.limiterError(limited, common.correlationId);
    }
    const result = await this.safeIdentityLinkCall(
      this.options.registrationService.linkExternalIdentity({
        correlationId: common.correlationId,
        principal,
      }),
      common.correlationId,
    );
    if (result.status === "TRANSPORT_FAILURE") {
      return result.response;
    }
    if (result.status === "BOUND" || result.status === "ALREADY_BOUND") {
      return {
        body: {
          apiVersion: customerAccountTransportApiVersion,
          status: result.status,
        },
        headers: mutationHeaders,
        statusCode: 200,
      };
    }
    if (result.status === "IDENTITY_CONFLICT") {
      return this.error(409, "CONFLICT", common.correlationId);
    }
    if (result.status === "AUTHENTICATION_REQUIRED") {
      return this.error(401, "AUTHENTICATION_REQUIRED", common.correlationId);
    }
    return this.error(403, "ACCESS_DENIED", common.correlationId);
  }

  private validateReadRequest(
    request: CustomerAccountTransportRequest,
    route: string,
  ):
    | {
        readonly status: "VALID";
        readonly correlationId: CorrelationId;
        readonly sessionCredential: string;
      }
    | {
        readonly status: "INVALID";
        readonly response: CustomerAccountTransportResponse;
      } {
    const correlation = safeCorrelationId(request.correlationIdHeader, route);
    if (
      request.method !== "GET" ||
      request.bodyByteLength !== 0 ||
      hasDangerousAuthorityFields(request.body)
    ) {
      return {
        response: this.error(400, "BAD_REQUEST", correlation),
        status: "INVALID",
      };
    }
    if (!this.originAllowed(request.origin)) {
      return {
        response: this.error(403, "ACCESS_DENIED", correlation),
        status: "INVALID",
      };
    }
    const credential = extractCustomerAccountSessionCredential(request);
    if (credential.status !== "OK") {
      return {
        response: this.error(401, "AUTHENTICATION_REQUIRED", correlation),
        status: "INVALID",
      };
    }
    return {
      correlationId: correlation,
      sessionCredential: credential.sessionCredential,
      status: "VALID",
    };
  }

  private validatePublicMutation(
    request: CustomerAccountTransportRequest,
    route: string,
  ):
    | { readonly status: "VALID"; readonly correlationId: CorrelationId }
    | {
        readonly status: "INVALID";
        readonly response: CustomerAccountTransportResponse;
      } {
    const correlation = safeCorrelationId(request.correlationIdHeader, route);
    if (
      request.method !== "POST" ||
      !isJsonContentType(request.contentType) ||
      !this.validBodySize(request.bodyByteLength) ||
      hasDangerousAuthorityFields(request.body)
    ) {
      return {
        response: this.error(400, "BAD_REQUEST", correlation),
        status: "INVALID",
      };
    }
    if (!this.originAllowed(request.origin)) {
      return {
        response: this.error(403, "ACCESS_DENIED", correlation),
        status: "INVALID",
      };
    }
    return { correlationId: correlation, status: "VALID" };
  }

  private validateAuthenticatedMutation(
    request: CustomerAccountTransportRequest,
    route: string,
  ):
    | {
        readonly status: "VALID";
        readonly correlationId: CorrelationId;
        readonly sessionCredential: string;
      }
    | {
        readonly status: "INVALID";
        readonly response: CustomerAccountTransportResponse;
      } {
    const mutation = this.validatePublicMutation(request, route);
    if (mutation.status !== "VALID") {
      return mutation;
    }
    const credential = extractCustomerAccountSessionCredential(request);
    if (credential.status !== "OK") {
      return {
        response: this.error(
          401,
          "AUTHENTICATION_REQUIRED",
          mutation.correlationId,
        ),
        status: "INVALID",
      };
    }
    try {
      const csrf = this.options.csrfPolicy.validate({
        csrfCookie: request.csrfCookie,
        csrfHeader: request.csrfHeader,
        sessionCredential: credential.sessionCredential,
      });
      if (csrf.status !== "VALID") {
        return {
          response: this.error(403, "ACCESS_DENIED", mutation.correlationId),
          status: "INVALID",
        };
      }
    } catch {
      return {
        response: this.error(403, "ACCESS_DENIED", mutation.correlationId),
        status: "INVALID",
      };
    }
    return {
      correlationId: mutation.correlationId,
      sessionCredential: credential.sessionCredential,
      status: "VALID",
    };
  }

  private async resolvePrincipal(
    sessionCredential: string,
    correlationIdValue: CorrelationId,
  ): Promise<AuthenticatedCustomerPrincipal | null> {
    const result = await this.options.sessionService.resolveSession({
      correlationId: correlationIdValue,
      rawSessionToken: sessionCredential,
    });
    return result.status === "AUTHENTICATED" ? result.principal : null;
  }

  private async safeAccountCall<
    TResult extends
      | { readonly status: "OK" }
      | {
          readonly status: "DENIED";
          readonly code: CustomerAccountFailureCode;
        },
  >(
    operation: Promise<TResult>,
    correlationIdValue: CorrelationId,
  ): Promise<
    | TResult
    | {
        readonly status: "TRANSPORT_FAILURE";
        readonly response: CustomerAccountTransportResponse;
      }
  > {
    try {
      return await operation;
    } catch {
      return {
        response: this.error(
          503,
          "TEMPORARILY_UNAVAILABLE",
          correlationIdValue,
        ),
        status: "TRANSPORT_FAILURE",
      };
    }
  }

  private async safeRegistrationCall(
    operation: Promise<CustomerRegistrationResult>,
    correlationIdValue: CorrelationId,
  ): Promise<
    | CustomerRegistrationResult
    | {
        readonly status: "TRANSPORT_FAILURE";
        readonly response: CustomerAccountTransportResponse;
      }
  > {
    try {
      return await operation;
    } catch {
      return {
        response: this.error(
          503,
          "TEMPORARILY_UNAVAILABLE",
          correlationIdValue,
        ),
        status: "TRANSPORT_FAILURE",
      };
    }
  }

  private async safeVerificationCall(
    operation: Promise<CustomerEmailVerificationPublicResult>,
    correlationIdValue: CorrelationId,
  ): Promise<
    | CustomerEmailVerificationPublicResult
    | {
        readonly status: "TRANSPORT_FAILURE";
        readonly response: CustomerAccountTransportResponse;
      }
  > {
    try {
      return await operation;
    } catch {
      return {
        response: this.error(
          503,
          "TEMPORARILY_UNAVAILABLE",
          correlationIdValue,
        ),
        status: "TRANSPORT_FAILURE",
      };
    }
  }

  private async safeIdentityLinkCall(
    operation: Promise<CustomerIdentityLinkResult>,
    correlationIdValue: CorrelationId,
  ): Promise<
    | CustomerIdentityLinkResult
    | {
        readonly status: "TRANSPORT_FAILURE";
        readonly response: CustomerAccountTransportResponse;
      }
  > {
    try {
      return await operation;
    } catch {
      return {
        response: this.error(
          503,
          "TEMPORARILY_UNAVAILABLE",
          correlationIdValue,
        ),
        status: "TRANSPORT_FAILURE",
      };
    }
  }

  private originAllowed(origin: string | null | undefined): boolean {
    if (!origin) {
      return false;
    }
    const normalized = normalizeCustomerTransportOrigin(
      origin,
      this.environment,
    );
    return Boolean(normalized && this.allowedOrigins.has(normalized));
  }

  private validBodySize(bodyByteLength: number): boolean {
    return (
      Number.isSafeInteger(bodyByteLength) &&
      bodyByteLength >= 0 &&
      bodyByteLength <= this.options.config.maxBodyBytes
    );
  }

  private async rateLimiterAllows(
    route: string,
    subject: string,
    request: CustomerAccountTransportRequest,
  ): Promise<"ALLOWED" | "LIMITED" | "UNAVAILABLE"> {
    try {
      const result = await this.options.rateLimiter.check({
        key: stableHash(
          JSON.stringify({
            ip: request.remoteAddress ?? null,
            route,
            subject: stableHash(subject),
          }),
        ),
        now: this.now(),
      });
      return result.status === "ALLOWED" ? "ALLOWED" : "LIMITED";
    } catch {
      return "UNAVAILABLE";
    }
  }

  private limiterError(
    status: "LIMITED" | "UNAVAILABLE",
    correlationIdValue: CorrelationId,
  ): CustomerAccountTransportResponse {
    return status === "LIMITED"
      ? this.error(429, "RATE_LIMITED", correlationIdValue)
      : this.error(503, "TEMPORARILY_UNAVAILABLE", correlationIdValue);
  }

  private mapAccountFailure(
    code: "AUTHENTICATION_REQUIRED" | "RESOURCE_NOT_AVAILABLE" | "BAD_REQUEST",
    correlationIdValue: CorrelationId,
  ): CustomerAccountTransportResponse {
    if (code === "AUTHENTICATION_REQUIRED") {
      return this.error(401, "AUTHENTICATION_REQUIRED", correlationIdValue);
    }
    if (code === "BAD_REQUEST") {
      return this.error(400, "BAD_REQUEST", correlationIdValue);
    }
    return this.error(404, "RESOURCE_NOT_AVAILABLE", correlationIdValue);
  }

  private mapRegistrationFailure(
    result: Extract<
      CustomerRegistrationResult,
      { status: "REGISTRATION_DENIED" }
    >,
    correlationIdValue: CorrelationId,
  ): CustomerAccountTransportResponse {
    if (result.reasonCode === "RATE_LIMITED") {
      return this.error(429, "RATE_LIMITED", correlationIdValue);
    }
    if (result.reasonCode === "DELIVERY_FAILED") {
      return this.error(503, "TEMPORARILY_UNAVAILABLE", correlationIdValue);
    }
    return this.error(400, "BAD_REQUEST", correlationIdValue);
  }

  private error(
    statusCode: CustomerAccountTransportResponse["statusCode"],
    code: CustomerAccountTransportFailureCode,
    correlationIdValue: CorrelationId,
  ): CustomerAccountTransportResponse {
    return {
      body: {
        apiVersion: customerAccountTransportApiVersion,
        code,
        correlationId: correlationIdValue,
        status: "ERROR",
      },
      headers: mutationHeaders,
      statusCode,
    };
  }
}

export const customerAccountTransportCookiePolicy =
  "HttpOnly; Secure; SameSite=Lax; Path=/";

export const accountReadHeaders = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

export const mutationHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export const verificationHeaders = mutationHeaders;

export const woocommerceCustomerAccountTrustBoundary = {
  emailOnlyAuthentication: "DENIED",
  emailOnlyIdentityLinking: "DENIED",
  emailOnlyOrderClaim: "DENIED",
  sourceOfTruth: "KEYCORE",
} as const;

export const extractCustomerAccountSessionCredential = (
  request: Pick<
    CustomerAccountTransportRequest,
    "sessionCredential" | "credentialSources"
  >,
):
  | { readonly status: "OK"; readonly sessionCredential: string }
  | {
      readonly status: "MISSING" | "AMBIGUOUS" | "INVALID";
    } => {
  const candidates = [
    ...(request.sessionCredential === undefined
      ? []
      : [request.sessionCredential]),
    ...(request.credentialSources?.sessionCookie ?? []),
    ...(request.credentialSources?.authorizationHeader ?? []).map(
      parseBearerCredential,
    ),
    ...(request.credentialSources?.sessionHeader ?? []),
  ];
  const present = candidates.filter(
    (candidate): candidate is string =>
      candidate !== null && candidate !== undefined,
  );
  if (present.length === 0) {
    return { status: "MISSING" };
  }
  if (present.some((candidate) => candidate.trim() !== candidate)) {
    return { status: "INVALID" };
  }
  if (present.some((candidate) => !isSafeSessionCredential(candidate))) {
    return { status: "INVALID" };
  }
  const unique = new Set(present);
  if (present.length !== 1 || unique.size !== 1) {
    return { status: "AMBIGUOUS" };
  }
  const [sessionCredential] = present;
  if (!sessionCredential) {
    return { status: "MISSING" };
  }
  return { sessionCredential, status: "OK" };
};

const parseLimit = (
  raw: string | undefined,
): number | undefined | "INVALID" => {
  if (raw === undefined) {
    return undefined;
  }
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    return "INVALID";
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : "INVALID";
};

const onlyFields = (
  body: Readonly<Record<string, unknown>> | undefined,
  allowed: readonly string[],
): boolean => {
  if (!body || Object.getPrototypeOf(body) !== Object.prototype) {
    return allowed.length === 0;
  }
  const allowedSet = new Set(allowed);
  return Object.keys(body).every((key) => allowedSet.has(key));
};

const hasDangerousAuthorityFields = (
  body: Readonly<Record<string, unknown>> | undefined,
): boolean => {
  if (!body || Object.getPrototypeOf(body) !== Object.prototype) {
    return false;
  }
  return [
    "customerId",
    "providerSubject",
    "orderOwner",
    "supplierOrderId",
    "supplierId",
    "externalSupplierOrderId",
    "fulfillmentId",
    "fulfillmentReference",
    "verificationState",
    "emailVerificationState",
    "authenticatedPrincipal",
    "sessionPrincipal",
    "deliveryCapability",
    "rawSessionToken",
  ].some((field) => field in body);
};

const safeCorrelationId = (
  raw: string | null | undefined,
  route: string,
): CorrelationId => {
  if (raw && /^[A-Za-z0-9._:-]{1,96}$/u.test(raw)) {
    return correlationId(raw);
  }
  return correlationId(`customer-account-${route}-${randomUUID()}`);
};

const isJsonContentType = (contentType: string | null | undefined): boolean => {
  const [mediaType = "", ...parameters] = (contentType ?? "")
    .split(";")
    .map((part) => part.trim().toLowerCase());
  return (
    mediaType === "application/json" &&
    parameters.every((parameter) => /^charset=[a-z0-9._-]+$/u.test(parameter))
  );
};

const isSafeUuid = (value: string | undefined): value is string =>
  Boolean(
    value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    ),
  );

const isSafeCursor = (value: string): boolean =>
  value.length <= 1024 && /^[A-Za-z0-9_.-]+$/u.test(value);

const isSafeSessionCredential = (value: string): boolean =>
  value.length >= 43 && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value);

const parseBearerCredential = (value: string): string =>
  value.startsWith("Bearer ") ? value.slice("Bearer ".length) : value;

const stableHash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const requiredOrigin = (value: string | null): string => {
  if (!value) {
    throw new Error("Customer account transport origin is invalid");
  }
  return value;
};

const customerTransportEnvironmentFromEnv = (
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
