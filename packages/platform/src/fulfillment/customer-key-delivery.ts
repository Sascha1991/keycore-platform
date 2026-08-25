import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type {
  CorrelationId,
  CustomerId,
  OrderId,
} from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import type { SafePayload } from "../queue/job.js";
import type { KeyManagementProvider } from "../vault/crypto.js";
import {
  decryptFulfillmentSecret,
  fulfillmentEncryptionContext,
  fulfillmentOutboxPayload,
  type FulfillmentOperation,
  type FulfillmentRepository,
  type FulfillmentSecretRecord,
} from "./secure-key-fulfillment.js";

export type CustomerKeyDeliveryChannel =
  "FAKE" | "TEST" | "ADMIN_CONTROLLED_TEST";

export type CustomerKeyDeliveryStatus =
  | "PENDING"
  | "AUTHORIZED"
  | "DELIVERY_IN_FLIGHT"
  | "DELIVERED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL"
  | "AMBIGUOUS"
  | "MANUAL_REVIEW_REQUIRED";

export type CustomerKeyDeliveryApprovalStatus =
  "AUTHORIZED" | "CONSUMED" | "EXPIRED" | "CANCELLED";

export type CustomerKeyDeliveryReasonCode =
  | "FULFILLMENT_DELIVERY_AUTHORIZED"
  | "FULFILLMENT_DELIVERY_ALREADY_AUTHORIZED"
  | "FULFILLMENT_DELIVERY_UNAUTHORIZED"
  | "FULFILLMENT_DELIVERY_AUTHORIZATION_EXPIRED"
  | "FULFILLMENT_DELIVERY_TOKEN_INVALID"
  | "FULFILLMENT_DELIVERY_CONTEXT_MISMATCH"
  | "FULFILLMENT_DELIVERY_NOT_READY"
  | "FULFILLMENT_DELIVERY_IN_FLIGHT"
  | "FULFILLMENT_ALREADY_DELIVERED"
  | "FULFILLMENT_DELIVERED"
  | "FULFILLMENT_KEY_MANAGEMENT_FAILED"
  | "FULFILLMENT_DELIVERY_REJECTED"
  | "FULFILLMENT_DELIVERY_RETRYABLE"
  | "FULFILLMENT_DELIVERY_OUTCOME_UNKNOWN"
  | "FULFILLMENT_DELIVERY_LOCAL_PERSISTENCE_FAILED"
  | "FULFILLMENT_DELIVERY_LOCAL_UNKNOWN"
  | "FULFILLMENT_LIVE_DELIVERY_DISABLED";

export interface CustomerDeliveryAuthorization {
  readonly customerId: CustomerId;
  readonly orderId: OrderId;
  readonly fulfillmentId: string;
  readonly purpose: "customer-key-delivery";
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly version: 1;
}

export interface CustomerOrderAuthorizationPort {
  authorizeDelivery(
    authorization: CustomerDeliveryAuthorization,
  ): Promise<{ readonly status: "AUTHORIZED" } | { readonly status: "DENIED" }>;
}

