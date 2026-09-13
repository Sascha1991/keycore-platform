import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { validateAuditEvent, type AuditEvent } from "../domain/audit.js";
import type { CorrelationId } from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import type {
  ChangeOperationsControlResult,
  OperationsCapability,
  OperationsControlReasonCode,
  OperationsControlState,
} from "../operations/operations-controls.js";
import type {
  OperatorSupportCaseDetail,
  OperatorSupportCaseResult,
  SupportCasePriority,
  SupportCaseResolutionCode,
  SupportCaseStatus,
  SupportMessageVisibility,
} from "../support/support-cases.js";
import {
  availabilityStates,
  platforms,
  productTypes,
} from "../domain/catalog.js";
import {
  AdminAccessError,
  hasAdminCapability,
  type AdminCapability,
  type AdminPrincipal,
} from "./admin-orders.js";

export interface AdminListQuery {
  readonly search?: string;
  readonly status?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AdminCustomerQuery extends AdminListQuery {
  readonly orderPresence?: string;
  readonly registrationWindow?: string;
  readonly registeredFrom?: string;
  readonly registeredTo?: string;
  readonly sort?: string;
}

export interface AdminReadCursor {
  readonly sortValue: string;
  readonly id: string;
}

export interface AdminCustomerSummary {
  readonly customerId: string;
  readonly email: string;
  readonly verificationState: "UNVERIFIED" | "VERIFIED";
  readonly orderCount: number;
  readonly lastOrderAt: Date | null;
  readonly lastOrderReference: string | null;
  readonly lastOrderStatus: string | null;
  readonly createdAt: Date;
}

export interface AdminCustomerMetrics {
  readonly capturedPaymentVolumes: readonly {
    readonly amountMinor: string;
    readonly currency: string;
  }[];
  readonly customersWithOrders: number;
  readonly newCustomersLast30Days: number;
  readonly totalCustomers: number;
  readonly verifiedCustomers: number;
}

export interface AdminCustomerPage extends AdminOperationsPage<AdminCustomerSummary> {
  readonly metrics: AdminCustomerMetrics;
  readonly totalCount: number;
}

export interface AdminCustomerListResult extends AdminCustomerPage {
  readonly nextCursorValue?: string;
  readonly limit: number;
  readonly sort: AdminCustomerSort;
}

export type AdminCustomerSort =
  "NEWEST" | "OLDEST" | "EMAIL_ASC" | "EMAIL_DESC";

export interface AdminCustomerRepositoryListInput {
  readonly search?: string;
  readonly status?: string;
  readonly orderPresence?:
    "WITH_ORDERS" | "WITHOUT_ORDERS" | "WITH_CAPTURED_PAYMENT";
  readonly registrationWindow?: "LAST_30_DAYS";
  readonly registeredFrom?: Date;
  readonly registeredTo?: Date;
  readonly sort: AdminCustomerSort;
  readonly limit: number;
  readonly after?: AdminReadCursor;
}

export interface AdminProductSummary {
  readonly productId: string;
  readonly title: string;
  readonly productType: string;
  readonly platform: string;
  readonly lifecycle: string;
  readonly active: boolean;
  readonly offerCount: number;
  readonly availableOfferCount: number;
  readonly supplierCount: number;
  readonly publicationState: "PUBLISHED" | "UNPUBLISHED";
  readonly updatedAt: Date;
}

export type AdminProductSort =
  "TITLE_ASC" | "TITLE_DESC" | "UPDATED_DESC" | "UPDATED_ASC";

export type AdminProductQuickView = "ACTIVE" | "WITH_OFFERS" | "AVAILABLE";

export interface AdminProductQuery extends AdminListQuery {
  readonly platform?: string;
  readonly productType?: string;
  readonly offerState?: string;
  readonly availability?: string;
  readonly publication?: string;
  readonly sort?: string;
  readonly quickView?: string;
}

export interface AdminProductMetrics {
  readonly totalProducts: number;
  readonly activeProducts: number;
  readonly productsWithOffers: number;
  readonly availableProducts: number;
}

export interface AdminProductPage extends AdminOperationsPage<AdminProductSummary> {
  readonly metrics: AdminProductMetrics;
  readonly totalCount: number;
}

export interface AdminProductListResult extends AdminProductPage {
  readonly nextCursorValue?: string;
  readonly limit: number;
  readonly sort: AdminProductSort;
}

export interface AdminProductRepositoryListInput {
  readonly search?: string;
  readonly lifecycle?: string;
  readonly platform?: string;
  readonly productType?: string;
  readonly offerState?: "WITH_OFFERS" | "WITHOUT_OFFERS";
  readonly availability?: "AVAILABLE" | "UNAVAILABLE";
  readonly publication?: "PUBLISHED" | "UNPUBLISHED";
  readonly quickView?: AdminProductQuickView;
  readonly sort: AdminProductSort;
  readonly limit: number;
  readonly after?: AdminReadCursor;
}

export interface AdminProductIdentifierSummary {
  readonly type: string;
  readonly value: string;
  readonly verified: boolean;
}

export interface AdminProductOfferSummary {
  readonly offerId: string;
  readonly supplierName: string;
  readonly supplierOfferReference: string;
  readonly availability: string;
  readonly active: boolean;
  readonly updatedAt: Date;
}

export interface AdminProductDetail extends AdminProductSummary {
  readonly createdAt: Date;
  readonly identifiers: readonly AdminProductIdentifierSummary[];
  readonly offers: readonly AdminProductOfferSummary[];
  readonly publicationStorefronts: readonly string[];
}

export interface AdminSupplierSummary {
  readonly supplierId: string;
  readonly supplierCode: string;
  readonly displayName: string;
  readonly productCount: number;
  readonly activeOfferCount: number;
  readonly lastSyncStatus: string | null;
  readonly lastSyncAt: Date | null;
}

export interface AdminSupportCaseSummary {
  readonly caseId: string;
  readonly customerEmail: string | null;
  readonly orderId: string | null;
  readonly category: string;
  readonly status: string;
  readonly priority: string;
  readonly updatedAt: Date;
}

export interface AdminFraudReviewSummary {
  readonly reviewId: string;
  readonly orderId: string;
  readonly status: string;
  readonly reasonCodes: readonly string[];
  readonly openedAt: Date;
  readonly resolvedAt: Date | null;
}

export interface AdminOperationsControlSummary {
  readonly capability: string;
  readonly state: "ENABLED" | "PAUSED";
  readonly reasonCode: string | null;
  readonly recordVersion: number;
  readonly updatedAt: Date;
}

export const adminCapturedPaymentVolumeStates = [
  "CAPTURED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
] as const;

export interface AdminFinanceCurrencySummary {
  readonly currency: string;
  readonly capturedAmountMinor: string;
  readonly refundedAmountMinor: string;
  readonly capturedOrders: number;
  readonly refundedOrders: number;
  readonly partiallyRefundedOrders: number;
}

export interface AdminNotificationItem {
  readonly id: string;
  readonly category: "FRAUD" | "OPERATIONS" | "SUPPORT";
  readonly title: string;
  readonly detail: string;
  readonly occurredAt: Date;
  readonly href: string;
  readonly tone: "INFO" | "WARNING" | "CRITICAL";
}

export interface AdminOperationsPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: AdminReadCursor;
}

