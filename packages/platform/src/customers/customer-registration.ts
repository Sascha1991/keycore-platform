import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type {
  CorrelationId,
  CustomerId,
  OrderId,
} from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import type {
  AuthenticatedCustomerPrincipal,
  CustomerIdentityBindingAuthorityPort,
  CustomerOrderIdentityRepository,
  EmailVerificationAuthorityPort,
  EmailVerificationEvidence,
  KeyCoreCustomer,
  OrderOwnershipBindingAuthorityPort,
} from "./customer-order-identity.js";
import {
  CustomerOrderIdentityService,
  normalizeCustomerEmail,
} from "./customer-order-identity.js";
import { isPlausibleGuestOrderClaimCode } from "./guest-order-claim.js";

export type CustomerEmailVerificationPurpose = "EMAIL_VERIFICATION";

export interface CustomerEmailVerificationChallenge {
  readonly id: string;
  readonly customerId: CustomerId;
  readonly emailNormalizedSnapshot: string;
  readonly tokenHash: string;
  readonly purpose: CustomerEmailVerificationPurpose;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly recordVersion: number;
}

export interface CustomerRegistrationInspection {
  readonly customerId: CustomerId;
  readonly verificationState: KeyCoreCustomer["emailVerificationState"];
  readonly activeChallengeCount: number;
  readonly lastChallengeCreatedAt: Date | null;
  readonly identityBindingCount: number;
}

export interface CustomerRegistrationChallengeRepository {
  createChallenge(input: {
    readonly challenge: CustomerEmailVerificationChallenge;
    readonly now: Date;
  }): Promise<"CREATED" | "TOKEN_HASH_COLLISION">;
  revokeChallenge(input: {
    readonly challengeId: string;
    readonly now: Date;
  }): Promise<"REVOKED" | "ALREADY_INACTIVE" | "NOT_FOUND">;
  consumeChallenge(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<
    | {
        readonly status: "CONSUMED";
        readonly challenge: CustomerEmailVerificationChallenge;
        readonly customer: KeyCoreCustomer;
      }
    | { readonly status: "INVALID"; readonly reasonCode: string }
  >;
  inspectCustomerRegistration(input: {
    readonly customerId: CustomerId;
    readonly now: Date;
  }): Promise<CustomerRegistrationInspection | null>;
}

export interface CustomerEmailVerificationDeliveryPort {
  sendVerificationChallenge(input: {
    readonly customerId: CustomerId;
    readonly challengeId: string;
    readonly emailNormalized: string;
    readonly rawVerificationToken: string;
    readonly expiresAt: Date;
    readonly correlationId: CorrelationId;
  }): Promise<{ readonly status: "ACCEPTED" } | { readonly status: "FAILED" }>;
}

export class FakeCustomerEmailVerificationDeliveryPort implements CustomerEmailVerificationDeliveryPort {
  public readonly deliveries: {
    readonly customerId: CustomerId;
    readonly challengeId: string;
    readonly emailNormalized: string;
    readonly rawVerificationToken: string;
    readonly expiresAt: Date;
    readonly correlationId: CorrelationId;
  }[] = [];

  public async sendVerificationChallenge(input: {
    readonly customerId: CustomerId;
    readonly challengeId: string;
    readonly emailNormalized: string;
    readonly rawVerificationToken: string;
    readonly expiresAt: Date;
    readonly correlationId: CorrelationId;
  }): Promise<{ readonly status: "ACCEPTED" }> {
    this.deliveries.push(input);
    return { status: "ACCEPTED" };
  }
}

export interface CustomerRegistrationRateLimitPort {
  checkRegistrationAttempt(input: {
    readonly emailHash: string;
    readonly ipHash?: string;
    readonly correlationId: CorrelationId;
  }): Promise<{ readonly status: "ALLOWED" } | { readonly status: "DENIED" }>;
}

export class InMemoryCustomerRegistrationRateLimitPort implements CustomerRegistrationRateLimitPort {
  public constructor(private readonly allow = true) {}

