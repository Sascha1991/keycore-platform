import { describe, expect, it, vi } from "vitest";

import {
  AdminAccessError,
  AdminAuthenticationService,
  AdminOrderService,
  correlationId,
  hashAdminSession,
  orderId,
  type AdminOrderReadRepository,
  type AdminOrderDetail,
  type AdminPrincipal,
  type AdminSessionRepository,
  type AuditEvent,
  type AuditEventPort,
} from "../contracts.js";

const hmacMaterial = [
  "admin-test",
  "material-longer-than-thirty-two-bytes",
].join("-");
const now = new Date("2026-09-02T10:00:00.000Z");
const owner: AdminPrincipal = {
  adminId: "admin-owner",
  assurance: "MFA",
  displayName: "Project Owner",
  expiresAt: new Date("2026-09-02T18:00:00.000Z"),
  roles: ["PROJECT_OWNER"],
};
const auditor: AdminPrincipal = {
  ...owner,
  adminId: "admin-auditor",
  roles: ["SECURITY_AUDITOR"],
};
const targetOrderId = orderId("20000000-0000-4000-8000-000000000001");

describe("secure admin authentication and orders", () => {
  it("stores and looks up only an HMAC session hash", async () => {
    const rawSession = "opaque-admin-session-value-1234567890abcdef";
    const repository: AdminSessionRepository = {
      findByHash: vi.fn(async (hash) =>
        hash === hashAdminSession(rawSession, hmacMaterial)
          ? {
              adminId: owner.adminId,
              assurance: owner.assurance,
              displayName: owner.displayName,
              expiresAt: owner.expiresAt,
              identityStatus: "ACTIVE" as const,
              revokedAt: null,
              roles: owner.roles,
            }
          : null,
      ),
      revoke: vi.fn(async () => undefined),
      touch: vi.fn(async () => undefined),
    };
    const audit = new MemoryAudit();
    const service = new AdminAuthenticationService(
      repository,
      audit,
      hmacMaterial,
      "STAGING",
      () => now,
    );

    await expect(
      service.authenticate(rawSession, correlationId("admin-auth-test")),
    ).resolves.toMatchObject({
      authenticated: true,
      principal: { adminId: owner.adminId },
    });
    expect(repository.findByHash).toHaveBeenCalledWith(
      expect.stringMatching(/^[a-f0-9]{64}$/u),
    );
    expect(JSON.stringify(repository)).not.toContain(rawSession);
    expect(JSON.stringify(audit.events)).not.toContain(rawSession);
  });

  it("fails closed for expired sessions", async () => {
    const audit = new MemoryAudit();
    const service = new AdminAuthenticationService(
      {
        findByHash: async () => ({
          ...owner,
          identityStatus: "ACTIVE",
          revokedAt: null,
          expiresAt: new Date(now.getTime() - 1_000),
        }),
        revoke: async () => undefined,
        touch: vi.fn(async () => undefined),
      },
      audit,
      hmacMaterial,
      "STAGING",
      () => now,
    );

    await expect(
      service.authenticate(
        "expired-admin-session-1234567890abcdef",
        correlationId("expired-test"),
      ),
    ).resolves.toEqual({
      authenticated: false,
      reasonCode: "ADMIN_SESSION_UNAVAILABLE",
    });
    expect(audit.events.at(-1)).toMatchObject({
      outcome: "DENIED",
      reasonCode: "ADMIN_SESSION_UNAVAILABLE",
    });
  });

  it("denies order access before the repository for an insufficient role and audits it", async () => {
    const repository = repositoryFixture();
    const audit = new MemoryAudit();
    const service = new AdminOrderService(
      repository,
      audit,
      hmacMaterial,
      "STAGING",
      () => now,
    );

    await expect(
      service.dashboard(auditor, correlationId("admin-denied")),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_ACCESS_DENIED" });
    expect(repository.dashboard).not.toHaveBeenCalled();
    expect(audit.events.at(-1)).toMatchObject({
      outcome: "DENIED",
      reasonCode: "ADMIN_ACCESS_DENIED",
    });
  });

  it("validates exact searches, preserves deterministic pagination and rejects a tampered cursor", async () => {
    const repository = repositoryFixture();
    const audit = new MemoryAudit();
    const service = new AdminOrderService(
      repository,
      audit,
      hmacMaterial,
      "STAGING",
      () => now,
    );
    vi.mocked(repository.list).mockResolvedValueOnce({
      orders: [summary()],
      nextCursor: { createdAt: now, orderId: targetOrderId },
    });

    const first = await service.list(
      owner,
      { search: "ADMIN@EXAMPLE.TEST", status: "COMPLETED" },
      correlationId("admin-list"),
    );
    expect(repository.list).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: {
          exactCustomerEmail: "admin@example.test",
          status: "COMPLETED",
        },
        limit: 25,
      }),
    );
    expect(first.nextCursorValue).toBeTruthy();
    const cursor = required(first.nextCursorValue);
    await service.list(
      owner,
      { cursor, search: "admin@example.test", status: "COMPLETED" },
      correlationId("admin-list-next"),
    );
    expect(repository.list).toHaveBeenLastCalledWith(
      expect.objectContaining({
        after: { createdAt: now, orderId: targetOrderId },
      }),
    );
    await expect(
      service.list(
        owner,
        {
          cursor: `${cursor}x`,
          search: "admin@example.test",
          status: "COMPLETED",
        },
        correlationId("admin-list-bad"),
      ),
    ).rejects.toBeInstanceOf(AdminAccessError);
    await expect(
      service.list(
        owner,
        { search: "partial-customer" },
        correlationId("admin-list-invalid"),
      ),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_INPUT_INVALID" });
  });

  it("supports exact order and date filters and enforces page bounds", async () => {
    const repository = repositoryFixture();
    const service = new AdminOrderService(
      repository,
      new MemoryAudit(),
      hmacMaterial,
      "STAGING",
      () => now,
    );

    await service.list(
      owner,
      {
        fromDate: "2026-09-01",
        limit: 100,
        search: targetOrderId,
        toDate: "2026-09-02",
      },
      correlationId("admin-order-filter"),
    );
    expect(repository.list).toHaveBeenCalledWith({
      filters: {
        exactOrderId: targetOrderId,
        fromDate: "2026-09-01",
        toDate: "2026-09-02",
      },
      limit: 100,
    });
    await expect(
      service.list(owner, { limit: 101 }, correlationId("admin-limit-invalid")),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_INPUT_INVALID" });
    await expect(
      service.list(
        owner,
        { fromDate: "2026-09-03", toDate: "2026-09-02" },
        correlationId("admin-dates-invalid"),
      ),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_INPUT_INVALID" });
  });

  it("makes missing orders enumeration-resistant and audits the denied read", async () => {
    const repository = repositoryFixture();
    vi.mocked(repository.findDetail).mockResolvedValueOnce(null);
    const audit = new MemoryAudit();
    const service = new AdminOrderService(
      repository,
      audit,
      hmacMaterial,
      "STAGING",
      () => now,
    );

    await expect(
      service.detail(owner, targetOrderId, correlationId("admin-idor")),
    ).rejects.toEqual(new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE"));
    expect(audit.events.at(-1)).toMatchObject({
      outcome: "DENIED",
      reasonCode: "ADMIN_RESOURCE_UNAVAILABLE",
    });
  });

  it("fails closed when protected-read audit persistence is unavailable", async () => {
    const repository = repositoryFixture();
    const failingAudit: AuditEventPort = {
      append: async () => {
        throw new Error("synthetic audit outage");
      },
    };
    const service = new AdminOrderService(
      repository,
      failingAudit,
      hmacMaterial,
      "STAGING",
      () => now,
    );

    await expect(
      service.list(owner, {}, correlationId("admin-audit-outage")),
    ).rejects.toThrow("synthetic audit outage");
  });

  it("denies reveal privilege escalation before reading order data", async () => {
    const repository = repositoryFixture();
    const service = new AdminOrderService(
      repository,
      new MemoryAudit(),
      hmacMaterial,
      "STAGING",
      () => now,
    );
    const support: AdminPrincipal = {
      ...owner,
      adminId: "admin-support",
      roles: ["SUPPORT"],
    };

    await expect(
      service.requestProductKeyReveal(
        support,
        targetOrderId,
        correlationId("admin-reveal-denied"),
      ),
    ).rejects.toMatchObject({ reasonCode: "ADMIN_ACCESS_DENIED" });
    expect(repository.findDetail).not.toHaveBeenCalled();
  });

  it("returns no key material and keeps admin reveal fail-closed after authorization", async () => {
    const repository = repositoryFixture();
    const audit = new MemoryAudit();
    const service = new AdminOrderService(
      repository,
      audit,
      hmacMaterial,
      "STAGING",
      () => now,
    );

    const detail = await service.detail(
      owner,
      targetOrderId,
      correlationId("admin-detail"),
    );
    expect(JSON.stringify(detail)).not.toMatch(
      /ciphertext|nonce|wrapped|TEST-[A-Z0-9-]+/u,
    );
    await expect(
      service.requestProductKeyReveal(
        owner,
        targetOrderId,
        correlationId("admin-reveal"),
      ),
    ).resolves.toEqual({
      available: false,
      reasonCode: "ADMIN_KEY_REVEAL_NOT_ENABLED",
    });
    expect(audit.events.at(-1)).toMatchObject({
      eventType: "ADMIN_ACTION",
      outcome: "DENIED",
      reasonCode: "ADMIN_KEY_REVEAL_NOT_ENABLED",
    });
  });
});

class MemoryAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];
  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const repositoryFixture = (): AdminOrderReadRepository => ({
  dashboard: vi.fn(async () => ({
    attentionOrders: 0,
    failedOrders: 0,
    processingOrders: 1,
    recentOrders: [summary()],
    revenueByCurrency: [{ amountMinor: "2199", currency: "EUR" }],
    totalOrders: 1,
  })),
  findDetail: vi.fn(async () => detail()),
  list: vi.fn(async () => ({ orders: [summary()] })),
});

const summary = () => ({
  amountMinor: "2199",
  createdAt: now,
  currency: "EUR",
  customerEmail: "admin@example.test",
  fulfillmentStatus: "PENDING",
  orderId: targetOrderId,
  paymentStatus: "CAPTURED",
  procurementStatus: "SUCCEEDED",
  productTitle: "Arena Eleven",
  quantity: 1,
  riskStatus: "APPROVED",
  status: "FULFILLMENT_PENDING",
  updatedAt: now,
});
const detail = (): AdminOrderDetail => ({
  ...summary(),
  correlationId: "corr-admin",
  customerId: "10000000-0000-4000-8000-000000000001",
  deliveryState: "PENDING",
  encryptedSecretAvailable: true,
  externalSupplierOrderId: "supplier-order-safe-reference",
  fulfillmentOperationStatus: "DELIVERY_PENDING",
  guestClaimStatus: "NOT_AVAILABLE",
  history: [],
  invoiceStatus: "NOT_AVAILABLE",
  retrievalState: "RETRIEVED",
  supplierId: "supplier-reference",
});
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Expected value");
  return value;
};
