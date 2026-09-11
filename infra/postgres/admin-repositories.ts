import { randomUUID } from "node:crypto";

import type {
  AdminDashboard,
  AdminAuditEntry,
  AdminCapability,
  AdminOrderDetail,
  AdminOrderFilters,
  AdminOrderPage,
  AdminOrderReadRepository,
  AdminRole,
  AdminStaffDetail,
  AdminStaffMutationResult,
  AdminStaffRepository,
  AdminStaffSummary,
  AdminMutationContext,
  AdminSessionRepository,
  AdminPasswordCredentialRepository,
  StoredAdminPasswordCredential,
  OrderId,
  StoredAdminSession,
} from "../../packages/platform/src/contracts.js";
import {
  adminCapturedPaymentVolumeStates,
  capabilitiesForRole,
  effectiveAdminCapabilities,
  orderId,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface OrderSummaryRow {
  readonly id: string;
  readonly operator_reference: string;
  readonly customer_access_confirmed: boolean;
  readonly customer_email: string | null;
  readonly product_title: string;
  readonly product_platform: string;
  readonly quantity: number;
  readonly customer_amount_minor: string;
  readonly currency: string;
  readonly status: string;
  readonly payment_status: string;
  readonly procurement_status: string;
  readonly fulfillment_status: string;
  readonly risk_status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresAdminSessionRepository implements AdminSessionRepository {
  public constructor(private readonly database: Queryable) {}

  public async findByHash(
    sessionHash: string,
  ): Promise<StoredAdminSession | null> {
    const result = await this.database.query<{
      readonly admin_id: string;
      readonly display_name: string;
      readonly roles: AdminRole[];
      readonly assurance: StoredAdminSession["assurance"];
      readonly expires_at: Date;
      readonly revoked_at: Date | null;
      readonly identity_status: StoredAdminSession["identityStatus"];
      readonly individual_capabilities: AdminCapability[];
    }>(
      `
        SELECT
          identity.id::text AS admin_id,
          identity.display_name,
          COALESCE(
            array_agg(assignment.role ORDER BY assignment.role)
              FILTER (WHERE assignment.role IS NOT NULL),
            ARRAY[]::text[]
          ) AS roles,
          session.assurance,
          session.expires_at,
          session.revoked_at,
          identity.status AS identity_status
          , COALESCE(
            (SELECT array_agg(grant_row.capability ORDER BY grant_row.capability)
             FROM admin_permission_grants grant_row
             WHERE grant_row.admin_id = identity.id AND grant_row.revoked_at IS NULL),
            ARRAY[]::text[]
          ) AS individual_capabilities
        FROM admin_sessions session
        JOIN admin_identities identity ON identity.id = session.admin_id
        LEFT JOIN admin_role_assignments assignment
          ON assignment.admin_id = identity.id AND assignment.revoked_at IS NULL
        WHERE session.session_hash = $1
        GROUP BY identity.id, session.id
      `,
      [sessionHash],
    );
    const row = result.rows[0];
    return row
      ? {
          adminId: row.admin_id,
          assurance: row.assurance,
          displayName: row.display_name,
          expiresAt: row.expires_at,
          identityStatus: row.identity_status,
          individualCapabilities: row.individual_capabilities,
          revokedAt: row.revoked_at,
          roles: row.roles,
        }
      : null;
  }

  public async touch(sessionHash: string, at: Date): Promise<void> {
    await this.database.query(
      `UPDATE admin_sessions SET last_seen_at = $2 WHERE session_hash = $1 AND revoked_at IS NULL`,
      [sessionHash, at],
    );
  }

  public async revoke(sessionHash: string, at: Date): Promise<void> {
    await this.database.query(
      `UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE session_hash = $1`,
      [sessionHash, at],
    );
  }
}

export class PostgresAdminPasswordCredentialRepository implements AdminPasswordCredentialRepository {
  public constructor(private readonly database: Queryable) {}

  public async findByEmail(
    emailNormalized: string,
  ): Promise<StoredAdminPasswordCredential | null> {
    const result = await this.database.query<{
      readonly admin_id: string;
      readonly identity_status: StoredAdminPasswordCredential["identityStatus"];
      readonly password_hash: string;
    }>(
      `SELECT identity.id::text AS admin_id,
              identity.status AS identity_status,
              credential.password_hash
       FROM admin_identities identity
       JOIN admin_password_credentials credential ON credential.admin_id = identity.id
       WHERE identity.email_normalized = $1`,
      [emailNormalized],
    );
    const row = result.rows[0];
    return row
      ? {
          adminId: row.admin_id,
          identityStatus: row.identity_status,
          passwordHash: row.password_hash,
        }
      : null;
  }

  public async issueSession(input: {
    readonly adminId: string;
    readonly expiresAt: Date;
    readonly issuedAt: Date;
    readonly sessionHash: string;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO admin_sessions(
         id, admin_id, session_hash, assurance, issued_at, expires_at
       ) VALUES ($1, $2, $3, 'STAGING_SYNTHETIC', $4, $5)`,
      [
        randomUUID(),
        input.adminId,
        input.sessionHash,
        input.issuedAt,
        input.expiresAt,
      ],
    );
  }
}

interface StaffRow {
  readonly admin_id: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly display_name: string;
  readonly employee_number: string | null;
  readonly email_normalized: string | null;
  readonly status: AdminStaffSummary["status"];
  readonly role: AdminRole | null;
  readonly has_additional_permissions: boolean;
  readonly last_login_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresAdminStaffRepository implements AdminStaffRepository {
  public constructor(private readonly database: TransactionalQueryable) {}

  public async list(
    limit: number,
    after?: string,
  ): Promise<readonly AdminStaffSummary[]> {
    const result = await this.database.query<StaffRow>(
      `${staffSelect}
       ${after ? "WHERE identity.id > $2::uuid" : ""}
       ORDER BY identity.id ASC
       LIMIT $1`,
      after ? [limit, after] : [limit],
    );
    return result.rows.map(mapStaff);
  }

  public async findDetail(adminId: string): Promise<AdminStaffDetail | null> {
    const staff = await this.database.query<StaffRow>(
      `${staffSelect} WHERE identity.id = $1::uuid`,
      [adminId],
    );
    const row = staff.rows[0];
    if (!row) return null;
    const [roles, permissions, audit] = await Promise.all([
      this.database.query<{
        role: AdminRole;
        granted_at: Date;
        revoked_at: Date | null;
      }>(
        `SELECT role, granted_at, revoked_at FROM admin_role_assignments WHERE admin_id = $1 ORDER BY granted_at DESC, id DESC`,
        [adminId],
      ),
      this.database.query<{
        capability: AdminCapability;
        granted_at: Date;
        revoked_at: Date | null;
        reason: string | null;
      }>(
        `SELECT capability, granted_at, revoked_at, reason FROM admin_permission_grants WHERE admin_id = $1 ORDER BY granted_at DESC, id DESC`,
        [adminId],
      ),
      this.database.query<{ last_audit_at: Date | null }>(
        `SELECT max(timestamp_utc) AS last_audit_at FROM audit_events WHERE entity->>'type' = 'ADMIN_IDENTITY' AND entity->>'id' = $1`,
        [adminId],
      ),
    ]);
    const summary = mapStaff(row);
    const active = permissions.rows
      .filter((item) => item.revoked_at === null)
      .map((item) => item.capability);
    return {
      ...summary,
      activeIndividualCapabilities: active,
      effectiveCapabilities: effectiveAdminCapabilities(summary.role, active),
      lastAuditAt: audit.rows[0]?.last_audit_at ?? null,
      permissionHistory: permissions.rows.map((item) => ({
        capability: item.capability,
        grantedAt: item.granted_at,
        reason: item.reason,
        revokedAt: item.revoked_at,
      })),
      roleCapabilities: summary.role ? capabilitiesForRole(summary.role) : [],
      roleHistory: roles.rows.map((item) => ({
        grantedAt: item.granted_at,
        revokedAt: item.revoked_at,
        role: item.role,
      })),
    };
  }

  public async create(
    input: Parameters<AdminStaffRepository["create"]>[0],
    context: AdminMutationContext,
  ): Promise<AdminStaffMutationResult> {
    try {
      return await this.database.transaction<AdminStaffMutationResult>(
        async (client) => {
          await client.query(
            `INSERT INTO admin_identities(id, provider, provider_subject, display_name, first_name, last_name, employee_number, email_normalized, status, created_at, updated_at)
           VALUES ($1, 'STAGING_SYNTHETIC', $2, $3, $4, $5, $6, $7, 'ACTIVE', $8, $8)`,
            [
              input.adminId,
              `managed-profile:${input.adminId}`,
              input.displayName,
              input.firstName,
              input.lastName,
              input.employeeNumber,
              input.emailNormalized,
              context.at,
            ],
          );
          await client.query(
            `INSERT INTO admin_role_assignments(admin_id, role, granted_by, granted_at) VALUES ($1, $2, $3, $4)`,
            [input.adminId, input.role, context.actorId, context.at],
          );
          await appendAdminAudit(
            client,
            context,
            input.adminId,
            "ADMIN_STAFF_CREATED",
            { targetAdminId: input.adminId, newRole: input.role },
          );
          return "UPDATED";
        },
      );
    } catch (error) {
      if (isUniqueViolation(error)) return "DUPLICATE";
      throw error;
    }
  }

  public async setStatus(
    targetAdminId: string,
    status: "ACTIVE" | "DISABLED",
    context: AdminMutationContext,
  ): Promise<AdminStaffMutationResult> {
    return this.database.transaction(async (client) => {
      await lockOwnerLifecycle(client);
      const current = await client.query<{
        status: AdminStaffSummary["status"];
        role: AdminRole | null;
      }>(
        `SELECT identity.status, assignment.role
         FROM admin_identities identity
         LEFT JOIN admin_role_assignments assignment ON assignment.admin_id = identity.id AND assignment.revoked_at IS NULL
         WHERE identity.id = $1 FOR UPDATE OF identity`,
        [targetAdminId],
      );
      const row = current.rows[0];
      if (!row) return "NOT_FOUND";
      if (row.status === status) return "UNCHANGED";
      if (
        status === "DISABLED" &&
        row.role === "PROJECT_OWNER" &&
        (await activeOwnerCount(client)) <= 1
      ) {
        await appendAdminAudit(
          client,
          context,
          targetAdminId,
          "ADMIN_LAST_OWNER_PROTECTED",
          { targetAdminId },
          "DENIED",
        );
        return "LAST_OWNER_PROTECTED";
      }
      await client.query(
        `UPDATE admin_identities SET status = $2, updated_at = $3 WHERE id = $1`,
        [targetAdminId, status, context.at],
      );
      if (status === "DISABLED")
        await revokeSessions(client, targetAdminId, context.at);
      await appendAdminAudit(
        client,
        context,
        targetAdminId,
        status === "ACTIVE" ? "ADMIN_STAFF_ENABLED" : "ADMIN_STAFF_DISABLED",
        { targetAdminId },
      );
      return "UPDATED";
    });
  }

  public async changeRole(
    targetAdminId: string,
    role: AdminRole,
    context: AdminMutationContext,
  ): Promise<AdminStaffMutationResult> {
    return this.database.transaction(async (client) => {
      await lockOwnerLifecycle(client);
      const current = await client.query<{ role: AdminRole }>(
        `SELECT role FROM admin_role_assignments WHERE admin_id = $1 AND revoked_at IS NULL FOR UPDATE`,
        [targetAdminId],
      );
      const previous = current.rows[0]?.role;
      if (!previous) return "NOT_FOUND";
      if (previous === role) return "UNCHANGED";
      if (
        previous === "PROJECT_OWNER" &&
        role !== "PROJECT_OWNER" &&
        (await activeOwnerCount(client)) <= 1
      ) {
        await appendAdminAudit(
          client,
          context,
          targetAdminId,
          "ADMIN_LAST_OWNER_PROTECTED",
          { targetAdminId, previousRole: previous, newRole: role },
          "DENIED",
        );
        return "LAST_OWNER_PROTECTED";
      }
      await client.query(
        `UPDATE admin_role_assignments SET revoked_at = $2 WHERE admin_id = $1 AND revoked_at IS NULL`,
        [targetAdminId, context.at],
      );
      await client.query(
        `INSERT INTO admin_role_assignments(admin_id, role, granted_by, granted_at) VALUES ($1, $2, $3, $4)`,
        [targetAdminId, role, context.actorId, context.at],
      );
      await revokeSessions(client, targetAdminId, context.at);
      await appendAdminAudit(
        client,
        context,
        targetAdminId,
        "ADMIN_ROLE_CHANGED",
        { targetAdminId, previousRole: previous, newRole: role },
      );
      return "UPDATED";
    });
  }

  public async grantPermission(
    targetAdminId: string,
    capability: AdminCapability,
    reason: string | null,
    context: AdminMutationContext,
  ): Promise<AdminStaffMutationResult> {
    try {
      return await this.database.transaction(async (client) => {
        const target = await client.query(
          `SELECT 1 FROM admin_identities WHERE id = $1 FOR UPDATE`,
          [targetAdminId],
        );
        if (target.rowCount === 0) return "NOT_FOUND";
        await client.query(
          `INSERT INTO admin_permission_grants(admin_id, capability, granted_at, granted_by_admin_id, reason) VALUES ($1, $2, $3, $4, $5)`,
          [targetAdminId, capability, context.at, context.actorId, reason],
        );
        await revokeSessions(client, targetAdminId, context.at);
        await appendAdminAudit(
          client,
          context,
          targetAdminId,
          "ADMIN_PERMISSION_GRANTED",
          { targetAdminId, capability },
        );
        return "UPDATED";
      });
    } catch (error) {
      if (isUniqueViolation(error)) return "UNCHANGED";
      throw error;
    }
  }

  public async revokePermission(
    targetAdminId: string,
    capability: AdminCapability,
    context: AdminMutationContext,
  ): Promise<AdminStaffMutationResult> {
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE admin_permission_grants SET revoked_at = $3, revoked_by_admin_id = $2 WHERE admin_id = $1 AND capability = $4 AND revoked_at IS NULL`,
        [targetAdminId, context.actorId, context.at, capability],
      );
      if (result.rowCount === 0) {
        const target = await client.query(
          `SELECT 1 FROM admin_identities WHERE id = $1`,
          [targetAdminId],
        );
        return target.rowCount === 0 ? "NOT_FOUND" : "UNCHANGED";
      }
      await revokeSessions(client, targetAdminId, context.at);
      await appendAdminAudit(
        client,
        context,
        targetAdminId,
        "ADMIN_PERMISSION_REVOKED",
        { targetAdminId, capability },
      );
      return "UPDATED";
    });
  }

  public async listAudit(
    input: Parameters<AdminStaffRepository["listAudit"]>[0],
  ): Promise<Awaited<ReturnType<AdminStaffRepository["listAudit"]>>> {
    const values: unknown[] = [];
    const predicates: string[] = [];
    const add = (value: unknown) => {
      values.push(value);
      return `$${values.length}`;
    };
    if (input.filters.from)
      predicates.push(
        `timestamp_utc >= ${add(`${input.filters.from}T00:00:00.000Z`)}::timestamptz`,
      );
    if (input.filters.to)
      predicates.push(
        `timestamp_utc < (${add(`${input.filters.to}T00:00:00.000Z`)}::timestamptz + interval '1 day')`,
      );
    if (input.filters.eventType)
      predicates.push(`event_type = ${add(input.filters.eventType)}`);
    if (input.filters.outcome)
      predicates.push(`outcome = ${add(input.filters.outcome)}`);
    if (input.filters.actorId)
      predicates.push(`actor->>'id' = ${add(input.filters.actorId)}`);
    if (input.filters.entityId)
      predicates.push(`entity->>'id' = ${add(input.filters.entityId)}`);
    if (input.filters.reasonCode)
      predicates.push(`reason_code = ${add(input.filters.reasonCode)}`);
    if (input.after)
      predicates.push(
        `(timestamp_utc, id) < (${add(input.after.timestampUtc)}, ${add(input.after.id)}::uuid)`,
      );
    const result = await this.database.query<{
      id: string;
      timestamp_utc: Date;
      event_type: string;
      actor: { id?: unknown };
      entity: { id?: unknown; type?: unknown };
      outcome: AdminAuditEntry["outcome"];
      reason_code: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT id::text, timestamp_utc, event_type, actor, entity, outcome, reason_code, metadata
       FROM audit_events ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
       ORDER BY timestamp_utc DESC, id DESC LIMIT ${add(input.limit + 1)}`,
      values,
    );
    const rows = result.rows.slice(0, input.limit);
    const entries = rows.map(mapAuditEntry);
    const last = rows.at(-1);
    return {
      entries,
      ...(result.rows.length > input.limit && last
        ? { nextCursor: { id: last.id, timestampUtc: last.timestamp_utc } }
        : {}),
    };
  }
}

const staffSelect = `
  SELECT identity.id::text AS admin_id, identity.first_name, identity.last_name,
    identity.display_name, identity.employee_number, identity.email_normalized,
    identity.status, assignment.role,
    EXISTS (SELECT 1 FROM admin_permission_grants grant_row WHERE grant_row.admin_id = identity.id AND grant_row.revoked_at IS NULL) AS has_additional_permissions,
    (SELECT max(COALESCE(session.last_seen_at, session.issued_at)) FROM admin_sessions session WHERE session.admin_id = identity.id) AS last_login_at,
    identity.created_at, identity.updated_at
  FROM admin_identities identity
  LEFT JOIN admin_role_assignments assignment ON assignment.admin_id = identity.id AND assignment.revoked_at IS NULL
`;
const mapStaff = (row: StaffRow): AdminStaffSummary => ({
  adminId: row.admin_id,
  createdAt: row.created_at,
  displayName: row.display_name,
  emailNormalized: row.email_normalized,
  employeeNumber: row.employee_number,
  firstName: row.first_name,
  hasAdditionalPermissions: row.has_additional_permissions,
  lastLoginAt: row.last_login_at,
  lastName: row.last_name,
  role: row.role,
  status: row.status,
  updatedAt: row.updated_at,
});
const safeAuditDetailKeys = new Set([
  "action",
  "targetAdminId",
  "previousRole",
  "newRole",
  "capability",
  "resultCount",
  "filtered",
  "found",
]);
const mapAuditEntry = (row: {
  id: string;
  timestamp_utc: Date;
  event_type: string;
  actor: { id?: unknown };
  entity: { id?: unknown; type?: unknown };
  outcome: AdminAuditEntry["outcome"];
  reason_code: string;
  metadata: Record<string, unknown>;
}): AdminAuditEntry => {
  const safeDetails: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(row.metadata))
    if (
      safeAuditDetailKeys.has(key) &&
      (typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean")
    )
      safeDetails[key] = value;
  return {
    actorId: typeof row.actor.id === "string" ? row.actor.id : "unknown",
    entityId: typeof row.entity.id === "string" ? row.entity.id : "unknown",
    entityType:
      typeof row.entity.type === "string" ? row.entity.type : "unknown",
    eventType: row.event_type,
    id: row.id,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    safeDetails,
    timestampUtc: row.timestamp_utc,
  };
};
const lockOwnerLifecycle = async (client: Queryable): Promise<void> => {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('keycore-admin-owner-lifecycle'))`,
  );
};
const activeOwnerCount = async (client: Queryable): Promise<number> => {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM admin_role_assignments assignment JOIN admin_identities identity ON identity.id = assignment.admin_id WHERE assignment.role = 'PROJECT_OWNER' AND assignment.revoked_at IS NULL AND identity.status = 'ACTIVE'`,
  );
  return Number(result.rows[0]?.count ?? "0");
};
const revokeSessions = async (
  client: Queryable,
  adminId: string,
  at: Date,
): Promise<void> => {
  await client.query(
    `UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE admin_id = $1 AND revoked_at IS NULL`,
    [adminId, at],
  );
};
const appendAdminAudit = async (
  client: Queryable,
  context: AdminMutationContext,
  targetAdminId: string,
  reasonCode: string,
  metadata: Record<string, string>,
  outcome: "SUCCEEDED" | "DENIED" = "SUCCEEDED",
): Promise<void> => {
  await client.query(
    `INSERT INTO audit_events(id, event_type, timestamp_utc, actor, correlation_id, entity, environment, outcome, reason_code, metadata) VALUES (gen_random_uuid(), 'ADMIN_ACTION', $1, $2::jsonb, $3, $4::jsonb, $5, $6, $7, $8::jsonb)`,
    [
      context.at,
      JSON.stringify({ id: context.actorId, type: "ADMIN" }),
      context.correlationId,
      JSON.stringify({ id: targetAdminId, type: "ADMIN_IDENTITY" }),
      context.environment,
      outcome,
      reasonCode,
      JSON.stringify({ action: reasonCode, ...metadata }),
    ],
  );
};
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "23505";

export class PostgresAdminOrderReadRepository implements AdminOrderReadRepository {
  public constructor(private readonly database: Queryable) {}

  public async dashboard(): Promise<AdminDashboard> {
    const [counts, revenue, recent, topProducts] = await Promise.all([
      this.database.query<{
        readonly total_orders: string;
        readonly attention_orders: string;
        readonly processing_orders: string;
        readonly failed_orders: string;
      }>(`
        SELECT
          count(*)::text AS total_orders,
          count(*) FILTER (WHERE status = 'MANUAL_REVIEW' OR risk_status = 'REVIEW_REQUIRED')::text AS attention_orders,
          count(*) FILTER (WHERE status IN ('PAYMENT_CAPTURED', 'PROCUREMENT_PENDING', 'PROCUREMENT_IN_PROGRESS', 'FULFILLMENT_PENDING'))::text AS processing_orders,
          count(*) FILTER (WHERE status = 'FAILED')::text AS failed_orders
        FROM keycore_orders
      `),
      this.database.query<{
        readonly currency: string;
        readonly amount_minor: string;
      }>(
        `
        SELECT currency, COALESCE(sum(customer_amount_minor), 0)::text AS amount_minor
        FROM keycore_orders
        WHERE payment_status = ANY($1::text[])
        GROUP BY currency
        ORDER BY currency ASC
      `,
        [adminCapturedPaymentVolumeStates],
      ),
      this.database.query<OrderSummaryRow>(
        `${summarySelect} ORDER BY orders.created_at DESC, orders.id DESC LIMIT 10`,
      ),
      this.database.query<{
        readonly product_id: string;
        readonly product_title: string;
        readonly purchased_quantity: string;
      }>(
        `
        SELECT
          product.id::text AS product_id,
          product.title AS product_title,
          sum(orders.quantity)::text AS purchased_quantity
        FROM keycore_orders orders
        JOIN products product ON product.id = orders.product_id
        WHERE orders.payment_status = ANY($1::text[])
          AND orders.created_at >= current_timestamp - interval '30 days'
        GROUP BY product.id, product.title
        ORDER BY sum(orders.quantity) DESC, product.title ASC, product.id ASC
        LIMIT 3
      `,
        [adminCapturedPaymentVolumeStates],
      ),
    ]);
    const row = required(counts.rows[0]);
    return {
      attentionOrders: Number(row.attention_orders),
      failedOrders: Number(row.failed_orders),
      processingOrders: Number(row.processing_orders),
      recentOrders: recent.rows.map(mapOrderSummary),
      revenueByCurrency: revenue.rows.map((item) => ({
        amountMinor: item.amount_minor,
        currency: item.currency,
      })),
      topProducts: topProducts.rows.map((item) => ({
        productId: item.product_id,
        productTitle: item.product_title,
        purchasedQuantity: Number(item.purchased_quantity),
      })),
      totalOrders: Number(row.total_orders),
    };
  }

  public async list(input: {
    readonly filters: AdminOrderFilters;
    readonly limit: number;
    readonly cursor?: { readonly createdAt: Date; readonly orderId: OrderId };
    readonly cursorDirection: "NEXT" | "PREVIOUS";
    readonly sort: "NEWEST" | "OLDEST";
  }): Promise<AdminOrderPage> {
    const base = orderFilterSql(input.filters, false);
    const filtered = orderFilterSql(input.filters, true);
    const listValues = [...filtered.values];
    const predicates = [...filtered.predicates];
    const parameter = (value: unknown): string => {
      listValues.push(value);
      return `$${listValues.length}`;
    };
    const baseAscending = input.sort === "OLDEST";
    const queryAscending =
      input.cursorDirection === "PREVIOUS" ? !baseAscending : baseAscending;
    if (input.cursor) {
      const nextComparator = baseAscending ? ">" : "<";
      const comparator =
        input.cursorDirection === "PREVIOUS"
          ? nextComparator === ">"
            ? "<"
            : ">"
          : nextComparator;
      predicates.push(
        `(orders.created_at, orders.id) ${comparator} (${parameter(input.cursor.createdAt)}, ${parameter(input.cursor.orderId)}::uuid)`,
      );
    }
    const where =
      predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
    const orderDirection = queryAscending ? "ASC" : "DESC";
    const [result, total, metrics] = await Promise.all([
      this.database.query<OrderSummaryRow>(
        `${summarySelect} ${where} ORDER BY orders.created_at ${orderDirection}, orders.id ${orderDirection} LIMIT ${parameter(input.limit + 1)}`,
        listValues,
      ),
      this.database.query<{ readonly total_count: string }>(
        `SELECT count(*)::text AS total_count FROM keycore_orders orders LEFT JOIN keycore_customers customer ON customer.id = orders.customer_id JOIN products product ON product.id = orders.product_id ${filtered.where}`,
        filtered.values,
      ),
      this.database.query<{
        readonly total_orders: string;
        readonly attention_orders: string;
        readonly processing_orders: string;
        readonly failed_orders: string;
      }>(
        `
          SELECT
            count(*)::text AS total_orders,
            count(*) FILTER (WHERE orders.status = 'MANUAL_REVIEW' OR orders.risk_status = 'REVIEW_REQUIRED')::text AS attention_orders,
            count(*) FILTER (WHERE orders.status IN ('PAYMENT_CAPTURED', 'PROCUREMENT_PENDING', 'PROCUREMENT_IN_PROGRESS', 'FULFILLMENT_PENDING'))::text AS processing_orders,
            count(*) FILTER (WHERE orders.status = 'FAILED')::text AS failed_orders
          FROM keycore_orders orders
          LEFT JOIN keycore_customers customer ON customer.id = orders.customer_id
          JOIN products product ON product.id = orders.product_id
          ${base.where}
        `,
        base.values,
      ),
    ]);
    const hasNext = result.rows.length > input.limit;
    const selected = result.rows.slice(0, input.limit);
    const rows =
      input.cursorDirection === "PREVIOUS" ? selected.reverse() : selected;
    const first = rows[0];
    const last = rows.at(-1);
    const hasPreviousPage =
      input.cursorDirection === "NEXT" ? Boolean(input.cursor) : hasNext;
    const hasNextPage =
      input.cursorDirection === "PREVIOUS" ? Boolean(input.cursor) : hasNext;
    const metricRow = required(metrics.rows[0]);
    return {
      metrics: {
        attentionOrders: Number(metricRow.attention_orders),
        failedOrders: Number(metricRow.failed_orders),
        processingOrders: Number(metricRow.processing_orders),
        totalOrders: Number(metricRow.total_orders),
      },
      orders: rows.map(mapOrderSummary),
      totalCount: Number(required(total.rows[0]).total_count),
      ...(hasNextPage && last
        ? {
            nextCursor: {
              createdAt: last.created_at,
              orderId: orderId(last.id),
            },
          }
        : {}),
      ...(hasPreviousPage && first
        ? {
            previousCursor: {
              createdAt: first.created_at,
              orderId: orderId(first.id),
            },
          }
        : {}),
    };
  }

  public async findDetail(
    targetOrderId: OrderId,
  ): Promise<AdminOrderDetail | null> {
    const result = await this.database.query<
      OrderSummaryRow & {
        readonly customer_id: string | null;
        readonly correlation_id: string;
        readonly guest_claim_status: AdminOrderDetail["guestClaimStatus"];
        readonly supplier_id: string | null;
        readonly external_supplier_order_id: string | null;
        readonly fulfillment_operation_status: string | null;
        readonly retrieval_state: string | null;
        readonly delivery_state: string | null;
        readonly encrypted_secret_available: boolean;
      }
    >(
      `
        SELECT
          orders.id::text,
          orders.operator_reference,
          EXISTS (
            SELECT 1
            FROM customer_key_delivery_attempts customer_delivery
            WHERE customer_delivery.order_id = orders.id
              AND customer_delivery.status = 'DELIVERED'
          ) AS customer_access_confirmed,
          COALESCE(customer.email_normalized, orders.checkout_email_normalized) AS customer_email,
          product.title AS product_title,
          product.platform AS product_platform,
          orders.quantity,
          orders.customer_amount_minor::text,
          orders.currency,
          orders.status,
          orders.payment_status,
          orders.procurement_status,
          orders.fulfillment_status,
          orders.risk_status,
          orders.created_at,
          orders.updated_at,
          orders.customer_id::text,
          orders.correlation_id,
          CASE
            WHEN claim.id IS NULL THEN 'NOT_AVAILABLE'
            WHEN claim.consumed_at IS NOT NULL THEN 'CLAIMED'
            WHEN claim.revoked_at IS NOT NULL THEN 'REVOKED'
            WHEN claim.expires_at <= now() THEN 'EXPIRED'
            ELSE 'ACTIVE'
          END AS guest_claim_status,
          fulfillment.supplier_id,
          fulfillment.external_supplier_order_id,
          fulfillment.status AS fulfillment_operation_status,
          fulfillment.retrieval_state,
          fulfillment.delivery_state,
          (fulfillment.encrypted_secret_id IS NOT NULL) AS encrypted_secret_available
        FROM keycore_orders orders
        JOIN products product ON product.id = orders.product_id
        LEFT JOIN keycore_customers customer ON customer.id = orders.customer_id
        ${detailJoins}
        WHERE orders.id = $1
      `,
      [targetOrderId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const history = await this.database.query<{
      readonly from_status: string | null;
      readonly to_status: string;
      readonly reason_code: string;
      readonly actor_type: string;
      readonly occurred_at: Date;
    }>(
      `
        SELECT from_status, to_status, reason_code, actor_type, occurred_at
        FROM order_transition_history
        WHERE order_id = $1
        ORDER BY occurred_at ASC, id ASC
      `,
      [targetOrderId],
    );
    return {
      ...mapOrderSummary(row),
      correlationId: row.correlation_id,
      customerId: row.customer_id,
      deliveryState: row.delivery_state,
      encryptedSecretAvailable: row.encrypted_secret_available,
      externalSupplierOrderId: row.external_supplier_order_id,
      fulfillmentOperationStatus: row.fulfillment_operation_status,
      guestClaimStatus: row.guest_claim_status,
      history: history.rows.map((item) => ({
        actorType: item.actor_type,
        fromStatus: item.from_status,
        occurredAt: item.occurred_at,
        reasonCode: item.reason_code,
        toStatus: item.to_status,
      })),
      invoiceStatus: "NOT_AVAILABLE",
      retrievalState: row.retrieval_state,
      supplierId: row.supplier_id,
    };
  }
}

const summarySelect = `
  SELECT
    orders.id::text,
    orders.operator_reference,
    EXISTS (
      SELECT 1
      FROM customer_key_delivery_attempts customer_delivery
      WHERE customer_delivery.order_id = orders.id
        AND customer_delivery.status = 'DELIVERED'
    ) AS customer_access_confirmed,
    COALESCE(customer.email_normalized, orders.checkout_email_normalized) AS customer_email,
    product.title AS product_title,
    product.platform AS product_platform,
    orders.quantity,
    orders.customer_amount_minor::text,
    orders.currency,
    orders.status,
    orders.payment_status,
    orders.procurement_status,
    orders.fulfillment_status,
    orders.risk_status,
    orders.created_at,
    orders.updated_at
  FROM keycore_orders orders
  JOIN products product ON product.id = orders.product_id
  LEFT JOIN keycore_customers customer ON customer.id = orders.customer_id
`;

const detailJoins = `
  LEFT JOIN LATERAL (
    SELECT
      operation.id,
      operation.supplier_id,
      operation.external_supplier_order_id,
      operation.status,
      operation.retrieval_state,
      operation.delivery_state,
      operation.encrypted_secret_id,
      operation.created_at
    FROM fulfillment_operations operation
    WHERE operation.order_id = orders.id
    ORDER BY operation.created_at DESC, operation.id DESC
    LIMIT 1
  ) fulfillment ON true
  LEFT JOIN LATERAL (
    SELECT
      challenge.id,
      challenge.expires_at,
      challenge.consumed_at,
      challenge.revoked_at,
      challenge.created_at
    FROM guest_order_claim_challenges challenge
    WHERE challenge.order_id = orders.id
    ORDER BY challenge.created_at DESC, challenge.id DESC
    LIMIT 1
  ) claim ON true
`;

const orderFilterSql = (
  filters: AdminOrderFilters,
  includeOperationalView: boolean,
): {
  readonly predicates: readonly string[];
  readonly values: readonly unknown[];
  readonly where: string;
} => {
  const values: unknown[] = [];
  const predicates: string[] = [];
  const parameter = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  if (filters.exactOrderId)
    predicates.push(`orders.id = ${parameter(filters.exactOrderId)}::uuid`);
  if (filters.exactOperatorReference)
    predicates.push(
      `orders.operator_reference = ${parameter(filters.exactOperatorReference)}`,
    );
  if (filters.exactCustomerId)
    predicates.push(
      `orders.customer_id = ${parameter(filters.exactCustomerId)}::uuid`,
    );
  if (filters.exactCustomerEmail)
    predicates.push(
      `COALESCE(customer.email_normalized, orders.checkout_email_normalized) = ${parameter(filters.exactCustomerEmail)}`,
    );
  if (filters.status)
    predicates.push(`orders.status = ${parameter(filters.status)}`);
  if (filters.paymentStatus)
    predicates.push(
      `orders.payment_status = ${parameter(filters.paymentStatus)}`,
    );
  if (filters.riskStatus)
    predicates.push(`orders.risk_status = ${parameter(filters.riskStatus)}`);
  if (filters.procurementStatus)
    predicates.push(
      `orders.procurement_status = ${parameter(filters.procurementStatus)}`,
    );
  if (filters.fulfillmentStatus)
    predicates.push(
      `orders.fulfillment_status = ${parameter(filters.fulfillmentStatus)}`,
    );
  if (filters.fromDate)
    predicates.push(
      `orders.created_at >= ${parameter(`${filters.fromDate}T00:00:00.000Z`)}::timestamptz`,
    );
  if (filters.toDate)
    predicates.push(
      `orders.created_at < (${parameter(`${filters.toDate}T00:00:00.000Z`)}::timestamptz + interval '1 day')`,
    );
  if (includeOperationalView && filters.operationalView === "ATTENTION")
    predicates.push(
      "(orders.status = 'MANUAL_REVIEW' OR orders.risk_status = 'REVIEW_REQUIRED')",
    );
  if (includeOperationalView && filters.operationalView === "PROCESSING")
    predicates.push(
      "orders.status IN ('PAYMENT_CAPTURED', 'PROCUREMENT_PENDING', 'PROCUREMENT_IN_PROGRESS', 'FULFILLMENT_PENDING')",
    );
  if (includeOperationalView && filters.operationalView === "FAILED")
    predicates.push("orders.status = 'FAILED'");
  return {
    predicates,
    values,
    where: predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "",
  };
};

const mapOrderSummary = (row: OrderSummaryRow) => ({
  amountMinor: row.customer_amount_minor,
  createdAt: row.created_at,
  currency: row.currency,
  customerAccessConfirmed: row.customer_access_confirmed,
  customerEmail: row.customer_email,
  fulfillmentStatus: row.fulfillment_status,
  orderId: orderId(row.id),
  operatorReference: row.operator_reference,
  paymentStatus: row.payment_status,
  procurementStatus: row.procurement_status,
  productTitle: row.product_title,
  productPlatform: row.product_platform,
  quantity: row.quantity,
  riskStatus: row.risk_status,
  status: row.status,
  updatedAt: row.updated_at,
});

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Expected PostgreSQL row");
  return value;
};
