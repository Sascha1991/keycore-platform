import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  AuditEvent,
  AuditEventPort,
  CorrelationId,
} from "../contracts.js";
import { validateAuditEvent } from "../contracts.js";
import {
  AdminAccessError,
  adminCapabilities,
  adminRoles,
  capabilitiesForRole,
  hasAdminCapability,
  type AdminCapability,
  type AdminPrincipal,
  type AdminRole,
} from "./admin-orders.js";

export const sensitiveAdminCapabilities = [
  "PRODUCT_KEY_REVEAL",
  "STAFF_MANAGE",
  "ROLE_ASSIGN",
  "PERMISSION_OVERRIDE_MANAGE",
  "SENSITIVE_OPERATION",
] as const satisfies readonly AdminCapability[];

export interface AdminStaffSummary {
  readonly adminId: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly displayName: string;
  readonly employeeNumber: string | null;
  readonly emailNormalized: string | null;
  readonly status: "ACTIVE" | "DISABLED";
  readonly role: AdminRole | null;
  readonly hasAdditionalPermissions: boolean;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdminRoleHistoryEntry {
  readonly role: AdminRole;
  readonly grantedAt: Date;
  readonly revokedAt: Date | null;
}

export interface AdminPermissionGrant {
  readonly capability: AdminCapability;
  readonly grantedAt: Date;
  readonly revokedAt: Date | null;
  readonly reason: string | null;
}

export interface AdminStaffDetail extends AdminStaffSummary {
  readonly roleCapabilities: readonly AdminCapability[];
  readonly activeIndividualCapabilities: readonly AdminCapability[];
  readonly effectiveCapabilities: readonly AdminCapability[];
  readonly roleHistory: readonly AdminRoleHistoryEntry[];
  readonly permissionHistory: readonly AdminPermissionGrant[];
  readonly lastAuditAt: Date | null;
}

export interface AdminAuditEntry {
  readonly id: string;
  readonly timestampUtc: Date;
  readonly eventType: string;
  readonly actorId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly outcome: "SUCCEEDED" | "FAILED" | "DENIED";
  readonly reasonCode: string;
  readonly safeDetails: Readonly<Record<string, string | number | boolean>>;
}

export interface AdminAuditFilters {
  readonly from?: string;
  readonly to?: string;
  readonly eventType?: string;
  readonly outcome?: AdminAuditEntry["outcome"];
  readonly actorId?: string;
  readonly entityId?: string;
  readonly reasonCode?: string;
}

export interface AdminAuditCursor {
  readonly timestampUtc: Date;
  readonly id: string;
}

export interface AdminMutationContext {
  readonly actorId: string;
  readonly correlationId: CorrelationId;
  readonly environment: AuditEvent["environment"];
  readonly at: Date;
}

export type AdminStaffMutationResult =
  "UPDATED" | "UNCHANGED" | "NOT_FOUND" | "LAST_OWNER_PROTECTED" | "DUPLICATE";

export interface AdminStaffRepository {
  list(limit: number, after?: string): Promise<readonly AdminStaffSummary[]>;
  findDetail(adminId: string): Promise<AdminStaffDetail | null>;
  create(
    input: {
      readonly adminId: string;
      readonly firstName: string;
      readonly lastName: string;
      readonly displayName: string;
      readonly employeeNumber: string;
      readonly emailNormalized: string | null;
      readonly role: AdminRole;
    },
    context: AdminMutationContext,
  ): Promise<AdminStaffMutationResult>;
  setStatus(
    targetAdminId: string,
    status: "ACTIVE" | "DISABLED",
    context: AdminMutationContext,
  ): Promise<AdminStaffMutationResult>;
  changeRole(
    targetAdminId: string,
    role: AdminRole,
    context: AdminMutationContext,
  ): Promise<AdminStaffMutationResult>;
  grantPermission(
    targetAdminId: string,
    capability: AdminCapability,
    reason: string | null,
    context: AdminMutationContext,
  ): Promise<AdminStaffMutationResult>;
  revokePermission(
    targetAdminId: string,
    capability: AdminCapability,
    context: AdminMutationContext,
  ): Promise<AdminStaffMutationResult>;
  listAudit(input: {
    readonly filters: AdminAuditFilters;
    readonly limit: number;
    readonly after?: AdminAuditCursor;
  }): Promise<{
    readonly entries: readonly AdminAuditEntry[];
    readonly nextCursor?: AdminAuditCursor;
  }>;
}

export class AdminStaffService {
  public constructor(
    private readonly repository: AdminStaffRepository,
    private readonly audit: AuditEventPort,
    private readonly cursorSecret: string,
    private readonly environment: AuditEvent["environment"],
    private readonly now: () => Date = () => new Date(),
  ) {
    if (Buffer.byteLength(cursorSecret, "utf8") < 32)
      throw new Error("Admin staff cursor secret must be at least 32 bytes");
  }