export interface CustomerKeyDeliveryApproval {
  readonly id: string;
  readonly fulfillmentId: string;
  readonly orderId: OrderId;
  readonly customerId: CustomerId;
  readonly purpose: "customer-key-delivery";
  readonly version: 1;
  readonly tokenHash: string;
  readonly contextFingerprint: string;
  readonly status: CustomerKeyDeliveryApprovalStatus;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt?: Date | null;
  readonly correlationId: CorrelationId;
  readonly recordVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CustomerKeyDeliveryAttempt {
  readonly id: string;
  readonly approvalId: string;
  readonly fulfillmentId: string;
  readonly orderId: OrderId;
  readonly customerId: CustomerId;
  readonly channel: CustomerKeyDeliveryChannel;
  readonly status: CustomerKeyDeliveryStatus;
  readonly executionToken?: string | null;
  readonly startedAt?: Date | null;
  readonly deliveredAt?: Date | null;
  readonly deliveryReference?: string | null;
  readonly failureReasonCode?: CustomerKeyDeliveryReasonCode | null;
  readonly correlationId: CorrelationId;
  readonly recordVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CustomerKeyDeliveryRepository {
  createApproval(input: {
    readonly approval: CustomerKeyDeliveryApproval;
    readonly now: Date;
  }): Promise<
    | {
        readonly status: "CREATED";
        readonly approval: CustomerKeyDeliveryApproval;
      }
    | {
        readonly status: "EXISTING";
        readonly approval: CustomerKeyDeliveryApproval;
      }
  >;
  claimDelivery(input: {
    readonly approvalId: string;
    readonly tokenHash: string;
    readonly contextFingerprint: string;
    readonly channel: CustomerKeyDeliveryChannel;
    readonly executionToken: string;
    readonly staleStartedBefore: Date;
    readonly now: Date;
  }): Promise<
    | {
        readonly status: "CLAIMED";
        readonly approval: CustomerKeyDeliveryApproval;
        readonly attempt: CustomerKeyDeliveryAttempt;
      }
    | {
        readonly status:
          | "IN_FLIGHT"
          | "ALREADY_DELIVERED"
          | "EXPIRED"
          | "TOKEN_INVALID"
          | "CONTEXT_MISMATCH"
          | "MANUAL_REVIEW_REQUIRED"
          | "NOT_FOUND";
        readonly approval?: CustomerKeyDeliveryApproval;
        readonly attempt?: CustomerKeyDeliveryAttempt;
      }
  >;
  markDelivered(input: {
    readonly attemptId: string;
    readonly executionToken: string;
    readonly deliveredAt: Date;
    readonly deliveryReference: string;
    readonly outbox: CustomerKeyDeliveryOutboxEvent;
  }): Promise<CustomerKeyDeliveryAttempt | null>;
  markFailed(input: {
    readonly attemptId: string;
    readonly executionToken: string;
    readonly status: Extract<
      CustomerKeyDeliveryStatus,
      | "FAILED_RETRYABLE"
      | "FAILED_TERMINAL"
      | "AMBIGUOUS"
      | "MANUAL_REVIEW_REQUIRED"
    >;
    readonly reasonCode: CustomerKeyDeliveryReasonCode;
    readonly now: Date;
  }): Promise<CustomerKeyDeliveryAttempt | null>;
  findLatestAttemptByFulfillmentId(
    fulfillmentId: string,
  ): Promise<CustomerKeyDeliveryAttempt | null>;
}

export interface CustomerKeyDeliveryPort {
  deliver(input: {
    readonly authorization: CustomerDeliveryAuthorization;
    readonly channel: CustomerKeyDeliveryChannel;
    readonly plaintext: Buffer;
    readonly correlationId: CorrelationId;
  }): Promise<CustomerKeyDeliveryPortResult>;
}

export interface CustomerKeyDeliveryPortResult {
  readonly status: "DELIVERED";
  readonly deliveryReference: string;
  readonly deliveredAt: Date;
  readonly channel: CustomerKeyDeliveryChannel;
}

export class CustomerKeyDeliveryError extends Error {
  public constructor(
    public readonly category: "RETRYABLE" | "REJECTED" | "AMBIGUOUS",
  ) {
    super("Customer key delivery failed");
  }
}

export interface CustomerKeyDeliveryOutboxEvent {
  readonly eventType: "fulfillment.delivered";
  readonly aggregateType: "FULFILLMENT";
  readonly aggregateId: string;
  readonly payload: SafePayload;
  readonly correlationId: CorrelationId;
  readonly eventDeduplicationKey: string;
}

export interface CustomerKeyDeliveryServiceOptions {
  readonly fulfillmentRepository: FulfillmentRepository;
  readonly deliveryRepository: CustomerKeyDeliveryRepository;
  readonly orderAuthorization: CustomerOrderAuthorizationPort;
  readonly deliveryPort: CustomerKeyDeliveryPort;
  readonly keyManagementProvider: KeyManagementProvider;
  readonly approvalTtlMs: number;
  readonly deliveryLeaseStaleAfterMs: number;
  readonly allowLiveCustomerKeyDelivery?: boolean;
  readonly protectedFulfillmentIds?: readonly string[];
  readonly audit?: AuditEventPort;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
}

export interface CustomerKeyDeliveryPrepareResult {
  readonly status: "AUTHORIZED" | "BLOCKED";
  readonly reasonCode: CustomerKeyDeliveryReasonCode;
  readonly deliveryApprovalId?: string;
  readonly oneTimeCapability?: string;
  readonly expiresAt?: string;
  readonly message?: string;
}

export interface CustomerKeyDeliveryExecuteResult {
  readonly status:
    | "DELIVERED"
    | "ALREADY_DELIVERED"
    | "BLOCKED"
    | "IN_FLIGHT"
    | "FAILED_RETRYABLE"
    | "FAILED_TERMINAL"
    | "AMBIGUOUS"
    | "MANUAL_REVIEW_REQUIRED";
  readonly reasonCode: CustomerKeyDeliveryReasonCode;
  readonly fulfillmentId?: string;
  readonly deliveryReference?: string;
  readonly channel?: CustomerKeyDeliveryChannel;
}

export class CustomerKeyDeliveryService {
  private readonly now: () => Date;
  private readonly environment: AuditEvent["environment"];
  private readonly protectedFulfillmentIds: ReadonlySet<string>;

  public constructor(
    private readonly options: CustomerKeyDeliveryServiceOptions,
  ) {
    if (
      !Number.isInteger(options.approvalTtlMs) ||
      options.approvalTtlMs <= 0 ||
      !Number.isInteger(options.deliveryLeaseStaleAfterMs) ||
      options.deliveryLeaseStaleAfterMs <= 0
    ) {
      throw new Error("Customer delivery timing configuration is invalid");
    }
    this.now = options.now ?? (() => new Date());
    this.environment = options.environment ?? "LOCAL";
    this.protectedFulfillmentIds = new Set(
      options.protectedFulfillmentIds ?? [],
    );
  }

  public async prepareDelivery(input: {
    readonly customerId: CustomerId;
    readonly orderId: OrderId;
    readonly fulfillmentId: string;
    readonly correlationId: CorrelationId;
  }): Promise<CustomerKeyDeliveryPrepareResult> {
    if (this.liveGateBlocks(input.fulfillmentId)) {
      return {
        reasonCode: "FULFILLMENT_LIVE_DELIVERY_DISABLED",
        status: "BLOCKED",
      };
    }
    const fulfillment = await this.options.fulfillmentRepository.findById(
      input.fulfillmentId,
    );
    if (!deliveryReady(fulfillment, input.orderId)) {
      return {
        reasonCode: notReadyReason(fulfillment),
        status: "BLOCKED",
      };
    }
    const now = this.now();
    const authorization = customerDeliveryAuthorization({
      customerId: input.customerId,
      expiresAt: new Date(now.getTime() + this.options.approvalTtlMs),
      fulfillmentId: input.fulfillmentId,
      issuedAt: now,
      orderId: input.orderId,
    });
    const ownership =
      await this.options.orderAuthorization.authorizeDelivery(authorization);
    if (ownership.status !== "AUTHORIZED") {
      return {
        reasonCode: "FULFILLMENT_DELIVERY_UNAUTHORIZED",
        status: "BLOCKED",
      };
    }
    const token = generateCustomerDeliveryCapability();
    const approval: CustomerKeyDeliveryApproval = {
      ...authorization,
      contextFingerprint:
        customerDeliveryAuthorizationFingerprint(authorization),
      correlationId: input.correlationId,
      createdAt: now,
      id: randomUUID(),
      recordVersion: 1,
      status: "AUTHORIZED",
      tokenHash: hashCustomerDeliveryCapability(token),
      updatedAt: now,
    };
    const created = await this.options.deliveryRepository.createApproval({
      approval,
      now,
    });
    await this.audit(
      input.correlationId,
      input.fulfillmentId,
      input.orderId,
      input.customerId,
      "FULFILLMENT_DELIVERY_AUTHORIZED",
      "SUCCEEDED",
      created.status === "CREATED"
        ? "FULFILLMENT_DELIVERY_AUTHORIZED"
        : "FULFILLMENT_DELIVERY_ALREADY_AUTHORIZED",
    );
    if (created.status === "EXISTING") {
      return {
        deliveryApprovalId: created.approval.id,
        expiresAt: created.approval.expiresAt.toISOString(),
        message: "NO PRODUCT KEY HAS BEEN DELIVERED.",
        reasonCode: "FULFILLMENT_DELIVERY_ALREADY_AUTHORIZED",
        status: "BLOCKED",
      };
    }
    return {
      deliveryApprovalId: approval.id,
      expiresAt: approval.expiresAt.toISOString(),
      message: "NO PRODUCT KEY HAS BEEN DELIVERED.",
      oneTimeCapability: token,
      reasonCode: "FULFILLMENT_DELIVERY_AUTHORIZED",
      status: "AUTHORIZED",
    };
  }

  public async executeDelivery(input: {
    readonly deliveryApprovalId: string;
    readonly capability: string;
    readonly customerId: CustomerId;
    readonly orderId: OrderId;
    readonly fulfillmentId: string;
    readonly channel: CustomerKeyDeliveryChannel;
    readonly correlationId: CorrelationId;
  }): Promise<CustomerKeyDeliveryExecuteResult> {
    if (this.liveGateBlocks(input.fulfillmentId)) {
      return {
        reasonCode: "FULFILLMENT_LIVE_DELIVERY_DISABLED",
        status: "BLOCKED",
      };
    }
    const authorization = customerDeliveryAuthorization({
      customerId: input.customerId,
      expiresAt: new Date(0),
      fulfillmentId: input.fulfillmentId,
      issuedAt: new Date(0),
      orderId: input.orderId,
    });
    const executionToken = randomUUID();
    const now = this.now();
    const claim = await this.options.deliveryRepository.claimDelivery({
      approvalId: input.deliveryApprovalId,
      channel: input.channel,
      contextFingerprint:
        customerDeliveryAuthorizationFingerprint(authorization),
      executionToken,
      now,
      staleStartedBefore: new Date(
        now.getTime() - this.options.deliveryLeaseStaleAfterMs,
      ),
      tokenHash: hashCustomerDeliveryCapability(input.capability),
    });
    if (claim.status !== "CLAIMED") {
      return claimResult(claim);
    }
    const approval = claim.approval;
    const attempt = claim.attempt;
    const freshAuthorization = customerDeliveryAuthorization({
      customerId: approval.customerId,
      expiresAt: approval.expiresAt,
      fulfillmentId: approval.fulfillmentId,
      issuedAt: approval.issuedAt,
      orderId: approval.orderId,
    });
    const ownership =
      await this.options.orderAuthorization.authorizeDelivery(
        freshAuthorization,
      );
    if (ownership.status !== "AUTHORIZED") {
      return this.failAttempt(
        attempt,
        executionToken,
        "FAILED_TERMINAL",
        "FULFILLMENT_DELIVERY_UNAUTHORIZED",
      );
    }
    const fulfillment = await this.options.fulfillmentRepository.findById(
      approval.fulfillmentId,
    );
    if (!deliveryReady(fulfillment, approval.orderId)) {
      return this.failAttempt(
        attempt,
        executionToken,
        "FAILED_TERMINAL",
        notReadyReason(fulfillment),
      );
    }
    const secret =
      await this.options.fulfillmentRepository.findSecretByFulfillmentId(
        approval.fulfillmentId,
      );
    if (!secret || !fulfillment) {
      return this.failAttempt(
        attempt,
        executionToken,
        "FAILED_TERMINAL",
        "FULFILLMENT_DELIVERY_NOT_READY",
      );
    }
    let plaintext: Buffer | null = null;
    let externalDeliveryConfirmed = false;
    try {
      plaintext = await this.decryptForImmediateDelivery(secret, fulfillment);
      const delivered = await this.options.deliveryPort.deliver({
        authorization: freshAuthorization,
        channel: input.channel,
        correlationId: input.correlationId,
        plaintext,
      });
      externalDeliveryConfirmed = true;
      const persisted = await this.options.deliveryRepository.markDelivered({
        attemptId: attempt.id,
        deliveredAt: delivered.deliveredAt,
        deliveryReference: delivered.deliveryReference,
        executionToken,
        outbox: deliveryOutboxEvent({
          attempt,
          delivered,
          fulfillment,
        }),
      });
      if (!persisted) {
        return this.possibleDeliveryOutcomeUnknown(attempt, executionToken);
      }
      await this.audit(
        input.correlationId,
        fulfillment.id,
        approval.orderId,
        approval.customerId,
        "FULFILLMENT_DELIVERED",
        "SUCCEEDED",
        "FULFILLMENT_DELIVERED",
        {
          channel: delivered.channel,
          deliveryReference: delivered.deliveryReference,
        },
      );
      return {
        channel: delivered.channel,
        deliveryReference: delivered.deliveryReference,
        fulfillmentId: fulfillment.id,
        reasonCode: "FULFILLMENT_DELIVERED",
        status: "DELIVERED",
      };
    } catch (error) {
      if (externalDeliveryConfirmed) {
        return this.possibleDeliveryOutcomeUnknown(attempt, executionToken);
      }
      const mapped = mapDeliveryError(error);
      return this.failAttempt(
        attempt,
        executionToken,
        mapped.status,
        mapped.reasonCode,
      );
    } finally {
      plaintext?.fill(0);
    }
  }

  private async possibleDeliveryOutcomeUnknown(
    attempt: CustomerKeyDeliveryAttempt,
    executionToken: string,
  ): Promise<CustomerKeyDeliveryExecuteResult> {
    try {
      return await this.failAttempt(
        attempt,
        executionToken,
        "MANUAL_REVIEW_REQUIRED",
        "FULFILLMENT_DELIVERY_OUTCOME_UNKNOWN",
      );
    } catch {
      return {
        channel: attempt.channel,
        fulfillmentId: attempt.fulfillmentId,
        reasonCode: "FULFILLMENT_DELIVERY_OUTCOME_UNKNOWN",
        status: "MANUAL_REVIEW_REQUIRED",
      };
    }
  }

  private async decryptForImmediateDelivery(
    secret: FulfillmentSecretRecord,
    fulfillment: FulfillmentOperation,
  ): Promise<Buffer> {
    try {
      return Buffer.from(
        await decryptFulfillmentSecret(
          secret,
          fulfillmentEncryptionContext(fulfillment),
          this.options.keyManagementProvider,
        ),
      );
    } catch {
      throw new Error("customer delivery key management failed");
    }
  }

  private async failAttempt(
    attempt: CustomerKeyDeliveryAttempt,
    executionToken: string,
    status: Extract<
      CustomerKeyDeliveryStatus,
      | "FAILED_RETRYABLE"
      | "FAILED_TERMINAL"
      | "AMBIGUOUS"
      | "MANUAL_REVIEW_REQUIRED"
    >,
    reasonCode: CustomerKeyDeliveryReasonCode,
  ): Promise<CustomerKeyDeliveryExecuteResult> {
    const updated = await this.options.deliveryRepository.markFailed({
      attemptId: attempt.id,
      executionToken,
      now: this.now(),
      reasonCode,
      status,
    });
    await this.audit(
      attempt.correlationId,
      attempt.fulfillmentId,
      attempt.orderId,
      attempt.customerId,
      status === "MANUAL_REVIEW_REQUIRED"
        ? "FULFILLMENT_DELIVERY_MANUAL_REVIEW_REQUIRED"
        : "FULFILLMENT_DELIVERY_FAILED",
      "FAILED",
      reasonCode,
      { channel: attempt.channel },
    );
    return {
      channel: attempt.channel,
      fulfillmentId: attempt.fulfillmentId,
      reasonCode,
      status: executeStatusForFailure(updated?.status ?? status),
    };
  }

  private liveGateBlocks(fulfillmentId: string): boolean {
    return (
      this.protectedFulfillmentIds.has(fulfillmentId) &&
      this.options.allowLiveCustomerKeyDelivery !== true
    );
  }

  private async audit(
    correlationIdValue: CorrelationId,
    fulfillmentId: string,
    orderIdValue: OrderId,
    customerIdValue: CustomerId,
    eventType: AuditEvent["eventType"],
    outcome: AuditEvent["outcome"],
    reasonCode: CustomerKeyDeliveryReasonCode,
    metadata: Readonly<Record<string, string | number | boolean | null>> = {},
  ): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "customer-key-delivery", type: "SERVICE" },
      correlationId: correlationIdValue,
      entity: { id: fulfillmentId, type: "FULFILLMENT_OPERATION" },
      environment: this.environment,
      eventType,
      metadata: {
        customerId: customerIdValue,
        fulfillmentId,
        orderId: orderIdValue,
        reasonCode,
        ...metadata,
      },
      outcome,
      reasonCode,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }
}

