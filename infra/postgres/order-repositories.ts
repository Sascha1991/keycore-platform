import {
  currency,
  money,
  orderId,
  productId,
  type CorrelationId,
  type Money,
} from "../../packages/platform/src/contracts.js";
import type {
  ExternalEventReceipt,
  ExternalEventReceiptPersistenceResult,
  KeyCoreOrder,
  OrderCreatePersistenceResult,
  OrderFulfillmentStatus,
  OrderOutboxEvent,
  OrderPaymentStatus,
  OrderProcurementStatus,
  OrderReasonCode,
  OrderRefundStatus,
  OrderRepository,
  OrderRiskStatus,
  OrderStatus,
  OrderStatePatch,
  OrderTransitionHistoryEntry,
  OrderTransitionPersistenceResult,
} from "../../packages/platform/src/orders/order-orchestration.js";
import type { PriceLock } from "../../packages/platform/src/pricing/price-locks.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface OrderRow {
  readonly id: string;
  readonly product_id: string;
  readonly price_lock_id: string;
  readonly customer_amount_minor: string;
  readonly currency: string;
  readonly quantity: number;
  readonly status: OrderStatus;
  readonly payment_status: OrderPaymentStatus;
  readonly procurement_status: OrderProcurementStatus;
  readonly fulfillment_status: OrderFulfillmentStatus;
  readonly risk_status: OrderRiskStatus;
  readonly refund_status: OrderRefundStatus;
  readonly record_version: number;
  readonly idempotency_key: string;
  readonly idempotency_fingerprint: string;
  readonly correlation_id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface HistoryRow {
  readonly id: string;
  readonly order_id: string;
  readonly from_status: OrderStatus | null;
  readonly to_status: OrderStatus;
  readonly from_payment_status: OrderPaymentStatus | null;
  readonly to_payment_status: OrderPaymentStatus | null;
  readonly from_procurement_status: OrderProcurementStatus | null;
  readonly to_procurement_status: OrderProcurementStatus | null;
  readonly from_fulfillment_status: OrderFulfillmentStatus | null;
  readonly to_fulfillment_status: OrderFulfillmentStatus | null;
  readonly from_risk_status: OrderRiskStatus | null;
  readonly to_risk_status: OrderRiskStatus | null;
  readonly from_refund_status: OrderRefundStatus | null;
  readonly to_refund_status: OrderRefundStatus | null;
  readonly reason_code: OrderReasonCode;
  readonly correlation_id: string;
  readonly actor_type: "CUSTOMER" | "ADMIN" | "SYSTEM" | "SERVICE";
  readonly occurred_at: Date;
}

interface ExternalEventReceiptRow {
  readonly provider: string;
  readonly external_event_id: string;
  readonly event_type: string;
  readonly event_fingerprint: string;
  readonly order_id: string | null;
  readonly correlation_id: string;
  readonly received_at: Date;
}

