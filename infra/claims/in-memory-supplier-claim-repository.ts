import type {
  OrderId,
  SupplierClaim,
  SupplierClaimDetail,
  SupplierClaimEvent,
  SupplierClaimEvidenceLink,
  SupplierClaimEvidenceReference,
  SupplierClaimFulfillmentReference,
  SupplierClaimOrderReference,
  SupplierClaimProcurementReference,
  SupplierClaimRepository,
  SupplierClaimStatus,
  SupplierClaimSubmissionOperation,
  SupplierClaimSupportReference,
} from "../../packages/platform/src/contracts.js";

export class InMemorySupplierClaimRepository implements SupplierClaimRepository {
  private readonly orders = new Map<OrderId, SupplierClaimOrderReference>();
  private readonly supportCases = new Map<
    string,
    SupplierClaimSupportReference
  >();
  private readonly procurements = new Map<
    string,
    SupplierClaimProcurementReference
  >();
  private readonly fulfillments = new Map<
    string,
    SupplierClaimFulfillmentReference
  >();
  private readonly evidence = new Map<string, SupplierClaimEvidenceReference>();
  private readonly claims = new Map<string, SupplierClaim>();
  private readonly idempotency = new Map<string, string>();
  private readonly activeIssues = new Map<string, string>();
  private readonly links = new Map<string, SupplierClaimEvidenceLink[]>();
  private readonly events = new Map<string, SupplierClaimEvent[]>();
  private readonly submissions = new Map<
    string,
    SupplierClaimSubmissionOperation
  >();

  public setOrder(value: SupplierClaimOrderReference): void {
    this.orders.set(value.orderId, value);
  }
  public setSupportCase(value: SupplierClaimSupportReference): void {
    this.supportCases.set(value.id, value);
  }
  public setProcurement(value: SupplierClaimProcurementReference): void {
    this.procurements.set(value.id, value);
  }
  public setFulfillment(value: SupplierClaimFulfillmentReference): void {
    this.fulfillments.set(value.id, value);
  }
  public setEvidence(value: SupplierClaimEvidenceReference): void {
    this.evidence.set(value.id, value);
  }

  public async findOrder(
    orderId: OrderId,
  ): Promise<SupplierClaimOrderReference | null> {
    return this.orders.get(orderId) ?? null;
  }
  public async findSupportCase(
    id: string,
  ): Promise<SupplierClaimSupportReference | null> {
    return this.supportCases.get(id) ?? null;
  }
  public async findProcurementOperation(
    id: string,
  ): Promise<SupplierClaimProcurementReference | null> {
    return this.procurements.get(id) ?? null;
  }
  public async findFulfillment(
    id: string,
  ): Promise<SupplierClaimFulfillmentReference | null> {
    return this.fulfillments.get(id) ?? null;
  }
  public async findEvidence(
    id: string,
  ): Promise<SupplierClaimEvidenceReference | null> {
    return this.evidence.get(id) ?? null;
  }

