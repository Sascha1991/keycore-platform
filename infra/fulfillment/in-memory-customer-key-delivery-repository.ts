import { randomUUID } from "node:crypto";

import type {
  CustomerKeyDeliveryApproval,
  CustomerKeyDeliveryAttempt,
  CustomerKeyDeliveryOutboxEvent,
  CustomerKeyDeliveryReasonCode,
  CustomerKeyDeliveryRepository,
} from "../../packages/platform/src/contracts.js";
import type { InMemoryFulfillmentRepository } from "./in-memory-fulfillment-repository.js";

export class InMemoryCustomerKeyDeliveryRepository implements CustomerKeyDeliveryRepository {
  public readonly approvals = new Map<string, CustomerKeyDeliveryApproval>();
  public readonly attempts = new Map<string, CustomerKeyDeliveryAttempt>();
  public readonly outbox: CustomerKeyDeliveryOutboxEvent[] = [];
  private claimQueue: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly fulfillmentRepository: InMemoryFulfillmentRepository,
  ) {}

  public async createApproval(input: {
    readonly approval: CustomerKeyDeliveryApproval;
    readonly now: Date;
  }) {
    const existing = [...this.approvals.values()].find(
      (approval) =>
        approval.fulfillmentId === input.approval.fulfillmentId &&
        approval.orderId === input.approval.orderId &&
        approval.customerId === input.approval.customerId &&
        approval.status === "AUTHORIZED",
    );
    if (existing) {
      return { approval: existing, status: "EXISTING" as const };
    }
    this.approvals.set(input.approval.id, input.approval);
    return { approval: input.approval, status: "CREATED" as const };
  }

  public async claimDelivery(input: {
    readonly approvalId: string;
    readonly tokenHash: string;
    readonly contextFingerprint: string;
    readonly channel: CustomerKeyDeliveryAttempt["channel"];
    readonly executionToken: string;
    readonly staleStartedBefore: Date;
    readonly now: Date;
  }) {
    return this.serializedClaim(() => this.claimDeliveryUnlocked(input));
  }

  private async claimDeliveryUnlocked(input: {
    readonly approvalId: string;
    readonly tokenHash: string;
    readonly contextFingerprint: string;
    readonly channel: CustomerKeyDeliveryAttempt["channel"];
    readonly executionToken: string;
    readonly staleStartedBefore: Date;
    readonly now: Date;
  }) {
    const approval = this.approvals.get(input.approvalId);
    if (!approval) {
      return { status: "NOT_FOUND" as const };
    }
    const latest = await this.findLatestAttemptByFulfillmentId(
      approval.fulfillmentId,
    );
    if (latest?.status === "DELIVERED") {
      return {
        approval,
        attempt: latest,
        status: "ALREADY_DELIVERED" as const,
      };
    }
    if (
      latest?.status === "DELIVERY_IN_FLIGHT" &&
      latest.startedAt &&
      latest.startedAt > input.staleStartedBefore
    ) {
      return { approval, attempt: latest, status: "IN_FLIGHT" as const };
    }
    if (latest?.status === "DELIVERY_IN_FLIGHT") {
      const reviewed: CustomerKeyDeliveryAttempt = {
        ...latest,
        executionToken: null,
        failureReasonCode: "FULFILLMENT_DELIVERY_OUTCOME_UNKNOWN",
        recordVersion: latest.recordVersion + 1,
        status: "MANUAL_REVIEW_REQUIRED",
        updatedAt: input.now,
      };
      this.attempts.set(reviewed.id, reviewed);
      return {
        approval,
        attempt: reviewed,
        status: "MANUAL_REVIEW_REQUIRED" as const,
      };
    }
    if (approval.contextFingerprint !== input.contextFingerprint) {
      return { approval, status: "CONTEXT_MISMATCH" as const };
    }
    if (approval.tokenHash !== input.tokenHash) {
      return { approval, status: "TOKEN_INVALID" as const };
    }
    if (approval.expiresAt <= input.now || approval.status !== "AUTHORIZED") {
      return { approval, status: "EXPIRED" as const };
    }
    const consumed: CustomerKeyDeliveryApproval = {
      ...approval,
      consumedAt: input.now,
      recordVersion: approval.recordVersion + 1,
      status: "CONSUMED",
      updatedAt: input.now,
    };
    this.approvals.set(consumed.id, consumed);
    const attempt: CustomerKeyDeliveryAttempt = {
      approvalId: consumed.id,
      channel: input.channel,
      correlationId: consumed.correlationId,
      createdAt: input.now,
      customerId: consumed.customerId,
      executionToken: input.executionToken,
      fulfillmentId: consumed.fulfillmentId,
      id: randomUUID(),
      orderId: consumed.orderId,
      recordVersion: 1,
      startedAt: input.now,
      status: "DELIVERY_IN_FLIGHT",
      updatedAt: input.now,
    };
    this.attempts.set(attempt.id, attempt);
    return { approval: consumed, attempt, status: "CLAIMED" as const };
  }

  private async serializedClaim<TResult>(
    callback: () => Promise<TResult>,
  ): Promise<TResult> {
    const run = this.claimQueue.then(callback);
    this.claimQueue = run.catch(() => undefined);
    return run;
  }

  public async markDelivered(input: {
    readonly attemptId: string;
    readonly executionToken: string;
    readonly deliveredAt: Date;
    readonly deliveryReference: string;
    readonly outbox: CustomerKeyDeliveryOutboxEvent;
  }): Promise<CustomerKeyDeliveryAttempt | null> {
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt || attempt.executionToken !== input.executionToken) {
      return null;
    }
    const fulfillment = await this.fulfillmentRepository.markDelivered({
      fulfillmentId: attempt.fulfillmentId,
      now: input.deliveredAt,
    });
    if (!fulfillment) {
      return null;
    }
    const delivered: CustomerKeyDeliveryAttempt = {
      ...attempt,
      deliveredAt: input.deliveredAt,
      deliveryReference: input.deliveryReference,
      executionToken: null,
      recordVersion: attempt.recordVersion + 1,
      status: "DELIVERED",
      updatedAt: input.deliveredAt,
    };
    this.attempts.set(delivered.id, delivered);
    if (
      !this.outbox.some(
        (event) =>
          event.eventDeduplicationKey === input.outbox.eventDeduplicationKey,
      )
    ) {
      this.outbox.push(input.outbox);
    }
    return delivered;
  }

  public async markFailed(input: {
    readonly attemptId: string;
    readonly executionToken: string;
    readonly status:
      | "FAILED_RETRYABLE"
      | "FAILED_TERMINAL"
      | "AMBIGUOUS"
      | "MANUAL_REVIEW_REQUIRED";
    readonly reasonCode: CustomerKeyDeliveryReasonCode;
    readonly now: Date;
  }): Promise<CustomerKeyDeliveryAttempt | null> {
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt || attempt.executionToken !== input.executionToken) {
      return null;
    }
    const failed: CustomerKeyDeliveryAttempt = {
      ...attempt,
      executionToken: null,
      failureReasonCode: input.reasonCode,
      recordVersion: attempt.recordVersion + 1,
      status: input.status,
      updatedAt: input.now,
    };
    this.attempts.set(failed.id, failed);
    return failed;
  }

  public async findLatestAttemptByFulfillmentId(
    fulfillmentId: string,
  ): Promise<CustomerKeyDeliveryAttempt | null> {
    return (
      [...this.attempts.values()]
        .filter((attempt) => attempt.fulfillmentId === fulfillmentId)
        .sort(
          (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
        )[0] ?? null
    );
  }
}