export class PostgresOrderRepository implements OrderRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async createFromActivePriceLock(input: {
    readonly order: KeyCoreOrder;
    readonly priceLock: PriceLock;
    readonly history: OrderTransitionHistoryEntry;
    readonly outbox: OrderOutboxEvent;
    readonly now: Date;
  }): Promise<OrderCreatePersistenceResult> {
    return this.db.transaction(async (client) => {
      await lockOrderIdempotencyKey(client, input.order.idempotencyKey);
      const existing = await findByIdempotencyKey(
        client,
        input.order.idempotencyKey,
      );
      if (existing) {
        return existing.idempotencyFingerprint ===
          input.order.idempotencyFingerprint
          ? { order: existing, status: "EXISTING_SAME" }
          : { order: existing, status: "EXISTING_CONFLICT" };
      }

      const claimed = await client.query(
        `
          UPDATE price_locks
          SET status = 'CONSUMED',
            record_version = record_version + 1,
            consumed_at = $3,
            reason_code = 'PRICE_LOCK_CONSUMED'
          WHERE id = $1
            AND record_version = $2
            AND status = 'ACTIVE'
            AND expires_at > $3
          RETURNING id
        `,
        [input.priceLock.id, input.priceLock.recordVersion, input.now],
      );
      if (!claimed.rows[0]) {
        return { status: "PRICE_LOCK_UNAVAILABLE" };
      }

      const inserted = await client.query<OrderRow>(
        `
          INSERT INTO keycore_orders(
            id, product_id, price_lock_id, customer_amount_minor, currency,
            quantity, status, payment_status, procurement_status,
            fulfillment_status, risk_status, refund_status, record_version,
            idempotency_key, idempotency_fingerprint, correlation_id,
            created_at, updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18
          )
          RETURNING ${orderReturning}
        `,
        orderValues(input.order),
      );
      const row = inserted.rows[0];
      if (!row) {
        throw new Error("Expected PostgreSQL order insert to return one row");
      }
      await insertHistory(client, input.history);
      await insertOutbox(client, input.outbox);
      return { order: orderFromRow(row), status: "CREATED" };
    });
  }

  public async findById(
    requestedOrderId: KeyCoreOrder["id"],
  ): Promise<KeyCoreOrder | null> {
    return findById(this.db, requestedOrderId);
  }

  public async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<KeyCoreOrder | null> {
    return findByIdempotencyKey(this.db, idempotencyKey);
  }

  public async updateState(input: {
    readonly orderId: KeyCoreOrder["id"];
    readonly expectedVersion: number;
    readonly next: OrderStatePatch;
    readonly history: OrderTransitionHistoryEntry;
    readonly outbox?: OrderOutboxEvent;
    readonly now: Date;
  }): Promise<OrderTransitionPersistenceResult> {
    return this.db.transaction(async (client) => {
      const updated = await client.query<OrderRow>(
        `
          UPDATE keycore_orders
          SET status = COALESCE($3, status),
            payment_status = COALESCE($4, payment_status),
            procurement_status = COALESCE($5, procurement_status),
            fulfillment_status = COALESCE($6, fulfillment_status),
            risk_status = COALESCE($7, risk_status),
            refund_status = COALESCE($8, refund_status),
            record_version = record_version + 1,
            updated_at = $9
          WHERE id = $1 AND record_version = $2
          RETURNING ${orderReturning}
        `,
        [
          input.orderId,
          input.expectedVersion,
          input.next.status ?? null,
          input.next.paymentStatus ?? null,
          input.next.procurementStatus ?? null,
          input.next.fulfillmentStatus ?? null,
          input.next.riskStatus ?? null,
          input.next.refundStatus ?? null,
          input.now,
        ],
      );
      const row = updated.rows[0];
      if (!row) {
        return {
          currentOrder: await findById(client, input.orderId),
          status: "CONFLICT",
        };
      }
      await insertHistory(client, input.history);
      if (input.outbox) {
        await insertOutbox(client, input.outbox);
      }
      return { order: orderFromRow(row), status: "UPDATED" };
    });
  }

  public async recordExternalEvent(
    receipt: ExternalEventReceipt,
  ): Promise<ExternalEventReceiptPersistenceResult> {
    const inserted = await this.db.query<ExternalEventReceiptRow>(
      `
        INSERT INTO external_event_receipts(
          provider, external_event_id, event_type, event_fingerprint,
          order_id, correlation_id, received_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (provider, external_event_id, event_type)
        DO NOTHING
        RETURNING ${receiptReturning}
      `,
      [
        receipt.provider,
        receipt.externalEventId,
        receipt.eventType,
        receipt.eventFingerprint,
        receipt.orderId ?? null,
        receipt.correlationId,
        receipt.receivedAt,
      ],
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow) {
      return { receipt: receiptFromRow(insertedRow), status: "RECORDED" };
    }
    const existing = await this.findReceipt(receipt);
    if (!existing) {
      throw new Error("External event receipt conflict row not found");
    }
    return existing.eventFingerprint === receipt.eventFingerprint
      ? { receipt: existing, status: "DUPLICATE" }
      : { receipt: existing, status: "CONFLICT" };
  }

  public async listHistory(
    requestedOrderId: KeyCoreOrder["id"],
  ): Promise<readonly OrderTransitionHistoryEntry[]> {
    const result = await this.db.query<HistoryRow>(
      `
        SELECT ${historyReturning}
        FROM order_transition_history
        WHERE order_id = $1
        ORDER BY occurred_at, id
      `,
      [requestedOrderId],
    );
    return result.rows.map(historyFromRow);
  }

  private async findReceipt(
    receipt: Pick<
      ExternalEventReceipt,
      "provider" | "externalEventId" | "eventType"
    >,
  ): Promise<ExternalEventReceipt | null> {
    const result = await this.db.query<ExternalEventReceiptRow>(
      `
        SELECT ${receiptReturning}
        FROM external_event_receipts
        WHERE provider = $1 AND external_event_id = $2 AND event_type = $3
      `,
      [receipt.provider, receipt.externalEventId, receipt.eventType],
    );
    const row = result.rows[0];
    return row ? receiptFromRow(row) : null;
  }
}

