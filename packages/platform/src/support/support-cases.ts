import { randomUUID } from "node:crypto";

import type { AuditEventPort } from "../ports/core.js";
import type { AuditEvent } from "../domain/audit.js";
import type {
  CorrelationId,
  CustomerId,
  OrderId,
} from "../domain/identifiers.js";
import type { AuthenticatedCustomerPrincipal } from "../customers/customer-order-identity.js";

export type SupportCaseCategory =
  | "ACCOUNT_PROBLEM"
  | "ACTIVATION_PROBLEM"
  | "INVOICE_PROBLEM"
  | "KEY_NOT_AVAILABLE"
  | "KEY_REVEAL_PROBLEM"
  | "ORDER_STATUS"
  | "PAYMENT_PROBLEM"
  | "REFUND_REQUEST"
  | "SUPPLIER_PROBLEM"
  | "SUSPECTED_DUPLICATE_ORDER"
  | "OTHER";

export type SupportCaseStatus =
  | "OPEN"
  | "IN_PROGRESS"
  | "WAITING_FOR_CUSTOMER"
  | "WAITING_FOR_INTERNAL"
  | "RESOLVED"
  | "CLOSED";

export type SupportCasePriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type SupportCaseSource = "CUSTOMER" | "OPERATOR" | "SYSTEM";
export type SupportMessageAuthorType = "CUSTOMER" | "OPERATOR" | "SYSTEM";
export type SupportMessageVisibility = "CUSTOMER_VISIBLE" | "INTERNAL";

export type SupportCaseResolutionCode =
  | "CUSTOMER_ACTION_REQUIRED"
  | "DUPLICATE_REQUEST"
  | "INFORMATION_PROVIDED"
  | "NO_PLATFORM_ERROR_FOUND"
  | "ORDER_COMPLETED"
  | "REFUND_REFERRED"
  | "SUPPLIER_REVIEW_REQUIRED";

export type SupportCaseLinkType =
  "DISPUTE_EVIDENCE" | "FRAUD_REVIEW" | "FRAUD_EVALUATION" | "FULFILLMENT";

export type SupportCaseEventType =
  | "CASE_CREATED"
  | "MESSAGE_ADDED"
  | "STATUS_CHANGED"
  | "PRIORITY_CHANGED"
  | "EVIDENCE_LINKED"
  | "FRAUD_REVIEW_LINKED"
  | "FRAUD_EVALUATION_LINKED"
  | "FULFILLMENT_LINKED"
  | "CASE_RESOLVED"
  | "CASE_CLOSED";

export type SupportCaseFailureCode =
  | "AUTHENTICATION_REQUIRED"
  | "BAD_REQUEST"
  | "CLOSED_TO_REPLIES"
  | "CONFLICT"
  | "INVALID_TRANSITION"
  | "RESOURCE_NOT_AVAILABLE"
  | "STALE_VERSION"
  | "UNTRUSTED_AUTHORITY";

export interface SupportCase {
  readonly id: string;
  readonly customerId: CustomerId | null;
  readonly orderId: OrderId | null;
  readonly category: SupportCaseCategory;
  readonly status: SupportCaseStatus;
  readonly priority: SupportCasePriority;
  readonly source: SupportCaseSource;
  readonly resolutionCode: SupportCaseResolutionCode | null;
  readonly recordVersion: number;
  readonly correlationId: CorrelationId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly resolvedAt: Date | null;
  readonly closedAt: Date | null;
}

export interface SupportMessage {
  readonly id: string;
  readonly caseId: string;
  readonly authorType: SupportMessageAuthorType;
  readonly visibility: SupportMessageVisibility;
  readonly body: string;
  readonly createdAt: Date;
}

export interface SupportCaseLink {
  readonly id: string;
  readonly caseId: string;
  readonly linkType: SupportCaseLinkType;
  readonly targetId: string;
  readonly orderId: OrderId;
  readonly createdAt: Date;
}

export interface SupportCaseEvent {
  readonly id: string;
  readonly caseId: string;
  readonly eventType: SupportCaseEventType;
  readonly actorType: SupportMessageAuthorType;
  readonly actorReference: string;
  readonly fromStatus: SupportCaseStatus | null;
  readonly toStatus: SupportCaseStatus | null;
  readonly fromPriority: SupportCasePriority | null;
  readonly toPriority: SupportCasePriority | null;
  readonly linkType: SupportCaseLinkType | null;
  readonly linkTargetId: string | null;
  readonly occurredAt: Date;
}

export interface CustomerSupportCaseView {
  readonly id: string;
  readonly customerId: CustomerId | null;
  readonly orderId: OrderId | null;
  readonly category: SupportCaseCategory;
  readonly status: SupportCaseStatus;
  readonly resolutionCode: SupportCaseResolutionCode | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly resolvedAt: Date | null;
  readonly closedAt: Date | null;
}

export interface CustomerSupportMessageView {
  readonly id: string;
  readonly caseId: string;
  readonly authorType: SupportMessageAuthorType;
  readonly body: string;
  readonly createdAt: Date;
}

export interface SupportOrderReference {
  readonly orderId: OrderId;
  readonly customerId: CustomerId | null;
}

export interface SupportCustomerReference {
  readonly customerId: CustomerId;
}

export interface SupportLinkedReference {
  readonly id: string;
  readonly orderId: OrderId;
}

export interface CustomerSupportCaseDetail {
  readonly case: CustomerSupportCaseView;
  readonly messages: readonly CustomerSupportMessageView[];
}

