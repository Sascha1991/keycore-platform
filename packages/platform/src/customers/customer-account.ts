import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type {
  CorrelationId,
  CustomerId,
  OrderId,
} from "../domain/identifiers.js";
import { orderId } from "../domain/identifiers.js";
import type { Money } from "../domain/money.js";
import type {
  OrderFulfillmentStatus,
  OrderPaymentStatus,
  OrderProcurementStatus,
  OrderRefundStatus,
  OrderStatus,
} from "../orders/order-orchestration.js";
import type { AuditEventPort } from "../ports/core.js";
import type {
  FulfillmentDeliveryState,
  FulfillmentRetrievalState,
  FulfillmentStatus,
} from "../fulfillment/secure-key-fulfillment.js";
import type {
  AuthenticatedCustomerPrincipal,
  EmailVerificationState,
} from "./customer-order-identity.js";

export type CustomerAccountFailureCode =
  "AUTHENTICATION_REQUIRED" | "RESOURCE_NOT_AVAILABLE" | "BAD_REQUEST";

export type CustomerFacingOrderState =
  | "PROCESSING"
  | "READY"
  | "COMPLETED"
  | "ACTION_REQUIRED"
  | "CANCELLED"
  | "REFUNDED";

export type CustomerFacingDeliveryStatus =
  "PENDING" | "AVAILABLE" | "DELIVERED" | "ACTION_REQUIRED" | "UNAVAILABLE";

export type CustomerKeyVaultStatus =
  | "NO_KEY"
  | "KEY_PENDING"
  | "KEY_AVAILABLE"
  | "DELIVERED"
  | "MANUAL_REVIEW_REQUIRED";

export type InvoiceStatus =
  "NOT_AVAILABLE" | "PENDING" | "AVAILABLE" | "FAILED";

export type ActivationPlatform =
  | "STEAM"
  | "EPIC"
  | "UBISOFT_CONNECT"
  | "EA_APP"
  | "XBOX"
  | "PLAYSTATION"
  | "OTHER";

export interface CustomerAccountSummary {
  readonly customerId: CustomerId;
  readonly emailMasked: string;
  readonly emailVerificationState: EmailVerificationState;
  readonly createdAt: string;
}

export interface CustomerOrderHistoryItem {
  readonly orderId: OrderId;
  readonly createdAt: string;
  readonly status: CustomerFacingOrderState;
  readonly paymentStatus: OrderPaymentStatus;
  readonly procurementStatus: OrderProcurementStatus;
  readonly fulfillmentStatus: CustomerFacingDeliveryStatus;
  readonly currency: Money["currency"];
  readonly total: Money;
  readonly productTitle?: string;
  readonly fulfillmentAvailable: boolean;
}

export interface CustomerOrderHistoryPage {
  readonly orders: readonly CustomerOrderHistoryItem[];
  readonly nextCursor?: string;
}

export interface CustomerKeyVaultMetadata {
  readonly fulfillmentId: string;
  readonly status: CustomerKeyVaultStatus;
  readonly deliveryStatus: CustomerFacingDeliveryStatus;
  readonly hasEncryptedSecret: boolean;
  readonly retrievedAt?: string;
  readonly deliveredAt?: string;
  readonly keyAccessAvailable: boolean;
}

export interface InvoiceSummary {
  readonly status: InvoiceStatus;
  readonly invoiceReference?: string;
  readonly issuedAt?: string;
  readonly downloadAvailable: boolean;
}

export interface ActivationInstructions {
  readonly platform: ActivationPlatform | "UNKNOWN";
  readonly status: "AVAILABLE" | "NOT_AVAILABLE";
  readonly instructionCode: string;
}

export interface CustomerOrderDetail {
  readonly orderId: OrderId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: CustomerFacingOrderState;
  readonly paymentStatus: OrderPaymentStatus;
  readonly procurementStatus: OrderProcurementStatus;
  readonly refundStatus: OrderRefundStatus;
  readonly currency: Money["currency"];
  readonly total: Money;
  readonly productTitle?: string;
  readonly fulfillment?: CustomerKeyVaultMetadata;
  readonly invoice: InvoiceSummary;
  readonly activationInstructions: ActivationInstructions;
}

