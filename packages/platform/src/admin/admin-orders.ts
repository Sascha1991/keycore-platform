import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type {
  AuditEvent,
  AuditEventPort,
  CorrelationId,
  OrderId,
} from "../contracts.js";
import { correlationId, orderId, validateAuditEvent } from "../contracts.js";

export const adminRoles = [
  "PROJECT_OWNER",
  "OPERATIONS",
  "SUPPORT",
  "FINANCE",
  "SECURITY_AUDITOR",
] as const;
export type AdminRole = (typeof adminRoles)[number];

export const adminCapabilities = [
  "ADMIN_ACCESS",
  "ORDER_VIEW",
  "SENSITIVE_OPERATION",
  "PRODUCT_KEY_REVEAL",
  "AUDIT_VIEW",
  "STAFF_VIEW",
  "STAFF_MANAGE",
  "ROLE_ASSIGN",
  "PERMISSION_OVERRIDE_MANAGE",
  "CUSTOMER_VIEW",
  "CATALOG_VIEW",
  "SUPPLIER_VIEW",
  "SUPPORT_VIEW",
  "SUPPORT_MANAGE",
  "FINANCE_VIEW",
  "REPORT_VIEW",
  "FRAUD_REVIEW_VIEW",
  "FRAUD_REVIEW_MANAGE",
  "REFUND_MANAGE",
  "OPERATIONS_CONTROL_VIEW",
  "OPERATIONS_CONTROL_MANAGE",
] as const;
export type AdminCapability = (typeof adminCapabilities)[number];

const roleCapabilities: Readonly<
  Record<AdminRole, readonly AdminCapability[]>
> = {
  FINANCE: ["ADMIN_ACCESS", "ORDER_VIEW", "FINANCE_VIEW", "REPORT_VIEW"],
  OPERATIONS: [
    "ADMIN_ACCESS",
    "ORDER_VIEW",
    "SENSITIVE_OPERATION",
    "CUSTOMER_VIEW",
    "CATALOG_VIEW",
    "SUPPLIER_VIEW",
    "SUPPORT_VIEW",
    "SUPPORT_MANAGE",
    "FRAUD_REVIEW_VIEW",
    "FRAUD_REVIEW_MANAGE",
    "OPERATIONS_CONTROL_VIEW",
    "OPERATIONS_CONTROL_MANAGE",
  ],
  PROJECT_OWNER: adminCapabilities,
  SECURITY_AUDITOR: [
    "ADMIN_ACCESS",
    "AUDIT_VIEW",
    "FRAUD_REVIEW_VIEW",
    "OPERATIONS_CONTROL_VIEW",
  ],
  SUPPORT: [
    "ADMIN_ACCESS",
    "ORDER_VIEW",
    "CUSTOMER_VIEW",
    "SUPPORT_VIEW",
    "SUPPORT_MANAGE",
  ],
};

export interface AdminPrincipal {
  readonly adminId: string;
  readonly displayName: string;
  readonly roles: readonly AdminRole[];
  readonly assurance: "MFA" | "STAGING_SYNTHETIC";
  readonly expiresAt: Date;
  readonly individualCapabilities?: readonly AdminCapability[];
}

export interface StoredAdminSession {
  readonly adminId: string;
  readonly displayName: string;
  readonly roles: readonly AdminRole[];
  readonly assurance: AdminPrincipal["assurance"];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly identityStatus: "ACTIVE" | "DISABLED";
  readonly individualCapabilities?: readonly AdminCapability[];
}

export interface AdminSessionRepository {
  findByHash(sessionHash: string): Promise<StoredAdminSession | null>;
  touch(sessionHash: string, at: Date): Promise<void>;
  revoke(sessionHash: string, at: Date): Promise<void>;
}

export interface AdminAuthenticationResult {
  readonly authenticated: boolean;
  readonly principal?: AdminPrincipal;
  readonly reasonCode: string;
}

export class AdminAuthenticationService {
  public constructor(
    private readonly sessions: AdminSessionRepository,
    private readonly audit: AuditEventPort,
    private readonly hashSecret: string,
    private readonly environment: AuditEvent["environment"],
    private readonly now: () => Date = () => new Date(),
  ) {
    requireStrongSecret(hashSecret, "Admin session hash secret");
  }

