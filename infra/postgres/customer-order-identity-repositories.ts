import {
  customerId,
  maskCustomerEmail,
  orderId,
  type CustomerId,
  type CustomerIdentityBinding,
  type CustomerIdentityBindingRepositoryResult,
  type CustomerIdentityProvider,
  type CustomerInspection,
  type CustomerOrderIdentityRepository,
  type EmailVerificationState,
  type KeyCoreCustomer,
  type OrderId,
  type OrderOwnershipBindingRepositoryResult,
  type OrderOwnershipInspection,
  type OwnedOrderSnapshot,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface CustomerRow {
  readonly id: string;
  readonly email_normalized: string;
  readonly email_verification_state: EmailVerificationState;
  readonly record_version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface BindingRow {
  readonly id: string;
  readonly customer_id: string;
  readonly provider: CustomerIdentityProvider;
  readonly provider_subject: string;
  readonly created_at: Date;
}

interface OwnedOrderRow {
  readonly id: string;
  readonly customer_id: string | null;
  readonly checkout_email_normalized: string | null;
  readonly record_version: number;
  readonly status: string;
  readonly payment_status: string;
  readonly procurement_status: string;
  readonly fulfillment_status: string;
  readonly updated_at: Date;
}

export class PostgresCustomerOrderIdentityRepository implements CustomerOrderIdentityRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async createCustomer(input: {
    readonly customer: KeyCoreCustomer;
    readonly now: Date;
  }): Promise<
    | { readonly status: "CREATED"; readonly customer: KeyCoreCustomer }
    | { readonly status: "EXISTING"; readonly customer: KeyCoreCustomer }
  > {
    return this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 7006))",
        [input.customer.emailNormalized],
      );
      const existing = await findCustomerByEmail(
        client,
        input.customer.emailNormalized,
      );
      if (existing) {
        return { customer: existing, status: "EXISTING" };
      }
      const inserted = await client.query<CustomerRow>(
        `
          INSERT INTO keycore_customers(
            id, email_normalized, email_verification_state, record_version,
            created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING ${customerReturning}
        `,
        [
          input.customer.id,
          input.customer.emailNormalized,
          input.customer.emailVerificationState,
          input.customer.recordVersion,
          input.customer.createdAt,
          input.customer.updatedAt,
        ],
      );
      return {
        customer: customerFromRow(required(inserted.rows[0])),
        status: "CREATED",
      };
    });
  }

  public findCustomerById(
    requestedCustomerId: CustomerId,
  ): Promise<KeyCoreCustomer | null> {
    return findCustomerById(this.db, requestedCustomerId);
  }

  public findCustomerByNormalizedEmail(
    emailNormalized: string,
  ): Promise<KeyCoreCustomer | null> {
    return findCustomerByEmail(this.db, emailNormalized);
  }

  public async bindIdentity(input: {
    readonly binding: CustomerIdentityBinding;
  }): Promise<CustomerIdentityBindingRepositoryResult> {
    return this.db.transaction(async (client) => {
      const customer = await findCustomerById(client, input.binding.customerId);
      if (!customer) {
        return { status: "CUSTOMER_NOT_FOUND" };
      }
      const inserted = await client.query<BindingRow>(
        `
          INSERT INTO customer_identity_bindings(
            id, customer_id, provider, provider_subject, created_at
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (provider, provider_subject) DO NOTHING
          RETURNING ${bindingReturning}
        `,
        [
          input.binding.id,
          input.binding.customerId,
          input.binding.provider,
          input.binding.providerSubject,
          input.binding.createdAt,
        ],
      );
      if (inserted.rows[0]) {
        return {
          binding: bindingFromRow(inserted.rows[0]),
          status: "BOUND",
        };
      }
      const existing = await findBinding(
        client,
        input.binding.provider,
        input.binding.providerSubject,
      );
      if (existing?.customerId === input.binding.customerId) {
        return { binding: existing, status: "ALREADY_BOUND" };
      }
      return { status: "IDENTITY_CONFLICT" };
    });
  }

  public async markEmailVerified(input: {
    readonly customerId: CustomerId;
    readonly expectedCustomerVersion: number;
    readonly now: Date;
  }): Promise<
    | { readonly status: "VERIFIED"; readonly customer: KeyCoreCustomer }
    | {
        readonly status: "ALREADY_VERIFIED";
        readonly customer: KeyCoreCustomer;
      }
    | { readonly status: "CUSTOMER_NOT_FOUND" }
    | { readonly status: "STALE_WRITER"; readonly customer?: KeyCoreCustomer }
  > {
    return this.db.transaction(async (client) => {
      const customer = await findCustomerByIdForUpdate(
        client,
        input.customerId,
      );
      if (!customer) {
        return { status: "CUSTOMER_NOT_FOUND" };
      }
      if (customer.emailVerificationState === "VERIFIED") {
        return { customer, status: "ALREADY_VERIFIED" };
      }
      if (customer.recordVersion !== input.expectedCustomerVersion) {
        return { customer, status: "STALE_WRITER" };
      }
      const updated = await client.query<CustomerRow>(
        `
          UPDATE keycore_customers
          SET email_verification_state = 'VERIFIED',
            record_version = record_version + 1,
            updated_at = $3
          WHERE id = $1
            AND email_verification_state = 'UNVERIFIED'
            AND record_version = $2
          RETURNING ${customerReturning}
        `,
        [input.customerId, input.expectedCustomerVersion, input.now],
      );
      const row = updated.rows[0];
      return row
        ? { customer: customerFromRow(row), status: "VERIFIED" }
        : { customer, status: "STALE_WRITER" };
    });
  }

  public async bindOrderOwnership(input: {
    readonly orderId: OrderId;
    readonly customerId: CustomerId;
    readonly expectedOrderVersion: number;
    readonly now: Date;
  }): Promise<OrderOwnershipBindingRepositoryResult> {
    return this.db.transaction(async (client) => {
      const customer = await findCustomerById(client, input.customerId);
      if (!customer) {
        return { status: "CUSTOMER_NOT_FOUND" };
      }
      const order = await findOrderForUpdate(client, input.orderId);
      if (!order) {
        return { status: "ORDER_NOT_FOUND" };
      }
      if (order.customerId === input.customerId) {
        return { order, status: "ALREADY_BOUND" };
      }
      if (order.customerId) {
        return { order, status: "OWNERSHIP_CONFLICT" };
      }
      if (order.recordVersion !== input.expectedOrderVersion) {
        return { order, status: "STALE_WRITER" };
      }
      const updated = await client.query<OwnedOrderRow>(
        `
          UPDATE keycore_orders
          SET customer_id = $2,
            record_version = record_version + 1,
            updated_at = $4
          WHERE id = $1
            AND customer_id IS NULL
            AND record_version = $3
          RETURNING ${ownedOrderReturning}
        `,
        [
          input.orderId,
          input.customerId,
          input.expectedOrderVersion,
          input.now,
        ],
      );
      const row = updated.rows[0];
      if (!row) {
        const currentOrder = await findOrderForUpdate(client, input.orderId);
        return currentOrder
          ? { order: currentOrder, status: "STALE_WRITER" }
          : { status: "ORDER_NOT_FOUND" };
      }
      return { order: orderFromRow(row), status: "BOUND" };
    });
  }

  public async authorizeFulfillmentForCustomer(input: {
    readonly customerId: CustomerId;
    readonly orderId: OrderId;
    readonly fulfillmentId: string;
    readonly requireVerifiedEmail: boolean;
  }): Promise<
    { readonly status: "AUTHORIZED" } | { readonly status: "DENIED" }
  > {
    const result = await this.db.query<{ readonly id: string }>(
      `
        SELECT f.id::text
        FROM fulfillment_operations f
        JOIN keycore_orders o ON o.id = f.order_id
        JOIN keycore_customers c ON c.id = o.customer_id
        WHERE f.id = $1
          AND o.id = $2
          AND o.customer_id = $3
          AND ($4 = false OR c.email_verification_state = 'VERIFIED')
          AND o.procurement_status = 'SUCCEEDED'
          AND o.fulfillment_status = 'PENDING'
          AND f.status = 'DELIVERY_PENDING'
          AND f.retrieval_state = 'RETRIEVED'
          AND f.delivery_state = 'PENDING'
          AND f.encrypted_secret_id IS NOT NULL
        LIMIT 1
      `,
      [
        input.fulfillmentId,
        input.orderId,
        input.customerId,
        input.requireVerifiedEmail,
      ],
    );
    return { status: result.rows[0] ? "AUTHORIZED" : "DENIED" };
  }

  public async inspectCustomer(
    requestedCustomerId: CustomerId,
  ): Promise<CustomerInspection | null> {
    const customer = await findCustomerById(this.db, requestedCustomerId);
    return customer
      ? {
          createdAt: customer.createdAt,
          customerId: customer.id,
          emailMasked: maskCustomerEmail(customer.emailNormalized),
          emailVerificationState: customer.emailVerificationState,
          recordVersion: customer.recordVersion,
          updatedAt: customer.updatedAt,
        }
      : null;
  }

  public async inspectOrderOwnership(
    requestedOrderId: OrderId,
  ): Promise<OrderOwnershipInspection | null> {
    const order = await findOrder(this.db, requestedOrderId);
    return order
      ? {
          checkoutEmailNormalized: order.checkoutEmailNormalized ?? null,
          fulfillmentStatus: order.fulfillmentStatus,
          orderId: order.orderId,
          ownerCustomerId: order.customerId,
          ownershipBound: Boolean(order.customerId),
          recordVersion: order.recordVersion,
          status: order.status,
        }
      : null;
  }
}

