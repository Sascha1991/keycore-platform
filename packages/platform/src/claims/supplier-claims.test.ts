import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

const allowOperations = {
  evaluate: async () => ({ status: "ALLOWED" as const }),
};

import type { OperationsControlGate } from "../operations/operations-controls.js";

import { InMemorySupplierClaimRepository } from "../../../../infra/claims/in-memory-supplier-claim-repository.js";
import {
  SupplierClaimService,
  correlationId,
  orderId,
  validateAuditEventType,
  type AuditEvent,
  type AuditEventPort,
  type SupplierClaimAuthorityPort,
  type SupplierClaimSubmissionPayload,
  type SupplierClaimSubmissionPort,
} from "../contracts.js";

const now = new Date("2026-08-28T12:00:00.000Z");

describe("SupplierClaimService", () => {
  it("creates a trusted provider-neutral claim from authoritative references", async () => {
    const fixture = setup();
    const result = await fixture.service.createClaim(validCreate(fixture));

    expect(result).toMatchObject({
      detail: {
        claim: {
          category: "KEY_NOT_WORKING",
          orderId: fixture.order,
          source: "SUPPORT",
          status: "OPEN",
          supplierId: "mock-supplier",
          supplierOrderReference: "supplier-order-synthetic",
        },
        events: [{ eventType: "CLAIM_CREATED" }],
        submission: null,
      },
      status: "CREATED",
    });
    expect(validateAuditEventType("SUPPLIER_CLAIM_CREATED")).toBe(
      "SUPPLIER_CLAIM_CREATED",
    );
  });

  it("fails closed for default authority and rejects request supplier authority", async () => {
    const fixture = setup({ trusted: false });
    await expect(
      fixture.service.createClaim(validCreate(fixture)),
    ).resolves.toEqual({ code: "UNTRUSTED_AUTHORITY", status: "FAILED" });

    const trusted = setup();
    await expect(
      trusted.service.createClaim({
        ...validCreate(trusted),
        supplierId: "kinguin",
      }),
    ).resolves.toEqual({ code: "BAD_REQUEST", status: "FAILED" });
    await expect(
      trusted.service.createClaim({
        ...validCreate(trusted),
        externalSupplierOrderId: "forged-order",
      }),
    ).resolves.toEqual({ code: "BAD_REQUEST", status: "FAILED" });

    const unsafeAuthority = setup({ authority: new UnsafeAuthority() });
    await expect(
      unsafeAuthority.service.createClaim(validCreate(unsafeAuthority)),
    ).resolves.toEqual({ code: "UNTRUSTED_AUTHORITY", status: "FAILED" });
  });

  it("requires an existing exact-order support case and procurement", async () => {
    const missing = setup();
    missing.repository.setOrder({ orderId: orderId(randomUUID()) });
    await expect(
      missing.service.createClaim({
        ...validCreate(missing),
        orderId: orderId(randomUUID()),
      }),
    ).resolves.toMatchObject({ code: "RESOURCE_NOT_AVAILABLE" });

    const supportMismatch = setup();
    supportMismatch.repository.setSupportCase({
      category: "ACTIVATION_PROBLEM",
      id: supportMismatch.supportCaseId,
      orderId: orderId(randomUUID()),
      status: "OPEN",
    });
    await expect(
      supportMismatch.service.createClaim(validCreate(supportMismatch)),
    ).resolves.toMatchObject({ code: "RESOURCE_NOT_AVAILABLE" });

    const procurementMismatch = setup();
    procurementMismatch.repository.setProcurement({
      dispatchState: "DISPATCH_CONFIRMED",
      externalSupplierOrderId: "supplier-order-synthetic",
      id: procurementMismatch.procurementId,
      orderId: orderId(randomUUID()),
      status: "SUCCEEDED",
      supplierId: "mock-supplier",
    });
    await expect(
      procurementMismatch.service.createClaim(validCreate(procurementMismatch)),
    ).resolves.toMatchObject({ code: "RESOURCE_NOT_AVAILABLE" });
  });

  it("allows only eligible support statuses and explicit category mappings", async () => {
    for (const status of ["RESOLVED", "CLOSED", "WAITING_FOR_CUSTOMER"]) {
      const fixture = setup();
      fixture.repository.setSupportCase({
        category: "ACTIVATION_PROBLEM",
        id: fixture.supportCaseId,
        orderId: fixture.order,
        status,
      });
      await expect(
        fixture.service.createClaim(validCreate(fixture)),
      ).resolves.toMatchObject({ code: "NOT_ELIGIBLE" });
    }
    const payment = setup();
    payment.repository.setSupportCase({
      category: "PAYMENT_PROBLEM",
      id: payment.supportCaseId,
      orderId: payment.order,
      status: "OPEN",
    });
    await expect(
      payment.service.createClaim(validCreate(payment)),
    ).resolves.toMatchObject({ code: "NOT_ELIGIBLE" });
  });

  it("requires proven procurement and exact fulfillment for key-related claims", async () => {
    const noPurchase = setup();
    noPurchase.repository.setProcurement({
      dispatchState: "NOT_DISPATCHED",
      externalSupplierOrderId: null,
      id: noPurchase.procurementId,
      orderId: noPurchase.order,
      status: "READY",
      supplierId: "mock-supplier",
    });
    await expect(
      noPurchase.service.createClaim(validCreate(noPurchase)),
    ).resolves.toMatchObject({ code: "NOT_ELIGIBLE" });

    const noFulfillment = setup();
    await expect(
      noFulfillment.service.createClaim({
        ...validCreate(noFulfillment),
        fulfillmentId: null,
      }),
    ).resolves.toMatchObject({ code: "NOT_ELIGIBLE" });

    const crossOrder = setup();
    crossOrder.repository.setFulfillment({
      deliveryState: "PENDING",
      id: crossOrder.fulfillmentId,
      orderId: orderId(randomUUID()),
      procurementOperationId: crossOrder.procurementId,
      retrievalState: "RETRIEVED",
      status: "DELIVERY_PENDING",
    });
    await expect(
      crossOrder.service.createClaim(validCreate(crossOrder)),
    ).resolves.toMatchObject({ code: "RESOURCE_NOT_AVAILABLE" });
  });

  it("represents ambiguous procurement only as a supplier order problem", async () => {
    const fixture = setup();
    fixture.repository.setSupportCase({
      category: "SUPPLIER_PROBLEM",
      id: fixture.supportCaseId,
      orderId: fixture.order,
      status: "IN_PROGRESS",
    });
    fixture.repository.setProcurement({
      dispatchState: "DISPATCH_STARTED",
      externalSupplierOrderId: null,
      id: fixture.procurementId,
      orderId: fixture.order,
      status: "AMBIGUOUS",
      supplierId: "mock-supplier",
    });
    await expect(
      fixture.service.createClaim({
        ...validCreate(fixture),
        category: "SUPPLIER_ORDER_PROBLEM",
        fulfillmentId: null,
      }),
    ).resolves.toMatchObject({ status: "CREATED" });

    const keyClaim = setup();
    keyClaim.repository.setProcurement({
      dispatchState: "DISPATCH_STARTED",
      externalSupplierOrderId: null,
      id: keyClaim.procurementId,
      orderId: keyClaim.order,
      status: "AMBIGUOUS",
      supplierId: "mock-supplier",
    });
    await expect(
      keyClaim.service.createClaim(validCreate(keyClaim)),
    ).resolves.toMatchObject({ code: "NOT_ELIGIBLE" });
  });

  it("is idempotent for replay and rejects conflicting reuse", async () => {
    const fixture = setup();
    const first = await fixture.service.createClaim(validCreate(fixture));
    const replay = await fixture.service.createClaim(validCreate(fixture));
    const conflict = await fixture.service.createClaim({
      ...validCreate(fixture),
      category: "KEY_ALREADY_USED",
    });

    expect(first.status).toBe("CREATED");
    expect(replay).toMatchObject({
      detail: { claim: { id: createdId(first) } },
      status: "EXISTING",
    });
    expect(conflict).toEqual({ code: "CONFLICT", status: "FAILED" });
    await expect(
      fixture.service.createClaim({
        ...validCreate(fixture),
        idempotencyKey: "different-operation-same-active-issue",
      }),
    ).resolves.toEqual({ code: "CONFLICT", status: "FAILED" });
  });

  it("uses optimistic state transitions and structured outcomes", async () => {
    const fixture = setup();
    const created = await fixture.service.createClaim(validCreate(fixture));
    const claimId = createdId(created);
    const first = await fixture.service.transitionClaim({
      claimId,
      correlationId: correlationId("review"),
      expectedVersion: 1,
      nextStatus: "UNDER_REVIEW",
    });
    const stale = await fixture.service.transitionClaim({
      claimId,
      correlationId: correlationId("stale"),
      expectedVersion: 1,
      nextStatus: "RESOLVED",
      outcome: "CUSTOMER_ISSUE_RESOLVED",
    });
    const invalid = await fixture.service.transitionClaim({
      claimId,
      correlationId: correlationId("invalid"),
      expectedVersion: 2,
      nextStatus: "CLOSED",
      outcome: "CUSTOMER_ISSUE_RESOLVED",
    });
    const unsupportedSupplierOutcome = await fixture.service.transitionClaim({
      claimId,
      correlationId: correlationId("supplier-outcome"),
      expectedVersion: 2,
      nextStatus: "RESOLVED",
      outcome: "SUPPLIER_ACCEPTED",
    });

    expect(first).toMatchObject({
      detail: { claim: { recordVersion: 2, status: "UNDER_REVIEW" } },
      status: "OK",
    });
    expect(stale).toEqual({ code: "STALE_VERSION", status: "FAILED" });
    expect(invalid).toEqual({ code: "INVALID_TRANSITION", status: "FAILED" });
    expect(unsupportedSupplierOutcome).toEqual({
      code: "NOT_ELIGIBLE",
      status: "FAILED",
    });
  });

  it("links only finalized exact-order evidence and suppresses duplicate history", async () => {
    const fixture = setup();
    const claimId = createdId(
      await fixture.service.createClaim(validCreate(fixture)),
    );
    const linked = await fixture.service.linkEvidence({
      claimId,
      correlationId: correlationId("evidence"),
      evidenceSnapshotId: fixture.evidenceId,
    });
    const replay = await fixture.service.linkEvidence({
      claimId,
      correlationId: correlationId("evidence-replay"),
      evidenceSnapshotId: fixture.evidenceId,
    });
    expect(linked).toMatchObject({
      detail: { evidenceLinks: [{ evidenceSnapshotId: fixture.evidenceId }] },
      status: "OK",
    });
    expect(replay).toMatchObject({
      detail: { events: expect.any(Array) },
      status: "EXISTING",
    });
    if (replay.status !== "FAILED")
      expect(
        replay.detail.events.filter(
          (event) => event.eventType === "EVIDENCE_LINKED",
        ),
      ).toHaveLength(1);

    const draft = setup();
    draft.repository.setEvidence({
      id: draft.evidenceId,
      orderId: draft.order,
      state: "DRAFT",
    });
    const draftClaim = createdId(
      await draft.service.createClaim(validCreate(draft)),
    );
    await expect(
      draft.service.linkEvidence({
        claimId: draftClaim,
        correlationId: correlationId("draft"),
        evidenceSnapshotId: draft.evidenceId,
      }),
    ).resolves.toMatchObject({ code: "EVIDENCE_NOT_FINALIZED" });

    const cross = setup();
    cross.repository.setEvidence({
      id: cross.evidenceId,
      orderId: orderId(randomUUID()),
      state: "FINALIZED",
    });
    const crossClaim = createdId(
      await cross.service.createClaim(validCreate(cross)),
    );
    await expect(
      cross.service.linkEvidence({
        claimId: crossClaim,
        correlationId: correlationId("cross"),
        evidenceSnapshotId: cross.evidenceId,
      }),
    ).resolves.toMatchObject({ code: "RESOURCE_NOT_AVAILABLE" });
  });

  it("keeps READY separate from submission and defaults production submission unavailable", async () => {
    const fixture = setup();
    const claimId = createdId(
      await fixture.service.createClaim(validCreate(fixture)),
    );
    await toReady(fixture.service, claimId);
    const prepared = await fixture.service.prepareSubmission({
      claimId,
      correlationId: correlationId("prepare"),
    });
    expect(prepared).toMatchObject({
      detail: {
        claim: { status: "READY_FOR_SUBMISSION" },
        submission: { status: "PREPARED" },
      },
      status: "OK",
    });
    await expect(
      fixture.service.executeSubmission({
        claimId,
        correlationId: correlationId("submit"),
        expectedSubmissionVersion: 1,
      }),
    ).resolves.toEqual({ code: "SUBMISSION_UNAVAILABLE", status: "FAILED" });
    await expect(
      fixture.service.linkEvidence({
        claimId,
        correlationId: correlationId("evidence-after-prepare"),
        evidenceSnapshotId: fixture.evidenceId,
      }),
    ).resolves.toEqual({ code: "NOT_ELIGIBLE", status: "FAILED" });

    await fixture.service.transitionClaim({
      claimId,
      correlationId: correlationId("return-to-review"),
      expectedVersion: 3,
      nextStatus: "UNDER_REVIEW",
    });
    await expect(
      fixture.service.executeSubmission({
        claimId,
        correlationId: correlationId("submit-after-return"),
        expectedSubmissionVersion: 1,
      }),
    ).resolves.toEqual({ code: "NOT_ELIGIBLE", status: "FAILED" });
  });

  it("models trusted confirmation and ambiguity without automatic redispatch", async () => {
    const confirmed = setup({
      submissionPort: new FakeSubmissionPort("CONFIRMED"),
    });
    const confirmedId = createdId(
      await confirmed.service.createClaim(validCreate(confirmed)),
    );
    await toReady(confirmed.service, confirmedId);
    await confirmed.service.prepareSubmission({
      claimId: confirmedId,
      correlationId: correlationId("prepare-confirmed"),
    });
    const result = await confirmed.service.executeSubmission({
      claimId: confirmedId,
      correlationId: correlationId("execute-confirmed"),
      expectedSubmissionVersion: 1,
    });
    expect(result).toMatchObject({
      detail: {
        submission: {
          responseType: "ACCEPTED",
          status: "CONFIRMED",
          supplierClaimReference: "synthetic-claim-reference",
        },
      },
      status: "OK",
    });

    const ambiguousPort = new FakeSubmissionPort("AMBIGUOUS");
    const ambiguous = setup({ submissionPort: ambiguousPort });
    const ambiguousId = createdId(
      await ambiguous.service.createClaim(validCreate(ambiguous)),
    );
    await toReady(ambiguous.service, ambiguousId);
    await ambiguous.service.prepareSubmission({
      claimId: ambiguousId,
      correlationId: correlationId("prepare-ambiguous"),
    });
    await expect(
      ambiguous.service.executeSubmission({
        claimId: ambiguousId,
        correlationId: correlationId("execute-ambiguous"),
        expectedSubmissionVersion: 1,
      }),
    ).resolves.toMatchObject({
      detail: { submission: { status: "AMBIGUOUS" } },
    });
    await expect(
      ambiguous.service.executeSubmission({
        claimId: ambiguousId,
        correlationId: correlationId("retry-ambiguous"),
        expectedSubmissionVersion: 3,
      }),
    ).resolves.toEqual({ code: "NOT_ELIGIBLE", status: "FAILED" });
    expect(ambiguousPort.calls).toBe(1);
  });

  it("keeps submission PREPARED and makes no adapter call while operations are paused", async () => {
    const submissionPort = new FakeSubmissionPort("CONFIRMED");
    const fixture = setup({
      operationsControlGate: {
        evaluate: async () => ({
          reasonCode: "OPERATIONS_CONTROL_PAUSED",
          status: "DENIED",
        }),
      },
      submissionPort,
    });
    const claimId = createdId(
      await fixture.service.createClaim(validCreate(fixture)),
    );
    await toReady(fixture.service, claimId);
    await fixture.service.prepareSubmission({
      claimId,
      correlationId: correlationId("prepare-paused"),
    });
    await expect(
      fixture.service.executeSubmission({
        claimId,
        correlationId: correlationId("submit-paused"),
        expectedSubmissionVersion: 1,
      }),
    ).resolves.toEqual({ code: "OPERATIONS_CONTROL_PAUSED", status: "FAILED" });
    expect(submissionPort.calls).toBe(0);
    await expect(fixture.repository.findClaim(claimId)).resolves.toMatchObject({
      submission: { status: "PREPARED" },
    });
  });

  it("classifies malformed trusted-adapter output as ambiguous", async () => {
    const fixture = setup({ submissionPort: new MalformedSubmissionPort() });
    const claimId = createdId(
      await fixture.service.createClaim(validCreate(fixture)),
    );
    await toReady(fixture.service, claimId);
    await fixture.service.prepareSubmission({
      claimId,
      correlationId: correlationId("prepare-malformed"),
    });

    await expect(
      fixture.service.executeSubmission({
        claimId,
        correlationId: correlationId("execute-malformed"),
        expectedSubmissionVersion: 1,
      }),
    ).resolves.toMatchObject({
      detail: {
        submission: {
          responseType: null,
          status: "AMBIGUOUS",
          supplierClaimReference: null,
        },
      },
      status: "OK",
    });
  });

  it("does not copy customer assertions or synthetic secrets into claim, events, audit, or payload", async () => {
    const markers = [
      "KEYRANO_KS0905_PRODUCT_KEY_DO_NOT_LEAK",
      "KEYRANO_KS0905_CIPHERTEXT_DO_NOT_LEAK",
      "KEYRANO_KS0905_SESSION_DO_NOT_LEAK",
      "KEYRANO_KS0905_CLAIM_TOKEN_DO_NOT_LEAK",
      "KEYRANO_KS0905_STRIPE_SECRET_DO_NOT_LEAK",
      "KEYRANO_KS0905_KINGUIN_SECRET_DO_NOT_LEAK",
      "KEYRANO_KS0905_VELOCITY_SECRET_DO_NOT_LEAK",
      "KEYRANO_KS0905_CUSTOMER_MESSAGE_DO_NOT_LEAK",
    ];
    const audit = new CollectingAudit();
    const port = new FakeSubmissionPort("CONFIRMED");
    const fixture = setup({ audit, submissionPort: port });
    await expect(
      fixture.service.createClaim({
        ...validCreate(fixture),
        customerMessage: markers.at(-1),
        productKey: markers[0],
      }),
    ).resolves.toEqual({ code: "BAD_REQUEST", status: "FAILED" });
    const claimId = createdId(
      await fixture.service.createClaim(validCreate(fixture)),
    );
    await toReady(fixture.service, claimId);
    await fixture.service.prepareSubmission({
      claimId,
      correlationId: correlationId("leak-prepare"),
    });
    const result = await fixture.service.executeSubmission({
      claimId,
      correlationId: correlationId("leak-submit"),
      expectedSubmissionVersion: 1,
    });
    const generated = JSON.stringify({
      audit: audit.events,
      payloads: port.payloads,
      result,
    });
    for (const marker of markers) expect(generated).not.toContain(marker);
    expect(generated).not.toContain("message");
  });

  it("keeps durable mutation successful when best-effort audit fails", async () => {
    const fixture = setup({
      audit: {
        append: async () => {
          throw new Error("audit unavailable");
        },
      },
    });
    await expect(
      fixture.service.createClaim(validCreate(fixture)),
    ).resolves.toMatchObject({ status: "CREATED" });
  });
});

