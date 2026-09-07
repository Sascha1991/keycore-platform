import { randomUUID } from "node:crypto";

import type { TransactionalQueryable } from "../infra/postgres/client.js";
import {
  hashAdminSession,
  sensitiveAdminCapabilities,
  type AdminCapability,
  type AdminRole,
} from "../packages/platform/src/contracts.js";

const approvedAdminStagingOrigins = new Set([
  "https://admin.staging.keyrano.de",
  "https://admin.staging.example.invalid",
]);
const allowedUatRoles = new Set<AdminRole>(["SUPPORT", "FINANCE"]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const opaqueSessionPattern = /^[A-Za-z0-9._~-]+$/u;

export interface StagingAdminUatEnvironment {
  readonly deploymentId?: string | undefined;
  readonly enabled?: string | undefined;
  readonly environment?: string | undefined;
  readonly origin?: string | undefined;
}

export interface StagingAdminUatSessionResult {
  readonly adminId: string;
  readonly expiresAt: Date;
  readonly role: "FINANCE" | "SUPPORT";
  readonly status: "READY";
}

export const assertStagingAdminUatEnvironment = (
  input: StagingAdminUatEnvironment,
): void => {
  if (input.environment !== "STAGING")
    throw new Error("STAGING_ADMIN_UAT_ENVIRONMENT_REQUIRED");
  if (input.enabled !== "true")
    throw new Error("STAGING_ADMIN_UAT_EXPLICIT_ENABLE_REQUIRED");
  if (
    !input.deploymentId ||
    !/^staging-[a-z0-9][a-z0-9-]{2,62}$/u.test(input.deploymentId)
  ) {
    throw new Error("STAGING_ADMIN_UAT_DEPLOYMENT_REQUIRED");
  }
  if (!isApprovedAdminStagingOrigin(input.origin))
    throw new Error("STAGING_ADMIN_UAT_ORIGIN_REQUIRED");
};

export const issueStagingAdminUatSession = async (
  database: TransactionalQueryable,
  input: {
    readonly adminId: string;
    readonly environment: StagingAdminUatEnvironment;
    readonly hashSecret: string;
    readonly now?: Date;
    readonly rawSession: string;
  },
): Promise<StagingAdminUatSessionResult> => {
  assertStagingAdminUatEnvironment(input.environment);
  if (!uuidPattern.test(input.adminId))
    throw new Error("STAGING_ADMIN_UAT_IDENTITY_INVALID");
  if (
    input.rawSession.length < 32 ||
    input.rawSession.length > 512 ||
    !opaqueSessionPattern.test(input.rawSession)
  ) {
    throw new Error("STAGING_ADMIN_UAT_SESSION_INVALID");
  }
  if (Buffer.byteLength(input.hashSecret, "utf8") < 32)
    throw new Error("STAGING_ADMIN_UAT_HASH_SECRET_INVALID");

  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
  const sessionHash = hashAdminSession(input.rawSession, input.hashSecret);

  return database.transaction(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('keycore-admin-owner-lifecycle'))`,
    );
    const identity = await client.query<{
      readonly provider: string;
      readonly provider_subject: string;
      readonly role: AdminRole | null;
      readonly status: string;
    }>(
      `SELECT identity.provider, identity.provider_subject, identity.status, assignment.role
       FROM admin_identities identity
       LEFT JOIN admin_role_assignments assignment
         ON assignment.admin_id = identity.id AND assignment.revoked_at IS NULL
       WHERE identity.id = $1
       FOR UPDATE OF identity`,
      [input.adminId],
    );
    const target = identity.rows.length === 1 ? identity.rows[0] : undefined;
    if (
      !target ||
      target.provider !== "STAGING_SYNTHETIC" ||
      target.provider_subject !== `managed-profile:${input.adminId}`
    ) {
      throw new Error("STAGING_ADMIN_UAT_IDENTITY_NOT_ELIGIBLE");
    }
    if (target.status !== "ACTIVE")
      throw new Error("STAGING_ADMIN_UAT_IDENTITY_NOT_ACTIVE");
    if (!target.role || !allowedUatRoles.has(target.role))
      throw new Error("STAGING_ADMIN_UAT_ROLE_NOT_ALLOWED");

    const grants = await client.query<{
      readonly capability: AdminCapability;
    }>(
      `SELECT capability
       FROM admin_permission_grants
       WHERE admin_id = $1 AND revoked_at IS NULL
       ORDER BY capability
       FOR UPDATE`,
      [input.adminId],
    );
    const sensitive = grants.rows.some(({ capability }) =>
      (sensitiveAdminCapabilities as readonly AdminCapability[]).includes(
        capability,
      ),
    );
    if (sensitive) throw new Error("STAGING_ADMIN_UAT_CAPABILITY_NOT_ALLOWED");

    try {
      await client.query(
        `INSERT INTO admin_sessions(
           id, admin_id, session_hash, assurance, issued_at, expires_at
         ) VALUES ($1, $2, $3, 'STAGING_SYNTHETIC', $4, $5)`,
        [randomUUID(), input.adminId, sessionHash, now, expiresAt],
      );
    } catch (error) {
      if (isUniqueViolation(error))
        throw new Error("STAGING_ADMIN_UAT_SESSION_CONFLICT");
      throw error;
    }

    return {
      adminId: input.adminId,
      expiresAt,
      role: target.role as "FINANCE" | "SUPPORT",
      status: "READY",
    };
  });
};

export const serializeStagingAdminUatSessionResult = (
  result: StagingAdminUatSessionResult,
): string =>
  JSON.stringify({
    adminId: result.adminId,
    expiresAt: result.expiresAt.toISOString(),
    role: result.role,
    status: result.status,
  });

const isApprovedAdminStagingOrigin = (raw: string | undefined): boolean => {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return (
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      approvedAdminStagingOrigins.has(url.origin.toLowerCase())
    );
  } catch {
    return false;
  }
};

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "23505";
