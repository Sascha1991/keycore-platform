import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AdminAuthenticationService,
  AdminPasswordAuthenticationService,
  AdminPasswordResetService,
  correlationId,
  hashAdminPassword,
  type AdminPasswordResetDeliveryPort,
} from "../../packages/platform/src/contracts.js";
import {
  bootstrapStagingAdmin,
  stagingAdminId,
} from "../../scripts/staging-admin-bootstrap-service.js";
import {
  PostgresAdminPasswordCredentialRepository,
  PostgresAdminPasswordResetRepository,
  PostgresAdminSessionRepository,
} from "./admin-repositories.js";
import { PostgresAuditEventRepository } from "./repositories.js";
import { PostgresTestDatabase } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const hashSecret =
  "admin-reset-test-session-secret-longer-than-thirty-two-bytes";
const bootstrapSession = "admin-reset-bootstrap-session-1234567890abcdef";
const email = "admin@example.test";
const oldPassword = ["original", "admin", "password"].join("-");
const newPassword = ["replacement", "admin", "password"].join("-");

describePostgres("Admin password reset persistence", () => {
  it("delivers one current token, changes the scrypt credential, and revokes only target sessions", async () => {
    const database = await PostgresTestDatabase.initialize({
      connectionString,
      schemaName: `admin_password_reset_${randomUUID().replaceAll("-", "_")}`,
    });
    let now = new Date("2026-09-12T10:00:00.000Z");
    const delivery = new CapturingDelivery();
    const audit = new PostgresAuditEventRepository(database);
    const credentials = new PostgresAdminPasswordCredentialRepository(database);
    const reset = new AdminPasswordResetService(
      new PostgresAdminPasswordResetRepository(database),
      delivery,
      audit,
      "STAGING",
      () => now,
    );
    const login = new AdminPasswordAuthenticationService(
      credentials,
      audit,
      hashSecret,
      "STAGING",
      () => now,
    );

    try {
      await bootstrapStagingAdmin(database, {
        credential: {
          emailNormalized: email,
          passwordHash: await hashAdminPassword(oldPassword),
        },
        hashSecret,
        now,
        rawSession: bootstrapSession,
        role: "PROJECT_OWNER",
      });
      const oldLogin = await login.login(
        email,
        oldPassword,
        correlationId("reset-old-session"),
      );
      expect(oldLogin.authenticated).toBe(true);

      now = new Date("2026-09-12T10:05:00.000Z");
      await expect(
        reset.request(email, correlationId("reset-first-request")),
      ).resolves.toEqual({ accepted: true });
      expect(delivery.messages).toHaveLength(1);
      const firstToken = delivery.messages[0]?.rawToken ?? "";
      expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);

      now = new Date("2026-09-12T10:06:00.000Z");
      await reset.request(email, correlationId("reset-throttled-request"));
      await reset.request(
        "unknown@example.test",
        correlationId("reset-unknown-request"),
      );
      expect(delivery.messages).toHaveLength(1);

      now = new Date("2026-09-12T10:11:00.000Z");
      await reset.request(email, correlationId("reset-replacement-request"));
      expect(delivery.messages).toHaveLength(2);
      const currentToken = delivery.messages[1]?.rawToken ?? "";
      await expect(
        reset.reset(
          firstToken,
          newPassword,
          newPassword,
          correlationId("reset-superseded-token"),
        ),
      ).resolves.toEqual({ status: "INVALID_OR_EXPIRED" });
      await expect(
        reset.reset(
          currentToken,
          newPassword,
          oldPassword,
          correlationId("reset-password-mismatch"),
        ),
      ).resolves.toEqual({ status: "PASSWORD_MISMATCH" });
      await expect(
        reset.reset(
          currentToken,
          "too-short",
          "too-short",
          correlationId("reset-password-short"),
        ),
      ).resolves.toEqual({ status: "PASSWORD_INVALID" });

      now = new Date("2026-09-12T10:12:00.000Z");
      await expect(
        reset.reset(
          currentToken,
          newPassword,
          newPassword,
          correlationId("reset-password-completed"),
        ),
      ).resolves.toEqual({ status: "COMPLETED" });
      await expect(
        reset.reset(
          currentToken,
          newPassword,
          newPassword,
          correlationId("reset-token-replay"),
        ),
      ).resolves.toEqual({ status: "INVALID_OR_EXPIRED" });

      await expect(
        login.login(email, oldPassword, correlationId("reset-old-password")),
      ).resolves.toEqual({ authenticated: false });
      await expect(
        login.login(email, newPassword, correlationId("reset-new-password")),
      ).resolves.toMatchObject({ authenticated: true });
      const authentication = new AdminAuthenticationService(
        new PostgresAdminSessionRepository(database),
        audit,
        hashSecret,
        "STAGING",
        () => now,
      );
      await expect(
        authentication.authenticate(
          oldLogin.rawSession ?? "",
          correlationId("reset-revoked-old-session"),
        ),
      ).resolves.toEqual({
        authenticated: false,
        reasonCode: "ADMIN_SESSION_UNAVAILABLE",
      });

      now = new Date("2026-09-12T10:13:00.000Z");
      await bootstrapStagingAdmin(database, {
        credential: {
          emailNormalized: email,
          passwordHash: await hashAdminPassword(oldPassword),
        },
        hashSecret,
        now,
        rawSession: bootstrapSession,
        role: "PROJECT_OWNER",
      });
      await expect(
        login.login(
          email,
          newPassword,
          correlationId("reset-password-after-normal-bootstrap"),
        ),
      ).resolves.toMatchObject({ authenticated: true });
      await expect(
        login.login(
          email,
          oldPassword,
          correlationId("reset-old-password-after-normal-bootstrap"),
        ),
      ).resolves.toEqual({ authenticated: false });

      const lifecycle = await database.query<{
        readonly consumed: string;
        readonly invalidated: string;
      }>(
        `SELECT
           count(*) FILTER (WHERE consumed_at IS NOT NULL)::text AS consumed,
           count(*) FILTER (WHERE invalidated_at IS NOT NULL)::text AS invalidated
         FROM admin_password_reset_requests
         WHERE admin_id = $1`,
        [stagingAdminId],
      );
      expect(lifecycle.rows[0]).toEqual({ consumed: "1", invalidated: "1" });
      const persisted = await database.query<{ readonly payload: string }>(
        `SELECT concat_ws(' ', string_agg(token_hash, ' '),
           (SELECT string_agg(metadata::text, ' ') FROM audit_events)) AS payload
         FROM admin_password_reset_requests`,
      );
      expect(persisted.rows[0]?.payload).not.toContain(firstToken);
      expect(persisted.rows[0]?.payload).not.toContain(currentToken);
      expect(persisted.rows[0]?.payload).not.toContain(oldPassword);
      expect(persisted.rows[0]?.payload).not.toContain(newPassword);

      now = new Date("2026-09-12T10:20:00.000Z");
      await reset.request(email, correlationId("reset-expiring-request"));
      const expiringToken = delivery.messages[2]?.rawToken ?? "";
      now = new Date("2026-09-12T11:06:00.000Z");
      await expect(
        reset.reset(
          expiringToken,
          oldPassword,
          oldPassword,
          correlationId("reset-expired-token"),
        ),
      ).resolves.toEqual({ status: "INVALID_OR_EXPIRED" });

      await database.query(
        `UPDATE admin_identities SET status = 'DISABLED' WHERE id = $1`,
        [stagingAdminId],
      );
      now = new Date("2026-09-12T11:12:00.000Z");
      await reset.request(email, correlationId("reset-disabled-request"));
      expect(delivery.messages).toHaveLength(3);
    } finally {
      await database.cleanup();
    }
  }, 40_000);
});

class CapturingDelivery implements AdminPasswordResetDeliveryPort {
  public readonly messages: {
    readonly emailNormalized: string;
    readonly expiresAt: Date;
    readonly rawToken: string;
  }[] = [];

  public async sendPasswordReset(
    input: (typeof this.messages)[number],
  ): Promise<{ readonly status: "ACCEPTED" }> {
    this.messages.push(input);
    return { status: "ACCEPTED" };
  }
}
