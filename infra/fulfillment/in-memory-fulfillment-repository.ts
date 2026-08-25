import { randomUUID } from "node:crypto";

import type {
  FulfillmentEncryptedSecretMaterial,
  FulfillmentOperation,
  FulfillmentReasonCode,
  FulfillmentRepository,
  FulfillmentSecretRecord,
} from "../../packages/platform/src/fulfillment/secure-key-fulfillment.js";

export class InMemoryFulfillmentRepository implements FulfillmentRepository {
  public readonly operations = new Map<string, FulfillmentOperation>();
  public readonly secrets = new Map<string, FulfillmentSecretRecord>();

  public async createIdempotent(input: {
    readonly operation: FulfillmentOperation;
    readonly now: Date;
  }): Promise<
    | { readonly status: "CREATED"; readonly operation: FulfillmentOperation }
    | { readonly status: "EXISTING"; readonly operation: FulfillmentOperation }
  > {
    const existing = input.operation.controlledProcurementApprovalId
      ? await this.findByControlledProcurementApprovalId(
          input.operation.controlledProcurementApprovalId,
        )
      : null;
    if (existing) {
      return { operation: existing, status: "EXISTING" };
    }
    this.operations.set(input.operation.id, input.operation);
    return { operation: input.operation, status: "CREATED" };
  }

  public async findById(
    fulfillmentId: string,
  ): Promise<FulfillmentOperation | null> {
    return this.operations.get(fulfillmentId) ?? null;
  }

  public async findByControlledProcurementApprovalId(
    approvalId: string,
  ): Promise<FulfillmentOperation | null> {
    return (
      [...this.operations.values()].find(
        (operation) => operation.controlledProcurementApprovalId === approvalId,
      ) ?? null
    );
  }

  public async acquireRetrievalLease(input: {
    readonly fulfillmentId: string;
    readonly tokenHash: string;
    readonly executionToken: string;
    readonly staleStartedBefore: Date;
    readonly now: Date;
  }): Promise<
    | { readonly status: "ACQUIRED"; readonly operation: FulfillmentOperation }
    | { readonly status: "IN_FLIGHT"; readonly operation: FulfillmentOperation }
    | {
        readonly status: "ALREADY_RETRIEVED";
        readonly operation: FulfillmentOperation;
      }
    | { readonly status: "EXPIRED"; readonly operation: FulfillmentOperation }
    | {
        readonly status: "TOKEN_INVALID";
        readonly operation: FulfillmentOperation;
      }
    | {
        readonly status: "NOT_ELIGIBLE";
        readonly operation?: FulfillmentOperation;
      }
  > {
    const current = this.operations.get(input.fulfillmentId);
    if (!current) {
      return { status: "NOT_ELIGIBLE" };
    }
    if (current.encryptedSecretId || current.retrievalState === "RETRIEVED") {
      return { operation: current, status: "ALREADY_RETRIEVED" };
    }
    if (current.tokenHash !== input.tokenHash) {
      return { operation: current, status: "TOKEN_INVALID" };
    }
    if (
      current.approvalExpiresAt &&
      current.approvalExpiresAt.getTime() <= input.now.getTime()
    ) {
      return { operation: current, status: "EXPIRED" };
    }
    if (
      current.retrievalExecutionToken &&
      current.retrievalStartedAt &&
      current.retrievalStartedAt.getTime() > input.staleStartedBefore.getTime()
    ) {
      return { operation: current, status: "IN_FLIGHT" };
    }
    if (!["READY", "FAILED_RETRYABLE"].includes(current.status)) {
      return { operation: current, status: "NOT_ELIGIBLE" };
    }
    const next: FulfillmentOperation = {
      ...current,
      recordVersion: current.recordVersion + 1,
      retrievalExecutionToken: input.executionToken,
      retrievalStartedAt: input.now,
      retrievalState: "IN_FLIGHT",
      status: "RETRIEVAL_IN_FLIGHT",
      updatedAt: input.now,
    };
    this.operations.set(next.id, next);
    return { operation: next, status: "ACQUIRED" };
  }

  public async markRetrieved(input: {
    readonly fulfillmentId: string;
    readonly executionToken: string;
    readonly material: FulfillmentEncryptedSecretMaterial;
    readonly now: Date;
  }): Promise<FulfillmentOperation | null> {
    const current = this.operations.get(input.fulfillmentId);
    if (
      !current ||
      current.retrievalExecutionToken !== input.executionToken ||
      current.encryptedSecretId
    ) {
      return null;
    }
    const secret: FulfillmentSecretRecord = {
      ...input.material,
      createdAt: input.now,
      fulfillmentId: current.id,
      id: randomUUID(),
    };
    this.secrets.set(secret.id, secret);
    const next: FulfillmentOperation = {
      ...current,
      deliveryState: "PENDING",
      encryptedSecretId: secret.id,
      recordVersion: current.recordVersion + 1,
      retrievalExecutionToken: null,
      retrievalStartedAt: null,
      retrievalState: "RETRIEVED",
      retrievedAt: input.now,
      status: "DELIVERY_PENDING",
      updatedAt: input.now,
    };
    this.operations.set(next.id, next);
    return next;
  }

  public async markFailed(input: {
    readonly fulfillmentId: string;
    readonly executionToken: string;
    readonly status:
      | "FAILED_RETRYABLE"
      | "FAILED_TERMINAL"
      | "AMBIGUOUS"
      | "MANUAL_REVIEW_REQUIRED";
    readonly reasonCode: FulfillmentReasonCode;
    readonly now: Date;
  }): Promise<FulfillmentOperation | null> {
    const current = this.operations.get(input.fulfillmentId);
    if (!current || current.retrievalExecutionToken !== input.executionToken) {
      return null;
    }
    const next: FulfillmentOperation = {
      ...current,
      failureReasonCode: input.reasonCode,
      recordVersion: current.recordVersion + 1,
      retrievalExecutionToken: null,
      retrievalStartedAt: null,
      retrievalState: input.status,
      status: input.status,
      updatedAt: input.now,
    };
    this.operations.set(next.id, next);
    return next;
  }

  public async markDelivered(input: {
    readonly fulfillmentId: string;
    readonly now: Date;
  }): Promise<FulfillmentOperation | null> {
    const current = this.operations.get(input.fulfillmentId);
    if (!current || current.status !== "DELIVERY_PENDING") {
      return null;
    }
    const next: FulfillmentOperation = {
      ...current,
      deliveredAt: input.now,
      deliveryState: "DELIVERED",
      recordVersion: current.recordVersion + 1,
      status: "DELIVERED",
      updatedAt: input.now,
    };
    this.operations.set(next.id, next);
    return next;
  }

  public async findSecretByFulfillmentId(
    fulfillmentId: string,
  ): Promise<FulfillmentSecretRecord | null> {
    return (
      [...this.secrets.values()].find(
        (secret) => secret.fulfillmentId === fulfillmentId,
      ) ?? null
    );
  }
}