  public async createClaim(input: {
    readonly claim: SupplierClaim;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | { readonly status: "CREATED"; readonly detail: SupplierClaimDetail }
    | { readonly status: "EXISTING"; readonly detail: SupplierClaimDetail }
    | { readonly status: "CONFLICT" }
  > {
    const existingId = this.idempotency.get(input.claim.idempotencyKey);
    if (existingId) {
      const existing = this.claims.get(existingId);
      if (
        !existing ||
        existing.idempotencyFingerprint !== input.claim.idempotencyFingerprint
      )
        return { status: "CONFLICT" };
      return { detail: this.requireDetail(existingId), status: "EXISTING" };
    }
    const issue = issueKey(input.claim);
    const activeId = this.activeIssues.get(issue);
    if (activeId) return { status: "CONFLICT" };
    this.claims.set(input.claim.id, input.claim);
    this.idempotency.set(input.claim.idempotencyKey, input.claim.id);
    this.activeIssues.set(issue, input.claim.id);
    this.events.set(input.claim.id, [input.event]);
    return { detail: this.requireDetail(input.claim.id), status: "CREATED" };
  }

  public async findClaim(id: string): Promise<SupplierClaimDetail | null> {
    return this.detail(id);
  }

  public async transitionClaim(input: {
    readonly claimId: string;
    readonly expectedVersion: number;
    readonly nextStatus: SupplierClaimStatus;
    readonly outcome: SupplierClaim["outcome"];
    readonly now: Date;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | { readonly status: "UPDATED"; readonly detail: SupplierClaimDetail }
    | { readonly status: "NOT_FOUND" | "STALE_VERSION" }
  > {
    const current = this.claims.get(input.claimId);
    if (!current) return { status: "NOT_FOUND" };
    if (
      current.recordVersion !== input.expectedVersion ||
      input.event.fromStatus !== current.status
    )
      return { status: "STALE_VERSION" };
    const resolvedAt =
      input.nextStatus === "RESOLVED" ? input.now : current.resolvedAt;
    const closedAt = input.nextStatus === "CLOSED" ? input.now : null;
    const updated: SupplierClaim = {
      ...current,
      closedAt,
      outcome: input.outcome,
      recordVersion: current.recordVersion + 1,
      resolvedAt,
      status: input.nextStatus,
      updatedAt: input.now,
    };
    this.claims.set(input.claimId, updated);
    this.events.set(input.claimId, [
      ...(this.events.get(input.claimId) ?? []),
      input.event,
    ]);
    if (["RESOLVED", "CLOSED"].includes(updated.status))
      this.activeIssues.delete(issueKey(current));
    return { detail: this.requireDetail(input.claimId), status: "UPDATED" };
  }

  public async linkEvidence(input: {
    readonly claimId: string;
    readonly link: SupplierClaimEvidenceLink;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | {
        readonly status: "LINKED" | "EXISTING";
        readonly detail: SupplierClaimDetail;
      }
    | { readonly status: "NOT_FOUND" }
  > {
    if (!this.claims.has(input.claimId)) return { status: "NOT_FOUND" };
    const current = this.links.get(input.claimId) ?? [];
    if (
      current.some(
        (link) => link.evidenceSnapshotId === input.link.evidenceSnapshotId,
      )
    )
      return { detail: this.requireDetail(input.claimId), status: "EXISTING" };
    this.links.set(input.claimId, [...current, input.link]);
    this.events.set(input.claimId, [
      ...(this.events.get(input.claimId) ?? []),
      input.event,
    ]);
    return { detail: this.requireDetail(input.claimId), status: "LINKED" };
  }

  public async prepareSubmission(input: {
    readonly operation: SupplierClaimSubmissionOperation;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | {
        readonly status: "PREPARED" | "EXISTING";
        readonly detail: SupplierClaimDetail;
      }
    | { readonly status: "NOT_FOUND" | "NOT_READY" }
  > {
    const claim = this.claims.get(input.operation.claimId);
    if (!claim) return { status: "NOT_FOUND" };
    if (claim.status !== "READY_FOR_SUBMISSION") return { status: "NOT_READY" };
    const existing = this.submissions.get(input.operation.claimId);
    if (existing)
      return {
        detail: this.requireDetail(input.operation.claimId),
        status: "EXISTING",
      };
    this.submissions.set(input.operation.claimId, input.operation);
    this.events.set(input.operation.claimId, [
      ...(this.events.get(input.operation.claimId) ?? []),
      input.event,
    ]);
    return {
      detail: this.requireDetail(input.operation.claimId),
      status: "PREPARED",
    };
  }

  public async acquireSubmission(input: {
    readonly claimId: string;
    readonly operationId: string;
    readonly expectedVersion: number;
    readonly now: Date;
    readonly event: SupplierClaimEvent;
  }): Promise<
    | { readonly status: "ACQUIRED"; readonly detail: SupplierClaimDetail }
    | { readonly status: "NOT_FOUND" | "NOT_PREPARED" | "STALE_VERSION" }
  > {
    const current = this.submissions.get(input.claimId);
    if (!current || current.id !== input.operationId)
      return { status: "NOT_FOUND" };
    if (current.recordVersion !== input.expectedVersion)
      return { status: "STALE_VERSION" };
    if (current.status !== "PREPARED") return { status: "NOT_PREPARED" };
    this.submissions.set(input.claimId, {
      ...current,
      dispatchedAt: input.now,
      recordVersion: current.recordVersion + 1,
      status: "DISPATCHING",
      updatedAt: input.now,
    });
    this.events.set(input.claimId, [
      ...(this.events.get(input.claimId) ?? []),
      input.event,
    ]);
    return { detail: this.requireDetail(input.claimId), status: "ACQUIRED" };
  }

  public async completeSubmission(input: {
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
  > {
    const current = this.submissions.get(input.claimId);
    if (!current || current.id !== input.operationId)
      return { status: "NOT_FOUND" };
    if (
      current.recordVersion !== input.expectedVersion ||
      current.status !== "DISPATCHING"
    )
      return { status: "STALE_VERSION" };
    this.submissions.set(input.claimId, {
      ...current,
      confirmedAt: input.status === "CONFIRMED" ? input.now : null,
      recordVersion: current.recordVersion + 1,
      responseType: input.responseType,
      status: input.status,
      supplierClaimReference: input.supplierClaimReference,
      updatedAt: input.now,
    });
    this.events.set(input.claimId, [
      ...(this.events.get(input.claimId) ?? []),
      input.event,
    ]);
    return { detail: this.requireDetail(input.claimId), status: "UPDATED" };
  }

  private detail(id: string): SupplierClaimDetail | null {
    const claim = this.claims.get(id);
    if (!claim) return null;
    return {
      claim,
      evidenceLinks: [...(this.links.get(id) ?? [])],
      events: [...(this.events.get(id) ?? [])],
      submission: this.submissions.get(id) ?? null,
    };
  }

  private requireDetail(id: string): SupplierClaimDetail {
    const detail = this.detail(id);
    if (!detail)
      throw new Error("Supplier claim disappeared from in-memory repository");
    return detail;
  }
}

const issueKey = (claim: SupplierClaim): string =>
  [
    claim.orderId,
    claim.supportCaseId,
    claim.category,
    claim.procurementOperationId,
    claim.fulfillmentId ?? "none",
  ].join(":");
