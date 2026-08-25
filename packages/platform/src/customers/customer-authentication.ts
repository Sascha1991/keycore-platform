import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type { CorrelationId, CustomerId } from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import type {
  AuthenticatedCustomerPrincipal,
  AuthenticatedCustomerPrincipalProvider,
  CustomerIdentityBinding,
  CustomerIdentityProvider,
  KeyCoreCustomer,
} from "./customer-order-identity.js";
import { isSafeProviderSubject } from "./customer-order-identity.js";

export type CustomerAuthenticationAssurance = "TEST" | "AUTHENTICATED";

export interface VerifiedCustomerAuthenticationAssertion {
  readonly provider: CustomerIdentityProvider;
  readonly providerSubject: string;
  readonly assurance: CustomerAuthenticationAssurance;
  readonly authenticatedAt: Date;
  readonly expiresAt: Date;
  readonly authContextId: string;
}

export interface CustomerAuthenticationAuthorityPort {
  verifiedAuthenticationAssertion(input: {
    readonly correlationId: CorrelationId;
  }): Promise<
    | {
        readonly status: "AUTHORIZED";
        readonly assertion: VerifiedCustomerAuthenticationAssertion;
      }
    | { readonly status: "DENIED"; readonly reasonCode?: string }
  >;
}

export class FailClosedCustomerAuthenticationAuthority implements CustomerAuthenticationAuthorityPort {
  public async verifiedAuthenticationAssertion(): Promise<{
    readonly status: "DENIED";
    readonly reasonCode: "UNTRUSTED_AUTHORITY";
  }> {
    return { reasonCode: "UNTRUSTED_AUTHORITY", status: "DENIED" };
  }
}

export interface CustomerAuthSession {
  readonly id: string;
  readonly customerId: CustomerId;
  readonly identityBindingId: string;
  readonly provider: CustomerIdentityProvider;
  readonly sessionTokenHash: string;
  readonly createdAt: Date;
  readonly authenticatedAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly revokedAt: Date | null;
  readonly recordVersion: number;
  readonly authAssurance: CustomerAuthenticationAssurance;
  readonly authContextId: string;
}

export type CustomerSessionStatus =
  "ACTIVE" | "EXPIRED" | "IDLE_TIMEOUT" | "REVOKED" | "INVALID";

export interface CustomerAuthSessionInspection {
  readonly sessionId: string;
  readonly customerId: CustomerId;
  readonly identityBindingId: string;
  readonly provider: CustomerIdentityProvider;
  readonly authAssurance: CustomerAuthenticationAssurance;
  readonly authContextId: string;
  readonly status: CustomerSessionStatus;
  readonly createdAt: Date;
  readonly authenticatedAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly revokedAt: Date | null;
  readonly recordVersion: number;
}

export interface CustomerAuthSessionRepository {
  findIdentityBindingByProviderSubject(input: {
    readonly provider: CustomerIdentityProvider;
    readonly providerSubject: string;
  }): Promise<CustomerIdentityBinding | null>;
  findIdentityBindingById(input: {
    readonly identityBindingId: string;
  }): Promise<CustomerIdentityBinding | null>;
  findCustomerById(customerId: CustomerId): Promise<KeyCoreCustomer | null>;
  createSession(input: {
    readonly session: CustomerAuthSession;
  }): Promise<
    | { readonly status: "CREATED"; readonly session: CustomerAuthSession }
    | { readonly status: "TOKEN_HASH_COLLISION" }
    | { readonly status: "CUSTOMER_NOT_FOUND" }
    | { readonly status: "IDENTITY_BINDING_NOT_FOUND" }
  >;
  findSessionByTokenHash(input: {
    readonly sessionTokenHash: string;
  }): Promise<CustomerAuthSession | null>;
  touchSession(input: {
    readonly sessionId: string;
    readonly minLastSeenAt: Date;
    readonly now: Date;
  }): Promise<void>;
  rotateSessionToken(input: {
    readonly sessionId: string;
    readonly expectedTokenHash: string;
    readonly nextTokenHash: string;
    readonly now: Date;
  }): Promise<
    | { readonly status: "ROTATED"; readonly session: CustomerAuthSession }
    | { readonly status: "STALE_SESSION" }
    | { readonly status: "TOKEN_HASH_COLLISION" }
  >;
  revokeSessionById(input: {
    readonly sessionId: string;
    readonly now: Date;
  }): Promise<"REVOKED" | "ALREADY_REVOKED" | "NOT_FOUND">;
  revokeAllCustomerSessions(input: {
    readonly customerId: CustomerId;
    readonly now: Date;
  }): Promise<{ readonly revokedCount: number }>;
  inspectSession(input: {
    readonly sessionId: string;
  }): Promise<CustomerAuthSession | null>;
}