  public async list(
    principal: AdminPrincipal,
    correlationId: CorrelationId,
  ): Promise<readonly AdminStaffSummary[]> {
    await this.requireCapability(principal, "STAFF_VIEW", correlationId);
    const rows = await this.repository.list(100);
    await this.auditAction(
      principal,
      correlationId,
      "ADMIN_STAFF_LIST_VIEWED",
      {
        resultCount: rows.length,
      },
    );
    return rows;
  }

  public async detail(
    principal: AdminPrincipal,
    targetAdminId: string,
    correlationId: CorrelationId,
  ): Promise<AdminStaffDetail> {
    await this.requireCapability(principal, "STAFF_VIEW", correlationId);
    const id = parseAdminId(targetAdminId);
    const detail = await this.repository.findDetail(id);
    if (!detail) throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    await this.auditAction(
      principal,
      correlationId,
      "ADMIN_STAFF_DETAIL_VIEWED",
      { targetAdminId: id },
      id,
    );
    return detail;
  }

  public async create(
    principal: AdminPrincipal,
    input: Readonly<Record<string, string>>,
    correlationId: CorrelationId,
  ): Promise<string> {
    await this.requireCapability(principal, "STAFF_MANAGE", correlationId);
    const firstName = boundedName(input.firstName ?? "");
    const lastName = boundedName(input.lastName ?? "");
    const employeeNumber = parseEmployeeNumber(input.employeeNumber ?? "");
    const emailNormalized = parseOptionalEmail(input.email ?? "");
    const role = parseRole(input.role ?? "");
    const adminId = randomUUID();
    const result = await this.repository.create(
      {
        adminId,
        displayName: `${firstName} ${lastName}`,
        emailNormalized,
        employeeNumber,
        firstName,
        lastName,
        role,
      },
      this.context(principal, correlationId),
    );
    if (result === "DUPLICATE")
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    if (result !== "UPDATED")
      throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    return adminId;
  }

  public async setStatus(
    principal: AdminPrincipal,
    targetAdminId: string,
    status: "ACTIVE" | "DISABLED",
    correlationId: CorrelationId,
  ): Promise<void> {
    await this.requireCapability(principal, "STAFF_MANAGE", correlationId);
    const id = parseAdminId(targetAdminId);
    if (status === "DISABLED" && id === principal.adminId) {
      await this.denied(
        principal,
        correlationId,
        "ADMIN_SELF_DISABLE_DENIED",
        id,
      );
      throw new AdminAccessError("ADMIN_ACCESS_DENIED");
    }
    this.requireMutationResult(
      await this.repository.setStatus(
        id,
        status,
        this.context(principal, correlationId),
      ),
    );
  }

  public async changeRole(
    principal: AdminPrincipal,
    targetAdminId: string,
    roleValue: string,
    correlationId: CorrelationId,
  ): Promise<void> {
    await this.requireCapability(principal, "ROLE_ASSIGN", correlationId);
    const id = parseAdminId(targetAdminId);
    const role = parseRole(roleValue);
    this.requireMutationResult(
      await this.repository.changeRole(
        id,
        role,
        this.context(principal, correlationId),
      ),
    );
  }

