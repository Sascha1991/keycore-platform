import { createHash, randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type { Money } from "../domain/money.js";
import type {
  CorrelationId,
  IdempotencyKey,
  OrderId,
  OrderLineId,
  SupplierId,
  SupplierOfferId,
  SupplierProductId,
} from "../domain/identifiers.js";
import { idempotencyKey, orderLineId } from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import type { PurchaseReceipt } from "../ports/supplier.js";
import type {
  KeyCoreOrder,
  OrderOrchestrationService,
} from "../orders/order-orchestration.js";
import {
  evaluateHighRiskOperation,
  type OperationsControlGate,
} from "../operations/operations-controls.js";
import type { PriceLockService } from "../pricing/price-locks.js";
import type { PricingService } from "../pricing/pricing-margin.js";
import type { SafePayload } from "../queue/job.js";
import { SupplierError } from "../suppliers/errors.js";
import type { SupplierRegistry } from "../suppliers/registry.js";
import type {
  SupplierRoutingCandidate,
  SupplierRoutingPolicy,
  SupplierRoutingService,
} from "../suppliers/routing.js";

export type ProcurementExecutionMode =
  "DISABLED" | "DRY_RUN" | "FAKE_SUPPLIER_ONLY";

export type ProcurementOperationStatus =
  | "PENDING"
  | "READY"
  | "IN_FLIGHT"
  | "SUCCEEDED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL"
  | "AMBIGUOUS"
  | "RECONCILIATION_REQUIRED";

export type ProcurementDispatchState =
  "NOT_DISPATCHED" | "DISPATCH_STARTED" | "DISPATCH_CONFIRMED";

export const procurementReasonCodes = [
  "PROCUREMENT_DISABLED",
  "PROCUREMENT_DRY_RUN",
  "ORDER_NOT_PROCUREMENT_ELIGIBLE",
  "PAYMENT_NOT_CAPTURED",
  "RISK_NOT_APPROVED",
  "PRICE_LOCK_INVALID",
  "PROFITABILITY_REVALIDATION_FAILED",
  "NO_PROFITABLE_SUPPLIER_OFFER",
  "SUPPLIER_OFFER_NOT_FOUND",
  "SUPPLIER_MAPPING_NOT_FOUND",
  "PROCUREMENT_ALREADY_SUCCEEDED",
  "PROCUREMENT_ALREADY_IN_FLIGHT",
  "PROCUREMENT_AMBIGUOUS",
  "PROCUREMENT_RECONCILIATION_REQUIRED",
  "SUPPLIER_REJECTED",
  "SUPPLIER_RESPONSE_INVALID",
  "SUPPLIER_NETWORK_AMBIGUOUS",
  "SUPPLIER_AUTHENTICATION_FAILED",
  "SUPPLIER_RATE_LIMITED",
  "OPERATIONS_CONTROL_PAUSED",
  "OPERATIONS_CONTROL_UNAVAILABLE",
  "OPTIMISTIC_CONCURRENCY_CONFLICT",
] as const;

export type ProcurementReasonCode = (typeof procurementReasonCodes)[number];

export interface ProcurementOperation {
  readonly id: string;
  readonly orderId: OrderId;
  readonly supplierId: SupplierId;
  readonly supplierProductId: SupplierProductId;
  readonly supplierOfferId: SupplierOfferId;
  readonly quantity: number;
  readonly status: ProcurementOperationStatus;
  readonly dispatchState: ProcurementDispatchState;
  readonly attemptGeneration: number;
  readonly recordVersion: number;
  readonly correlationId: CorrelationId;
  readonly clientIdempotencyReference: IdempotencyKey;
  readonly acquisitionAmount?: Money | null;
  readonly externalSupplierOrderId?: string | null;
  readonly normalizedSupplierStatus?: string | null;
  readonly responseFingerprint?: string | null;
  readonly executionToken?: string | null;
  readonly executionStartedAt?: Date | null;
  readonly lastReconciledAt?: Date | null;
  readonly reconciliationReasonCode?: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ProcurementCreateResult =
  | { readonly status: "CREATED"; readonly operation: ProcurementOperation }
  | { readonly status: "EXISTING"; readonly operation: ProcurementOperation }
  | { readonly status: "BLOCKED"; readonly operation?: ProcurementOperation };

export type ProcurementLeaseResult =
  | { readonly status: "ACQUIRED"; readonly operation: ProcurementOperation }
  | { readonly status: "IN_FLIGHT"; readonly operation: ProcurementOperation }
  | {
      readonly status: "STALE_DISPATCH_STARTED";
      readonly operation: ProcurementOperation;
    }
  | {
      readonly status: "NOT_ELIGIBLE";
      readonly operation?: ProcurementOperation;
    };

export interface ProcurementOperationRepository {
  findById(operationId: string): Promise<ProcurementOperation | null>;
  listByOrder(orderId: OrderId): Promise<readonly ProcurementOperation[]>;
  createNextAttempt(input: {
    readonly operation: ProcurementOperation;
    readonly now: Date;
  }): Promise<ProcurementCreateResult>;
  acquireExecutionLease(input: {
    readonly operationId: string;
    readonly executionToken: string;
    readonly staleStartedBefore: Date;
    readonly now: Date;
  }): Promise<ProcurementLeaseResult>;
  markDispatchStarted(input: {
    readonly operationId: string;
    readonly executionToken: string;
    readonly now: Date;
  }): Promise<ProcurementOperation | null>;
  markSucceeded(input: {
    readonly operationId: string;
    readonly executionToken: string;
    readonly externalSupplierOrderId: string;
    readonly normalizedSupplierStatus: string;
    readonly responseFingerprint: string;
    readonly acquisitionAmount: Money;
    readonly now: Date;
  }): Promise<ProcurementOperation | null>;
  markFailed(input: {
    readonly operationId: string;
    readonly executionToken: string;
    readonly status: Extract<
      ProcurementOperationStatus,
      "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "AMBIGUOUS"
    >;
    readonly reasonCode: ProcurementReasonCode;
    readonly externalSupplierOrderId?: string | null;
    readonly responseFingerprint?: string | null;
    readonly now: Date;
  }): Promise<ProcurementOperation | null>;
  markReconciliation(input: {
    readonly operationId: string;
    readonly status: Extract<
      ProcurementOperationStatus,
      "SUCCEEDED" | "FAILED_TERMINAL" | "AMBIGUOUS" | "RECONCILIATION_REQUIRED"
    >;
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<ProcurementOperation | null>;
}

export interface ProcurementServiceOptions {
  readonly repository: ProcurementOperationRepository;
  readonly orders: OrderOrchestrationService;
  readonly priceLocks: PriceLockService;
  readonly pricing: PricingService;
  readonly routing: SupplierRoutingService;
  readonly suppliers: SupplierRegistry;
  readonly routingPolicy: SupplierRoutingPolicy;
  readonly executionMode: ProcurementExecutionMode;
  readonly executionLeaseStaleAfterMs: number;
  readonly operationsControlGate?: OperationsControlGate;
  readonly audit?: AuditEventPort;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
}

export interface ProcurementResult {
  readonly status:
    | "BLOCKED"
    | "DRY_RUN_READY"
    | "IN_PROGRESS"
    | "SUCCEEDED"
    | "FAILED_RETRYABLE"
    | "FAILED_TERMINAL"
    | "AMBIGUOUS"
    | "RECONCILIATION_REQUIRED";
  readonly reasonCode: ProcurementReasonCode;
  readonly operation?: ProcurementOperation;
}

export class SupplierProcurementService {
  private readonly now: () => Date;
  private readonly environment: AuditEvent["environment"];

  public constructor(private readonly options: ProcurementServiceOptions) {
    if (
      !Number.isInteger(options.executionLeaseStaleAfterMs) ||
      options.executionLeaseStaleAfterMs <= 0
    ) {
      throw new Error("Procurement execution lease staleness must be positive");
    }
    this.now = options.now ?? (() => new Date());
    this.environment = options.environment ?? "LOCAL";
  }

  public async startProcurement(input: {
    readonly orderId: OrderId;
    readonly correlationId: CorrelationId;
  }): Promise<ProcurementResult> {
    const order = await this.options.orders.getOrder(input.orderId);
    if (!order) {
      return {
        reasonCode: "ORDER_NOT_PROCUREMENT_ELIGIBLE",
        status: "BLOCKED",
      };
    }
    const existing = await this.blockingExistingOperation(order.id);
    if (existing) {
      return existing;
    }
    const gate = this.procurementGate(order);
    if (gate) {
      return { reasonCode: gate, status: "BLOCKED" };
    }
    if (this.options.executionMode === "DISABLED") {
      return { reasonCode: "PROCUREMENT_DISABLED", status: "BLOCKED" };
    }

    const candidate = await this.selectProfitableCandidate(order, []);
    if (!candidate) {
      return {
        reasonCode: "NO_PROFITABLE_SUPPLIER_OFFER",
        status: "BLOCKED",
      };
    }
    if (
      this.options.executionMode === "FAKE_SUPPLIER_ONLY" &&
      candidate.supplierId !== ("mock-supplier" as SupplierId)
    ) {
      return { reasonCode: "PROCUREMENT_DISABLED", status: "BLOCKED" };
    }

    const now = this.now();
    const created = await this.options.repository.createNextAttempt({
      now,
      operation: {
        attemptGeneration:
          (await this.options.repository.listByOrder(order.id)).length + 1,
        clientIdempotencyReference: procurementIdempotencyReference({
          generation:
            (await this.options.repository.listByOrder(order.id)).length + 1,
          orderId: order.id,
          supplierId: candidate.supplierId,
        }),
        correlationId: input.correlationId,
        createdAt: now,
        dispatchState: "NOT_DISPATCHED",
        id: randomUUID(),
        orderId: order.id,
        quantity: order.quantity,
        recordVersion: 1,
        status: "READY",
        supplierId: candidate.supplierId,
        supplierOfferId: candidate.supplierOfferId,
        supplierProductId: candidate.supplierProductId,
        updatedAt: now,
        acquisitionAmount: candidate.price,
      },
    });
    const operation = created.operation;
    if (!operation) {
      return {
        reasonCode: "OPTIMISTIC_CONCURRENCY_CONFLICT",
        status: "BLOCKED",
      };
    }

    if (this.options.executionMode === "DRY_RUN") {
      await this.audit(
        operation,
        "PROCUREMENT_DRY_RUN_READY",
        "SUCCEEDED",
        "PROCUREMENT_DRY_RUN",
      );
      return {
        operation,
        reasonCode: "PROCUREMENT_DRY_RUN",
        status: "DRY_RUN_READY",
      };
    }

    return this.executeOperation(operation.id, input.correlationId);
  }

  public async executeOperation(
    operationId: string,
    correlationId: CorrelationId,
  ): Promise<ProcurementResult> {
    if (this.options.executionMode !== "FAKE_SUPPLIER_ONLY") {
      return { reasonCode: "PROCUREMENT_DISABLED", status: "BLOCKED" };
    }
    const operations = await evaluateHighRiskOperation(
      this.options.operationsControlGate,
      "PROCUREMENT_CREATE",
    );
    if (operations.status === "DENIED") {
      return { reasonCode: operations.reasonCode, status: "BLOCKED" };
    }
    const token = randomUUID();
    const now = this.now();
    const lease = await this.options.repository.acquireExecutionLease({
      executionToken: token,
      now,
      operationId,
      staleStartedBefore: new Date(
        now.getTime() - this.options.executionLeaseStaleAfterMs,
      ),
    });
    if (lease.status === "IN_FLIGHT") {
      return {
        operation: lease.operation,
        reasonCode: "PROCUREMENT_ALREADY_IN_FLIGHT",
        status: "IN_PROGRESS",
      };
    }
    if (lease.status === "STALE_DISPATCH_STARTED") {
      const ambiguous = await this.options.repository.markReconciliation({
        now,
        operationId: lease.operation.id,
        reasonCode: "STALE_DISPATCH_REQUIRES_RECONCILIATION",
        status: "AMBIGUOUS",
      });
      if (ambiguous) {
        await this.recordOrderResult(ambiguous, "AMBIGUOUS", correlationId);
      }
      return {
        operation: ambiguous ?? lease.operation,
        reasonCode: "PROCUREMENT_AMBIGUOUS",
        status: "AMBIGUOUS",
      };
    }
    if (lease.status !== "ACQUIRED") {
      return {
        reasonCode: "PROCUREMENT_RECONCILIATION_REQUIRED",
        status: "BLOCKED",
      };
    }
    const started = await this.options.repository.markDispatchStarted({
      executionToken: token,
      now: this.now(),
      operationId,
    });
    if (!started) {
      return {
        reasonCode: "OPTIMISTIC_CONCURRENCY_CONFLICT",
        status: "BLOCKED",
      };
    }

    const supplier = this.options.suppliers.resolve(started.supplierId);
    try {
      const receipt = await supplier.submitPurchase({
        clientIdempotencyReference: started.clientIdempotencyReference,
        correlationId,
        orderLineId: procurementOrderLineId(started.orderId),
        supplierOfferId: started.supplierOfferId,
      });
      const valid = validateReceipt(receipt);
      if (!valid) {
        const failed = await this.options.repository.markFailed({
          executionToken: token,
          now: this.now(),
          operationId,
          reasonCode: "SUPPLIER_RESPONSE_INVALID",
          status: "AMBIGUOUS",
        });
        if (failed) {
          await this.recordOrderResult(failed, "AMBIGUOUS", correlationId);
        }
        return {
          operation: failed ?? started,
          reasonCode: "SUPPLIER_RESPONSE_INVALID",
          status: "AMBIGUOUS",
        };
      }
      if (receipt.state === "AMBIGUOUS") {
        const ambiguous = await this.options.repository.markFailed({
          executionToken: token,
          externalSupplierOrderId: receipt.supplierPurchaseReference,
          now: this.now(),
          operationId,
          reasonCode: "SUPPLIER_NETWORK_AMBIGUOUS",
          responseFingerprint: procurementResponseFingerprint(receipt),
          status: "AMBIGUOUS",
        });
        if (ambiguous) {
          await this.recordOrderResult(ambiguous, "AMBIGUOUS", correlationId);
        }
        return {
          operation: ambiguous ?? started,
          reasonCode: "SUPPLIER_NETWORK_AMBIGUOUS",
          status: "AMBIGUOUS",
        };
      }
      if (receipt.state === "OUT_OF_STOCK" || receipt.state === "REJECTED") {
        const terminal = await this.options.repository.markFailed({
          executionToken: token,
          externalSupplierOrderId: receipt.supplierPurchaseReference,
          now: this.now(),
          operationId,
          reasonCode: "SUPPLIER_REJECTED",
          responseFingerprint: procurementResponseFingerprint(receipt),
          status: "FAILED_TERMINAL",
        });
        if (terminal) {
          await this.recordOrderResult(
            terminal,
            "FAILED_TERMINAL",
            correlationId,
          );
        }
        return {
          operation: terminal ?? started,
          reasonCode: "SUPPLIER_REJECTED",
          status: "FAILED_TERMINAL",
        };
      }
      const succeeded = await this.options.repository.markSucceeded({
        acquisitionAmount:
          started.acquisitionAmount ??
          (() => {
            throw new Error("Procurement acquisition amount missing");
          })(),
        executionToken: token,
        externalSupplierOrderId: receipt.supplierPurchaseReference,
        normalizedSupplierStatus: receipt.state,
        now: this.now(),
        operationId,
        responseFingerprint: procurementResponseFingerprint(receipt),
      });
      if (!succeeded) {
        return {
          reasonCode: "SUPPLIER_NETWORK_AMBIGUOUS",
          status: "AMBIGUOUS",
        };
      }
      await this.recordOrderResult(succeeded, "SUCCEEDED", correlationId);
      await this.audit(
        succeeded,
        "PROCUREMENT_SUCCEEDED",
        "SUCCEEDED",
        "ORDER_CREATED",
      );
      return {
        operation: succeeded,
        reasonCode: "PROCUREMENT_DRY_RUN",
        status: "SUCCEEDED",
      };
    } catch (error) {
      const mapped = mapSupplierError(error);
      const failed = await this.options.repository.markFailed({
        executionToken: token,
        now: this.now(),
        operationId,
        reasonCode: mapped.reasonCode,
        status: mapped.status,
      });
      if (failed) {
        await this.recordOrderResult(failed, mapped.status, correlationId);
      }
      return {
        operation: failed ?? started,
        reasonCode: mapped.reasonCode,
        status: mapped.resultStatus,
      };
    }
  }

  public async reconcileOperation(input: {
    readonly operationId: string;
    readonly correlationId: CorrelationId;
  }): Promise<ProcurementResult> {
    const operation = await this.options.repository.findById(input.operationId);
    if (!operation) {
      return {
        reasonCode: "PROCUREMENT_RECONCILIATION_REQUIRED",
        status: "BLOCKED",
      };
    }
    if (!operation.externalSupplierOrderId) {
      return {
        operation,
        reasonCode: "PROCUREMENT_AMBIGUOUS",
        status: "AMBIGUOUS",
      };
    }
    const supplier = this.options.suppliers.resolve(operation.supplierId);
    const result = await supplier.reconcilePurchase(
      operation.externalSupplierOrderId,
    );
    const status =
      result.outcome === "RESOLVED"
        ? "SUCCEEDED"
        : result.outcome === "MANUAL_REVIEW_REQUIRED"
          ? "RECONCILIATION_REQUIRED"
          : "AMBIGUOUS";
    const updated = await this.options.repository.markReconciliation({
      now: this.now(),
      operationId: operation.id,
      reasonCode: result.reason ?? result.outcome,
      status,
    });
    if (updated && status === "SUCCEEDED") {
      await this.recordOrderResult(updated, "SUCCEEDED", input.correlationId);
    }
    return {
      operation: updated ?? operation,
      reasonCode:
        status === "SUCCEEDED"
          ? "PROCUREMENT_DRY_RUN"
          : status === "AMBIGUOUS"
            ? "PROCUREMENT_AMBIGUOUS"
            : "PROCUREMENT_RECONCILIATION_REQUIRED",
      status: status === "SUCCEEDED" ? "SUCCEEDED" : status,
    };
  }

  private procurementGate(
    order: KeyCoreOrder | null,
  ): ProcurementReasonCode | null {
    if (!order) {
      return "ORDER_NOT_PROCUREMENT_ELIGIBLE";
    }
    if (order.paymentStatus !== "CAPTURED") {
      return "PAYMENT_NOT_CAPTURED";
    }
    if (order.riskStatus !== "APPROVED") {
      return "RISK_NOT_APPROVED";
    }
    if (order.quantity !== 1) {
      return "ORDER_NOT_PROCUREMENT_ELIGIBLE";
    }
    if (
      ![
        "PAYMENT_CAPTURED",
        "PROCUREMENT_PENDING",
        "PROCUREMENT_IN_PROGRESS",
      ].includes(order.status)
    ) {
      return "ORDER_NOT_PROCUREMENT_ELIGIBLE";
    }
    return null;
  }

  private async blockingExistingOperation(
    orderIdValue: OrderId,
  ): Promise<ProcurementResult | null> {
    const operations = await this.options.repository.listByOrder(orderIdValue);
    if (operations.some((operation) => operation.status === "SUCCEEDED")) {
      const succeeded = operations.find(
        (operation) => operation.status === "SUCCEEDED",
      );
      return {
        ...(succeeded ? { operation: succeeded } : {}),
        reasonCode: "PROCUREMENT_ALREADY_SUCCEEDED",
        status: "BLOCKED",
      };
    }
    const ambiguous = operations.find((operation) =>
      ["AMBIGUOUS", "RECONCILIATION_REQUIRED"].includes(operation.status),
    );
    if (ambiguous) {
      return {
        operation: ambiguous,
        reasonCode: "PROCUREMENT_AMBIGUOUS",
        status: "AMBIGUOUS",
      };
    }
    const active = operations.find((operation) =>
      ["PENDING", "READY", "IN_FLIGHT"].includes(operation.status),
    );
    if (active) {
      return {
        operation: active,
        reasonCode: "PROCUREMENT_ALREADY_IN_FLIGHT",
        status: "IN_PROGRESS",
      };
    }
    return null;
  }

  private async selectProfitableCandidate(
    order: KeyCoreOrder,
    failedAttempts: readonly ProcurementOperation[],
  ): Promise<SupplierRoutingCandidate | null> {
    const lock = await this.options.priceLocks.validatePriceLock(
      order.priceLockId,
      order.correlationId,
    );
    if (lock.status !== "SAFE") {
      return null;
    }
    const selection = await this.options.routing.selectSupplier(
      { correlationId: order.correlationId, productId: order.productId },
      this.options.routingPolicy,
    );
    const candidates = selection.evaluatedCandidates.filter(
      (candidate) =>
        candidate.status === "ELIGIBLE" &&
        !failedAttempts.some(
          (attempt) =>
            attempt.status === "FAILED_TERMINAL" &&
            attempt.supplierId === candidate.supplierId &&
            attempt.supplierOfferId === candidate.supplierOfferId,
        ),
    );
    for (const candidate of candidates) {
      const pricing = await this.options.pricing.quoteProduct({
        correlationId: order.correlationId,
        eligibleOfferIds: [candidate.offer.offer.offerId],
        productId: order.productId,
      });
      const quote = pricing.selectedQuote;
      if (
        quote?.status === "QUOTED" &&
        quote.currency === order.currency &&
        order.customerAmount.amountMinor - quote.acquisitionCost.amountMinor >=
          (quote.hardMinimumProfit?.amountMinor ?? 0n)
      ) {
        return candidate;
      }
    }
    return null;
  }

  private async recordOrderResult(
    operation: ProcurementOperation,
    status: Extract<
      ProcurementOperationStatus,
      "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "AMBIGUOUS"
    >,
    correlationId: CorrelationId,
  ): Promise<void> {
    const order = await this.options.orders.getOrder(operation.orderId);
    if (!order) {
      return;
    }
    if (order.procurementStatus === "NOT_STARTED") {
      const pending = await this.options.orders.markProcurementPending({
        correlationId,
        expectedVersion: order.recordVersion,
        orderId: order.id,
      });
      if (pending.order) {
        await this.options.orders.beginProcurement({
          correlationId,
          expectedVersion: pending.order.recordVersion,
          orderId: order.id,
        });
      }
    }
    const current = await this.options.orders.getOrder(operation.orderId);
    if (!current || current.procurementStatus !== "IN_PROGRESS") {
      return;
    }
    await this.options.orders.recordProcurementResult({
      correlationId,
      expectedVersion: current.recordVersion,
      orderId: current.id,
      procurementStatus: status,
    });
  }

  private async audit(
    operation: ProcurementOperation,
    eventType: AuditEvent["eventType"],
    outcome: AuditEvent["outcome"],
    reasonCode: string,
  ): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "supplier-procurement", type: "SERVICE" },
      correlationId: operation.correlationId,
      entity: { id: operation.id, type: "PROCUREMENT_OPERATION" },
      environment: this.environment,
      eventType,
      metadata: procurementAuditMetadata(operation, reasonCode),
      outcome,
      reasonCode,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }
}

export const procurementOutboxPayload = (input: {
  readonly operation: ProcurementOperation;
  readonly reasonCode: string;
}): SafePayload => ({
  attemptGeneration: input.operation.attemptGeneration,
  correlationId: input.operation.correlationId,
  orderId: input.operation.orderId,
  procurementOperationId: input.operation.id,
  reasonCode: input.reasonCode,
  status: input.operation.status,
  supplierId: input.operation.supplierId,
});

export const procurementAuditMetadata = (
  operation: ProcurementOperation,
  reasonCode: string,
): AuditEvent["metadata"] => ({
  attemptGeneration: operation.attemptGeneration,
  correlationId: operation.correlationId,
  orderId: operation.orderId,
  procurementOperationId: operation.id,
  reasonCode,
  status: operation.status,
  supplierId: operation.supplierId,
});

export const procurementOrderLineId = (orderIdValue: OrderId): OrderLineId =>
  orderLineId(`procurement:${orderIdValue}`);

export const procurementIdempotencyReference = (input: {
  readonly orderId: OrderId;
  readonly supplierId: SupplierId;
  readonly generation: number;
}): IdempotencyKey =>
  idempotencyKey(
    `keycore:procurement:${input.orderId}:${input.supplierId}:g${input.generation}`,
  );

export const procurementResponseFingerprint = (
  receipt: PurchaseReceipt,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        acceptedAt: receipt.acceptedAt.toISOString(),
        reference: receipt.supplierPurchaseReference,
        state: receipt.state,
      }),
    )
    .digest("hex");

