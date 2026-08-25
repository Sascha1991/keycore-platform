import { randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type {
  CorrelationId,
  CustomerId,
  OrderId,
} from "../domain/identifiers.js";
import { customerId } from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import type {
  CustomerDeliveryAuthorization,
  CustomerOrderAuthorizationPort,
} from "../fulfillment/customer-key-delivery.js";

export type EmailVerificationState = "UNVERIFIED" | "VERIFIED";

export type CustomerIdentityProvider = "KEYCORE" | "WOOCOMMERCE" | "TEST";

export interface KeyCoreCustomer {
  readonly id: CustomerId;
  readonly emailNormalized: string;
  readonly emailVerificationState: EmailVerificationState;
  readonly recordVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CustomerIdentityBinding {
  readonly id: string;
  readonly customerId: CustomerId;
  readonly provider: CustomerIdentityProvider;
  readonly providerSubject: string;
  readonly createdAt: Date;
}

export interface AuthenticatedCustomerPrincipal {
  readonly customerId: CustomerId;
  readonly authenticationContext: {
    readonly provider: CustomerIdentityProvider;
    readonly assurance: "TEST" | "AUTHENTICATED";
  };
}

export interface AuthenticatedCustomerPrincipalProvider {
  currentPrincipal(): Promise<AuthenticatedCustomerPrincipal | null>;
}

export interface TrustedOrderOwnershipBindingContext {
  readonly actorType: "SERVICE" | "ADMIN";
  readonly actorId: string;
  readonly reasonCode: "ORDER_OWNERSHIP_INITIAL_BINDING";
}

export type CustomerCreateResult =
  | { readonly status: "CREATED"; readonly customer: KeyCoreCustomer }
  | { readonly status: "EXISTING"; readonly customer: KeyCoreCustomer }
  | { readonly status: "INVALID_EMAIL" };

export type CustomerIdentityBindingResult =
  | {
      readonly status: "BOUND";
      readonly binding: CustomerIdentityBinding;
    }
  | {
      readonly status: "ALREADY_BOUND";
      readonly binding: CustomerIdentityBinding;
    }
  | { readonly status: "IDENTITY_CONFLICT" };

export type OrderOwnershipBindingResult =
  | { readonly status: "BOUND"; readonly order: OwnedOrderSnapshot }
  | { readonly status: "ALREADY_BOUND"; readonly order: OwnedOrderSnapshot }
  | {
      readonly status: "OWNERSHIP_CONFLICT";
      readonly order?: OwnedOrderSnapshot;
    }
  | { readonly status: "STALE_WRITER"; readonly order?: OwnedOrderSnapshot }
  | { readonly status: "ORDER_NOT_FOUND" }
  | { readonly status: "CUSTOMER_NOT_FOUND" }
  | { readonly status: "UNTRUSTED_CONTEXT" };

export interface OwnedOrderSnapshot {
  readonly orderId: OrderId;
  readonly customerId: CustomerId | null;
  readonly recordVersion: number;
  readonly status: string;
  readonly paymentStatus: string;
  readonly procurementStatus: string;
  readonly fulfillmentStatus: string;
  readonly updatedAt: Date;
}

export interface CustomerOrderIdentityRepository {
  createCustomer(input: {
    readonly customer: KeyCoreCustomer;
    readonly now: Date;
  }): Promise<
    | { readonly status: "CREATED"; readonly customer: KeyCoreCustomer }
    | { readonly status: "EXISTING"; readonly customer: KeyCoreCustomer }
  >;
  findCustomerById(customerId: CustomerId): Promise<KeyCoreCustomer | null>;
  findCustomerByNormalizedEmail(
    emailNormalized: string,
  ): Promise<KeyCoreCustomer | null>;
  bindIdentity(input: {
    readonly binding: CustomerIdentityBinding;
  }): Promise<CustomerIdentityBindingResult>;
  bindOrderOwnership(input: {
    readonly orderId: OrderId;
    readonly customerId: CustomerId;
    readonly expectedOrderVersion: number;
    readonly now: Date;
  }): Promise<
    Exclude<
      OrderOwnershipBindingResult,
      { readonly status: "UNTRUSTED_CONTEXT" }
    >
  >;
  authorizeFulfillmentForCustomer(input: {
    readonly customerId: CustomerId;
    readonly orderId: OrderId;
    readonly fulfillmentId: string;
    readonly requireVerifiedEmail: boolean;
  }): Promise<
    { readonly status: "AUTHORIZED" } | { readonly status: "DENIED" }
  >;
  inspectCustomer(customerId: CustomerId): Promise<CustomerInspection | null>;
  inspectOrderOwnership(
    orderId: OrderId,
  ): Promise<OrderOwnershipInspection | null>;
}

export interface CustomerInspection {
  readonly customerId: CustomerId;
  readonly emailMasked: string;
  readonly emailVerificationState: EmailVerificationState;
  readonly recordVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OrderOwnershipInspection {
  readonly orderId: OrderId;
  readonly ownershipBound: boolean;
  readonly ownerCustomerId: CustomerId | null;
  readonly recordVersion: number;
  readonly status: string;
  readonly fulfillmentStatus: string;
}

export interface CustomerOrderIdentityServiceOptions {
  readonly repository: CustomerOrderIdentityRepository;
  readonly audit?: AuditEventPort;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
}

export class CustomerOrderIdentityService {
  private readonly now: () => Date;
  private readonly environment: AuditEvent["environment"];

  public constructor(
    private readonly options: CustomerOrderIdentityServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.environment = options.environment ?? "LOCAL";
  }

  public async createCustomer(input: {
    readonly email: string;
    readonly emailVerificationState?: EmailVerificationState;
    readonly correlationId: CorrelationId;
  }): Promise<CustomerCreateResult> {
    const normalized = normalizeCustomerEmail(input.email);
    if (!normalized) {
      return { status: "INVALID_EMAIL" };
    }
    const now = this.now();
    const result = await this.options.repository.createCustomer({
      customer: {
        createdAt: now,
        emailNormalized: normalized,
        emailVerificationState: input.emailVerificationState ?? "UNVERIFIED",
        id: customerId(randomUUID()),
        recordVersion: 1,
        updatedAt: now,
      },
      now,
    });
    await this.audit({
      correlationId: input.correlationId,
      customerId: result.customer.id,
      eventType:
        result.status === "CREATED"
          ? "CUSTOMER_CREATED"
          : "CUSTOMER_IDEMPOTENT_REPLAY",
      outcome: "SUCCEEDED",
      reasonCode: result.status,
    });
    return result;
  }

  public async bindIdentity(input: {
    readonly customerId: CustomerId;
    readonly provider: CustomerIdentityProvider;
    readonly providerSubject: string;
    readonly correlationId: CorrelationId;
  }): Promise<CustomerIdentityBindingResult> {
    const customer = await this.options.repository.findCustomerById(
      input.customerId,
    );
    if (!customer || input.providerSubject.trim().length === 0) {
      return { status: "IDENTITY_CONFLICT" };
    }
    const result = await this.options.repository.bindIdentity({
      binding: {
        createdAt: this.now(),
        customerId: input.customerId,
        id: randomUUID(),
        provider: input.provider,
        providerSubject: input.providerSubject.trim(),
      },
    });
    await this.audit({
      correlationId: input.correlationId,
      customerId: input.customerId,
      eventType:
        result.status === "IDENTITY_CONFLICT"
          ? "CUSTOMER_IDENTITY_BINDING_CONFLICT"
          : "CUSTOMER_IDENTITY_BOUND",
      outcome: result.status === "IDENTITY_CONFLICT" ? "DENIED" : "SUCCEEDED",
      reasonCode: result.status,
      metadata: { provider: input.provider },
    });
    return result;
  }

  public async bindOrderOwnership(input: {
    readonly orderId: OrderId;
    readonly customerId: CustomerId;
    readonly expectedOrderVersion: number;
    readonly trustedContext: TrustedOrderOwnershipBindingContext | null;
    readonly correlationId: CorrelationId;
  }): Promise<OrderOwnershipBindingResult> {
    if (
      !input.trustedContext ||
      input.trustedContext.actorId.trim().length === 0
    ) {
      return { status: "UNTRUSTED_CONTEXT" };
    }
    const result = await this.options.repository.bindOrderOwnership({
      customerId: input.customerId,
      expectedOrderVersion: input.expectedOrderVersion,
      now: this.now(),
      orderId: input.orderId,
    });
    await this.audit({
      correlationId: input.correlationId,
      customerId: input.customerId,
      eventType:
        result.status === "BOUND" || result.status === "ALREADY_BOUND"
          ? "ORDER_OWNERSHIP_BOUND"
          : "ORDER_OWNERSHIP_CONFLICT",
      outcome:
        result.status === "BOUND" || result.status === "ALREADY_BOUND"
          ? "SUCCEEDED"
          : "DENIED",
      reasonCode: result.status,
      metadata: { orderId: input.orderId },
    });
    return result;
  }

  private async audit(input: {
    readonly customerId: CustomerId;
    readonly correlationId: CorrelationId;
    readonly eventType: AuditEvent["eventType"];
    readonly outcome: AuditEvent["outcome"];
    readonly reasonCode: string;
    readonly metadata?: Readonly<
      Record<string, string | number | boolean | null>
    >;
  }): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "customer-order-identity-service", type: "SERVICE" },
      correlationId: input.correlationId,
      entity: { id: input.customerId, type: "CUSTOMER" },
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

export class PersistedCustomerOrderAuthorizationPort implements CustomerOrderAuthorizationPort {
  public constructor(
    private readonly options: {
      readonly repository: CustomerOrderIdentityRepository;
      readonly principalProvider: AuthenticatedCustomerPrincipalProvider;
      readonly requireVerifiedEmail?: boolean;
      readonly audit?: AuditEventPort;
      readonly environment?: AuditEvent["environment"];
      readonly now?: () => Date;
    },
  ) {}

  public async authorizeDelivery(
    authorization: CustomerDeliveryAuthorization,
  ): Promise<
    { readonly status: "AUTHORIZED" } | { readonly status: "DENIED" }
  > {
    const principal = await this.options.principalProvider.currentPrincipal();
    if (!principal || principal.customerId !== authorization.customerId) {
      await this.auditDenied(authorization, principal?.customerId ?? null);
      return { status: "DENIED" };
    }
    const result =
      await this.options.repository.authorizeFulfillmentForCustomer({
        customerId: principal.customerId,
        fulfillmentId: authorization.fulfillmentId,
        orderId: authorization.orderId,
        requireVerifiedEmail: this.options.requireVerifiedEmail !== false,
      });
    if (result.status !== "AUTHORIZED") {
      await this.auditDenied(authorization, principal.customerId);
    }
    return result;
  }

  private async auditDenied(
    authorization: CustomerDeliveryAuthorization,
    principalCustomerId: CustomerId | null,
  ): Promise<void> {
    await this.options.audit?.append({
      actor: {
        id: principalCustomerId ?? "missing-principal",
        type: principalCustomerId ? "CUSTOMER" : "SYSTEM",
      },
      correlationId: `authz-${authorization.fulfillmentId}` as CorrelationId,
      entity: {
        id: authorization.fulfillmentId,
        type: "FULFILLMENT_OPERATION",
      },
      environment: this.options.environment ?? "LOCAL",
      eventType: "FULFILLMENT_AUTHORIZATION_DENIED",
      metadata: {
        fulfillmentId: authorization.fulfillmentId,
        orderId: authorization.orderId,
        reasonCode: "FULFILLMENT_DELIVERY_UNAUTHORIZED",
      },
      outcome: "DENIED",
      reasonCode: "FULFILLMENT_DELIVERY_UNAUTHORIZED",
      timestampUtc: this.options.now?.() ?? new Date(),
      uuid: randomUUID(),
    });
  }
}

export class StaticAuthenticatedCustomerPrincipalProvider implements AuthenticatedCustomerPrincipalProvider {
  public constructor(
    private readonly principal: AuthenticatedCustomerPrincipal | null,
  ) {}

  public async currentPrincipal(): Promise<AuthenticatedCustomerPrincipal | null> {
    return this.principal;
  }
}

export class FailClosedProductionPrincipalProvider implements AuthenticatedCustomerPrincipalProvider {
  public async currentPrincipal(): Promise<null> {
    return null;
  }
}

export const normalizeCustomerEmail = (email: string): string | null => {
  const trimmed = email.trim();
  if (trimmed.length > 254 || /\s/u.test(trimmed)) {
    return null;
  }
  const atIndex = trimmed.indexOf("@");
  if (atIndex <= 0 || atIndex !== trimmed.lastIndexOf("@")) {
    return null;
  }
  const local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1).toLowerCase();
  if (
    local.length === 0 ||
    domain.length === 0 ||
    domain.length > 253 ||
    !domain.includes(".") ||
    domain.startsWith(".") ||
    domain.endsWith(".")
  ) {
    return null;
  }
  return `${local}@${domain}`;
};

export const maskCustomerEmail = (emailNormalized: string): string => {
  const [local = "", domain = ""] = emailNormalized.split("@");
  const visibleLocal = local.slice(0, 1);
  return `${visibleLocal}${"*".repeat(Math.min(6, Math.max(1, local.length - 1)))}@${domain}`;
};