const orderReturning = `
  id::text, product_id::text, price_lock_id::text,
  customer_amount_minor::text, currency, quantity, status, payment_status,
  procurement_status, fulfillment_status, risk_status, refund_status,
  record_version, idempotency_key, idempotency_fingerprint, correlation_id,
  created_at, updated_at
`;

const historyReturning = `
  id::text, order_id::text, from_status, to_status, from_payment_status,
  to_payment_status, from_procurement_status, to_procurement_status,
  from_fulfillment_status, to_fulfillment_status, from_risk_status,
  to_risk_status, from_refund_status, to_refund_status, reason_code,
  correlation_id, actor_type, occurred_at
`;

const receiptReturning = `
  provider, external_event_id, event_type, event_fingerprint,
  order_id::text, correlation_id, received_at
`;

const orderValues = (order: KeyCoreOrder): readonly unknown[] => [
  order.id,
  order.productId,
  order.priceLockId,
  order.customerAmount.amountMinor.toString(),
  order.currency,
  order.quantity,
  order.status,
  order.paymentStatus,
  order.procurementStatus,
  order.fulfillmentStatus,
  order.riskStatus,
  order.refundStatus,
  order.recordVersion,
  order.idempotencyKey,
  order.idempotencyFingerprint,
  order.correlationId,
  order.createdAt,
  order.updatedAt,
];

const findById = async (
  db: Queryable,
  requestedOrderId: KeyCoreOrder["id"],
): Promise<KeyCoreOrder | null> => {
  const result = await db.query<OrderRow>(
    `
      SELECT ${orderReturning}
      FROM keycore_orders
      WHERE id = $1
    `,
    [requestedOrderId],
  );
  const row = result.rows[0];
  return row ? orderFromRow(row) : null;
};

const findByIdempotencyKey = async (
  db: Queryable,
  idempotencyKey: string,
): Promise<KeyCoreOrder | null> => {
  const result = await db.query<OrderRow>(
    `
      SELECT ${orderReturning}
      FROM keycore_orders
      WHERE idempotency_key = $1
    `,
    [idempotencyKey],
  );
  const row = result.rows[0];
  return row ? orderFromRow(row) : null;
};

const lockOrderIdempotencyKey = async (
  db: Queryable,
  idempotencyKey: string,
): Promise<void> => {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7001))", [
    idempotencyKey,
  ]);
};