export interface OperatorSupportCaseDetail {
  readonly case: SupportCase;
  readonly messages: readonly SupportMessage[];
  readonly links: readonly SupportCaseLink[];
  readonly events: readonly SupportCaseEvent[];
}

export interface SupportCaseListPage {
  readonly items: readonly CustomerSupportCaseView[];
  readonly nextCursor: string | null;
}

export interface SupportCaseRepositoryListPage {
  readonly items: readonly SupportCase[];
  readonly nextCursor: string | null;
}

export interface SupportCaseRepository {
  findCustomerById(
    customerId: CustomerId,
  ): Promise<SupportCustomerReference | null>;
  findOrderForCustomer(input: {
    readonly orderId: OrderId;
    readonly customerId: CustomerId;
  }): Promise<SupportOrderReference | null>;
  findOrderById(orderId: OrderId): Promise<SupportOrderReference | null>;
  createCase(input: {
    readonly supportCase: SupportCase;
    readonly initialMessage: SupportMessage;
    readonly event: SupportCaseEvent;
  }): Promise<OperatorSupportCaseDetail>;
  findCustomerCaseById(input: {
    readonly caseId: string;
    readonly customerId: CustomerId;
  }): Promise<CustomerSupportCaseDetail | null>;
  findCaseById(caseId: string): Promise<OperatorSupportCaseDetail | null>;
  listCustomerCases(input: {
    readonly customerId: CustomerId;
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<SupportCaseRepositoryListPage>;
  addMessage(input: {
    readonly caseId: string;
    readonly customerId?: CustomerId;
    readonly message: SupportMessage;
    readonly event: SupportCaseEvent;
    readonly allowedStatuses: readonly SupportCaseStatus[];
  }): Promise<
    | { readonly status: "ADDED"; readonly detail: OperatorSupportCaseDetail }
    | { readonly status: "RESOURCE_NOT_AVAILABLE" }
    | { readonly status: "CLOSED_TO_REPLIES" }
  >;
  transitionCase(input: {
    readonly caseId: string;
    readonly expectedVersion: number;
    readonly nextStatus: SupportCaseStatus;
    readonly resolutionCode: SupportCaseResolutionCode | null;
    readonly now: Date;
    readonly event: SupportCaseEvent;
  }): Promise<
    | { readonly status: "UPDATED"; readonly detail: OperatorSupportCaseDetail }
    | { readonly status: "RESOURCE_NOT_AVAILABLE" }
    | { readonly status: "STALE_VERSION" }
  >;
  updatePriority(input: {
    readonly caseId: string;
    readonly expectedVersion: number;
    readonly priority: SupportCasePriority;
    readonly now: Date;
    readonly event: SupportCaseEvent;
  }): Promise<
    | { readonly status: "UPDATED"; readonly detail: OperatorSupportCaseDetail }
    | { readonly status: "RESOURCE_NOT_AVAILABLE" }
    | { readonly status: "STALE_VERSION" }
  >;
  findDisputeEvidence(id: string): Promise<SupportLinkedReference | null>;
  findFraudReview(id: string): Promise<SupportLinkedReference | null>;
  findFraudEvaluation(id: string): Promise<SupportLinkedReference | null>;
  findFulfillment(id: string): Promise<SupportLinkedReference | null>;
  linkReference(input: {
    readonly caseId: string;
    readonly link: SupportCaseLink;
    readonly event: SupportCaseEvent;
  }): Promise<
    | { readonly status: "LINKED"; readonly detail: OperatorSupportCaseDetail }
    | { readonly status: "RESOURCE_NOT_AVAILABLE" }
    | { readonly status: "CONFLICT" }
  >;
}

export interface SupportOperatorAuthorityPort {
  authorize(input: {
    readonly action:
      | "CREATE_CASE"
      | "ADD_NOTE"
      | "CHANGE_STATUS"
      | "CHANGE_PRIORITY"
      | "LINK_REFERENCE";
    readonly caseId?: string;
    readonly correlationId: CorrelationId;
  }): Promise<
    | { readonly status: "AUTHORIZED"; readonly operatorReference: string }
    | { readonly status: "DENIED" }
  >;
}

export class FailClosedSupportOperatorAuthority implements SupportOperatorAuthorityPort {
  public async authorize(): Promise<{ readonly status: "DENIED" }> {
    return { status: "DENIED" };
  }
}

export type CustomerCreateSupportCaseResult =
  | { readonly status: "CREATED"; readonly detail: CustomerSupportCaseDetail }
  | { readonly status: "FAILED"; readonly code: SupportCaseFailureCode };

export type CustomerSupportCaseResult =
  | { readonly status: "FOUND"; readonly detail: CustomerSupportCaseDetail }
  | { readonly status: "FAILED"; readonly code: SupportCaseFailureCode };

export type CustomerSupportCaseListResult =
  | { readonly status: "LISTED"; readonly page: SupportCaseListPage }
  | { readonly status: "FAILED"; readonly code: SupportCaseFailureCode };

export type OperatorSupportCaseResult =
  | { readonly status: "OK"; readonly detail: OperatorSupportCaseDetail }
  | { readonly status: "FAILED"; readonly code: SupportCaseFailureCode };

export const supportMessageMaxLength = 5_000;
export const supportCaseDefaultPageSize = 20;
export const supportCaseMaxPageSize = 100;
const supportCorrelationIdMaxLength = 128;
const supportCursorMaxLength = 512;

const accountOnlyCategories = new Set<SupportCaseCategory>(["ACCOUNT_PROBLEM"]);
const supportCaseCategories = new Set<SupportCaseCategory>([
  "ACCOUNT_PROBLEM",
  "ACTIVATION_PROBLEM",
  "INVOICE_PROBLEM",
  "KEY_NOT_AVAILABLE",
  "KEY_REVEAL_PROBLEM",
  "ORDER_STATUS",
  "PAYMENT_PROBLEM",
  "REFUND_REQUEST",
  "SUPPLIER_PROBLEM",
  "SUSPECTED_DUPLICATE_ORDER",
  "OTHER",
]);
const supportCasePriorities = new Set<SupportCasePriority>([
  "LOW",
  "NORMAL",
  "HIGH",
  "URGENT",
]);
const supportMessageVisibilities = new Set<SupportMessageVisibility>([
  "CUSTOMER_VISIBLE",
  "INTERNAL",
]);
const supportCaseStatuses = new Set<SupportCaseStatus>([
  "OPEN",
  "IN_PROGRESS",
  "WAITING_FOR_CUSTOMER",
  "WAITING_FOR_INTERNAL",
  "RESOLVED",
  "CLOSED",
]);
const supportResolutionCodes = new Set<SupportCaseResolutionCode>([
  "CUSTOMER_ACTION_REQUIRED",
  "DUPLICATE_REQUEST",
  "INFORMATION_PROVIDED",
  "NO_PLATFORM_ERROR_FOUND",
  "ORDER_COMPLETED",
  "REFUND_REFERRED",
  "SUPPLIER_REVIEW_REQUIRED",
]);
const supportLinkTypes = new Set<SupportCaseLinkType>([
  "DISPUTE_EVIDENCE",
  "FRAUD_REVIEW",
  "FRAUD_EVALUATION",
  "FULFILLMENT",
]);
const customerReplyStatuses = new Set<SupportCaseStatus>([
  "OPEN",
  "IN_PROGRESS",
  "WAITING_FOR_CUSTOMER",
  "WAITING_FOR_INTERNAL",
]);

const forbiddenCustomerFields = new Set([
  "customerId",
  "status",
  "priority",
  "resolutionCode",
  "operatorId",
  "operatorReference",
  "internalVisibility",
  "visibility",
  "authorType",
  "evidenceSnapshotId",
  "fraudReviewCaseId",
  "fraudEvaluationId",
  "fulfillmentId",
]);

const transitionGraph: ReadonlyMap<
  SupportCaseStatus,
  readonly SupportCaseStatus[]
> = new Map([
  [
    "OPEN",
    [
      "IN_PROGRESS",
      "WAITING_FOR_CUSTOMER",
      "WAITING_FOR_INTERNAL",
      "RESOLVED",
      "CLOSED",
    ],
  ],
  [
    "IN_PROGRESS",
    ["WAITING_FOR_CUSTOMER", "WAITING_FOR_INTERNAL", "RESOLVED", "CLOSED"],
  ],
  ["WAITING_FOR_CUSTOMER", ["IN_PROGRESS", "RESOLVED", "CLOSED"]],
  [
    "WAITING_FOR_INTERNAL",
    ["IN_PROGRESS", "WAITING_FOR_CUSTOMER", "RESOLVED", "CLOSED"],
  ],
  ["RESOLVED", ["CLOSED"]],
  ["CLOSED", []],
]);

export class SupportCaseService {
  private readonly authority: SupportOperatorAuthorityPort;

  public constructor(
    private readonly options: {
      readonly repository: SupportCaseRepository;
      readonly audit?: AuditEventPort;
      readonly environment?: AuditEvent["environment"];
      readonly now?: () => Date;
      readonly operatorAuthority?: SupportOperatorAuthorityPort;
    },
  ) {
    this.authority =
      options.operatorAuthority ?? new FailClosedSupportOperatorAuthority();
  }

  public async createCustomerCase(input: {
    readonly principal: AuthenticatedCustomerPrincipal | null;
    readonly category: SupportCaseCategory;
    readonly orderId?: OrderId;
    readonly message: string;
    readonly correlationId: CorrelationId;
    readonly [key: string]: unknown;
  }): Promise<CustomerCreateSupportCaseResult> {
    const principal = requireAuthenticatedCustomer(input.principal);
    if (!principal) {
      return { code: "AUTHENTICATION_REQUIRED", status: "FAILED" };
    }
    if (
      containsForbiddenCustomerField(input) ||
      !isSupportCaseCategory(input.category) ||
      !isSafeCorrelationId(input.correlationId) ||
      (input.orderId !== undefined && !isUuid(input.orderId)) ||
      !isSafeDate(this.now())
    ) {
      return { code: "BAD_REQUEST", status: "FAILED" };
    }
    const message = normalizeMessageBody(input.message);
    if (!message) {
      return { code: "BAD_REQUEST", status: "FAILED" };
    }
    const customer = await this.options.repository.findCustomerById(
      principal.customerId,
    );
    if (!customer) {
      return { code: "RESOURCE_NOT_AVAILABLE", status: "FAILED" };
    }

    const needsOrder = !accountOnlyCategories.has(input.category);
    let order: SupportOrderReference | null = null;
    if (needsOrder) {
      if (!input.orderId) {
        return { code: "BAD_REQUEST", status: "FAILED" };
      }
      order = await this.options.repository.findOrderForCustomer({
        customerId: principal.customerId,
        orderId: input.orderId,
      });
      if (!order) {
        return { code: "RESOURCE_NOT_AVAILABLE", status: "FAILED" };
      }
    } else if (input.orderId) {
      order = await this.options.repository.findOrderForCustomer({
        customerId: principal.customerId,
        orderId: input.orderId,
      });
      if (!order) {
        return { code: "RESOURCE_NOT_AVAILABLE", status: "FAILED" };
      }
    }

    const now = this.now();
    const supportCase = makeSupportCase({
      category: input.category,
      correlationId: input.correlationId,
      customerId: principal.customerId,
      orderId: order?.orderId ?? null,
      priority: "NORMAL",
      source: "CUSTOMER",
      status: "OPEN",
      now,
    });
    const initialMessage = makeSupportMessage({
      authorType: "CUSTOMER",
      body: message,
      caseId: supportCase.id,
      now,
      visibility: "CUSTOMER_VISIBLE",
    });
    const event = makeSupportEvent({
      actorReference: principal.customerId,
      actorType: "CUSTOMER",
      caseId: supportCase.id,
      eventType: "CASE_CREATED",
      now,
    });

    const created = await this.options.repository.createCase({
      event,
      initialMessage,
      supportCase,
    });
    await this.audit({
      actor: { id: principal.customerId, type: "CUSTOMER" },
      correlationId: input.correlationId,
      entity: { id: supportCase.id, type: "SupportCase" },
      eventType: "SUPPORT_CASE_CREATED",
      metadata: {
        caseId: supportCase.id,
        category: supportCase.category,
        customerId: principal.customerId,
        orderId: supportCase.orderId,
        source: supportCase.source,
        status: supportCase.status,
      },
      outcome: "SUCCEEDED",
      reasonCode: "CREATED",
    });
    return { detail: toCustomerDetail(created), status: "CREATED" };
  }

  public async getCustomerCase(input: {
    readonly principal: AuthenticatedCustomerPrincipal | null;
    readonly caseId: string;
  }): Promise<CustomerSupportCaseResult> {
    const principal = requireAuthenticatedCustomer(input.principal);
    if (!principal) {
      return { code: "AUTHENTICATION_REQUIRED", status: "FAILED" };
    }
    if (!isUuid(input.caseId)) {
      return { code: "BAD_REQUEST", status: "FAILED" };
    }
    const detail = await this.options.repository.findCustomerCaseById({
      caseId: input.caseId,
      customerId: principal.customerId,
    });
    return detail
      ? { detail, status: "FOUND" }
      : { code: "RESOURCE_NOT_AVAILABLE", status: "FAILED" };
  }

  public async listCustomerCases(input: {
    readonly principal: AuthenticatedCustomerPrincipal | null;
    readonly limit?: number;
    readonly cursor?: string | null;
  }): Promise<CustomerSupportCaseListResult> {
    const principal = requireAuthenticatedCustomer(input.principal);
    if (!principal) {
      return { code: "AUTHENTICATION_REQUIRED", status: "FAILED" };
    }
    const pageSize = parsePageSize(input.limit);
    if (pageSize.status === "INVALID" || !isValidCursor(input.cursor ?? null)) {
      return { code: "BAD_REQUEST", status: "FAILED" };
    }
    const page = await this.options.repository.listCustomerCases({
      cursor: input.cursor ?? null,
      customerId: principal.customerId,
      limit: pageSize.limit,
    });
    return {
      page: {
        items: page.items.map(toCustomerCaseView),
        nextCursor: page.nextCursor,
      },
      status: "LISTED",
    };
  }

  public async addCustomerReply(input: {
    readonly principal: AuthenticatedCustomerPrincipal | null;
    readonly caseId: string;
    readonly message: string;
    readonly correlationId: CorrelationId;
    readonly [key: string]: unknown;
  }): Promise<CustomerSupportCaseResult> {
    const principal = requireAuthenticatedCustomer(input.principal);
    if (!principal) {
      return { code: "AUTHENTICATION_REQUIRED", status: "FAILED" };
    }
    if (
      containsForbiddenCustomerField(input) ||
      !isUuid(input.caseId) ||
      !isSafeCorrelationId(input.correlationId) ||
      !isSafeDate(this.now())
    ) {
      return { code: "BAD_REQUEST", status: "FAILED" };
    }
    const body = normalizeMessageBody(input.message);
    if (!body) {
      return { code: "BAD_REQUEST", status: "FAILED" };
    }
    const now = this.now();
    const message = makeSupportMessage({
      authorType: "CUSTOMER",
      body,
      caseId: input.caseId,
      now,
      visibility: "CUSTOMER_VISIBLE",
    });
    const added = await this.options.repository.addMessage({
      allowedStatuses: [...customerReplyStatuses],
      caseId: input.caseId,
      customerId: principal.customerId,
      event: makeSupportEvent({
        actorReference: principal.customerId,
        actorType: "CUSTOMER",
        caseId: input.caseId,
        eventType: "MESSAGE_ADDED",
        now,
      }),
      message,
    });
    if (added.status !== "ADDED") {
      return { code: added.status, status: "FAILED" };
    }
    await this.audit({
      actor: { id: principal.customerId, type: "CUSTOMER" },
      correlationId: input.correlationId,
      entity: { id: input.caseId, type: "SupportCase" },
      eventType: "SUPPORT_MESSAGE_ADDED",
      metadata: {
        authorType: "CUSTOMER",
        caseId: input.caseId,
        visibility: "CUSTOMER_VISIBLE",
      },
      outcome: "SUCCEEDED",
      reasonCode: "MESSAGE_ADDED",
    });
    return { detail: toCustomerDetail(added.detail), status: "FOUND" };
  }

  public async createOperatorCase(input: {
    readonly category: SupportCaseCategory;
    readonly customerId?: CustomerId | null;
    readonly orderId?: OrderId | null;
    readonly priority?: SupportCasePriority;
    readonly message: string;
    readonly correlationId: CorrelationId;
  }): Promise<OperatorSupportCaseResult> {
    if (
      !isSupportCaseCategory(input.category) ||
      !isSafeCorrelationId(input.correlationId) ||
      (input.priority !== undefined &&
        !isSupportCasePriority(input.priority)) ||
      (input.orderId !== undefined &&
        input.orderId !== null &&
        !isUuid(input.orderId)) ||
      (input.customerId !== undefined &&
        input.customerId !== null &&
        !isUuid(input.customerId)) ||
      !isSafeDate(this.now())
    ) {
      return { code: "BAD_REQUEST", status: "FAILED" };
    }
    const authorization = await this.authority.authorize({
      action: "CREATE_CASE",
      correlationId: input.correlationId,
    });
    if (authorization.status !== "AUTHORIZED") {
      return { code: "UNTRUSTED_AUTHORITY", status: "FAILED" };
    }
    if (!isSafeActorReference(authorization.operatorReference)) {
      return { code: "UNTRUSTED_AUTHORITY", status: "FAILED" };
    }
    const body = normalizeMessageBody(input.message);
    if (!body) {
      return { code: "BAD_REQUEST", status: "FAILED" };
    }
    const order = input.orderId
      ? await this.options.repository.findOrderById(input.orderId)
      : null;
    if (input.orderId && !order) {
      return { code: "RESOURCE_NOT_AVAILABLE", status: "FAILED" };
    }
    if (
      input.customerId &&
      order?.customerId &&
      input.customerId !== order.customerId
    ) {
      return { code: "RESOURCE_NOT_AVAILABLE", status: "FAILED" };
    }
    if (input.customerId && order && !order.customerId) {
      return { code: "RESOURCE_NOT_AVAILABLE", status: "FAILED" };
    }
    if (input.customerId) {
      const customer = await this.options.repository.findCustomerById(
        input.customerId,
      );
      if (!customer) {
        return { code: "RESOURCE_NOT_AVAILABLE", status: "FAILED" };
      }
    }
    const now = this.now();
    const supportCase = makeSupportCase({
      category: input.category,
      correlationId: input.correlationId,
      customerId: order ? order.customerId : (input.customerId ?? null),
      orderId: order?.orderId ?? null,
      priority: input.priority ?? "NORMAL",
      source: "OPERATOR",
      status: "OPEN",
      now,
    });
    const detail = await this.options.repository.createCase({
      event: makeSupportEvent({
        actorReference: authorization.operatorReference,
        actorType: "OPERATOR",
        caseId: supportCase.id,
        eventType: "CASE_CREATED",
        now,
      }),
      initialMessage: makeSupportMessage({
        authorType: "OPERATOR",
        body,
        caseId: supportCase.id,
        now,
        visibility: "INTERNAL",
      }),
      supportCase,
    });
    await this.audit({
      actor: { id: authorization.operatorReference, type: "ADMIN" },
      correlationId: input.correlationId,
      entity: { id: supportCase.id, type: "SupportCase" },
      eventType: "SUPPORT_CASE_CREATED",
      metadata: {
        caseId: supportCase.id,
        category: supportCase.category,
        customerId: supportCase.customerId,
        orderId: supportCase.orderId,
        source: supportCase.source,
        status: supportCase.status,
      },
      outcome: "SUCCEEDED",
      reasonCode: "CREATED",
    });
    return { detail, status: "OK" };
  }

  public async addOperatorNote(input: {
    readonly caseId: string;
    readonly message: string;
    readonly visibility: SupportMessageVisibility;
    readonly correlationId: CorrelationId;
  }): Promise<OperatorSupportCaseResult> {
    if (
      !isUuid(input.caseId) ||
      !isSafeCorrelationId(input.correlationId) ||
      !isSupportMessageVisibility(input.visibility) ||
      !isSafeDate(this.now())
    ) {
      return { code: "BAD_REQUEST", status: "FAILED" };
    }
    const authorization = await this.authority.authorize({
      action: "ADD_NOTE",
      caseId: input.caseId,
      correlationId: input.correlationId,
    });
    if (authorization.status !== "AUTHORIZED") {
      return { code: "UNTRUSTED_AUTHORITY", status: "FAILED" };
    }
    if (!isSafeActorReference(authorization.operatorReference)) {
      return { code: "UNTRUSTED_AUTHORITY", status: "FAILED" };
    }
    const body = normalizeMessageBody(input.message);
    if (!body) {
      return { code: "BAD_REQUEST", status: "FAILED" };
    }
    const now = this.now();
    const added = await this.options.repository.addMessage({
      allowedStatuses: [
        "OPEN",
        "IN_PROGRESS",
        "WAITING_FOR_CUSTOMER",
        "WAITING_FOR_INTERNAL",
        "RESOLVED",
      ],
      caseId: input.caseId,
      event: makeSupportEvent({
        actorReference: authorization.operatorReference,
        actorType: "OPERATOR",
        caseId: input.caseId,
        eventType: "MESSAGE_ADDED",
        now,
      }),
      message: makeSupportMessage({
        authorType: "OPERATOR",
        body,
        caseId: input.caseId,
        now,
        visibility: input.visibility,
      }),
    });
    if (added.status !== "ADDED") {
      return { code: added.status, status: "FAILED" };
    }
    await this.audit({
      actor: { id: authorization.operatorReference, type: "ADMIN" },
      correlationId: input.correlationId,
      entity: { id: input.caseId, type: "SupportCase" },
      eventType: "SUPPORT_MESSAGE_ADDED",
      metadata: {
        authorType: "OPERATOR",
        caseId: input.caseId,
        visibility: input.visibility,
      },
      outcome: "SUCCEEDED",
      reasonCode: "MESSAGE_ADDED",
    });
    return { detail: added.detail, status: "OK" };
  }

  public async changePriority(input: {
    readonly caseId: string;
    readonly expectedVersion: number;
    readonly priority: SupportCasePriority;
    readonly correlationId: CorrelationId;
  }): Promise<OperatorSupportCaseResult> {
    if (
      !isUuid(input.caseId) ||
      !isSafeCorrelationId(input.correlationId) ||
      !isSupportCasePriority(input.priority) ||
      !isSafeExpectedVersion(input.expectedVersion) ||
      !isSafeDate(this.now())
    ) {
      return { code: "BAD_REQUEST", status: "FAILED" };
    }
    const authorization = await this.authority.authorize({
      action: "CHANGE_PRIORITY",
      caseId: input.caseId,
      correlationId: input.correlationId,
    });
    if (authorization.status !== "AUTHORIZED") {
      return { code: "UNTRUSTED_AUTHORITY", status: "FAILED" };
    }
    if (!isSafeActorReference(authorization.operatorReference)) {
      return { code: "UNTRUSTED_AUTHORITY", status: "FAILED" };
    }
    const current = await this.options.repository.findCaseById(input.caseId);
    if (!current) {
      return { code: "RESOURCE_NOT_AVAILABLE", status: "FAILED" };
    }
    const now = this.now();
    const updated = await this.options.repository.updatePriority({
      caseId: input.caseId,
      event: makeSupportEvent({
        actorReference: authorization.operatorReference,
        actorType: "OPERATOR",
        caseId: input.caseId,
        eventType: "PRIORITY_CHANGED",
        fromPriority: current.case.priority,
        now,
        toPriority: input.priority,
      }),
      expectedVersion: input.expectedVersion,
      now,
      priority: input.priority,
    });
    if (updated.status !== "UPDATED") {
      return { code: updated.status, status: "FAILED" };
    }
    await this.audit({
      actor: { id: authorization.operatorReference, type: "ADMIN" },
      correlationId: input.correlationId,
      entity: { id: input.caseId, type: "SupportCase" },
      eventType: "SUPPORT_PRIORITY_CHANGED",
      metadata: {
        caseId: input.caseId,
        priority: input.priority,
      },
      outcome: "SUCCEEDED",
      reasonCode: "PRIORITY_CHANGED",
    });
    return { detail: updated.detail, status: "OK" };
  }

  public async transitionCase(input: {
    readonly caseId: string;
    readonly expectedVersion: number;
    readonly nextStatus: SupportCaseStatus;
    readonly resolutionCode?: SupportCaseResolutionCode | null;
    readonly correlationId: CorrelationId;
  }): Promise<OperatorSupportCaseResult> {
    if (
      !isUuid(input.caseId) ||
      !isSafeCorrelationId(input.correlationId) ||
      !isSupportCaseStatus(input.nextStatus) ||
      !isSafeExpectedVersion(input.expectedVersion) ||
      (input.resolutionCode !== undefined &&
        input.resolutionCode !== null &&
        !isSupportResolutionCode(input.resolutionCode)) ||
      !isSafeDate(this.now())
    ) {
      return { code: "BAD_REQUEST", status: "FAILED" };
    }
    const authorization = await this.authority.authorize({
      action: "CHANGE_STATUS",
      caseId: input.caseId,
      correlationId: input.correlationId,
    });
    if (authorization.status !== "AUTHORIZED") {
      return { code: "UNTRUSTED_AUTHORITY", status: "FAILED" };
    }
    if (!isSafeActorReference(authorization.operatorReference)) {
      return { code: "UNTRUSTED_AUTHORITY", status: "FAILED" };
    }
    const current = await this.options.repository.findCaseById(input.caseId);
    if (!current) {
      return { code: "RESOURCE_NOT_AVAILABLE", status: "FAILED" };
    }
    if (!transitionGraph.get(current.case.status)?.includes(input.nextStatus)) {
      return { code: "INVALID_TRANSITION", status: "FAILED" };
    }
    const requiresResolution =
      input.nextStatus === "RESOLVED" ||
      (input.nextStatus === "CLOSED" && !current.case.resolutionCode);
    if (requiresResolution && !input.resolutionCode) {
      return { code: "BAD_REQUEST", status: "FAILED" };
    }
    const now = this.now();
    const nextResolutionCode =
      input.nextStatus === "CLOSED"
        ? (input.resolutionCode ?? current.case.resolutionCode)
        : (input.resolutionCode ?? null);
    const updated = await this.options.repository.transitionCase({
      caseId: input.caseId,
      event: makeSupportEvent({
        actorReference: authorization.operatorReference,
        actorType: "OPERATOR",
        caseId: input.caseId,
        eventType:
          input.nextStatus === "RESOLVED"
            ? "CASE_RESOLVED"
            : input.nextStatus === "CLOSED"
              ? "CASE_CLOSED"
              : "STATUS_CHANGED",
        fromStatus: current.case.status,
        now,
        toStatus: input.nextStatus,
      }),
      expectedVersion: input.expectedVersion,
      nextStatus: input.nextStatus,
      now,
      resolutionCode: nextResolutionCode,
    });
    if (updated.status !== "UPDATED") {
      return { code: updated.status, status: "FAILED" };
    }
    await this.audit({
      actor: { id: authorization.operatorReference, type: "ADMIN" },
      correlationId: input.correlationId,
      entity: { id: input.caseId, type: "SupportCase" },
      eventType:
        input.nextStatus === "RESOLVED"
          ? "SUPPORT_CASE_RESOLVED"
          : input.nextStatus === "CLOSED"
            ? "SUPPORT_CASE_CLOSED"
            : "SUPPORT_STATUS_CHANGED",
      metadata: {
        caseId: input.caseId,
        status: input.nextStatus,
      },
      outcome: "SUCCEEDED",
      reasonCode: input.nextStatus,
    });
    return { detail: updated.detail, status: "OK" };
  }

  public async linkReference(input: {
    readonly caseId: string;
    readonly linkType: SupportCaseLinkType;
    readonly targetId: string;
    readonly correlationId: CorrelationId;
  }): Promise<OperatorSupportCaseResult> {
    if (
      !isUuid(input.caseId) ||
      !isUuid(input.targetId) ||
      !isSupportCaseLinkType(input.linkType) ||
      !isSafeCorrelationId(input.correlationId) ||
      !isSafeDate(this.now())
    ) {
      return { code: "BAD_REQUEST", status: "FAILED" };
    }
    const authorization = await this.authority.authorize({
      action: "LINK_REFERENCE",
      caseId: input.caseId,
      correlationId: input.correlationId,
    });
    if (authorization.status !== "AUTHORIZED") {
      return { code: "UNTRUSTED_AUTHORITY", status: "FAILED" };
    }
    if (!isSafeActorReference(authorization.operatorReference)) {
      return { code: "UNTRUSTED_AUTHORITY", status: "FAILED" };
    }
    const detail = await this.options.repository.findCaseById(input.caseId);
    if (!detail?.case.orderId) {
      return { code: "RESOURCE_NOT_AVAILABLE", status: "FAILED" };
    }
    const reference = await findReference(
      this.options.repository,
      input.linkType,
      input.targetId,
    );
    if (!reference || reference.orderId !== detail.case.orderId) {
      return { code: "RESOURCE_NOT_AVAILABLE", status: "FAILED" };
    }
    const now = this.now();
    const linked = await this.options.repository.linkReference({
      caseId: input.caseId,
      event: makeSupportEvent({
        actorReference: authorization.operatorReference,
        actorType: "OPERATOR",
        caseId: input.caseId,
        eventType: linkEventType(input.linkType),
        linkTargetId: input.targetId,
        linkType: input.linkType,
        now,
      }),
      link: {
        caseId: input.caseId,
        createdAt: now,
        id: randomUUID(),
        linkType: input.linkType,
        orderId: reference.orderId,
        targetId: input.targetId,
      },
    });
    if (linked.status !== "LINKED") {
      return { code: linked.status, status: "FAILED" };
    }
    await this.audit({
      actor: { id: authorization.operatorReference, type: "ADMIN" },
      correlationId: input.correlationId,
      entity: { id: input.caseId, type: "SupportCase" },
      eventType: "SUPPORT_REFERENCE_LINKED",
      metadata: {
        caseId: input.caseId,
        linkType: input.linkType,
      },
      outcome: "SUCCEEDED",
      reasonCode: "REFERENCE_LINKED",
    });
    return { detail: linked.detail, status: "OK" };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async audit(
    event: Omit<AuditEvent, "uuid" | "timestampUtc" | "environment">,
  ): Promise<void> {
    if (!this.options.audit) {
      return;
    }
    try {
      await this.options.audit.append({
        ...event,
        environment: this.options.environment ?? "LOCAL",
        timestampUtc: this.now(),
        uuid: randomUUID(),
      });
    } catch {
      // Support state is durable even if best-effort audit is unavailable.
    }
  }
}

const requireAuthenticatedCustomer = (
  principal: AuthenticatedCustomerPrincipal | null,
): AuthenticatedCustomerPrincipal | null =>
  principal?.authenticationContext.assurance === "AUTHENTICATED"
    ? principal
    : null;

export const normalizeMessageBody = (body: string): string | null => {
  if (typeof body !== "string") {
    return null;
  }
  const normalized = body.trim();
  if (normalized.length === 0 || normalized.length > supportMessageMaxLength) {
    return null;
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\r]/u.test(normalized)) {
    return null;
  }
  return normalized;
};

const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );

const isSafeDate = (value: Date): boolean =>
  value instanceof Date && Number.isFinite(value.getTime());

const isSafeCorrelationId = (value: unknown): value is CorrelationId =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= supportCorrelationIdMaxLength &&
  value.trim() === value &&
  !/[\u0000-\u001F\u007F\r]/u.test(value);

const isSafeActorReference = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 128 &&
  value.trim() === value &&
  !/[\u0000-\u001F\u007F\r]/u.test(value) &&
  !/(product.?key|plaintext|api.?key|secret|token)/iu.test(value);

const isSafeExpectedVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isSupportCaseCategory = (value: unknown): value is SupportCaseCategory =>
  typeof value === "string" &&
  supportCaseCategories.has(value as SupportCaseCategory);

const isSupportCasePriority = (value: unknown): value is SupportCasePriority =>
  typeof value === "string" &&
  supportCasePriorities.has(value as SupportCasePriority);

const isSupportMessageVisibility = (
  value: unknown,
): value is SupportMessageVisibility =>
  typeof value === "string" &&
  supportMessageVisibilities.has(value as SupportMessageVisibility);

const isSupportCaseStatus = (value: unknown): value is SupportCaseStatus =>
  typeof value === "string" &&
  supportCaseStatuses.has(value as SupportCaseStatus);

const isSupportResolutionCode = (
  value: unknown,
): value is SupportCaseResolutionCode =>
  typeof value === "string" &&
  supportResolutionCodes.has(value as SupportCaseResolutionCode);

const isSupportCaseLinkType = (value: unknown): value is SupportCaseLinkType =>
  typeof value === "string" &&
  supportLinkTypes.has(value as SupportCaseLinkType);

const containsForbiddenCustomerField = (
  input: Record<string, unknown>,
): boolean =>
  [...forbiddenCustomerFields].some((field) =>
    Object.prototype.hasOwnProperty.call(input, field),
  );

const makeSupportCase = (input: {
  readonly customerId: CustomerId | null;
  readonly orderId: OrderId | null;
  readonly category: SupportCaseCategory;
  readonly status: SupportCaseStatus;
  readonly priority: SupportCasePriority;
  readonly source: SupportCaseSource;
  readonly correlationId: CorrelationId;
  readonly now: Date;
}): SupportCase => ({
  category: input.category,
  closedAt: null,
  correlationId: input.correlationId,
  createdAt: input.now,
  customerId: input.customerId,
  id: randomUUID(),
  orderId: input.orderId,
  priority: input.priority,
  recordVersion: 1,
  resolutionCode: null,
  resolvedAt: null,
  source: input.source,
  status: input.status,
  updatedAt: input.now,
});

export const makeSupportMessage = (input: {
  readonly caseId: string;
  readonly authorType: SupportMessageAuthorType;
  readonly visibility: SupportMessageVisibility;
  readonly body: string;
  readonly now: Date;
}): SupportMessage => ({
  authorType: input.authorType,
  body: input.body,
  caseId: input.caseId,
  createdAt: input.now,
  id: randomUUID(),
  visibility: input.visibility,
});

export const makeSupportEvent = (input: {
  readonly caseId: string;
  readonly eventType: SupportCaseEventType;
  readonly actorType: SupportMessageAuthorType;
  readonly actorReference: string;
  readonly now: Date;
  readonly fromStatus?: SupportCaseStatus | null;
  readonly toStatus?: SupportCaseStatus | null;
  readonly fromPriority?: SupportCasePriority | null;
  readonly toPriority?: SupportCasePriority | null;
  readonly linkType?: SupportCaseLinkType | null;
  readonly linkTargetId?: string | null;
}): SupportCaseEvent => ({
  actorReference: input.actorReference,
  actorType: input.actorType,
  caseId: input.caseId,
  eventType: input.eventType,
  fromPriority: input.fromPriority ?? null,
  fromStatus: input.fromStatus ?? null,
  id: randomUUID(),
  linkTargetId: input.linkTargetId ?? null,
  linkType: input.linkType ?? null,
  occurredAt: input.now,
  toPriority: input.toPriority ?? null,
  toStatus: input.toStatus ?? null,
});

export const toCustomerDetail = (
  detail: OperatorSupportCaseDetail,
): CustomerSupportCaseDetail => ({
  case: toCustomerCaseView(detail.case),
  messages: detail.messages
    .filter((message) => message.visibility === "CUSTOMER_VISIBLE")
    .map(toCustomerMessageView),
});

export const parsePageSize = (
  limit?: number,
):
  | { readonly status: "VALID"; readonly limit: number }
  | { readonly status: "INVALID" } => {
  if (limit === undefined) {
    return { limit: supportCaseDefaultPageSize, status: "VALID" };
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return { status: "INVALID" };
  }
  return { limit: Math.min(limit, supportCaseMaxPageSize), status: "VALID" };
};

export const boundedPageSize = (limit?: number): number => {
  const parsed = parsePageSize(limit);
  return parsed.status === "VALID" ? parsed.limit : supportCaseDefaultPageSize;
};

const isValidCursor = (cursor: string | null): boolean =>
  cursor === null ||
  (typeof cursor === "string" &&
    cursor.length > 0 &&
    cursor.length <= supportCursorMaxLength &&
    /^[A-Za-z0-9_-]+$/u.test(cursor));

const toCustomerCaseView = (
  supportCase: SupportCase,
): CustomerSupportCaseView => ({
  category: supportCase.category,
  closedAt: supportCase.closedAt,
  createdAt: supportCase.createdAt,
  customerId: supportCase.customerId,
  id: supportCase.id,
  orderId: supportCase.orderId,
  resolutionCode: supportCase.resolutionCode,
  resolvedAt: supportCase.resolvedAt,
  status: supportCase.status,
  updatedAt: supportCase.updatedAt,
});

const toCustomerMessageView = (
  message: SupportMessage,
): CustomerSupportMessageView => ({
  authorType: message.authorType,
  body: message.body,
  caseId: message.caseId,
  createdAt: message.createdAt,
  id: message.id,
});

const findReference = (
  repository: SupportCaseRepository,
  linkType: SupportCaseLinkType,
  targetId: string,
): Promise<SupportLinkedReference | null> => {
  if (linkType === "DISPUTE_EVIDENCE") {
    return repository.findDisputeEvidence(targetId);
  }
  if (linkType === "FRAUD_REVIEW") {
    return repository.findFraudReview(targetId);
  }
  if (linkType === "FRAUD_EVALUATION") {
    return repository.findFraudEvaluation(targetId);
  }
  return repository.findFulfillment(targetId);
};

const linkEventType = (linkType: SupportCaseLinkType): SupportCaseEventType => {
  if (linkType === "DISPUTE_EVIDENCE") {
    return "EVIDENCE_LINKED";
  }
  if (linkType === "FULFILLMENT") {
    return "FULFILLMENT_LINKED";
  }
  return linkType === "FRAUD_EVALUATION"
    ? "FRAUD_EVALUATION_LINKED"
    : "FRAUD_REVIEW_LINKED";
};
