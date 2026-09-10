import type {
  AdminCustomerSummary,
  AdminCustomerRepositoryListInput,
  AdminCustomerSort,
  AdminFinanceCurrencySummary,
  AdminFraudReviewSummary,
  AdminOperationsControlSummary,
  AdminOperationsPage,
  AdminOperationsRepository,
  AdminProductSummary,
  AdminRepositoryListInput,
  AdminSupplierSummary,
  AdminSupportCaseSummary,
} from "../../packages/platform/src/contracts.js";
import { adminCapturedPaymentVolumeStates } from "../../packages/platform/src/contracts.js";
import type { Queryable } from "./client.js";

export class PostgresAdminOperationsRepository implements AdminOperationsRepository {
  public constructor(private readonly database: Queryable) {}

  public async listCustomers(input: AdminCustomerRepositoryListInput) {
    const values: unknown[] = [];
    const basePredicates: string[] = [];
    const parameter = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (input.search)
      basePredicates.push(
        `(customer.id::text = ${parameter(input.search)} OR customer.email_normalized ILIKE ${parameter(like(input.search))} ESCAPE '\\')`,
      );
    if (input.status)
      basePredicates.push(
        `customer.email_verification_state = ${parameter(input.status)}`,
      );
    if (input.orderPresence === "WITH_ORDERS")
      basePredicates.push(
        "EXISTS (SELECT 1 FROM keycore_orders owned_order WHERE owned_order.customer_id = customer.id)",
      );
    if (input.orderPresence === "WITHOUT_ORDERS")
      basePredicates.push(
        "NOT EXISTS (SELECT 1 FROM keycore_orders owned_order WHERE owned_order.customer_id = customer.id)",
      );
    if (input.registeredFrom)
      basePredicates.push(
        `customer.created_at >= ${parameter(input.registeredFrom)}`,
      );
    if (input.registeredTo)
      basePredicates.push(
        `customer.created_at <= ${parameter(input.registeredTo)}`,
      );

    const metricsValues = [...values];
    const baseWhere = where(basePredicates);
    const predicates = [...basePredicates];
    const sort = customerSort(input.sort);
    if (input.after) {
      const sortParameter = parameter(input.after.sortValue);
      const idParameter = parameter(input.after.id);
      predicates.push(
        `(${sort.expression}, customer.id) ${sort.comparator} (${sort.cast(sortParameter)}, ${idParameter}::uuid)`,
      );
    }
    const [result, metricResult] = await Promise.all([
      this.database.query<{
        readonly id: string;
        readonly email_normalized: string;
        readonly email_verification_state: AdminCustomerSummary["verificationState"];
        readonly order_count: string;
        readonly last_order_at: Date | null;
        readonly last_order_reference: string | null;
        readonly last_order_status: string | null;
        readonly created_at: Date;
      }>(
        `
      SELECT customer.id::text, customer.email_normalized, customer.email_verification_state,
        count(orders.id)::text AS order_count,
        latest_order.created_at AS last_order_at,
        latest_order.operator_reference AS last_order_reference,
        latest_order.status AS last_order_status,
        customer.created_at
      FROM keycore_customers customer
      LEFT JOIN keycore_orders orders ON orders.customer_id = customer.id
      LEFT JOIN LATERAL (
        SELECT recent_order.operator_reference, recent_order.status, recent_order.created_at
        FROM keycore_orders recent_order
        WHERE recent_order.customer_id = customer.id
        ORDER BY recent_order.created_at DESC, recent_order.id DESC
        LIMIT 1
      ) latest_order ON true
      ${where(predicates)}
      GROUP BY customer.id, latest_order.operator_reference, latest_order.status, latest_order.created_at
      ORDER BY ${sort.expression} ${sort.direction}, customer.id ${sort.direction}
      LIMIT ${parameter(input.limit + 1)}
    `,
        values,
      ),
      this.database.query<{
        readonly customers_with_orders: string;
        readonly total_customers: string;
        readonly total_orders: string;
        readonly verified_customers: string;
      }>(
        `
        SELECT
          count(*)::text AS total_customers,
          count(*) FILTER (WHERE scoped.email_verification_state = 'VERIFIED')::text AS verified_customers,
          count(*) FILTER (WHERE scoped.order_count > 0)::text AS customers_with_orders,
          COALESCE(sum(scoped.order_count), 0)::text AS total_orders
        FROM (
          SELECT customer.id, customer.email_verification_state, count(orders.id) AS order_count
          FROM keycore_customers customer
          LEFT JOIN keycore_orders orders ON orders.customer_id = customer.id
          ${baseWhere}
          GROUP BY customer.id
        ) scoped
        `,
        metricsValues,
      ),
    ]);
    const paged = page(
      input.limit,
      result.rows,
      (row) => ({
        createdAt: row.created_at,
        customerId: row.id,
        email: row.email_normalized,
        lastOrderAt: row.last_order_at,
        lastOrderReference: row.last_order_reference,
        lastOrderStatus: row.last_order_status,
        orderCount: Number(row.order_count),
        verificationState: row.email_verification_state,
      }),
      (row) => ({
        id: row.id,
        sortValue:
          input.sort === "EMAIL_ASC" || input.sort === "EMAIL_DESC"
            ? row.email_normalized.toLowerCase()
            : row.created_at.toISOString(),
      }),
    );
    const metrics = required(metricResult.rows[0]);
    return {
      ...paged,
      metrics: {
        customersWithOrders: Number(metrics.customers_with_orders),
        totalCustomers: Number(metrics.total_customers),
        totalOrders: Number(metrics.total_orders),
        verifiedCustomers: Number(metrics.verified_customers),
      },
      totalCount: Number(metrics.total_customers),
    };
  }

