import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type {
  CorrelationId,
  CustomerId,
  OrderId,
} from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import type { AuthenticatedCustomerPrincipal } from "./customer-order-identity.js";
import type {
  GuestOrderClaimAuthorityPort,
  GuestOrderClaimEvidence,
} from "./customer-registration.js";
import { normalizeCustomerEmail } from "./customer-order-identity.js";

export type GuestOrderClaimPurpose = "GUEST_ORDER_CLAIM";

export interface GuestOrderClaimChallenge {
  readonly id: string;
  readonly orderId: OrderId;
  readonly emailNormalizedSnapshot: string;
  readonly purpose: GuestOrderClaimPurpose;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly recordVersion: number;
}

export interface GuestOrderClaimInspection {
  readonly orderId: OrderId;
  readonly isOwned: boolean;
  readonly ownerCustomerId: CustomerId | null;
  readonly hasCheckoutEmailSnapshot: boolean;
  readonly activeClaimCount: number;
  readonly lastClaimCreatedAt: Date | null;
  readonly claimStateSummary: {
    readonly active: number;
    readonly consumed: number;
    readonly revoked: number;
    readonly expired: number;
  };
}

export interface GuestOrderClaimRepository {
  createChallenge(input: {
    readonly challenge: GuestOrderClaimChallenge;
    readonly now: Date;
  }): Promise<
    | { readonly status: "CREATED" }
    | { readonly status: "TOKEN_HASH_COLLISION" }
    | { readonly status: "ORDER_NOT_CLAIMABLE"; readonly reasonCode: string }
  >;
  revokeChallenge(input: {
    readonly challengeId: string;
    readonly now: Date;
  }): Promise<"REVOKED" | "ALREADY_INACTIVE" | "NOT_FOUND">;
  consumeClaim(input: {
    readonly tokenHash: string;
    readonly principal: AuthenticatedCustomerPrincipal;
    readonly orderId?: OrderId;
    readonly now: Date;
  }): Promise<
    | {
        readonly status: "CONSUMED";
        readonly challenge: GuestOrderClaimChallenge;
        readonly evidence: GuestOrderClaimEvidence;
      }
    | { readonly status: "INVALID"; readonly reasonCode: string }
  >;
  inspectOrderClaim(input: {
    readonly orderId: OrderId;
    readonly now: Date;
  }): Promise<GuestOrderClaimInspection | null>;
}

export interface GuestOrderClaimDeliveryPort {
  sendGuestOrderClaim(input: {
    readonly orderId: OrderId;
    readonly challengeId: string;
    readonly emailNormalized: string;
    readonly rawClaimCode: string;
    readonly expiresAt: Date;
    readonly correlationId: CorrelationId;
  }): Promise<{ readonly status: "ACCEPTED" } | { readonly status: "FAILED" }>;
}

export class FakeGuestOrderClaimDeliveryPort implements GuestOrderClaimDeliveryPort {
  public readonly deliveries: {
    readonly orderId: OrderId;
    readonly challengeId: string;
    readonly emailNormalized: string;
    readonly rawClaimCode: string;
    readonly expiresAt: Date;
    readonly correlationId: CorrelationId;
  }[] = [];

  public async sendGuestOrderClaim(input: {
    readonly orderId: OrderId;
    readonly challengeId: string;
    readonly emailNormalized: string;
    readonly rawClaimCode: string;
    readonly expiresAt: Date;
    readonly correlationId: CorrelationId;
  }): Promise<{ readonly status: "ACCEPTED" }> {
    this.deliveries.push(input);
    return { status: "ACCEPTED" };
  }
}

export interface GuestOrderClaimIssuanceAuthorityPort {
  verifiedGuestOrderClaimIssuance(input: {
    readonly orderId: OrderId;
    readonly checkoutEmailNormalized: string;
    readonly correlationId: CorrelationId;
  }): Promise<
    | { readonly status: "AUTHORIZED"; readonly providerEvidenceId: string }
    | { readonly status: "DENIED"; readonly reasonCode?: string }
  >;
}

export class FailClosedGuestOrderClaimIssuanceAuthority implements GuestOrderClaimIssuanceAuthorityPort {
  public async verifiedGuestOrderClaimIssuance(): Promise<{
    readonly status: "DENIED";
    readonly reasonCode: "UNTRUSTED_CLAIM_ISSUANCE_AUTHORITY";
  }> {
    return {
      reasonCode: "UNTRUSTED_CLAIM_ISSUANCE_AUTHORITY",
      status: "DENIED",
    };
  }
}

export type GuestOrderClaimIssueResult =
  | { readonly status: "ISSUED" }
  | {
      readonly status:
        "CLAIM_ISSUE_DENIED" | "DELIVERY_FAILED" | "ORDER_NOT_CLAIMABLE";
      readonly reasonCode: string;
    };

export interface GuestOrderClaimServiceOptions {
  readonly repository: GuestOrderClaimRepository;
  readonly delivery: GuestOrderClaimDeliveryPort;
  readonly issuanceAuthority?: GuestOrderClaimIssuanceAuthorityPort;
  readonly claimTtlMs?: number;
  readonly audit?: AuditEventPort;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
  readonly tokenFactory?: () => string;
}