const setup = (
  input: {
    readonly trusted?: boolean;
    readonly authority?: SupplierClaimAuthorityPort;
    readonly audit?: AuditEventPort;
    readonly submissionPort?: SupplierClaimSubmissionPort;
    readonly operationsControlGate?: OperationsControlGate;
  } = {},
) => {
  const repository = new InMemorySupplierClaimRepository();
  const order = orderId(randomUUID());
  const supportCaseId = randomUUID();
  const procurementId = randomUUID();
  const fulfillmentId = randomUUID();
  const evidenceId = randomUUID();
  repository.setOrder({ orderId: order });
  repository.setSupportCase({
    category: "ACTIVATION_PROBLEM",
    id: supportCaseId,
    orderId: order,
    status: "OPEN",
  });
  repository.setProcurement({
    dispatchState: "DISPATCH_CONFIRMED",
    externalSupplierOrderId: "supplier-order-synthetic",
    id: procurementId,
    orderId: order,
    status: "SUCCEEDED",
    supplierId: "mock-supplier",
  });
  repository.setFulfillment({
    deliveryState: "PENDING",
    id: fulfillmentId,
    orderId: order,
    procurementOperationId: procurementId,
    retrievalState: "RETRIEVED",
    status: "DELIVERY_PENDING",
  });
  repository.setEvidence({
    id: evidenceId,
    orderId: order,
    state: "FINALIZED",
  });
  const service = new SupplierClaimService({
    ...(input.authority
      ? { authority: input.authority }
      : input.trusted === false
        ? {}
        : { authority: new TrustedAuthority() }),
    ...(input.audit ? { audit: input.audit } : {}),
    ...(input.submissionPort ? { submissionPort: input.submissionPort } : {}),
    environment: "CI",
    now: () => now,
    operationsControlGate: input.operationsControlGate ?? allowOperations,
    repository,
  });
  return {
    evidenceId,
    fulfillmentId,
    order,
    procurementId,
    repository,
    service,
    supportCaseId,
  };
};

