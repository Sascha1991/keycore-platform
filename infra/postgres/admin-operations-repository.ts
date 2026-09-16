import type {
  AdminCustomerSummary,
  AdminCustomerRepositoryListInput,
  AdminCustomerSort,
  AdminFinanceCurrencySummary,
  AdminFraudReviewSummary,
  AdminOperationsControlSummary,
  AdminOperationsPage,
  AdminOperationsRepository,
  AdminProductDetail,
  AdminProductRepositoryListInput,
  AdminProductSort,
  AdminRepositoryListInput,
  AdminSupplierDetail,
  AdminSupplierRepositoryListInput,
  AdminSupplierSort,
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
    if (input.orderPresence === "WITH_CAPTURED_PAYMENT")
      basePredicates.push(
        `EXISTS (SELECT 1 FROM keycore_orders owned_order WHERE owned_order.customer_id = customer.id AND owned_order.payment_status = ANY(${parameter(adminCapturedPaymentVolumeStates)}::text[]))`,
      );
    if (input.registrationWindow === "LAST_30_DAYS")
      basePredicates.push(
        "customer.created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days' AND customer.created_at <= CURRENT_TIMESTAMP",
      );
    if (input.registeredFrom)
      basePredicates.push(
        `customer.created_at >= ${parameter(input.registeredFrom)}`,
      );
    if (input.registeredTo)
      basePredicates.push(
        `customer.created_at <= ${parameter(input.registeredTo)}`,
      );

    const countValues = [...values];
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
    const [result, countResult, metricResult, paymentVolumeResult] =
      await Promise.all([
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
        this.database.query<{ readonly total_customers: string }>(
          `SELECT count(*)::text AS total_customers FROM keycore_customers customer ${baseWhere}`,
          countValues,
        ),
        this.database.query<{
          readonly customers_with_orders: string;
          readonly new_customers_last_30_days: string;
          readonly total_customers: string;
          readonly verified_customers: string;
        }>(`
          SELECT
            count(*)::text AS total_customers,
            count(*) FILTER (WHERE customer.email_verification_state = 'VERIFIED')::text AS verified_customers,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM keycore_orders owned_order
              WHERE owned_order.customer_id = customer.id
            ))::text AS customers_with_orders,
            count(*) FILTER (
              WHERE customer.created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'
                AND customer.created_at <= CURRENT_TIMESTAMP
            )::text AS new_customers_last_30_days
          FROM keycore_customers customer
        `),
        this.database.query<{
          readonly amount_minor: string;
          readonly currency: string;
        }>(
          `
          SELECT owned_order.currency,
            COALESCE(sum(owned_order.customer_amount_minor), 0)::text AS amount_minor
          FROM keycore_orders owned_order
          WHERE owned_order.customer_id IS NOT NULL
            AND owned_order.payment_status = ANY($1::text[])
          GROUP BY owned_order.currency
          ORDER BY owned_order.currency ASC
        `,
          [adminCapturedPaymentVolumeStates],
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
    const count = required(countResult.rows[0]);
    const metrics = required(metricResult.rows[0]);
    return {
      ...paged,
      metrics: {
        capturedPaymentVolumes: paymentVolumeResult.rows.map((row) => ({
          amountMinor: row.amount_minor,
          currency: row.currency,
        })),
        customersWithOrders: Number(metrics.customers_with_orders),
        newCustomersLast30Days: Number(metrics.new_customers_last_30_days),
        totalCustomers: Number(metrics.total_customers),
        verifiedCustomers: Number(metrics.verified_customers),
      },
      totalCount: Number(count.total_customers),
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

  public async listProducts(input: AdminProductRepositoryListInput) {
    const values: unknown[] = [];
    const basePredicates: string[] = [];
    const parameter = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (input.search)
      basePredicates.push(
        `(product.id::text = ${parameter(input.search)} OR product.title ILIKE ${parameter(like(input.search))} ESCAPE '\\' OR EXISTS (SELECT 1 FROM canonical_product_identifiers identifier WHERE identifier.product_id = product.id AND identifier.verified = true AND identifier.identifier_value ILIKE ${parameter(like(input.search))} ESCAPE '\\'))`,
      );
    if (input.lifecycle)
      basePredicates.push(`product.lifecycle = ${parameter(input.lifecycle)}`);
    if (input.platform)
      basePredicates.push(
        `upper(product.platform) = upper(${parameter(input.platform)})`,
      );
    if (input.productType)
      basePredicates.push(
        `product.product_type = ${parameter(input.productType)}`,
      );
    const hasOffer =
      "EXISTS (SELECT 1 FROM offers current_offer JOIN supplier_offers current_supplier_offer ON current_supplier_offer.id = current_offer.supplier_offer_id WHERE current_offer.product_id = product.id AND current_supplier_offer.active = true)";
    const hasAvailableOffer =
      "EXISTS (SELECT 1 FROM offers current_offer JOIN supplier_offers current_supplier_offer ON current_supplier_offer.id = current_offer.supplier_offer_id WHERE current_offer.product_id = product.id AND current_supplier_offer.active = true AND current_offer.availability IN ('IN_STOCK', 'LIMITED'))";
    const isPublished =
      "EXISTS (SELECT 1 FROM storefront_publications publication WHERE publication.product_id = product.id AND publication.state = 'PUBLISHED')";
    if (input.offerState)
      basePredicates.push(
        input.offerState === "WITH_OFFERS" ? hasOffer : `NOT ${hasOffer}`,
      );
    if (input.availability)
      basePredicates.push(
        input.availability === "AVAILABLE"
          ? hasAvailableOffer
          : `NOT ${hasAvailableOffer}`,
      );
    if (input.publication)
      basePredicates.push(
        input.publication === "PUBLISHED" ? isPublished : `NOT ${isPublished}`,
      );
    if (input.quickView === "ACTIVE")
      basePredicates.push("product.active = true");
    if (input.quickView === "WITH_OFFERS") basePredicates.push(hasOffer);
    if (input.quickView === "AVAILABLE") basePredicates.push(hasAvailableOffer);
    const countValues = [...values];
    const predicates = [...basePredicates];
    const sort = productSort(input.sort);
    if (input.after) {
      const sortValue = parameter(input.after.sortValue);
      const id = parameter(input.after.id);
      predicates.push(
        `(${sort.expression}, product.id) ${sort.comparator} (${sort.cast(sortValue)}, ${id}::uuid)`,
      );
    }
    const [result, countResult, metricResult] = await Promise.all([
      this.database.query<{
        readonly id: string;
        readonly title: string;
        readonly product_type: string;
        readonly platform: string;
        readonly lifecycle: string;
        readonly active: boolean;
        readonly offer_count: string;
        readonly available_offer_count: string;
        readonly supplier_count: string;
        readonly publication_state: "PUBLISHED" | "UNPUBLISHED";
        readonly updated_at: Date;
      }>(
        `
      SELECT product.id::text, product.title, product.product_type, product.platform, product.lifecycle, product.active,
        count(offer.id) FILTER (WHERE supplier_offer.active = true)::text AS offer_count,
        count(offer.id) FILTER (WHERE offer.availability IN ('IN_STOCK', 'LIMITED') AND supplier_offer.active = true)::text AS available_offer_count,
        count(DISTINCT supplier_offer.supplier_id) FILTER (WHERE supplier_offer.active = true)::text AS supplier_count,
        CASE WHEN ${isPublished} THEN 'PUBLISHED' ELSE 'UNPUBLISHED' END AS publication_state,
        product.updated_at
      FROM products product
      LEFT JOIN offers offer ON offer.product_id = product.id
      LEFT JOIN supplier_offers supplier_offer ON supplier_offer.id = offer.supplier_offer_id
      ${where(predicates)}
      GROUP BY product.id
      ORDER BY ${sort.expression} ${sort.direction}, product.id ${sort.direction}
      LIMIT ${parameter(input.limit + 1)}
    `,
        values,
      ),
      this.database.query<{ readonly total_products: string }>(
        `SELECT count(*)::text AS total_products FROM products product ${where(basePredicates)}`,
        countValues,
      ),
      this.database.query<{
        readonly total_products: string;
        readonly active_products: string;
        readonly products_with_offers: string;
        readonly available_products: string;
      }>(`
        SELECT count(*)::text AS total_products,
          count(*) FILTER (WHERE product.active = true)::text AS active_products,
          count(*) FILTER (WHERE ${hasOffer})::text AS products_with_offers,
          count(*) FILTER (WHERE ${hasAvailableOffer})::text AS available_products
        FROM products product
      `),
    ]);
    const paged = page(
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
        publicationState: row.publication_state,
        supplierCount: Number(row.supplier_count),
        title: row.title,
        updatedAt: row.updated_at,
      }),
      (row) => ({
        id: row.id,
        sortValue: input.sort.startsWith("TITLE_")
          ? row.title.toLowerCase()
          : row.updated_at.toISOString(),
      }),
    );
    const count = required(countResult.rows[0]);
    const metrics = required(metricResult.rows[0]);
    return {
      ...paged,
      metrics: {
        activeProducts: Number(metrics.active_products),
        availableProducts: Number(metrics.available_products),
        productsWithOffers: Number(metrics.products_with_offers),
        totalProducts: Number(metrics.total_products),
      },
      totalCount: Number(count.total_products),
    };
  }

  public async findProduct(
    productId: string,
  ): Promise<AdminProductDetail | null> {
    const productResult = await this.database.query<{
      readonly id: string;
      readonly title: string;
      readonly product_type: string;
      readonly platform: string;
      readonly lifecycle: string;
      readonly active: boolean;
      readonly offer_count: string;
      readonly available_offer_count: string;
      readonly supplier_count: string;
      readonly publication_state: "PUBLISHED" | "UNPUBLISHED";
      readonly created_at: Date;
      readonly updated_at: Date;
    }>(
      `
      SELECT product.id::text, product.title, product.product_type, product.platform,
        product.lifecycle, product.active, product.created_at, product.updated_at,
        count(offer.id) FILTER (WHERE supplier_offer.active = true)::text AS offer_count,
        count(offer.id) FILTER (WHERE supplier_offer.active = true AND offer.availability IN ('IN_STOCK', 'LIMITED'))::text AS available_offer_count,
        count(DISTINCT supplier_offer.supplier_id) FILTER (WHERE supplier_offer.active = true)::text AS supplier_count,
        CASE WHEN EXISTS (SELECT 1 FROM storefront_publications publication WHERE publication.product_id = product.id AND publication.state = 'PUBLISHED') THEN 'PUBLISHED' ELSE 'UNPUBLISHED' END AS publication_state
      FROM products product
      LEFT JOIN offers offer ON offer.product_id = product.id
      LEFT JOIN supplier_offers supplier_offer ON supplier_offer.id = offer.supplier_offer_id
      WHERE product.id = $1::uuid
      GROUP BY product.id
    `,
      [productId],
    );
    const product = productResult.rows[0];
    if (!product) return null;
    const [identifierResult, offerResult, publicationResult] =
      await Promise.all([
        this.database.query<{
          readonly identifier_type: string;
          readonly identifier_value: string;
          readonly verified: boolean;
        }>(
          `
        SELECT identifier_type, identifier_value, verified
        FROM canonical_product_identifiers
        WHERE product_id = $1::uuid
        ORDER BY verified DESC, identifier_type ASC, identifier_value ASC
        LIMIT 25
      `,
          [productId],
        ),
        this.database.query<{
          readonly offer_id: string;
          readonly supplier_name: string;
          readonly supplier_offer_reference: string;
          readonly availability: string;
          readonly active: boolean;
          readonly updated_at: Date;
        }>(
          `
        SELECT offer.id::text AS offer_id, supplier.display_name AS supplier_name,
          supplier_offer.supplier_offer_id AS supplier_offer_reference,
          offer.availability, supplier_offer.active, GREATEST(offer.updated_at, supplier_offer.updated_at) AS updated_at
        FROM offers offer
        JOIN supplier_offers supplier_offer ON supplier_offer.id = offer.supplier_offer_id
        JOIN suppliers supplier ON supplier.id = supplier_offer.supplier_id
        WHERE offer.product_id = $1::uuid
        ORDER BY supplier_offer.active DESC, offer.updated_at DESC, offer.id DESC
        LIMIT 25
      `,
          [productId],
        ),
        this.database.query<{ readonly storefront: string }>(
          `
        SELECT storefront FROM storefront_publications
        WHERE product_id = $1::uuid AND state = 'PUBLISHED'
        ORDER BY storefront ASC LIMIT 25
      `,
          [productId],
        ),
      ]);
    return {
      active: product.active,
      availableOfferCount: Number(product.available_offer_count),
      createdAt: product.created_at,
      identifiers: identifierResult.rows.map((row) => ({
        type: row.identifier_type,
        value: row.identifier_value,
        verified: row.verified,
      })),
      lifecycle: product.lifecycle,
      offerCount: Number(product.offer_count),
      offers: offerResult.rows.map((row) => ({
        active: row.active,
        availability: row.availability,
        offerId: row.offer_id,
        supplierName: row.supplier_name,
        supplierOfferReference: row.supplier_offer_reference,
        updatedAt: row.updated_at,
      })),
      platform: product.platform,
      productId: product.id,
      productType: product.product_type,
      publicationState: product.publication_state,
      publicationStorefronts: publicationResult.rows.map(
        (row) => row.storefront,
      ),
      supplierCount: Number(product.supplier_count),
      title: product.title,
      updatedAt: product.updated_at,
    };
  }

  public async listSuppliers(input: AdminSupplierRepositoryListInput) {
    const requestedSort = input.sort ?? "NAME_ASC";
    const values: unknown[] = [];
    const basePredicates: string[] = [];
    const parameter = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (input.search)
      basePredicates.push(
        `(supplier.id::text = ${parameter(input.search)} OR supplier.display_name ILIKE ${parameter(like(input.search))} ESCAPE '\\' OR supplier.supplier_code ILIKE ${parameter(like(input.search))} ESCAPE '\\')`,
      );
    const hasProducts =
      "EXISTS (SELECT 1 FROM supplier_products filtered_product WHERE filtered_product.supplier_id = supplier.id)";
    const hasOffers =
      "EXISTS (SELECT 1 FROM supplier_offers filtered_offer WHERE filtered_offer.supplier_id = supplier.id AND filtered_offer.active = true)";
    const hasAvailableOffers =
      "EXISTS (SELECT 1 FROM supplier_offers filtered_offer JOIN offers filtered_canonical_offer ON filtered_canonical_offer.supplier_offer_id = filtered_offer.id WHERE filtered_offer.supplier_id = supplier.id AND filtered_offer.active = true AND filtered_canonical_offer.availability IN ('IN_STOCK', 'LIMITED'))";
    const hasOpenMappings =
      "EXISTS (SELECT 1 FROM supplier_product_canonical_mappings filtered_mapping WHERE filtered_mapping.supplier_id = supplier.id AND filtered_mapping.state = 'REVIEW_REQUIRED')";
    const latestSyncStatus =
      "(SELECT filtered_run.status FROM catalog_sync_runs filtered_run WHERE filtered_run.supplier_id = supplier.id ORDER BY filtered_run.started_at DESC, filtered_run.id DESC LIMIT 1)";
    if (input.sync)
      basePredicates.push(
        input.sync === "NEVER"
          ? `NOT EXISTS (SELECT 1 FROM catalog_sync_runs filtered_run WHERE filtered_run.supplier_id = supplier.id)`
          : `${latestSyncStatus} = ${parameter(input.sync)}`,
      );
    if (input.catalog)
      basePredicates.push(
        input.catalog === "WITH_PRODUCTS"
          ? hasProducts
          : input.catalog === "WITHOUT_PRODUCTS"
            ? `NOT ${hasProducts}`
            : hasOpenMappings,
      );
    if (input.offers)
      basePredicates.push(
        input.offers === "WITH_OFFERS"
          ? hasOffers
          : input.offers === "WITHOUT_OFFERS"
            ? `NOT ${hasOffers}`
            : input.offers === "AVAILABLE"
              ? hasAvailableOffers
              : `${hasOffers} AND NOT ${hasAvailableOffers}`,
      );
    if (input.quickView === "ATTENTION")
      basePredicates.push(
        `(${latestSyncStatus} = 'FAILED' OR ${hasOpenMappings})`,
      );
    if (input.quickView === "WITH_PRODUCTS") basePredicates.push(hasProducts);
    if (input.quickView === "WITH_OFFERS") basePredicates.push(hasOffers);
    const countValues = [...values];
    const predicates = [...basePredicates];
    const sort = supplierSort(requestedSort);
    if (input.after)
      predicates.push(
        `(${sort.expression}, supplier.id) ${sort.comparator} (${sort.cast(parameter(input.after.sortValue))}, ${parameter(input.after.id)}::uuid)`,
      );
    const result = await this.database.query<{
      readonly id: string;
      readonly supplier_code: string;
      readonly display_name: string;
      readonly record_version: number;
      readonly product_count: string;
      readonly mapped_product_count: string;
      readonly review_required_count: string;
      readonly current_offer_count: string;
      readonly available_offer_count: string;
      readonly latest_sync_status: string | null;
      readonly latest_sync_at: Date | null;
      readonly last_successful_sync_at: Date | null;
      readonly updated_at: Date;
      readonly integration_id: string | null;
      readonly integration_adapter_type: string | null;
      readonly integration_status: string | null;
      readonly integration_capabilities: Record<string, unknown> | null;
      readonly integration_record_version: number | null;
      readonly integration_created_at: Date | null;
      readonly integration_updated_at: Date | null;
    }>(
      `
      WITH selected_suppliers AS (
        SELECT supplier.id, supplier.supplier_code, supplier.display_name, supplier.record_version, supplier.updated_at
        FROM suppliers supplier
        ${where(predicates)}
        ORDER BY ${sort.expression} ${sort.direction}, supplier.id ${sort.direction}
        LIMIT ${parameter(input.limit + 1)}
      )
      SELECT supplier.id::text, supplier.supplier_code, supplier.display_name, supplier.record_version, supplier.updated_at,
        product_stats.product_count,
        mapping_stats.mapped_product_count, mapping_stats.review_required_count,
        offer_stats.current_offer_count, offer_stats.available_offer_count,
        latest_sync.status AS latest_sync_status, latest_sync.started_at AS latest_sync_at,
        last_success.started_at AS last_successful_sync_at,
        integration.id::text AS integration_id, integration.adapter_type AS integration_adapter_type,
        integration.status AS integration_status, integration.capabilities AS integration_capabilities,
        integration.record_version AS integration_record_version,
        integration.created_at AS integration_created_at, integration.updated_at AS integration_updated_at
      FROM selected_suppliers supplier
      LEFT JOIN supplier_integrations integration ON integration.supplier_id = supplier.id
      LEFT JOIN LATERAL (
        SELECT count(*)::text AS product_count
        FROM supplier_products supplier_product
        WHERE supplier_product.supplier_id = supplier.id
      ) product_stats ON true
      LEFT JOIN LATERAL (
        SELECT
          count(*) FILTER (WHERE mapping.product_id IS NOT NULL AND mapping.state IN ('AUTO_MATCHED', 'MANUAL_MATCHED'))::text AS mapped_product_count,
          count(*) FILTER (WHERE mapping.state = 'REVIEW_REQUIRED')::text AS review_required_count
        FROM supplier_product_canonical_mappings mapping
        WHERE mapping.supplier_id = supplier.id
      ) mapping_stats ON true
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE supplier_offer.active = true)::text AS current_offer_count,
          count(*) FILTER (WHERE supplier_offer.active = true AND canonical_offer.availability IN ('IN_STOCK', 'LIMITED'))::text AS available_offer_count
        FROM supplier_offers supplier_offer
        LEFT JOIN offers canonical_offer ON canonical_offer.supplier_offer_id = supplier_offer.id
        WHERE supplier_offer.supplier_id = supplier.id
      ) offer_stats ON true
      LEFT JOIN LATERAL (
        SELECT status, started_at FROM catalog_sync_runs run
        WHERE run.supplier_id = supplier.id ORDER BY started_at DESC, id DESC LIMIT 1
      ) latest_sync ON true
      LEFT JOIN LATERAL (
        SELECT started_at FROM catalog_sync_runs run
        WHERE run.supplier_id = supplier.id AND run.status = 'SUCCEEDED'
        ORDER BY started_at DESC, id DESC LIMIT 1
      ) last_success ON true
      ORDER BY ${sort.expression} ${sort.direction}, supplier.id ${sort.direction}
    `,
      values,
    );
    const countResult = await this.database.query<{
      readonly total_count: string;
    }>(
      `SELECT count(*)::text AS total_count FROM suppliers supplier ${where(basePredicates)}`,
      countValues,
    );
    const metricResult = await this.database.query<{
      readonly total_suppliers: string;
      readonly suppliers_with_products: string;
      readonly suppliers_with_offers: string;
      readonly suppliers_requiring_attention: string;
    }>(`
      SELECT count(*)::text AS total_suppliers,
        count(*) FILTER (WHERE ${hasProducts})::text AS suppliers_with_products,
        count(*) FILTER (WHERE ${hasOffers})::text AS suppliers_with_offers,
        count(*) FILTER (WHERE ${latestSyncStatus} = 'FAILED' OR ${hasOpenMappings})::text AS suppliers_requiring_attention
      FROM suppliers supplier
    `);
    const paged = page(
      input.limit,
      result.rows,
      (row) => ({
        availableOfferCount: Number(row.available_offer_count),
        currentOfferCount: Number(row.current_offer_count),
        displayName: row.display_name,
        lastSuccessfulSyncAt: row.last_successful_sync_at,
        latestSyncAt: row.latest_sync_at,
        latestSyncStatus: row.latest_sync_status,
        mappedProductCount: Number(row.mapped_product_count),
        productCount: Number(row.product_count),
        recordVersion: row.record_version,
        reviewRequiredCount: Number(row.review_required_count),
        supplierCode: row.supplier_code,
        supplierId: row.id,
        updatedAt: row.updated_at,
        integration: supplierIntegration(row),
      }),
      (row) => ({
        id: row.id,
        sortValue: requestedSort.startsWith("NAME_")
          ? row.display_name.toLowerCase()
          : row.updated_at.toISOString(),
      }),
    );
    const count = required(countResult.rows[0]);
    const metrics = required(metricResult.rows[0]);
    return {
      ...paged,
      metrics: {
        suppliersRequiringAttention: Number(
          metrics.suppliers_requiring_attention,
        ),
        suppliersWithOffers: Number(metrics.suppliers_with_offers),
        suppliersWithProducts: Number(metrics.suppliers_with_products),
        totalSuppliers: Number(metrics.total_suppliers),
      },
      totalCount: Number(count.total_count),
    };
  }

  public async findSupplier(
    supplierId: string,
  ): Promise<AdminSupplierDetail | null> {
    const core = await this.database.query<{
      readonly id: string;
      readonly supplier_code: string;
      readonly display_name: string;
      readonly record_version: number;
      readonly capabilities: Record<string, unknown>;
      readonly created_at: Date;
      readonly updated_at: Date;
      readonly product_count: string;
      readonly mapped_product_count: string;
      readonly review_required_count: string;
      readonly current_offer_count: string;
      readonly available_offer_count: string;
      readonly latest_sync_status: string | null;
      readonly latest_sync_at: Date | null;
      readonly last_successful_sync_at: Date | null;
      readonly integration_id: string | null;
      readonly integration_adapter_type: string | null;
      readonly integration_status: string | null;
      readonly integration_capabilities: Record<string, unknown> | null;
      readonly integration_record_version: number | null;
      readonly integration_created_at: Date | null;
      readonly integration_updated_at: Date | null;
    }>(
      `
      SELECT supplier.id::text, supplier.supplier_code, supplier.display_name, supplier.record_version,
        supplier.capabilities, supplier.created_at, supplier.updated_at,
        (SELECT count(*)::text FROM supplier_products product WHERE product.supplier_id = supplier.id) AS product_count,
        (SELECT count(*)::text FROM supplier_product_canonical_mappings mapping WHERE mapping.supplier_id = supplier.id AND mapping.product_id IS NOT NULL AND mapping.state IN ('AUTO_MATCHED', 'MANUAL_MATCHED')) AS mapped_product_count,
        (SELECT count(*)::text FROM supplier_product_canonical_mappings mapping WHERE mapping.supplier_id = supplier.id AND mapping.state = 'REVIEW_REQUIRED') AS review_required_count,
        (SELECT count(*)::text FROM supplier_offers supplier_offer WHERE supplier_offer.supplier_id = supplier.id AND supplier_offer.active = true) AS current_offer_count,
        (SELECT count(*)::text FROM supplier_offers supplier_offer JOIN offers canonical_offer ON canonical_offer.supplier_offer_id = supplier_offer.id WHERE supplier_offer.supplier_id = supplier.id AND supplier_offer.active = true AND canonical_offer.availability IN ('IN_STOCK', 'LIMITED')) AS available_offer_count,
        (SELECT run.status FROM catalog_sync_runs run WHERE run.supplier_id = supplier.id ORDER BY run.started_at DESC, run.id DESC LIMIT 1) AS latest_sync_status,
        (SELECT run.started_at FROM catalog_sync_runs run WHERE run.supplier_id = supplier.id ORDER BY run.started_at DESC, run.id DESC LIMIT 1) AS latest_sync_at,
        (SELECT run.started_at FROM catalog_sync_runs run WHERE run.supplier_id = supplier.id AND run.status = 'SUCCEEDED' ORDER BY run.started_at DESC, run.id DESC LIMIT 1) AS last_successful_sync_at,
        integration.id::text AS integration_id, integration.adapter_type AS integration_adapter_type,
        integration.status AS integration_status, integration.capabilities AS integration_capabilities,
        integration.record_version AS integration_record_version,
        integration.created_at AS integration_created_at, integration.updated_at AS integration_updated_at
      FROM suppliers supplier
      LEFT JOIN supplier_integrations integration ON integration.supplier_id = supplier.id
      WHERE supplier.id = $1::uuid
    `,
      [supplierId],
    );
    const supplier = core.rows[0];
    if (!supplier) return null;
    const syncRuns = await this.database.query<{
      readonly id: string;
      readonly mode: string;
      readonly status: string;
      readonly started_at: Date;
      readonly completed_at: Date | null;
      readonly failed_at: Date | null;
    }>(
      `SELECT id::text, mode, status, started_at, completed_at, failed_at FROM catalog_sync_runs WHERE supplier_id = $1::uuid ORDER BY started_at DESC, id DESC LIMIT 10`,
      [supplierId],
    );
    const offers = await this.database.query<{
      readonly id: string;
      readonly supplier_offer_id: string;
      readonly supplier_product_title: string;
      readonly canonical_product_title: string | null;
      readonly availability: string;
      readonly active: boolean;
      readonly updated_at: Date;
    }>(
      `
        SELECT supplier_offer.id::text, supplier_offer.supplier_offer_id,
          supplier_product.title AS supplier_product_title, product.title AS canonical_product_title,
          COALESCE(canonical_offer.availability, 'UNKNOWN') AS availability,
          supplier_offer.active, GREATEST(supplier_offer.updated_at, COALESCE(canonical_offer.updated_at, supplier_offer.updated_at)) AS updated_at
        FROM supplier_offers supplier_offer
        JOIN supplier_products supplier_product ON supplier_product.id = supplier_offer.supplier_product_id
        LEFT JOIN offers canonical_offer ON canonical_offer.supplier_offer_id = supplier_offer.id
        LEFT JOIN products product ON product.id = canonical_offer.product_id
        WHERE supplier_offer.supplier_id = $1::uuid
        ORDER BY supplier_offer.updated_at DESC, supplier_offer.id DESC LIMIT 25
      `,
      [supplierId],
    );
    return {
      availableOfferCount: Number(supplier.available_offer_count),
      capabilities: Object.entries(supplier.capabilities ?? {})
        .filter(([, enabled]) => enabled === true)
        .map(([capability]) => capability)
        .sort(),
      createdAt: supplier.created_at,
      currentOfferCount: Number(supplier.current_offer_count),
      displayName: supplier.display_name,
      lastSuccessfulSyncAt: supplier.last_successful_sync_at,
      latestSyncAt: supplier.latest_sync_at,
      latestSyncStatus: supplier.latest_sync_status,
      mappedProductCount: Number(supplier.mapped_product_count),
      productCount: Number(supplier.product_count),
      recordVersion: supplier.record_version,
      recentOffers: offers.rows.map((row) => ({
        active: row.active,
        availability: row.availability,
        canonicalProductTitle: row.canonical_product_title,
        offerId: row.id,
        supplierOfferReference: row.supplier_offer_id,
        supplierProductTitle: row.supplier_product_title,
        updatedAt: row.updated_at,
      })),
      recentSyncRuns: syncRuns.rows.map((row) => ({
        completedAt: row.completed_at,
        failedAt: row.failed_at,
        mode: row.mode,
        runId: row.id,
        startedAt: row.started_at,
        status: row.status,
      })),
      reviewRequiredCount: Number(supplier.review_required_count),
      supplierCode: supplier.supplier_code,
      supplierId: supplier.id,
      updatedAt: supplier.updated_at,
      integration: supplierIntegration(supplier),
    };
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

const productSort = (
  sort: AdminProductSort,
): {
  readonly cast: (parameter: string) => string;
  readonly comparator: "<" | ">";
  readonly direction: "ASC" | "DESC";
  readonly expression: string;
} => {
  if (sort === "TITLE_DESC")
    return {
      cast: (parameter) => parameter,
      comparator: "<",
      direction: "DESC",
      expression: "lower(product.title)",
    };
  if (sort === "UPDATED_ASC")
    return {
      cast: (parameter) => `${parameter}::timestamptz`,
      comparator: ">",
      direction: "ASC",
      expression: "product.updated_at",
    };
  if (sort === "UPDATED_DESC")
    return {
      cast: (parameter) => `${parameter}::timestamptz`,
      comparator: "<",
      direction: "DESC",
      expression: "product.updated_at",
    };
  return {
    cast: (parameter) => parameter,
    comparator: ">",
    direction: "ASC",
    expression: "lower(product.title)",
  };
};

const supplierSort = (
  sort: AdminSupplierSort,
): {
  readonly cast: (parameter: string) => string;
  readonly comparator: "<" | ">";
  readonly direction: "ASC" | "DESC";
  readonly expression: string;
} => {
  if (sort === "NAME_DESC")
    return {
      cast: (parameter) => parameter,
      comparator: "<",
      direction: "DESC",
      expression: "lower(supplier.display_name)",
    };
  if (sort === "UPDATED_ASC")
    return {
      cast: (parameter) => `${parameter}::timestamptz`,
      comparator: ">",
      direction: "ASC",
      expression: "supplier.updated_at",
    };
  if (sort === "UPDATED_DESC")
    return {
      cast: (parameter) => `${parameter}::timestamptz`,
      comparator: "<",
      direction: "DESC",
      expression: "supplier.updated_at",
    };
  return {
    cast: (parameter) => parameter,
    comparator: ">",
    direction: "ASC",
    expression: "lower(supplier.display_name)",
  };
};

interface SupplierIntegrationRow {
  readonly integration_id: string | null;
  readonly integration_adapter_type: string | null;
  readonly integration_status: string | null;
  readonly integration_capabilities: Record<string, unknown> | null;
  readonly integration_record_version: number | null;
  readonly integration_created_at: Date | null;
  readonly integration_updated_at: Date | null;
}

const supplierIntegration = (row: SupplierIntegrationRow) => {
  if (
    !row.integration_id ||
    !row.integration_adapter_type ||
    !row.integration_status ||
    !row.integration_record_version ||
    !row.integration_created_at ||
    !row.integration_updated_at
  )
    return null;
  const capabilities = Object.entries(row.integration_capabilities ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([capability]) => capability)
    .sort();
  return {
    adapterType: row.integration_adapter_type,
    capabilities,
    createdAt: row.integration_created_at,
    credentialsConfigured: false,
    integrationId: row.integration_id,
    recordVersion: row.integration_record_version,
    status: row.integration_status,
    supportsConnectionTest: false,
    supportsManualSync: false,
    updatedAt: row.integration_updated_at,
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