export interface CustomerAccountRecord {
  readonly customerId: CustomerId;
  readonly emailMasked: string;
  readonly emailVerificationState: EmailVerificationState;
  readonly createdAt: Date;
}

export interface CustomerAccountOrderProjection {
  readonly orderId: OrderId;
  readonly customerId: CustomerId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly status: OrderStatus;
  readonly paymentStatus: OrderPaymentStatus;
  readonly procurementStatus: OrderProcurementStatus;
  readonly fulfillmentStatus: OrderFulfillmentStatus;
  readonly refundStatus: OrderRefundStatus;
  readonly currency: Money["currency"];
  readonly total: Money;
  readonly productTitle?: string | null;
  readonly fulfillment?: CustomerAccountFulfillmentProjection | null;
  readonly invoice?: CustomerAccountInvoiceProjection | null;
  readonly activation?: CustomerAccountActivationProjection | null;
}

export interface CustomerAccountFulfillmentProjection {
  readonly fulfillmentId: string;
  readonly orderId: OrderId | null;
  readonly status: FulfillmentStatus;
  readonly retrievalState: FulfillmentRetrievalState;
  readonly deliveryState: FulfillmentDeliveryState;
  readonly hasEncryptedSecret: boolean;
  readonly retrievedAt?: Date | null;
  readonly deliveredAt?: Date | null;
}

export interface CustomerAccountInvoiceProjection {
  readonly status: InvoiceStatus;
  readonly invoiceReference?: string | null;
  readonly issuedAt?: Date | null;
  readonly downloadAvailable: boolean;
}

export interface CustomerAccountActivationProjection {
  readonly platform?: ActivationPlatform | null;
  readonly instructionCode?: string | null;
  readonly source: "STRUCTURED" | "TITLE_ONLY" | "NONE";
}

export interface CustomerAccountReadCursor {
  readonly createdAt: Date;
  readonly orderId: OrderId;
}

export interface CustomerAccountReadRepository {
  findAccountSummary(
    customerId: CustomerId,
  ): Promise<CustomerAccountRecord | null>;
  listOwnedOrders(input: {
    readonly customerId: CustomerId;
    readonly limit: number;
    readonly after?: CustomerAccountReadCursor;
  }): Promise<{
    readonly orders: readonly CustomerAccountOrderProjection[];
    readonly nextCursor?: CustomerAccountReadCursor;
  }>;
  findOwnedOrderDetail(input: {
    readonly customerId: CustomerId;
    readonly orderId: OrderId;
  }): Promise<CustomerAccountOrderProjection | null>;
}

export interface CustomerAccountServiceOptions {
  readonly repository: CustomerAccountReadRepository;
  readonly cursorSigningSecret: string;
  readonly audit?: AuditEventPort;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
}

export class CustomerAccountService {
  private readonly environment: AuditEvent["environment"];
  private readonly now: () => Date;

  public constructor(private readonly options: CustomerAccountServiceOptions) {
    if (Buffer.byteLength(options.cursorSigningSecret, "utf8") < 32) {
      throw new Error("Customer account cursor secret is too short");
    }
    this.environment = options.environment ?? "LOCAL";
    this.now = options.now ?? (() => new Date());
  }