  public async grantPermission(
    principal: AdminPrincipal,
    targetAdminId: string,
    capabilityValue: string,
    reasonValue: string,
    correlationId: CorrelationId,
  ): Promise<void> {
    await this.requireCapability(
      principal,
      "PERMISSION_OVERRIDE_MANAGE",
      correlationId,
    );
    const id = parseAdminId(targetAdminId);
    const capability = parseCapability(capabilityValue);
    const reason = parseOptionalReason(reasonValue);
    const sensitive = (
      sensitiveAdminCapabilities as readonly string[]
    ).includes(capability);
    if (
      (sensitive && !principal.roles.includes("PROJECT_OWNER")) ||
      (sensitive && id === principal.adminId)
    ) {
      await this.denied(
        principal,
        correlationId,
        "ADMIN_SELF_ESCALATION_DENIED",
        id,
        capability,
      );
      throw new AdminAccessError("ADMIN_ACCESS_DENIED");
    }
    this.requireMutationResult(
      await this.repository.grantPermission(
        id,
        capability,
        reason,
        this.context(principal, correlationId),
      ),
    );
  }

  public async revokePermission(
    principal: AdminPrincipal,
    targetAdminId: string,
    capabilityValue: string,
    correlationId: CorrelationId,
  ): Promise<void> {
    await this.requireCapability(
      principal,
      "PERMISSION_OVERRIDE_MANAGE",
      correlationId,
    );
    const id = parseAdminId(targetAdminId);
    const capability = parseCapability(capabilityValue);
    this.requireMutationResult(
      await this.repository.revokePermission(
        id,
        capability,
        this.context(principal, correlationId),
      ),
    );
  }

  public async auditList(
    principal: AdminPrincipal,
    query: Readonly<Record<string, string | undefined>>,
    correlationId: CorrelationId,
  ) {
    await this.requireCapability(principal, "AUDIT_VIEW", correlationId);
    const filters = parseAuditFilters(query);
    const fingerprint = JSON.stringify(filters);
    const after = query.cursor
      ? decodeCursor(query.cursor, fingerprint, this.cursorSecret)
      : undefined;
    const page = await this.repository.listAudit({
      ...(after ? { after } : {}),
      filters,
      limit: 50,
    });
    await this.auditAction(principal, correlationId, "ADMIN_AUDIT_VIEWED", {
      filtered: Object.keys(filters).length > 0,
      resultCount: page.entries.length,
    });
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
      filters,
    };
  }

  private context(
    principal: AdminPrincipal,
    correlationId: CorrelationId,
  ): AdminMutationContext {
    return {
      actorId: principal.adminId,
      at: this.now(),
      correlationId,
      environment: this.environment,
    };
  }

  private requireMutationResult(result: AdminStaffMutationResult): void {
    if (result === "UPDATED" || result === "UNCHANGED") return;
    if (result === "LAST_OWNER_PROTECTED")
      throw new AdminAccessError("ADMIN_ACCESS_DENIED");
    if (result === "DUPLICATE")
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
  }

  private async requireCapability(
    principal: AdminPrincipal,
    capability: AdminCapability,
    correlationId: CorrelationId,
  ): Promise<void> {
    if (
      !hasAdminCapability(principal, "ADMIN_ACCESS") ||
      !hasAdminCapability(principal, capability)
    ) {
      await this.denied(
        principal,
        correlationId,
        "ADMIN_ACCESS_DENIED",
        "admin-portal",
        capability,
      );
      throw new AdminAccessError("ADMIN_ACCESS_DENIED");
    }
  }

  private async denied(
    principal: AdminPrincipal,
    correlationId: CorrelationId,
    reasonCode: string,
    targetAdminId: string,
    capability?: AdminCapability,
  ): Promise<void> {
    await this.auditAction(
      principal,
      correlationId,
      "ADMIN_ACCESS_DENIED",
      {
        ...(capability ? { requiredCapability: capability } : {}),
        targetAdminId,
      },
      targetAdminId,
      "DENIED",
      reasonCode,
    );
  }