  public async findCustomer(
    customerId: string,
  ): Promise<AdminCustomerSummary | null> {
    const result = await this.database.query<{
      readonly id: string;
      readonly email_normalized: string;
      readonly email_verification_state: AdminCustomerSummary["verificationState"];
      readonly order_count: string;
      readonly last_order_at: Date | null;
      readonly last_order_reference: string | null;
      readonly last_order_status: string | null;
      readonly created_at: Date;
    }>(
      `
      SELECT customer.id::text, customer.email_normalized, customer.email_verification_state,
        count(orders.id)::text AS order_count,
        latest_order.created_at AS last_order_at,
        latest_order.operator_reference AS last_order_reference,
        latest_order.status AS last_order_status,
        customer.created_at
      FROM keycore_customers customer
      LEFT JOIN keycore_orders orders ON orders.customer_id = customer.id
      LEFT JOIN LATERAL (
        SELECT recent_order.operator_reference, recent_order.status, recent_order.created_at
        FROM keycore_orders recent_order
        WHERE recent_order.customer_id = customer.id
        ORDER BY recent_order.created_at DESC, recent_order.id DESC
        LIMIT 1
      ) latest_order ON true
      WHERE customer.id = $1::uuid
      GROUP BY customer.id, latest_order.operator_reference, latest_order.status, latest_order.created_at
      `,
      [customerId],
    );
    const row = result.rows[0];
    return row
      ? {
          createdAt: row.created_at,
          customerId: row.id,
          email: row.email_normalized,
          lastOrderAt: row.last_order_at,
          lastOrderReference: row.last_order_reference,
          lastOrderStatus: row.last_order_status,
          orderCount: Number(row.order_count),
          verificationState: row.email_verification_state,
        }
      : null;
  }