  public async authenticate(
    rawSession: string,
    requestCorrelationId: CorrelationId,
  ): Promise<AdminAuthenticationResult> {
    const at = this.now();
    if (!isOpaqueSessionValue(rawSession)) {
      await this.auditAuthentication(
        "anonymous",
        requestCorrelationId,
        "DENIED",
        "ADMIN_SESSION_INVALID",
        at,
      );
      return { authenticated: false, reasonCode: "ADMIN_SESSION_INVALID" };
    }

    const sessionHash = hashAdminSession(rawSession, this.hashSecret);
    const stored = await this.sessions.findByHash(sessionHash);
    if (
      !stored ||
      stored.identityStatus !== "ACTIVE" ||
      stored.revokedAt !== null ||
      stored.expiresAt.getTime() <= at.getTime()
    ) {
      await this.auditAuthentication(
        stored?.adminId ?? "anonymous",
        requestCorrelationId,
        "DENIED",
        "ADMIN_SESSION_UNAVAILABLE",
        at,
      );
      return { authenticated: false, reasonCode: "ADMIN_SESSION_UNAVAILABLE" };
    }

    const principal: AdminPrincipal = {
      adminId: stored.adminId,
      assurance: stored.assurance,
      displayName: stored.displayName,
      expiresAt: stored.expiresAt,
      roles: [...stored.roles],
      individualCapabilities: [...(stored.individualCapabilities ?? [])],
    };
    await this.sessions.touch(sessionHash, at);
    await this.auditAuthentication(
      principal.adminId,
      requestCorrelationId,
      "SUCCEEDED",
      "ADMIN_AUTHENTICATED",
      at,
    );
    return {
      authenticated: true,
      principal,
      reasonCode: "ADMIN_AUTHENTICATED",
    };
  }

  public async logout(rawSession: string): Promise<void> {
    if (isOpaqueSessionValue(rawSession)) {
      await this.sessions.revoke(
        hashAdminSession(rawSession, this.hashSecret),
        this.now(),
      );
    }
  }

  private async auditAuthentication(
    actorId: string,
    requestCorrelationId: CorrelationId,
    outcome: AuditEvent["outcome"],
    reasonCode: string,
    timestampUtc: Date,
  ): Promise<void> {
    await this.audit.append(
      validateAuditEvent({
        actor: { id: actorId, type: "ADMIN" },
        correlationId: requestCorrelationId,
        entity: { id: "admin-portal", type: "ADMIN_PORTAL" },
        environment: this.environment,
        eventType: "AUTH_SECURITY_EVENT",
        metadata: { authenticationMethod: "OPAQUE_SERVER_SESSION" },
        outcome,
        reasonCode,
        timestampUtc,
        uuid: randomUUID(),
      }),
    );
  }
}

export const hasAdminCapability = (
  principal: AdminPrincipal,
  capability: AdminCapability,
): boolean =>
  principal.roles.some((role) => roleCapabilities[role].includes(capability)) ||
  (principal.individualCapabilities ?? []).includes(capability);

export const capabilitiesForRole = (
  role: AdminRole,
): readonly AdminCapability[] => [...roleCapabilities[role]];

export class AdminAccessError extends Error {
  public constructor(
    public readonly reasonCode:
      | "ADMIN_ACCESS_DENIED"
      | "ADMIN_INPUT_INVALID"
      | "ADMIN_RESOURCE_UNAVAILABLE",
  ) {
    super("Admin request unavailable");
    this.name = "AdminAccessError";
  }
}