export class GuestOrderClaimService {
  private readonly now: () => Date;
  private readonly environment: AuditEvent["environment"];
  private readonly claimTtlMs: number;
  private readonly issuanceAuthority: GuestOrderClaimIssuanceAuthorityPort;

  public constructor(private readonly options: GuestOrderClaimServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.environment = options.environment ?? "LOCAL";
    this.claimTtlMs = validateGuestOrderClaimTtlMs(
      options.claimTtlMs ?? defaultGuestOrderClaimTtlMs,
    );
    this.issuanceAuthority =
      options.issuanceAuthority ??
      new FailClosedGuestOrderClaimIssuanceAuthority();
  }

  public async issueGuestOrderClaim(input: {
    readonly orderId: OrderId;
    readonly checkoutEmail: string;
    readonly correlationId: CorrelationId;
  }): Promise<GuestOrderClaimIssueResult> {
    const email = normalizeCustomerEmail(input.checkoutEmail);
    if (!email) {
      await this.auditIssueDenied(
        input.correlationId,
        input.orderId,
        "INVALID_CHECKOUT_EMAIL",
      );
      return {
        reasonCode: "INVALID_CHECKOUT_EMAIL",
        status: "ORDER_NOT_CLAIMABLE",
      };
    }
    const authority =
      await this.issuanceAuthority.verifiedGuestOrderClaimIssuance({
        checkoutEmailNormalized: email,
        correlationId: input.correlationId,
        orderId: input.orderId,
      });
    if (authority.status !== "AUTHORIZED") {
      const reasonCode =
        authority.reasonCode ?? "UNTRUSTED_CLAIM_ISSUANCE_AUTHORITY";
      await this.auditIssueDenied(
        input.correlationId,
        input.orderId,
        reasonCode,
      );
      return { reasonCode, status: "CLAIM_ISSUE_DENIED" };
    }
    const now = this.now();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rawClaimCode = this.createRawClaimCode();
      const challenge: GuestOrderClaimChallenge = {
        consumedAt: null,
        createdAt: now,
        emailNormalizedSnapshot: email,
        expiresAt: new Date(now.getTime() + this.claimTtlMs),
        id: randomUUID(),
        orderId: input.orderId,
        purpose: "GUEST_ORDER_CLAIM",
        recordVersion: 1,
        revokedAt: null,
        tokenHash: hashGuestOrderClaimCode(rawClaimCode),
      };
      const created = await this.options.repository.createChallenge({
        challenge,
        now,
      });
      if (created.status === "TOKEN_HASH_COLLISION") {
        continue;
      }
      if (created.status === "ORDER_NOT_CLAIMABLE") {
        await this.auditIssueDenied(
          input.correlationId,
          input.orderId,
          created.reasonCode,
          challenge.id,
        );
        return {
          reasonCode: created.reasonCode,
          status: "ORDER_NOT_CLAIMABLE",
        };
      }
      const deliveryInput = {
        challengeId: challenge.id,
        correlationId: input.correlationId,
        emailNormalized: email,
        expiresAt: challenge.expiresAt,
        orderId: input.orderId,
        rawClaimCode,
      };
      try {
        const delivered =
          await this.options.delivery.sendGuestOrderClaim(deliveryInput);
        if (delivered.status !== "ACCEPTED") {
          await this.revokeUndelivered(
            challenge.id,
            input.orderId,
            now,
            input.correlationId,
          );
          await this.auditIssueDenied(
            input.correlationId,
            input.orderId,
            "CLAIM_DELIVERY_FAILED",
            challenge.id,
          );
          return {
            reasonCode: "CLAIM_DELIVERY_FAILED",
            status: "DELIVERY_FAILED",
          };
        }
      } catch {
        await this.revokeUndelivered(
          challenge.id,
          input.orderId,
          now,
          input.correlationId,
        );
        await this.auditIssueDenied(
          input.correlationId,
          input.orderId,
          "CLAIM_DELIVERY_FAILED",
          challenge.id,
        );
        return {
          reasonCode: "CLAIM_DELIVERY_FAILED",
          status: "DELIVERY_FAILED",
        };
      }
      await this.audit(
        input.correlationId,
        input.orderId,
        "CUSTOMER_GUEST_ORDER_CLAIM_ISSUED",
        "SUCCEEDED",
        "CLAIM_ISSUED",
        challenge.id,
      );
      return { status: "ISSUED" };
    }
    return {
      reasonCode: "CLAIM_TOKEN_HASH_COLLISION",
      status: "CLAIM_ISSUE_DENIED",
    };
  }

  public inspectOrderClaim(input: {
    readonly orderId: OrderId;
  }): Promise<GuestOrderClaimInspection | null> {
    return this.options.repository.inspectOrderClaim({
      now: this.now(),
      orderId: input.orderId,
    });
  }

  private createRawClaimCode(): string {
    return this.options.tokenFactory?.() ?? generateGuestOrderClaimCode();
  }

  private async revokeUndelivered(
    challengeId: string,
    orderIdValue: OrderId,
    now: Date,
    correlationIdValue: CorrelationId,
  ): Promise<void> {
    try {
      await this.options.repository.revokeChallenge({ challengeId, now });
      await this.audit(
        correlationIdValue,
        orderIdValue,
        "CUSTOMER_GUEST_ORDER_CLAIM_REVOKED",
        "DENIED",
        "CLAIM_DELIVERY_FAILED",
        challengeId,
      );
    } catch {
      await this.audit(
        correlationIdValue,
        orderIdValue,
        "CUSTOMER_GUEST_ORDER_CLAIM_DELIVERY_FAILED",
        "FAILED",
        "CLAIM_REVOKE_FAILED",
        challengeId,
      );
    }
  }

  private auditIssueDenied(
    correlationIdValue: CorrelationId,
    orderIdValue: OrderId,
    reasonCode: string,
    challengeId?: string,
  ): Promise<void> {
    return this.audit(
      correlationIdValue,
      orderIdValue,
      "CUSTOMER_GUEST_ORDER_CLAIM_DENIED",
      "DENIED",
      reasonCode,
      challengeId,
    );
  }

  private async audit(
    correlationIdValue: CorrelationId,
    orderIdValue: OrderId,
    eventType: AuditEvent["eventType"],
    outcome: AuditEvent["outcome"],
    reasonCode: string,
    challengeId?: string,
  ): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "guest-order-claim-service", type: "SERVICE" },
      correlationId: correlationIdValue,
      entity: { id: orderIdValue, type: "ORDER" },
      environment: this.environment,
      eventType,
      metadata: {
        ...(challengeId ? { challengeId } : {}),
        orderId: orderIdValue,
        reasonCode,
      },
      outcome,
      reasonCode,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }
}