  public async listProducts(
    input: AdminRepositoryListInput,
  ): Promise<AdminOperationsPage<AdminProductSummary>> {
    const values: unknown[] = [];
    const predicates: string[] = [];
    const parameter = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (input.search)
      predicates.push(
        `(product.id::text = ${parameter(input.search)} OR product.title ILIKE ${parameter(like(input.search))} ESCAPE '\\')`,
      );
    if (input.status === "ACTIVE") predicates.push("product.active = true");
    else if (input.status === "INACTIVE")
      predicates.push("product.active = false");
    else if (input.status)
      predicates.push(`product.lifecycle = ${parameter(input.status)}`);
    if (input.after)
      predicates.push(
        `(lower(product.title), product.id) > (${parameter(input.after.sortValue)}, ${parameter(input.after.id)}::uuid)`,
      );
    const result = await this.database.query<{
      readonly id: string;
      readonly title: string;
      readonly product_type: string;
      readonly platform: string;
      readonly lifecycle: string;
      readonly active: boolean;
      readonly offer_count: string;
      readonly available_offer_count: string;
    }>(
      `
      SELECT product.id::text, product.title, product.product_type, product.platform, product.lifecycle, product.active,
        count(offer.id)::text AS offer_count,
        count(offer.id) FILTER (WHERE offer.availability = 'AVAILABLE' AND supplier_offer.active = true)::text AS available_offer_count
      FROM products product
      LEFT JOIN offers offer ON offer.product_id = product.id
      LEFT JOIN supplier_offers supplier_offer ON supplier_offer.id = offer.supplier_offer_id
      ${where(predicates)}
      GROUP BY product.id
      ORDER BY lower(product.title) ASC, product.id ASC
      LIMIT ${parameter(input.limit + 1)}
    `,
      values,
    );
    return page(
      input.limit,
      result.rows,
      (row) => ({
        active: row.active,
        availableOfferCount: Number(row.available_offer_count),
        lifecycle: row.lifecycle,
        offerCount: Number(row.offer_count),
        platform: row.platform,
        productId: row.id,
        productType: row.product_type,
        title: row.title,
      }),
      (row) => ({ id: row.id, sortValue: row.title.toLowerCase() }),
    );
  }

  public async listSuppliers(
    input: AdminRepositoryListInput,
  ): Promise<AdminOperationsPage<AdminSupplierSummary>> {
    const values: unknown[] = [];
    const predicates: string[] = [];
    const parameter = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (input.search)
      predicates.push(
        `(supplier.id::text = ${parameter(input.search)} OR supplier.display_name ILIKE ${parameter(like(input.search))} ESCAPE '\\' OR supplier.supplier_code ILIKE ${parameter(like(input.search))} ESCAPE '\\')`,
      );
    if (input.after)
      predicates.push(
        `(lower(supplier.display_name), supplier.id) > (${parameter(input.after.sortValue)}, ${parameter(input.after.id)}::uuid)`,
      );
    const result = await this.database.query<{
      readonly id: string;
      readonly supplier_code: string;
      readonly display_name: string;
      readonly product_count: string;
      readonly active_offer_count: string;
      readonly last_sync_status: string | null;
      readonly last_sync_at: Date | null;
    }>(
      `
      WITH selected_suppliers AS (
        SELECT supplier.id, supplier.supplier_code, supplier.display_name
        FROM suppliers supplier
        ${where(predicates)}
        ORDER BY lower(supplier.display_name) ASC, supplier.id ASC
        LIMIT ${parameter(input.limit + 1)}
      )
      SELECT supplier.id::text, supplier.supplier_code, supplier.display_name,
        product_stats.product_count,
        offer_stats.active_offer_count,
        latest_sync.status AS last_sync_status, latest_sync.started_at AS last_sync_at
      FROM selected_suppliers supplier
      LEFT JOIN LATERAL (
        SELECT count(*)::text AS product_count
        FROM supplier_products supplier_product
        WHERE supplier_product.supplier_id = supplier.id
      ) product_stats ON true
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE supplier_offer.active = true)::text AS active_offer_count
        FROM supplier_offers supplier_offer
        WHERE supplier_offer.supplier_id = supplier.id
      ) offer_stats ON true
      LEFT JOIN LATERAL (
        SELECT status, started_at FROM catalog_sync_runs run
        WHERE run.supplier_id = supplier.id ORDER BY started_at DESC, id DESC LIMIT 1
      ) latest_sync ON true
      ORDER BY lower(supplier.display_name) ASC, supplier.id ASC
    `,
      values,
    );
    return page(
      input.limit,
      result.rows,
      (row) => ({
        activeOfferCount: Number(row.active_offer_count),
        displayName: row.display_name,
        lastSyncAt: row.last_sync_at,
        lastSyncStatus: row.last_sync_status,
        productCount: Number(row.product_count),
        supplierCode: row.supplier_code,
        supplierId: row.id,
      }),
      (row) => ({ id: row.id, sortValue: row.display_name.toLowerCase() }),
    );
  }

