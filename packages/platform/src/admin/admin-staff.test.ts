import { describe, expect, it } from "vitest";

import {
  AdminAccessError,
  AdminStaffService,
  capabilitiesForRole,
  correlationId,
  effectiveAdminCapabilities,
  hasAdminCapability,
  type AdminPrincipal,
  type AdminStaffRepository,
  type AuditEvent,
  type AuditEventPort,
} from "../contracts.js";

const hmacMaterial = "admin-staff-test-material-longer-than-thirty-two-bytes";
const ownerId = "a1000000-0000-4000-8000-000000000001";
const targetId = "a1000000-0000-4000-8000-000000000002";
const requestId = correlationId("staff-domain-test");

describe("Admin staff authorization", () => {
  it("keeps role defaults least-privilege and unions active grants", () => {
    expect(capabilitiesForRole("SUPPORT")).toEqual([
      "ADMIN_ACCESS",
      "ORDER_VIEW",
    ]);
    expect(capabilitiesForRole("SECURITY_AUDITOR")).toEqual([
      "ADMIN_ACCESS",
      "AUDIT_VIEW",
    ]);
    expect(capabilitiesForRole("OPERATIONS")).not.toContain(
      "PRODUCT_KEY_REVEAL",
    );
    expect(effectiveAdminCapabilities("SUPPORT", ["AUDIT_VIEW"])).toEqual([
      "ADMIN_ACCESS",
      "AUDIT_VIEW",
      "ORDER_VIEW",
    ]);
    expect(
      hasAdminCapability(
        { ...principal("SUPPORT"), individualCapabilities: ["AUDIT_VIEW"] },
        "AUDIT_VIEW",
      ),
    ).toBe(true);
  });

  it("blocks direct support access and sensitive self escalation with audited denial", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.list(principal("SUPPORT"), requestId),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_ACCESS_DENIED" });
    const owner = principal("PROJECT_OWNER");
    await expect(
      fixture.service.grantPermission(
        owner,
        owner.adminId,
        "PRODUCT_KEY_REVEAL",
        "",
        requestId,
      ),
    ).rejects.toBeInstanceOf(AdminAccessError);
    expect(fixture.audit.events.map((event) => event.reasonCode)).toEqual([
      "ADMIN_ACCESS_DENIED",
      "ADMIN_SELF_ESCALATION_DENIED",
    ]);
    expect(fixture.repository.grants).toHaveLength(0);

    const delegated = {
      ...principal("SUPPORT"),
      individualCapabilities: ["PERMISSION_OVERRIDE_MANAGE" as const],
    };
    await expect(
      fixture.service.grantPermission(
        delegated,
        targetId,
        "PRODUCT_KEY_REVEAL",
        "",
        requestId,
      ),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_ACCESS_DENIED" });
    expect(fixture.repository.grants).toHaveLength(0);
  });

  it("rejects unknown capabilities and normalizes bounded staff input", async () => {
    const fixture = serviceFixture();
    const owner = principal("PROJECT_OWNER");
    await expect(
      fixture.service.grantPermission(owner, targetId, "ROOT", "", requestId),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_INPUT_INVALID" });
    await fixture.service.create(
      owner,
      {
        email: " Staff.Example@Example.Test ",
        employeeNumber: "STAFF-002",
        firstName: " Ada ",
        lastName: " Lovelace ",
        role: "FINANCE",
      },
      requestId,
    );
    expect(fixture.repository.created[0]).toMatchObject({
      displayName: "Ada Lovelace",
      emailNormalized: "staff.example@example.test",
      employeeNumber: "STAFF-002",
      role: "FINANCE",
    });
  });

  it("treats idempotent mutations as safe and propagates last-owner protection", async () => {
    const unchanged = serviceFixture("UNCHANGED");
    await expect(
      unchanged.service.changeRole(
        principal("PROJECT_OWNER"),
        targetId,
        "SUPPORT",
        requestId,
      ),
    ).resolves.toBeUndefined();
    const protectedFixture = serviceFixture("LAST_OWNER_PROTECTED");
    await expect(
      protectedFixture.service.setStatus(
        principal("PROJECT_OWNER"),
        targetId,
        "DISABLED",
        requestId,
      ),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_ACCESS_DENIED" });
  });

  it("rejects unsafe audit filters before querying persistence", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.auditList(
        principal("PROJECT_OWNER"),
        { reasonCode: "ADMIN_OK' OR 1=1" },
        requestId,
      ),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_INPUT_INVALID" });
  });
});

const principal = (role: "PROJECT_OWNER" | "SUPPORT"): AdminPrincipal => ({
  adminId: ownerId,
  assurance: "MFA",
  displayName: "Test Admin",
  expiresAt: new Date("2026-09-03T00:00:00.000Z"),
  roles: [role],
});

class MemoryAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];
  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const serviceFixture = (
  mutationResult: "UPDATED" | "UNCHANGED" | "LAST_OWNER_PROTECTED" = "UPDATED",
) => {
  const audit = new MemoryAudit();
  const created: Parameters<AdminStaffRepository["create"]>[0][] = [];
  const grants: string[] = [];
  const repository: AdminStaffRepository & {
    created: typeof created;
    grants: typeof grants;
  } = {
    changeRole: async () => mutationResult,
    create: async (input) => {
      created.push(input);
      return mutationResult;
    },
    created,
    findDetail: async () => null,
    grantPermission: async (_id, capability) => {
      grants.push(capability);
      return mutationResult;
    },
    grants,
    list: async () => [],
    listAudit: async () => ({ entries: [] }),
    revokePermission: async () => mutationResult,
    setStatus: async () => mutationResult,
  };
  return {
    audit,
    repository,
    service: new AdminStaffService(
      repository,
      audit,
      hmacMaterial,
      "STAGING",
      () => new Date("2026-09-02T10:00:00.000Z"),
    ),
  };
};