export interface AdminOperationsListResult<T> extends AdminOperationsPage<T> {
  readonly nextCursorValue?: string;
}

export interface AdminOperationsRepository {
  listCustomers(
    input: AdminCustomerRepositoryListInput,
  ): Promise<AdminCustomerPage>;
  findCustomer(customerId: string): Promise<AdminCustomerSummary | null>;
  listProducts(
    input: AdminProductRepositoryListInput,
  ): Promise<AdminProductPage>;
  findProduct(productId: string): Promise<AdminProductDetail | null>;
  listSuppliers(
    input: AdminRepositoryListInput,
  ): Promise<AdminOperationsPage<AdminSupplierSummary>>;
  listSupportCases(
    input: AdminRepositoryListInput,
  ): Promise<AdminOperationsPage<AdminSupportCaseSummary>>;
  listFraudReviews(
    input: AdminRepositoryListInput,
  ): Promise<AdminOperationsPage<AdminFraudReviewSummary>>;
  listOperationsControls(): Promise<readonly AdminOperationsControlSummary[]>;
  financeSummary(): Promise<readonly AdminFinanceCurrencySummary[]>;
}

export interface AdminOperationsControlMutationPort {
  change(input: {
    readonly principal: AdminPrincipal;
    readonly capability: OperationsCapability;
    readonly desiredState: OperationsControlState;
    readonly reasonCode: OperationsControlReasonCode | null;
    readonly expectedVersion: number;
    readonly operationId: string;
    readonly correlationId: CorrelationId;
  }): Promise<ChangeOperationsControlResult>;
}

