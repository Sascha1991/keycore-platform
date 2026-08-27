import type {
  CustomerSupportCaseDetail,
  OperatorSupportCaseDetail,
  SupportCase,
  SupportCaseEvent,
  SupportCaseLink,
  SupportCaseListPage,
  SupportCaseRepository,
  SupportCustomerReference,
  SupportLinkedReference,
  SupportMessage,
  SupportOrderReference,
} from "../../packages/platform/src/support/support-cases.js";
import { toCustomerDetail } from "../../packages/platform/src/support/support-cases.js";
import type {
  CustomerId,
  OrderId,
} from "../../packages/platform/src/domain/identifiers.js";

export class InMemorySupportCaseRepository implements SupportCaseRepository {
  private readonly customers = new Map<CustomerId, SupportCustomerReference>();
  private readonly orders = new Map<OrderId, SupportOrderReference>();
  private readonly cases = new Map<string, SupportCase>();
  private readonly messages = new Map<string, SupportMessage[]>();
  private readonly links = new Map<string, SupportCaseLink[]>();
  private readonly events = new Map<string, SupportCaseEvent[]>();
  private readonly disputeEvidence = new Map<string, SupportLinkedReference>();
  private readonly fraudReviews = new Map<string, SupportLinkedReference>();
  private readonly fraudEvaluations = new Map<string, SupportLinkedReference>();
  private readonly fulfillments = new Map<string, SupportLinkedReference>();

  public addCustomer(customerId: CustomerId): void {
    this.customers.set(customerId, { customerId });
  }

  public addOrder(order: SupportOrderReference): void {
    this.orders.set(order.orderId, order);
  }

  public addDisputeEvidence(reference: SupportLinkedReference): void {
    this.disputeEvidence.set(reference.id, reference);
  }

  public addFraudReview(reference: SupportLinkedReference): void {
    this.fraudReviews.set(reference.id, reference);
  }

  public addFraudEvaluation(reference: SupportLinkedReference): void {
    this.fraudEvaluations.set(reference.id, reference);
  }

  public addFulfillment(reference: SupportLinkedReference): void {
    this.fulfillments.set(reference.id, reference);
  }

  public async findCustomerById(
    customerId: CustomerId,
  ): Promise<SupportCustomerReference | null> {
    return this.customers.get(customerId) ?? null;
  }

  public async findOrderForCustomer(input: {
    readonly orderId: OrderId;
    readonly customerId: CustomerId;
  }): Promise<SupportOrderReference | null> {
    const order = this.orders.get(input.orderId);
    return order?.customerId === input.customerId ? order : null;
  }

  public async findOrderById(
    orderId: OrderId,
  ): Promise<SupportOrderReference | null> {
    return this.orders.get(orderId) ?? null;
  }

  public async createCase(input: {
    readonly supportCase: SupportCase;
    readonly initialMessage: SupportMessage;
    readonly event: SupportCaseEvent;
  }): Promise<OperatorSupportCaseDetail> {
    this.cases.set(input.supportCase.id, input.supportCase);
    this.messages.set(input.supportCase.id, [input.initialMessage]);
    this.events.set(input.supportCase.id, [input.event]);
    this.links.set(input.supportCase.id, []);
    return requireDetail(this.detail(input.supportCase.id));
  }

  public async findCustomerCaseById(input: {
    readonly caseId: string;
    readonly customerId: CustomerId;
  }): Promise<CustomerSupportCaseDetail | null> {
    const detail = this.detail(input.caseId);
    if (!detail || detail.case.customerId !== input.customerId) {
      return null;
    }
    return toCustomerDetail(detail);
  }

  public async findCaseById(
    caseId: string,
  ): Promise<OperatorSupportCaseDetail | null> {
    return this.detail(caseId);
  }

