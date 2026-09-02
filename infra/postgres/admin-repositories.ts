import type {
  AdminDashboard,
  AdminOrderDetail,
  AdminOrderFilters,
  AdminOrderPage,
  AdminOrderReadRepository,
  AdminRole,
  AdminSessionRepository,
  OrderId,
  StoredAdminSession,
} from "../../packages/platform/src/contracts.js";
import { orderId } from "../../packages/platform/src/contracts.js";
import type { Queryable } from "./client.js";

interface OrderSummaryRow {
  readonly id: string;
  readonly customer_email: string | null;
  readonly product_title: string;
  readonly quantity: number;
  readonly customer_amount_minor: string;
  readonly currency: string;
  readonly status: string;
  readonly payment_status: string;
  readonly procurement_status: string;
  readonly fulfillment_status: string;
  readonly risk_status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresAdminSessionRepository implements AdminSessionRepository {
  public constructor(private readonly database: Queryable) {}

  public async findByHash(
    sessionHash: string,
  ): Promise<StoredAdminSession | null> {
    const result = await this.database.query<{
      readonly admin_id: string;
      readonly display_name: string;
      readonly roles: AdminRole[];
      readonly assurance: StoredAdminSession["assurance"];
      readonly expires_at: Date;
      readonly revoked_at: Date | null;
      readonly identity_status: StoredAdminSession["identityStatus"];
    }>(
      `
        SELECT
          identity.id::text AS admin_id,
          identity.display_name,
          COALESCE(
            array_agg(assignment.role ORDER BY assignment.role)
              FILTER (WHERE assignment.role IS NOT NULL),
            ARRAY[]::text[]
          ) AS roles,
          session.assurance,
          session.expires_at,
          session.revoked_at,
          identity.status AS identity_status
        FROM admin_sessions session
        JOIN admin_identities identity ON identity.id = session.admin_id
        LEFT JOIN admin_role_assignments assignment
          ON assignment.admin_id = identity.id AND assignment.revoked_at IS NULL
        WHERE session.session_hash = $1
        GROUP BY identity.id, session.id
      `,
      [sessionHash],
    );
    const row = result.rows[0];
    return row
      ? {
          adminId: row.admin_id,
          assurance: row.assurance,
          displayName: row.display_name,
          expiresAt: row.expires_at,
          identityStatus: row.identity_status,
          revokedAt: row.revoked_at,
          roles: row.roles,
        }
      : null;
  }

  public async touch(sessionHash: string, at: Date): Promise<void> {
    await this.database.query(
      `UPDATE admin_sessions SET last_seen_at = $2 WHERE session_hash = $1 AND revoked_at IS NULL`,
      [sessionHash, at],
    );
  }

  public async revoke(sessionHash: string, at: Date): Promise<void> {
    await this.database.query(
      `UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE session_hash = $1`,
      [sessionHash, at],
    );
  }
}

export class PostgresAdminOrderReadRepository implements AdminOrderReadRepository {
  public constructor(private readonly database: Queryable) {}

  public async dashboard(): Promise<AdminDashboard> {
    const [counts, revenue, recent] = await Promise.all([
      this.database.query<{
        readonly total_orders: string;
        readonly attention_orders: string;
        readonly processing_orders: string;
        readonly failed_orders: string;
      }>(`
        SELECT
          count(*)::text AS total_orders,
          count(*) FILTER (WHERE status = 'MANUAL_REVIEW' OR risk_status = 'REVIEW_REQUIRED')::text AS attention_orders,
          count(*) FILTER (WHERE status IN ('PAYMENT_CAPTURED', 'PROCUREMENT_PENDING', 'PROCUREMENT_IN_PROGRESS', 'FULFILLMENT_PENDING'))::text AS processing_orders,
          count(*) FILTER (WHERE status = 'FAILED')::text AS failed_orders
        FROM keycore_orders
      `),
      this.database.query<{
        readonly currency: string;
        readonly amount_minor: string;
      }>(`
        SELECT currency, COALESCE(sum(customer_amount_minor), 0)::text AS amount_minor
        FROM keycore_orders
        WHERE payment_status IN ('CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED')
        GROUP BY currency
        ORDER BY currency ASC
      `),
      this.database.query<OrderSummaryRow>(
        `${summarySelect} ORDER BY orders.created_at DESC, orders.id DESC LIMIT 10`,
      ),
    ]);
    const row = required(counts.rows[0]);
    return {
      attentionOrders: Number(row.attention_orders),
      failedOrders: Number(row.failed_orders),
      processingOrders: Number(row.processing_orders),
      recentOrders: recent.rows.map(mapOrderSummary),
      revenueByCurrency: revenue.rows.map((item) => ({
        amountMinor: item.amount_minor,
        currency: item.currency,
      })),
      totalOrders: Number(row.total_orders),
    };
  }