export const customerDeliveryAuthorization = (input: {
  readonly customerId: CustomerId;
  readonly orderId: OrderId;
  readonly fulfillmentId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}): CustomerDeliveryAuthorization => ({
  customerId: input.customerId,
  expiresAt: input.expiresAt,
  fulfillmentId: input.fulfillmentId,
  issuedAt: input.issuedAt,
  orderId: input.orderId,
  purpose: "customer-key-delivery",
  version: 1,
});

export const customerDeliveryAuthorizationFingerprint = (
  authorization: Pick<
    CustomerDeliveryAuthorization,
    "customerId" | "orderId" | "fulfillmentId" | "purpose" | "version"
  >,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        customerId: authorization.customerId,
        fulfillmentId: authorization.fulfillmentId,
        orderId: authorization.orderId,
        purpose: authorization.purpose,
        version: authorization.version,
      }),
    )
    .digest("hex");

export const generateCustomerDeliveryCapability = (): string =>
  randomBytes(32).toString("base64url");

export const hashCustomerDeliveryCapability = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export const customerDeliverySafeInspect = (input: {
  readonly fulfillment: FulfillmentOperation;
  readonly latestAttempt?: CustomerKeyDeliveryAttempt | null;
  readonly secret?: FulfillmentSecretRecord | null;
}): Readonly<Record<string, string | number | boolean | null>> => ({
  channel: input.latestAttempt?.channel ?? null,
  deliveredAt: input.fulfillment.deliveredAt?.toISOString() ?? null,
  deliveryReference: input.latestAttempt?.deliveryReference ?? null,
  deliveryState: input.fulfillment.deliveryState,
  encryptionKeyId: input.secret?.encryptionKeyId ?? null,
  encryptionVersion: input.secret?.encryptionVersion ?? null,
  failureReasonCode: input.latestAttempt?.failureReasonCode ?? null,
  fulfillmentId: input.fulfillment.id,
  hasEncryptedSecret: Boolean(input.fulfillment.encryptedSecretId),
  latestDeliveryAttemptStatus: input.latestAttempt?.status ?? null,
  retrievedAt: input.fulfillment.retrievedAt?.toISOString() ?? null,
  retrievalState: input.fulfillment.retrievalState,
  status: input.fulfillment.status,
});