export interface CustomerAuthenticationConfig {
  readonly ttlMs: number;
  readonly idleTimeoutMs: number;
  readonly touchIntervalMs: number;
}

export const defaultCustomerAuthenticationConfig =
  (): CustomerAuthenticationConfig => ({
    idleTimeoutMs: 3_600_000,
    touchIntervalMs: 300_000,
    ttlMs: 28_800_000,
  });

export const customerAuthenticationConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): CustomerAuthenticationConfig => {
  const defaults = defaultCustomerAuthenticationConfig();
  return {
    idleTimeoutMs: readPositiveInteger(
      env.KEYCORE_CUSTOMER_SESSION_IDLE_TIMEOUT_MS,
      defaults.idleTimeoutMs,
      "KEYCORE_CUSTOMER_SESSION_IDLE_TIMEOUT_MS",
    ),
    touchIntervalMs: readPositiveInteger(
      env.KEYCORE_CUSTOMER_SESSION_TOUCH_INTERVAL_MS,
      defaults.touchIntervalMs,
      "KEYCORE_CUSTOMER_SESSION_TOUCH_INTERVAL_MS",
    ),
    ttlMs: readPositiveInteger(
      env.KEYCORE_CUSTOMER_SESSION_TTL_MS,
      defaults.ttlMs,
      "KEYCORE_CUSTOMER_SESSION_TTL_MS",
    ),
  };
};

export type CustomerSessionCreationResult =
  | {
      readonly status: "CREATED";
      readonly sessionId: string;
      readonly customerId: CustomerId;
      readonly rawSessionToken: string;
      readonly expiresAt: Date;
    }
  | { readonly status: "AUTHENTICATION_FAILED"; readonly reasonCode: string }
  | { readonly status: "IDENTITY_UNBOUND" }
  | { readonly status: "CUSTOMER_NOT_FOUND" }
  | { readonly status: "INVALID_AUTHENTICATION_CONTEXT" }
  | { readonly status: "TOKEN_HASH_COLLISION" };

export type CustomerSessionResolutionResult =
  | {
      readonly status: "AUTHENTICATED";
      readonly principal: AuthenticatedCustomerPrincipal;
      readonly sessionId: string;
      readonly expiresAt: Date;
    }
  | {
      readonly status: Exclude<CustomerSessionStatus, "ACTIVE">;
      readonly reasonCode: string;
    };

export type CustomerSessionRotationResult =
  | {
      readonly status: "ROTATED";
      readonly sessionId: string;
      readonly rawSessionToken: string;
      readonly expiresAt: Date;
    }
  | {
      readonly status:
        Exclude<CustomerSessionStatus, "ACTIVE"> | "STALE_SESSION";
      readonly reasonCode: string;
    }
  | { readonly status: "TOKEN_HASH_COLLISION" };

export class CustomerAuthenticationService {
  private readonly now: () => Date;
  private readonly authority: CustomerAuthenticationAuthorityPort;
  private readonly config: CustomerAuthenticationConfig;
  private readonly environment: AuditEvent["environment"];

