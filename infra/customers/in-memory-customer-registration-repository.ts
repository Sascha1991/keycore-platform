import type {
  CustomerEmailVerificationChallenge,
  CustomerRegistrationChallengeRepository,
  CustomerRegistrationInspection,
  CustomerId,
} from "../../packages/platform/src/contracts.js";
import type { InMemoryCustomerOrderIdentityRepository } from "./in-memory-customer-order-identity-repository.js";

export class InMemoryCustomerRegistrationChallengeRepository implements CustomerRegistrationChallengeRepository {
  private readonly challenges = new Map<
    string,
    CustomerEmailVerificationChallenge
  >();
  private consumeQueue: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly identityRepository: InMemoryCustomerOrderIdentityRepository,
  ) {}

  public activeChallengesFor(
    customerId: CustomerId,
  ): readonly CustomerEmailVerificationChallenge[] {
    return [...this.challenges.values()].filter(
      (challenge) =>
        challenge.customerId === customerId &&
        !challenge.consumedAt &&
        !challenge.revokedAt,
    );
  }

  public async createChallenge(input: {
    readonly challenge: CustomerEmailVerificationChallenge;
    readonly now: Date;
  }): Promise<"CREATED" | "TOKEN_HASH_COLLISION"> {
    if (
      [...this.challenges.values()].some(
        (challenge) => challenge.tokenHash === input.challenge.tokenHash,
      )
    ) {
      return "TOKEN_HASH_COLLISION";
    }
    for (const [id, challenge] of this.challenges) {
      if (
        challenge.customerId === input.challenge.customerId &&
        challenge.emailNormalizedSnapshot ===
          input.challenge.emailNormalizedSnapshot &&
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
    return "CREATED";
  }

  public async consumeChallenge(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<
    | {
        readonly status: "CONSUMED";
        readonly challenge: CustomerEmailVerificationChallenge;
        readonly customer: NonNullable<
          Awaited<
            ReturnType<
              InMemoryCustomerOrderIdentityRepository["findCustomerById"]
            >
          >
        >;
      }
    | { readonly status: "INVALID"; readonly reasonCode: string }
  > {
    const queued = this.consumeQueue.then(() =>
      this.consumeChallengeNow(input),
    );
    this.consumeQueue = queued.catch(() => undefined);
    return queued;
  }

  private async consumeChallengeNow(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<
    | {
        readonly status: "CONSUMED";
        readonly challenge: CustomerEmailVerificationChallenge;
        readonly customer: NonNullable<
          Awaited<
            ReturnType<
              InMemoryCustomerOrderIdentityRepository["findCustomerById"]
            >
          >
        >;
      }
    | { readonly status: "INVALID"; readonly reasonCode: string }
  > {
    const challenge = [...this.challenges.values()].find(
      (candidate) => candidate.tokenHash === input.tokenHash,
    );
    if (!challenge) {
      return { reasonCode: "TOKEN_NOT_FOUND", status: "INVALID" };
    }
    if (challenge.consumedAt) {
      return { reasonCode: "TOKEN_CONSUMED", status: "INVALID" };
    }
    if (challenge.revokedAt) {
      return { reasonCode: "TOKEN_REVOKED", status: "INVALID" };
    }
    if (challenge.expiresAt.getTime() <= input.now.getTime()) {
      return { reasonCode: "TOKEN_EXPIRED", status: "INVALID" };
    }
    const customer = await this.identityRepository.findCustomerById(
      challenge.customerId,
    );
    if (!customer) {
      return { reasonCode: "CUSTOMER_NOT_FOUND", status: "INVALID" };
    }
    if (customer.emailNormalized !== challenge.emailNormalizedSnapshot) {
      return { reasonCode: "EMAIL_SNAPSHOT_MISMATCH", status: "INVALID" };
    }
    const consumed = {
      ...challenge,
      consumedAt: input.now,
      recordVersion: challenge.recordVersion + 1,
    };
    this.challenges.set(challenge.id, consumed);
    return { challenge: consumed, customer, status: "CONSUMED" };
  }

  public async inspectCustomerRegistration(
    customerId: CustomerId,
  ): Promise<CustomerRegistrationInspection | null> {
    const customer = await this.identityRepository.findCustomerById(customerId);
    if (!customer) {
      return null;
    }
    const challenges = [...this.challenges.values()].filter(
      (challenge) => challenge.customerId === customerId,
    );
    const active = challenges.filter(
      (challenge) => !challenge.consumedAt && !challenge.revokedAt,
    );
    const last = challenges
      .map((challenge) => challenge.createdAt)
      .sort((left, right) => right.getTime() - left.getTime())[0];
    return {
      activeChallengeCount: active.length,
      customerId,
      identityBindingCount:
        this.identityRepository.countIdentityBindingsForCustomer(customerId),
      lastChallengeCreatedAt: last ?? null,
      verificationState: customer.emailVerificationState,
    };
  }
}