const deliveryReady = (
  fulfillment: FulfillmentOperation | null,
  orderIdValue: OrderId,
): fulfillment is FulfillmentOperation =>
  Boolean(
    fulfillment &&
    fulfillment.orderId === orderIdValue &&
    fulfillment.status === "DELIVERY_PENDING" &&
    fulfillment.retrievalState === "RETRIEVED" &&
    fulfillment.deliveryState === "PENDING" &&
    fulfillment.encryptedSecretId,
  );

const notReadyReason = (
  fulfillment: FulfillmentOperation | null,
): CustomerKeyDeliveryReasonCode =>
  fulfillment?.deliveryState === "DELIVERED"
    ? "FULFILLMENT_ALREADY_DELIVERED"
    : "FULFILLMENT_DELIVERY_NOT_READY";

const claimResult = (
  claim: Exclude<
    Awaited<ReturnType<CustomerKeyDeliveryRepository["claimDelivery"]>>,
    { readonly status: "CLAIMED" }
  >,
): CustomerKeyDeliveryExecuteResult => {
  const reasonByStatus = {
    ALREADY_DELIVERED: "FULFILLMENT_ALREADY_DELIVERED",
    CONTEXT_MISMATCH: "FULFILLMENT_DELIVERY_CONTEXT_MISMATCH",
    EXPIRED: "FULFILLMENT_DELIVERY_AUTHORIZATION_EXPIRED",
    IN_FLIGHT: "FULFILLMENT_DELIVERY_IN_FLIGHT",
    MANUAL_REVIEW_REQUIRED: "FULFILLMENT_DELIVERY_OUTCOME_UNKNOWN",
    NOT_FOUND: "FULFILLMENT_DELIVERY_UNAUTHORIZED",
    TOKEN_INVALID: "FULFILLMENT_DELIVERY_TOKEN_INVALID",
  } as const satisfies Record<
    typeof claim.status,
    CustomerKeyDeliveryReasonCode
  >;
  const status: CustomerKeyDeliveryExecuteResult["status"] =
    claim.status === "ALREADY_DELIVERED"
      ? "ALREADY_DELIVERED"
      : claim.status === "IN_FLIGHT"
        ? "IN_FLIGHT"
        : claim.status === "MANUAL_REVIEW_REQUIRED"
          ? "MANUAL_REVIEW_REQUIRED"
          : "BLOCKED";
  const base: Pick<CustomerKeyDeliveryExecuteResult, "reasonCode" | "status"> =
    {
      reasonCode: reasonByStatus[claim.status],
      status,
    };
  const fulfillmentId =
    claim.approval?.fulfillmentId ?? claim.attempt?.fulfillmentId;
  return fulfillmentId ? { ...base, fulfillmentId } : base;
};

