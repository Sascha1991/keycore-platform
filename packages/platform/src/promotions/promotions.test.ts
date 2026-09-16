import { describe, expect, it } from "vitest";

import {
  correlationId,
  type AuditEvent,
  type AuditEventPort,
} from "../contracts.js";
import type { AdminPrincipal } from "../admin/admin-orders.js";
import {
  AdminPromotionService,
  calculatePromotionDiscount,
  effectivePromotionStatus,
  parseEuroMinorUnits,
  parsePercentageBasisPoints,
  promotionCode,
  type PromotionCampaign,
  type PromotionCreateInput,
  type PromotionOverview,
  type PromotionRepository,
} from "./promotions.js";

const now = new Date("2026-09-15T10:00:00.000Z");
const principal: AdminPrincipal = {
  adminId: "admin-owner",
  assurance: "STAGING_SYNTHETIC",
  displayName: "Admin",
  expiresAt: new Date("2026-09-15T11:00:00.000Z"),
  individualCapabilities: [
    "ADMIN_ACCESS",
    "PROMOTION_VIEW",
    "PROMOTION_MANAGE",
  ],
  roles: [],
};

describe("promotion domain", () => {
  it("normalizes codes and human percentage and EUR values centrally", () => {
    expect(promotionCode("  herbst_20 ")).toBe("HERBST_20");
    expect(parsePercentageBasisPoints("12,50")).toBe(1_250n);
    expect(parseEuroMinorUnits("19,99")).toBe(1_999n);
    expect(() => promotionCode("xx")).toThrow();
    expect(() => parsePercentageBasisPoints("100")).toThrow();
    expect(() => parseEuroMinorUnits("0")).toThrow();
  });

  it("calculates bounded percentage and fixed discounts without zero-value orders", () => {
    expect(calculatePromotionDiscount("PERCENTAGE", 2_000n, 1_299n)).toBe(259n);
    expect(calculatePromotionDiscount("FIXED_AMOUNT", 500n, 1_299n)).toBe(500n);
    expect(calculatePromotionDiscount("FIXED_AMOUNT", 2_000n, 1_299n)).toBe(
      1_298n,
    );
  });

  it("derives planned, active and expired states from lifecycle and schedule", () => {
    const campaign = campaignFixture();
    expect(effectivePromotionStatus(campaign, now)).toBe("ACTIVE");
    expect(
      effectivePromotionStatus(
        { ...campaign, startsAt: new Date("2026-09-16T00:00:00.000Z") },
        now,
      ),
    ).toBe("PLANNED");
    expect(
      effectivePromotionStatus(
        { ...campaign, endsAt: new Date("2026-09-15T09:00:00.000Z") },
        now,
      ),
    ).toBe("EXPIRED");
  });

  it("creates a draft with canonical values and repository idempotency authority", async () => {
    const repository = new CapturingRepository();
    const service = new AdminPromotionService(
      repository,
      new MemoryAudit(),
      "STAGING",
      () => now,
    );
    const id = await service.create(
      principal,
      {
        code: " staging-20 ",
        discountType: "PERCENTAGE",
        discountValue: "20",
        endsAt: "",
        internalDescription: "Nur synthetisch",
        minimumSubtotal: "10,00",
        name: "Staging Aktion",
        operationId: "30000000-0000-4000-8000-000000000001",
        productScope: "ALL_ELIGIBLE_PRODUCTS",
        startsAt: "",
        usageLimit: "25",
      },
      correlationId("promotion-create-test"),
    );

    expect(id).toBe(repository.created?.id);
    expect(repository.created).toMatchObject({
      code: "STAGING-20",
      currency: "EUR",
      discountValue: 2_000n,
      minimumSubtotalMinor: 1_000n,
      usageLimit: 25n,
    });
  });

  it("denies view without promotion capability and emits no sensitive data", async () => {
    const audit = new MemoryAudit();
    const service = new AdminPromotionService(
      new CapturingRepository(),
      audit,
      "STAGING",
      () => now,
    );
    await expect(
      service.list(
        { ...principal, individualCapabilities: ["ADMIN_ACCESS"] },
        {},
        correlationId("promotion-access-test"),
      ),
    ).rejects.toThrow("Admin request unavailable");
    expect(audit.events).toHaveLength(1);
    expect(JSON.stringify(audit.events)).not.toMatch(
      /STAGING20|secret|credential/iu,
    );
  });
});

class MemoryAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];
  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class CapturingRepository implements PromotionRepository {
  public created: PromotionCreateInput | undefined;
  public async list(): Promise<PromotionOverview> {
    return {
      active: 0,
      attention: 0,
      campaigns: [],
      limit: 10,
      page: 1,
      planned: 0,
      total: 0,
      totalCount: 0,
    };
  }
  public async find() {
    return null;
  }
  public async create(input: PromotionCreateInput) {
    this.created = input;
    return { id: input.id, status: "CREATED" as const };
  }
  public async update() {
    return "UPDATED" as const;
  }
  public async setProductEligibility() {
    return "UPDATED" as const;
  }
  public async searchProducts() {
    return [];
  }
  public async transition() {
    return "UPDATED" as const;
  }
  public async quote() {
    return null;
  }
  public async findReservation() {
    return null;
  }
  public async reserve() {
    return null;
  }
  public async consume() {
    return "UNAVAILABLE" as const;
  }
  public async release() {
    return undefined;
  }
}

const campaignFixture = (): PromotionCampaign => ({
  code: "ACTIVE10",
  consumedCount: 0n,
  createdAt: now,
  currency: "EUR",
  discountType: "PERCENTAGE",
  discountValue: 1_000n,
  endsAt: null,
  hasCommittedUsage: false,
  id: "10000000-0000-4000-8000-000000000001",
  internalDescription: "",
  lifecycle: "ENABLED",
  minimumSubtotalMinor: null,
  name: "Aktiv",
  operationId: "20000000-0000-4000-8000-000000000001",
  productIds: [],
  productScope: "ALL_ELIGIBLE_PRODUCTS",
  recordVersion: 1,
  reservedCount: 0n,
  startsAt: null,
  updatedAt: now,
  usageLimit: null,
});
