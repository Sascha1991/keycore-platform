import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AdminAuthenticationService,
  AdminPasswordAuthenticationService,
  correlationId,
  hashAdminPassword,
  hashAdminSession,
} from "../../packages/platform/src/contracts.js";
import {
  bootstrapStagingAdmin,
  parseStagingAdminRole,
  stagingAdminId,
} from "../../scripts/staging-admin-bootstrap-service.js";
import { issueStagingAdminUatSession } from "../../scripts/staging-admin-uat-session-service.js";
import {
  PostgresAdminSessionRepository,
  PostgresAdminPasswordCredentialRepository,
  PostgresAdminStaffRepository,
} from "./admin-repositories.js";
import { PostgresAuditEventRepository } from "./repositories.js";
import { PostgresTestDatabase } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const hashSecret =
  "staging-admin-bootstrap-test-hash-material-longer-than-thirty-two-bytes";
const ownerSession = "staging-owner-session-1234567890abcdef";
const supportSession = "staging-support-session-1234567890abcdef";
const financeSession = "staging-finance-session-1234567890abcdef";
const restoredOwnerSession = "staging-restored-owner-session-1234567890abcdef";
const uatStaffId = "a1000000-0000-4000-8000-000000000002";
const uatSupportSession = "staging-uat-support-session-1234567890abcdef";
const uatFinanceSession = "staging-uat-finance-session-1234567890abcdef";
const uatBlockedSession = "staging-uat-blocked-session-1234567890abcdef";
const uatEnvironment = {
  deploymentId: "staging-admin-uat-test",
  enabled: "true",
  environment: "STAGING",
  origin: "https://admin.staging.example.invalid",
} as const;

