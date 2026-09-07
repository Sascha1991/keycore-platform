import { describe, expect, it } from "vitest";

import {
  assertStagingAdminUatEnvironment,
  issueStagingAdminUatSession,
  serializeStagingAdminUatSessionResult,
} from "../../scripts/staging-admin-uat-session-service.js";

const validEnvironment = {
  deploymentId: "staging-keyrano-uat",
  enabled: "true",
  environment: "STAGING",
  origin: "https://admin.staging.keyrano.de",
} as const;

describe("staging Admin staff-session guard", () => {
  it("accepts only an explicit approved staging context", () => {
    expect(() =>
      assertStagingAdminUatEnvironment(validEnvironment),
    ).not.toThrow();
    expect(() =>
      assertStagingAdminUatEnvironment({
        ...validEnvironment,
        origin: "https://admin.staging.example.invalid",
      }),
    ).not.toThrow();
  });

  it("is unavailable in production and without explicit staging opt-in", () => {
    expect(() =>
      assertStagingAdminUatEnvironment({
        ...validEnvironment,
        environment: "PRODUCTION",
      }),
    ).toThrowError("STAGING_ADMIN_UAT_ENVIRONMENT_REQUIRED");
    expect(() =>
      assertStagingAdminUatEnvironment({
        ...validEnvironment,
        enabled: "false",
      }),
    ).toThrowError("STAGING_ADMIN_UAT_EXPLICIT_ENABLE_REQUIRED");
    expect(() =>
      assertStagingAdminUatEnvironment({
        ...validEnvironment,
        deploymentId: "production-keyrano",
      }),
    ).toThrowError("STAGING_ADMIN_UAT_DEPLOYMENT_REQUIRED");
  });

  it("rejects production before opening a database transaction", async () => {
    let transactionCalled = false;
    const database = {
      query: async () => ({ rowCount: 0, rows: [] }),
      transaction: async () => {
        transactionCalled = true;
        throw new Error("DATABASE_MUST_NOT_BE_CALLED");
      },
    };
    await expect(
      issueStagingAdminUatSession(database as never, {
        adminId: "a1000000-0000-4000-8000-000000000002",
        environment: { ...validEnvironment, environment: "PRODUCTION" },
        hashSecret: "test-hash-secret-material-longer-than-thirty-two-bytes",
        rawSession: "test-runtime-session-value-longer-than-32-chars",
      }),
    ).rejects.toThrowError("STAGING_ADMIN_UAT_ENVIRONMENT_REQUIRED");
    expect(transactionCalled).toBe(false);
  });

  it("rejects production, arbitrary and credential-bearing origins", () => {
    for (const origin of [
      "https://admin.keyrano.de",
      "https://keyrano.de",
      "https://arbitrary.example.com",
      "https://user:password@admin.staging.keyrano.de",
      "http://admin.staging.keyrano.de",
    ]) {
      expect(() =>
        assertStagingAdminUatEnvironment({ ...validEnvironment, origin }),
      ).toThrowError("STAGING_ADMIN_UAT_ORIGIN_REQUIRED");
    }
  });

  it("serializes only safe issuance metadata", () => {
    const serialized = serializeStagingAdminUatSessionResult({
      adminId: "a1000000-0000-4000-8000-000000000002",
      expiresAt: new Date("2026-09-07T12:00:00.000Z"),
      role: "SUPPORT",
      status: "READY",
    });
    expect(JSON.parse(serialized)).toEqual({
      adminId: "a1000000-0000-4000-8000-000000000002",
      expiresAt: "2026-09-07T12:00:00.000Z",
      role: "SUPPORT",
      status: "READY",
    });
    expect(serialized).not.toMatch(/session|secret|product.?key/iu);
  });
});