export interface AdminOrderSummary {
  readonly orderId: OrderId;
  readonly operatorReference: string;
  readonly customerEmail: string | null;
  readonly productTitle: string;
  readonly productPlatform: string;
  readonly quantity: number;
  readonly amountMinor: string;
  readonly currency: string;
  readonly status: string;
  readonly paymentStatus: string;
  readonly procurementStatus: string;
  readonly fulfillmentStatus: string;
  readonly riskStatus: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdminOrderHistoryEntry {
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly reasonCode: string;
  readonly actorType: string;
  readonly occurredAt: Date;
}

export interface AdminOrderDetail extends AdminOrderSummary {
  readonly customerId: string | null;
  readonly correlationId: string;
  readonly guestClaimStatus:
    "ACTIVE" | "CLAIMED" | "EXPIRED" | "REVOKED" | "NOT_AVAILABLE";
  readonly invoiceStatus: "NOT_AVAILABLE";
  readonly supplierId: string | null;
  readonly externalSupplierOrderId: string | null;
  readonly fulfillmentOperationStatus: string | null;
  readonly retrievalState: string | null;
  readonly deliveryState: string | null;
  readonly encryptedSecretAvailable: boolean;
  readonly history: readonly AdminOrderHistoryEntry[];
}

export interface AdminDashboard {
  readonly totalOrders: number;
  readonly attentionOrders: number;
  readonly processingOrders: number;
  readonly failedOrders: number;
  readonly revenueByCurrency: readonly {
    readonly currency: string;
    readonly amountMinor: string;
  }[];
  readonly topProducts: readonly {
    readonly productId: string;
    readonly productTitle: string;
    readonly purchasedQuantity: number;
  }[];
  readonly recentOrders: readonly AdminOrderSummary[];
}

export interface AdminOrderFilters {
  readonly exactOrderId?: OrderId;
  readonly exactOperatorReference?: string;
  readonly exactCustomerEmail?: string;
  readonly status?: string;
  readonly paymentStatus?: string;
  readonly riskStatus?: string;
  readonly procurementStatus?: string;
  readonly fulfillmentStatus?: string;
  readonly operationalView?: "ATTENTION" | "PROCESSING" | "FAILED";
  readonly fromDate?: string;
  readonly toDate?: string;
}

export interface AdminOrderCursor {
  readonly createdAt: Date;
  readonly orderId: OrderId;
}

export interface AdminOrderPage {
  readonly orders: readonly AdminOrderSummary[];
  readonly totalCount: number;
  readonly metrics: AdminOrderMetrics;
  readonly nextCursor?: AdminOrderCursor;
  readonly previousCursor?: AdminOrderCursor;
}

export interface AdminOrderMetrics {
  readonly totalOrders: number;
  readonly attentionOrders: number;
  readonly processingOrders: number;
  readonly failedOrders: number;
}

export interface AdminOrderReadRepository {
  dashboard(): Promise<AdminDashboard>;
  list(input: {
    readonly filters: AdminOrderFilters;
    readonly limit: number;
    readonly cursor?: AdminOrderCursor;
    readonly cursorDirection: "NEXT" | "PREVIOUS";
    readonly sort: "NEWEST" | "OLDEST";
  }): Promise<AdminOrderPage>;
  findDetail(targetOrderId: OrderId): Promise<AdminOrderDetail | null>;
}

export interface AdminOrderQuery {
  readonly search?: string;
  readonly status?: string;
  readonly paymentStatus?: string;
  readonly riskStatus?: string;
  readonly procurementStatus?: string;
  readonly fulfillmentStatus?: string;
  readonly operationalView?: string;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly cursorDirection?: string;
  readonly sort?: string;
}

export interface AdminOrderListResult extends AdminOrderPage {
  readonly nextCursorValue?: string;
  readonly previousCursorValue?: string;
  readonly filters: AdminOrderFilters;
  readonly limit: number;
  readonly sort: "NEWEST" | "OLDEST";
}

const allowedOrderStatuses = new Set([
  "CREATED",
  "AWAITING_PAYMENT",
  "PAYMENT_AUTHORIZED",
  "PAYMENT_CAPTURED",
  "PROCUREMENT_PENDING",
  "PROCUREMENT_IN_PROGRESS",
  "FULFILLMENT_PENDING",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "REFUND_PENDING",
  "REFUNDED",
  "MANUAL_REVIEW",
]);
const allowedPaymentStatuses = new Set([
  "NOT_STARTED",
  "PENDING",
  "AUTHORIZED",
  "CAPTURED",
  "FAILED",
  "CANCELLED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
]);
const allowedRiskStatuses = new Set([
  "NOT_EVALUATED",
  "APPROVED",
  "REVIEW_REQUIRED",
  "REJECTED",
]);
const allowedProcurementStatuses = new Set([
  "NOT_STARTED",
  "PENDING",
  "IN_PROGRESS",
  "SUCCEEDED",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
  "AMBIGUOUS",
]);
const allowedFulfillmentStatuses = new Set([
  "NOT_STARTED",
  "PENDING",
  "SUCCEEDED",
  "FAILED",
  "MANUAL_REVIEW",
]);

export class AdminOrderService {
  public constructor(
    private readonly repository: AdminOrderReadRepository,
    private readonly audit: AuditEventPort,
    private readonly cursorSecret: string,
    private readonly environment: AuditEvent["environment"],
    private readonly now: () => Date = () => new Date(),
  ) {
    requireStrongSecret(cursorSecret, "Admin cursor secret");
  }