  public async list(input: {
    readonly filters: AdminOrderFilters;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly orderId: OrderId };
  }): Promise<AdminOrderPage> {
    const values: unknown[] = [];
    const predicates: string[] = [];
    const parameter = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    if (input.filters.exactOrderId)
      predicates.push(
        `orders.id = ${parameter(input.filters.exactOrderId)}::uuid`,
      );
    if (input.filters.exactCustomerEmail)
      predicates.push(
        `COALESCE(customer.email_normalized, orders.checkout_email_normalized) = ${parameter(input.filters.exactCustomerEmail)}`,
      );
    if (input.filters.status)
      predicates.push(`orders.status = ${parameter(input.filters.status)}`);
    if (input.filters.fromDate)
      predicates.push(
        `orders.created_at >= ${parameter(`${input.filters.fromDate}T00:00:00.000Z`)}::timestamptz`,
      );
    if (input.filters.toDate)
      predicates.push(
        `orders.created_at < (${parameter(`${input.filters.toDate}T00:00:00.000Z`)}::timestamptz + interval '1 day')`,
      );
    if (input.after)
      predicates.push(
        `(orders.created_at, orders.id) < (${parameter(input.after.createdAt)}, ${parameter(input.after.orderId)}::uuid)`,
      );
    const where =
      predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
    const result = await this.database.query<OrderSummaryRow>(
      `${summarySelect} ${where} ORDER BY orders.created_at DESC, orders.id DESC LIMIT ${parameter(input.limit + 1)}`,
      values,
    );
    const hasNext = result.rows.length > input.limit;
    const rows = result.rows.slice(0, input.limit);
    const last = rows.at(-1);
    return {
      orders: rows.map(mapOrderSummary),
      ...(hasNext && last
        ? {
            nextCursor: {
              createdAt: last.created_at,
              orderId: orderId(last.id),
            },
          }
        : {}),
    };
  }