  private async auditAction(
    principal: AdminPrincipal,
    correlationId: CorrelationId,
    action: string,
    metadata: Readonly<Record<string, string | number | boolean>>,
    entityId = "admin-portal",
    outcome: AuditEvent["outcome"] = "SUCCEEDED",
    reasonCode = action,
  ): Promise<void> {
    await this.audit.append(
      validateAuditEvent({
        actor: { id: principal.adminId, type: "ADMIN" },
        correlationId,
        entity: { id: entityId, type: "ADMIN_IDENTITY" },
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

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const parseAdminId = (value: string): string => {
  if (!uuidPattern.test(value))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return value.toLowerCase();
};
const boundedName = (value: string): string => {
  const parsed = value.trim();
  if (
    parsed.length < 1 ||
    parsed.length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(parsed)
  )
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return parsed;
};
const parseEmployeeNumber = (value: string): string => {
  const parsed = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(parsed))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return parsed;
};
const parseOptionalEmail = (value: string): string | null => {
  const parsed = value.trim().toLowerCase();
  if (parsed === "") return null;
  if (parsed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(parsed))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return parsed;
};
const parseOptionalReason = (value: string): string | null => {
  const parsed = value.trim();
  if (parsed === "") return null;
  if (parsed.length > 240 || /[\u0000-\u001f\u007f]/u.test(parsed))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return parsed;
};
const parseRole = (value: string): AdminRole => {
  if (!(adminRoles as readonly string[]).includes(value))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return value as AdminRole;
};
const parseCapability = (value: string): AdminCapability => {
  if (!(adminCapabilities as readonly string[]).includes(value))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return value as AdminCapability;
};
const parseAuditFilters = (
  query: Readonly<Record<string, string | undefined>>,
): AdminAuditFilters => {
  const filters: {
    from?: string;
    to?: string;
    eventType?: string;
    outcome?: AdminAuditEntry["outcome"];
    actorId?: string;
    entityId?: string;
    reasonCode?: string;
  } = {};
  for (const key of ["from", "to"] as const) {
    const value = query[key];
    if (value) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
        Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
      )
        throw new AdminAccessError("ADMIN_INPUT_INVALID");
      filters[key] = value;
    }
  }
  if (filters.from && filters.to && filters.from > filters.to)
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  if (query.eventType) filters.eventType = safeCode(query.eventType);
  if (query.outcome) {
    if (!["SUCCEEDED", "FAILED", "DENIED"].includes(query.outcome))
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    filters.outcome = query.outcome as AdminAuditEntry["outcome"];
  }
  if (query.actorId) filters.actorId = parseAdminId(query.actorId);
  if (query.entityId) filters.entityId = parseAdminId(query.entityId);
  if (query.reasonCode) filters.reasonCode = safeCode(query.reasonCode);
  return filters;
};
const safeCode = (value: string): string => {
  if (!/^[A-Z][A-Z0-9_]{0,99}$/u.test(value))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return value;
};
const encodeCursor = (
  cursor: AdminAuditCursor,
  fingerprint: string,
  secret: string,
): string => {
  const payload = Buffer.from(
    JSON.stringify({
      id: cursor.id,
      timestampUtc: cursor.timestampUtc.toISOString(),
      fingerprint,
    }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
};
const decodeCursor = (
  value: string,
  fingerprint: string,
  secret: string,
): AdminAuditCursor => {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra || value.length > 1024)
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  const expected = createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      decoded.fingerprint !== fingerprint ||
      typeof decoded.id !== "string" ||
      typeof decoded.timestampUtc !== "string" ||
      !uuidPattern.test(decoded.id)
    )
      throw new Error("invalid");
    const timestampUtc = new Date(decoded.timestampUtc);
    if (Number.isNaN(timestampUtc.getTime())) throw new Error("invalid");
    return { id: decoded.id, timestampUtc };
  } catch {
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  }
};

export const effectiveAdminCapabilities = (
  role: AdminRole | null,
  grants: readonly AdminCapability[],
): readonly AdminCapability[] =>
  [...new Set([...(role ? capabilitiesForRole(role) : []), ...grants])].sort();
