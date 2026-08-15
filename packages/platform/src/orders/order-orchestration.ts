import { createHash, randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type { Money } from "../domain/money.js";
import type {
  CorrelationId,
  ProductId,
  OrderId,
} from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import type { PriceLock, PriceLockService } from "../pricing/price-locks.js";
import type { SafePayload } from "../queue/job.js";

export type OrderStatus =
  | "CREATED"
  | "AWAITING_PAYMENT"
  | "PAYMENT_AUTHORIZED"
  | "PAYMENT_CAPTURED"
  | "PROCUREMENT_PENDING"
  | "PROCUREMENT_IN_PROGRESS"
  | "FULFILLMENT_PENDING"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED"
  | "REFUND_PENDING"
  | "REFUNDED"
  | "MANUAL_REVIEW";

export type OrderPaymentStatus =
  | "NOT_STARTED"
  | "PENDING"
  | "AUTHORIZED"
  | "CAPTURED"
  | "FAILED"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED";

export type OrderProcurementStatus =
  | "NOT_STARTED"
  | "PENDING"
  | "IN_PROGRESS"
  | "SUCCEEDED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL"
  | "AMBIGUOUS";

export type OrderFulfillmentStatus =
  "NOT_STARTED" | "PENDING" | "SUCCEEDED" | "FAILED" | "MANUAL_REVIEW";

export type OrderRiskStatus =
  "NOT_EVALUATED" | "APPROVED" | "REVIEW_REQUIRED" | "REJECTED";

export type OrderRefundStatus =
  "NOT_REQUESTED" | "PENDING" | "SUCCEEDED" | "FAILED" | "MANUAL_REVIEW";

export const orderReasonCodes = [
  "ORDER_CREATED",
  "ORDER_IDEMPOTENT_REPLAY",
  "ORDER_IDEMPOTENCY_CONFLICT",
  "PRICE_LOCK_NOT_FOUND",
  "PRICE_LOCK_EXPIRED",
  "PRICE_LOCK_CONSUMED",
  "PRICE_LOCK_UNSAFE",
  "PRICE_LOCK_MISMATCH",
  "UNSUPPORTED_QUANTITY",
  "INVALID_ORDER_TRANSITION",
  "PAYMENT_NOT_ELIGIBLE_FOR_PROCUREMENT",
  "RISK_NOT_APPROVED",
  "PROCUREMENT_AMBIGUOUS",
  "PROCUREMENT_FAILED_RETRYABLE",
  "PROCUREMENT_FAILED_TERMINAL",
  "FULFILLMENT_FAILED",
  "REFUND_FAILED",
  "OPTIMISTIC_CONCURRENCY_CONFLICT",
  "EXTERNAL_EVENT_CONFLICT",
  "EXTERNAL_EVENT_DEDUPLICATED",
  "MANUAL_REVIEW_REQUIRED",
] as const;

export type OrderReasonCode = (typeof orderReasonCodes)[number];

export interface KeyCoreOrder {
  readonly id: OrderId;
  readonly productId: ProductId;
  readonly priceLockId: string;
  readonly customerAmount: Money;
  readonly currency: Money["currency"];
  readonly quantity: number;
  readonly status: OrderStatus;
  readonly paymentStatus: OrderPaymentStatus;
  readonly procurementStatus: OrderProcurementStatus;
  readonly fulfillmentStatus: OrderFulfillmentStatus;
  readonly riskStatus: OrderRiskStatus;
  readonly refundStatus: OrderRefundStatus;
  readonly recordVersion: number;
  readonly correlationId: CorrelationId;
  readonly idempotencyKey: string;
  readonly idempotencyFingerprint: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OrderTransitionHistoryEntry {
  readonly id: string;
  readonly orderId: OrderId;
  readonly fromStatus: OrderStatus | null;
  readonly toStatus: OrderStatus;
  readonly fromPaymentStatus?: OrderPaymentStatus | null;
  readonly toPaymentStatus?: OrderPaymentStatus | null;
  readonly fromProcurementStatus?: OrderProcurementStatus | null;
  readonly toProcurementStatus?: OrderProcurementStatus | null;
  readonly fromFulfillmentStatus?: OrderFulfillmentStatus | null;
  readonly toFulfillmentStatus?: OrderFulfillmentStatus | null;
  readonly fromRiskStatus?: OrderRiskStatus | null;
  readonly toRiskStatus?: OrderRiskStatus | null;
  readonly fromRefundStatus?: OrderRefundStatus | null;
  readonly toRefundStatus?: OrderRefundStatus | null;
  readonly reasonCode: OrderReasonCode;
  readonly correlationId: CorrelationId;
  readonly actorType: "CUSTOMER" | "ADMIN" | "SYSTEM" | "SERVICE";
  readonly occurredAt: Date;
}

export interface ExternalEventReceipt {
  readonly provider: string;
  readonly externalEventId: string;
  readonly eventType: string;
  readonly eventFingerprint: string;
  readonly orderId?: OrderId | null;
  readonly correlationId: CorrelationId;
  readonly receivedAt: Date;
}

export interface OrderOutboxEvent {
  readonly eventType: string;
  readonly aggregateType: "ORDER";
  readonly aggregateId: OrderId;
  readonly payload: SafePayload;
  readonly correlationId: CorrelationId;
  readonly eventDeduplicationKey: string;
}

export type OrderCreatePersistenceResult =
  | { readonly status: "CREATED"; readonly order: KeyCoreOrder }
  | { readonly status: "EXISTING_SAME"; readonly order: KeyCoreOrder }
  | { readonly status: "EXISTING_CONFLICT"; readonly order: KeyCoreOrder }
  | { readonly status: "PRICE_LOCK_UNAVAILABLE" };

export type OrderTransitionPersistenceResult =
  | { readonly status: "UPDATED"; readonly order: KeyCoreOrder }
  | { readonly status: "CONFLICT"; readonly currentOrder: KeyCoreOrder | null };

export type ExternalEventReceiptPersistenceResult =
  | { readonly status: "RECORDED"; readonly receipt: ExternalEventReceipt }
  | { readonly status: "DUPLICATE"; readonly receipt: ExternalEventReceipt }
  | { readonly status: "CONFLICT"; readonly receipt: ExternalEventReceipt };

export interface OrderRepository {
  createFromActivePriceLock(input: {
    readonly order: KeyCoreOrder;
    readonly priceLock: PriceLock;
    readonly history: OrderTransitionHistoryEntry;
    readonly outbox: OrderOutboxEvent;
    readonly now: Date;
  }): Promise<OrderCreatePersistenceResult>;
  findById(orderId: OrderId): Promise<KeyCoreOrder | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<KeyCoreOrder | null>;
  updateState(input: {
    readonly orderId: OrderId;
    readonly expectedVersion: number;
    readonly next: OrderStatePatch;
    readonly history: OrderTransitionHistoryEntry;
    readonly outbox?: OrderOutboxEvent;
    readonly now: Date;
  }): Promise<OrderTransitionPersistenceResult>;
  recordExternalEvent(
    receipt: ExternalEventReceipt,
  ): Promise<ExternalEventReceiptPersistenceResult>;
  listHistory(
    orderId: OrderId,
  ): Promise<readonly OrderTransitionHistoryEntry[]>;
}

export interface OrderStatePatch {
  readonly status?: OrderStatus;
  readonly paymentStatus?: OrderPaymentStatus;
  readonly procurementStatus?: OrderProcurementStatus;
  readonly fulfillmentStatus?: OrderFulfillmentStatus;
  readonly riskStatus?: OrderRiskStatus;
  readonly refundStatus?: OrderRefundStatus;
}

export interface OrderCreateResult {
  readonly status: "CREATED" | "IDEMPOTENT" | "CONFLICT" | "BLOCKED";
  readonly order?: KeyCoreOrder;
  readonly reasonCode: OrderReasonCode;
}

export interface OrderTransitionResult {
  readonly status: "UPDATED" | "IDEMPOTENT" | "CONFLICT" | "BLOCKED";
  readonly order?: KeyCoreOrder;
  readonly reasonCode: OrderReasonCode;
}

export interface ExternalEventResult {
  readonly status: "RECORDED" | "DUPLICATE" | "CONFLICT";
  readonly reasonCode?: OrderReasonCode;
}

export interface OrderOrchestrationServiceOptions {
  readonly repository: OrderRepository;
  readonly priceLocks: PriceLockService;
  readonly audit?: AuditEventPort;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
}

export class OrderOrchestrationService {
  private readonly now: () => Date;
  private readonly environment: AuditEvent["environment"];

  public constructor(
    private readonly options: OrderOrchestrationServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.environment = options.environment ?? "LOCAL";
  }

  public async createOrder(input: {
    readonly productId: ProductId;
    readonly priceLockId: string;
    readonly quantity: number;
    readonly idempotencyKey: string;
    readonly correlationId: CorrelationId;
    readonly expectedCustomerAmount?: Money;
    readonly expectedCurrency?: Money["currency"];
  }): Promise<OrderCreateResult> {
    const now = this.now();
    if (input.quantity !== 1) {
      return { reasonCode: "UNSUPPORTED_QUANTITY", status: "BLOCKED" };
    }
    if (input.idempotencyKey.trim().length === 0) {
      return { reasonCode: "ORDER_IDEMPOTENCY_CONFLICT", status: "BLOCKED" };
    }

    const lock = await this.options.priceLocks.getPriceLock(input.priceLockId);
    if (!lock) {
      return { reasonCode: "PRICE_LOCK_NOT_FOUND", status: "BLOCKED" };
    }
    const mismatch = validatePriceLockCommercialMatch(input, lock);
    const fingerprint = orderIdempotencyFingerprint({
      expectedCustomerAmount:
        input.expectedCustomerAmount ?? lock.lockedSellPrice,
      expectedCurrency: input.expectedCurrency ?? lock.currency,
      priceLockId: input.priceLockId,
      productId: input.productId,
      quantity: input.quantity,
    });
    const existing = await this.options.repository.findByIdempotencyKey(
      input.idempotencyKey,
    );
    if (existing) {
      if (existing.idempotencyFingerprint === fingerprint) {
        return {
          order: existing,
          reasonCode: "ORDER_IDEMPOTENT_REPLAY",
          status: "IDEMPOTENT",
        };
      }
      return {
        order: existing,
        reasonCode: "ORDER_IDEMPOTENCY_CONFLICT",
        status: "CONFLICT",
      };
    }
    if (mismatch) {
      return { reasonCode: mismatch, status: "BLOCKED" };
    }

    const validation = await this.options.priceLocks.validatePriceLock(
      input.priceLockId,
      input.correlationId,
    );
    if (validation.status !== "SAFE") {
      const replay = await this.findIdempotentReplay(
        input.idempotencyKey,
        fingerprint,
      );
      if (replay) {
        return replay;
      }
      return {
        reasonCode:
          validation.status === "EXPIRED"
            ? "PRICE_LOCK_EXPIRED"
            : validation.status === "CONSUMED"
              ? "PRICE_LOCK_CONSUMED"
              : "PRICE_LOCK_UNSAFE",
        status: "BLOCKED",
      };
    }

    const order = createInitialOrder({
      correlationId: input.correlationId,
      idempotencyFingerprint: fingerprint,
      idempotencyKey: input.idempotencyKey,
      lock,
      now,
      quantity: input.quantity,
    });
    const result = await this.options.repository.createFromActivePriceLock({
      history: historyEntry({
        correlationId: input.correlationId,
        from: null,
        next: order,
        now,
        reasonCode: "ORDER_CREATED",
      }),
      now,
      order,
      outbox: outboxEvent(order, "order.created", "created"),
      priceLock: lock,
    });

    if (result.status === "EXISTING_SAME") {
      return {
        order: result.order,
        reasonCode: "ORDER_IDEMPOTENT_REPLAY",
        status: "IDEMPOTENT",
      };
    }
    if (result.status === "EXISTING_CONFLICT") {
      return {
        order: result.order,
        reasonCode: "ORDER_IDEMPOTENCY_CONFLICT",
        status: "CONFLICT",
      };
    }
    if (result.status === "PRICE_LOCK_UNAVAILABLE") {
      const replay = await this.findIdempotentReplay(
        input.idempotencyKey,
        fingerprint,
      );
      if (replay) {
        return replay;
      }
      return { reasonCode: "PRICE_LOCK_CONSUMED", status: "CONFLICT" };
    }

    await this.auditOrder(result.order, "ORDER_CREATED", "SUCCEEDED");
    return {
      order: result.order,
      reasonCode: "ORDER_CREATED",
      status: "CREATED",
    };
  }

  public getOrder(orderId: OrderId): Promise<KeyCoreOrder | null> {
    return this.options.repository.findById(orderId);
  }

  public async markAwaitingPayment(input: {
    readonly orderId: OrderId;
    readonly expectedVersion: number;
    readonly correlationId: CorrelationId;
  }): Promise<OrderTransitionResult> {
    return this.transition({
      correlationId: input.correlationId,
      expectedVersion: input.expectedVersion,
      orderId: input.orderId,
      patch: { paymentStatus: "PENDING", status: "AWAITING_PAYMENT" },
      reasonCode: "ORDER_CREATED",
    });
  }

  public async transitionPayment(input: {
    readonly orderId: OrderId;
    readonly expectedVersion: number;
    readonly paymentStatus: Extract<
      OrderPaymentStatus,
      "AUTHORIZED" | "CAPTURED" | "FAILED" | "CANCELLED"
    >;
    readonly correlationId: CorrelationId;
  }): Promise<OrderTransitionResult> {
    const statusByPayment = {
      AUTHORIZED: "PAYMENT_AUTHORIZED",
      CANCELLED: "CANCELLED",
      CAPTURED: "PAYMENT_CAPTURED",
      FAILED: "FAILED",
    } as const satisfies Record<typeof input.paymentStatus, OrderStatus>;
    return this.transition({
      correlationId: input.correlationId,
      expectedVersion: input.expectedVersion,
      orderId: input.orderId,
      patch: {
        paymentStatus: input.paymentStatus,
        status: statusByPayment[input.paymentStatus],
      },
      reasonCode:
        input.paymentStatus === "FAILED"
          ? "PAYMENT_NOT_ELIGIBLE_FOR_PROCUREMENT"
          : "ORDER_CREATED",
    });
  }

  public async markRisk(input: {
    readonly orderId: OrderId;
    readonly expectedVersion: number;
    readonly riskStatus: OrderRiskStatus;
    readonly correlationId: CorrelationId;
  }): Promise<OrderTransitionResult> {
    return this.transition({
      correlationId: input.correlationId,
      expectedVersion: input.expectedVersion,
      orderId: input.orderId,
      patch:
        input.riskStatus === "REVIEW_REQUIRED" ||
        input.riskStatus === "REJECTED"
          ? { riskStatus: input.riskStatus, status: "MANUAL_REVIEW" }
          : { riskStatus: input.riskStatus },
      reasonCode:
        input.riskStatus === "APPROVED" ? "ORDER_CREATED" : "RISK_NOT_APPROVED",
    });
  }

  public async markProcurementPending(input: {
    readonly orderId: OrderId;
    readonly expectedVersion: number;
    readonly correlationId: CorrelationId;
  }): Promise<OrderTransitionResult> {
    const order = await this.options.repository.findById(input.orderId);
    if (!order) {
      return {
        reasonCode: "INVALID_ORDER_TRANSITION",
        status: "BLOCKED",
      };
    }
    const gate = procurementGate(order);
    if (gate) {
      return { reasonCode: gate, status: "BLOCKED" };
    }
    return this.transition({
      correlationId: input.correlationId,
      expectedVersion: input.expectedVersion,
      orderId: input.orderId,
      patch: { procurementStatus: "PENDING", status: "PROCUREMENT_PENDING" },
      reasonCode: "ORDER_CREATED",
    });
  }

  public async beginProcurement(input: {
    readonly orderId: OrderId;
    readonly expectedVersion: number;
    readonly correlationId: CorrelationId;
  }): Promise<OrderTransitionResult> {
    const order = await this.options.repository.findById(input.orderId);
    if (!order) {
      return { reasonCode: "INVALID_ORDER_TRANSITION", status: "BLOCKED" };
    }
    const gate = procurementGate(order);
    if (gate) {
      return { reasonCode: gate, status: "BLOCKED" };
    }
    return this.transition({
      correlationId: input.correlationId,
      expectedVersion: input.expectedVersion,
      orderId: input.orderId,
      patch: {
        procurementStatus: "IN_PROGRESS",
        status: "PROCUREMENT_IN_PROGRESS",
      },
      reasonCode: "ORDER_CREATED",
      outboxType: "order.procurement.requested",
    });
  }

  public async recordProcurementResult(input: {
    readonly orderId: OrderId;
    readonly expectedVersion: number;
    readonly procurementStatus: Extract<
      OrderProcurementStatus,
      "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "AMBIGUOUS"
    >;
    readonly correlationId: CorrelationId;
  }): Promise<OrderTransitionResult> {
    const patchByStatus = {
      AMBIGUOUS: {
        procurementStatus: "AMBIGUOUS",
        status: "MANUAL_REVIEW",
      },
      FAILED_RETRYABLE: {
        procurementStatus: "FAILED_RETRYABLE",
        status: "MANUAL_REVIEW",
      },
      FAILED_TERMINAL: {
        procurementStatus: "FAILED_TERMINAL",
        status: "FAILED",
      },
      SUCCEEDED: {
        procurementStatus: "SUCCEEDED",
        status: "FULFILLMENT_PENDING",
      },
    } as const;
    const reasonByStatus = {
      AMBIGUOUS: "PROCUREMENT_AMBIGUOUS",
      FAILED_RETRYABLE: "PROCUREMENT_FAILED_RETRYABLE",
      FAILED_TERMINAL: "PROCUREMENT_FAILED_TERMINAL",
      SUCCEEDED: "ORDER_CREATED",
    } as const satisfies Record<
      typeof input.procurementStatus,
      OrderReasonCode
    >;
    return this.transition({
      correlationId: input.correlationId,
      expectedVersion: input.expectedVersion,
      orderId: input.orderId,
      patch: patchByStatus[input.procurementStatus],
      reasonCode: reasonByStatus[input.procurementStatus],
      ...(input.procurementStatus === "SUCCEEDED"
        ? { outboxType: "order.fulfillment.requested" }
        : input.procurementStatus === "AMBIGUOUS"
          ? { outboxType: "order.reconciliation.requested" }
          : {}),
    });
  }

  public async markFulfillmentPending(input: {
    readonly orderId: OrderId;
    readonly expectedVersion: number;
    readonly correlationId: CorrelationId;
  }): Promise<OrderTransitionResult> {
    return this.transition({
      correlationId: input.correlationId,
      expectedVersion: input.expectedVersion,
      orderId: input.orderId,
      patch: { fulfillmentStatus: "PENDING", status: "FULFILLMENT_PENDING" },
      reasonCode: "ORDER_CREATED",
      outboxType: "order.fulfillment.requested",
    });
  }

  public async recordFulfillmentResult(input: {
    readonly orderId: OrderId;
    readonly expectedVersion: number;
    readonly fulfillmentStatus: Extract<
      OrderFulfillmentStatus,
      "SUCCEEDED" | "FAILED" | "MANUAL_REVIEW"
    >;
    readonly correlationId: CorrelationId;
  }): Promise<OrderTransitionResult> {
    return this.transition({
      correlationId: input.correlationId,
      expectedVersion: input.expectedVersion,
      orderId: input.orderId,
      patch:
        input.fulfillmentStatus === "SUCCEEDED"
          ? { fulfillmentStatus: "SUCCEEDED", status: "COMPLETED" }
          : {
              fulfillmentStatus: input.fulfillmentStatus,
              status: "MANUAL_REVIEW",
            },
      reasonCode:
        input.fulfillmentStatus === "SUCCEEDED"
          ? "ORDER_CREATED"
          : "FULFILLMENT_FAILED",
    });
  }

  public async requestRefund(input: {
    readonly orderId: OrderId;
    readonly expectedVersion: number;
    readonly correlationId: CorrelationId;
  }): Promise<OrderTransitionResult> {
    return this.transition({
      correlationId: input.correlationId,
      expectedVersion: input.expectedVersion,
      orderId: input.orderId,
      patch: { refundStatus: "PENDING", status: "REFUND_PENDING" },
      reasonCode: "ORDER_CREATED",
      outboxType: "order.refund.requested",
    });
  }

  public async recordRefundResult(input: {
    readonly orderId: OrderId;
    readonly expectedVersion: number;
    readonly refundStatus: Extract<
      OrderRefundStatus,
      "SUCCEEDED" | "FAILED" | "MANUAL_REVIEW"
    >;
    readonly correlationId: CorrelationId;
  }): Promise<OrderTransitionResult> {
    return this.transition({
      correlationId: input.correlationId,
      expectedVersion: input.expectedVersion,
      orderId: input.orderId,
      patch:
        input.refundStatus === "SUCCEEDED"
          ? {
              paymentStatus: "REFUNDED",
              refundStatus: "SUCCEEDED",
              status: "REFUNDED",
            }
          : {
              refundStatus: input.refundStatus,
              status: "MANUAL_REVIEW",
            },
      reasonCode:
        input.refundStatus === "SUCCEEDED" ? "ORDER_CREATED" : "REFUND_FAILED",
    });
  }

  public async markManualReview(input: {
    readonly orderId: OrderId;
    readonly expectedVersion: number;
    readonly correlationId: CorrelationId;
  }): Promise<OrderTransitionResult> {
    return this.transition({
      correlationId: input.correlationId,
      expectedVersion: input.expectedVersion,
      orderId: input.orderId,
      patch: { status: "MANUAL_REVIEW" },
      reasonCode: "MANUAL_REVIEW_REQUIRED",
      outboxType: "order.reconciliation.requested",
    });
  }

  public async recordExternalEvent(
    receipt: Omit<ExternalEventReceipt, "receivedAt">,
  ): Promise<ExternalEventResult> {
    const result = await this.options.repository.recordExternalEvent({
      ...receipt,
      receivedAt: this.now(),
    });
    if (result.status === "CONFLICT") {
      return { reasonCode: "EXTERNAL_EVENT_CONFLICT", status: "CONFLICT" };
    }
    if (result.status === "DUPLICATE") {
      await this.auditExternalEvent(
        receipt,
        "ORDER_EXTERNAL_EVENT_DEDUPLICATED",
      );
      return {
        reasonCode: "EXTERNAL_EVENT_DEDUPLICATED",
        status: "DUPLICATE",
      };
    }
    return { status: "RECORDED" };
  }

  private async transition(input: {
    readonly orderId: OrderId;
    readonly expectedVersion: number;
    readonly patch: OrderStatePatch;
    readonly reasonCode: OrderReasonCode;
    readonly correlationId: CorrelationId;
    readonly outboxType?: string;
  }): Promise<OrderTransitionResult> {
    const current = await this.options.repository.findById(input.orderId);
    if (!current) {
      return { reasonCode: "INVALID_ORDER_TRANSITION", status: "BLOCKED" };
    }
    const next = nextOrderState(current, input.patch);
    if (!isAllowedTransition(current, next)) {
      return {
        order: current,
        reasonCode: "INVALID_ORDER_TRANSITION",
        status: "BLOCKED",
      };
    }
    const invariant = validateOrderStateInvariants(next);
    if (invariant) {
      return { order: current, reasonCode: invariant, status: "BLOCKED" };
    }
    const result = await this.options.repository.updateState({
      expectedVersion: input.expectedVersion,
      history: historyEntry({
        correlationId: input.correlationId,
        from: current,
        next,
        now: this.now(),
        reasonCode: input.reasonCode,
      }),
      now: this.now(),
      orderId: input.orderId,
      ...(input.outboxType
        ? { outbox: outboxEvent(next, input.outboxType, input.reasonCode) }
        : {}),
      next: {
        fulfillmentStatus: next.fulfillmentStatus,
        paymentStatus: next.paymentStatus,
        procurementStatus: next.procurementStatus,
        refundStatus: next.refundStatus,
        riskStatus: next.riskStatus,
        status: next.status,
      },
    });
    if (result.status === "CONFLICT") {
      return {
        ...(result.currentOrder ? { order: result.currentOrder } : {}),
        reasonCode: "OPTIMISTIC_CONCURRENCY_CONFLICT",
        status: "CONFLICT",
      };
    }
    await this.auditOrder(result.order, eventTypeFor(input.patch), "SUCCEEDED");
    return {
      order: result.order,
      reasonCode: input.reasonCode,
      status: "UPDATED",
    };
  }

  private async findIdempotentReplay(
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<OrderCreateResult | null> {
    const existing =
      await this.options.repository.findByIdempotencyKey(idempotencyKey);
    if (!existing) {
      return null;
    }
    return existing.idempotencyFingerprint === fingerprint
      ? {
          order: existing,
          reasonCode: "ORDER_IDEMPOTENT_REPLAY",
          status: "IDEMPOTENT",
        }
      : {
          order: existing,
          reasonCode: "ORDER_IDEMPOTENCY_CONFLICT",
          status: "CONFLICT",
        };
  }

  private async auditOrder(
    order: KeyCoreOrder,
    eventType: AuditEvent["eventType"],
    outcome: AuditEvent["outcome"],
  ): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "order-orchestration-service", type: "SERVICE" },
      correlationId: order.correlationId,
      entity: { id: order.id, type: "ORDER" },
      environment: this.environment,
      eventType,
      metadata: {
        correlationId: order.correlationId,
        orderId: order.id,
        priceLockId: order.priceLockId,
        productId: order.productId,
        status: order.status,
      },
      outcome,
      reasonCode: "ORDER_CREATED",
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }

  private async auditExternalEvent(
    receipt: Omit<ExternalEventReceipt, "receivedAt">,
    eventType: AuditEvent["eventType"],
  ): Promise<void> {
    await this.options.audit?.append({
      actor: { id: receipt.provider, type: "SERVICE" },
      correlationId: receipt.correlationId,
      entity: { id: receipt.orderId ?? receipt.externalEventId, type: "ORDER" },
      environment: this.environment,
      eventType,
      metadata: {
        correlationId: receipt.correlationId,
        eventType: receipt.eventType,
        externalEventId: receipt.externalEventId,
        provider: receipt.provider,
      },
      outcome: "SUCCEEDED",
      reasonCode: "EXTERNAL_EVENT_DEDUPLICATED",
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }
}

export const orderIdempotencyFingerprint = (input: {
  readonly productId: ProductId;
  readonly priceLockId: string;
  readonly quantity: number;
  readonly expectedCustomerAmount: Money;
  readonly expectedCurrency: Money["currency"];
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        amountMinor: input.expectedCustomerAmount.amountMinor.toString(),
        currency: input.expectedCurrency,
        priceLockId: input.priceLockId,
        productId: input.productId,
        quantity: input.quantity,
      }),
    )
    .digest("hex");

export const orderOutboxPayload = (input: {
  readonly order: KeyCoreOrder;
  readonly reasonCode: string;
}): SafePayload => ({
  correlationId: input.order.correlationId,
  orderId: input.order.id,
  priceLockId: input.order.priceLockId,
  productId: input.order.productId,
  reasonCode: input.reasonCode,
  status: input.order.status,
});

export const reconciliationOutboxPayload = (input: {
  readonly order: KeyCoreOrder;
  readonly reasonCode: OrderReasonCode;
}): SafePayload => ({
  correlationId: input.order.correlationId,
  orderId: input.order.id,
  reasonCode: input.reasonCode,
  status: input.order.status,
});

export const procurementEligiblePaymentStates: readonly OrderPaymentStatus[] = [
  "CAPTURED",
];

const createInitialOrder = (input: {
  readonly lock: PriceLock;
  readonly quantity: number;
  readonly idempotencyKey: string;
  readonly idempotencyFingerprint: string;
  readonly correlationId: CorrelationId;
  readonly now: Date;
}): KeyCoreOrder => ({
  correlationId: input.correlationId,
  createdAt: input.now,
  currency: input.lock.currency,
  customerAmount: input.lock.lockedSellPrice,
  fulfillmentStatus: "NOT_STARTED",
  id: randomUUID() as OrderId,
  idempotencyFingerprint: input.idempotencyFingerprint,
  idempotencyKey: input.idempotencyKey,
  paymentStatus: "NOT_STARTED",
  priceLockId: input.lock.id,
  procurementStatus: "NOT_STARTED",
  productId: input.lock.productId,
  quantity: input.quantity,
  recordVersion: 1,
  refundStatus: "NOT_REQUESTED",
  riskStatus: "NOT_EVALUATED",
  status: "CREATED",
  updatedAt: input.now,
});

const validatePriceLockCommercialMatch = (
  input: {
    readonly productId: ProductId;
    readonly expectedCustomerAmount?: Money;
    readonly expectedCurrency?: Money["currency"];
  },
  lock: PriceLock,
): OrderReasonCode | null => {
  if (lock.productId !== input.productId) {
    return "PRICE_LOCK_MISMATCH";
  }
  if (
    input.expectedCurrency !== undefined &&
    input.expectedCurrency !== lock.currency
  ) {
    return "PRICE_LOCK_MISMATCH";
  }
  if (
    input.expectedCustomerAmount !== undefined &&
    (input.expectedCustomerAmount.currency !== lock.currency ||
      input.expectedCustomerAmount.amountMinor !==
        lock.lockedSellPrice.amountMinor)
  ) {
    return "PRICE_LOCK_MISMATCH";
  }
  return null;
};

const allowedTransitions: Readonly<
  Record<OrderStatus, readonly OrderStatus[]>
> = {
  AWAITING_PAYMENT: [
    "PAYMENT_AUTHORIZED",
    "PAYMENT_CAPTURED",
    "CANCELLED",
    "FAILED",
    "MANUAL_REVIEW",
  ],
  CANCELLED: [],
  COMPLETED: ["REFUND_PENDING"],
  CREATED: ["AWAITING_PAYMENT", "MANUAL_REVIEW"],
  FAILED: ["MANUAL_REVIEW"],
  FULFILLMENT_PENDING: ["COMPLETED", "MANUAL_REVIEW"],
  MANUAL_REVIEW: ["PROCUREMENT_PENDING", "REFUND_PENDING", "FAILED"],
  PAYMENT_AUTHORIZED: ["PAYMENT_CAPTURED", "CANCELLED", "MANUAL_REVIEW"],
  PAYMENT_CAPTURED: ["PROCUREMENT_PENDING", "MANUAL_REVIEW"],
  PROCUREMENT_IN_PROGRESS: ["FULFILLMENT_PENDING", "MANUAL_REVIEW", "FAILED"],
  PROCUREMENT_PENDING: ["PROCUREMENT_IN_PROGRESS", "MANUAL_REVIEW"],
  REFUND_PENDING: ["REFUNDED", "MANUAL_REVIEW"],
  REFUNDED: [],
};

export const isAllowedTransition = (
  current: KeyCoreOrder,
  next: KeyCoreOrder,
): boolean =>
  current.id === next.id &&
  (current.status === next.status ||
    (allowedTransitions[current.status] ?? []).includes(next.status));

export const validateOrderStateInvariants = (
  order: KeyCoreOrder,
): OrderReasonCode | null => {
  if (
    (order.procurementStatus === "PENDING" ||
      order.procurementStatus === "IN_PROGRESS") &&
    !procurementEligiblePaymentStates.includes(order.paymentStatus)
  ) {
    return "PAYMENT_NOT_ELIGIBLE_FOR_PROCUREMENT";
  }
  if (
    (order.procurementStatus === "PENDING" ||
      order.procurementStatus === "IN_PROGRESS") &&
    order.riskStatus !== "APPROVED"
  ) {
    return "RISK_NOT_APPROVED";
  }
  if (
    order.fulfillmentStatus === "SUCCEEDED" &&
    order.procurementStatus !== "SUCCEEDED"
  ) {
    return "INVALID_ORDER_TRANSITION";
  }
  return null;
};

const procurementGate = (order: KeyCoreOrder): OrderReasonCode | null => {
  if (!procurementEligiblePaymentStates.includes(order.paymentStatus)) {
    return "PAYMENT_NOT_ELIGIBLE_FOR_PROCUREMENT";
  }
  if (order.riskStatus !== "APPROVED") {
    return "RISK_NOT_APPROVED";
  }
  return null;
};

const nextOrderState = (
  order: KeyCoreOrder,
  patch: OrderStatePatch,
): KeyCoreOrder => ({
  ...order,
  fulfillmentStatus: patch.fulfillmentStatus ?? order.fulfillmentStatus,
  paymentStatus: patch.paymentStatus ?? order.paymentStatus,
  procurementStatus: patch.procurementStatus ?? order.procurementStatus,
  refundStatus: patch.refundStatus ?? order.refundStatus,
  riskStatus: patch.riskStatus ?? order.riskStatus,
  status: patch.status ?? order.status,
  updatedAt: new Date(order.updatedAt),
});

const historyEntry = (input: {
  readonly from: KeyCoreOrder | null;
  readonly next: KeyCoreOrder;
  readonly reasonCode: OrderReasonCode;
  readonly correlationId: CorrelationId;
  readonly now: Date;
}): OrderTransitionHistoryEntry => ({
  actorType: "SERVICE",
  correlationId: input.correlationId,
  fromFulfillmentStatus: input.from?.fulfillmentStatus ?? null,
  fromPaymentStatus: input.from?.paymentStatus ?? null,
  fromProcurementStatus: input.from?.procurementStatus ?? null,
  fromRefundStatus: input.from?.refundStatus ?? null,
  fromRiskStatus: input.from?.riskStatus ?? null,
  fromStatus: input.from?.status ?? null,
  id: randomUUID(),
  occurredAt: input.now,
  orderId: input.next.id,
  reasonCode: input.reasonCode,
  toFulfillmentStatus: input.next.fulfillmentStatus,
  toPaymentStatus: input.next.paymentStatus,
  toProcurementStatus: input.next.procurementStatus,
  toRefundStatus: input.next.refundStatus,
  toRiskStatus: input.next.riskStatus,
  toStatus: input.next.status,
});

const outboxEvent = (
  order: KeyCoreOrder,
  eventType: string,
  reasonCode: string,
): OrderOutboxEvent => ({
  aggregateId: order.id,
  aggregateType: "ORDER",
  correlationId: order.correlationId,
  eventDeduplicationKey: `${eventType}:${order.id}:${order.recordVersion}`,
  eventType,
  payload:
    eventType === "order.reconciliation.requested"
      ? reconciliationOutboxPayload({
          order,
          reasonCode: reasonCode as OrderReasonCode,
        })
      : orderOutboxPayload({ order, reasonCode }),
});

const eventTypeFor = (patch: OrderStatePatch): AuditEvent["eventType"] => {
  if (patch.paymentStatus) {
    return "ORDER_PAYMENT_STATE_CHANGED";
  }
  if (patch.riskStatus) {
    return "ORDER_RISK_STATE_CHANGED";
  }
  if (patch.procurementStatus) {
    return "ORDER_PROCUREMENT_STATE_CHANGED";
  }
  if (patch.fulfillmentStatus) {
    return "ORDER_FULFILLMENT_STATE_CHANGED";
  }
  if (patch.refundStatus) {
    return "ORDER_REFUND_STATE_CHANGED";
  }
  return patch.status === "MANUAL_REVIEW"
    ? "ORDER_MANUAL_REVIEW_REQUIRED"
    : "ORDER_STATE_CHANGED";
};
