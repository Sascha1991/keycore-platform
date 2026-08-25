import {
  currency,
  customerId,
  maskCustomerEmail,
  money,
  orderId,
  type CustomerAccountOrderProjection,
  type CustomerAccountReadCursor,
  type CustomerAccountReadRepository,
  type CustomerAccountRecord,
  type CustomerId,
  type EmailVerificationState,
  type FulfillmentDeliveryState,
  type FulfillmentRetrievalState,
  type FulfillmentStatus,
  type OrderFulfillmentStatus,
  type OrderId,
  type OrderPaymentStatus,
  type OrderProcurementStatus,
  type OrderRefundStatus,
  type OrderStatus,
} from "../../packages/platform/src/contracts.js";
import type { Queryable } from "./client.js";

interface AccountRow {
  readonly id: string;
  readonly email_normalized: string;
  readonly email_verification_state: EmailVerificationState;
  readonly created_at: Date;
}

interface AccountOrderRow {
  readonly id: string;
  readonly customer_id: string;
  readonly product_id: string;
  readonly product_title: string | null;
  readonly customer_amount_minor: string;
  readonly currency: string;
  readonly status: OrderStatus;
  readonly payment_status: OrderPaymentStatus;
  readonly procurement_status: OrderProcurementStatus;
  readonly fulfillment_status: OrderFulfillmentStatus;
  readonly refund_status: OrderRefundStatus;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly fulfillment_id: string | null;
  readonly fulfillment_order_id: string | null;
  readonly fulfillment_operation_status: FulfillmentStatus | null;
  readonly retrieval_state: FulfillmentRetrievalState | null;
  readonly delivery_state: FulfillmentDeliveryState | null;
  readonly encrypted_secret_id: string | null;
  readonly retrieved_at: Date | null;
  readonly delivered_at: Date | null;
}

export class PostgresCustomerAccountReadRepository implements CustomerAccountReadRepository {
  public constructor(private readonly db: Queryable) {}

  public async findAccountSummary(
    requestedCustomerId: CustomerId,
  ): Promise<CustomerAccountRecord | null> {
    const result = await this.db.query<AccountRow>(
      `
        SELECT id::text, email_normalized, email_verification_state, created_at
        FROM keycore_customers
        WHERE id = $1
      `,
      [requestedCustomerId],
    );
    return result.rows[0] ? accountFromRow(result.rows[0]) : null;
  }

  public async listOwnedOrders(input: {
    readonly customerId: CustomerId;
    readonly limit: number;
    readonly after?: CustomerAccountReadCursor;
  }): Promise<{
    readonly orders: readonly CustomerAccountOrderProjection[];
    readonly nextCursor?: CustomerAccountReadCursor;
  }> {
    const values: unknown[] = [input.customerId];
    const cursorPredicate = input.after
      ? `AND (o.created_at, o.id) < ($2, $3::uuid)`
      : "";
    if (input.after) {
      values.push(input.after.createdAt, input.after.orderId);
    }
    values.push(input.limit + 1);
    const limitParameter = `$${values.length}`;
    const result = await this.db.query<AccountOrderRow>(
      `
        SELECT ${accountOrderColumns}
        FROM keycore_orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN fulfillment_operations f ON f.order_id = o.id
        WHERE o.customer_id = $1
          ${cursorPredicate}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ${limitParameter}
      `,
      values,
    );
    const pageRows = result.rows.slice(0, input.limit);
    const cursorRow = pageRows.at(-1);
    return {
      ...(result.rows.length > input.limit && cursorRow
        ? {
            nextCursor: {
              createdAt: cursorRow.created_at,
              orderId: orderId(cursorRow.id),
            },
          }
        : {}),
      orders: pageRows.map(orderFromRow),
    };
  }

  public async findOwnedOrderDetail(input: {
    readonly customerId: CustomerId;
    readonly orderId: OrderId;
  }): Promise<CustomerAccountOrderProjection | null> {
    const result = await this.db.query<AccountOrderRow>(
      `
        SELECT ${accountOrderColumns}
        FROM keycore_orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN fulfillment_operations f ON f.order_id = o.id
        WHERE o.customer_id = $1
          AND o.id = $2
        LIMIT 1
      `,
      [input.customerId, input.orderId],
    );
    return result.rows[0] ? orderFromRow(result.rows[0]) : null;
  }
}

const accountOrderColumns = `
  o.id::text,
  o.customer_id::text,
  o.product_id::text,
  p.title AS product_title,
  o.customer_amount_minor,
  o.currency,
  o.status,
  o.payment_status,
  o.procurement_status,
  o.fulfillment_status,
  o.refund_status,
  o.created_at,
  o.updated_at,
  f.id::text AS fulfillment_id,
  f.order_id::text AS fulfillment_order_id,
  f.status AS fulfillment_operation_status,
  f.retrieval_state,
  f.delivery_state,
  f.encrypted_secret_id::text,
  f.retrieved_at,
  f.delivered_at
`;

const accountFromRow = (row: AccountRow): CustomerAccountRecord => ({
  createdAt: row.created_at,
  customerId: customerId(row.id),
  emailMasked: maskCustomerEmail(row.email_normalized),
  emailVerificationState: row.email_verification_state,
});

const orderFromRow = (
  row: AccountOrderRow,
): CustomerAccountOrderProjection => ({
  createdAt: row.created_at,
  currency: currency(row.currency),
  customerId: customerId(row.customer_id),
  fulfillment: row.fulfillment_id
    ? {
        deliveredAt: row.delivered_at,
        deliveryState: required(row.delivery_state),
        fulfillmentId: row.fulfillment_id,
        hasEncryptedSecret: Boolean(row.encrypted_secret_id),
        orderId: row.fulfillment_order_id
          ? orderId(row.fulfillment_order_id)
          : null,
        retrievedAt: row.retrieved_at,
        retrievalState: required(row.retrieval_state),
        status: required(row.fulfillment_operation_status),
      }
    : null,
  fulfillmentStatus: row.fulfillment_status,
  orderId: orderId(row.id),
  paymentStatus: row.payment_status,
  procurementStatus: row.procurement_status,
  productTitle: row.product_title,
  refundStatus: row.refund_status,
  status: row.status,
  total: money(BigInt(row.customer_amount_minor), currency(row.currency)),
  updatedAt: row.updated_at,
});

const required = <TValue>(value: TValue | null): TValue => {
  if (value === null) {
    throw new Error("Expected customer account projection value");
  }
  return value;
};