const validCreate = (fixture: ReturnType<typeof setup>) => ({
  category: "KEY_NOT_WORKING" as const,
  correlationId: correlationId("ks0905-create"),
  fulfillmentId: fixture.fulfillmentId,
  idempotencyKey: "support-escalation-synthetic-1",
  orderId: fixture.order,
  procurementOperationId: fixture.procurementId,
  source: "SUPPORT" as const,
  supportCaseId: fixture.supportCaseId,
});

const createdId = (
  result: Awaited<ReturnType<SupplierClaimService["createClaim"]>>,
): string => {
  if (result.status === "FAILED")
    throw new Error(`Expected created claim, got ${result.code}`);
  return result.detail.claim.id;
};

const toReady = async (
  service: SupplierClaimService,
  claimId: string,
): Promise<void> => {
  await service.transitionClaim({
    claimId,
    correlationId: correlationId("under-review"),
    expectedVersion: 1,
    nextStatus: "UNDER_REVIEW",
  });
  await service.transitionClaim({
    claimId,
    correlationId: correlationId("ready"),
    expectedVersion: 2,
    nextStatus: "READY_FOR_SUBMISSION",
  });
};

class TrustedAuthority implements SupplierClaimAuthorityPort {
  public async authorize(): Promise<{
    readonly status: "AUTHORIZED";
    readonly actorReference: string;
  }> {
    return { actorReference: "operator:ks0905", status: "AUTHORIZED" };
  }
}