  public constructor(
    private readonly options: {
      readonly repository: CustomerAuthSessionRepository;
      readonly authority?: CustomerAuthenticationAuthorityPort;
      readonly config?: CustomerAuthenticationConfig;
      readonly audit?: AuditEventPort;
      readonly environment?: AuditEvent["environment"];
      readonly now?: () => Date;
      readonly tokenFactory?: () => string;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.authority =
      options.authority ?? new FailClosedCustomerAuthenticationAuthority();
    this.config = validateCustomerAuthenticationConfig(
      options.config ?? defaultCustomerAuthenticationConfig(),
    );
    this.environment = options.environment ?? "LOCAL";
  }

  public async createSession(input: {
    readonly correlationId: CorrelationId;
  }): Promise<CustomerSessionCreationResult> {
    const assertionResult =
      await this.authority.verifiedAuthenticationAssertion({
        correlationId: input.correlationId,
      });
    if (assertionResult.status !== "AUTHORIZED") {
      await this.auditAuthFailure(input.correlationId, "UNTRUSTED_AUTHORITY");
      return {
        reasonCode: assertionResult.reasonCode ?? "UNTRUSTED_AUTHORITY",
        status: "AUTHENTICATION_FAILED",
      };
    }
    const assertion = assertionResult.assertion;
    if (!this.isTrustedAssertion(assertion)) {
      await this.auditAuthFailure(
        input.correlationId,
        "INVALID_AUTHENTICATION_CONTEXT",
      );
      return { status: "INVALID_AUTHENTICATION_CONTEXT" };
    }
    const binding =
      await this.options.repository.findIdentityBindingByProviderSubject({
        provider: assertion.provider,
        providerSubject: assertion.providerSubject,
      });
    if (!binding) {
      await this.auditAuthFailure(input.correlationId, "IDENTITY_UNBOUND");
      return { status: "IDENTITY_UNBOUND" };
    }
    const customer = await this.options.repository.findCustomerById(
      binding.customerId,
    );
    if (!customer) {
      return { status: "CUSTOMER_NOT_FOUND" };
    }

    const now = this.now();
    const expiresAt = minDate(
      assertion.expiresAt,
      new Date(now.getTime() + this.config.ttlMs),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rawSessionToken = this.createRawToken();
      const session: CustomerAuthSession = {
        authAssurance: "AUTHENTICATED",
        authContextId: assertion.authContextId,
        authenticatedAt: assertion.authenticatedAt,
        createdAt: now,
        customerId: binding.customerId,
        expiresAt,
        id: randomUUID(),
        identityBindingId: binding.id,
        lastSeenAt: now,
        provider: assertion.provider,
        recordVersion: 1,
        revokedAt: null,
        sessionTokenHash: hashCustomerSessionToken(rawSessionToken),
      };
      const result = await this.options.repository.createSession({ session });
      if (result.status === "CREATED") {
        await this.audit({
          correlationId: input.correlationId,
          customerId: binding.customerId,
          entityId: result.session.id,
          eventType: "CUSTOMER_SESSION_CREATED",
          outcome: "SUCCEEDED",
          reasonCode: "CREATED",
          metadata: {
            authAssurance: result.session.authAssurance,
            authContextId: result.session.authContextId,
            authRecordId: result.session.id,
            provider: result.session.provider,
          },
        });
        return {
          customerId: binding.customerId,
          expiresAt: result.session.expiresAt,
          rawSessionToken,
          sessionId: result.session.id,
          status: "CREATED",
        };
      }
      if (result.status !== "TOKEN_HASH_COLLISION") {
        return {
          status:
            result.status === "IDENTITY_BINDING_NOT_FOUND"
              ? "IDENTITY_UNBOUND"
              : result.status,
        };
      }
    }
    return { status: "TOKEN_HASH_COLLISION" };
  }

  public async resolveSession(input: {
    readonly rawSessionToken: string;
    readonly correlationId: CorrelationId;
  }): Promise<CustomerSessionResolutionResult> {
    const session = await this.loadSession(input.rawSessionToken);
    if (!session) {
      return { reasonCode: "SESSION_INVALID", status: "INVALID" };
    }
    const validity = await this.validateSession(session);
    if (validity.status !== "ACTIVE") {
      return {
        reasonCode: `SESSION_${validity.status}`,
        status: validity.status,
      };
    }
    await this.options.repository.touchSession({
      minLastSeenAt: new Date(
        this.now().getTime() - this.config.touchIntervalMs,
      ),
      now: this.now(),
      sessionId: session.id,
    });
    return {
      expiresAt: session.expiresAt,
      principal: {
        authenticationContext: {
          assurance: "AUTHENTICATED",
          provider: session.provider,
        },
        customerId: session.customerId,
      },
      sessionId: session.id,
      status: "AUTHENTICATED",
    };
  }

  public async rotateSession(input: {
    readonly rawSessionToken: string;
    readonly correlationId: CorrelationId;
  }): Promise<CustomerSessionRotationResult> {
    const session = await this.loadSession(input.rawSessionToken);
    if (!session) {
      return { reasonCode: "SESSION_INVALID", status: "INVALID" };
    }
    const validity = await this.validateSession(session);
    if (validity.status !== "ACTIVE") {
      return {
        reasonCode: `SESSION_${validity.status}`,
        status: validity.status,
      };
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rawSessionToken = this.createRawToken();
      const result = await this.options.repository.rotateSessionToken({
        expectedTokenHash: session.sessionTokenHash,
        nextTokenHash: hashCustomerSessionToken(rawSessionToken),
        now: this.now(),
        sessionId: session.id,
      });
      if (result.status === "ROTATED") {
        await this.audit({
          correlationId: input.correlationId,
          customerId: result.session.customerId,
          entityId: result.session.id,
          eventType: "CUSTOMER_SESSION_ROTATED",
          outcome: "SUCCEEDED",
          reasonCode: "ROTATED",
          metadata: {
            authAssurance: result.session.authAssurance,
            authContextId: result.session.authContextId,
            authRecordId: result.session.id,
            provider: result.session.provider,
          },
        });
        return {
          expiresAt: result.session.expiresAt,
          rawSessionToken,
          sessionId: result.session.id,
          status: "ROTATED",
        };
      }
      if (result.status !== "TOKEN_HASH_COLLISION") {
        return { reasonCode: result.status, status: result.status };
      }
    }
    return { status: "TOKEN_HASH_COLLISION" };
  }

  public async revokeSession(input: {
    readonly rawSessionToken: string;
    readonly correlationId: CorrelationId;
  }): Promise<{ readonly status: "REVOKED" | "ALREADY_REVOKED" | "INVALID" }> {
    const session = await this.loadSession(input.rawSessionToken);
    if (!session) {
      return { status: "INVALID" };
    }
    const status = await this.options.repository.revokeSessionById({
      now: this.now(),
      sessionId: session.id,
    });
    if (status !== "NOT_FOUND") {
      await this.audit({
        correlationId: input.correlationId,
        customerId: session.customerId,
        entityId: session.id,
        eventType: "CUSTOMER_SESSION_REVOKED",
        outcome: "SUCCEEDED",
        reasonCode: status,
        metadata: {
          authRecordId: session.id,
          provider: session.provider,
          reasonCode: status,
        },
      });
    }
    return { status: status === "NOT_FOUND" ? "INVALID" : status };
  }

  public async revokeAllForCustomer(input: {
    readonly customerId: CustomerId;
    readonly correlationId: CorrelationId;
  }): Promise<{ readonly status: "REVOKED"; readonly revokedCount: number }> {
    const result = await this.options.repository.revokeAllCustomerSessions({
      customerId: input.customerId,
      now: this.now(),
    });
    await this.audit({
      correlationId: input.correlationId,
      customerId: input.customerId,
      entityId: input.customerId,
      eventType: "CUSTOMER_SESSION_REVOKED",
      outcome: "SUCCEEDED",
      reasonCode: "REVOKED_ALL",
      metadata: { affectedRecords: result.revokedCount },
    });
    return { revokedCount: result.revokedCount, status: "REVOKED" };
  }

  public async inspectSession(input: {
    readonly sessionId: string;
  }): Promise<CustomerAuthSessionInspection | null> {
    const session = await this.options.repository.inspectSession(input);
    return session
      ? {
          authAssurance: session.authAssurance,
          authContextId: session.authContextId,
          authenticatedAt: session.authenticatedAt,
          createdAt: session.createdAt,
          customerId: session.customerId,
          expiresAt: session.expiresAt,
          identityBindingId: session.identityBindingId,
          lastSeenAt: session.lastSeenAt,
          provider: session.provider,
          recordVersion: session.recordVersion,
          revokedAt: session.revokedAt,
          sessionId: session.id,
          status: this.inspectStatus(session),
        }
      : null;
  }

  private async loadSession(
    rawSessionToken: string,
  ): Promise<CustomerAuthSession | null> {
    if (!isPlausibleCustomerSessionToken(rawSessionToken)) {
      return null;
    }
    return this.options.repository.findSessionByTokenHash({
      sessionTokenHash: hashCustomerSessionToken(rawSessionToken),
    });
  }

  private async validateSession(
    session: CustomerAuthSession,
  ): Promise<{ readonly status: CustomerSessionStatus }> {
    const now = this.now();
    if (session.revokedAt) {
      return { status: "REVOKED" };
    }
    if (session.expiresAt.getTime() <= now.getTime()) {
      return { status: "EXPIRED" };
    }
    if (
      now.getTime() - session.lastSeenAt.getTime() >
      this.config.idleTimeoutMs
    ) {
      return { status: "IDLE_TIMEOUT" };
    }
    if (session.authAssurance !== "AUTHENTICATED") {
      return { status: "INVALID" };
    }
    const customer = await this.options.repository.findCustomerById(
      session.customerId,
    );
    if (!customer) {
      return { status: "INVALID" };
    }
    const binding = await this.options.repository.findIdentityBindingById({
      identityBindingId: session.identityBindingId,
    });
    if (
      !binding ||
      binding.id !== session.identityBindingId ||
      binding.customerId !== session.customerId ||
      binding.provider !== session.provider
    ) {
      return { status: "INVALID" };
    }
    return { status: "ACTIVE" };
  }

  private inspectStatus(session: CustomerAuthSession): CustomerSessionStatus {
    const now = this.now();
    if (session.revokedAt) {
      return "REVOKED";
    }
    if (session.expiresAt.getTime() <= now.getTime()) {
      return "EXPIRED";
    }
    if (
      now.getTime() - session.lastSeenAt.getTime() >
      this.config.idleTimeoutMs
    ) {
      return "IDLE_TIMEOUT";
    }
    return session.authAssurance === "AUTHENTICATED" ? "ACTIVE" : "INVALID";
  }

  private isTrustedAssertion(
    assertion: VerifiedCustomerAuthenticationAssertion,
  ): boolean {
    const now = this.now().getTime();
    return (
      assertion.assurance === "AUTHENTICATED" &&
      isSafeProviderSubject(assertion.providerSubject) &&
      assertion.authContextId.length > 0 &&
      assertion.authContextId.length <= 120 &&
      assertion.authContextId === assertion.authContextId.trim() &&
      assertion.authenticatedAt.getTime() <= now &&
      assertion.expiresAt.getTime() > now &&
      assertion.expiresAt.getTime() > assertion.authenticatedAt.getTime()
    );
  }

  private createRawToken(): string {
    return this.options.tokenFactory?.() ?? generateCustomerSessionToken();
  }

  private async audit(input: {
    readonly correlationId: CorrelationId;
    readonly customerId: CustomerId;
    readonly entityId: string;
    readonly eventType: AuditEvent["eventType"];
    readonly outcome: AuditEvent["outcome"];
    readonly reasonCode: string;
    readonly metadata: Readonly<Record<string, string | number | boolean>>;
  }): Promise<void> {
    await this.options.audit?.append({
      actor: { id: input.customerId, type: "CUSTOMER" },
      correlationId: input.correlationId,
      entity: { id: input.entityId, type: "CUSTOMER_AUTH_RECORD" },
      environment: this.environment,
      eventType: input.eventType,
      metadata: { customerId: input.customerId, ...input.metadata },
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }

  private async auditAuthFailure(
    correlationId: CorrelationId,
    reasonCode: string,
  ): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "customer-authentication-service", type: "SERVICE" },
      correlationId,
      entity: { id: correlationId, type: "CUSTOMER_AUTH_RECORD" },
      environment: this.environment,
      eventType: "CUSTOMER_AUTHENTICATION_FAILED",
      metadata: { reasonCode },
      outcome: "DENIED",
      reasonCode,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }
}

export class CustomerSessionPrincipalProvider implements AuthenticatedCustomerPrincipalProvider {
  public constructor(
    private readonly options: {
      readonly service: CustomerAuthenticationService;
      readonly rawSessionToken: string | null;
      readonly correlationId: CorrelationId;
    },
  ) {}