  public async checkRegistrationAttempt(): Promise<
    { readonly status: "ALLOWED" } | { readonly status: "DENIED" }
  > {
    return { status: this.allow ? "ALLOWED" : "DENIED" };
  }
}

export interface GuestOrderClaimEvidence {
  readonly orderId: OrderId;
  readonly customerId: CustomerId;
  readonly expectedOrderVersion: number;
  readonly providerEvidenceId: string;
  readonly actorType: "SERVICE" | "ADMIN";
  readonly actorId: string;
}

export interface GuestOrderClaimAuthorityPort {
  verifiedGuestOrderClaim(input: {
    readonly principal: AuthenticatedCustomerPrincipal;
    readonly claimCode: string;
    readonly orderId?: OrderId;
    readonly correlationId: CorrelationId;
  }): Promise<
    | {
        readonly status: "AUTHORIZED";
        readonly evidence: GuestOrderClaimEvidence;
      }
    | { readonly status: "DENIED"; readonly reasonCode?: string }
  >;
}

export class FailClosedGuestOrderClaimAuthority implements GuestOrderClaimAuthorityPort {
  public async verifiedGuestOrderClaim(): Promise<{
    readonly status: "DENIED";
    readonly reasonCode: "UNTRUSTED_CLAIM_AUTHORITY";
  }> {
    return {
      reasonCode: "UNTRUSTED_CLAIM_AUTHORITY",
      status: "DENIED",
    };
  }
}

export interface CustomerRegistrationConfig {
  readonly verificationTtlMs: number;
}

export const defaultCustomerRegistrationConfig =
  (): CustomerRegistrationConfig => ({
    verificationTtlMs: 900_000,
  });

export const customerRegistrationConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): CustomerRegistrationConfig => ({
  verificationTtlMs: readPositiveInteger(
    env.KEYCORE_CUSTOMER_EMAIL_VERIFICATION_TTL_MS,
    defaultCustomerRegistrationConfig().verificationTtlMs,
    "KEYCORE_CUSTOMER_EMAIL_VERIFICATION_TTL_MS",
  ),
});

export type CustomerRegistrationResult =
  | { readonly status: "REGISTRATION_ACCEPTED" }
  | { readonly status: "REGISTRATION_DENIED"; readonly reasonCode: string };

export type CustomerEmailVerificationPublicResult =
  { readonly status: "VERIFIED" } | { readonly status: "VERIFICATION_INVALID" };

export type CustomerIdentityLinkResult =
  | { readonly status: "BOUND" | "ALREADY_BOUND" }
  | {
      readonly status:
        | "AUTHENTICATION_REQUIRED"
        | "AUTHENTICATION_UNTRUSTED"
        | "CUSTOMER_NOT_FOUND"
        | "EMAIL_NOT_VERIFIED"
        | "IDENTITY_CONFLICT"
        | "IDENTITY_LINK_DENIED";
    };

export type CustomerOrderClaimResult =
  | { readonly status: "CLAIMED" | "ALREADY_OWNED"; readonly orderId: OrderId }
  | {
      readonly status:
        | "AUTHENTICATION_REQUIRED"
        | "AUTHENTICATION_UNTRUSTED"
        | "CUSTOMER_NOT_FOUND"
        | "EMAIL_NOT_VERIFIED"
        | "CLAIM_DENIED"
        | "OWNERSHIP_CONFLICT"
        | "ORDER_NOT_FOUND";
    };

export interface CustomerRegistrationServiceOptions {
  readonly identityService: CustomerOrderIdentityService;
  readonly identityRepository: CustomerOrderIdentityRepository;
  readonly challengeRepository: CustomerRegistrationChallengeRepository;
  readonly delivery: CustomerEmailVerificationDeliveryPort;
  readonly rateLimit?: CustomerRegistrationRateLimitPort;
  readonly identityBindingAuthority?: CustomerIdentityBindingAuthorityPort;
  readonly claimAuthority?: GuestOrderClaimAuthorityPort;
  readonly audit?: AuditEventPort;
  readonly config?: CustomerRegistrationConfig;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
  readonly tokenFactory?: () => string;
}

export class CustomerRegistrationService {
  private readonly now: () => Date;
  private readonly config: CustomerRegistrationConfig;
  private readonly environment: AuditEvent["environment"];
  private readonly rateLimit: CustomerRegistrationRateLimitPort;
  private readonly claimAuthority: GuestOrderClaimAuthorityPort;