const customerReturning = `
  id::text, email_normalized, email_verification_state, record_version,
  created_at, updated_at
`;

const bindingReturning = `
  id::text, customer_id::text, provider, provider_subject, created_at
`;

const ownedOrderReturning = `
  id::text, customer_id::text, checkout_email_normalized, record_version, status, payment_status,
  procurement_status, fulfillment_status, updated_at
`;

const findCustomerById = async (
  db: Queryable,
  requestedCustomerId: CustomerId,
): Promise<KeyCoreCustomer | null> => {
  const result = await db.query<CustomerRow>(
    `
      SELECT ${customerReturning}
      FROM keycore_customers
      WHERE id = $1
    `,
    [requestedCustomerId],
  );
  return result.rows[0] ? customerFromRow(result.rows[0]) : null;
};

const findCustomerByIdForUpdate = async (
  db: Queryable,
  requestedCustomerId: CustomerId,
): Promise<KeyCoreCustomer | null> => {
  const result = await db.query<CustomerRow>(
    `
      SELECT ${customerReturning}
      FROM keycore_customers
      WHERE id = $1
      FOR UPDATE
    `,
    [requestedCustomerId],
  );
  return result.rows[0] ? customerFromRow(result.rows[0]) : null;
};

const findCustomerByEmail = async (
  db: Queryable,
  emailNormalized: string,
): Promise<KeyCoreCustomer | null> => {
  const result = await db.query<CustomerRow>(
    `
      SELECT ${customerReturning}
      FROM keycore_customers
      WHERE email_normalized = $1
    `,
    [emailNormalized],
  );
  return result.rows[0] ? customerFromRow(result.rows[0]) : null;
};