export interface AdminSupportOperationsPort {
  detail(input: {
    readonly principal: AdminPrincipal;
    readonly caseId: string;
  }): Promise<OperatorSupportCaseDetail | null>;
  addNote(input: {
    readonly principal: AdminPrincipal;
    readonly caseId: string;
    readonly message: string;
    readonly visibility: SupportMessageVisibility;
    readonly correlationId: CorrelationId;
  }): Promise<OperatorSupportCaseResult>;
  changePriority(input: {
    readonly principal: AdminPrincipal;
    readonly caseId: string;
    readonly expectedVersion: number;
    readonly priority: SupportCasePriority;
    readonly correlationId: CorrelationId;
  }): Promise<OperatorSupportCaseResult>;
  transition(input: {
    readonly principal: AdminPrincipal;
    readonly caseId: string;
    readonly expectedVersion: number;
    readonly nextStatus: SupportCaseStatus;
    readonly resolutionCode: SupportCaseResolutionCode | null;
    readonly correlationId: CorrelationId;
  }): Promise<OperatorSupportCaseResult>;
}

export interface AdminRepositoryListInput {
  readonly search?: string;
  readonly status?: string;
  readonly limit: number;
  readonly after?: AdminReadCursor;
}

type ListSection = "customers" | "products" | "suppliers" | "support" | "fraud";

const sectionCapability: Readonly<Record<ListSection, AdminCapability>> = {
  customers: "CUSTOMER_VIEW",
  fraud: "FRAUD_REVIEW_VIEW",
  products: "CATALOG_VIEW",
  suppliers: "SUPPLIER_VIEW",
  support: "SUPPORT_VIEW",
};

export class AdminOperationsService {
  public constructor(
    private readonly repository: AdminOperationsRepository,
    private readonly audit: AuditEventPort,
    private readonly cursorSecret: string,
    private readonly environment: AuditEvent["environment"],
    private readonly now: () => Date = () => new Date(),
    private readonly controlMutation?: AdminOperationsControlMutationPort,
    private readonly supportOperations?: AdminSupportOperationsPort,
  ) {
    if (Buffer.byteLength(cursorSecret, "utf8") < 32)
      throw new Error(
        "Admin operations cursor secret must be at least 32 bytes",
      );
  }

