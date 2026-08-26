import type {
  AuthenticatedCustomerPrincipal,
  GuestOrderClaimChallenge,
  GuestOrderClaimInspection,
  GuestOrderClaimRepository,
  GuestOrderClaimEvidence,
  OrderId,
} from "../../packages/platform/src/contracts.js";
import type { InMemoryCustomerOrderIdentityRepository } from "./in-memory-customer-order-identity-repository.js";

export class InMemoryGuestOrderClaimRepository implements GuestOrderClaimRepository {
  public readonly challenges = new Map<string, GuestOrderClaimChallenge>();
  private claimQueue: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly identityRepository: InMemoryCustomerOrderIdentityRepository,
  ) {}

  public async createChallenge(input: {
    readonly challenge: GuestOrderClaimChallenge;
    readonly now: Date;
  }) {
    const order = await this.identityRepository.inspectOrderOwnership(
      input.challenge.orderId,
    );
    if (!order) {
      return {
        reasonCode: "ORDER_NOT_FOUND",
        status: "ORDER_NOT_CLAIMABLE" as const,
      };
    }
    if (order.ownerCustomerId) {
      return {
        reasonCode: "ORDER_ALREADY_OWNED",
        status: "ORDER_NOT_CLAIMABLE" as const,
      };
    }
    if (!order.checkoutEmailNormalized) {
      return {
        reasonCode: "CHECKOUT_EMAIL_SNAPSHOT_REQUIRED",
        status: "ORDER_NOT_CLAIMABLE" as const,
      };
    }
    if (
      order.checkoutEmailNormalized !== input.challenge.emailNormalizedSnapshot
    ) {
      return {
        reasonCode: "CHECKOUT_EMAIL_SNAPSHOT_MISMATCH",
        status: "ORDER_NOT_CLAIMABLE" as const,
      };
    }
    for (const challenge of this.challenges.values()) {
      if (challenge.tokenHash === input.challenge.tokenHash) {
        return { status: "TOKEN_HASH_COLLISION" as const };
      }
    }
    for (const [id, challenge] of this.challenges) {
      if (
        challenge.orderId === input.challenge.orderId &&
        challenge.purpose === input.challenge.purpose &&
        !challenge.consumedAt &&
        !challenge.revokedAt
      ) {
        this.challenges.set(id, {
          ...challenge,
          recordVersion: challenge.recordVersion + 1,
          revokedAt: input.now,
        });
      }
    }
    this.challenges.set(input.challenge.id, input.challenge);
    return { status: "CREATED" as const };
  }

  public async revokeChallenge(input: {
    readonly challengeId: string;
    readonly now: Date;
  }): Promise<"REVOKED" | "ALREADY_INACTIVE" | "NOT_FOUND"> {
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge) {
      return "NOT_FOUND";
    }
    if (challenge.consumedAt || challenge.revokedAt) {
      return "ALREADY_INACTIVE";
    }
    this.challenges.set(challenge.id, {
      ...challenge,
      recordVersion: challenge.recordVersion + 1,
      revokedAt: input.now,
    });
    return "REVOKED";
  }

  public async consumeClaim(input: {
    readonly tokenHash: string;
    readonly principal: AuthenticatedCustomerPrincipal;
    readonly orderId?: OrderId;
    readonly now: Date;
  }) {
    return this.serializedClaim(() => this.consumeClaimUnlocked(input));
  }

  private async consumeClaimUnlocked(input: {
    readonly tokenHash: string;
    readonly principal: AuthenticatedCustomerPrincipal;
    readonly orderId?: OrderId;
    readonly now: Date;
  }) {
    const challenge = [...this.challenges.values()].find(
      (candidate) => candidate.tokenHash === input.tokenHash,
    );
    if (!challenge) {
      return { reasonCode: "CLAIM_INVALID", status: "INVALID" as const };
    }
    if (input.orderId !== undefined && input.orderId !== challenge.orderId) {
      return { reasonCode: "CLAIM_INVALID", status: "INVALID" as const };
    }
    if (challenge.consumedAt) {
      return { reasonCode: "CLAIM_CONSUMED", status: "INVALID" as const };
    }
    if (challenge.revokedAt) {
      return { reasonCode: "CLAIM_REVOKED", status: "INVALID" as const };
    }
    if (challenge.expiresAt.getTime() <= input.now.getTime()) {
      return { reasonCode: "CLAIM_EXPIRED", status: "INVALID" as const };
    }
    const customer = await this.identityRepository.findCustomerById(
      input.principal.customerId,
    );
    if (
      !customer ||
      customer.emailVerificationState !== "VERIFIED" ||
      customer.emailNormalized !== challenge.emailNormalizedSnapshot
    ) {
      return { reasonCode: "CLAIM_INVALID", status: "INVALID" as const };
    }
    const order = await this.identityRepository.inspectOrderOwnership(
      challenge.orderId,
    );
    if (!order) {
      return { reasonCode: "CLAIM_INVALID", status: "INVALID" as const };
    }
    if (order.ownerCustomerId && order.ownerCustomerId !== customer.id) {
      return { reasonCode: "CLAIM_INVALID", status: "INVALID" as const };
    }
    const consumed = {
      ...challenge,
      consumedAt: input.now,
      recordVersion: challenge.recordVersion + 1,
    };
    this.challenges.set(challenge.id, consumed);
    return {
      challenge: consumed,
      evidence: {
        actorId: "guest-order-claim",
        actorType: "SERVICE",
        customerId: customer.id,
        expectedOrderVersion: order.recordVersion,
        orderId: order.orderId,
        providerEvidenceId: `guest-order-claim:${challenge.id}`,
      } satisfies GuestOrderClaimEvidence,
      status: "CONSUMED" as const,
    };
  }

  private async serializedClaim<TResult>(
    callback: () => Promise<TResult>,
  ): Promise<TResult> {
    const run = this.claimQueue.then(callback);
    this.claimQueue = run.catch(() => undefined);
    return run;
  }

  public async inspectOrderClaim(input: {
    readonly orderId: OrderId;
    readonly now: Date;
  }): Promise<GuestOrderClaimInspection | null> {
    const order = await this.identityRepository.inspectOrderOwnership(
      input.orderId,
    );
    if (!order) {
      return null;
    }
    const challenges = [...this.challenges.values()].filter(
      (challenge) => challenge.orderId === input.orderId,
    );
    const active = challenges.filter(
      (challenge) =>
        !challenge.consumedAt &&
        !challenge.revokedAt &&
        challenge.expiresAt > input.now,
    );
    return {
      activeClaimCount: active.length,
      claimStateSummary: {
        active: active.length,
        consumed: challenges.filter((challenge) => challenge.consumedAt).length,
        expired: challenges.filter(
          (challenge) =>
            !challenge.consumedAt &&
            !challenge.revokedAt &&
            challenge.expiresAt <= input.now,
        ).length,
        revoked: challenges.filter((challenge) => challenge.revokedAt).length,
      },
      hasCheckoutEmailSnapshot: Boolean(order.checkoutEmailNormalized),
      isOwned: order.ownershipBound,
      lastClaimCreatedAt:
        [...challenges].sort(
          (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
        )[0]?.createdAt ?? null,
      orderId: order.orderId,
      ownerCustomerId: order.ownerCustomerId,
    };
  }
}
