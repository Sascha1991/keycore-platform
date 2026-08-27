import type {
  DisputeEvidenceAuthoritativeFacts,
  DisputeEvidenceRepository,
  DisputeEvidenceSnapshot,
  OrderId,
} from "../../packages/platform/src/contracts.js";

export class InMemoryDisputeEvidenceRepository implements DisputeEvidenceRepository {
  private readonly facts = new Map<
    OrderId,
    DisputeEvidenceAuthoritativeFacts
  >();
  private readonly snapshots = new Map<string, DisputeEvidenceSnapshot>();
  private readonly byOrderFingerprint = new Map<string, string>();

  public setFacts(facts: DisputeEvidenceAuthoritativeFacts): void {
    this.facts.set(facts.order.orderId, facts);
  }

  public async loadAuthoritativeFacts(
    orderId: OrderId,
  ): Promise<DisputeEvidenceAuthoritativeFacts | null> {
    return this.facts.get(orderId) ?? null;
  }

  public async persistDraft(input: {
    readonly snapshot: DisputeEvidenceSnapshot;
  }): Promise<DisputeEvidenceSnapshot> {
    const key = fingerprintKey(input.snapshot);
    const existingId = this.byOrderFingerprint.get(key);
    if (existingId) {
      const existing = this.snapshots.get(existingId);
      if (!existing) {
        throw new Error("Dispute evidence in-memory index is corrupt");
      }
      return existing;
    }
    const version =
      Math.max(
        0,
        ...[...this.snapshots.values()]
          .filter((snapshot) => snapshot.orderId === input.snapshot.orderId)
          .map((snapshot) => snapshot.version),
      ) + 1;
    const snapshot = { ...input.snapshot, version };
    this.snapshots.set(snapshot.evidenceSnapshotId, snapshot);
    this.byOrderFingerprint.set(key, snapshot.evidenceSnapshotId);
    return snapshot;
  }

  public async findSnapshotById(
    snapshotId: string,
  ): Promise<DisputeEvidenceSnapshot | null> {
    return this.snapshots.get(snapshotId) ?? null;
  }

  public async finalizeSnapshot(input: {
    readonly snapshotId: string;
    readonly orderId: OrderId;
    readonly finalizedAt: Date;
  }): Promise<
    | {
        readonly status: "FINALIZED" | "ALREADY_FINALIZED";
        readonly snapshot: DisputeEvidenceSnapshot;
      }
    | { readonly status: "NOT_FOUND" | "ORDER_MISMATCH" | "NOT_FINALIZABLE" }
  > {
    const current = this.snapshots.get(input.snapshotId);
    if (!current) {
      return { status: "NOT_FOUND" };
    }
    if (current.orderId !== input.orderId) {
      return { status: "ORDER_MISMATCH" };
    }
    if (current.state === "FINALIZED") {
      return { snapshot: current, status: "ALREADY_FINALIZED" };
    }
    if (current.state !== "DRAFT") {
      return { status: "NOT_FINALIZABLE" };
    }
    const finalized: DisputeEvidenceSnapshot = {
      ...current,
      finalizedAt: input.finalizedAt,
      state: "FINALIZED",
    };
    this.snapshots.set(input.snapshotId, finalized);
    return { snapshot: finalized, status: "FINALIZED" };
  }
}

const fingerprintKey = (snapshot: DisputeEvidenceSnapshot): string =>
  `${snapshot.orderId}:${snapshot.schemaVersion}:${snapshot.factFingerprint}`;