  public async dashboard(
    principal: AdminPrincipal,
    requestCorrelationId: CorrelationId,
  ): Promise<AdminDashboard> {
    await this.requireCapability(principal, "ORDER_VIEW", requestCorrelationId);
    const dashboard = await this.repository.dashboard();
    await this.auditRead(
      principal,
      requestCorrelationId,
      "ADMIN_DASHBOARD_VIEWED",
      {
        resultCount: dashboard.recentOrders.length,
      },
    );
    return dashboard;
  }

  public async list(
    principal: AdminPrincipal,
    query: AdminOrderQuery,
    requestCorrelationId: CorrelationId,
  ): Promise<AdminOrderListResult> {
    await this.requireCapability(principal, "ORDER_VIEW", requestCorrelationId);
    const filters = parseAdminOrderFilters(query);
    const limit = parsePageLimit(query.limit);
    const sort = parseOrderSort(query.sort);
    const cursorDirection = parseCursorDirection(query.cursorDirection);
    if (query.cursorDirection && !query.cursor)
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    const fingerprint = filterFingerprint(filters, sort, limit);
    const cursor = query.cursor
      ? decodeAdminCursor(query.cursor, fingerprint, this.cursorSecret)
      : undefined;
    const page = await this.repository.list({
      ...(cursor ? { cursor } : {}),
      cursorDirection,
      filters,
      limit,
      sort,
    });
    await this.auditRead(
      principal,
      requestCorrelationId,
      "ADMIN_ORDER_LIST_VIEWED",
      {
        resultCount: page.orders.length,
        filtered: Object.keys(filters).length > 0,
      },
    );
    return {
      ...page,
      filters,
      limit,
      sort,
      ...(page.nextCursor
        ? {
            nextCursorValue: encodeAdminCursor(
              page.nextCursor,
              fingerprint,
              this.cursorSecret,
            ),
          }
        : {}),
      ...(page.previousCursor
        ? {
            previousCursorValue: encodeAdminCursor(
              page.previousCursor,
              fingerprint,
              this.cursorSecret,
            ),
          }
        : {}),
    };
  }

  public async detail(
    principal: AdminPrincipal,
    targetOrderId: string,
    requestCorrelationId: CorrelationId,
  ): Promise<AdminOrderDetail> {
    await this.requireCapability(principal, "ORDER_VIEW", requestCorrelationId);
    const parsedOrderId = parseOrderId(targetOrderId);
    const detail = await this.repository.findDetail(parsedOrderId);
    if (!detail) {
      await this.auditRead(
        principal,
        requestCorrelationId,
        "ADMIN_ORDER_VIEW_DENIED",
        {
          found: false,
        },
        "DENIED",
        "ADMIN_RESOURCE_UNAVAILABLE",
        parsedOrderId,
      );
      throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    }
    await this.auditRead(
      principal,
      requestCorrelationId,
      "ADMIN_ORDER_DETAIL_VIEWED",
      { found: true },
      "SUCCEEDED",
      "ADMIN_ORDER_DETAIL_VIEWED",
      parsedOrderId,
    );
    return detail;
  }

