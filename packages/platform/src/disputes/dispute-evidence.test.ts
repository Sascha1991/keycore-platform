import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DisputeEvidenceService,
  correlationId,
  orderId,
  type AuditEvent,
  type AuditEventPort,
  type DisputeEvidenceAuthoritativeFacts,
  type DisputeEvidenceExportAuthorityPort,
  type DisputeEvidenceFinalizationAuthorityPort,
} from "../contracts.js";
import { InMemoryDisputeEvidenceRepository } from "../../../../infra/disputes/in-memory-dispute-evidence-repository.js";

const now = new Date("2026-08-27T12:00:00.000Z");
const fixtureOrderId = orderId("11111111-1111-4111-8111-111111111111");
const otherOrderId = orderId("22222222-2222-4222-8222-222222222222");

describe("DisputeEvidenceService", () => {
  it("builds a provider-neutral draft from mandatory persisted order and payment facts", async () => {
    const repository = repositoryWith(facts());
    const result = await service(repository).buildDraft({
      correlationId: correlationId("dispute-evidence-create"),
      orderId: fixtureOrderId,
    });

    expect(result).toMatchObject({ status: "CREATED" });
    if (result.status !== "CREATED" && result.status !== "EXISTING") {
      throw new Error("Expected dispute evidence draft");
    }
    expect(result.snapshot).toMatchObject({
      orderId: fixtureOrderId,
      state: "DRAFT",
      version: 1,
    });
    expect(sectionStatus(result.snapshot, "ORDER")).toBe("PRESENT");
    expect(sectionStatus(result.snapshot, "PAYMENT")).toBe("PRESENT");
    expect(sectionStatus(result.snapshot, "INVOICE")).toBe("NOT_APPLICABLE");
  });

  it("fails closed when mandatory payment evidence is unavailable", async () => {
    const repository = repositoryWith(facts({ payment: null }));
    const result = await service(repository).buildDraft({
      correlationId: correlationId("dispute-evidence-missing-payment"),
      orderId: fixtureOrderId,
    });

    expect(result).toEqual({
      reasonCode: "DISPUTE_EVIDENCE_MANDATORY_FACT_UNAVAILABLE",
      status: "UNAVAILABLE",
    });
    expect(await repository.findSnapshotById(randomUUID())).toBeNull();
  });

  it("reuses identical draft facts and creates a new version when authoritative facts change", async () => {
    const repository = repositoryWith(facts());
    const target = service(repository);
    const first = requiredDraft(
      await target.buildDraft({
        correlationId: correlationId("dispute-evidence-first"),
        orderId: fixtureOrderId,
      }),
    );
    const repeated = requiredDraft(
      await target.buildDraft({
        correlationId: correlationId("dispute-evidence-repeat"),
        orderId: fixtureOrderId,
      }),
    );

    expect(repeated.evidenceSnapshotId).toBe(first.evidenceSnapshotId);
    expect(repeated.factFingerprint).toBe(first.factFingerprint);

    repository.setFacts(
      facts({
        paymentStatus: "CAPTURED",
        updatedAt: new Date("2026-08-27T12:05:00.000Z"),
      }),
    );
    const changed = requiredDraft(
      await target.buildDraft({
        correlationId: correlationId("dispute-evidence-changed"),
        orderId: fixtureOrderId,
      }),
    );

    expect(changed.evidenceSnapshotId).not.toBe(first.evidenceSnapshotId);
    expect(changed.factFingerprint).not.toBe(first.factFingerprint);
    expect(changed.version).toBe(2);
  });

  it("requires trusted authority for finalization and export", async () => {
    const repository = repositoryWith(facts());
    const draft = requiredDraft(
      await service(repository).buildDraft({
        correlationId: correlationId("dispute-evidence-final-denied-create"),
        orderId: fixtureOrderId,
      }),
    );

    await expect(
      service(repository).finalizeSnapshot({
        correlationId: correlationId("dispute-evidence-final-denied"),
        orderId: fixtureOrderId,
        snapshotId: draft.evidenceSnapshotId,
      }),
    ).resolves.toEqual({
      reasonCode: "DISPUTE_EVIDENCE_FINALIZATION_DENIED",
      status: "DENIED",
    });
    await expect(
      service(repository).exportSnapshot({
        correlationId: correlationId("dispute-evidence-export-denied"),
        orderId: fixtureOrderId,
        snapshotId: draft.evidenceSnapshotId,
      }),
    ).resolves.toEqual({
      reasonCode: "DISPUTE_EVIDENCE_EXPORT_DENIED",
      status: "DENIED",
    });

    const trusted = service(repository, {
      exportAuthority: new TrustedExportAuthority(),
      finalizationAuthority: new TrustedFinalizationAuthority(),
    });
    await expect(
      trusted.finalizeSnapshot({
        correlationId: correlationId("dispute-evidence-final"),
        orderId: fixtureOrderId,
        snapshotId: draft.evidenceSnapshotId,
      }),
    ).resolves.toMatchObject({
      snapshot: { state: "FINALIZED" },
      status: "FINALIZED",
    });
    await expect(
      trusted.exportSnapshot({
        correlationId: correlationId("dispute-evidence-export-mismatch"),
        orderId: otherOrderId,
        snapshotId: draft.evidenceSnapshotId,
      }),
    ).resolves.toEqual({
      reasonCode: "DISPUTE_EVIDENCE_ORDER_MISMATCH",
      status: "ORDER_MISMATCH",
    });
    await expect(
      trusted.exportSnapshot({
        correlationId: correlationId("dispute-evidence-export"),
        orderId: fixtureOrderId,
        snapshotId: draft.evidenceSnapshotId,
      }),
    ).resolves.toMatchObject({
      export: { state: "FINALIZED" },
      status: "EXPORTED",
    });
  });

  it("keeps exported and audit material redacted and evidence-body-free", async () => {
    const audit = new RecordingAuditPort();
    const repository = repositoryWith(
      facts({
        externalPaymentId: "pi_KEYRANO_KS0903_PAYMENT_REFERENCE_DO_NOT_LEAK",
        externalSupplierOrderId:
          "supplier_KEYRANO_KS0903_SUPPLIER_REFERENCE_DO_NOT_LEAK",
      }),
    );
    const target = service(repository, {
      audit,
      exportAuthority: new TrustedExportAuthority(),
      finalizationAuthority: new TrustedFinalizationAuthority(),
    });
    const draft = requiredDraft(
      await target.buildDraft({
        correlationId: correlationId("dispute-evidence-redaction"),
        orderId: fixtureOrderId,
      }),
    );
    const exported = await target.exportSnapshot({
      correlationId: correlationId("dispute-evidence-redaction-export"),
      orderId: fixtureOrderId,
      snapshotId: draft.evidenceSnapshotId,
    });

    const exportText = JSON.stringify(exported);
    expect(exportText).not.toContain(
      "KEYRANO_KS0903_PAYMENT_REFERENCE_DO_NOT_LEAK",
    );
    expect(exportText).not.toContain(
      "KEYRANO_KS0903_SUPPLIER_REFERENCE_DO_NOT_LEAK",
    );
    expect(exportText).not.toContain("productKey");
    expect(JSON.stringify(audit.events)).not.toContain("sections");
    expect(JSON.stringify(audit.events)).not.toContain("KEYRANO_KS0903");
  });

  it("marks ambiguous fulfillment and delivery sections without claiming completion", async () => {
    const repository = repositoryWith(
      facts({
        deliveryStatus: "MANUAL_REVIEW_REQUIRED",
        fulfillmentStatus: "MANUAL_REVIEW_REQUIRED",
      }),
    );
    const draft = requiredDraft(
      await service(repository).buildDraft({
        correlationId: correlationId("dispute-evidence-ambiguous"),
        orderId: fixtureOrderId,
      }),
    );

    expect(sectionStatus(draft, "FULFILLMENT")).toBe("AMBIGUOUS");
    expect(sectionStatus(draft, "DELIVERY")).toBe("AMBIGUOUS");
  });

  it("keeps draft creation idempotent under concurrent callers", async () => {
    const repository = repositoryWith(facts());
    const target = service(repository);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        target.buildDraft({
          correlationId: correlationId(`dispute-evidence-race-${index}`),
          orderId: fixtureOrderId,
        }),
      ),
    );

    const drafts = results.map(requiredDraft);
    expect(new Set(drafts.map((draft) => draft.evidenceSnapshotId)).size).toBe(
      1,
    );
    expect(drafts.filter((draft) => draft.version === 1)).toHaveLength(10);
  });

  it("does not fail evidence creation when audit append fails", async () => {
    const result = await service(repositoryWith(facts()), {
      audit: new FailingAuditPort(),
    }).buildDraft({
      correlationId: correlationId("dispute-evidence-audit-failure"),
      orderId: fixtureOrderId,
    });

    expect(result).toMatchObject({ status: "CREATED" });
  });
});

