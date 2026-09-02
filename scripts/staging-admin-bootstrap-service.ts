import { randomUUID } from "node:crypto";

import type { TransactionalQueryable } from "../infra/postgres/client.js";
import {
  adminRoles,
  hashAdminSession,
  type AdminRole,
} from "../packages/platform/src/contracts.js";

export const stagingAdminId = "a1000000-0000-4000-8000-000000000001";

const displayNames: Readonly<Record<AdminRole, string>> = {
  FINANCE: "Staging Finance Admin",
  OPERATIONS: "Staging Operations Admin",
  PROJECT_OWNER: "Staging Project Owner",
  SECURITY_AUDITOR: "Staging Security Auditor",
  SUPPORT: "Staging Support Admin",
};

export const parseStagingAdminRole = (
  configuredRole: string | undefined,
): AdminRole => {
  if (configuredRole === undefined) return "PROJECT_OWNER";
  if (adminRoles.some((role) => role === configuredRole)) {
    return configuredRole as AdminRole;
  }
  throw new Error("STAGING_ADMIN_ROLE_INVALID");
};

export const bootstrapStagingAdmin = async (
  database: TransactionalQueryable,
  input: {
    readonly hashSecret: string;
    readonly rawSession: string;
    readonly role: AdminRole;
    readonly now?: Date;
  },
): Promise<{
  readonly adminId: string;
  readonly expiresAt: Date;
  readonly role: AdminRole;
}> => {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const sessionHash = hashAdminSession(input.rawSession, input.hashSecret);

  await database.transaction(async (client) => {
    await client.query(
      `
        INSERT INTO admin_identities(
          id, provider, provider_subject, display_name, status, created_at, updated_at
        )
        VALUES ($1, 'STAGING_SYNTHETIC', 'keyrano-staging-project-owner', $3, 'ACTIVE', $2, $2)
        ON CONFLICT (id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          status = 'ACTIVE',
          updated_at = EXCLUDED.updated_at
      `,
      [stagingAdminId, now, displayNames[input.role]],
    );
    await client.query(
      "SELECT id FROM admin_identities WHERE id = $1 FOR UPDATE",
      [stagingAdminId],
    );

    const activeAssignments = await client.query<{ readonly role: string }>(
      `SELECT role FROM admin_role_assignments WHERE admin_id = $1 AND revoked_at IS NULL ORDER BY role FOR UPDATE`,
      [stagingAdminId],
    );
    const activeRoles = activeAssignments.rows.map(({ role }) => {
      if (!adminRoles.some((knownRole) => knownRole === role)) {
        throw new Error("STAGING_ADMIN_ACTIVE_ROLE_INVALID");
      }
      return role as AdminRole;
    });
    const roleChanges =
      activeRoles.length > 0 &&
      (activeRoles.length !== 1 || activeRoles[0] !== input.role);

    const existingSession = await client.query<{
      readonly admin_id: string;
    }>(
      "SELECT admin_id::text FROM admin_sessions WHERE session_hash = $1 FOR UPDATE",
      [sessionHash],
    );
    const existingSessionAdminId = existingSession.rows[0]?.admin_id;
    if (
      existingSessionAdminId !== undefined &&
      existingSessionAdminId !== stagingAdminId
    ) {
      throw new Error("STAGING_ADMIN_SESSION_HASH_CONFLICT");
    }
    if (roleChanges && existingSessionAdminId === stagingAdminId) {
      throw new Error("STAGING_ADMIN_ROLE_SWITCH_REQUIRES_SESSION_ROTATION");
    }

    await client.query(
      `
        UPDATE admin_role_assignments
        SET revoked_at = $2
        WHERE admin_id = $1 AND revoked_at IS NULL AND role <> $3
      `,
      [stagingAdminId, now, input.role],
    );
    await client.query(
      `
        INSERT INTO admin_role_assignments(admin_id, role, granted_by, granted_at)
        SELECT $1, $3, 'staging-bootstrap', $2
        WHERE NOT EXISTS (
          SELECT 1 FROM admin_role_assignments
          WHERE admin_id = $1 AND role = $3 AND revoked_at IS NULL
        )
      `,
      [stagingAdminId, now, input.role],
    );
    await client.query(
      `
        UPDATE admin_sessions
        SET revoked_at = COALESCE(revoked_at, $2)
        WHERE admin_id = $1 AND revoked_at IS NULL
      `,
      [stagingAdminId, now],
    );
    const persistedSession = await client.query<{
      readonly admin_id: string;
    }>(
      `
        INSERT INTO admin_sessions(
          id, admin_id, session_hash, assurance, issued_at, expires_at
        )
        VALUES ($1, $2, $3, 'STAGING_SYNTHETIC', $4, $5)
        ON CONFLICT (session_hash) DO UPDATE SET
          assurance = EXCLUDED.assurance,
          issued_at = EXCLUDED.issued_at,
          expires_at = EXCLUDED.expires_at,
          revoked_at = NULL,
          last_seen_at = NULL
        WHERE admin_sessions.admin_id = EXCLUDED.admin_id
        RETURNING admin_id::text
      `,
      [randomUUID(), stagingAdminId, sessionHash, now, expiresAt],
    );
    if (persistedSession.rows[0]?.admin_id !== stagingAdminId) {
      throw new Error("STAGING_ADMIN_SESSION_HASH_CONFLICT");
    }
  });

  return { adminId: stagingAdminId, expiresAt, role: input.role };
};