class UnsafeAuthority implements SupplierClaimAuthorityPort {
  public async authorize(): Promise<{
    readonly status: "AUTHORIZED";
    readonly actorReference: string;
  }> {
    return {
      actorReference: "KEYRANO_KS0905_KINGUIN_SECRET_DO_NOT_LEAK",
      status: "AUTHORIZED",
    };
  }
}

class FakeSubmissionPort implements SupplierClaimSubmissionPort {
  public calls = 0;
  public readonly payloads: SupplierClaimSubmissionPayload[] = [];
  public constructor(private readonly result: "CONFIRMED" | "AMBIGUOUS") {}
  public async isAvailable(): Promise<boolean> {
    return true;
  }
  public async submit(input: SupplierClaimSubmissionPayload) {
    this.calls += 1;
    this.payloads.push(input);
    return this.result === "CONFIRMED"
      ? {
          responseType: "ACCEPTED" as const,
          status: "CONFIRMED" as const,
          supplierClaimReference: "synthetic-claim-reference",
        }
      : { status: "AMBIGUOUS" as const };
  }
}

class CollectingAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];
  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class MalformedSubmissionPort implements SupplierClaimSubmissionPort {
  public async isAvailable(): Promise<boolean> {
    return true;
  }

  public async submit(): Promise<{
    readonly status: "CONFIRMED";
    readonly supplierClaimReference: string;
    readonly responseType: "ACCEPTED";
  }> {
    return {
      responseType: "ACCEPTED",
      status: "CONFIRMED",
      supplierClaimReference: "KEYRANO_KS0905_PRODUCT_KEY_DO_NOT_LEAK",
    };
  }
}