  public async requestProductKeyReveal(
    principal: AdminPrincipal,
    targetOrderId: string,
    requestCorrelationId: CorrelationId,
  ): Promise<{ readonly available: false; readonly reasonCode: string }> {
    await this.requireCapability(
      principal,
      "PRODUCT_KEY_REVEAL",
      requestCorrelationId,
    );
    const parsedOrderId = parseOrderId(targetOrderId);
    const detail = await this.repository.findDetail(parsedOrderId);
    if (!detail) {
      await this.auditRead(
        principal,
        requestCorrelationId,
        "ADMIN_KEY_REVEAL_DENIED",
        { found: false },
        "DENIED",
        "ADMIN_RESOURCE_UNAVAILABLE",
        parsedOrderId,
      );
      throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    }
    const reasonCode = detail.encryptedSecretAvailable
      ? "ADMIN_KEY_REVEAL_NOT_ENABLED"
      : "ADMIN_KEY_NOT_AVAILABLE";
    await this.auditRead(
      principal,
      requestCorrelationId,
      "ADMIN_KEY_REVEAL_DENIED",
      {
        encryptedMaterialPresent: detail.encryptedSecretAvailable,
      },
      "DENIED",
      reasonCode,
      parsedOrderId,
    );
    return { available: false, reasonCode };
  }

  private async requireCapability(
    principal: AdminPrincipal,
    capability: AdminCapability,
    requestCorrelationId: CorrelationId,
  ): Promise<void> {
    if (
      !hasAdminCapability(principal, "ADMIN_ACCESS") ||
      !hasAdminCapability(principal, capability)
    ) {
      await this.auditRead(
        principal,
        requestCorrelationId,
        "ADMIN_ACCESS_DENIED",
        { requiredCapability: capability },
        "DENIED",
        "ADMIN_ACCESS_DENIED",
      );
      throw new AdminAccessError("ADMIN_ACCESS_DENIED");
    }
  }

  private async auditRead(
    principal: AdminPrincipal,
    requestCorrelationId: CorrelationId,
    action: string,
    metadata: Readonly<Record<string, string | number | boolean | null>>,
    outcome: AuditEvent["outcome"] = "SUCCEEDED",
    reasonCode: string = action,
    entityId = "admin-orders",
  ): Promise<void> {
    await this.audit.append(
      validateAuditEvent({
        actor: { id: principal.adminId, type: "ADMIN" },
        correlationId: requestCorrelationId,
        entity: { id: entityId, type: "ORDER" },
        environment: this.environment,
        eventType: "ADMIN_ACTION",
        metadata: { action, ...metadata },
        outcome,
        reasonCode,
        timestampUtc: this.now(),
        uuid: randomUUID(),
      }),
    );
  }
}

export const hashAdminSession = (rawSession: string, secret: string): string =>
  createHmac("sha256", secret).update(rawSession, "utf8").digest("hex");

export const createAdminCsrf = (
  principal: AdminPrincipal,
  method: "POST",
  path: string,
  secret: string,
): string => {
  requireStrongSecret(secret, "Admin CSRF secret");
  return createHmac("sha256", secret)
    .update(`${principal.adminId}\n${method}\n${path}`, "utf8")
    .digest("hex");
};

export const verifyAdminCsrf = (actual: string, expected: string): boolean => {
  if (!/^[a-f0-9]{64}$/u.test(actual) || !/^[a-f0-9]{64}$/u.test(expected)) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex"),
  );
};