  public async listSupportCases(
    input: AdminRepositoryListInput,
  ): Promise<AdminOperationsPage<AdminSupportCaseSummary>> {
    const values: unknown[] = [];
    const predicates: string[] = [];
    const parameter = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (input.search)
      predicates.push(
        `(support.id::text = ${parameter(input.search)} OR support.order_id::text = ${parameter(input.search)} OR customer.email_normalized ILIKE ${parameter(like(input.search))} ESCAPE '\\')`,
      );
    if (input.status)
      predicates.push(`support.status = ${parameter(input.status)}`);
    if (input.after)
      predicates.push(
        `(support.updated_at, support.id) < (${parameter(input.after.sortValue)}::timestamptz, ${parameter(input.after.id)}::uuid)`,
      );
    const result = await this.database.query<{
      readonly id: string;
      readonly customer_email: string | null;
      readonly order_id: string | null;
      readonly category: string;
      readonly status: string;
      readonly priority: string;
      readonly updated_at: Date;
    }>(
      `
      SELECT support.id::text, customer.email_normalized AS customer_email, support.order_id::text,
        support.category, support.status, support.priority, support.updated_at
      FROM support_cases support
      LEFT JOIN keycore_customers customer ON customer.id = support.customer_id
      ${where(predicates)}
      ORDER BY support.updated_at DESC, support.id DESC
      LIMIT ${parameter(input.limit + 1)}
    `,
      values,
    );
    return page(
      input.limit,
      result.rows,
      (row) => ({
        caseId: row.id,
        category: row.category,
        customerEmail: row.customer_email,
        orderId: row.order_id,
        priority: row.priority,
        status: row.status,
        updatedAt: row.updated_at,
      }),
      (row) => ({ id: row.id, sortValue: row.updated_at.toISOString() }),
    );
  }

  public async listFraudReviews(
    input: AdminRepositoryListInput,
  ): Promise<AdminOperationsPage<AdminFraudReviewSummary>> {
    const values: unknown[] = [];
    const predicates: string[] = [];
    const parameter = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (input.search)
      predicates.push(
        `(review.id::text = ${parameter(input.search)} OR review.order_id::text = ${parameter(input.search)})`,
      );
    if (input.status)
      predicates.push(`review.status = ${parameter(input.status)}`);
    if (input.after)
      predicates.push(
        `(review.opened_at, review.id) < (${parameter(input.after.sortValue)}::timestamptz, ${parameter(input.after.id)}::uuid)`,
      );
    const result = await this.database.query<{
      readonly id: string;
      readonly order_id: string;
      readonly status: string;
      readonly reason_codes: string[];
      readonly opened_at: Date;
      readonly resolved_at: Date | null;
    }>(
      `
      SELECT review.id::text, review.order_id::text, review.status, review.reason_codes, review.opened_at, review.resolved_at
      FROM fraud_manual_review_cases review
      ${where(predicates)}
      ORDER BY review.opened_at DESC, review.id DESC
      LIMIT ${parameter(input.limit + 1)}
    `,
      values,
    );
    return page(
      input.limit,
      result.rows,
      (row) => ({
        openedAt: row.opened_at,
        orderId: row.order_id,
        reasonCodes: row.reason_codes,
        resolvedAt: row.resolved_at,
        reviewId: row.id,
        status: row.status,
      }),
      (row) => ({ id: row.id, sortValue: row.opened_at.toISOString() }),
    );
  }

