import { describe, expect, it } from "vitest";

import {
  AdminPasswordAuthenticationService,
  correlationId,
  hashAdminPassword,
  verifyAdminPassword,
  type AdminPasswordCredentialRepository,
  type AuditEvent,
  type AuditEventPort,
} from "../contracts.js";

const password = ["correct", "development", "password"].join("-");
const sessionSecret = [
  "admin",
  "password",
  "session",
  "material",
  "longer-than-thirty-two-bytes",
].join("-");
const adminId = "a1000000-0000-4000-8000-000000000001";

describe("Admin password authentication", () => {
  it("hashes passwords with scrypt and verifies without preserving plaintext", async () => {
    const hash = await hashAdminPassword(password);

    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/u);
    expect(hash).not.toContain(password);
    await expect(verifyAdminPassword(password, hash)).resolves.toBe(true);
    await expect(
      verifyAdminPassword(["wrong", "development", "password"].join("-"), hash),
    ).resolves.toBe(false);
  });

  it("issues an eight-hour opaque server session for a valid active identity", async () => {
    const fixture = await setup("ACTIVE");
    const result = await fixture.service.login(
      " Admin@Example.Test ",
      password,
      correlationId("password-login-success"),
    );

    expect(result.authenticated).toBe(true);
    expect(result.rawSession).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(fixture.issued).toHaveLength(1);
    expect(fixture.issued[0]).toMatchObject({ adminId });
    expect(fixture.issued[0]?.sessionHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(fixture.issued[0]?.sessionHash).not.toContain(password);
    expect(fixture.issued[0]?.expiresAt.toISOString()).toBe(
      "2026-09-11T18:00:00.000Z",
    );
  });

  it("denies wrong passwords, unknown emails and inactive identities generically", async () => {
    const active = await setup("ACTIVE");
    const disabled = await setup("DISABLED");

    for (const attempt of [
      active.service.login(
        "admin@example.test",
        ["wrong", "development", "password"].join("-"),
        correlationId("wrong-password"),
      ),
      active.service.login(
        "unknown@example.test",
        password,
        correlationId("unknown-email"),
      ),
      disabled.service.login(
        "admin@example.test",
        password,
        correlationId("disabled-admin"),
      ),
    ]) {
      await expect(attempt).resolves.toEqual({ authenticated: false });
    }
    expect(active.issued).toHaveLength(0);
    expect(disabled.issued).toHaveLength(0);
    expect([
      ...active.audit.events,
      ...disabled.audit.events,
    ]).not.toContainEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({ password }),
      }),
    );
  });
});

const setup = async (identityStatus: "ACTIVE" | "DISABLED") => {
  const passwordHash = await hashAdminPassword(password);
  const issued: Parameters<
    AdminPasswordCredentialRepository["issueSession"]
  >[0][] = [];
  const repository: AdminPasswordCredentialRepository = {
    findByEmail: async (email) =>
      email === "admin@example.test"
        ? { adminId, identityStatus, passwordHash }
        : null,
    issueSession: async (input) => void issued.push(input),
  };
  const audit = new MemoryAudit();
  return {
    audit,
    issued,
    service: new AdminPasswordAuthenticationService(
      repository,
      audit,
      sessionSecret,
      "STAGING",
      () => new Date("2026-09-11T10:00:00.000Z"),
    ),
  };
};

class MemoryAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];
  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}