  public constructor(
    private readonly options: CustomerRegistrationServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.config = validateCustomerRegistrationConfig(
      options.config ?? defaultCustomerRegistrationConfig(),
    );
    this.environment = options.environment ?? "LOCAL";
    this.rateLimit =
      options.rateLimit ?? new InMemoryCustomerRegistrationRateLimitPort();
    this.claimAuthority =
      options.claimAuthority ?? new FailClosedGuestOrderClaimAuthority();
  }

  public async register(input: {
    readonly email: string;
    readonly correlationId: CorrelationId;
    readonly ipHash?: string;
  }): Promise<CustomerRegistrationResult> {
    const normalized = normalizeCustomerEmail(input.email);
    if (!normalized) {
      await this.auditRegistrationDenied(input.correlationId, "INVALID_EMAIL");
      return { reasonCode: "INVALID_EMAIL", status: "REGISTRATION_DENIED" };
    }
    const limiter = await this.rateLimit.checkRegistrationAttempt({
      correlationId: input.correlationId,
      emailHash: hashRegistrationLimiterIdentity(normalized),
      ...(input.ipHash ? { ipHash: input.ipHash } : {}),
    });
    if (limiter.status !== "ALLOWED") {
      await this.auditRegistrationDenied(input.correlationId, "RATE_LIMITED");
      return { reasonCode: "RATE_LIMITED", status: "REGISTRATION_DENIED" };
    }
    const customerResult = await this.options.identityService.createCustomer({
      correlationId: input.correlationId,
      email: normalized,
    });
    if (customerResult.status === "INVALID_EMAIL") {
      return { reasonCode: "INVALID_EMAIL", status: "REGISTRATION_DENIED" };
    }
    const customer = customerResult.customer;
    await this.audit({
      correlationId: input.correlationId,
      customerId: customer.id,
      entityId: customer.id,
      entityType: "CUSTOMER",
      eventType: "CUSTOMER_REGISTRATION_REQUESTED",
      outcome: "SUCCEEDED",
      reasonCode: "REGISTRATION_ACCEPTED",
      metadata: { customerKnown: true },
    });

    const challengeResult = await this.issueChallenge(
      customer,
      input.correlationId,
    );
    if (challengeResult.status !== "ISSUED") {
      return {
        reasonCode: challengeResult.reasonCode,
        status: "REGISTRATION_DENIED",
      };
    }
    return { status: "REGISTRATION_ACCEPTED" };
  }

  public async verifyEmail(input: {
    readonly rawVerificationToken: string;
    readonly correlationId: CorrelationId;
  }): Promise<CustomerEmailVerificationPublicResult> {
    if (!isPlausibleCustomerVerificationToken(input.rawVerificationToken)) {
      await this.auditVerificationFailed(input.correlationId, "INVALID_TOKEN");
      return { status: "VERIFICATION_INVALID" };
    }
    const consumed = await this.options.challengeRepository.consumeChallenge({
      now: this.now(),
      tokenHash: hashCustomerVerificationToken(input.rawVerificationToken),
    });
    if (consumed.status !== "CONSUMED") {
      await this.auditVerificationFailed(
        input.correlationId,
        consumed.reasonCode,
      );
      return { status: "VERIFICATION_INVALID" };
    }
    const authority = new ChallengeEmailVerificationAuthority(
      consumed.customer.id,
      consumed.customer.emailNormalized,
      consumed.challenge.id,
      this.now(),
    );
    const verified = await new CustomerOrderIdentityService({
      emailVerificationAuthority: authority,
      environment: this.environment,
      now: this.now,
      repository: this.options.identityRepository,
      ...(this.options.audit ? { audit: this.options.audit } : {}),
    }).markEmailVerified({
      correlationId: input.correlationId,
      customerId: consumed.customer.id,
      expectedCustomerVersion: consumed.customer.recordVersion,
    });
    if (
      verified.status === "VERIFIED" ||
      verified.status === "ALREADY_VERIFIED"
    ) {
      return { status: "VERIFIED" };
    }
    await this.auditVerificationFailed(input.correlationId, verified.status);
    return { status: "VERIFICATION_INVALID" };
  }

