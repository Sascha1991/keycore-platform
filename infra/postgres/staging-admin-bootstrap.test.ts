import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashAdminSession } from "../../packages/platform/src/contracts.js";
import {
  bootstrapStagingAdmin,
  parseStagingAdminRole,
  stagingAdminId,
} from "../../scripts/staging-admin-bootstrap-service.js";
import { PostgresAdminSessionRepository } from "./admin-repositories.js";
import { PostgresTestDatabase } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const hashSecret =
  "staging-admin-bootstrap-test-hash-material-longer-than-thirty-two-bytes";
const ownerSession = "staging-owner-session-1234567890abcdef";
const supportSession = "staging-support-session-1234567890abcdef";
const financeSession = "staging-finance-session-1234567890abcdef";
const restoredOwnerSession = "staging-restored-owner-session-1234567890abcdef";

describePostgres("staging Admin role bootstrap persistence", () => {
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
