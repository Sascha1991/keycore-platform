import { createHash, randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type { CorrelationId, OrderId } from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";

export const disputeEvidenceSchemaVersion = "KS_DISPUTE_EVIDENCE_V1";

export type DisputeEvidenceSnapshotState =
  "DRAFT" | "FINALIZED" | "INVALIDATED";

export type DisputeEvidenceSectionType =
  | "ORDER"
  | "PAYMENT"
  | "CUSTOMER_ACCOUNT"
  | "OWNERSHIP"
  | "GUEST_CLAIM"
  | "FRAUD"
  | "VELOCITY"
  | "PROCUREMENT"
  | "FULFILLMENT"
  | "DELIVERY"
  | "INVOICE"
  | "AUDIT_SUMMARY";

export type DisputeEvidenceSectionStatus =
  "PRESENT" | "NOT_AVAILABLE" | "NOT_APPLICABLE" | "AMBIGUOUS";

export interface DisputeEvidenceFact {
  readonly key: string;
  readonly sourceType: string;
  readonly sourceRecordId: string | null;
  readonly observedAt: Date | null;
  readonly value: string | number | boolean | null;
}

export interface DisputeEvidenceSection {
  readonly type: DisputeEvidenceSectionType;
  readonly status: DisputeEvidenceSectionStatus;
  readonly facts: readonly DisputeEvidenceFact[];
  readonly reasonCode?: string;
}

export interface DisputeEvidenceSnapshot {
  readonly evidenceSnapshotId: string;
  readonly orderId: OrderId;
  readonly version: number;
  readonly state: DisputeEvidenceSnapshotState;
  readonly createdAt: Date;
  readonly finalizedAt: Date | null;
  readonly schemaVersion: typeof disputeEvidenceSchemaVersion;
  readonly policyVersion: typeof disputeEvidenceSchemaVersion;
  readonly factFingerprint: string;
  readonly sections: readonly DisputeEvidenceSection[];
}

export interface DisputeEvidenceOrderFacts {
  readonly orderId: OrderId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: string;
  readonly paymentStatus: string;
  readonly procurementStatus: string;
  readonly fulfillmentStatus: string;
  readonly riskStatus: string;
  readonly refundStatus: string;
  readonly customerId: string | null;
  readonly checkoutEmailSnapshotPresent: boolean;
}

export interface DisputeEvidencePaymentFacts {
  readonly paymentId: string;
  readonly provider: string;
  readonly externalPaymentId: string | null;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastProviderEventAt: Date | null;
  readonly reconciliationRequired: boolean;
}

export interface DisputeEvidenceCustomerFacts {
  readonly customerId: string;
  readonly emailVerificationState: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly checkoutEmailMatchesCustomer: boolean | null;
}

export interface DisputeEvidenceGuestClaimFacts {
  readonly claimSucceeded: boolean;
  readonly claimedAt: Date | null;
  readonly activeChallengeCount: number;
}

export interface DisputeEvidenceFraudFacts {
  readonly evaluationId: string;
  readonly decision: string;
  readonly riskScore: number;
  readonly reasonCodes: readonly string[];
  readonly evaluatedAt: Date;
  readonly fraudPolicyVersion: string;
  readonly factFingerprint: string;
  readonly reviewCaseId: string | null;
  readonly reviewStatus: string | null;
  readonly reviewResolution: string | null;
  readonly reviewOpenedAt: Date | null;
  readonly reviewResolvedAt: Date | null;
}

export interface DisputeEvidenceVelocityFacts {
  readonly evaluationId: string;
  readonly aggregates: readonly {
    readonly window: string;
    readonly eventCount: number;
    readonly amountMinorTotal: bigint;
    readonly currency: string;
    readonly eventType: string;
  }[];
}

export interface DisputeEvidenceProcurementFacts {
  readonly procurementOperationId: string;
  readonly supplierId: string;
  readonly externalSupplierOrderId: string | null;
  readonly status: string;
  readonly dispatchState: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export interface DisputeEvidenceFulfillmentFacts {
  readonly fulfillmentId: string;
  readonly supplierId: string;
  readonly externalSupplierOrderId: string;
  readonly status: string;
  readonly retrievalState: string;
  readonly deliveryState: string;
  readonly retrievedAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly encryptedSecretPresent: boolean;
  readonly failureReasonCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DisputeEvidenceDeliveryFacts {
  readonly attemptId: string;
  readonly fulfillmentId: string;
  readonly channel: string;
  readonly status: string;
  readonly deliveredAt: Date | null;
  readonly deliveryReferencePresent: boolean;
  readonly failureReasonCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DisputeEvidenceInvoiceFacts {
  readonly invoiceState: string;
  readonly invoiceReference: string | null;
  readonly issuedAt: Date | null;
}

export interface DisputeEvidenceAuditFacts {
  readonly eventType: string;
  readonly timestampUtc: Date;
  readonly outcome: string;
  readonly reasonCode: string;
}

export interface DisputeEvidenceAuthoritativeFacts {
  readonly order: DisputeEvidenceOrderFacts;
  readonly payment: DisputeEvidencePaymentFacts | null;
  readonly customer: DisputeEvidenceCustomerFacts | null;
  readonly guestClaim: DisputeEvidenceGuestClaimFacts | null;
  readonly fraud: DisputeEvidenceFraudFacts | null;
  readonly velocity: DisputeEvidenceVelocityFacts | null;
  readonly procurement: readonly DisputeEvidenceProcurementFacts[];
  readonly fulfillment: readonly DisputeEvidenceFulfillmentFacts[];
  readonly delivery: readonly DisputeEvidenceDeliveryFacts[];
  readonly invoice: DisputeEvidenceInvoiceFacts | null;
  readonly audit: readonly DisputeEvidenceAuditFacts[];
}

export interface DisputeEvidenceRepository {
  loadAuthoritativeFacts(
    orderId: OrderId,
  ): Promise<DisputeEvidenceAuthoritativeFacts | null>;
  persistDraft(input: {
    readonly snapshot: DisputeEvidenceSnapshot;
  }): Promise<DisputeEvidenceSnapshot>;
  findSnapshotById(snapshotId: string): Promise<DisputeEvidenceSnapshot | null>;
  finalizeSnapshot(input: {
    readonly snapshotId: string;
    readonly orderId: OrderId;
    readonly finalizedAt: Date;
  }): Promise<
    | {
        readonly status: "FINALIZED" | "ALREADY_FINALIZED";
        readonly snapshot: DisputeEvidenceSnapshot;
      }
    | { readonly status: "NOT_FOUND" | "ORDER_MISMATCH" | "NOT_FINALIZABLE" }
  >;
}

export interface DisputeEvidenceFinalizationAuthorityPort {
  authorizeFinalization(input: {
    readonly orderId: OrderId;
    readonly snapshotId: string;
    readonly correlationId: CorrelationId;
  }): Promise<
    { readonly status: "AUTHORIZED" } | { readonly status: "DENIED" }
  >;
}

export interface DisputeEvidenceExportAuthorityPort {
  authorizeExport(input: {
    readonly orderId: OrderId;
    readonly snapshotId: string;
    readonly correlationId: CorrelationId;
  }): Promise<
    { readonly status: "AUTHORIZED" } | { readonly status: "DENIED" }
  >;
}

export class FailClosedDisputeEvidenceFinalizationAuthority implements DisputeEvidenceFinalizationAuthorityPort {
  public async authorizeFinalization(): Promise<{ readonly status: "DENIED" }> {
    return { status: "DENIED" };
  }
}

export class FailClosedDisputeEvidenceExportAuthority implements DisputeEvidenceExportAuthorityPort {
  public async authorizeExport(): Promise<{ readonly status: "DENIED" }> {
    return { status: "DENIED" };
  }
}

export interface DisputeEvidenceExport {
  readonly snapshotId: string;
  readonly orderId: OrderId;
  readonly schemaVersion: typeof disputeEvidenceSchemaVersion;
  readonly state: DisputeEvidenceSnapshotState;
  readonly factFingerprint: string;
  readonly sections: readonly DisputeEvidenceSection[];
}

export class DisputeEvidenceService {
  private readonly finalizationAuthority: DisputeEvidenceFinalizationAuthorityPort;
  private readonly exportAuthority: DisputeEvidenceExportAuthorityPort;
  private readonly audit: AuditEventPort | undefined;
  private readonly environment: AuditEvent["environment"];

  public constructor(
    private readonly options: {
      readonly repository: DisputeEvidenceRepository;
      readonly now?: () => Date;
      readonly finalizationAuthority?: DisputeEvidenceFinalizationAuthorityPort;
      readonly exportAuthority?: DisputeEvidenceExportAuthorityPort;
      readonly audit?: AuditEventPort;
      readonly environment?: AuditEvent["environment"];
    },
  ) {
    this.finalizationAuthority =
      options.finalizationAuthority ??
      new FailClosedDisputeEvidenceFinalizationAuthority();
    this.exportAuthority =
      options.exportAuthority ?? new FailClosedDisputeEvidenceExportAuthority();
    this.audit = options.audit;
    this.environment = options.environment ?? "LOCAL";
  }

  public async buildDraft(input: {
    readonly orderId: OrderId;
    readonly correlationId: CorrelationId;
  }): Promise<
    | {
        readonly status: "CREATED" | "EXISTING";
        readonly snapshot: DisputeEvidenceSnapshot;
      }
    | {
        readonly status: "NOT_FOUND" | "UNAVAILABLE";
        readonly reasonCode: string;
      }
  > {
    try {
      const facts = await this.options.repository.loadAuthoritativeFacts(
        input.orderId,
      );
      if (!facts) {
        return {
          reasonCode: "DISPUTE_EVIDENCE_ORDER_NOT_FOUND",
          status: "NOT_FOUND",
        };
      }
      const now = this.now();
      const sections = buildEvidenceSections(facts);
      if (
        !hasPresentSection(sections, "ORDER") ||
        !hasPresentSection(sections, "PAYMENT")
      ) {
        return {
          reasonCode: "DISPUTE_EVIDENCE_MANDATORY_FACT_UNAVAILABLE",
          status: "UNAVAILABLE",
        };
      }
      const factFingerprint = evidenceFingerprint({
        orderId: input.orderId,
        sections,
      });
      const snapshot: DisputeEvidenceSnapshot = {
        createdAt: now,
        evidenceSnapshotId: randomUUID(),
        factFingerprint,
        finalizedAt: null,
        orderId: input.orderId,
        policyVersion: disputeEvidenceSchemaVersion,
        schemaVersion: disputeEvidenceSchemaVersion,
        sections,
        state: "DRAFT",
        version: 0,
      };
      const persisted = await this.options.repository.persistDraft({
        snapshot,
      });
      await this.appendAudit({
        correlationId: input.correlationId,
        eventType: "DISPUTE_EVIDENCE_CREATED",
        metadata: {
          fingerprintPrefix: persisted.factFingerprint.slice(0, 12),
          schemaVersion: persisted.schemaVersion,
          snapshotId: persisted.evidenceSnapshotId,
          state: persisted.state,
        },
        orderId: input.orderId,
        outcome: "SUCCEEDED",
        reasonCode: "DISPUTE_EVIDENCE_CREATED",
      });
      return {
        snapshot: persisted,
        status:
          persisted.evidenceSnapshotId === snapshot.evidenceSnapshotId
            ? "CREATED"
            : "EXISTING",
      };
    } catch {
      return {
        reasonCode: "DISPUTE_EVIDENCE_SOURCE_UNAVAILABLE",
        status: "UNAVAILABLE",
      };
    }
  }

  public async finalizeSnapshot(input: {
    readonly orderId: OrderId;
    readonly snapshotId: string;
    readonly correlationId: CorrelationId;
  }): Promise<
    | {
        readonly status: "FINALIZED" | "ALREADY_FINALIZED";
        readonly snapshot: DisputeEvidenceSnapshot;
      }
    | {
        readonly status:
          "DENIED" | "NOT_FOUND" | "ORDER_MISMATCH" | "NOT_FINALIZABLE";
        readonly reasonCode: string;
      }
  > {
    const authorized =
      await this.finalizationAuthority.authorizeFinalization(input);
    if (authorized.status !== "AUTHORIZED") {
      return {
        reasonCode: "DISPUTE_EVIDENCE_FINALIZATION_DENIED",
        status: "DENIED",
      };
    }
    const result = await this.options.repository.finalizeSnapshot({
      finalizedAt: this.now(),
      orderId: input.orderId,
      snapshotId: input.snapshotId,
    });
    if (
      result.status === "FINALIZED" ||
      result.status === "ALREADY_FINALIZED"
    ) {
      await this.appendAudit({
        correlationId: input.correlationId,
        eventType: "DISPUTE_EVIDENCE_FINALIZED",
        metadata: {
          fingerprintPrefix: result.snapshot.factFingerprint.slice(0, 12),
          schemaVersion: result.snapshot.schemaVersion,
          snapshotId: result.snapshot.evidenceSnapshotId,
          state: result.snapshot.state,
        },
        orderId: input.orderId,
        outcome: "SUCCEEDED",
        reasonCode: result.status,
      });
      return result;
    }
    return {
      reasonCode: `DISPUTE_EVIDENCE_${result.status}`,
      status: result.status,
    };
  }

  public async exportSnapshot(input: {
    readonly orderId: OrderId;
    readonly snapshotId: string;
    readonly correlationId: CorrelationId;
  }): Promise<
    | { readonly status: "EXPORTED"; readonly export: DisputeEvidenceExport }
    | {
        readonly status: "DENIED" | "NOT_FOUND" | "ORDER_MISMATCH";
        readonly reasonCode: string;
      }
  > {
    const authorized = await this.exportAuthority.authorizeExport(input);
    if (authorized.status !== "AUTHORIZED") {
      return { reasonCode: "DISPUTE_EVIDENCE_EXPORT_DENIED", status: "DENIED" };
    }
    const snapshot = await this.options.repository.findSnapshotById(
      input.snapshotId,
    );
    if (!snapshot) {
      return { reasonCode: "DISPUTE_EVIDENCE_NOT_FOUND", status: "NOT_FOUND" };
    }
    if (snapshot.orderId !== input.orderId) {
      return {
        reasonCode: "DISPUTE_EVIDENCE_ORDER_MISMATCH",
        status: "ORDER_MISMATCH",
      };
    }
    const exported: DisputeEvidenceExport = {
      factFingerprint: snapshot.factFingerprint,
      orderId: snapshot.orderId,
      schemaVersion: snapshot.schemaVersion,
      sections: snapshot.sections,
      snapshotId: snapshot.evidenceSnapshotId,
      state: snapshot.state,
    };
    await this.appendAudit({
      correlationId: input.correlationId,
      eventType: "DISPUTE_EVIDENCE_EXPORTED",
      metadata: {
        fingerprintPrefix: snapshot.factFingerprint.slice(0, 12),
        schemaVersion: snapshot.schemaVersion,
        snapshotId: snapshot.evidenceSnapshotId,
        state: snapshot.state,
      },
      orderId: input.orderId,
      outcome: "SUCCEEDED",
      reasonCode: "DISPUTE_EVIDENCE_EXPORTED",
    });
    return { export: exported, status: "EXPORTED" };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async appendAudit(input: {
    readonly eventType: AuditEvent["eventType"];
    readonly orderId: OrderId;
    readonly correlationId: CorrelationId;
    readonly outcome: AuditEvent["outcome"];
    readonly reasonCode: string;
    readonly metadata: AuditEvent["metadata"];
  }): Promise<void> {
    if (!this.audit) {
      return;
    }
    try {
      await this.audit.append({
        actor: { id: "keycore-dispute-evidence", type: "SERVICE" },
        correlationId: input.correlationId,
        entity: { id: input.orderId, type: "ORDER" },
        environment: this.environment,
        eventType: input.eventType,
        metadata: input.metadata,
        outcome: input.outcome,
        reasonCode: input.reasonCode,
        timestampUtc: this.now(),
        uuid: randomUUID(),
      });
    } catch {
      // Audit is best-effort; durable evidence remains in the repository.
    }
  }
}

export const buildEvidenceSections = (
  facts: DisputeEvidenceAuthoritativeFacts,
): readonly DisputeEvidenceSection[] => [
  orderSection(facts.order),
  paymentSection(facts.payment),
  customerSection(facts.customer),
  ownershipSection(facts.order),
  guestClaimSection(facts.guestClaim),
  fraudSection(facts.fraud),
  velocitySection(facts.velocity),
  procurementSection(facts.procurement),
  fulfillmentSection(facts.fulfillment),
  deliverySection(facts.delivery),
  invoiceSection(facts.invoice),
  auditSummarySection(facts.audit),
];

export const evidenceFingerprint = (input: {
  readonly orderId: OrderId;
  readonly sections: readonly DisputeEvidenceSection[];
}): string =>
  createHash("sha256")
    .update(
      stableJson({
        orderId: input.orderId,
        schemaVersion: disputeEvidenceSchemaVersion,
        sections: input.sections,
      }),
    )
    .digest("hex");

const orderSection = (
  order: DisputeEvidenceOrderFacts,
): DisputeEvidenceSection => ({
  facts: [
    fact("orderId", "ORDER", order.orderId, order.createdAt, order.orderId),
    fact("createdAt", "ORDER", order.orderId, order.createdAt, order.createdAt),
    fact(
      "amountMinor",
      "ORDER",
      order.orderId,
      order.createdAt,
      order.amountMinor,
    ),
    fact("currency", "ORDER", order.orderId, order.createdAt, order.currency),
    fact("orderStatus", "ORDER", order.orderId, order.updatedAt, order.status),
    fact(
      "paymentStatus",
      "ORDER",
      order.orderId,
      order.updatedAt,
      order.paymentStatus,
    ),
    fact(
      "procurementStatus",
      "ORDER",
      order.orderId,
      order.updatedAt,
      order.procurementStatus,
    ),
    fact(
      "fulfillmentStatus",
      "ORDER",
      order.orderId,
      order.updatedAt,
      order.fulfillmentStatus,
    ),
    fact(
      "riskStatus",
      "ORDER",
      order.orderId,
      order.updatedAt,
      order.riskStatus,
    ),
  ],
  status: "PRESENT",
  type: "ORDER",
});

const paymentSection = (
  payment: DisputeEvidencePaymentFacts | null,
): DisputeEvidenceSection =>
  payment
    ? {
        facts: [
          fact(
            "provider",
            "PAYMENT",
            payment.paymentId,
            payment.createdAt,
            payment.provider,
          ),
          fact(
            "safeProviderReference",
            "PAYMENT",
            payment.paymentId,
            payment.updatedAt,
            maskReference(payment.externalPaymentId),
          ),
          fact(
            "status",
            "PAYMENT",
            payment.paymentId,
            payment.updatedAt,
            payment.status,
          ),
          fact(
            "amountMinor",
            "PAYMENT",
            payment.paymentId,
            payment.createdAt,
            payment.amountMinor,
          ),
          fact(
            "currency",
            "PAYMENT",
            payment.paymentId,
            payment.createdAt,
            payment.currency,
          ),
          fact(
            "lastProviderEventAt",
            "PAYMENT",
            payment.paymentId,
            payment.lastProviderEventAt,
            payment.lastProviderEventAt,
          ),
          fact(
            "reconciliationRequired",
            "PAYMENT",
            payment.paymentId,
            payment.updatedAt,
            payment.reconciliationRequired,
          ),
        ],
        status: "PRESENT",
        type: "PAYMENT",
      }
    : unavailable("PAYMENT", "DISPUTE_EVIDENCE_PAYMENT_NOT_AVAILABLE");

const customerSection = (
  customer: DisputeEvidenceCustomerFacts | null,
): DisputeEvidenceSection =>
  customer
    ? {
        facts: [
          fact(
            "customerId",
            "CUSTOMER_ACCOUNT",
            customer.customerId,
            customer.createdAt,
            customer.customerId,
          ),
          fact(
            "emailVerificationState",
            "CUSTOMER_ACCOUNT",
            customer.customerId,
            customer.updatedAt,
            customer.emailVerificationState,
          ),
          fact(
            "checkoutEmailMatchesVerifiedCustomer",
            "CUSTOMER_ACCOUNT",
            customer.customerId,
            customer.updatedAt,
            customer.checkoutEmailMatchesCustomer,
          ),
        ],
        status: "PRESENT",
        type: "CUSTOMER_ACCOUNT",
      }
    : notApplicable("CUSTOMER_ACCOUNT");

const ownershipSection = (
  order: DisputeEvidenceOrderFacts,
): DisputeEvidenceSection => ({
  facts: [
    fact(
      "customerOwnershipBound",
      "OWNERSHIP",
      order.orderId,
      order.updatedAt,
      Boolean(order.customerId),
    ),
    fact(
      "customerId",
      "OWNERSHIP",
      order.orderId,
      order.updatedAt,
      order.customerId,
    ),
    fact(
      "checkoutEmailSnapshotPresent",
      "OWNERSHIP",
      order.orderId,
      order.createdAt,
      order.checkoutEmailSnapshotPresent,
    ),
  ],
  status: order.customerId ? "PRESENT" : "NOT_APPLICABLE",
  type: "OWNERSHIP",
});

const guestClaimSection = (
  claim: DisputeEvidenceGuestClaimFacts | null,
): DisputeEvidenceSection =>
  claim
    ? {
        facts: [
          fact(
            "claimSucceeded",
            "GUEST_CLAIM",
            null,
            claim.claimedAt,
            claim.claimSucceeded,
          ),
          fact(
            "claimedAt",
            "GUEST_CLAIM",
            null,
            claim.claimedAt,
            claim.claimedAt,
          ),
          fact(
            "activeChallengeCount",
            "GUEST_CLAIM",
            null,
            claim.claimedAt,
            claim.activeChallengeCount,
          ),
        ],
        status: claim.claimSucceeded ? "PRESENT" : "NOT_APPLICABLE",
        type: "GUEST_CLAIM",
      }
    : notApplicable("GUEST_CLAIM");

const fraudSection = (
  fraud: DisputeEvidenceFraudFacts | null,
): DisputeEvidenceSection =>
  fraud
    ? {
        facts: [
          fact(
            "decision",
            "FRAUD_RISK",
            fraud.evaluationId,
            fraud.evaluatedAt,
            fraud.decision,
          ),
          fact(
            "riskScore",
            "FRAUD_RISK",
            fraud.evaluationId,
            fraud.evaluatedAt,
            fraud.riskScore,
          ),
          fact(
            "reasonCodes",
            "FRAUD_RISK",
            fraud.evaluationId,
            fraud.evaluatedAt,
            fraud.reasonCodes.join(","),
          ),
          fact(
            "fraudPolicyVersion",
            "FRAUD_RISK",
            fraud.evaluationId,
            fraud.evaluatedAt,
            fraud.fraudPolicyVersion,
          ),
          fact(
            "reviewStatus",
            "MANUAL_REVIEW",
            fraud.reviewCaseId,
            fraud.reviewOpenedAt,
            fraud.reviewStatus,
          ),
          fact(
            "reviewResolution",
            "MANUAL_REVIEW",
            fraud.reviewCaseId,
            fraud.reviewResolvedAt,
            fraud.reviewResolution,
          ),
        ],
        status: "PRESENT",
        type: "FRAUD",
      }
    : notApplicable("FRAUD");

const velocitySection = (
  velocity: DisputeEvidenceVelocityFacts | null,
): DisputeEvidenceSection =>
  velocity
    ? {
        facts: velocity.aggregates.flatMap((aggregate) => [
          fact(
            `eventCount.${aggregate.eventType}.${aggregate.window}.${aggregate.currency}`,
            "FRAUD_VELOCITY",
            velocity.evaluationId,
            null,
            aggregate.eventCount,
          ),
          fact(
            `amountMinor.${aggregate.eventType}.${aggregate.window}.${aggregate.currency}`,
            "FRAUD_VELOCITY",
            velocity.evaluationId,
            null,
            aggregate.amountMinorTotal,
          ),
        ]),
        status: "PRESENT",
        type: "VELOCITY",
      }
    : notApplicable("VELOCITY");

const procurementSection = (
  procurement: readonly DisputeEvidenceProcurementFacts[],
): DisputeEvidenceSection =>
  procurement.length > 0
    ? {
        facts: procurement.flatMap((operation) => [
          fact(
            "supplierId",
            "PROCUREMENT",
            operation.procurementOperationId,
            operation.createdAt,
            operation.supplierId,
          ),
          fact(
            "status",
            "PROCUREMENT",
            operation.procurementOperationId,
            operation.updatedAt,
            operation.status,
          ),
          fact(
            "dispatchState",
            "PROCUREMENT",
            operation.procurementOperationId,
            operation.updatedAt,
            operation.dispatchState,
          ),
          fact(
            "safeSupplierOrderReference",
            "PROCUREMENT",
            operation.procurementOperationId,
            operation.updatedAt,
            maskReference(operation.externalSupplierOrderId),
          ),
        ]),
        status: "PRESENT",
        type: "PROCUREMENT",
      }
    : notApplicable("PROCUREMENT");

const fulfillmentSection = (
  fulfillment: readonly DisputeEvidenceFulfillmentFacts[],
): DisputeEvidenceSection =>
  fulfillment.length > 0
    ? {
        facts: fulfillment.flatMap((operation) => [
          fact(
            "supplierId",
            "FULFILLMENT",
            operation.fulfillmentId,
            operation.createdAt,
            operation.supplierId,
          ),
          fact(
            "status",
            "FULFILLMENT",
            operation.fulfillmentId,
            operation.updatedAt,
            operation.status,
          ),
          fact(
            "retrievalState",
            "FULFILLMENT",
            operation.fulfillmentId,
            operation.updatedAt,
            operation.retrievalState,
          ),
          fact(
            "deliveryState",
            "FULFILLMENT",
            operation.fulfillmentId,
            operation.updatedAt,
            operation.deliveryState,
          ),
          fact(
            "keyMaterialRetrieved",
            "FULFILLMENT",
            operation.fulfillmentId,
            operation.retrievedAt,
            operation.encryptedSecretPresent,
          ),
          fact(
            "retrievedAt",
            "FULFILLMENT",
            operation.fulfillmentId,
            operation.retrievedAt,
            operation.retrievedAt,
          ),
          fact(
            "deliveredAt",
            "FULFILLMENT",
            operation.fulfillmentId,
            operation.deliveredAt,
            operation.deliveredAt,
          ),
          fact(
            "failureReasonCode",
            "FULFILLMENT",
            operation.fulfillmentId,
            operation.updatedAt,
            operation.failureReasonCode,
          ),
        ]),
        status: fulfillment.some(
          (operation) =>
            operation.status === "MANUAL_REVIEW_REQUIRED" ||
            operation.status === "AMBIGUOUS",
        )
          ? "AMBIGUOUS"
          : "PRESENT",
        type: "FULFILLMENT",
      }
    : notApplicable("FULFILLMENT");

const deliverySection = (
  delivery: readonly DisputeEvidenceDeliveryFacts[],
): DisputeEvidenceSection =>
  delivery.length > 0
    ? {
        facts: delivery.flatMap((attempt) => [
          fact(
            "channel",
            "DELIVERY",
            attempt.attemptId,
            attempt.createdAt,
            attempt.channel,
          ),
          fact(
            "status",
            "DELIVERY",
            attempt.attemptId,
            attempt.updatedAt,
            attempt.status,
          ),
          fact(
            "deliveredAt",
            "DELIVERY",
            attempt.attemptId,
            attempt.deliveredAt,
            attempt.deliveredAt,
          ),
          fact(
            "deliveryReferencePresent",
            "DELIVERY",
            attempt.attemptId,
            attempt.deliveredAt,
            attempt.deliveryReferencePresent,
          ),
          fact(
            "failureReasonCode",
            "DELIVERY",
            attempt.attemptId,
            attempt.updatedAt,
            attempt.failureReasonCode,
          ),
        ]),
        status: delivery.some(
          (attempt) =>
            attempt.status === "AMBIGUOUS" ||
            attempt.status === "MANUAL_REVIEW_REQUIRED",
        )
          ? "AMBIGUOUS"
          : "PRESENT",
        type: "DELIVERY",
      }
    : notApplicable("DELIVERY");

const invoiceSection = (
  invoice: DisputeEvidenceInvoiceFacts | null,
): DisputeEvidenceSection =>
  invoice
    ? {
        facts: [
          fact(
            "invoiceState",
            "INVOICE",
            null,
            invoice.issuedAt,
            invoice.invoiceState,
          ),
          fact(
            "safeInvoiceReference",
            "INVOICE",
            null,
            invoice.issuedAt,
            maskReference(invoice.invoiceReference),
          ),
          fact("issuedAt", "INVOICE", null, invoice.issuedAt, invoice.issuedAt),
        ],
        status: "PRESENT",
        type: "INVOICE",
      }
    : notApplicable("INVOICE");

const auditSummarySection = (
  audit: readonly DisputeEvidenceAuditFacts[],
): DisputeEvidenceSection =>
  audit.length > 0
    ? {
        facts: audit.map((event, index) =>
          fact(
            `event.${index}`,
            "AUDIT_EVENTS",
            null,
            event.timestampUtc,
            `${event.eventType}:${event.outcome}:${event.reasonCode}`,
          ),
        ),
        status: "PRESENT",
        type: "AUDIT_SUMMARY",
      }
    : notApplicable("AUDIT_SUMMARY");

const hasPresentSection = (
  sections: readonly DisputeEvidenceSection[],
  type: DisputeEvidenceSectionType,
): boolean =>
  sections.some(
    (section) => section.type === type && section.status === "PRESENT",
  );

const fact = (
  key: string,
  sourceType: string,
  sourceRecordId: string | null,
  observedAt: Date | null,
  value: string | number | bigint | boolean | Date | null,
): DisputeEvidenceFact => ({
  key,
  observedAt,
  sourceRecordId,
  sourceType,
  value: safeFactValue(value),
});

const unavailable = (
  type: DisputeEvidenceSectionType,
  reasonCode: string,
): DisputeEvidenceSection => ({
  facts: [],
  reasonCode,
  status: "NOT_AVAILABLE",
  type,
});

const notApplicable = (
  type: DisputeEvidenceSectionType,
): DisputeEvidenceSection => ({
  facts: [],
  reasonCode: `DISPUTE_EVIDENCE_${type}_NOT_APPLICABLE`,
  status: "NOT_APPLICABLE",
  type,
});

const safeFactValue = (
  value: string | number | bigint | boolean | Date | null,
): string | number | boolean | null => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return redactUnsafeText(value);
  }
  return value;
};

const maskReference = (value: string | null): string | null => {
  if (!value) {
    return null;
  }
  return value.length <= 8
    ? `${value.slice(0, 2)}...${value.slice(-2)}`
    : `${value.slice(0, 4)}...${value.slice(-4)}`;
};

const unsafeTextPattern =
  /(product.?key|serial|plaintext|token|api.?key|secret)/iu;

const redactUnsafeText = (value: string): string =>
  unsafeTextPattern.test(value) ? "[REDACTED]" : value;

const stableJson = (value: unknown): string => JSON.stringify(canonical(value));

const canonical = (value: unknown): unknown => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, canonical(object[key])]),
    );
  }
  return value;
};