  public async linkExternalIdentity(input: {
    readonly principal: AuthenticatedCustomerPrincipal | null;
    readonly correlationId: CorrelationId;
  }): Promise<CustomerIdentityLinkResult> {
    const principalCheck = await this.requireAuthenticatedVerifiedCustomer(
      input.principal,
    );
    if (principalCheck.status !== "OK") {
      await this.auditIdentityLinkDenied(
        input.correlationId,
        input.principal?.customerId ?? null,
        principalCheck.status,
      );
      return { status: principalCheck.status };
    }
    const identityService = new CustomerOrderIdentityService({
      environment: this.environment,
      now: this.now,
      repository: this.options.identityRepository,
      ...(this.options.audit ? { audit: this.options.audit } : {}),
      ...(this.options.identityBindingAuthority
        ? { identityBindingAuthority: this.options.identityBindingAuthority }
        : {}),
    });
    const result = await identityService.bindIdentity({
      correlationId: input.correlationId,
      customerId: principalCheck.customer.id,
    });
    if (result.status === "BOUND" || result.status === "ALREADY_BOUND") {
      await this.audit({
        correlationId: input.correlationId,
        customerId: principalCheck.customer.id,
        entityId: result.binding.id,
        entityType: "CUSTOMER_IDENTITY_BINDING",
        eventType: "CUSTOMER_IDENTITY_LINKED",
        outcome: "SUCCEEDED",
        reasonCode: result.status,
        metadata: { provider: result.binding.provider },
      });
      return { status: result.status };
    }
    const status =
      result.status === "IDENTITY_CONFLICT"
        ? "IDENTITY_CONFLICT"
        : "IDENTITY_LINK_DENIED";
    await this.auditIdentityLinkDenied(
      input.correlationId,
      principalCheck.customer.id,
      result.status,
    );
    return { status };
  }

  public async claimGuestOrder(input: {
    readonly principal: AuthenticatedCustomerPrincipal | null;
    readonly claimCode: string;
    readonly orderId?: OrderId;
    readonly correlationId: CorrelationId;
  }): Promise<CustomerOrderClaimResult> {
    const auditOrderId = input.orderId ?? ("unknown-order" as OrderId);
    if (!isPlausibleGuestOrderClaimCode(input.claimCode)) {
      await this.auditOrderClaimDenied(
        input.correlationId,
        input.principal?.customerId ?? null,
        auditOrderId,
        "CLAIM_INVALID",
      );
      return { status: "CLAIM_DENIED" };
    }
    const principalCheck = await this.requireAuthenticatedVerifiedCustomer(
      input.principal,
    );
    if (principalCheck.status !== "OK") {
      await this.auditOrderClaimDenied(
        input.correlationId,
        input.principal?.customerId ?? null,
        auditOrderId,
        principalCheck.status,
      );
      return { status: principalCheck.status };
    }
    const principal = input.principal;
    if (!principal) {
      return { status: "AUTHENTICATION_REQUIRED" };
    }
    const authority = await this.claimAuthority.verifiedGuestOrderClaim({
      claimCode: input.claimCode,
      correlationId: input.correlationId,
      ...(input.orderId ? { orderId: input.orderId } : {}),
      principal,
    });
    const claimedOrderId =
      authority.status === "AUTHORIZED"
        ? authority.evidence.orderId
        : auditOrderId;
    if (
      authority.status !== "AUTHORIZED" ||
      authority.evidence.customerId !== principalCheck.customer.id ||
      (input.orderId !== undefined &&
        authority.evidence.orderId !== input.orderId)
    ) {
      await this.auditOrderClaimDenied(
        input.correlationId,
        principalCheck.customer.id,
        claimedOrderId,
        authority.status === "DENIED"
          ? (authority.reasonCode ?? "UNTRUSTED_CLAIM_AUTHORITY")
          : "CLAIM_CONTEXT_MISMATCH",
      );
      return { status: "CLAIM_DENIED" };
    }
    const ownershipAuthority = new TrustedGuestOrderClaimOwnershipAuthority(
      authority.evidence,
    );
    const identityService = new CustomerOrderIdentityService({
      environment: this.environment,
      now: this.now,
      orderOwnershipAuthority: ownershipAuthority,
      repository: this.options.identityRepository,
      ...(this.options.audit ? { audit: this.options.audit } : {}),
    });
    const result = await identityService.bindOrderOwnership({
      correlationId: input.correlationId,
      customerId: principalCheck.customer.id,
      expectedOrderVersion: authority.evidence.expectedOrderVersion,
      orderId: authority.evidence.orderId,
    });
    if (result.status === "BOUND" || result.status === "ALREADY_BOUND") {
      await this.audit({
        correlationId: input.correlationId,
        customerId: principalCheck.customer.id,
        entityId: authority.evidence.orderId,
        entityType: "ORDER",
        eventType:
          result.status === "BOUND"
            ? "CUSTOMER_ORDER_CLAIMED"
            : "CUSTOMER_ORDER_CLAIM_DENIED",
        outcome: result.status === "BOUND" ? "SUCCEEDED" : "DENIED",
        reasonCode: result.status,
        metadata: { orderId: authority.evidence.orderId },
      });
      return {
        orderId: authority.evidence.orderId,
        status: result.status === "BOUND" ? "CLAIMED" : "ALREADY_OWNED",
      };
    }
    const status =
      result.status === "OWNERSHIP_CONFLICT"
        ? "OWNERSHIP_CONFLICT"
        : result.status === "ORDER_NOT_FOUND"
          ? "ORDER_NOT_FOUND"
          : "CLAIM_DENIED";
    await this.auditOrderClaimDenied(
      input.correlationId,
      principalCheck.customer.id,
      authority.evidence.orderId,
      result.status,
    );
    return { status };
  }

