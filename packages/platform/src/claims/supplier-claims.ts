import { createHash, randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type { CorrelationId, OrderId } from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import {
  evaluateHighRiskOperation,
  type OperationsControlGate,
} from "../operations/operations-controls.js";

export type SupplierClaimCategory =
  | "KEY_NOT_WORKING"
  | "KEY_ALREADY_USED"
  | "KEY_NOT_RECEIVED_FROM_SUPPLIER"
  | "WRONG_PRODUCT"
  | "WRONG_REGION"
  | "DUPLICATE_FULFILLMENT"
  | "SUPPLIER_ORDER_PROBLEM"
  | "OTHER";

export type SupplierClaimSource = "SUPPORT" | "OPERATOR" | "SYSTEM";
export type SupplierClaimStatus =
  "OPEN" | "UNDER_REVIEW" | "READY_FOR_SUBMISSION" | "RESOLVED" | "CLOSED";
export type SupplierClaimPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type SupplierClaimOutcome =
  | "SUPPLIER_ACCEPTED"
  | "SUPPLIER_REJECTED"
  | "INFORMATION_REQUIRED"
  | "INTERNAL_NOT_ELIGIBLE"
  | "CUSTOMER_ISSUE_RESOLVED"
  | "NO_SUPPLIER_ACTION_REQUIRED";
export type SupplierClaimSubmissionStatus =
  | "NOT_PREPARED"
  | "PREPARED"
  | "DISPATCHING"
  | "CONFIRMED"
  | "AMBIGUOUS"
  | "FAILED";

export type SupplierClaimEventType =
  | "CLAIM_CREATED"
  | "CLAIM_STATUS_CHANGED"
  | "EVIDENCE_LINKED"
  | "SUBMISSION_PREPARED"
  | "SUBMISSION_DISPATCHING"
  | "SUBMISSION_CONFIRMED"
  | "SUBMISSION_AMBIGUOUS"
  | "SUBMISSION_FAILED"
  | "CLAIM_RESOLVED"
  | "CLAIM_CLOSED";

export type SupplierClaimFailureCode =
  | "BAD_REQUEST"
  | "CONFLICT"
  | "EVIDENCE_NOT_FINALIZED"
  | "INVALID_TRANSITION"
  | "NOT_ELIGIBLE"
  | "RESOURCE_NOT_AVAILABLE"
  | "STALE_VERSION"
  | "SUBMISSION_UNAVAILABLE"
  | "OPERATIONS_CONTROL_PAUSED"
  | "OPERATIONS_CONTROL_UNAVAILABLE"
  | "UNTRUSTED_AUTHORITY";

export interface SupplierClaim {
  readonly id: string;
  readonly orderId: OrderId;
  readonly supportCaseId: string;
  readonly procurementOperationId: string;
  readonly fulfillmentId: string | null;
  readonly supplierId: string;
  readonly supplierOrderReference: string | null;
  readonly category: SupplierClaimCategory;
  readonly source: SupplierClaimSource;
  readonly status: SupplierClaimStatus;
  readonly priority: SupplierClaimPriority;
  readonly outcome: SupplierClaimOutcome | null;
  readonly idempotencyKey: string;
  readonly idempotencyFingerprint: string;
  readonly recordVersion: number;
  readonly correlationId: CorrelationId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly resolvedAt: Date | null;
  readonly closedAt: Date | null;
}

export interface SupplierClaimEvidenceLink {
  readonly id: string;
  readonly claimId: string;
  readonly evidenceSnapshotId: string;
  readonly orderId: OrderId;
  readonly createdAt: Date;
}

export interface SupplierClaimEvent {
  readonly id: string;
  readonly claimId: string;
  readonly eventType: SupplierClaimEventType;
  readonly actorType: "OPERATOR" | "SYSTEM";
  readonly actorReference: string;
  readonly fromStatus: SupplierClaimStatus | null;
  readonly toStatus: SupplierClaimStatus | null;
  readonly evidenceSnapshotId: string | null;
  readonly submissionOperationId: string | null;
  readonly occurredAt: Date;
}

export interface SupplierClaimSubmissionOperation {
  readonly id: string;
  readonly claimId: string;
  readonly orderId: OrderId;
  readonly supplierId: string;
  readonly supplierOrderReference: string;
  readonly status: Exclude<SupplierClaimSubmissionStatus, "NOT_PREPARED">;
  readonly idempotencyReference: string;
  readonly payloadFingerprint: string;
  readonly supplierClaimReference: string | null;
  readonly responseType: string | null;
  readonly recordVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly dispatchedAt: Date | null;
  readonly confirmedAt: Date | null;
}

export interface SupplierClaimDetail {
  readonly claim: SupplierClaim;
  readonly evidenceLinks: readonly SupplierClaimEvidenceLink[];
  readonly events: readonly SupplierClaimEvent[];
  readonly submission: SupplierClaimSubmissionOperation | null;
}

export interface SupplierClaimOrderReference {
  readonly orderId: OrderId;
}

export interface SupplierClaimSupportReference {
  readonly id: string;
  readonly orderId: OrderId | null;
  readonly category: string;
  readonly status: string;
}

export interface SupplierClaimProcurementReference {
  readonly id: string;
  readonly orderId: OrderId;
  readonly supplierId: string;
  readonly externalSupplierOrderId: string | null;
  readonly status: string;
  readonly dispatchState: string;
}

export interface SupplierClaimFulfillmentReference {
  readonly id: string;
  readonly orderId: OrderId | null;
  readonly procurementOperationId: string | null;
  readonly status: string;
  readonly retrievalState: string;
  readonly deliveryState: string;
}

export interface SupplierClaimEvidenceReference {
  readonly id: string;
  readonly orderId: OrderId;
  readonly state: string;
}

export interface SupplierClaimRepository {
  findOrder(orderId: OrderId): Promise<SupplierClaimOrderReference | null>;
  findSupportCase(id: string): Promise<SupplierClaimSupportReference | null>;
  findProcurementOperation(
    id: string,
  ): Promise<SupplierClaimProcurementReference | null>;
  findFulfillment(
    id: string,
  ): Promise<SupplierClaimFulfillmentReference | null>;
  findEvidence(id: string): Promise<SupplierClaimEvidenceReference | null>;
  createClaim(input: {
    readonly claim: SupplierClaim;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | { readonly status: "CREATED"; readonly detail: SupplierClaimDetail }
    | { readonly status: "EXISTING"; readonly detail: SupplierClaimDetail }
    | { readonly status: "CONFLICT" }
  >;
  findClaim(id: string): Promise<SupplierClaimDetail | null>;
  transitionClaim(input: {
    readonly claimId: string;
    readonly expectedVersion: number;
    readonly nextStatus: SupplierClaimStatus;
    readonly outcome: SupplierClaimOutcome | null;
    readonly now: Date;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | { readonly status: "UPDATED"; readonly detail: SupplierClaimDetail }
    | { readonly status: "NOT_FOUND" | "STALE_VERSION" }
  >;
  linkEvidence(input: {
    readonly claimId: string;
    readonly link: SupplierClaimEvidenceLink;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | {
        readonly status: "LINKED" | "EXISTING";
        readonly detail: SupplierClaimDetail;
      }
    | { readonly status: "NOT_FOUND" }
  >;
  prepareSubmission(input: {
    readonly operation: SupplierClaimSubmissionOperation;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | {
        readonly status: "PREPARED" | "EXISTING";
        readonly detail: SupplierClaimDetail;
      }
    | { readonly status: "NOT_FOUND" | "NOT_READY" }
  >;
  acquireSubmission(input: {
    readonly claimId: string;
    readonly operationId: string;
    readonly expectedVersion: number;
    readonly now: Date;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | { readonly status: "ACQUIRED"; readonly detail: SupplierClaimDetail }
    | { readonly status: "NOT_FOUND" | "NOT_PREPARED" | "STALE_VERSION" }
  >;
  completeSubmission(input: {
    readonly claimId: string;
    readonly operationId: string;
    readonly expectedVersion: number;
    readonly status: "CONFIRMED" | "AMBIGUOUS" | "FAILED";
    readonly supplierClaimReference: string | null;
    readonly responseType: string | null;
    readonly now: Date;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | { readonly status: "UPDATED"; readonly detail: SupplierClaimDetail }
    | { readonly status: "NOT_FOUND" | "STALE_VERSION" }
  >;
}

export type SupplierClaimAuthorityAction =
  | "CREATE"
  | "CHANGE_STATUS"
  | "LINK_EVIDENCE"
  | "PREPARE_SUBMISSION"
  | "SUBMIT";

export interface SupplierClaimAuthorityPort {
  authorize(input: {
    readonly action: SupplierClaimAuthorityAction;
    readonly claimId?: string;
    readonly correlationId: CorrelationId;
  }): Promise<
    | { readonly status: "AUTHORIZED"; readonly actorReference: string }
    | { readonly status: "DENIED" }
  >;
}

export class FailClosedSupplierClaimAuthority implements SupplierClaimAuthorityPort {
  public async authorize(): Promise<{ readonly status: "DENIED" }> {
    return { status: "DENIED" };
  }
}

export interface SupplierClaimSubmissionPayload {
  readonly claimId: string;
  readonly orderId: OrderId;
  readonly supplierOrderReference: string;
  readonly category: SupplierClaimCategory;
  readonly evidenceSnapshotIds: readonly string[];
  readonly idempotencyReference: string;
}

export interface SupplierClaimSubmissionPort {
  isAvailable(supplierId: string): Promise<boolean>;
  submit(input: SupplierClaimSubmissionPayload): Promise<
    | {
        readonly status: "CONFIRMED";
        readonly supplierClaimReference: string;
        readonly responseType: "ACCEPTED" | "REJECTED" | "INFORMATION_REQUIRED";
      }
    | { readonly status: "AMBIGUOUS" }
    | {
        readonly status: "FAILED";
        readonly responseType: "RETRYABLE" | "TERMINAL";
      }
  >;
}

export class UnavailableSupplierClaimSubmissionPort implements SupplierClaimSubmissionPort {
  public async isAvailable(): Promise<boolean> {
    return false;
  }

  public async submit(): Promise<never> {
    throw new Error("Supplier claim submission is not configured");
  }
}

export type SupplierClaimResult =
  | {
      readonly status: "OK" | "CREATED" | "EXISTING";
      readonly detail: SupplierClaimDetail;
    }
  | { readonly status: "FAILED"; readonly code: SupplierClaimFailureCode };

const categories = new Set<SupplierClaimCategory>([
  "KEY_NOT_WORKING",
  "KEY_ALREADY_USED",
  "KEY_NOT_RECEIVED_FROM_SUPPLIER",
  "WRONG_PRODUCT",
  "WRONG_REGION",
  "DUPLICATE_FULFILLMENT",
  "SUPPLIER_ORDER_PROBLEM",
  "OTHER",
]);
const priorities = new Set<SupplierClaimPriority>([
  "LOW",
  "NORMAL",
  "HIGH",
  "URGENT",
]);
const outcomes = new Set<SupplierClaimOutcome>([
  "SUPPLIER_ACCEPTED",
  "SUPPLIER_REJECTED",
  "INFORMATION_REQUIRED",
  "INTERNAL_NOT_ELIGIBLE",
  "CUSTOMER_ISSUE_RESOLVED",
  "NO_SUPPLIER_ACTION_REQUIRED",
]);
const eligibleSupportStatuses = new Set([
  "OPEN",
  "IN_PROGRESS",
  "WAITING_FOR_INTERNAL",
]);
const supportCategoryMappings: Readonly<
  Record<string, ReadonlySet<SupplierClaimCategory>>
> = {
  ACTIVATION_PROBLEM: new Set([
    "KEY_NOT_WORKING",
    "KEY_ALREADY_USED",
    "WRONG_PRODUCT",
    "WRONG_REGION",
  ]),
  KEY_NOT_AVAILABLE: new Set([
    "KEY_NOT_RECEIVED_FROM_SUPPLIER",
    "SUPPLIER_ORDER_PROBLEM",
  ]),
  SUPPLIER_PROBLEM: categories,
};
const fulfillmentRequiredCategories = new Set<SupplierClaimCategory>([
  "KEY_NOT_WORKING",
  "KEY_ALREADY_USED",
  "WRONG_PRODUCT",
  "WRONG_REGION",
  "DUPLICATE_FULFILLMENT",
]);
const forbiddenCreateFields = new Set([
  "approved",
  "canSubmit",
  "ciphertext",
  "customerMessage",
  "isAdmin",
  "key",
  "message",
  "operatorId",
  "operatorReference",
  "productKey",
  "rawRequest",
  "rawResponse",
  "supplierAccepted",
]);
const transitionGraph: Readonly<
  Record<SupplierClaimStatus, readonly SupplierClaimStatus[]>
> = {
  OPEN: ["UNDER_REVIEW", "RESOLVED"],
  UNDER_REVIEW: ["READY_FOR_SUBMISSION", "RESOLVED"],
  READY_FOR_SUBMISSION: ["UNDER_REVIEW", "RESOLVED"],
  RESOLVED: ["CLOSED"],
  CLOSED: [],
};

export class SupplierClaimService {
  private readonly authority: SupplierClaimAuthorityPort;
  private readonly submissionPort: SupplierClaimSubmissionPort;

  public constructor(
    private readonly options: {
      readonly repository: SupplierClaimRepository;
      readonly authority?: SupplierClaimAuthorityPort;
      readonly submissionPort?: SupplierClaimSubmissionPort;
      readonly operationsControlGate?: OperationsControlGate;
      readonly audit?: AuditEventPort;
      readonly environment?: AuditEvent["environment"];
      readonly now?: () => Date;
    },
  ) {
    this.authority =
      options.authority ?? new FailClosedSupplierClaimAuthority();
    this.submissionPort =
      options.submissionPort ?? new UnavailableSupplierClaimSubmissionPort();
  }

  public async createClaim(input: {
    readonly orderId: OrderId;
    readonly supportCaseId: string;
    readonly procurementOperationId: string;
    readonly fulfillmentId?: string | null;
    readonly category: SupplierClaimCategory;
    readonly source: SupplierClaimSource;
    readonly priority?: SupplierClaimPriority;
    readonly idempotencyKey: string;
    readonly correlationId: CorrelationId;
    readonly supplierId?: unknown;
    readonly externalSupplierOrderId?: unknown;
    readonly [key: string]: unknown;
  }): Promise<SupplierClaimResult> {
    if (
      !isUuid(input.orderId) ||
      !isUuid(input.supportCaseId) ||
      !isUuid(input.procurementOperationId) ||
      (input.fulfillmentId != null && !isUuid(input.fulfillmentId)) ||
      !categories.has(input.category) ||
      !["SUPPORT", "OPERATOR", "SYSTEM"].includes(input.source) ||
      (input.priority !== undefined && !priorities.has(input.priority)) ||
      !isSafeBounded(input.idempotencyKey, 128) ||
      !isSafeBounded(input.correlationId, 128) ||
      input.supplierId !== undefined ||
      input.externalSupplierOrderId !== undefined ||
      Object.keys(input).some((key) => forbiddenCreateFields.has(key))
    ) {
      return failed("BAD_REQUEST");
    }
    const authorization = await this.authority.authorize({
      action: "CREATE",
      correlationId: input.correlationId,
    });
    if (
      authorization.status !== "AUTHORIZED" ||
      !isSafeActorReference(authorization.actorReference)
    ) {
      return failed("UNTRUSTED_AUTHORITY");
    }
    const [order, support, procurement] = await Promise.all([
      this.options.repository.findOrder(input.orderId),
      this.options.repository.findSupportCase(input.supportCaseId),
      this.options.repository.findProcurementOperation(
        input.procurementOperationId,
      ),
    ]);
    if (!order || !support || !procurement) {
      return failed("RESOURCE_NOT_AVAILABLE");
    }
    if (
      !isSafeBounded(procurement.supplierId, 120) ||
      (procurement.externalSupplierOrderId !== null &&
        !isSafeExternalReference(procurement.externalSupplierOrderId))
    ) {
      return failed("NOT_ELIGIBLE");
    }
    if (
      support.orderId !== input.orderId ||
      procurement.orderId !== input.orderId
    ) {
      return failed("RESOURCE_NOT_AVAILABLE");
    }
    if (!eligibleSupportStatuses.has(support.status)) {
      return failed("NOT_ELIGIBLE");
    }
    const allowedCategories = supportCategoryMappings[support.category];
    if (!allowedCategories?.has(input.category)) {
      return failed("NOT_ELIGIBLE");
    }
    const ambiguousProcurement = [
      "AMBIGUOUS",
      "RECONCILIATION_REQUIRED",
    ].includes(procurement.status);
    if (
      procurement.status !== "SUCCEEDED" &&
      !(ambiguousProcurement && input.category === "SUPPLIER_ORDER_PROBLEM")
    ) {
      return failed("NOT_ELIGIBLE");
    }
    if (
      procurement.status === "SUCCEEDED" &&
      procurement.dispatchState !== "DISPATCH_CONFIRMED"
    ) {
      return failed("NOT_ELIGIBLE");
    }
    let fulfillment: SupplierClaimFulfillmentReference | null = null;
    if (input.fulfillmentId) {
      fulfillment = await this.options.repository.findFulfillment(
        input.fulfillmentId,
      );
      if (
        !fulfillment ||
        fulfillment.orderId !== input.orderId ||
        fulfillment.procurementOperationId !== procurement.id
      ) {
        return failed("RESOURCE_NOT_AVAILABLE");
      }
    }
    if (fulfillmentRequiredCategories.has(input.category) && !fulfillment) {
      return failed("NOT_ELIGIBLE");
    }
    const now = this.now();
    if (!isSafeDate(now)) {
      return failed("BAD_REQUEST");
    }
    const fingerprint = hashCanonical({
      category: input.category,
      fulfillmentId: fulfillment?.id ?? null,
      orderId: input.orderId,
      procurementOperationId: procurement.id,
      source: input.source,
      supportCaseId: support.id,
    });
    const claim: SupplierClaim = {
      category: input.category,
      closedAt: null,
      correlationId: input.correlationId,
      createdAt: now,
      fulfillmentId: fulfillment?.id ?? null,
      id: randomUUID(),
      idempotencyFingerprint: fingerprint,
      idempotencyKey: input.idempotencyKey,
      orderId: input.orderId,
      outcome: null,
      priority: input.priority ?? "NORMAL",
      procurementOperationId: procurement.id,
      recordVersion: 1,
      resolvedAt: null,
      source: input.source,
      status: "OPEN",
      supplierId: procurement.supplierId,
      supplierOrderReference: procurement.externalSupplierOrderId,
      supportCaseId: support.id,
      updatedAt: now,
    };
    const event = makeEvent({
      actorReference: authorization.actorReference,
      actorType: input.source === "SYSTEM" ? "SYSTEM" : "OPERATOR",
      claimId: claim.id,
      eventType: "CLAIM_CREATED",
      now,
      toStatus: "OPEN",
    });
    const persisted = await this.options.repository.createClaim({
      claim,
      event,
    });
    if (persisted.status === "CONFLICT") {
      return failed("CONFLICT");
    }
    await this.audit(
      persisted.detail.claim,
      authorization.actorReference,
      input.correlationId,
      "SUPPLIER_CLAIM_CREATED",
      persisted.status,
    );
    return { detail: persisted.detail, status: persisted.status };
  }

  public async transitionClaim(input: {
    readonly claimId: string;
    readonly expectedVersion: number;
    readonly nextStatus: SupplierClaimStatus;
    readonly outcome?: SupplierClaimOutcome | null;
    readonly correlationId: CorrelationId;
  }): Promise<SupplierClaimResult> {
    if (
      !isUuid(input.claimId) ||
      !isVersion(input.expectedVersion) ||
      !isSafeBounded(input.correlationId, 128)
    ) {
      return failed("BAD_REQUEST");
    }
    const detail = await this.options.repository.findClaim(input.claimId);
    if (!detail) return failed("RESOURCE_NOT_AVAILABLE");
    if (!transitionGraph[detail.claim.status]?.includes(input.nextStatus)) {
      return failed("INVALID_TRANSITION");
    }
    const outcome = input.outcome ?? null;
    if (
      (input.nextStatus === "RESOLVED" || input.nextStatus === "CLOSED") !==
      (outcome !== null ||
        (input.nextStatus === "CLOSED" && detail.claim.outcome !== null))
    ) {
      return failed("BAD_REQUEST");
    }
    if (outcome !== null && !outcomes.has(outcome))
      return failed("BAD_REQUEST");
    if (
      [
        "SUPPLIER_ACCEPTED",
        "SUPPLIER_REJECTED",
        "INFORMATION_REQUIRED",
      ].includes(outcome ?? "") &&
      detail.submission?.status !== "CONFIRMED"
    ) {
      return failed("NOT_ELIGIBLE");
    }
    const authorization = await this.authority.authorize({
      action: "CHANGE_STATUS",
      claimId: input.claimId,
      correlationId: input.correlationId,
    });
    if (
      authorization.status !== "AUTHORIZED" ||
      !isSafeActorReference(authorization.actorReference)
    )
      return failed("UNTRUSTED_AUTHORITY");
    const now = this.now();
    const eventType =
      input.nextStatus === "RESOLVED"
        ? "CLAIM_RESOLVED"
        : input.nextStatus === "CLOSED"
          ? "CLAIM_CLOSED"
          : "CLAIM_STATUS_CHANGED";
    const updated = await this.options.repository.transitionClaim({
      claimId: input.claimId,
      event: makeEvent({
        actorReference: authorization.actorReference,
        actorType: "OPERATOR",
        claimId: input.claimId,
        eventType,
        fromStatus: detail.claim.status,
        now,
        toStatus: input.nextStatus,
      }),
      expectedVersion: input.expectedVersion,
      nextStatus: input.nextStatus,
      now,
      outcome:
        outcome ??
        (input.nextStatus === "CLOSED" ? detail.claim.outcome : null),
    });
    if (updated.status !== "UPDATED")
      return failed(
        updated.status === "STALE_VERSION"
          ? "STALE_VERSION"
          : "RESOURCE_NOT_AVAILABLE",
      );
    await this.audit(
      updated.detail.claim,
      authorization.actorReference,
      input.correlationId,
      "SUPPLIER_CLAIM_STATUS_CHANGED",
      input.nextStatus,
    );
    return { detail: updated.detail, status: "OK" };
  }

  public async linkEvidence(input: {
    readonly claimId: string;
    readonly evidenceSnapshotId: string;
    readonly correlationId: CorrelationId;
  }): Promise<SupplierClaimResult> {
    if (
      !isUuid(input.claimId) ||
      !isUuid(input.evidenceSnapshotId) ||
      !isSafeBounded(input.correlationId, 128)
    )
      return failed("BAD_REQUEST");
    const authorization = await this.authority.authorize({
      action: "LINK_EVIDENCE",
      claimId: input.claimId,
      correlationId: input.correlationId,
    });
    if (
      authorization.status !== "AUTHORIZED" ||
      !isSafeActorReference(authorization.actorReference)
    )
      return failed("UNTRUSTED_AUTHORITY");
    const [detail, evidence] = await Promise.all([
      this.options.repository.findClaim(input.claimId),
      this.options.repository.findEvidence(input.evidenceSnapshotId),
    ]);
    if (!detail || !evidence || evidence.orderId !== detail.claim.orderId)
      return failed("RESOURCE_NOT_AVAILABLE");
    if (detail.submission) return failed("NOT_ELIGIBLE");
    if (evidence.state !== "FINALIZED") return failed("EVIDENCE_NOT_FINALIZED");
    const now = this.now();
    const link: SupplierClaimEvidenceLink = {
      claimId: input.claimId,
      createdAt: now,
      evidenceSnapshotId: evidence.id,
      id: randomUUID(),
      orderId: detail.claim.orderId,
    };
    const linked = await this.options.repository.linkEvidence({
      claimId: input.claimId,
      event: makeEvent({
        actorReference: authorization.actorReference,
        actorType: "OPERATOR",
        claimId: input.claimId,
        eventType: "EVIDENCE_LINKED",
        evidenceSnapshotId: evidence.id,
        now,
      }),
      link,
    });
    if (linked.status === "NOT_FOUND") return failed("RESOURCE_NOT_AVAILABLE");
    if (linked.status === "LINKED")
      await this.audit(
        linked.detail.claim,
        authorization.actorReference,
        input.correlationId,
        "SUPPLIER_CLAIM_EVIDENCE_LINKED",
        "LINKED",
      );
    return {
      detail: linked.detail,
      status: linked.status === "EXISTING" ? "EXISTING" : "OK",
    };
  }

  public async prepareSubmission(input: {
    readonly claimId: string;
    readonly correlationId: CorrelationId;
  }): Promise<SupplierClaimResult> {
    if (!isUuid(input.claimId) || !isSafeBounded(input.correlationId, 128))
      return failed("BAD_REQUEST");
    const authorization = await this.authority.authorize({
      action: "PREPARE_SUBMISSION",
      claimId: input.claimId,
      correlationId: input.correlationId,
    });
    if (
      authorization.status !== "AUTHORIZED" ||
      !isSafeActorReference(authorization.actorReference)
    )
      return failed("UNTRUSTED_AUTHORITY");
    const detail = await this.options.repository.findClaim(input.claimId);
    if (!detail) return failed("RESOURCE_NOT_AVAILABLE");
    if (
      detail.claim.status !== "READY_FOR_SUBMISSION" ||
      !detail.claim.supplierOrderReference
    )
      return failed("NOT_ELIGIBLE");
    const now = this.now();
    const idempotencyReference = `keycore:supplier-claim:${detail.claim.id}`;
    const operation: SupplierClaimSubmissionOperation = {
      claimId: detail.claim.id,
      confirmedAt: null,
      createdAt: now,
      dispatchedAt: null,
      id: randomUUID(),
      idempotencyReference,
      orderId: detail.claim.orderId,
      payloadFingerprint: hashCanonical(
        submissionPayloadFromDetail(detail, idempotencyReference),
      ),
      recordVersion: 1,
      responseType: null,
      status: "PREPARED",
      supplierClaimReference: null,
      supplierId: detail.claim.supplierId,
      supplierOrderReference: detail.claim.supplierOrderReference,
      updatedAt: now,
    };
    const prepared = await this.options.repository.prepareSubmission({
      event: makeEvent({
        actorReference: authorization.actorReference,
        actorType: "OPERATOR",
        claimId: input.claimId,
        eventType: "SUBMISSION_PREPARED",
        now,
        submissionOperationId: operation.id,
      }),
      operation,
    });
    if (!("detail" in prepared)) {
      return failed(
        prepared.status === "NOT_FOUND"
          ? "RESOURCE_NOT_AVAILABLE"
          : "NOT_ELIGIBLE",
      );
    }
    await this.audit(
      prepared.detail.claim,
      authorization.actorReference,
      input.correlationId,
      "SUPPLIER_CLAIM_SUBMISSION_PREPARED",
      prepared.status,
    );
    return {
      detail: prepared.detail,
      status: prepared.status === "EXISTING" ? "EXISTING" : "OK",
    };
  }

  public async executeSubmission(input: {
    readonly claimId: string;
    readonly expectedSubmissionVersion: number;
    readonly correlationId: CorrelationId;
  }): Promise<SupplierClaimResult> {
    if (
      !isUuid(input.claimId) ||
      !isVersion(input.expectedSubmissionVersion) ||
      !isSafeBounded(input.correlationId, 128)
    )
      return failed("BAD_REQUEST");
    const detail = await this.options.repository.findClaim(input.claimId);
    if (!detail?.submission || detail.submission.status !== "PREPARED")
      return failed("NOT_ELIGIBLE");
    if (detail.claim.status !== "READY_FOR_SUBMISSION")
      return failed("NOT_ELIGIBLE");
    const authorization = await this.authority.authorize({
      action: "SUBMIT",
      claimId: input.claimId,
      correlationId: input.correlationId,
    });
    if (
      authorization.status !== "AUTHORIZED" ||
      !isSafeActorReference(authorization.actorReference)
    )
      return failed("UNTRUSTED_AUTHORITY");
    let submissionAvailable = false;
    try {
      submissionAvailable = await this.submissionPort.isAvailable(
        detail.claim.supplierId,
      );
    } catch {
      return failed("SUBMISSION_UNAVAILABLE");
    }
    if (!submissionAvailable) return failed("SUBMISSION_UNAVAILABLE");
    const operations = await evaluateHighRiskOperation(
      this.options.operationsControlGate,
      "SUPPLIER_CLAIM_SUBMISSION",
    );
    if (operations.status === "DENIED") return failed(operations.reasonCode);
    const now = this.now();
    const acquired = await this.options.repository.acquireSubmission({
      claimId: input.claimId,
      event: makeEvent({
        actorReference: authorization.actorReference,
        actorType: "OPERATOR",
        claimId: input.claimId,
        eventType: "SUBMISSION_DISPATCHING",
        now,
        submissionOperationId: detail.submission.id,
      }),
      expectedVersion: input.expectedSubmissionVersion,
      now,
      operationId: detail.submission.id,
    });
    if (acquired.status !== "ACQUIRED")
      return failed(
        acquired.status === "STALE_VERSION"
          ? "STALE_VERSION"
          : acquired.status === "NOT_FOUND"
            ? "RESOURCE_NOT_AVAILABLE"
            : "NOT_ELIGIBLE",
      );
    let result: Awaited<ReturnType<SupplierClaimSubmissionPort["submit"]>>;
    try {
      result = await this.submissionPort.submit(
        toSubmissionPayload(acquired.detail),
      );
    } catch {
      result = { status: "AMBIGUOUS" };
    }
    if (
      (result.status === "CONFIRMED" &&
        (!isSafeExternalReference(result.supplierClaimReference) ||
          !["ACCEPTED", "REJECTED", "INFORMATION_REQUIRED"].includes(
            result.responseType,
          ))) ||
      (result.status === "FAILED" &&
        !["RETRYABLE", "TERMINAL"].includes(result.responseType))
    ) {
      result = { status: "AMBIGUOUS" };
    }
    const current = acquired.detail.submission;
    if (!current) return failed("RESOURCE_NOT_AVAILABLE");
    const completedAt = this.now();
    const eventType =
      result.status === "CONFIRMED"
        ? "SUBMISSION_CONFIRMED"
        : result.status === "AMBIGUOUS"
          ? "SUBMISSION_AMBIGUOUS"
          : "SUBMISSION_FAILED";
    const completed = await this.options.repository.completeSubmission({
      claimId: input.claimId,
      event: makeEvent({
        actorReference: authorization.actorReference,
        actorType: "OPERATOR",
        claimId: input.claimId,
        eventType,
        now: completedAt,
        submissionOperationId: current.id,
      }),
      expectedVersion: current.recordVersion,
      now: completedAt,
      operationId: current.id,
      responseType:
        result.status === "CONFIRMED" || result.status === "FAILED"
          ? result.responseType
          : null,
      status: result.status,
      supplierClaimReference:
        result.status === "CONFIRMED" ? result.supplierClaimReference : null,
    });
    if (completed.status !== "UPDATED")
      return failed(
        completed.status === "STALE_VERSION"
          ? "STALE_VERSION"
          : "RESOURCE_NOT_AVAILABLE",
      );
    await this.audit(
      completed.detail.claim,
      authorization.actorReference,
      input.correlationId,
      `SUPPLIER_CLAIM_SUBMISSION_${result.status}`,
      result.status,
    );
    return { detail: completed.detail, status: "OK" };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async audit(
    claim: SupplierClaim,
    actorReference: string,
    correlation: CorrelationId,
    eventType: `SUPPLIER_CLAIM_${string}`,
    reasonCode: string,
  ): Promise<void> {
    if (!this.options.audit) return;
    try {
      await this.options.audit.append({
        actor: { id: actorReference, type: "ADMIN" },
        correlationId: correlation,
        entity: { id: claim.id, type: "SupplierClaim" },
        environment: this.options.environment ?? "LOCAL",
        eventType,
        metadata: {
          category: claim.category,
          claimId: claim.id,
          orderId: claim.orderId,
          source: claim.source,
          status: claim.status,
          supplierId: claim.supplierId,
        },
        outcome: "SUCCEEDED",
        reasonCode,
        timestampUtc: this.now(),
        uuid: randomUUID(),
      });
    } catch {
      // Claim persistence is authoritative; audit is best-effort by project convention.
    }
  }
}

const makeEvent = (input: {
  readonly actorReference: string;
  readonly actorType: "OPERATOR" | "SYSTEM";
  readonly claimId: string;
  readonly eventType: SupplierClaimEventType;
  readonly now: Date;
  readonly fromStatus?: SupplierClaimStatus | null;
  readonly toStatus?: SupplierClaimStatus | null;
  readonly evidenceSnapshotId?: string | null;
  readonly submissionOperationId?: string | null;
}): SupplierClaimEvent => ({
  actorReference: input.actorReference,
  actorType: input.actorType,
  claimId: input.claimId,
  eventType: input.eventType,
  evidenceSnapshotId: input.evidenceSnapshotId ?? null,
  fromStatus: input.fromStatus ?? null,
  id: randomUUID(),
  occurredAt: input.now,
  submissionOperationId: input.submissionOperationId ?? null,
  toStatus: input.toStatus ?? null,
});

const failed = (code: SupplierClaimFailureCode): SupplierClaimResult => ({
  code,
  status: "FAILED",
});
const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
const isSafeBounded = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value === value.trim() &&
  value.length >= 1 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/u.test(value);
const isSafeExternalReference = (value: unknown): value is string =>
  isSafeBounded(value, 200) &&
  !/(product.?key|plaintext|api.?key|secret|token)/iu.test(value);
const isSafeActorReference = (value: unknown): value is string =>
  isSafeBounded(value, 128) &&
  !/(product.?key|plaintext|api.?key|secret|token)/iu.test(value);
const isVersion = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const isSafeDate = (value: Date): boolean =>
  !Number.isNaN(value.getTime()) &&
  value.getTime() >= Date.parse("2026-01-01T00:00:00.000Z");
const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
    .join(",")}}`;
};
const hashCanonical = (value: unknown): string =>
  createHash("sha256").update(canonicalize(value)).digest("hex");
const toSubmissionPayload = (
  detail: SupplierClaimDetail,
): SupplierClaimSubmissionPayload => {
  const submission = detail.submission;
  if (!submission || !detail.claim.supplierOrderReference)
    throw new Error("Supplier claim submission is not prepared");
  return submissionPayloadFromDetail(detail, submission.idempotencyReference);
};
const submissionPayloadFromDetail = (
  detail: SupplierClaimDetail,
  idempotencyReference: string,
): SupplierClaimSubmissionPayload => {
  if (!detail.claim.supplierOrderReference) {
    throw new Error(
      "Supplier claim has no authoritative supplier order reference",
    );
  }
  return {
    category: detail.claim.category,
    claimId: detail.claim.id,
    evidenceSnapshotIds: detail.evidenceLinks
      .map((link) => link.evidenceSnapshotId)
      .sort(),
    idempotencyReference,
    orderId: detail.claim.orderId,
    supplierOrderReference: detail.claim.supplierOrderReference,
  };
};