const service = (
  repository: InMemoryDisputeEvidenceRepository,
  overrides: {
    readonly audit?: AuditEventPort;
    readonly exportAuthority?: DisputeEvidenceExportAuthorityPort;
    readonly finalizationAuthority?: DisputeEvidenceFinalizationAuthorityPort;
  } = {},
): DisputeEvidenceService =>
  new DisputeEvidenceService({
    ...(overrides.audit ? { audit: overrides.audit } : {}),
    ...(overrides.exportAuthority
      ? { exportAuthority: overrides.exportAuthority }
      : {}),
    ...(overrides.finalizationAuthority
      ? { finalizationAuthority: overrides.finalizationAuthority }
      : {}),
    environment: "CI",
    now: () => now,
    repository,
  });

const repositoryWith = (
  authoritativeFacts: DisputeEvidenceAuthoritativeFacts,
): InMemoryDisputeEvidenceRepository => {
  const repository = new InMemoryDisputeEvidenceRepository();
  repository.setFacts(authoritativeFacts);
  return repository;
};

const facts = (
  overrides: {
    readonly payment?: DisputeEvidenceAuthoritativeFacts["payment"];
    readonly paymentStatus?: string;
    readonly updatedAt?: Date;
    readonly externalPaymentId?: string;
    readonly externalSupplierOrderId?: string;
    readonly fulfillmentStatus?: string;
    readonly deliveryStatus?: string;
  } = {},
): DisputeEvidenceAuthoritativeFacts => {
  const updatedAt = overrides.updatedAt ?? now;
  const externalSupplierOrderId =
    overrides.externalSupplierOrderId ?? "supplier-order-ks0903";
  return {
    audit: [
      {
        eventType: "PAYMENT_CAPTURED",
        outcome: "SUCCEEDED",
        reasonCode: "PAYMENT_CAPTURED",
        timestampUtc: now,
      },
    ],
    customer: {
      checkoutEmailMatchesCustomer: true,
      createdAt: now,
      customerId: "customer-ks0903",
      emailVerificationState: "VERIFIED",
      updatedAt,
    },
    delivery: [
      {
        attemptId: "delivery-ks0903",
        channel: "CUSTOMER_ACCOUNT",
        createdAt: now,
        deliveredAt: null,
        deliveryReferencePresent: true,
        failureReasonCode: null,
        fulfillmentId: "fulfillment-ks0903",
        status: overrides.deliveryStatus ?? "DELIVERED",
        updatedAt,
      },
    ],
    fraud: {
      decision: "ALLOW",
      evaluatedAt: now,
      evaluationId: "fraud-ks0903",
      factFingerprint: "a".repeat(64),
      fraudPolicyVersion: "KS09_POLICY_V1",
      reasonCodes: ["RISK_POLICY_ALLOW"],
      reviewCaseId: null,
      reviewOpenedAt: null,
      reviewResolution: null,
      reviewResolvedAt: null,
      reviewStatus: null,
      riskScore: 5,
    },
    fulfillment: [
      {
        createdAt: now,
        deliveredAt: null,
        deliveryState: "READY",
        encryptedSecretPresent: true,
        externalSupplierOrderId,
        failureReasonCode: null,
        fulfillmentId: "fulfillment-ks0903",
        retrievalState: "SUCCEEDED",
        retrievedAt: now,
        status: overrides.fulfillmentStatus ?? "READY_FOR_DELIVERY",
        supplierId: "kinguin",
        updatedAt,
      },
    ],
    guestClaim: {
      activeChallengeCount: 0,
      claimedAt: now,
      claimSucceeded: true,
    },
    invoice: null,
    order: {
      amountMinor: 2_999n,
      checkoutEmailSnapshotPresent: true,
      createdAt: now,
      currency: "EUR",
      customerId: "customer-ks0903",
      fulfillmentStatus: "SUCCEEDED",
      orderId: fixtureOrderId,
      paymentStatus: overrides.paymentStatus ?? "CAPTURED",
      procurementStatus: "SUCCEEDED",
      refundStatus: "NOT_REQUESTED",
      riskStatus: "APPROVED",
      status: "COMPLETED",
      updatedAt,
    },
    payment:
      overrides.payment === undefined
        ? {
            amountMinor: 2_999n,
            createdAt: now,
            currency: "EUR",
            externalPaymentId: overrides.externalPaymentId ?? "pi_ks0903",
            lastProviderEventAt: now,
            paymentId: "payment-ks0903",
            provider: "STRIPE",
            reconciliationRequired: false,
            status: "CAPTURED",
            updatedAt,
          }
        : overrides.payment,
    procurement: [
      {
        completedAt: now,
        createdAt: now,
        dispatchState: "DISPATCHED",
        externalSupplierOrderId,
        procurementOperationId: "procurement-ks0903",
        status: "SUCCEEDED",
        supplierId: "kinguin",
        updatedAt,
      },
    ],
    velocity: {
      aggregates: [
        {
          amountMinorTotal: 2_999n,
          currency: "EUR",
          eventCount: 1,
          eventType: "PAYMENT_CONFIRMED",
          window: "PT24H",
        },
      ],
      evaluationId: "fraud-ks0903",
    },
  };
};

const requiredDraft = (
  result: Awaited<ReturnType<DisputeEvidenceService["buildDraft"]>>,
) => {
  if (result.status !== "CREATED" && result.status !== "EXISTING") {
    throw new Error(`Expected draft result, got ${result.status}`);
  }
  return result.snapshot;
};

const sectionStatus = (
  snapshot: ReturnType<typeof requiredDraft>,
  type: string,
): string | undefined =>
  snapshot.sections.find((section) => section.type === type)?.status;

class TrustedFinalizationAuthority implements DisputeEvidenceFinalizationAuthorityPort {
  public async authorizeFinalization(): Promise<{
    readonly status: "AUTHORIZED";
  }> {
    return { status: "AUTHORIZED" };
  }
}

class TrustedExportAuthority implements DisputeEvidenceExportAuthorityPort {
  public async authorizeExport(): Promise<{ readonly status: "AUTHORIZED" }> {
    return { status: "AUTHORIZED" };
  }
}

class RecordingAuditPort implements AuditEventPort {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class FailingAuditPort implements AuditEventPort {
  public async append(): Promise<void> {
    throw new Error("Audit unavailable");
  }
}