const executeStatusForFailure = (
  status: CustomerKeyDeliveryStatus,
): Extract<
  CustomerKeyDeliveryExecuteResult["status"],
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL"
  | "AMBIGUOUS"
  | "MANUAL_REVIEW_REQUIRED"
> => {
  if (
    status === "FAILED_RETRYABLE" ||
    status === "FAILED_TERMINAL" ||
    status === "AMBIGUOUS" ||
    status === "MANUAL_REVIEW_REQUIRED"
  ) {
    return status;
  }
  return "MANUAL_REVIEW_REQUIRED";
};

const deliveryOutboxEvent = (input: {
  readonly fulfillment: FulfillmentOperation;
  readonly attempt: CustomerKeyDeliveryAttempt;
  readonly delivered: CustomerKeyDeliveryPortResult;
}): CustomerKeyDeliveryOutboxEvent => ({
  aggregateId: input.fulfillment.id,
  aggregateType: "FULFILLMENT",
  correlationId: input.attempt.correlationId,
  eventDeduplicationKey: `fulfillment.delivered:${input.fulfillment.id}`,
  eventType: "fulfillment.delivered",
  payload: {
    ...fulfillmentOutboxPayload({
      ...input.fulfillment,
      deliveredAt: input.delivered.deliveredAt,
      deliveryState: "DELIVERED",
      status: "DELIVERED",
    }),
    channel: input.delivered.channel,
    deliveryReference: input.delivered.deliveryReference,
    reasonCode: "FULFILLMENT_DELIVERED",
  },
});

