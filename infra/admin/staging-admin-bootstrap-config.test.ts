import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { adminRoles } from "../../packages/platform/src/contracts.js";
import { parseStagingAdminRole } from "../../scripts/staging-admin-bootstrap-service.js";

describe("staging Admin bootstrap role configuration", () => {
  it("defaults to PROJECT_OWNER and accepts only authoritative Admin roles", () => {
    expect(parseStagingAdminRole(undefined)).toBe("PROJECT_OWNER");
    expect(adminRoles).toEqual([
      "PROJECT_OWNER",
      "OPERATIONS",
      "SUPPORT",
      "FINANCE",
      "SECURITY_AUDITOR",
    ]);
    for (const role of adminRoles) {
      expect(parseStagingAdminRole(role)).toBe(role);
    }
  });

  it("fails closed for empty, malformed or invented roles", () => {
    for (const role of ["", "support", " SUPPORT", "ADMIN", "ROOT"]) {
      expect(() => parseStagingAdminRole(role)).toThrowError(
        "STAGING_ADMIN_ROLE_INVALID",
      );
    }
  });

  it("keeps the staging role variable outside the Admin production-style runtime", () => {
    const server = readFileSync("scripts/staging-admin-server.ts", "utf8");
    const bootstrap = readFileSync(
      "scripts/staging-admin-bootstrap.ts",
      "utf8",
    );

    expect(bootstrap).toContain("KEYRANO_STAGING_ADMIN_ROLE");
    expect(server).not.toContain("KEYRANO_STAGING_ADMIN_ROLE");
  });
});
