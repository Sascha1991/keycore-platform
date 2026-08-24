import type {
  ProcurementCreateResult,
  ProcurementLeaseResult,
  ProcurementOperation,
  ProcurementOperationRepository,
} from "../../packages/platform/src/procurement/supplier-procurement.js";
import type { OrderId } from "../../packages/platform/src/domain/identifiers.js";

export class InMemoryProcurementOperationRepository implements ProcurementOperationRepository {
  private readonly operations = new Map<string, ProcurementOperation>();

  public async findById(
    operationId: string,
  ): Promise<ProcurementOperation | null> {
    return this.operations.get(operationId) ?? null;
  }

  public async listByOrder(
    orderId: OrderId,
  ): Promise<readonly ProcurementOperation[]> {
    return [...this.operations.values()]
      .filter((operation) => operation.orderId === orderId)
      .sort((left, right) => left.attemptGeneration - right.attemptGeneration);
  }

  public async createNextAttempt(input: {
    readonly operation: ProcurementOperation;
  }): Promise<ProcurementCreateResult> {
    const existing = await this.listByOrder(input.operation.orderId);
    const blocking = existing.find((operation) =>
      [
        "PENDING",
        "READY",
        "IN_FLIGHT",
        "AMBIGUOUS",
        "RECONCILIATION_REQUIRED",
      ].includes(operation.status),
    );
    if (blocking) {
      return { operation: blocking, status: "EXISTING" };
    }
    if (existing.some((operation) => operation.status === "SUCCEEDED")) {
      const succeeded = existing.find(
        (operation) => operation.status === "SUCCEEDED",
      );
      return succeeded
        ? { operation: succeeded, status: "BLOCKED" }
        : { status: "BLOCKED" };
    }
    if (
      existing.some(
        (operation) =>
          operation.attemptGeneration === input.operation.attemptGeneration,
      )
    ) {
      return { status: "BLOCKED" };
    }
    this.operations.set(input.operation.id, input.operation);
    return { operation: input.operation, status: "CREATED" };
  }

  public async acquireExecutionLease(input: {
    readonly operationId: string;
    readonly executionToken: string;
    readonly staleStartedBefore: Date;
    readonly now: Date;
  }): Promise<ProcurementLeaseResult> {
    const current = this.operations.get(input.operationId);
    if (!current) {
      return { status: "NOT_ELIGIBLE" };
    }
    if (current.status === "IN_FLIGHT") {
      if (
        current.executionToken &&
        current.executionStartedAt &&
        current.executionStartedAt.getTime() >
          input.staleStartedBefore.getTime()
      ) {
        return { operation: current, status: "IN_FLIGHT" };
      }
      if (current.dispatchState === "DISPATCH_STARTED") {
        return { operation: current, status: "STALE_DISPATCH_STARTED" };
      }
    }
    if (current.status !== "READY") {
      return current
        ? { operation: current, status: "NOT_ELIGIBLE" }
        : { status: "NOT_ELIGIBLE" };
    }
    if (
      current.executionToken &&
      current.executionStartedAt &&
      current.executionStartedAt.getTime() > input.staleStartedBefore.getTime()
    ) {
      return { operation: current, status: "IN_FLIGHT" };
    }
    if (
      current.dispatchState === "DISPATCH_STARTED" &&
      current.executionStartedAt &&
      current.executionStartedAt.getTime() <= input.staleStartedBefore.getTime()
    ) {
      return { operation: current, status: "STALE_DISPATCH_STARTED" };
    }
    const updated = updateOperation(current, input.now, {
      executionStartedAt: input.now,
      executionToken: input.executionToken,
      status: "IN_FLIGHT",
    });
    this.operations.set(updated.id, updated);
    return { operation: updated, status: "ACQUIRED" };
  }

  public async markDispatchStarted(input: {
    readonly operationId: string;
    readonly executionToken: string;
    readonly now: Date;
  }): Promise<ProcurementOperation | null> {
    return this.updateOwned(input, { dispatchState: "DISPATCH_STARTED" });
  }

  public async markSucceeded(input: {
    readonly operationId: string;
    readonly executionToken: string;
    readonly externalSupplierOrderId: string;
    readonly normalizedSupplierStatus: string;
    readonly responseFingerprint: string;
    readonly acquisitionAmount: NonNullable<
      ProcurementOperation["acquisitionAmount"]
    >;
    readonly now: Date;
  }): Promise<ProcurementOperation | null> {
    return this.updateOwned(input, {
      acquisitionAmount: input.acquisitionAmount,
      dispatchState: "DISPATCH_CONFIRMED",
      executionStartedAt: null,
      executionToken: null,
      externalSupplierOrderId: input.externalSupplierOrderId,
      normalizedSupplierStatus: input.normalizedSupplierStatus,
      responseFingerprint: input.responseFingerprint,
      status: "SUCCEEDED",
    });
  }

  public async markFailed(input: {
    readonly operationId: string;
    readonly executionToken: string;
    readonly status: "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "AMBIGUOUS";
    readonly reasonCode: string;
    readonly externalSupplierOrderId?: string | null;
    readonly responseFingerprint?: string | null;
    readonly now: Date;
  }): Promise<ProcurementOperation | null> {
    return this.updateOwned(input, {
      executionStartedAt: null,
      executionToken: null,
      externalSupplierOrderId: input.externalSupplierOrderId ?? null,
      reconciliationReasonCode: input.reasonCode,
      responseFingerprint: input.responseFingerprint ?? null,
      status: input.status,
    });
  }

  public async markReconciliation(input: {
    readonly operationId: string;
    readonly status:
      "SUCCEEDED" | "FAILED_TERMINAL" | "AMBIGUOUS" | "RECONCILIATION_REQUIRED";
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<ProcurementOperation | null> {
    const current = this.operations.get(input.operationId);
    if (!current) {
      return null;
    }
    const updated = updateOperation(current, input.now, {
      executionStartedAt: null,
      executionToken: null,
      lastReconciledAt: input.now,
      reconciliationReasonCode: input.reasonCode,
      status: input.status,
    });
    this.operations.set(updated.id, updated);
    return updated;
  }

  private async updateOwned(
    input: {
      readonly operationId: string;
      readonly executionToken: string;
      readonly now: Date;
    },
    patch: Partial<ProcurementOperation>,
  ): Promise<ProcurementOperation | null> {
    const current = this.operations.get(input.operationId);
    if (!current || current.executionToken !== input.executionToken) {
      return null;
    }
    const updated = updateOperation(current, input.now, patch);
    this.operations.set(updated.id, updated);
    return updated;
  }
}

const updateOperation = (
  current: ProcurementOperation,
  now: Date,
  patch: Partial<ProcurementOperation>,
): ProcurementOperation => ({
  ...current,
  ...patch,
  recordVersion: current.recordVersion + 1,
  updatedAt: now,
});