describePostgres("staging Admin role bootstrap persistence", () => {
  it("persists only a scrypt credential and issues a reusable normal Admin session", async () => {
    const database = await PostgresTestDatabase.initialize({
      connectionString,
      schemaName: `staging_admin_password_${randomUUID().replaceAll("-", "_")}`,
    });
    const password = ["local", "development", "admin", "password"].join("-");
    const now = new Date("2026-09-11T10:00:00.000Z");

    try {
      await bootstrapStagingAdmin(database, {
        credential: {
          emailNormalized: "admin@example.test",
          passwordHash: await hashAdminPassword(password),
        },
        hashSecret,
        now,
        rawSession: ownerSession,
        role: "PROJECT_OWNER",
      });
      const persisted = await database.query<{
        readonly email_normalized: string;
        readonly password_hash: string;
      }>(
        `SELECT identity.email_normalized, credential.password_hash
         FROM admin_identities identity
         JOIN admin_password_credentials credential ON credential.admin_id = identity.id
         WHERE identity.id = $1`,
        [stagingAdminId],
      );
      expect(persisted.rows[0]?.email_normalized).toBe("admin@example.test");
      expect(persisted.rows[0]?.password_hash).toMatch(/^scrypt\$/u);
      expect(persisted.rows[0]?.password_hash).not.toContain(password);

      const audit = new PostgresAuditEventRepository(database);
      const passwordAuthentication = new AdminPasswordAuthenticationService(
        new PostgresAdminPasswordCredentialRepository(database),
        audit,
        hashSecret,
        "STAGING",
        () => now,
      );
      const login = await passwordAuthentication.login(
        "admin@example.test",
        password,
        correlationId("postgres-password-login"),
      );
      expect(login.authenticated).toBe(true);
      const authentication = new AdminAuthenticationService(
        new PostgresAdminSessionRepository(database),
        audit,
        hashSecret,
        "STAGING",
        () => new Date("2026-09-11T10:01:00.000Z"),
      );
      await expect(
        authentication.authenticate(
          login.rawSession ?? "",
          correlationId("postgres-password-session"),
        ),
      ).resolves.toMatchObject({
        authenticated: true,
        principal: { roles: ["PROJECT_OWNER"] },
      });
    } finally {
      await database.cleanup();
    }
  }, 30_000);

  it("switches one synthetic identity without role accumulation or surviving old sessions", async () => {
    const database = await PostgresTestDatabase.initialize({
      connectionString,
      schemaName: `staging_admin_bootstrap_${randomUUID().replaceAll("-", "_")}`,
    });
    const sessions = new PostgresAdminSessionRepository(database);
    const at = (minutes: number): Date =>
      new Date(Date.UTC(2026, 8, 2, 10, minutes));

    try {
      await bootstrapStagingAdmin(database, {
        hashSecret,
        now: at(0),
        rawSession: ownerSession,
        role: parseStagingAdminRole(undefined),
      });
      await expectActiveState(database, ["PROJECT_OWNER"], 1);
      await expect(
        sessions.findByHash(hashAdminSession(ownerSession, hashSecret)),
      ).resolves.toMatchObject({
        adminId: stagingAdminId,
        revokedAt: null,
        roles: ["PROJECT_OWNER"],
      });

      await bootstrapStagingAdmin(database, {
        hashSecret,
        now: at(1),
        rawSession: ownerSession,
        role: "PROJECT_OWNER",
      });
      await expectActiveState(database, ["PROJECT_OWNER"], 1);

      await expect(
        bootstrapStagingAdmin(database, {
          hashSecret,
          now: at(2),
          rawSession: ownerSession,
          role: "SUPPORT",
        }),
      ).rejects.toThrowError(
        "STAGING_ADMIN_ROLE_SWITCH_REQUIRES_SESSION_ROTATION",
      );
      await expectActiveState(database, ["PROJECT_OWNER"], 1);

      await bootstrapStagingAdmin(database, {
        hashSecret,
        now: at(3),
        rawSession: supportSession,
        role: "SUPPORT",
      });
      await expectActiveState(database, ["SUPPORT"], 1);
      await expectSessionRevoked(database, ownerSession);
      await expect(
        sessions.findByHash(hashAdminSession(supportSession, hashSecret)),
      ).resolves.toMatchObject({ revokedAt: null, roles: ["SUPPORT"] });

      await bootstrapStagingAdmin(database, {
        hashSecret,
        now: at(4),
        rawSession: supportSession,
        role: "SUPPORT",
      });
      await expectActiveState(database, ["SUPPORT"], 1);

      await bootstrapStagingAdmin(database, {
        hashSecret,
        now: at(5),
        rawSession: financeSession,
        role: "FINANCE",
      });
      await expectActiveState(database, ["FINANCE"], 1);
      await expectSessionRevoked(database, supportSession);

      await bootstrapStagingAdmin(database, {
        hashSecret,
        now: at(6),
        rawSession: restoredOwnerSession,
        role: "PROJECT_OWNER",
      });
      await expectActiveState(database, ["PROJECT_OWNER"], 1);
      await expectSessionRevoked(database, financeSession);

      const assignmentHistory = await database.query<{
        readonly role: string;
        readonly revoked_at: Date | null;
      }>(
        `SELECT role, revoked_at FROM admin_role_assignments WHERE admin_id = $1 ORDER BY granted_at, role`,
        [stagingAdminId],
      );
      expect(assignmentHistory.rows).toHaveLength(4);
      expect(
        assignmentHistory.rows.filter(({ revoked_at }) => !revoked_at),
      ).toEqual([expect.objectContaining({ role: "PROJECT_OWNER" })]);
    } finally {
      await database.cleanup();
    }
  }, 30_000);

  it("issues a least-privilege managed-profile session that existing lifecycle mutations revoke", async () => {
    const database = await PostgresTestDatabase.initialize({
      connectionString,
      schemaName: `staging_admin_uat_${randomUUID().replaceAll("-", "_")}`,
    });
    const sessions = new PostgresAdminSessionRepository(database);
    const staff = new PostgresAdminStaffRepository(database);
    const audit = new PostgresAuditEventRepository(database);
    const authentication = new AdminAuthenticationService(
      sessions,
      audit,
      hashSecret,
      "STAGING",
      () => new Date("2026-09-07T11:30:00.000Z"),
    );

    try {
      await bootstrapStagingAdmin(database, {
        hashSecret,
        now: new Date("2026-09-07T10:30:00.000Z"),
        rawSession: ownerSession,
        role: "PROJECT_OWNER",
      });
      await createUatStaff(database);
      await database.query(
        `INSERT INTO admin_permission_grants(
           admin_id, capability, granted_at, granted_by_admin_id, reason
         ) VALUES ($1, 'AUDIT_VIEW', $2, $1, 'Synthetic UAT access')`,
        [uatStaffId, new Date("2026-09-07T11:00:00.000Z")],
      );

      const issued = await issueStagingAdminUatSession(database, {
        adminId: uatStaffId,
        environment: uatEnvironment,
        hashSecret,
        now: new Date("2026-09-07T11:00:00.000Z"),
        rawSession: uatSupportSession,
      });
      expect(issued).toMatchObject({
        adminId: uatStaffId,
        role: "SUPPORT",
        status: "READY",
      });
      await expect(
        sessions.findByHash(hashAdminSession(uatSupportSession, hashSecret)),
      ).resolves.toMatchObject({
        individualCapabilities: ["AUDIT_VIEW"],
        revokedAt: null,
        roles: ["SUPPORT"],
      });
      await expectOwnerSessionActive(sessions);

      await expect(
        authentication.authenticate(
          uatSupportSession,
          correlationId("uat-support-session-before-role-change"),
        ),
      ).resolves.toMatchObject({
        authenticated: true,
        principal: {
          individualCapabilities: ["AUDIT_VIEW"],
          roles: ["SUPPORT"],
        },
      });

      await expect(
        staff.changeRole(uatStaffId, "FINANCE", mutationContext(12)),
      ).resolves.toBe("UPDATED");
      await expect(
        authentication.authenticate(
          uatSupportSession,
          correlationId("uat-support-session-after-role-change"),
        ),
      ).resolves.toEqual({
        authenticated: false,
        reasonCode: "ADMIN_SESSION_UNAVAILABLE",
      });
      await expectOwnerSessionActive(sessions);

      await issueStagingAdminUatSession(database, {
        adminId: uatStaffId,
        environment: uatEnvironment,
        hashSecret,
        now: new Date("2026-09-07T12:05:00.000Z"),
        rawSession: uatFinanceSession,
      });
      await expect(
        staff.setStatus(uatStaffId, "DISABLED", mutationContext(13)),
      ).resolves.toBe("UPDATED");
      await expect(
        authentication.authenticate(
          uatFinanceSession,
          correlationId("uat-finance-session-after-disable"),
        ),
      ).resolves.toEqual({
        authenticated: false,
        reasonCode: "ADMIN_SESSION_UNAVAILABLE",
      });
      await expectOwnerSessionActive(sessions);

      await expect(
        staff.setStatus(uatStaffId, "ACTIVE", mutationContext(14)),
      ).resolves.toBe("UPDATED");
      await expect(
        authentication.authenticate(
          uatFinanceSession,
          correlationId("uat-finance-session-after-reactivation"),
        ),
      ).resolves.toEqual({
        authenticated: false,
        reasonCode: "ADMIN_SESSION_UNAVAILABLE",
      });
      await expectOwnerSessionActive(sessions);

      const leaked = await database.query<{ readonly payload: string }>(
        `SELECT concat_ws(' ', reason_code, metadata::text) AS payload
         FROM audit_events
         WHERE entity->>'id' = $1 OR actor->>'id' = $1`,
        [uatStaffId],
      );
      expect(leaked.rows.map(({ payload }) => payload).join(" ")).not.toContain(
        uatSupportSession,
      );
      expect(leaked.rows.map(({ payload }) => payload).join(" ")).not.toContain(
        uatFinanceSession,
      );
    } finally {
      await database.cleanup();
    }
  }, 30_000);

  it("rejects ineligible identities and active sensitive capabilities", async () => {
    const database = await PostgresTestDatabase.initialize({
      connectionString,
      schemaName: `staging_admin_uat_blocked_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await createUatStaff(database);
      await database.query(
        `UPDATE admin_identities SET status = 'DISABLED' WHERE id = $1`,
        [uatStaffId],
      );
      await expect(
        issueStagingAdminUatSession(database, {
          adminId: uatStaffId,
          environment: uatEnvironment,
          hashSecret,
          rawSession: uatBlockedSession,
        }),
      ).rejects.toThrowError("STAGING_ADMIN_UAT_IDENTITY_NOT_ACTIVE");
      await database.query(
        `UPDATE admin_identities SET status = 'ACTIVE' WHERE id = $1`,
        [uatStaffId],
      );
      await database.query(
        `INSERT INTO admin_permission_grants(
           admin_id, capability, granted_at, granted_by_admin_id, reason
         ) VALUES ($1, 'PRODUCT_KEY_REVEAL', $2, $1, 'Negative UAT fixture')`,
        [uatStaffId, new Date("2026-09-07T11:00:00.000Z")],
      );
      await expect(
        issueStagingAdminUatSession(database, {
          adminId: uatStaffId,
          environment: uatEnvironment,
          hashSecret,
          rawSession: uatBlockedSession,
        }),
      ).rejects.toThrowError("STAGING_ADMIN_UAT_CAPABILITY_NOT_ALLOWED");

      await database.query(
        `UPDATE admin_identities SET provider_subject = 'unmanaged-fixture' WHERE id = $1`,
        [uatStaffId],
      );
      await expect(
        issueStagingAdminUatSession(database, {
          adminId: uatStaffId,
          environment: uatEnvironment,
          hashSecret,
          rawSession: uatBlockedSession,
        }),
      ).rejects.toThrowError("STAGING_ADMIN_UAT_IDENTITY_NOT_ELIGIBLE");
    } finally {
      await database.cleanup();
    }
  }, 30_000);
});

const createUatStaff = async (
  database: PostgresTestDatabase,
): Promise<void> => {
  const at = new Date("2026-09-07T10:00:00.000Z");
  await database.query(
    `INSERT INTO admin_identities(
       id, provider, provider_subject, display_name, first_name, last_name,
       employee_number, status, created_at, updated_at
     ) VALUES ($1, 'STAGING_SYNTHETIC', $2, 'Synthetic UAT Staff', 'Synthetic',
       'Staff', 'UAT-STAFF-02', 'ACTIVE', $3, $3)`,
    [uatStaffId, `managed-profile:${uatStaffId}`, at],
  );
  await database.query(
    `INSERT INTO admin_role_assignments(admin_id, role, granted_by, granted_at)
     VALUES ($1, 'SUPPORT', 'staging-uat-fixture', $2)`,
    [uatStaffId, at],
  );
};

const mutationContext = (hour: number) => ({
  actorId: stagingAdminId,
  at: new Date(Date.UTC(2026, 8, 7, hour)),
  correlationId: correlationId(`staging-admin-uat-mutation-${hour}`),
  environment: "STAGING" as const,
});

const expectActiveState = async (
  database: PostgresTestDatabase,
  roles: readonly string[],
  activeSessionCount: number,
): Promise<void> => {
  const activeRoles = await database.query<{ readonly role: string }>(
    `SELECT role FROM admin_role_assignments WHERE admin_id = $1 AND revoked_at IS NULL ORDER BY role`,
    [stagingAdminId],
  );
  const activeSessions = await database.query<{ readonly count: string }>(
    `SELECT count(*)::text FROM admin_sessions WHERE admin_id = $1 AND revoked_at IS NULL`,
    [stagingAdminId],
  );
  expect(activeRoles.rows.map(({ role }) => role)).toEqual(roles);
  expect(Number(activeSessions.rows[0]?.count)).toBe(activeSessionCount);
};

const expectSessionRevoked = async (
  database: PostgresTestDatabase,
  rawSession: string,
): Promise<void> => {
  const result = await database.query<{ readonly revoked_at: Date | null }>(
    `SELECT revoked_at FROM admin_sessions WHERE session_hash = $1`,
    [hashAdminSession(rawSession, hashSecret)],
  );
  expect(result.rows[0]?.revoked_at).toBeInstanceOf(Date);
};

const expectOwnerSessionActive = async (
  sessions: PostgresAdminSessionRepository,
): Promise<void> => {
  await expect(
    sessions.findByHash(hashAdminSession(ownerSession, hashSecret)),
  ).resolves.toMatchObject({
    adminId: stagingAdminId,
    revokedAt: null,
    roles: ["PROJECT_OWNER"],
  });
};