  public async currentPrincipal(): Promise<AuthenticatedCustomerPrincipal | null> {
    if (!this.options.rawSessionToken) {
      return null;
    }
    const result = await this.options.service.resolveSession({
      correlationId: this.options.correlationId,
      rawSessionToken: this.options.rawSessionToken,
    });
    return result.status === "AUTHENTICATED" ? result.principal : null;
  }
}

export const generateCustomerSessionToken = (): string =>
  randomBytes(32).toString("base64url");

export const hashCustomerSessionToken = (rawSessionToken: string): string =>
  createHash("sha256").update(rawSessionToken, "utf8").digest("hex");

export const isPlausibleCustomerSessionToken = (
  rawSessionToken: string,
): boolean =>
  rawSessionToken.length >= 43 &&
  rawSessionToken.length <= 128 &&
  /^[A-Za-z0-9_-]+$/u.test(rawSessionToken);

export const validateCustomerAuthenticationConfig = (
  config: CustomerAuthenticationConfig,
): CustomerAuthenticationConfig => {
  if (
    !Number.isSafeInteger(config.ttlMs) ||
    !Number.isSafeInteger(config.idleTimeoutMs) ||
    !Number.isSafeInteger(config.touchIntervalMs) ||
    config.ttlMs <= 0 ||
    config.idleTimeoutMs <= 0 ||
    config.touchIntervalMs <= 0 ||
    config.touchIntervalMs > config.idleTimeoutMs ||
    config.idleTimeoutMs > config.ttlMs
  ) {
    throw new Error("Invalid customer authentication session configuration");
  }
  return config;
};

const readPositiveInteger = (
  rawValue: string | undefined,
  defaultValue: number,
  name: string,
): number => {
  if (rawValue === undefined) {
    return defaultValue;
  }
  if (!/^[1-9][0-9]*$/u.test(rawValue)) {
    throw new Error(`${name}_INVALID`);
  }
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name}_INVALID`);
  }
  return parsed;
};

const minDate = (left: Date, right: Date): Date =>
  left.getTime() <= right.getTime() ? left : right;