const mapDeliveryError = (
  error: unknown,
): {
  readonly status:
    "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "MANUAL_REVIEW_REQUIRED";
  readonly reasonCode: CustomerKeyDeliveryReasonCode;
} => {
  if (error instanceof CustomerKeyDeliveryError) {
    if (error.category === "AMBIGUOUS") {
      return {
        reasonCode: "FULFILLMENT_DELIVERY_OUTCOME_UNKNOWN",
        status: "MANUAL_REVIEW_REQUIRED",
      };
    }
    return error.category === "RETRYABLE"
      ? {
          reasonCode: "FULFILLMENT_DELIVERY_RETRYABLE",
          status: "FAILED_RETRYABLE",
        }
      : {
          reasonCode: "FULFILLMENT_DELIVERY_REJECTED",
          status: "FAILED_TERMINAL",
        };
  }
  if (
    error instanceof Error &&
    /key|decrypt|crypto|kms|verification/iu.test(error.message)
  ) {
    return {
      reasonCode: "FULFILLMENT_KEY_MANAGEMENT_FAILED",
      status: "FAILED_RETRYABLE",
    };
  }
  return {
    reasonCode: "FULFILLMENT_DELIVERY_LOCAL_UNKNOWN",
    status: "MANUAL_REVIEW_REQUIRED",
  };
};