  public async getAccountSummary(input: {
    readonly principal: AuthenticatedCustomerPrincipal | null;
    readonly correlationId: CorrelationId;
  }): Promise<
    | { readonly status: "OK"; readonly account: CustomerAccountSummary }
    | { readonly status: "DENIED"; readonly code: CustomerAccountFailureCode }
  > {
    const principal = this.acceptedPrincipal(input.principal);
    if (!principal) {
      return { code: "AUTHENTICATION_REQUIRED", status: "DENIED" };
    }
    const account = await this.options.repository.findAccountSummary(
      principal.customerId,
    );
    if (!account) {
      return { code: "RESOURCE_NOT_AVAILABLE", status: "DENIED" };
    }
    await this.audit({
      correlationId: input.correlationId,
      customerId: principal.customerId,
      entityId: principal.customerId,
      eventType: "CUSTOMER_ACCOUNT_VIEWED",
      outcome: "SUCCEEDED",
      reasonCode: "CUSTOMER_ACCOUNT_VIEWED",
    });
    return {
      account: {
        createdAt: account.createdAt.toISOString(),
        customerId: account.customerId,
        emailMasked: account.emailMasked,
        emailVerificationState: account.emailVerificationState,
      },
      status: "OK",
    };
  }

  public async listOwnedOrders(input: {
    readonly principal: AuthenticatedCustomerPrincipal | null;
    readonly correlationId: CorrelationId;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<
    | { readonly status: "OK"; readonly page: CustomerOrderHistoryPage }
    | { readonly status: "DENIED"; readonly code: CustomerAccountFailureCode }
  > {
    const principal = this.acceptedPrincipal(input.principal);
    if (!principal) {
      return { code: "AUTHENTICATION_REQUIRED", status: "DENIED" };
    }
    const limit = normalizeLimit(input.limit);
    if (limit === "INVALID") {
      return { code: "BAD_REQUEST", status: "DENIED" };
    }
    const cursor = input.cursor
      ? this.decodeCursor(input.cursor, principal.customerId)
      : null;
    if (cursor === "INVALID") {
      return { code: "BAD_REQUEST", status: "DENIED" };
    }
    const result = await this.options.repository.listOwnedOrders({
      customerId: principal.customerId,
      limit,
      ...(cursor ? { after: cursor } : {}),
    });
    await this.audit({
      correlationId: input.correlationId,
      customerId: principal.customerId,
      entityId: principal.customerId,
      eventType: "CUSTOMER_ORDER_HISTORY_VIEWED",
      outcome: "SUCCEEDED",
      reasonCode: "CUSTOMER_ORDER_HISTORY_VIEWED",
      metadata: { resultCount: result.orders.length },
    });
    return {
      page: {
        ...(result.nextCursor
          ? {
              nextCursor: this.encodeCursor(
                result.nextCursor,
                principal.customerId,
              ),
            }
          : {}),
        orders: result.orders.map(orderHistoryItem),
      },
      status: "OK",
    };
  }

  public async getOwnedOrderDetail(input: {
    readonly principal: AuthenticatedCustomerPrincipal | null;
    readonly correlationId: CorrelationId;
    readonly orderId: string;
  }): Promise<
    | { readonly status: "OK"; readonly order: CustomerOrderDetail }
    | { readonly status: "DENIED"; readonly code: CustomerAccountFailureCode }
  > {
    const principal = this.acceptedPrincipal(input.principal);
    if (!principal) {
      return { code: "AUTHENTICATION_REQUIRED", status: "DENIED" };
    }
    if (!isSafeUuid(input.orderId)) {
      return { code: "RESOURCE_NOT_AVAILABLE", status: "DENIED" };
    }
    const requestedOrderId = orderId(input.orderId);
    const projection = await this.options.repository.findOwnedOrderDetail({
      customerId: principal.customerId,
      orderId: requestedOrderId,
    });
    if (!projection) {
      await this.audit({
        correlationId: input.correlationId,
        customerId: principal.customerId,
        entityId: requestedOrderId,
        eventType: "CUSTOMER_ORDER_VIEW_DENIED",
        outcome: "DENIED",
        reasonCode: "RESOURCE_NOT_AVAILABLE",
      });
      return { code: "RESOURCE_NOT_AVAILABLE", status: "DENIED" };
    }
    await this.audit({
      correlationId: input.correlationId,
      customerId: principal.customerId,
      entityId: projection.orderId,
      eventType: "CUSTOMER_ORDER_VIEWED",
      outcome: "SUCCEEDED",
      reasonCode: "CUSTOMER_ORDER_VIEWED",
    });
    if (projection.fulfillment) {
      await this.audit({
        correlationId: input.correlationId,
        customerId: principal.customerId,
        entityId: projection.fulfillment.fulfillmentId,
        eventType: "CUSTOMER_KEY_VAULT_VIEWED",
        outcome: "SUCCEEDED",
        reasonCode: "CUSTOMER_KEY_VAULT_METADATA_VIEWED",
        metadata: {
          fulfillmentId: projection.fulfillment.fulfillmentId,
          orderId: projection.orderId,
        },
      });
    }
    await this.audit({
      correlationId: input.correlationId,
      customerId: principal.customerId,
      entityId: projection.orderId,
      eventType: "CUSTOMER_INVOICE_METADATA_VIEWED",
      outcome: "SUCCEEDED",
      reasonCode: "CUSTOMER_INVOICE_METADATA_VIEWED",
    });
    await this.audit({
      correlationId: input.correlationId,
      customerId: principal.customerId,
      entityId: projection.orderId,
      eventType: "CUSTOMER_ACTIVATION_INSTRUCTIONS_VIEWED",
      outcome: "SUCCEEDED",
      reasonCode: "CUSTOMER_ACTIVATION_INSTRUCTIONS_VIEWED",
    });
    return { order: orderDetail(projection), status: "OK" };
  }

  private acceptedPrincipal(
    principal: AuthenticatedCustomerPrincipal | null,
  ): AuthenticatedCustomerPrincipal | null {
    return principal?.authenticationContext.assurance === "AUTHENTICATED"
      ? principal
      : null;
  }

  private encodeCursor(
    cursor: CustomerAccountReadCursor,
    customerId: CustomerId,
  ): string {
    const payload = Buffer.from(
      JSON.stringify({
        createdAt: cursor.createdAt.toISOString(),
        customerId,
        orderId: cursor.orderId,
        purpose: "customer-account-orders",
        version: 1,
      }),
      "utf8",
    ).toString("base64url");
    return `v1.${payload}.${this.sign(payload)}`;
  }

  private decodeCursor(
    raw: string,
    customerId: CustomerId,
  ): CustomerAccountReadCursor | "INVALID" {
    const parts = raw.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) {
      return "INVALID";
    }
    if (!constantTimeEqual(this.sign(parts[1]), parts[2])) {
      return "INVALID";
    }
    try {
      const parsed = JSON.parse(
        Buffer.from(parts[1], "base64url").toString("utf8"),
      ) as Partial<{
        readonly createdAt: string;
        readonly customerId: string;
        readonly orderId: string;
        readonly purpose: string;
        readonly version: number;
      }>;
      if (
        parsed.version !== 1 ||
        parsed.purpose !== "customer-account-orders" ||
        parsed.customerId !== customerId ||
        !parsed.createdAt ||
        !parsed.orderId ||
        !isSafeUuid(parsed.orderId)
      ) {
        return "INVALID";
      }
      const createdAt = new Date(parsed.createdAt);
      if (
        Number.isNaN(createdAt.getTime()) ||
        createdAt.toISOString() !== parsed.createdAt
      ) {
        return "INVALID";
      }
      return { createdAt, orderId: orderId(parsed.orderId) };
    } catch {
      return "INVALID";
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.options.cursorSigningSecret)
      .update(payload)
      .digest("base64url");
  }

  private async audit(input: {
    readonly correlationId: CorrelationId;
    readonly customerId: CustomerId;
    readonly entityId: string;
    readonly eventType: AuditEvent["eventType"];
    readonly outcome: AuditEvent["outcome"];
    readonly reasonCode: string;
    readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  }): Promise<void> {
    await this.options.audit?.append({
      actor: { id: input.customerId, type: "CUSTOMER" },
      correlationId: input.correlationId,
      entity: { id: input.entityId, type: "CUSTOMER_ACCOUNT" },
      environment: this.environment,
      eventType: input.eventType,
      metadata: {
        customerId: input.customerId,
        reasonCode: input.reasonCode,
        ...input.metadata,
      },
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }
}

export const customerAccountCacheHeaders = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

export const keyAccessAvailable = (input: {
  readonly orderId: OrderId;
  readonly orderCustomerId: CustomerId;
  readonly principalCustomerId: CustomerId;
  readonly fulfillment: CustomerAccountFulfillmentProjection | null | undefined;
}): boolean => {
  const fulfillment = input.fulfillment;
  return Boolean(
    input.orderCustomerId === input.principalCustomerId &&
    fulfillment &&
    fulfillment.orderId === input.orderId &&
    fulfillment.retrievalState === "RETRIEVED" &&
    fulfillment.status === "DELIVERY_PENDING" &&
    fulfillment.deliveryState === "PENDING" &&
    fulfillment.hasEncryptedSecret,
  );
};

export const keyVaultMetadata = (
  order: CustomerAccountOrderProjection,
): CustomerKeyVaultMetadata | undefined => {
  const fulfillment = order.fulfillment;
  if (!fulfillment) {
    return undefined;
  }
  const deliveryStatus = customerDeliveryStatus(order, fulfillment);
  const status = keyVaultStatus(order, fulfillment);
  return {
    ...(fulfillment.deliveredAt
      ? { deliveredAt: fulfillment.deliveredAt.toISOString() }
      : {}),
    deliveryStatus,
    fulfillmentId: fulfillment.fulfillmentId,
    hasEncryptedSecret: fulfillment.hasEncryptedSecret,
    keyAccessAvailable: keyAccessAvailable({
      fulfillment,
      orderId: order.orderId,
      orderCustomerId: order.customerId,
      principalCustomerId: order.customerId,
    }),
    ...(fulfillment.retrievedAt
      ? { retrievedAt: fulfillment.retrievedAt.toISOString() }
      : {}),
    status,
  };
};

export const customerOrderState = (
  order: Pick<
    CustomerAccountOrderProjection,
    | "status"
    | "paymentStatus"
    | "procurementStatus"
    | "fulfillmentStatus"
    | "refundStatus"
  >,
): CustomerFacingOrderState => {
  if (order.refundStatus === "SUCCEEDED" || order.status === "REFUNDED") {
    return "REFUNDED";
  }
  if (order.status === "CANCELLED") {
    return "CANCELLED";
  }
  if (
    order.status === "MANUAL_REVIEW" ||
    order.procurementStatus === "AMBIGUOUS" ||
    order.fulfillmentStatus === "MANUAL_REVIEW"
  ) {
    return "ACTION_REQUIRED";
  }
  if (order.status === "COMPLETED" || order.fulfillmentStatus === "SUCCEEDED") {
    return "COMPLETED";
  }
  if (
    order.procurementStatus === "SUCCEEDED" &&
    order.fulfillmentStatus === "PENDING"
  ) {
    return "READY";
  }
  return "PROCESSING";
};

const orderHistoryItem = (
  order: CustomerAccountOrderProjection,
): CustomerOrderHistoryItem => ({
  createdAt: order.createdAt.toISOString(),
  currency: order.currency,
  fulfillmentAvailable: Boolean(keyVaultMetadata(order)?.keyAccessAvailable),
  fulfillmentStatus: order.fulfillment
    ? customerDeliveryStatus(order, order.fulfillment)
    : "UNAVAILABLE",
  orderId: order.orderId,
  paymentStatus: order.paymentStatus,
  procurementStatus: order.procurementStatus,
  ...(order.productTitle ? { productTitle: order.productTitle } : {}),
  status: customerOrderState(order),
  total: order.total,
});

const orderDetail = (
  order: CustomerAccountOrderProjection,
): CustomerOrderDetail => {
  const fulfillment = keyVaultMetadata(order);
  return {
    activationInstructions: activationInstructions(order.activation),
    createdAt: order.createdAt.toISOString(),
    currency: order.currency,
    ...(fulfillment ? { fulfillment } : {}),
    invoice: invoiceSummary(order.invoice),
    orderId: order.orderId,
    paymentStatus: order.paymentStatus,
    procurementStatus: order.procurementStatus,
    ...(order.productTitle ? { productTitle: order.productTitle } : {}),
    refundStatus: order.refundStatus,
    status: customerOrderState(order),
    total: order.total,
    updatedAt: order.updatedAt.toISOString(),
  };
};

const keyVaultStatus = (
  order: CustomerAccountOrderProjection,
  fulfillment: CustomerAccountFulfillmentProjection,
): CustomerKeyVaultStatus => {
  if (
    fulfillment.status === "MANUAL_REVIEW_REQUIRED" ||
    fulfillment.retrievalState === "MANUAL_REVIEW_REQUIRED"
  ) {
    return "MANUAL_REVIEW_REQUIRED";
  }
  if (
    fulfillment.deliveryState === "DELIVERED" ||
    fulfillment.status === "DELIVERED"
  ) {
    return "DELIVERED";
  }
  if (
    fulfillment.retrievalState === "RETRIEVED" &&
    fulfillment.deliveryState === "PENDING" &&
    fulfillment.hasEncryptedSecret &&
    fulfillment.orderId === order.orderId
  ) {
    return "KEY_AVAILABLE";
  }
  if (
    fulfillment.retrievalState === "NOT_STARTED" ||
    fulfillment.retrievalState === "IN_FLIGHT"
  ) {
    return "KEY_PENDING";
  }
  return "NO_KEY";
};

const customerDeliveryStatus = (
  order: CustomerAccountOrderProjection,
  fulfillment: CustomerAccountFulfillmentProjection,
): CustomerFacingDeliveryStatus => {
  if (
    fulfillment.status === "MANUAL_REVIEW_REQUIRED" ||
    fulfillment.retrievalState === "MANUAL_REVIEW_REQUIRED"
  ) {
    return "ACTION_REQUIRED";
  }
  if (
    fulfillment.deliveryState === "DELIVERED" ||
    fulfillment.status === "DELIVERED"
  ) {
    return "DELIVERED";
  }
  if (
    fulfillment.retrievalState === "RETRIEVED" &&
    fulfillment.deliveryState === "PENDING" &&
    fulfillment.hasEncryptedSecret &&
    fulfillment.orderId === order.orderId
  ) {
    return "AVAILABLE";
  }
  if (
    fulfillment.status === "PENDING" ||
    fulfillment.status === "READY" ||
    fulfillment.status === "RETRIEVAL_IN_FLIGHT"
  ) {
    return "PENDING";
  }
  return "UNAVAILABLE";
};

export const invoiceSummary = (
  invoice: CustomerAccountInvoiceProjection | null | undefined,
): InvoiceSummary => {
  if (!invoice) {
    return { downloadAvailable: false, status: "NOT_AVAILABLE" };
  }
  return {
    downloadAvailable:
      invoice.status === "AVAILABLE" && invoice.downloadAvailable === true,
    ...(invoice.invoiceReference
      ? { invoiceReference: invoice.invoiceReference }
      : {}),
    ...(invoice.issuedAt ? { issuedAt: invoice.issuedAt.toISOString() } : {}),
    status: invoice.status,
  };
};

export const activationInstructions = (
  activation: CustomerAccountActivationProjection | null | undefined,
): ActivationInstructions => {
  if (
    !activation ||
    activation.source !== "STRUCTURED" ||
    !activation.platform ||
    !activation.instructionCode
  ) {
    return {
      instructionCode: "GENERIC_SAFE_ACTIVATION",
      platform: "UNKNOWN",
      status: "NOT_AVAILABLE",
    };
  }
  return {
    instructionCode: activation.instructionCode,
    platform: activation.platform,
    status: "AVAILABLE",
  };
};

const normalizeLimit = (limit: number | undefined): number | "INVALID" => {
  if (limit === undefined) {
    return 20;
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return "INVALID";
  }
  return Math.min(limit, 100);
};

const isSafeUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );

const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
};