  public async listCustomers(
    principal: AdminPrincipal,
    query: AdminCustomerQuery,
    correlationId: CorrelationId,
  ): Promise<AdminCustomerListResult> {
    this.require(principal, "CUSTOMER_VIEW");
    const search = parseSearch(query.search);
    const status = parseCustomerStatus(query.status);
    const orderPresence = parseOrderPresence(query.orderPresence);
    const registrationWindow = parseRegistrationWindow(
      query.registrationWindow,
    );
    const registeredFrom = parseCustomerDate(query.registeredFrom, false);
    const registeredTo = parseCustomerDate(query.registeredTo, true);
    if (
      registeredFrom &&
      registeredTo &&
      registeredFrom.getTime() > registeredTo.getTime()
    )
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    const sort = parseCustomerSort(query.sort);
    const limit = parseLimit(query.limit);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          orderPresence,
          registrationWindow,
          registeredFrom: registeredFrom?.toISOString(),
          registeredTo: registeredTo?.toISOString(),
          search,
          section: "customers",
          sort,
          status,
        }),
        "utf8",
      )
      .digest("hex");
    const after = query.cursor
      ? decodeCursor(query.cursor, fingerprint, this.cursorSecret)
      : undefined;
    const page = await this.repository.listCustomers({
      ...(after ? { after } : {}),
      ...(orderPresence ? { orderPresence } : {}),
      ...(registrationWindow ? { registrationWindow } : {}),
      ...(registeredFrom ? { registeredFrom } : {}),
      ...(registeredTo ? { registeredTo } : {}),
      ...(search ? { search } : {}),
      ...(status ? { status } : {}),
      limit,
      sort,
    });
    await this.auditRead(
      principal,
      correlationId,
      "ADMIN_CUSTOMERS_VIEWED",
      page.items.length,
    );
    return {
      ...page,
      limit,
      sort,
      ...(page.nextCursor
        ? {
            nextCursorValue: encodeCursor(
              page.nextCursor,
              fingerprint,
              this.cursorSecret,
            ),
          }
        : {}),
    };
  }

  public async customerDetail(
    principal: AdminPrincipal,
    customerId: string,
    correlationId: CorrelationId,
  ): Promise<AdminCustomerSummary | null> {
    this.require(principal, "CUSTOMER_VIEW");
    if (!isUuid(customerId))
      throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    const customer = await this.repository.findCustomer(customerId);
    await this.auditRead(
      principal,
      correlationId,
      "ADMIN_CUSTOMER_DETAIL_VIEWED",
      customer ? 1 : 0,
    );
    return customer;
  }

  public async listProducts(
    principal: AdminPrincipal,
    query: AdminProductQuery,
    correlationId: CorrelationId,
  ): Promise<AdminProductListResult> {
    this.require(principal, "CATALOG_VIEW");
    const search = parseSearch(query.search);
    const lifecycle = parseProductLifecycle(query.status);
    const platform = parseAllowed(query.platform, [
      ...platforms,
      "PC",
    ] as const);
    const productType = parseAllowed(query.productType, productTypes);
    const offerState = parseAllowed(query.offerState, [
      "WITH_OFFERS",
      "WITHOUT_OFFERS",
    ] as const);
    const availability = parseAllowed(query.availability, [
      "AVAILABLE",
      "UNAVAILABLE",
    ] as const);
    const publication = parseAllowed(query.publication, [
      "PUBLISHED",
      "UNPUBLISHED",
    ] as const);
    const quickView = parseAllowed(query.quickView, [
      "ACTIVE",
      "WITH_OFFERS",
      "AVAILABLE",
    ] as const);
    const sort = parseProductSort(query.sort);
    const limit = parseProductLimit(query.limit);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          availability,
          lifecycle,
          offerState,
          platform,
          productType,
          publication,
          quickView,
          search,
          section: "products",
          sort,
        }),
        "utf8",
      )
      .digest("hex");
    const after = query.cursor
      ? decodeCursor(query.cursor, fingerprint, this.cursorSecret)
      : undefined;
    const page = await this.repository.listProducts({
      ...(after ? { after } : {}),
      ...(availability ? { availability } : {}),
      ...(lifecycle ? { lifecycle } : {}),
      ...(offerState ? { offerState } : {}),
      ...(platform ? { platform } : {}),
      ...(productType ? { productType } : {}),
      ...(publication ? { publication } : {}),
      ...(quickView ? { quickView } : {}),
      ...(search ? { search } : {}),
      limit,
      sort,
    });
    await this.auditRead(
      principal,
      correlationId,
      "ADMIN_PRODUCTS_VIEWED",
      page.items.length,
    );
    return {
      ...page,
      limit,
      sort,
      ...(page.nextCursor
        ? {
            nextCursorValue: encodeCursor(
              page.nextCursor,
              fingerprint,
              this.cursorSecret,
            ),
          }
        : {}),
    };
  }

  public async productDetail(
    principal: AdminPrincipal,
    productId: string,
    correlationId: CorrelationId,
  ): Promise<AdminProductDetail | null> {
    this.require(principal, "CATALOG_VIEW");
    if (!isUuid(productId))
      throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    const product = await this.repository.findProduct(productId);
    await this.auditRead(
      principal,
      correlationId,
      "ADMIN_PRODUCT_DETAIL_VIEWED",
      product ? 1 : 0,
    );
    return product;
  }

  public listSuppliers(
    principal: AdminPrincipal,
    query: AdminListQuery,
    correlationId: CorrelationId,
  ) {
    return this.list("suppliers", principal, query, correlationId, (input) =>
      this.repository.listSuppliers(input),
    );
  }

  public listSupportCases(
    principal: AdminPrincipal,
    query: AdminListQuery,
    correlationId: CorrelationId,
  ) {
    return this.list("support", principal, query, correlationId, (input) =>
      this.repository.listSupportCases(input),
    );
  }

  public listFraudReviews(
    principal: AdminPrincipal,
    query: AdminListQuery,
    correlationId: CorrelationId,
  ) {
    return this.list("fraud", principal, query, correlationId, (input) =>
      this.repository.listFraudReviews(input),
    );
  }

  public async controls(
    principal: AdminPrincipal,
    correlationId: CorrelationId,
  ) {
    this.require(principal, "OPERATIONS_CONTROL_VIEW");
    const result = await this.repository.listOperationsControls();
    await this.auditRead(
      principal,
      correlationId,
      "ADMIN_OPERATIONS_CONTROLS_VIEWED",
      result.length,
    );
    return result;
  }

  public async changeControl(
    principal: AdminPrincipal,
    input: {
      readonly capability: OperationsCapability;
      readonly desiredState: OperationsControlState;
      readonly reasonCode: OperationsControlReasonCode | null;
      readonly expectedVersion: number;
      readonly operationId: string;
    },
    correlationId: CorrelationId,
  ): Promise<ChangeOperationsControlResult> {
    this.require(principal, "OPERATIONS_CONTROL_MANAGE");
    if (!this.controlMutation)
      throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    return this.controlMutation.change({
      ...input,
      correlationId,
      principal,
    });
  }

  public async supportDetail(principal: AdminPrincipal, caseId: string) {
    this.require(principal, "SUPPORT_VIEW");
    if (!this.supportOperations)
      throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    const detail = await this.supportOperations.detail({ caseId, principal });
    if (!detail) throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    return detail;
  }

  public async addSupportNote(
    principal: AdminPrincipal,
    input: Omit<
      Parameters<AdminSupportOperationsPort["addNote"]>[0],
      "principal"
    >,
  ) {
    this.require(principal, "SUPPORT_MANAGE");
    if (!this.supportOperations)
      throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    return this.supportOperations.addNote({ ...input, principal });
  }

  public async changeSupportPriority(
    principal: AdminPrincipal,
    input: Omit<
      Parameters<AdminSupportOperationsPort["changePriority"]>[0],
      "principal"
    >,
  ) {
    this.require(principal, "SUPPORT_MANAGE");
    if (!this.supportOperations)
      throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    return this.supportOperations.changePriority({ ...input, principal });
  }

  public async transitionSupportCase(
    principal: AdminPrincipal,
    input: Omit<
      Parameters<AdminSupportOperationsPort["transition"]>[0],
      "principal"
    >,
  ) {
    this.require(principal, "SUPPORT_MANAGE");
    if (!this.supportOperations)
      throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    return this.supportOperations.transition({ ...input, principal });
  }

  public async finance(
    principal: AdminPrincipal,
    correlationId: CorrelationId,
  ) {
    this.require(principal, "FINANCE_VIEW");
    const result = await this.repository.financeSummary();
    await this.auditRead(
      principal,
      correlationId,
      "ADMIN_FINANCE_VIEWED",
      result.length,
    );
    return result;
  }

  public async reports(
    principal: AdminPrincipal,
    correlationId: CorrelationId,
  ) {
    this.require(principal, "REPORT_VIEW");
    const result = await this.repository.financeSummary();
    await this.auditRead(
      principal,
      correlationId,
      "ADMIN_REPORTS_VIEWED",
      result.length,
    );
    return result;
  }

  public async notifications(
    principal: AdminPrincipal,
    correlationId: CorrelationId,
  ): Promise<readonly AdminNotificationItem[]> {
    this.require(principal, "ADMIN_ACCESS");
    const items: AdminNotificationItem[] = [];
    if (hasAdminCapability(principal, "SUPPORT_VIEW")) {
      const support = await this.repository.listSupportCases({
        limit: 10,
        status: "OPEN",
      });
      items.push(
        ...support.items.map((item) => ({
          category: "SUPPORT" as const,
          detail: `${item.category} · ${item.priority}`,
          href: `/admin/support/${item.caseId}`,
          id: `support:${item.caseId}`,
          occurredAt: item.updatedAt,
          title: "Offener Supportfall",
          tone:
            item.priority === "URGENT"
              ? ("CRITICAL" as const)
              : ("INFO" as const),
        })),
      );
    }
    if (hasAdminCapability(principal, "FRAUD_REVIEW_VIEW")) {
      const fraud = await this.repository.listFraudReviews({
        limit: 10,
        status: "OPEN",
      });
      items.push(
        ...fraud.items.map((item) => ({
          category: "FRAUD" as const,
          detail: `Bestellung ${item.orderId}`,
          href: "/admin/fraud",
          id: `fraud:${item.reviewId}`,
          occurredAt: item.openedAt,
          title: "Manuelle Betrugsprüfung erforderlich",
          tone: "WARNING" as const,
        })),
      );
    }
    if (hasAdminCapability(principal, "OPERATIONS_CONTROL_VIEW")) {
      const controls = await this.repository.listOperationsControls();
      items.push(
        ...controls
          .filter((item) => item.state === "PAUSED")
          .map((item) => ({
            category: "OPERATIONS" as const,
            detail: `${item.capability} · ${item.reasonCode ?? "PAUSED"}`,
            href: "/admin/settings",
            id: `operations:${item.capability}`,
            occurredAt: item.updatedAt,
            title: "Betriebsfunktion pausiert",
            tone: "CRITICAL" as const,
          })),
      );
    }
    const result = items
      .sort(
        (left, right) => right.occurredAt.getTime() - left.occurredAt.getTime(),
      )
      .slice(0, 25);
    await this.auditRead(
      principal,
      correlationId,
      "ADMIN_NOTIFICATIONS_VIEWED",
      result.length,
    );
    return result;
  }

  private async list<T>(
    section: ListSection,
    principal: AdminPrincipal,
    query: AdminListQuery,
    correlationId: CorrelationId,
    read: (input: AdminRepositoryListInput) => Promise<AdminOperationsPage<T>>,
  ): Promise<AdminOperationsListResult<T>> {
    this.require(principal, sectionCapability[section]);
    const search = parseSearch(query.search);
    const status = parseStatus(query.status);
    const limit = parseLimit(query.limit);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ search, section, status }), "utf8")
      .digest("hex");
    const after = query.cursor
      ? decodeCursor(query.cursor, fingerprint, this.cursorSecret)
      : undefined;
    const input: AdminRepositoryListInput = {
      ...(after ? { after } : {}),
      ...(search ? { search } : {}),
      ...(status ? { status } : {}),
      limit,
    };
    const page = await read(input);
    await this.auditRead(
      principal,
      correlationId,
      `ADMIN_${section.toUpperCase()}_VIEWED`,
      page.items.length,
    );
    return {
      ...page,
      ...(page.nextCursor
        ? {
            nextCursorValue: encodeCursor(
              page.nextCursor,
              fingerprint,
              this.cursorSecret,
            ),
          }
        : {}),
    };
  }

  private require(
    principal: AdminPrincipal,
    capability: AdminCapability,
  ): void {
    if (
      !hasAdminCapability(principal, "ADMIN_ACCESS") ||
      !hasAdminCapability(principal, capability)
    )
      throw new AdminAccessError("ADMIN_ACCESS_DENIED");
  }

  private async auditRead(
    principal: AdminPrincipal,
    correlationId: CorrelationId,
    action: string,
    resultCount: number,
  ): Promise<void> {
    await this.audit.append(
      validateAuditEvent({
        actor: { id: principal.adminId, type: "ADMIN" },
        correlationId,
        entity: { id: "admin-operations", type: "ADMIN_PORTAL" },
        environment: this.environment,
        eventType: "ADMIN_ACTION",
        metadata: { action, resultCount },
        outcome: "SUCCEEDED",
        reasonCode: action,
        timestampUtc: this.now(),
        uuid: randomUUID(),
      }),
    );
  }
}

