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
  readonly createdAt: Date;
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
    input: AdminRepositoryListInput,
  ): Promise<AdminOperationsPage<AdminCustomerSummary>>;
  listProducts(
    input: AdminRepositoryListInput,
  ): Promise<AdminOperationsPage<AdminProductSummary>>;
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

  public listCustomers(
    principal: AdminPrincipal,
    query: AdminListQuery,
    correlationId: CorrelationId,
  ) {
    return this.list("customers", principal, query, correlationId, (input) =>
      this.repository.listCustomers(input),
    );
  }

  public listProducts(
    principal: AdminPrincipal,
    query: AdminListQuery,
    correlationId: CorrelationId,
  ) {
    return this.list("products", principal, query, correlationId, (input) =>
      this.repository.listProducts(input),
    );
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
