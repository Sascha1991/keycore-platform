import { describe, expect, it } from "vitest";

import {
  AdminAccessError,
  AdminSupplierConflictError,
  AdminSupplierService,
  correlationId,
  type AdminPrincipal,
  type AdminSupplierMutationRepository,
  type AuditEvent,
  type AuditEventPort,
} from "../contracts.js";

const now = new Date("2026-09-13T10:00:00.000Z");
const operationId = "30000000-0000-4000-8000-000000000001";
const supplierId = "40000000-0000-4000-8000-000000000001";
const requestId = correlationId("supplier-management-test");

describe("AdminSupplierService", () => {
  it("creates a name-only supplier and exposes the synthetic adapter separately", async () => {
    const fixture = serviceFixture();

    await expect(
      fixture.service.integrationOptions(owner(), requestId),
    ).resolves.toEqual([
      {
        capabilities: ["Katalogintegration"],
        description:
          "Sichere lokale und Staging-Integration für synthetische Katalogdaten.",
        label: "Synthetischer Testadapter",
        type: "SYNTHETIC",
      },
    ]);
    await expect(
      fixture.service.create(
        owner(),
        {
          displayName: "  Zweiter Testlieferant  ",
          operationId,
        },
        requestId,
      ),
    ).resolves.toBe(supplierId);

    expect(fixture.repository.created).toMatchObject([
      {
        displayName: "Zweiter Testlieferant",
        operationId,
        supplierCode: `admin-supplier-${operationId}`,
        supplierId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      },
    ]);
  });

  it("keeps supplier creation environment-neutral and adapters staging-only", async () => {
    const production = serviceFixture("PRODUCTION");
    await expect(
      production.service.integrationOptions(owner(), requestId),
    ).resolves.toEqual([]);
    await expect(
      production.service.create(
        owner(),
        { displayName: "Supplier", operationId },
        requestId,
      ),
    ).resolves.toBe(supplierId);
    await expect(
      production.service.configureIntegration(
        owner(),
        supplierId,
        { adapterType: "SYNTHETIC", operationId },
        requestId,
      ),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_INPUT_INVALID" });

    const conflict = serviceFixture("STAGING", {
      createResult: { status: "CONFLICT" },
    });
    await expect(
      conflict.service.create(
        owner(),
        { displayName: "Supplier", operationId },
        requestId,
      ),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_INPUT_INVALID" });
    await expect(
      conflict.service.create(
        owner(),
        { displayName: "\u0000", operationId },
        requestId,
      ),
    ).rejects.toBeInstanceOf(AdminAccessError);
  });

  it("configures the supported credential-less integration independently", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.configureIntegration(
        owner(),
        supplierId,
        { adapterType: "SYNTHETIC", operationId },
        requestId,
      ),
    ).resolves.toBeUndefined();
    expect(fixture.repository.configured).toEqual([
      expect.objectContaining({
        adapterType: "SYNTHETIC",
        capabilities: { catalog: true },
        operationId,
        supplierId,
      }),
    ]);
  });

  it("renames with optimistic concurrency and reports stale writes", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.rename(
        owner(),
        supplierId,
        { displayName: " Neuer Anzeigename ", expectedVersion: "3" },
        requestId,
      ),
    ).resolves.toBeUndefined();
    expect(fixture.repository.renamed).toEqual([
      {
        displayName: "Neuer Anzeigename",
        expectedVersion: 3,
        supplierId,
      },
    ]);

    const stale = serviceFixture("STAGING", { renameResult: "STALE" });
    await expect(
      stale.service.rename(
        owner(),
        supplierId,
        { displayName: "Neuer Name", expectedVersion: "1" },
        requestId,
      ),
    ).rejects.toBeInstanceOf(AdminSupplierConflictError);
  });

  it("does not infer mutation authority from supplier read access", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.integrationOptions(support(), requestId),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_ACCESS_DENIED" });
    expect(fixture.audit.events).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          action: "ADMIN_SUPPLIER_MANAGEMENT_DENIED",
          requiredCapability: "SUPPLIER_MANAGE",
        }),
        outcome: "DENIED",
      }),
    ]);
  });
});

class MemoryAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class CapturingRepository implements AdminSupplierMutationRepository {
  public readonly created: Parameters<
    AdminSupplierMutationRepository["create"]
  >[0][] = [];
  public readonly renamed: Parameters<
    AdminSupplierMutationRepository["rename"]
  >[0][] = [];
  public readonly configured: Parameters<
    AdminSupplierMutationRepository["configureIntegration"]
  >[0][] = [];

  public constructor(
    private readonly createResult: Awaited<
      ReturnType<AdminSupplierMutationRepository["create"]>
    > = { status: "CREATED", supplierId },
    private readonly renameResult: Awaited<
      ReturnType<AdminSupplierMutationRepository["rename"]>
    > = "UPDATED",
  ) {}

  public async create(
    input: Parameters<AdminSupplierMutationRepository["create"]>[0],
  ): ReturnType<AdminSupplierMutationRepository["create"]> {
    this.created.push(input);
    return this.createResult;
  }

  public async rename(
    input: Parameters<AdminSupplierMutationRepository["rename"]>[0],
  ): ReturnType<AdminSupplierMutationRepository["rename"]> {
    this.renamed.push(input);
    return this.renameResult;
  }

  public async configureIntegration(
    input: Parameters<
      AdminSupplierMutationRepository["configureIntegration"]
    >[0],
  ): ReturnType<AdminSupplierMutationRepository["configureIntegration"]> {
    this.configured.push(input);
    return Promise.resolve("CREATED");
  }
}

const serviceFixture = (
  environment: AuditEvent["environment"] = "STAGING",
  results: {
    readonly createResult?: Awaited<
      ReturnType<AdminSupplierMutationRepository["create"]>
    >;
    readonly renameResult?: Awaited<
      ReturnType<AdminSupplierMutationRepository["rename"]>
    >;
  } = {},
) => {
  const audit = new MemoryAudit();
  const repository = new CapturingRepository(
    results.createResult,
    results.renameResult,
  );
  return {
    audit,
    repository,
    service: new AdminSupplierService(
      repository,
      audit,
      environment,
      () => now,
    ),
  };
};

const owner = (): AdminPrincipal => ({
  adminId: "admin-owner",
  assurance: "MFA",
  displayName: "Project Owner",
  expiresAt: new Date("2026-09-14T00:00:00.000Z"),
  roles: ["PROJECT_OWNER"],
});

const support = (): AdminPrincipal => ({
  ...owner(),
  adminId: "admin-support",
  roles: ["SUPPORT"],
});