const parseSearch = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > 254 || /[\u0000-\u001f\u007f]/u.test(normalized))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return normalized;
};

const parseStatus = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(normalized))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return normalized;
};

const parseAllowed = <T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | undefined => {
  if (!value) return undefined;
  if (!allowed.includes(value as T))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return value as T;
};

const parseProductLifecycle = (value: string | undefined) =>
  parseAllowed(value, productLifecycleValues);

const productLifecycleValues = [
  ...availabilityStates,
  "ACTIVE",
  "INACTIVE",
  "ACTIVE_CANDIDATE",
  "REVIEW_REQUIRED",
  "REJECTED",
] as const;

const parseProductSort = (value: string | undefined): AdminProductSort => {
  if (!value) return "TITLE_ASC";
  if (
    !["TITLE_ASC", "TITLE_DESC", "UPDATED_DESC", "UPDATED_ASC"].includes(value)
  )
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return value as AdminProductSort;
};

const parseProductLimit = (value: number | undefined): number => {
  if (value === undefined) return 10;
  if (![10, 25, 50].includes(value))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return value;
};

const parseCustomerStatus = (
  value: string | undefined,
): "VERIFIED" | "UNVERIFIED" | undefined => {
  const status = parseStatus(value);
  if (!status) return undefined;
  if (status !== "VERIFIED" && status !== "UNVERIFIED")
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return status;
};