const insertHistory = async (
  db: Queryable,
  history: OrderTransitionHistoryEntry,
): Promise<void> => {
  await db.query(
    `
      INSERT INTO order_transition_history(
        id, order_id, from_status, to_status, from_payment_status,
        to_payment_status, from_procurement_status, to_procurement_status,
        from_fulfillment_status, to_fulfillment_status, from_risk_status,
        to_risk_status, from_refund_status, to_refund_status, reason_code,
        correlation_id, actor_type, occurred_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18
      )
    `,
    [
      history.id,
      history.orderId,
      history.fromStatus ?? null,
      history.toStatus,
      history.fromPaymentStatus ?? null,
      history.toPaymentStatus ?? null,
      history.fromProcurementStatus ?? null,
      history.toProcurementStatus ?? null,
      history.fromFulfillmentStatus ?? null,
      history.toFulfillmentStatus ?? null,
      history.fromRiskStatus ?? null,
      history.toRiskStatus ?? null,
      history.fromRefundStatus ?? null,
      history.toRefundStatus ?? null,
      history.reasonCode,
      history.correlationId,
      history.actorType,
      history.occurredAt,
    ],
  );
};

const insertOutbox = async (
  db: Queryable,
  event: OrderOutboxEvent,
): Promise<void> => {
  await db.query(
    `
      INSERT INTO outbox_events(
        event_type, aggregate_type, aggregate_id, payload, correlation_id,
        event_deduplication_key, status, retry_count, next_attempt_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'PENDING', 0, now())
      ON CONFLICT (event_deduplication_key) DO NOTHING
    `,
    [
      event.eventType,
      event.aggregateType,
      event.aggregateId,
      JSON.stringify(event.payload),
      event.correlationId,
      event.eventDeduplicationKey,
    ],
  );
};

const orderFromRow = (row: OrderRow): KeyCoreOrder => ({
  correlationId: row.correlation_id as CorrelationId,
  createdAt: row.created_at,
  currency: currency(row.currency),
  customerAmount: moneyFrom(row.customer_amount_minor, row.currency),
  fulfillmentStatus: row.fulfillment_status,
  id: orderId(row.id),
  idempotencyFingerprint: row.idempotency_fingerprint,
  idempotencyKey: row.idempotency_key,
  paymentStatus: row.payment_status,
  priceLockId: row.price_lock_id,
  procurementStatus: row.procurement_status,
  productId: productId(row.product_id),
  quantity: row.quantity,
  recordVersion: row.record_version,
  refundStatus: row.refund_status,
  riskStatus: row.risk_status,
  status: row.status,
  updatedAt: row.updated_at,
});

const historyFromRow = (row: HistoryRow): OrderTransitionHistoryEntry => ({
  actorType: row.actor_type,
  correlationId: row.correlation_id as CorrelationId,
  fromFulfillmentStatus: row.from_fulfillment_status,
  fromPaymentStatus: row.from_payment_status,
  fromProcurementStatus: row.from_procurement_status,
  fromRefundStatus: row.from_refund_status,
  fromRiskStatus: row.from_risk_status,
  fromStatus: row.from_status,
  id: row.id,
  occurredAt: row.occurred_at,
  orderId: orderId(row.order_id),
  reasonCode: row.reason_code,
  toFulfillmentStatus: row.to_fulfillment_status,
  toPaymentStatus: row.to_payment_status,
  toProcurementStatus: row.to_procurement_status,
  toRefundStatus: row.to_refund_status,
  toRiskStatus: row.to_risk_status,
  toStatus: row.to_status,
});

const receiptFromRow = (
  row: ExternalEventReceiptRow,
): ExternalEventReceipt => ({
  correlationId: row.correlation_id as CorrelationId,
  eventFingerprint: row.event_fingerprint,
  eventType: row.event_type,
  externalEventId: row.external_event_id,
  ...(row.order_id ? { orderId: orderId(row.order_id) } : {}),
  provider: row.provider,
  receivedAt: row.received_at,
});

const moneyFrom = (amountMinor: string, moneyCurrency: string): Money =>
  money(BigInt(amountMinor), currency(moneyCurrency));
