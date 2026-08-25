import type {
  CustomerIdentityBinding,
  CustomerIdentityBindingRepositoryResult,
  CustomerInspection,
  CustomerOrderIdentityRepository,
  KeyCoreCustomer,
  OrderOwnershipBindingRepositoryResult,
  OrderOwnershipInspection,
  OwnedOrderSnapshot,
} from "../../packages/platform/src/contracts.js";
import {
  maskCustomerEmail,
  type CustomerId,
  type OrderId,
} from "../../packages/platform/src/contracts.js";

export class InMemoryCustomerOrderIdentityRepository implements CustomerOrderIdentityRepository {
  private readonly customers = new Map<CustomerId, KeyCoreCustomer>();
  private readonly customerByEmail = new Map<string, CustomerId>();
  private readonly bindings = new Map<string, CustomerIdentityBinding>();
  private readonly orders = new Map<OrderId, OwnedOrderSnapshot>();
  private readonly fulfillments = new Map<
    string,
    {
      readonly orderId: OrderId | null;
      readonly status: string;
      readonly retrievalState: string;
      readonly deliveryState: string;
      readonly encryptedSecretId: string | null;
    }
  >();

  public addOrder(order: OwnedOrderSnapshot): void {
    this.orders.set(order.orderId, order);
  }

  public addFulfillment(input: {
    readonly fulfillmentId: string;
    readonly orderId: OrderId | null;
    readonly status: string;
    readonly retrievalState: string;
    readonly deliveryState: string;
    readonly encryptedSecretId: string | null;
  }): void {
    this.fulfillments.set(input.fulfillmentId, input);
  }

  public async createCustomer(input: {
    readonly customer: KeyCoreCustomer;
    readonly now: Date;
  }): Promise<
    | { readonly status: "CREATED"; readonly customer: KeyCoreCustomer }
    | { readonly status: "EXISTING"; readonly customer: KeyCoreCustomer }
  > {
    const existingId = this.customerByEmail.get(input.customer.emailNormalized);
    if (existingId) {
      return {
        customer: required(this.customers.get(existingId)),
        status: "EXISTING",
      };
    }
    this.customers.set(input.customer.id, input.customer);
    this.customerByEmail.set(input.customer.emailNormalized, input.customer.id);
    return { customer: input.customer, status: "CREATED" };
  }

  public async findCustomerById(
    requestedCustomerId: CustomerId,
  ): Promise<KeyCoreCustomer | null> {
    return this.customers.get(requestedCustomerId) ?? null;
  }

  public async findCustomerByNormalizedEmail(
    emailNormalized: string,
  ): Promise<KeyCoreCustomer | null> {
    const id = this.customerByEmail.get(emailNormalized);
    return id ? (this.customers.get(id) ?? null) : null;
  }

  public async bindIdentity(input: {
    readonly binding: CustomerIdentityBinding;
  }): Promise<CustomerIdentityBindingRepositoryResult> {
    if (!this.customers.has(input.binding.customerId)) {
      return { status: "CUSTOMER_NOT_FOUND" };
    }
    const key = `${input.binding.provider}:${input.binding.providerSubject}`;
    const existing = this.bindings.get(key);
    if (existing) {
      return existing.customerId === input.binding.customerId
        ? { binding: existing, status: "ALREADY_BOUND" }
        : { status: "IDENTITY_CONFLICT" };
    }
    this.bindings.set(key, input.binding);
    return { binding: input.binding, status: "BOUND" };
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
    const customer = this.customers.get(input.customerId);
    if (!customer) {
      return { status: "CUSTOMER_NOT_FOUND" };
    }
    if (customer.emailVerificationState === "VERIFIED") {
      return { customer, status: "ALREADY_VERIFIED" };
    }
    if (customer.recordVersion !== input.expectedCustomerVersion) {
      return { customer, status: "STALE_WRITER" };
    }
    const verified: KeyCoreCustomer = {
      ...customer,
      emailVerificationState: "VERIFIED",
      recordVersion: customer.recordVersion + 1,
      updatedAt: input.now,
    };
    this.customers.set(input.customerId, verified);
    return { customer: verified, status: "VERIFIED" };
  }

  public async bindOrderOwnership(input: {
    readonly orderId: OrderId;
    readonly customerId: CustomerId;
    readonly expectedOrderVersion: number;
    readonly now: Date;
  }): Promise<OrderOwnershipBindingRepositoryResult> {
    if (!this.customers.has(input.customerId)) {
      return { status: "CUSTOMER_NOT_FOUND" };
    }
    const order = this.orders.get(input.orderId);
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
    const next = {
      ...order,
      customerId: input.customerId,
      recordVersion: order.recordVersion + 1,
      updatedAt: input.now,
    };
    this.orders.set(input.orderId, next);
    return { order: next, status: "BOUND" };
  }

  public async authorizeFulfillmentForCustomer(input: {
    readonly customerId: CustomerId;
    readonly orderId: OrderId;
    readonly fulfillmentId: string;
    readonly requireVerifiedEmail: boolean;
  }): Promise<
    { readonly status: "AUTHORIZED" } | { readonly status: "DENIED" }
  > {
    const customer = this.customers.get(input.customerId);
    const order = this.orders.get(input.orderId);
    const fulfillment = this.fulfillments.get(input.fulfillmentId);
    const authorized = Boolean(
      customer &&
      (!input.requireVerifiedEmail ||
        customer.emailVerificationState === "VERIFIED") &&
      order?.customerId === input.customerId &&
      fulfillment?.orderId === input.orderId &&
      fulfillment.status === "DELIVERY_PENDING" &&
      fulfillment.retrievalState === "RETRIEVED" &&
      fulfillment.deliveryState === "PENDING" &&
      fulfillment.encryptedSecretId,
    );
    return { status: authorized ? "AUTHORIZED" : "DENIED" };
  }

  public async inspectCustomer(
    requestedCustomerId: CustomerId,
  ): Promise<CustomerInspection | null> {
    const customer = this.customers.get(requestedCustomerId);
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
    const order = this.orders.get(requestedOrderId);
    return order
      ? {
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

const required = <TValue>(value: TValue | undefined): TValue => {
  if (!value) {
    throw new Error("Expected in-memory identity fixture");
  }
  return value;
};