  public inspectCustomerRegistration(input: {
    readonly customerId: CustomerId;
  }): Promise<CustomerRegistrationInspection | null> {
    return this.options.challengeRepository.inspectCustomerRegistration({
      customerId: input.customerId,
      now: this.now(),
    });
  }

  private async issueChallenge(
    customer: KeyCoreCustomer,
    correlation: CorrelationId,
  ): Promise<
    | { readonly status: "ISSUED"; readonly challengeId: string }
    | { readonly status: "FAILED"; readonly reasonCode: string }
  > {
    const now = this.now();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rawVerificationToken = this.createRawToken();
      const challenge: CustomerEmailVerificationChallenge = {
        consumedAt: null,
        createdAt: now,
        customerId: customer.id,
        emailNormalizedSnapshot: customer.emailNormalized,
        expiresAt: new Date(now.getTime() + this.config.verificationTtlMs),
        id: randomUUID(),
        purpose: "EMAIL_VERIFICATION",
        recordVersion: 1,
        revokedAt: null,
        tokenHash: hashCustomerVerificationToken(rawVerificationToken),
      };
      const created = await this.options.challengeRepository.createChallenge({
        challenge,
        now,
      });
      if (created === "TOKEN_HASH_COLLISION") {
        continue;
      }
      const deliveryInput = {
        challengeId: challenge.id,
        correlationId: correlation,
        customerId: customer.id,
        emailNormalized: customer.emailNormalized,
        expiresAt: challenge.expiresAt,
        rawVerificationToken,
      };
      let delivered: Awaited<
        ReturnType<
          CustomerEmailVerificationDeliveryPort["sendVerificationChallenge"]
        >
      >;
      try {
        delivered =
          await this.options.delivery.sendVerificationChallenge(deliveryInput);
      } catch {
        await this.revokeUndeliveredChallenge(challenge.id, now);
        return { reasonCode: "DELIVERY_FAILED", status: "FAILED" };
      }
      if (delivered.status !== "ACCEPTED") {
        await this.revokeUndeliveredChallenge(challenge.id, now);
        return { reasonCode: "DELIVERY_FAILED", status: "FAILED" };
      }
      await this.audit({
        correlationId: correlation,
        customerId: customer.id,
        entityId: challenge.id,
        entityType: "CUSTOMER_EMAIL_VERIFICATION_CHALLENGE",
        eventType: "CUSTOMER_EMAIL_VERIFICATION_ISSUED",
        outcome: "SUCCEEDED",
        reasonCode: "ISSUED",
        metadata: {
          challengeId: challenge.id,
          expiresAt: challenge.expiresAt.toISOString(),
          purpose: challenge.purpose,
        },
      });
      return { challengeId: challenge.id, status: "ISSUED" };
    }
    return { reasonCode: "TOKEN_HASH_COLLISION", status: "FAILED" };
  }

  private async revokeUndeliveredChallenge(
    challengeId: string,
    now: Date,
  ): Promise<void> {
    try {
      await this.options.challengeRepository.revokeChallenge({
        challengeId,
        now,
      });
    } catch {
      await this.auditNoCustomer(
        `revoke-${challengeId}` as CorrelationId,
        "CUSTOMER_EMAIL_VERIFICATION_FAILED",
        "CHALLENGE_REVOKE_FAILED",
      );
    }
  }

  private async requireAuthenticatedVerifiedCustomer(
    principal: AuthenticatedCustomerPrincipal | null,
  ): Promise<
    | { readonly status: "OK"; readonly customer: KeyCoreCustomer }
    | {
        readonly status:
          | "AUTHENTICATION_REQUIRED"
          | "AUTHENTICATION_UNTRUSTED"
          | "CUSTOMER_NOT_FOUND"
          | "EMAIL_NOT_VERIFIED";
      }
  > {
    if (!principal) {
      return { status: "AUTHENTICATION_REQUIRED" };
    }
    if (principal.authenticationContext.assurance !== "AUTHENTICATED") {
      return { status: "AUTHENTICATION_UNTRUSTED" };
    }
    const customer = await this.options.identityRepository.findCustomerById(
      principal.customerId,
    );
    if (!customer) {
      return { status: "CUSTOMER_NOT_FOUND" };
    }
    if (customer.emailVerificationState !== "VERIFIED") {
      return { status: "EMAIL_NOT_VERIFIED" };
    }
    return { customer, status: "OK" };
  }

  private createRawToken(): string {
    return this.options.tokenFactory?.() ?? generateCustomerVerificationToken();
  }

  private async audit(input: {
    readonly correlationId: CorrelationId;
    readonly customerId: CustomerId;
    readonly entityId: string;
    readonly entityType: string;
    readonly eventType: AuditEvent["eventType"];
    readonly outcome: AuditEvent["outcome"];
    readonly reasonCode: string;
    readonly metadata: Readonly<Record<string, string | number | boolean>>;
  }): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "customer-registration-service", type: "SERVICE" },
      correlationId: input.correlationId,
      entity: { id: input.entityId, type: input.entityType },
      environment: this.environment,
      eventType: input.eventType,
      metadata: {
        customerId: input.customerId,
        reasonCode: input.reasonCode,
        ...input.metadata,
      },
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }

  private auditRegistrationDenied(
    correlation: CorrelationId,
    reasonCode: string,
  ): Promise<void> {
    return this.auditNoCustomer(
      correlation,
      "CUSTOMER_REGISTRATION_REQUESTED",
      reasonCode,
    );
  }

  private auditVerificationFailed(
    correlation: CorrelationId,
    reasonCode: string,
  ): Promise<void> {
    return this.auditNoCustomer(
      correlation,
      "CUSTOMER_EMAIL_VERIFICATION_FAILED",
      reasonCode,
    );
  }

  private auditIdentityLinkDenied(
    correlation: CorrelationId,
    customer: CustomerId | null,
    reasonCode: string,
  ): Promise<void> {
    return this.auditOptionalCustomer(
      correlation,
      customer,
      "CUSTOMER_IDENTITY_LINK_DENIED",
      "CUSTOMER_IDENTITY_BINDING",
      reasonCode,
    );
  }

  private auditOrderClaimDenied(
    correlation: CorrelationId,
    customer: CustomerId | null,
    order: OrderId,
    reasonCode: string,
  ): Promise<void> {
    return this.auditOptionalCustomer(
      correlation,
      customer,
      "CUSTOMER_ORDER_CLAIM_DENIED",
      "ORDER",
      reasonCode,
      order,
    );
  }

  private async auditNoCustomer(
    correlation: CorrelationId,
    eventType: AuditEvent["eventType"],
    reasonCode: string,
  ): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "customer-registration-service", type: "SERVICE" },
      correlationId: correlation,
      entity: { id: correlation, type: "CUSTOMER_REGISTRATION" },
      environment: this.environment,
      eventType,
      metadata: { reasonCode },
      outcome: "DENIED",
      reasonCode,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }

  private async auditOptionalCustomer(
    correlation: CorrelationId,
    customer: CustomerId | null,
    eventType: AuditEvent["eventType"],
    entityType: string,
    reasonCode: string,
    entityId: string = correlation,
  ): Promise<void> {
    await this.options.audit?.append({
      actor: {
        id: customer ?? "missing-principal",
        type: customer ? "CUSTOMER" : "SYSTEM",
      },
      correlationId: correlation,
      entity: { id: entityId, type: entityType },
      environment: this.environment,
      eventType,
      metadata: {
        ...(customer ? { customerId: customer } : {}),
        reasonCode,
      },
      outcome: "DENIED",
      reasonCode,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }
}

class ChallengeEmailVerificationAuthority implements EmailVerificationAuthorityPort {
  public constructor(
    private readonly customer: CustomerId,
    private readonly email: string,
    private readonly challengeId: string,
    private readonly verifiedAt: Date,
  ) {}

  public async verifiedEmailEvidence(input: {
    readonly customerId: CustomerId;
    readonly emailNormalized: string;
    readonly correlationId: CorrelationId;
  }): Promise<
    | {
        readonly status: "AUTHORIZED";
        readonly evidence: EmailVerificationEvidence;
      }
    | { readonly status: "DENIED" }
  > {
    if (
      input.customerId !== this.customer ||
      input.emailNormalized !== this.email
    ) {
      return { status: "DENIED" };
    }
    return {
      evidence: {
        customerId: this.customer,
        emailNormalized: this.email,
        provider: "KEYCORE",
        providerEvidenceId: `email-challenge:${this.challengeId}`,
        verifiedAt: this.verifiedAt,
      },
      status: "AUTHORIZED",
    };
  }
}

class TrustedGuestOrderClaimOwnershipAuthority implements OrderOwnershipBindingAuthorityPort {
  public constructor(private readonly evidence: GuestOrderClaimEvidence) {}

  public async verifiedOrderOwnership(input: {
    readonly orderId: OrderId;
    readonly customerId: CustomerId;
    readonly correlationId: CorrelationId;
  }): Promise<
    | {
        readonly status: "AUTHORIZED";
        readonly actorType: "SERVICE" | "ADMIN";
        readonly actorId: string;
        readonly providerEvidenceId: string;
      }
    | { readonly status: "DENIED" }
  > {
    if (
      input.orderId !== this.evidence.orderId ||
      input.customerId !== this.evidence.customerId
    ) {
      return { status: "DENIED" };
    }
    return {
      actorId: this.evidence.actorId,
      actorType: this.evidence.actorType,
      providerEvidenceId: this.evidence.providerEvidenceId,
      status: "AUTHORIZED",
    };
  }
}

export const generateCustomerVerificationToken = (): string =>
  randomBytes(32).toString("base64url");

export const hashCustomerVerificationToken = (
  rawVerificationToken: string,
): string =>
  createHash("sha256").update(rawVerificationToken, "utf8").digest("hex");

export const hashRegistrationLimiterIdentity = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const isPlausibleCustomerVerificationToken = (
  rawVerificationToken: string,
): boolean =>
  rawVerificationToken.length >= 43 &&
  rawVerificationToken.length <= 128 &&
  /^[A-Za-z0-9_-]+$/u.test(rawVerificationToken);

export const validateCustomerRegistrationConfig = (
  config: CustomerRegistrationConfig,
): CustomerRegistrationConfig => {
  if (
    !Number.isSafeInteger(config.verificationTtlMs) ||
    config.verificationTtlMs <= 0 ||
    config.verificationTtlMs > 86_400_000
  ) {
    throw new Error("Invalid customer registration configuration");
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