const findBinding = async (
  db: Queryable,
  provider: CustomerIdentityProvider,
  providerSubject: string,
): Promise<CustomerIdentityBinding | null> => {
  const result = await db.query<BindingRow>(
    `
      SELECT ${bindingReturning}
      FROM customer_identity_bindings
      WHERE provider = $1 AND provider_subject = $2
    `,
    [provider, providerSubject],
  );
  return result.rows[0] ? bindingFromRow(result.rows[0]) : null;
};

const findOrder = async (
  db: Queryable,
  requestedOrderId: OrderId,
): Promise<OwnedOrderSnapshot | null> => {
  const result = await db.query<OwnedOrderRow>(
    `
      SELECT ${ownedOrderReturning}
      FROM keycore_orders
      WHERE id = $1
    `,
    [requestedOrderId],
  );
  return result.rows[0] ? orderFromRow(result.rows[0]) : null;
};

const findOrderForUpdate = async (
  db: Queryable,
  requestedOrderId: OrderId,
): Promise<OwnedOrderSnapshot | null> => {
  const result = await db.query<OwnedOrderRow>(
    `
      SELECT ${ownedOrderReturning}
      FROM keycore_orders
      WHERE id = $1
      FOR UPDATE
    `,
    [requestedOrderId],
  );
  return result.rows[0] ? orderFromRow(result.rows[0]) : null;
};

const customerFromRow = (row: CustomerRow): KeyCoreCustomer => ({
  createdAt: row.created_at,
  emailNormalized: row.email_normalized,
  emailVerificationState: row.email_verification_state,
  id: customerId(row.id),
  recordVersion: row.record_version,
  updatedAt: row.updated_at,
});

const bindingFromRow = (row: BindingRow): CustomerIdentityBinding => ({
  createdAt: row.created_at,
  customerId: customerId(row.customer_id),
  id: row.id,
  provider: row.provider,
  providerSubject: row.provider_subject,
});

const orderFromRow = (row: OwnedOrderRow): OwnedOrderSnapshot => ({
  customerId: row.customer_id ? customerId(row.customer_id) : null,
  checkoutEmailNormalized: row.checkout_email_normalized,
  fulfillmentStatus: row.fulfillment_status,
  orderId: orderId(row.id),
  paymentStatus: row.payment_status,
  procurementStatus: row.procurement_status,
  recordVersion: row.record_version,
  status: row.status,
  updatedAt: row.updated_at,
});

const required = <TValue>(value: TValue | undefined): TValue => {
  if (!value) {
    throw new Error("Expected customer identity row");
  }
  return value;
};