const parseAdminOrderFilters = (query: AdminOrderQuery): AdminOrderFilters => {
  const filters: {
    exactOrderId?: OrderId;
    exactOperatorReference?: string;
    exactCustomerEmail?: string;
    status?: string;
    paymentStatus?: string;
    riskStatus?: string;
    procurementStatus?: string;
    fulfillmentStatus?: string;
    operationalView?: "ATTENTION" | "PROCESSING" | "FAILED";
    fromDate?: string;
    toDate?: string;
  } = {};
  if (query.search !== undefined && query.search.trim() !== "") {
    const search = query.search.trim();
    if (search.length > 254 || /[\u0000-\u001f\u007f]/u.test(search)) {
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    }
    if (uuidPattern.test(search)) {
      filters.exactOrderId = orderId(search.toLowerCase());
    } else if (operatorReferencePattern.test(search)) {
      filters.exactOperatorReference = search.toUpperCase();
    } else if (emailPattern.test(search)) {
      filters.exactCustomerEmail = search.toLowerCase();
    } else {
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    }
  }
  if (query.status !== undefined && query.status !== "") {
    if (!allowedOrderStatuses.has(query.status)) {
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    }
    filters.status = query.status;
  }
  if (query.paymentStatus !== undefined && query.paymentStatus !== "") {
    if (!allowedPaymentStatuses.has(query.paymentStatus))
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    filters.paymentStatus = query.paymentStatus;
  }
  if (query.riskStatus !== undefined && query.riskStatus !== "") {
    if (!allowedRiskStatuses.has(query.riskStatus))
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    filters.riskStatus = query.riskStatus;
  }
  if (query.procurementStatus !== undefined && query.procurementStatus !== "") {
    if (!allowedProcurementStatuses.has(query.procurementStatus))
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    filters.procurementStatus = query.procurementStatus;
  }
  if (query.fulfillmentStatus !== undefined && query.fulfillmentStatus !== "") {
    if (!allowedFulfillmentStatuses.has(query.fulfillmentStatus))
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    filters.fulfillmentStatus = query.fulfillmentStatus;
  }
  if (query.operationalView !== undefined && query.operationalView !== "") {
    if (!["ATTENTION", "PROCESSING", "FAILED"].includes(query.operationalView))
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    filters.operationalView = query.operationalView as
      "ATTENTION" | "PROCESSING" | "FAILED";
  }
  if (query.fromDate !== undefined && query.fromDate !== "") {
    filters.fromDate = parseIsoDate(query.fromDate);
  }
  if (query.toDate !== undefined && query.toDate !== "") {
    filters.toDate = parseIsoDate(query.toDate);
  }
  if (filters.fromDate && filters.toDate && filters.fromDate > filters.toDate) {
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  }
  return filters;
};

const operatorReferencePattern = /^KR[0-9A-F]{7}$/iu;

const parsePageLimit = (value: number | undefined): number => {
  if (value === undefined) return 25;
  if (![10, 25, 50].includes(value)) {
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  }
  return value;
};

const parseOrderSort = (value: string | undefined): "NEWEST" | "OLDEST" => {
  if (value === undefined || value === "") return "NEWEST";
  if (value !== "NEWEST" && value !== "OLDEST")
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return value;
};

const parseCursorDirection = (
  value: string | undefined,
): "NEXT" | "PREVIOUS" => {
  if (value === undefined || value === "") return "NEXT";
  if (value !== "NEXT" && value !== "PREVIOUS")
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return value;
};

const parseOrderId = (value: string): OrderId => {
  if (!uuidPattern.test(value))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return orderId(value.toLowerCase());
};

const parseIsoDate = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  }
  return value;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const isOpaqueSessionValue = (value: string): boolean =>
  value.length >= 32 &&
  value.length <= 512 &&
  /^[A-Za-z0-9._~-]+$/u.test(value);

const requireStrongSecret = (value: string, label: string): void => {
  if (Buffer.byteLength(value, "utf8") < 32)
    throw new Error(`${label} must be at least 32 bytes`);
};

const filterFingerprint = (
  filters: AdminOrderFilters,
  sort: "NEWEST" | "OLDEST",
  limit: number,
): string =>
  createHash("sha256")
    .update(JSON.stringify({ filters, limit, sort }), "utf8")
    .digest("hex");

const encodeAdminCursor = (
  cursor: AdminOrderCursor,
  fingerprint: string,
  secret: string,
): string => {
  const payload = Buffer.from(
    JSON.stringify({
      createdAt: cursor.createdAt.toISOString(),
      fingerprint,
      orderId: cursor.orderId,
    }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("base64url");
  return `${payload}.${signature}`;
};

const decodeAdminCursor = (
  value: string,
  fingerprint: string,
  secret: string,
): AdminOrderCursor => {
  if (value.length > 1024) throw new AdminAccessError("ADMIN_INPUT_INVALID");
  const parts = value.split(".");
  if (parts.length !== 2) throw new AdminAccessError("ADMIN_INPUT_INVALID");
  const [payload, signature] = parts;
  if (!payload || !signature) throw new AdminAccessError("ADMIN_INPUT_INVALID");
  const expected = createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      decoded.fingerprint !== fingerprint ||
      typeof decoded.createdAt !== "string" ||
      typeof decoded.orderId !== "string"
    ) {
      throw new Error("invalid");
    }
    return {
      createdAt: new Date(decoded.createdAt),
      orderId: parseOrderId(decoded.orderId),
    };
  } catch {
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  }
};

export const newAdminCorrelationId = (): CorrelationId =>
  correlationId(randomUUID());