  public async findDetail(
    targetOrderId: OrderId,
  ): Promise<AdminOrderDetail | null> {
    const result = await this.database.query<
      OrderSummaryRow & {
        readonly customer_id: string | null;
        readonly correlation_id: string;
        readonly guest_claim_status: AdminOrderDetail["guestClaimStatus"];
        readonly supplier_id: string | null;
        readonly external_supplier_order_id: string | null;
        readonly fulfillment_operation_status: string | null;
        readonly retrieval_state: string | null;
        readonly delivery_state: string | null;
        readonly encrypted_secret_available: boolean;
      }
    >(
      `
        SELECT
          orders.id::text,
          COALESCE(customer.email_normalized, orders.checkout_email_normalized) AS customer_email,
          product.title AS product_title,
          orders.quantity,
          orders.customer_amount_minor::text,
          orders.currency,
          orders.status,
          orders.payment_status,
          orders.procurement_status,
          orders.fulfillment_status,
          orders.risk_status,
          orders.created_at,
          orders.updated_at,
          orders.customer_id::text,
          orders.correlation_id,
          CASE
            WHEN claim.id IS NULL THEN 'NOT_AVAILABLE'
            WHEN claim.consumed_at IS NOT NULL THEN 'CLAIMED'
            WHEN claim.revoked_at IS NOT NULL THEN 'REVOKED'
            WHEN claim.expires_at <= now() THEN 'EXPIRED'
            ELSE 'ACTIVE'
          END AS guest_claim_status,
          fulfillment.supplier_id,
          fulfillment.external_supplier_order_id,
          fulfillment.status AS fulfillment_operation_status,
          fulfillment.retrieval_state,
          fulfillment.delivery_state,
          (fulfillment.encrypted_secret_id IS NOT NULL) AS encrypted_secret_available
        FROM keycore_orders orders
        JOIN products product ON product.id = orders.product_id
        LEFT JOIN keycore_customers customer ON customer.id = orders.customer_id
        ${detailJoins}
        WHERE orders.id = $1
      `,
      [targetOrderId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const history = await this.database.query<{
      readonly from_status: string | null;
      readonly to_status: string;
      readonly reason_code: string;
      readonly actor_type: string;
      readonly occurred_at: Date;
    }>(
      `
        SELECT from_status, to_status, reason_code, actor_type, occurred_at
        FROM order_transition_history
        WHERE order_id = $1
        ORDER BY occurred_at ASC, id ASC
      `,
      [targetOrderId],
    );
    return {
      ...mapOrderSummary(row),
      correlationId: row.correlation_id,
      customerId: row.customer_id,
      deliveryState: row.delivery_state,
      encryptedSecretAvailable: row.encrypted_secret_available,
      externalSupplierOrderId: row.external_supplier_order_id,
      fulfillmentOperationStatus: row.fulfillment_operation_status,
      guestClaimStatus: row.guest_claim_status,
      history: history.rows.map((item) => ({
        actorType: item.actor_type,
        fromStatus: item.from_status,
        occurredAt: item.occurred_at,
        reasonCode: item.reason_code,
        toStatus: item.to_status,
      })),
      invoiceStatus: "NOT_AVAILABLE",
      retrievalState: row.retrieval_state,
      supplierId: row.supplier_id,
    };
  }
}

const summarySelect = `
  SELECT
    orders.id::text,
    COALESCE(customer.email_normalized, orders.checkout_email_normalized) AS customer_email,
    product.title AS product_title,
    orders.quantity,
    orders.customer_amount_minor::text,
    orders.currency,
    orders.status,
    orders.payment_status,
    orders.procurement_status,
    orders.fulfillment_status,
    orders.risk_status,
    orders.created_at,
    orders.updated_at
  FROM keycore_orders orders
  JOIN products product ON product.id = orders.product_id
  LEFT JOIN keycore_customers customer ON customer.id = orders.customer_id
`;

const detailJoins = `
  LEFT JOIN LATERAL (
    SELECT
      operation.id,
      operation.supplier_id,
      operation.external_supplier_order_id,
      operation.status,
      operation.retrieval_state,
      operation.delivery_state,
      operation.encrypted_secret_id,
      operation.created_at
    FROM fulfillment_operations operation
    WHERE operation.order_id = orders.id
    ORDER BY operation.created_at DESC, operation.id DESC
    LIMIT 1
  ) fulfillment ON true
  LEFT JOIN LATERAL (
    SELECT
      challenge.id,
      challenge.expires_at,
      challenge.consumed_at,
      challenge.revoked_at,
      challenge.created_at
    FROM guest_order_claim_challenges challenge
    WHERE challenge.order_id = orders.id
    ORDER BY challenge.created_at DESC, challenge.id DESC
    LIMIT 1
  ) claim ON true
`;

const mapOrderSummary = (row: OrderSummaryRow) => ({
  amountMinor: row.customer_amount_minor,
  createdAt: row.created_at,
  currency: row.currency,
  customerEmail: row.customer_email,
  fulfillmentStatus: row.fulfillment_status,
  orderId: orderId(row.id),
  paymentStatus: row.payment_status,
  procurementStatus: row.procurement_status,
  productTitle: row.product_title,
  quantity: row.quantity,
  riskStatus: row.risk_status,
  status: row.status,
  updatedAt: row.updated_at,
});

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Expected PostgreSQL row");
  return value;
};