export class PersistedGuestOrderClaimAuthority implements GuestOrderClaimAuthorityPort {
  public constructor(
    private readonly options: {
      readonly repository: GuestOrderClaimRepository;
      readonly now?: () => Date;
    },
  ) {}

  public async verifiedGuestOrderClaim(input: {
    readonly principal: AuthenticatedCustomerPrincipal;
    readonly claimCode: string;
    readonly orderId?: OrderId;
    readonly correlationId: CorrelationId;
  }) {
    if (!isPlausibleGuestOrderClaimCode(input.claimCode)) {
      return { reasonCode: "CLAIM_INVALID", status: "DENIED" as const };
    }
    const consumed = await this.options.repository.consumeClaim({
      now: this.options.now?.() ?? new Date(),
      ...(input.orderId ? { orderId: input.orderId } : {}),
      principal: input.principal,
      tokenHash: hashGuestOrderClaimCode(input.claimCode),
    });
    if (consumed.status !== "CONSUMED") {
      return { reasonCode: consumed.reasonCode, status: "DENIED" as const };
    }
    return { evidence: consumed.evidence, status: "AUTHORIZED" as const };
  }
}

export const defaultGuestOrderClaimTtlMs = 604_800_000;

export const generateGuestOrderClaimCode = (): string =>
  randomBytes(32).toString("base64url");

export const hashGuestOrderClaimCode = (rawClaimCode: string): string =>
  createHash("sha256").update(rawClaimCode, "utf8").digest("hex");

export const isPlausibleGuestOrderClaimCode = (rawClaimCode: string): boolean =>
  rawClaimCode.length >= 16 &&
  rawClaimCode.length <= 128 &&
  /^[A-Za-z0-9_-]+(?:-[A-Za-z0-9_-]+)*$/u.test(rawClaimCode);

export const validateGuestOrderClaimTtlMs = (ttlMs: number): number => {
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > 31 * 24 * 60 * 60 * 1000
  ) {
    throw new Error("Invalid guest order claim TTL configuration");
  }
  return ttlMs;
};

export class TrustedGuestOrderClaimIssuanceAuthority implements GuestOrderClaimIssuanceAuthorityPort {
  public async verifiedGuestOrderClaimIssuance(input: {
    readonly orderId: OrderId;
    readonly checkoutEmailNormalized: string;
    readonly correlationId: CorrelationId;
  }) {
    return {
      providerEvidenceId: `trusted-guest-claim:${input.orderId}:${input.correlationId}:${hashGuestOrderClaimCode(input.checkoutEmailNormalized).slice(0, 16)}`,
      status: "AUTHORIZED" as const,
    };
  }
}

export const guestOrderClaimEmailPolicy = {
  containsProductKey: "FORBIDDEN",
  germanAccountRequirement:
    "Wichtig: Erstelle dein KeyRaNo-Konto mit derselben E-Mail-Adresse, die du bei deiner Bestellung angegeben hast. Nur so koennen wir deinen Kauf sicher deinem Konto zuordnen.",
  publicBrand: "KeyRaNo",
  publicBrandLine: "KeyRaNo - Rapid Access. No Waiting.",
  rawClaimCodeVisibility: "TRUSTED_DELIVERY_ADAPTER_ONLY",
} as const;