  public async listCustomerCases(input: {
    readonly customerId: CustomerId;
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<SupportCaseListPage> {
    const startAfter = input.cursor ?? "";
    const items = [...this.cases.values()]
      .filter(
        (supportCase) =>
          supportCase.customerId === input.customerId &&
          (startAfter.length === 0 || supportCase.id > startAfter),
      )
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() ||
          right.id.localeCompare(left.id),
      );
    const page = items.slice(0, input.limit);
    return {
      items: page,
      nextCursor:
        items.length > page.length ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  public async addMessage(input: {
    readonly caseId: string;
    readonly customerId?: CustomerId;
    readonly message: SupportMessage;
    readonly event: SupportCaseEvent;
    readonly allowedStatuses: readonly SupportCase["status"][];
  }): Promise<
    | { readonly status: "ADDED"; readonly detail: OperatorSupportCaseDetail }
    | { readonly status: "RESOURCE_NOT_AVAILABLE" }
    | { readonly status: "CLOSED_TO_REPLIES" }
  > {
    const supportCase = this.cases.get(input.caseId);
    if (
      !supportCase ||
      (input.customerId && supportCase.customerId !== input.customerId)
    ) {
      return { status: "RESOURCE_NOT_AVAILABLE" };
    }
    if (!input.allowedStatuses.includes(supportCase.status)) {
      return { status: "CLOSED_TO_REPLIES" };
    }
    this.messages.set(input.caseId, [
      ...(this.messages.get(input.caseId) ?? []),
      input.message,
    ]);
    this.events.set(input.caseId, [
      ...(this.events.get(input.caseId) ?? []),
      input.event,
    ]);
    this.cases.set(input.caseId, {
      ...supportCase,
      recordVersion: supportCase.recordVersion + 1,
      updatedAt: input.message.createdAt,
    });
    return {
      detail: requireDetail(this.detail(input.caseId)),
      status: "ADDED",
    };
  }

  public async transitionCase(input: {
    readonly caseId: string;
    readonly expectedVersion: number;
    readonly nextStatus: SupportCase["status"];
    readonly resolutionCode: SupportCase["resolutionCode"];
    readonly now: Date;
    readonly event: SupportCaseEvent;
  }): Promise<
    | { readonly status: "UPDATED"; readonly detail: OperatorSupportCaseDetail }
    | { readonly status: "RESOURCE_NOT_AVAILABLE" }
    | { readonly status: "STALE_VERSION" }
  > {
    const supportCase = this.cases.get(input.caseId);
    if (!supportCase) {
      return { status: "RESOURCE_NOT_AVAILABLE" };
    }
    if (supportCase.recordVersion !== input.expectedVersion) {
      return { status: "STALE_VERSION" };
    }
    this.cases.set(input.caseId, {
      ...supportCase,
      closedAt:
        input.nextStatus === "CLOSED" ? input.now : supportCase.closedAt,
      recordVersion: supportCase.recordVersion + 1,
      resolutionCode: input.resolutionCode,
      resolvedAt:
        input.nextStatus === "RESOLVED" ? input.now : supportCase.resolvedAt,
      status: input.nextStatus,
      updatedAt: input.now,
    });
    this.events.set(input.caseId, [
      ...(this.events.get(input.caseId) ?? []),
      input.event,
    ]);
    return {
      detail: requireDetail(this.detail(input.caseId)),
      status: "UPDATED",
    };
  }

  public async updatePriority(): Promise<
    | { readonly status: "UPDATED"; readonly detail: OperatorSupportCaseDetail }
    | { readonly status: "RESOURCE_NOT_AVAILABLE" }
    | { readonly status: "STALE_VERSION" }
  > {
    return { status: "RESOURCE_NOT_AVAILABLE" };
  }

  public async findDisputeEvidence(
    id: string,
  ): Promise<SupportLinkedReference | null> {
    return this.disputeEvidence.get(id) ?? null;
  }

  public async findFraudReview(
    id: string,
  ): Promise<SupportLinkedReference | null> {
    return this.fraudReviews.get(id) ?? null;
  }

  public async findFraudEvaluation(
    id: string,
  ): Promise<SupportLinkedReference | null> {
    return this.fraudEvaluations.get(id) ?? null;
  }

  public async findFulfillment(
    id: string,
  ): Promise<SupportLinkedReference | null> {
    return this.fulfillments.get(id) ?? null;
  }

  public async linkReference(input: {
    readonly caseId: string;
    readonly link: SupportCaseLink;
    readonly event: SupportCaseEvent;
  }): Promise<
    | { readonly status: "LINKED"; readonly detail: OperatorSupportCaseDetail }
    | { readonly status: "RESOURCE_NOT_AVAILABLE" }
    | { readonly status: "CONFLICT" }
  > {
    const supportCase = this.cases.get(input.caseId);
    if (!supportCase) {
      return { status: "RESOURCE_NOT_AVAILABLE" };
    }
    const existing = this.links.get(input.caseId) ?? [];
    if (
      existing.some(
        (link) =>
          link.linkType === input.link.linkType &&
          link.targetId === input.link.targetId,
      )
    ) {
      return { status: "CONFLICT" };
    }
    this.links.set(input.caseId, [...existing, input.link]);
    this.events.set(input.caseId, [
      ...(this.events.get(input.caseId) ?? []),
      input.event,
    ]);
    return {
      detail: requireDetail(this.detail(input.caseId)),
      status: "LINKED",
    };
  }

  public snapshot(caseId: string): OperatorSupportCaseDetail | null {
    return this.detail(caseId);
  }

  private detail(caseId: string): OperatorSupportCaseDetail | null {
    const supportCase = this.cases.get(caseId);
    if (!supportCase) {
      return null;
    }
    return {
      case: supportCase,
      events: [...(this.events.get(caseId) ?? [])],
      links: [...(this.links.get(caseId) ?? [])],
      messages: [...(this.messages.get(caseId) ?? [])].sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id),
      ),
    };
  }
}

const requireDetail = (
  detail: OperatorSupportCaseDetail | null,
): OperatorSupportCaseDetail => {
  if (!detail) {
    throw new Error(
      "Support case detail disappeared from in-memory repository",
    );
  }
  return detail;
};
