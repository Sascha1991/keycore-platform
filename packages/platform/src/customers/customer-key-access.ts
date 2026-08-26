import { randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type { CorrelationId, CustomerId } from "../domain/identifiers.js";
import { orderId } from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import type {
  CustomerKeyDeliveryExecuteResult as DeliveryExecuteResult,
  CustomerKeyDeliveryPrepareResult as DeliveryPrepareResult,
  CustomerKeyDeliveryService,
} from "../fulfillment/customer-key-delivery.js";
import type { AuthenticatedCustomerPrincipal } from "./customer-order-identity.js";
import type { CustomerAccountReadRepository } from "./customer-account.js";
import { keyAccessAvailable } from "./customer-account.js";

export type CustomerKeyAccessFailureCode =
  | "AUTHENTICATION_REQUIRED"
  | "RESOURCE_NOT_AVAILABLE"
  | "KEY_ACCESS_NOT_AVAILABLE"
  | "CONFLICT"
  | "TEMPORARILY_UNAVAILABLE";

export type CustomerKeyAccessPrepareResult =
  | {
      readonly status: "AUTHORIZED";
      readonly deliveryApprovalId: string;
      readonly deliveryCapability: string;
      readonly expiresAt: string;
    }
  | {
      readonly status: "DENIED";
      readonly code: CustomerKeyAccessFailureCode;
    };

export type CustomerKeyAccessExecuteResult =
  | {
      readonly status:
        | "DELIVERED"
        | "ALREADY_DELIVERED"
        | "IN_FLIGHT"
        | "MANUAL_REVIEW_REQUIRED";
      readonly fulfillmentId?: string;
    }
  | {
      readonly status: "DENIED";
      readonly code: CustomerKeyAccessFailureCode;
    };

export interface CustomerKeyAccessServiceOptions {
  readonly accountRepository: CustomerAccountReadRepository;
  readonly deliveryService: CustomerKeyDeliveryService;
  readonly audit?: AuditEventPort;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
}

export class CustomerKeyAccessService {
  private readonly environment: AuditEvent["environment"];
  private readonly now: () => Date;

  public constructor(
    private readonly options: CustomerKeyAccessServiceOptions,
  ) {
    this.environment = options.environment ?? "LOCAL";
    this.now = options.now ?? (() => new Date());
  }

  public async prepareKeyAccess(input: {
    readonly principal: AuthenticatedCustomerPrincipal | null;
    readonly orderId: string;
    readonly fulfillmentReference: string;
    readonly correlationId: CorrelationId;
  }): Promise<CustomerKeyAccessPrepareResult> {
    const eligibility = await this.resolveEligibleAccess(input);
    if (eligibility.status !== "ELIGIBLE") {
      await this.auditDenied(input, eligibility.code);
      return { code: eligibility.code, status: "DENIED" };
    }
    const prepared = await this.options.deliveryService.prepareDelivery({
      correlationId: input.correlationId,
      customerId: eligibility.customerId,
      fulfillmentId: eligibility.fulfillmentId,
      orderId: eligibility.orderId,
    });
    if (prepared.status !== "AUTHORIZED") {
      const code = prepareFailureCode(prepared);
      await this.auditDenied(input, code);
      return { code, status: "DENIED" };
    }
    await this.auditAccess(
      input,
      eligibility.customerId,
      "CUSTOMER_KEY_ACCESS_AUTHORIZED",
      "SUCCEEDED",
      "KEY_ACCESS_AUTHORIZED",
    );
    return {
      deliveryApprovalId: required(prepared.deliveryApprovalId),
      deliveryCapability: required(prepared.oneTimeCapability),
      expiresAt: required(prepared.expiresAt),
      status: "AUTHORIZED",
    };
  }

  public async executeKeyAccess(input: {
    readonly principal: AuthenticatedCustomerPrincipal | null;
    readonly orderId: string;
    readonly fulfillmentReference: string;
    readonly deliveryApprovalId: string;
    readonly deliveryCapability: string;
    readonly correlationId: CorrelationId;
  }): Promise<CustomerKeyAccessExecuteResult> {
    const eligibility = await this.resolveEligibleAccess(input);
    if (eligibility.status !== "ELIGIBLE") {
      await this.auditDenied(input, eligibility.code);
      return { code: eligibility.code, status: "DENIED" };
    }
    const delivered = await this.options.deliveryService.executeDelivery({
      capability: input.deliveryCapability,
      channel: "FAKE",
      correlationId: input.correlationId,
      customerId: eligibility.customerId,
      deliveryApprovalId: input.deliveryApprovalId,
      fulfillmentId: eligibility.fulfillmentId,
      orderId: eligibility.orderId,
    });
    return this.mapExecuteResult(input, eligibility.customerId, delivered);
  }

  private async resolveEligibleAccess(input: {
    readonly principal: AuthenticatedCustomerPrincipal | null;
    readonly orderId: string;
    readonly fulfillmentReference: string;
  }): Promise<
    | {
        readonly status: "ELIGIBLE";
        readonly customerId: CustomerId;
        readonly orderId: ReturnType<typeof orderId>;
        readonly fulfillmentId: string;
      }
    | { readonly status: "DENIED"; readonly code: CustomerKeyAccessFailureCode }
  > {
    const principal = acceptedPrincipal(input.principal);
    if (!principal) {
      return { code: "AUTHENTICATION_REQUIRED", status: "DENIED" };
    }
    if (!isSafeUuid(input.orderId) || !isSafeUuid(input.fulfillmentReference)) {
      return { code: "RESOURCE_NOT_AVAILABLE", status: "DENIED" };
    }
    const requestedOrderId = orderId(input.orderId);
    const order = await this.options.accountRepository.findOwnedOrderDetail({
      customerId: principal.customerId,
      orderId: requestedOrderId,
    });
    const fulfillment = order?.fulfillment;
    if (
      !order ||
      !fulfillment ||
      fulfillment.fulfillmentId !== input.fulfillmentReference ||
      fulfillment.orderId !== order.orderId
    ) {
      return { code: "RESOURCE_NOT_AVAILABLE", status: "DENIED" };
    }
    if (
      !keyAccessAvailable({
        fulfillment,
        orderCustomerId: order.customerId,
        orderId: order.orderId,
        principalCustomerId: principal.customerId,
      })
    ) {
      return { code: "KEY_ACCESS_NOT_AVAILABLE", status: "DENIED" };
    }
    return {
      customerId: principal.customerId,
      fulfillmentId: fulfillment.fulfillmentId,
      orderId: order.orderId,
      status: "ELIGIBLE",
    };
  }

  private async mapExecuteResult(
    input: {
      readonly correlationId: CorrelationId;
      readonly fulfillmentReference: string;
    },
    customerIdValue: CustomerId,
    result: DeliveryExecuteResult,
  ): Promise<CustomerKeyAccessExecuteResult> {
    if (
      result.status === "DELIVERED" ||
      result.status === "ALREADY_DELIVERED" ||
      result.status === "IN_FLIGHT" ||
      result.status === "MANUAL_REVIEW_REQUIRED"
    ) {
      await this.auditAccess(
        input,
        customerIdValue,
        result.status === "DELIVERED"
          ? "CUSTOMER_KEY_ACCESS_DELIVERED"
          : "CUSTOMER_KEY_ACCESS_NOT_DELIVERED",
        result.status === "DELIVERED" ? "SUCCEEDED" : "DENIED",
        result.status,
      );
      return {
        ...(result.fulfillmentId
          ? { fulfillmentId: result.fulfillmentId }
          : {}),
        status: result.status,
      };
    }
    const code =
      result.status === "FAILED_RETRYABLE"
        ? "TEMPORARILY_UNAVAILABLE"
        : result.status === "BLOCKED"
          ? "KEY_ACCESS_NOT_AVAILABLE"
          : "CONFLICT";
    await this.auditAccess(
      input,
      customerIdValue,
      "CUSTOMER_KEY_ACCESS_DENIED",
      "DENIED",
      code,
    );
    return { code, status: "DENIED" };
  }

  private async auditDenied(
    input: {
      readonly principal: AuthenticatedCustomerPrincipal | null;
      readonly correlationId: CorrelationId;
      readonly fulfillmentReference: string;
    },
    reasonCode: CustomerKeyAccessFailureCode,
  ): Promise<void> {
    await this.auditAccess(
      input,
      input.principal?.customerId ?? "unknown-customer",
      "CUSTOMER_KEY_ACCESS_DENIED",
      "DENIED",
      reasonCode,
    );
  }

  private async auditAccess(
    input: {
      readonly correlationId: CorrelationId;
      readonly fulfillmentReference: string;
    },
    customerIdValue: CustomerId | string,
    eventType: AuditEvent["eventType"],
    outcome: AuditEvent["outcome"],
    reasonCode: string,
  ): Promise<void> {
    await this.options.audit?.append({
      actor: { id: customerIdValue, type: "CUSTOMER" },
      correlationId: input.correlationId,
      entity: {
        id: input.fulfillmentReference,
        type: "FULFILLMENT_OPERATION",
      },
      environment: this.environment,
      eventType,
      metadata: {
        customerId: customerIdValue,
        fulfillmentReference: input.fulfillmentReference,
        reasonCode,
      },
      outcome,
      reasonCode,
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

const prepareFailureCode = (
  result: DeliveryPrepareResult,
): CustomerKeyAccessFailureCode => {
  if (result.reasonCode === "FULFILLMENT_DELIVERY_UNAUTHORIZED") {
    return "RESOURCE_NOT_AVAILABLE";
  }
  if (result.reasonCode === "FULFILLMENT_DELIVERY_ALREADY_AUTHORIZED") {
    return "CONFLICT";
  }
  return "KEY_ACCESS_NOT_AVAILABLE";
};

const required = (value: string | undefined): string => {
  if (!value) {
    throw new Error("Expected customer key access delivery value");
  }
  return value;
};

const isSafeUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