const validateReceipt = (receipt: PurchaseReceipt): boolean =>
  receipt.supplierPurchaseReference.trim().length > 0 &&
  Number.isFinite(receipt.acceptedAt.getTime());

const mapSupplierError = (
  error: unknown,
): {
  readonly status: Extract<
    ProcurementOperationStatus,
    "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "AMBIGUOUS"
  >;
  readonly resultStatus: ProcurementResult["status"];
  readonly reasonCode: ProcurementReasonCode;
} => {
  if (error instanceof SupplierError) {
    if (
      error.category === "OUT_OF_STOCK" ||
      error.category === "REJECTED" ||
      error.category === "NOT_FOUND"
    ) {
      return {
        reasonCode: "SUPPLIER_REJECTED",
        resultStatus: "FAILED_TERMINAL",
        status: "FAILED_TERMINAL",
      };
    }
    if (
      error.category === "AUTHENTICATION" ||
      error.category === "AUTHORIZATION"
    ) {
      return {
        reasonCode: "SUPPLIER_AUTHENTICATION_FAILED",
        resultStatus: "FAILED_RETRYABLE",
        status: "FAILED_RETRYABLE",
      };
    }
    if (error.category === "RATE_LIMIT") {
      return {
        reasonCode: "SUPPLIER_RATE_LIMITED",
        resultStatus: "FAILED_RETRYABLE",
        status: "FAILED_RETRYABLE",
      };
    }
  }
  return {
    reasonCode: "SUPPLIER_NETWORK_AMBIGUOUS",
    resultStatus: "AMBIGUOUS",
    status: "AMBIGUOUS",
  };
};
