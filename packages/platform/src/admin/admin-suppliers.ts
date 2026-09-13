import { randomUUID } from "node:crypto";

import type {
  AuditEvent,
  AuditEventPort,
  CorrelationId,
} from "../contracts.js";
import { validateAuditEvent } from "../contracts.js";
import {
  AdminAccessError,
  hasAdminCapability,
  type AdminPrincipal,
} from "./admin-orders.js";
import type { AdminMutationContext } from "./admin-staff.js";

export const adminSupplierProviderTypes = ["SYNTHETIC"] as const;
export type AdminSupplierProviderType =
  (typeof adminSupplierProviderTypes)[number];

export interface AdminSupplierProviderOption {
  readonly type: AdminSupplierProviderType;
  readonly label: string;
}

export interface AdminSupplierMutationRepository {
  create(
    input: {
      readonly supplierId: string;
      readonly supplierCode: string;
      readonly displayName: string;
      readonly providerType: AdminSupplierProviderType;
      readonly operationId: string;
    },
    context: AdminMutationContext,
  ): Promise<
    | { readonly status: "CREATED"; readonly supplierId: string }
    | { readonly status: "IDEMPOTENT"; readonly supplierId: string }
    | { readonly status: "CONFLICT" }
  >;
  rename(
    input: {
      readonly supplierId: string;
      readonly displayName: string;
      readonly expectedVersion: number;
    },
    context: AdminMutationContext,
  ): Promise<"UPDATED" | "UNCHANGED" | "STALE" | "NOT_FOUND">;
}

export class AdminSupplierConflictError extends Error {
  public constructor() {
    super("Supplier changed concurrently");
    this.name = "AdminSupplierConflictError";
  }
}

export class AdminSupplierService {
  public constructor(
    private readonly repository: AdminSupplierMutationRepository,
    private readonly audit: AuditEventPort,
    private readonly environment: AuditEvent["environment"],
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async options(
    principal: AdminPrincipal,
    correlationId: CorrelationId,
  ): Promise<readonly AdminSupplierProviderOption[]> {
    await this.requireManage(principal, correlationId);
    return this.environment === "STAGING"
      ? [{ type: "SYNTHETIC", label: "Synthetischer Testanbieter" }]
      : [];
  }

  public async create(
    principal: AdminPrincipal,
    input: Readonly<Record<string, string>>,
    correlationId: CorrelationId,
  ): Promise<string> {
    await this.requireManage(principal, correlationId);
    const displayName = supplierDisplayName(input.displayName ?? "");
    const providerType = this.providerType(input.providerType ?? "");
    const operationId = canonicalUuid(input.operationId ?? "");
    const result = await this.repository.create(
      {
        displayName,
        operationId,
        providerType,
        supplierCode: `synthetic-admin-${operationId}`,
        supplierId: randomUUID(),
      },
      this.context(principal, correlationId),
    );
    if (result.status === "CONFLICT")
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    return result.supplierId;
  }

  public async rename(
    principal: AdminPrincipal,
    supplierIdValue: string,
    input: Readonly<Record<string, string>>,
    correlationId: CorrelationId,
  ): Promise<void> {
    await this.requireManage(principal, correlationId);
    const supplierId = canonicalUuid(supplierIdValue);
    const displayName = supplierDisplayName(input.displayName ?? "");
    const expectedVersion = positiveInteger(input.expectedVersion ?? "");
    const result = await this.repository.rename(
      { displayName, expectedVersion, supplierId },
      this.context(principal, correlationId),
    );
    if (result === "STALE") throw new AdminSupplierConflictError();
    if (result === "NOT_FOUND")
      throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
  }

  private providerType(value: string): AdminSupplierProviderType {
    if (value !== "SYNTHETIC" || this.environment !== "STAGING")
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    return value;
  }

  private async requireManage(
    principal: AdminPrincipal,
    correlationId: CorrelationId,
  ): Promise<void> {
    if (
      hasAdminCapability(principal, "ADMIN_ACCESS") &&
      hasAdminCapability(principal, "SUPPLIER_MANAGE")
    )
      return;
    await this.audit.append(
      validateAuditEvent({
        actor: { id: principal.adminId, type: "ADMIN" },
        correlationId,
        entity: { id: "admin-suppliers", type: "ADMIN_PORTAL" },
        environment: this.environment,
        eventType: "ADMIN_ACTION",
        metadata: {
          action: "ADMIN_SUPPLIER_MANAGEMENT_DENIED",
          requiredCapability: "SUPPLIER_MANAGE",
        },
        outcome: "DENIED",
        reasonCode: "ADMIN_ACCESS_DENIED",
        timestampUtc: this.now(),
        uuid: randomUUID(),
      }),
    );
    throw new AdminAccessError("ADMIN_ACCESS_DENIED");
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
}

const supplierDisplayName = (value: string): string => {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 120 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  )
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return normalized;
};

const canonicalUuid = (value: string): string => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return value.toLowerCase();
};

const positiveInteger = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
  return parsed;
};
