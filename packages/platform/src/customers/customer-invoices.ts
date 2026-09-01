import { randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type {
  CorrelationId,
  CustomerId,
  OrderId,
} from "../domain/identifiers.js";
import { orderId } from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import {
  invoiceSummary,
  type CustomerAccountReadRepository,
  type InvoiceSummary,
} from "./customer-account.js";
import type { AuthenticatedCustomerPrincipal } from "./customer-order-identity.js";

export type CustomerInvoiceAccessFailureCode =
  "AUTHENTICATION_REQUIRED" | "RESOURCE_NOT_AVAILABLE";

export type CustomerInvoiceMetadataResult =
  | {
      readonly status: "OK";
      readonly orderId: OrderId;
      readonly invoice: InvoiceSummary;
    }
  | {
      readonly status: "DENIED";
      readonly code: CustomerInvoiceAccessFailureCode;
    };

export interface CustomerInvoiceAccessServiceOptions {
  readonly repository: CustomerAccountReadRepository;
  readonly documentProvider?: CustomerInvoiceDocumentProvider;
  readonly audit?: AuditEventPort;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
}

export const customerInvoiceDocumentContentType = "application/pdf" as const;
export const customerInvoiceDocumentMaxBytes = 512 * 1024;

export interface CustomerInvoiceDocumentProvider {
  getDocument(input: {
    readonly customerId: CustomerId;
    readonly orderId: OrderId;
    readonly invoiceReference: string;
    readonly issuedAt: string;
    readonly productTitle: string;
    readonly currency: string;
    readonly totalMinor: string;
  }): Promise<
    | {
        readonly status: "AVAILABLE";
        readonly contentType: string;
        readonly bytes: Uint8Array;
      }
    | { readonly status: "NOT_AVAILABLE" }
  >;
}

export type CustomerInvoiceDocumentResult =
  | {
      readonly status: "OK";
      readonly orderId: OrderId;
      readonly contentType: typeof customerInvoiceDocumentContentType;
      readonly bytes: Uint8Array;
    }
  | {
      readonly status: "DENIED";
      readonly code: CustomerInvoiceAccessFailureCode;
    };

export class CustomerInvoiceAccessService {
  private readonly environment: AuditEvent["environment"];
  private readonly now: () => Date;

  public constructor(
    private readonly options: CustomerInvoiceAccessServiceOptions,
  ) {
    this.environment = options.environment ?? "LOCAL";
    this.now = options.now ?? (() => new Date());
  }

  public async getInvoiceMetadata(input: {
    readonly principal: AuthenticatedCustomerPrincipal | null;
    readonly correlationId: CorrelationId;
    readonly orderId: string;
  }): Promise<CustomerInvoiceMetadataResult> {
    const principal = acceptedPrincipal(input.principal);
    if (!principal) {
      return { code: "AUTHENTICATION_REQUIRED", status: "DENIED" };
    }
    if (!isSafeUuid(input.orderId)) {
      return { code: "RESOURCE_NOT_AVAILABLE", status: "DENIED" };
    }
    const requestedOrderId = orderId(input.orderId);
    const order = await this.options.repository.findOwnedOrderDetail({
      customerId: principal.customerId,
      orderId: requestedOrderId,
    });
    if (!order) {
      await this.audit({
        correlationId: input.correlationId,
        customerId: principal.customerId,
        entityId: requestedOrderId,
        eventType: "CUSTOMER_INVOICE_METADATA_DENIED",
        outcome: "DENIED",
        reasonCode: "RESOURCE_NOT_AVAILABLE",
      });
      return { code: "RESOURCE_NOT_AVAILABLE", status: "DENIED" };
    }
    const invoice = invoiceSummary(order.invoice);
    await this.audit({
      correlationId: input.correlationId,
      customerId: principal.customerId,
      entityId: order.orderId,
      eventType: "CUSTOMER_INVOICE_METADATA_VIEWED",
      outcome: "SUCCEEDED",
      reasonCode: "CUSTOMER_INVOICE_METADATA_VIEWED",
      metadata: {
        downloadAvailable: invoice.downloadAvailable,
        invoiceStatus: invoice.status,
        orderId: order.orderId,
      },
    });
    return { invoice, orderId: order.orderId, status: "OK" };
  }

  public async getInvoiceDocument(input: {
    readonly principal: AuthenticatedCustomerPrincipal | null;
    readonly correlationId: CorrelationId;
    readonly orderId: string;
  }): Promise<CustomerInvoiceDocumentResult> {
    const principal = acceptedPrincipal(input.principal);
    if (!principal) {
      return { code: "AUTHENTICATION_REQUIRED", status: "DENIED" };
    }
    if (!isSafeUuid(input.orderId)) {
      return { code: "RESOURCE_NOT_AVAILABLE", status: "DENIED" };
    }
    const requestedOrderId = orderId(input.orderId);
    const order = await this.options.repository.findOwnedOrderDetail({
      customerId: principal.customerId,
      orderId: requestedOrderId,
    });
    const invoice = invoiceSummary(order?.invoice);
    const provider = this.options.documentProvider;
    if (
      !order ||
      !provider ||
      invoice.status !== "AVAILABLE" ||
      !invoice.downloadAvailable ||
      !invoice.invoiceReference ||
      !invoice.issuedAt
    ) {
      await this.audit({
        correlationId: input.correlationId,
        customerId: principal.customerId,
        entityId: requestedOrderId,
        eventType: "CUSTOMER_INVOICE_DOCUMENT_DENIED",
        outcome: "DENIED",
        reasonCode: "RESOURCE_NOT_AVAILABLE",
      });
      return { code: "RESOURCE_NOT_AVAILABLE", status: "DENIED" };
    }
    const document = await provider.getDocument({
      currency: order.currency,
      customerId: principal.customerId,
      invoiceReference: invoice.invoiceReference,
      issuedAt: invoice.issuedAt,
      orderId: order.orderId,
      productTitle: order.productTitle ?? "Digital product",
      totalMinor: order.total.amountMinor.toString(),
    });
    if (
      document.status !== "AVAILABLE" ||
      document.contentType !== customerInvoiceDocumentContentType ||
      document.bytes.byteLength < 1 ||
      document.bytes.byteLength > customerInvoiceDocumentMaxBytes
    ) {
      await this.audit({
        correlationId: input.correlationId,
        customerId: principal.customerId,
        entityId: order.orderId,
        eventType: "CUSTOMER_INVOICE_DOCUMENT_DENIED",
        outcome: "DENIED",
        reasonCode: "RESOURCE_NOT_AVAILABLE",
      });
      return { code: "RESOURCE_NOT_AVAILABLE", status: "DENIED" };
    }
    await this.audit({
      correlationId: input.correlationId,
      customerId: principal.customerId,
      entityId: order.orderId,
      eventType: "CUSTOMER_INVOICE_DOCUMENT_VIEWED",
      outcome: "SUCCEEDED",
      reasonCode: "CUSTOMER_INVOICE_DOCUMENT_VIEWED",
      metadata: {
        contentType: customerInvoiceDocumentContentType,
        documentBytes: document.bytes.byteLength,
        orderId: order.orderId,
      },
    });
    return {
      bytes: document.bytes,
      contentType: customerInvoiceDocumentContentType,
      orderId: order.orderId,
      status: "OK",
    };
  }

  private async audit(input: {
    readonly correlationId: CorrelationId;
    readonly customerId: string;
    readonly entityId: string;
    readonly eventType: AuditEvent["eventType"];
    readonly outcome: AuditEvent["outcome"];
    readonly reasonCode: string;
    readonly metadata?: Readonly<Record<string, string | number | boolean>>;
  }): Promise<void> {
    await this.options.audit?.append({
      actor: { id: input.customerId, type: "CUSTOMER" },
      correlationId: input.correlationId,
      entity: { id: input.entityId, type: "CUSTOMER_INVOICE" },
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

const acceptedPrincipal = (
  principal: AuthenticatedCustomerPrincipal | null,
): AuthenticatedCustomerPrincipal | null =>
  principal?.authenticationContext.assurance === "AUTHENTICATED"
    ? principal
    : null;

const isSafeUuid = (value: string): boolean => {
  const parts = value.split("-");
  return (
    parts.length === 5 &&
    /^[0-9a-f]{8}$/iu.test(parts[0] ?? "") &&
    /^[0-9a-f]{4}$/iu.test(parts[1] ?? "") &&
    /^[1-5][0-9a-f]{3}$/iu.test(parts[2] ?? "") &&
    /^[89ab][0-9a-f]{3}$/iu.test(parts[3] ?? "") &&
    /^[0-9a-f]{12}$/iu.test(parts[4] ?? "")
  );
};
