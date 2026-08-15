import type {
  ExternalEventReceipt,
  ExternalEventReceiptPersistenceResult,
  KeyCoreOrder,
  OrderCreatePersistenceResult,
  OrderRepository,
  OrderTransitionHistoryEntry,
  OrderTransitionPersistenceResult,
} from "../../packages/platform/src/orders/order-orchestration.js";
import type { OrderId } from "../../packages/platform/src/domain/identifiers.js";

export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<string, KeyCoreOrder>();
  private readonly idempotencyKeys = new Map<string, string>();
  private readonly lockOwners = new Map<string, string>();
  private readonly history = new Map<string, OrderTransitionHistoryEntry[]>();
  private readonly receipts = new Map<string, ExternalEventReceipt>();

  public async createFromActivePriceLock(input: {
    readonly order: KeyCoreOrder;
    readonly history: OrderTransitionHistoryEntry;
    readonly now: Date;
  }): Promise<OrderCreatePersistenceResult> {
    const existingOrderId = this.idempotencyKeys.get(
      input.order.idempotencyKey,
    );
    if (existingOrderId) {
      const existing = this.orders.get(existingOrderId);
      if (!existing) {
        throw new Error("Order idempotency index is corrupt");
      }
      return existing.idempotencyFingerprint ===
        input.order.idempotencyFingerprint
        ? { order: existing, status: "EXISTING_SAME" }
        : { order: existing, status: "EXISTING_CONFLICT" };
    }
    if (this.lockOwners.has(input.order.priceLockId)) {
      return { status: "PRICE_LOCK_UNAVAILABLE" };
    }
    this.orders.set(input.order.id, input.order);
    this.idempotencyKeys.set(input.order.idempotencyKey, input.order.id);
    this.lockOwners.set(input.order.priceLockId, input.order.id);
    this.history.set(input.order.id, [input.history]);
    return { order: input.order, status: "CREATED" };
  }

  public async findById(orderId: OrderId): Promise<KeyCoreOrder | null> {
    return this.orders.get(orderId) ?? null;
  }

  public async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<KeyCoreOrder | null> {
    const orderId = this.idempotencyKeys.get(idempotencyKey);
    return orderId ? (this.orders.get(orderId) ?? null) : null;
  }

  public async updateState(input: {
    readonly orderId: OrderId;
    readonly expectedVersion: number;
    readonly next: {
      readonly status?: KeyCoreOrder["status"];
      readonly paymentStatus?: KeyCoreOrder["paymentStatus"];
      readonly procurementStatus?: KeyCoreOrder["procurementStatus"];
      readonly fulfillmentStatus?: KeyCoreOrder["fulfillmentStatus"];
      readonly riskStatus?: KeyCoreOrder["riskStatus"];
      readonly refundStatus?: KeyCoreOrder["refundStatus"];
    };
    readonly history: OrderTransitionHistoryEntry;
    readonly now: Date;
  }): Promise<OrderTransitionPersistenceResult> {
    const current = this.orders.get(input.orderId);
    if (!current || current.recordVersion !== input.expectedVersion) {
      return { currentOrder: current ?? null, status: "CONFLICT" };
    }
    const updated: KeyCoreOrder = {
      ...current,
      fulfillmentStatus:
        input.next.fulfillmentStatus ?? current.fulfillmentStatus,
      paymentStatus: input.next.paymentStatus ?? current.paymentStatus,
      procurementStatus:
        input.next.procurementStatus ?? current.procurementStatus,
      recordVersion: current.recordVersion + 1,
      refundStatus: input.next.refundStatus ?? current.refundStatus,
      riskStatus: input.next.riskStatus ?? current.riskStatus,
      status: input.next.status ?? current.status,
      updatedAt: input.now,
    };
    this.orders.set(input.orderId, updated);
    this.history.set(input.orderId, [
      ...(this.history.get(input.orderId) ?? []),
      input.history,
    ]);
    return { order: updated, status: "UPDATED" };
  }

  public async recordExternalEvent(
    receipt: ExternalEventReceipt,
  ): Promise<ExternalEventReceiptPersistenceResult> {
    const key = receiptKey(receipt);
    const existing = this.receipts.get(key);
    if (existing) {
      return existing.eventFingerprint === receipt.eventFingerprint
        ? { receipt: existing, status: "DUPLICATE" }
        : { receipt: existing, status: "CONFLICT" };
    }
    this.receipts.set(key, receipt);
    return { receipt, status: "RECORDED" };
  }

  public async listHistory(
    orderId: OrderId,
  ): Promise<readonly OrderTransitionHistoryEntry[]> {
    return this.history.get(orderId) ?? [];
  }
}

const receiptKey = (receipt: ExternalEventReceipt): string =>
  `${receipt.provider}:${receipt.externalEventId}:${receipt.eventType}`;