  public async listOperationsControls(): Promise<
    readonly AdminOperationsControlSummary[]
  > {
    const result = await this.database.query<{
      readonly capability: string;
      readonly state: "ENABLED" | "PAUSED";
      readonly reason_code: string | null;
      readonly record_version: number;
      readonly updated_at: Date;
    }>(
      `SELECT capability, state, reason_code, record_version, updated_at FROM operations_controls ORDER BY capability ASC`,
    );
    return result.rows.map((row) => ({
      capability: row.capability,
      reasonCode: row.reason_code,
      recordVersion: row.record_version,
      state: row.state,
      updatedAt: row.updated_at,
    }));
  }

  public async financeSummary(): Promise<
    readonly AdminFinanceCurrencySummary[]
  > {
    const result = await this.database.query<{
      readonly currency: string;
      readonly captured_amount_minor: string;
      readonly refunded_amount_minor: string;
      readonly captured_orders: string;
      readonly refunded_orders: string;
      readonly partially_refunded_orders: string;
    }>(
      `
      SELECT currency,
        COALESCE(sum(customer_amount_minor) FILTER (WHERE payment_status = ANY($1::text[])), 0)::text AS captured_amount_minor,
        COALESCE(sum(customer_amount_minor) FILTER (WHERE payment_status = 'REFUNDED'), 0)::text AS refunded_amount_minor,
        count(*) FILTER (WHERE payment_status = ANY($1::text[]))::text AS captured_orders,
        count(*) FILTER (WHERE payment_status = 'REFUNDED')::text AS refunded_orders,
        count(*) FILTER (WHERE payment_status = 'PARTIALLY_REFUNDED')::text AS partially_refunded_orders
      FROM keycore_orders GROUP BY currency ORDER BY currency ASC
    `,
      [adminCapturedPaymentVolumeStates],
    );
    return result.rows.map((row) => ({
      capturedAmountMinor: row.captured_amount_minor,
      capturedOrders: Number(row.captured_orders),
      currency: row.currency,
      partiallyRefundedOrders: Number(row.partially_refunded_orders),
      refundedAmountMinor: row.refunded_amount_minor,
      refundedOrders: Number(row.refunded_orders),
    }));
  }
}

const where = (predicates: readonly string[]): string =>
  predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";

const customerSort = (
  sort: AdminCustomerSort,
): {
  readonly cast: (parameter: string) => string;
  readonly comparator: "<" | ">";
  readonly direction: "ASC" | "DESC";
  readonly expression: string;
} => {
  if (sort === "OLDEST")
    return {
      cast: (parameter) => `${parameter}::timestamptz`,
      comparator: ">",
      direction: "ASC",
      expression: "customer.created_at",
    };
  if (sort === "EMAIL_ASC")
    return {
      cast: (parameter) => parameter,
      comparator: ">",
      direction: "ASC",
      expression: "lower(customer.email_normalized)",
    };
  if (sort === "EMAIL_DESC")
    return {
      cast: (parameter) => parameter,
      comparator: "<",
      direction: "DESC",
      expression: "lower(customer.email_normalized)",
    };
  return {
    cast: (parameter) => `${parameter}::timestamptz`,
    comparator: "<",
    direction: "DESC",
    expression: "customer.created_at",
  };
};

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Expected database result row");
  return value;
};

const like = (value: string): string =>
  `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;

const page = <TRow, TItem>(
  limit: number,
  rows: readonly TRow[],
  map: (row: TRow) => TItem,
  cursor: (row: TRow) => { readonly sortValue: string; readonly id: string },
): AdminOperationsPage<TItem> => {
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(map),
    ...(rows.length > limit && last ? { nextCursor: cursor(last) } : {}),
  };
};