const parseOrderPresence = (
  value: string | undefined,
): "WITH_ORDERS" | "WITHOUT_ORDERS" | "WITH_CAPTURED_PAYMENT" | undefined => {
  if (!value) return undefined;
  if (
    value !== "WITH_ORDERS" &&
    value !== "WITHOUT_ORDERS" &&
    value !== "WITH_CAPTURED_PAYMENT"
  )
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return value;
};

const parseRegistrationWindow = (
  value: string | undefined,
): "LAST_30_DAYS" | undefined => {
  if (!value) return undefined;
  if (value !== "LAST_30_DAYS")
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return value;
};

const parseCustomerSort = (value: string | undefined): AdminCustomerSort => {
  if (!value) return "NEWEST";
  if (!["NEWEST", "OLDEST", "EMAIL_ASC", "EMAIL_DESC"].includes(value))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return value as AdminCustomerSort;
};

const parseCustomerDate = (
  value: string | undefined,
  endOfDay: boolean,
): Date | undefined => {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  const date = new Date(
    `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`,
  );
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return date;
};

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );

const parseLimit = (value: number | undefined): number => {
  if (value === undefined) return 25;
  if (!Number.isInteger(value) || value < 1 || value > 100)
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return value;
};

const encodeCursor = (
  cursor: AdminReadCursor,
  fingerprint: string,
  secret: string,
): string => {
  const payload = Buffer.from(
    JSON.stringify({ ...cursor, fingerprint }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("base64url");
  return `${payload}.${signature}`;
};

const decodeCursor = (
  value: string,
  fingerprint: string,
  secret: string,
): AdminReadCursor => {
  if (value.length > 1024) throw new AdminAccessError("ADMIN_INPUT_INVALID");
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra)
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  const expected = createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  )
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      decoded.fingerprint !== fingerprint ||
      typeof decoded.sortValue !== "string" ||
      typeof decoded.id !== "string"
    )
      throw new Error("invalid");
    return { id: decoded.id, sortValue: decoded.sortValue };
  } catch {
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  }
};
