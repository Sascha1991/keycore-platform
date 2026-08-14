import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { InMemoryCanonicalProductGroupingRepository } from "../../../../infra/catalog/in-memory-canonical-product-repository.js";
import {
  CanonicalProductGroupingService,
  canonicalGroupingPolicyVersion,
  detectEdition,
  normalizeProductTitle,
  safeEvidenceSnapshot,
  strongVerifiedIdentifiers,
  type CanonicalProductAuditEvent,
  type CanonicalProductEvidence,
  type CanonicalProductIdentifierEvidence,
} from "./canonical-product-grouping.js";
import {
  productId,
  supplierId,
  supplierProductId,
  type ProductId,
  type SupplierId,
} from "../contracts.js";

const now = new Date("2026-08-15T00:00:00.000Z");
const supplierA = supplierId("supplier-a");
const supplierB = supplierId("supplier-b");

class RecordingAudit {
  public readonly events: CanonicalProductAuditEvent[] = [];

  public async record(event: CanonicalProductAuditEvent): Promise<void> {
    this.events.push(event);
  }
}

describe("canonical product grouping foundation", () => {
  it("creates a new canonical product for a new supplier product", async () => {
    const { repository, service } = createHarness();

    const result = await service.evaluateSupplierProduct(
      evidence({ supplierProductId: "a-gta-v", title: "Grand Theft Auto V" }),
    );

    expect(result).toMatchObject({
      outcome: "NEW_CANONICAL_PRODUCT",
      reasonCode: "NEW_CANONICAL_PRODUCT_CREATED",
      state: "UNMATCHED",
    });
    expect(repository.listProducts()).toHaveLength(1);
  });

  it("returns the same mapping idempotently for the same supplier product", async () => {
    const { service } = createHarness();
    const input = evidence({ supplierProductId: "a-idempotent" });

    const first = await service.evaluateSupplierProduct(input);
    const second = await service.evaluateSupplierProduct(input);

    expect(second.productId).toBe(first.productId);
    expect(second.reasonCode).toBe("EXISTING_MAPPING_RETURNED");
  });

  it("auto-matches compatible products by identical trusted external identifier", async () => {
    const { service } = createHarness();

    const first = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [
          trustedIdentifier("OFFICIAL_PRODUCT_ID", "rockstar-gta-v"),
        ],
        supplierId: supplierA,
        supplierProductId: "a-gta",
      }),
    );
    const second = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [
          trustedIdentifier("OFFICIAL_PRODUCT_ID", "rockstar-gta-v"),
        ],
        supplierId: supplierB,
        supplierProductId: "b-gta",
      }),
    );

    expect(second).toMatchObject({
      outcome: "AUTO_MATCHED",
      productId: first.productId,
      reasonCode: "STRONG_IDENTIFIER_MATCH",
      state: "AUTO_MATCHED",
    });
  });

  it("auto-matches compatible records by same Steam App ID", async () => {
    const { service } = createHarness();
    const first = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "271590")],
        supplierProductId: "a-steam",
      }),
    );
    const second = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "0271590")],
        supplierId: supplierB,
        supplierProductId: "b-steam",
      }),
    );

    expect(second.productId).toBe(first.productId);
  });

  it("does not auto-match when Steam IDs differ", async () => {
    const { service } = createHarness();
    const first = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "271590")],
        supplierProductId: "a-steam-diff",
      }),
    );
    const second = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "271591")],
        supplierId: supplierB,
        supplierProductId: "b-steam-diff",
      }),
    );

    expect(second.productId).not.toBe(first.productId);
    expect(second.outcome).toBe("NEW_CANONICAL_PRODUCT");
  });

  it("does not auto-group same title only", async () => {
    const { service } = createHarness();
    const first = await service.evaluateSupplierProduct(
      evidence({ supplierProductId: "a-title", title: "Grand Theft Auto V" }),
    );
    const second = await service.evaluateSupplierProduct(
      evidence({
        supplierId: supplierB,
        supplierProductId: "b-title",
        title: "Grand Theft Auto V",
      }),
    );

    expect(second.productId).not.toBe(first.productId);
  });

  it("title plus publisher remains review-required without a trusted identifier", async () => {
    const { service } = createHarness();
    const result = await service.evaluateSupplierProduct(
      evidence({ publisher: "Rockstar", supplierProductId: "publisher-only" }),
    );

    expect(result).toMatchObject({
      outcome: "REVIEW_REQUIRED",
      reasonCode: "SUPPORTING_EVIDENCE_REVIEW_REQUIRED",
    });
  });

  it.each([
    ["GAME vs DLC", "GAME", "DLC", "PRODUCT_TYPE_INCOMPATIBLE"],
    ["GAME vs SOFTWARE", "GAME", "SOFTWARE", "PRODUCT_TYPE_INCOMPATIBLE"],
  ] as const)(
    "blocks %s with the same strong ID",
    async (_name, firstType, secondType, reasonCode) => {
      const { service } = createHarness();
      await service.evaluateSupplierProduct(
        evidence({
          identifiers: [trustedIdentifier("STEAM_APP_ID", "10")],
          productType: firstType,
          supplierProductId: `a-${firstType}`,
        }),
      );
      const result = await service.evaluateSupplierProduct(
        evidence({
          identifiers: [trustedIdentifier("STEAM_APP_ID", "10")],
          productType: secondType,
          supplierId: supplierB,
          supplierProductId: `b-${secondType}`,
        }),
      );

      expect(result).toMatchObject({
        outcome: "CONFLICT",
        reasonCode,
        state: "REVIEW_REQUIRED",
      });
    },
  );

  it.each([
    [
      "standard vs deluxe",
      "Grand Theft Auto V Standard",
      "Grand Theft Auto V Deluxe Edition",
    ],
    [
      "standard vs ultimate",
      "Grand Theft Auto V Standard",
      "Grand Theft Auto V Ultimate Edition",
    ],
    ["bundle vs base", "Grand Theft Auto V Bundle", "Grand Theft Auto V"],
  ])("does not auto-collapse %s", async (_name, firstTitle, secondTitle) => {
    const { service } = createHarness();
    await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("OFFICIAL_PRODUCT_ID", "edition-safe")],
        supplierProductId: "a-edition",
        title: firstTitle,
      }),
    );
    const result = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("OFFICIAL_PRODUCT_ID", "edition-safe")],
        supplierId: supplierB,
        supplierProductId: "b-edition",
        title: secondTitle,
      }),
    );

    expect(result.reasonCode).toBe("EDITION_INCOMPATIBLE");
    expect(result.state).toBe("REVIEW_REQUIRED");
  });

  it("platform mismatch fails closed without blindly merging", async () => {
    const { service } = createHarness();
    await service.evaluateSupplierProduct(
      evidence({
        identifiers: [
          trustedIdentifier("OFFICIAL_PRODUCT_ID", "platform-safe"),
        ],
        platforms: ["WINDOWS"],
        supplierProductId: "a-pc",
      }),
    );
    const result = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [
          trustedIdentifier("OFFICIAL_PRODUCT_ID", "platform-safe"),
        ],
        platforms: ["XBOX"],
        supplierId: supplierB,
        supplierProductId: "b-xbox",
      }),
    );

    expect(result.reasonCode).toBe("PLATFORM_INCOMPATIBLE");
  });

  it.each([
    [" whitespace and case ", "Whitespace and Case", "whitespace and case"],
    ["GTA.V: Premium", "gta v premium", "gta v premium"],
    ["A/B - C", "a b c", "a b c"],
  ])("normalizes titles deterministically for %s", (input, _same, expected) => {
    expect(normalizeProductTitle(input)).toBe(expected);
  });

  it.each([
    ["Grand Theft Auto V Deluxe Edition", "DELUXE"],
    ["Grand Theft Auto V Ultimate Edition", "ULTIMATE"],
    ["Grand Theft Auto V GOTY", "GOTY"],
    ["Grand Theft Auto V Complete", "COMPLETE"],
    ["Grand Theft Auto V Bundle", "BUNDLE"],
    ["Grand Theft Auto V DLC", "DLC"],
    ["Grand Theft Auto V Season Pass", "SEASON_PASS"],
    ["Grand Theft Auto V", "UNKNOWN"],
  ] as const)("preserves edition marker %s", (title, edition) => {
    expect(detectEdition(title, "GAME")).toBe(edition);
  });

  it("treats the same supplierProductId string across suppliers as distinct", async () => {
    const { service } = createHarness();
    const first = await service.evaluateSupplierProduct(
      evidence({ supplierId: supplierA, supplierProductId: "shared-id" }),
    );
    const second = await service.evaluateSupplierProduct(
      evidence({ supplierId: supplierB, supplierProductId: "shared-id" }),
    );

    expect(second.productId).not.toBe(first.productId);
  });

  it("selects strong identifier candidates deterministically", async () => {
    const { service } = createHarness();
    const first = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "20")],
        supplierProductId: "a-det",
      }),
    );
    const second = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "20")],
        supplierId: supplierB,
        supplierProductId: "b-det",
      }),
    );

    expect(second.productId).toBe(first.productId);
  });

  it("multiple strong candidates require review", async () => {
    const { repository, service } = createHarness();
    const first = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("GTIN", "111")],
        supplierProductId: "a-multi-1",
      }),
    );
    const secondProductId = productId("manual-seed-product");
    await repository.saveIdentifiers({
      identifiers: [trustedIdentifier("GTIN", "111")],
      productId: secondProductId,
    });
    repository.putProduct({
      active: true,
      canonicalTitle: "Other",
      confidenceState: "LOW",
      createdAt: now,
      lifecycle: "IN_STOCK",
      platforms: ["WINDOWS"],
      productId: secondProductId,
      productType: "GAME",
      updatedAt: now,
    });

    const result = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("GTIN", "111")],
        supplierId: supplierB,
        supplierProductId: "b-multi",
      }),
    );

    expect(first.productId).toBeDefined();
    expect(result.reasonCode).toBe("MULTIPLE_STRONG_IDENTIFIER_CANDIDATES");
  });

  it("mapping persists and survives repository restart", async () => {
    const { repository, service } = createHarness();
    const result = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "30")],
        supplierProductId: "persisted",
      }),
    );
    const restarted = repository.clone();

    await expect(
      restarted.findMapping({
        supplierId: supplierA,
        supplierProductId: supplierProductId("persisted"),
      }),
    ).resolves.toMatchObject({ productId: result.productId });
  });

  it("mapping cannot silently change ProductId", async () => {
    const { repository, service } = createHarness();
    const input = evidence({ supplierProductId: "no-move" });
    const first = await service.evaluateSupplierProduct(input);
    await repository.createOrUpdateMapping({
      mapping: {
        ...(await requiredMapping(repository, input)),
        productId: productId("another-product"),
      },
    });

    const mapping = await requiredMapping(repository, input);
    expect(mapping.productId).toBe(first.productId);
    expect(mapping.reasonCode).toBe(
      "MAPPED_PRODUCT_REASSIGNMENT_REVIEW_REQUIRED",
    );
  });

  it("manual match, detach and reject record actor and reason safely", async () => {
    const { repository, service } = createHarness();
    const input = evidence({ supplierProductId: "manual-flow" });
    const created = await service.evaluateSupplierProduct(input);
    const manual = await service.manualMatch(
      {
        actorRef: "admin:user-1",
        productId: requiredProductId(created.productId),
        reason: "curated mapping",
        supplierId: input.supplierId,
        supplierProductId: input.supplierProductId,
      },
      input,
    );
    const detached = await service.detach(
      {
        actorRef: "admin:user-1",
        reason: "bad source evidence",
        supplierId: input.supplierId,
        supplierProductId: input.supplierProductId,
      },
      input,
    );
    const rejected = await service.reject(
      {
        actorRef: "admin:user-1",
        reason: "not the same edition",
        supplierId: input.supplierId,
        supplierProductId: input.supplierProductId,
      },
      input,
    );

    expect(manual).toMatchObject({
      actorRef: "admin:user-1",
      reason: "curated mapping",
      state: "MANUAL_MATCHED",
    });
    expect(detached.state).toBe("DETACHED");
    expect(rejected.state).toBe("REJECTED");
    expect(repository.listMappings()).toHaveLength(1);
  });

  it("emits audit events for auto, manual and conflict decisions", async () => {
    const audit = new RecordingAudit();
    const { service } = createHarness(audit);
    await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "40")],
        supplierProductId: "audit-a",
      }),
    );
    const conflict = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "40")],
        productType: "DLC",
        supplierId: supplierB,
        supplierProductId: "audit-b",
      }),
    );
    await service.manualMatch(
      {
        actorRef: "admin",
        productId: requiredProductId(conflict.productId),
        reason: "manual check",
        supplierId: supplierB,
        supplierProductId: supplierProductId("audit-b"),
      },
      evidence({ supplierId: supplierB, supplierProductId: "audit-b" }),
    );

    expect(audit.events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "CANONICAL_PRODUCT_CREATED",
        "SUPPLIER_PRODUCT_MAPPING_CONFLICT",
        "SUPPLIER_PRODUCT_MANUAL_MATCHED",
      ]),
    );
    expect(JSON.stringify(audit.events).toLowerCase()).not.toContain("apikey");
  });

  it("persists policy version and re-evaluation never silently moves a mapped product", async () => {
    const { service } = createHarness();
    const input = evidence({
      identifiers: [trustedIdentifier("STEAM_APP_ID", "50")],
      supplierProductId: "policy",
    });
    const first = await service.evaluateSupplierProduct(input);
    const second = await service.reEvaluate({
      ...input,
      identifiers: [trustedIdentifier("STEAM_APP_ID", "51")],
    });

    expect(first.mapping.policyVersion).toBe(canonicalGroupingPolicyVersion);
    expect(second.productId).toBe(first.productId);
  });

  it("region eligibility does not affect identity mapping", async () => {
    const { service } = createHarness();
    const first = await service.evaluateSupplierProduct(
      evidence({
        germanyEligibility: "ALLOWED",
        identifiers: [trustedIdentifier("STEAM_APP_ID", "60")],
        supplierProductId: "region-a",
      }),
    );
    const second = await service.evaluateSupplierProduct(
      evidence({
        germanyEligibility: "BLOCKED",
        identifiers: [trustedIdentifier("STEAM_APP_ID", "60")],
        supplierId: supplierB,
        supplierProductId: "region-b",
      }),
    );

    expect(second.productId).toBe(first.productId);
  });

  it("canonical product can have offers from two suppliers through mappings", async () => {
    const { repository, service } = createHarness();
    const first = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "70")],
        supplierProductId: "route-a",
      }),
    );
    await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "70")],
        supplierId: supplierB,
        supplierProductId: "route-b",
      }),
    );

    await expect(
      repository.listSupplierProductsForCanonicalProduct(
        requiredProductId(first.productId),
      ),
    ).resolves.toHaveLength(2);
  });

  it("does not require fuzzy matching dependencies", async () => {
    const packageJson = await import("../../../../package.json", {
      with: { type: "json" },
    });
    expect({
      dependencies: packageJson.default.dependencies,
      devDependencies: packageJson.default.devDependencies,
    }).not.toHaveProperty("fuse.js");
    expect(
      Object.keys({
        ...packageJson.default.dependencies,
        ...packageJson.default.devDependencies,
      }).join(" "),
    ).not.toMatch(/\b(fuzzy|machine-learning|ml|ai-sdk)\b/iu);
  });

  it("keeps raw supplier payloads, credentials and product keys out of evidence snapshots", () => {
    const snapshot = safeEvidenceSnapshot(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "80")],
        supplierProductId: "safe-evidence",
      }),
    );

    expect(JSON.stringify(snapshot).toLowerCase()).not.toMatch(
      /credential|api|productkey|raw/u,
    );
  });

  it("performs indexed-style strong identifier lookup for 50,000 supplier products", async () => {
    const { service } = createHarness();
    const start = performance.now();
    for (let index = 0; index < 50_000; index += 1) {
      await service.evaluateSupplierProduct(
        evidence({
          identifiers: [
            trustedIdentifier("STEAM_APP_ID", String(100_000 + index)),
          ],
          supplierProductId: `scale-${index}`,
          title: `Synthetic Product ${index}`,
        }),
      );
    }
    const matched = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "120000")],
        supplierId: supplierB,
        supplierProductId: "scale-match",
        title: "Synthetic Product 20000",
      }),
    );
    const runtimeMs = performance.now() - start;

    expect(matched.outcome).toBe("AUTO_MATCHED");
    expect(runtimeMs).toBeLessThan(15_000);
  });

  it.each([
    [
      "unverified Steam ID",
      { verified: false, trustedSource: "fixture" },
      "NEW_CANONICAL_PRODUCT",
    ],
    [
      "missing trusted source",
      { verified: true, trustedSource: "" },
      "NEW_CANONICAL_PRODUCT",
    ],
    [
      "blank identifier value",
      { verified: true, trustedSource: "fixture", value: " " },
      "NEW_CANONICAL_PRODUCT",
    ],
  ] as const)(
    "does not auto-match using %s",
    async (_name, override, expected) => {
      const { service } = createHarness();
      await service.evaluateSupplierProduct(
        evidence({
          identifiers: [
            {
              ...trustedIdentifier("OFFICIAL_PRODUCT_ID", "weak-id"),
              ...override,
            },
          ],
          supplierProductId: `weak-a-${_name}`,
        }),
      );
      const second = await service.evaluateSupplierProduct(
        evidence({
          identifiers: [
            {
              ...trustedIdentifier("OFFICIAL_PRODUCT_ID", "weak-id"),
              ...override,
            },
          ],
          supplierId: supplierB,
          supplierProductId: `weak-b-${_name}`,
        }),
      );

      expect(second.outcome).toBe(expected);
    },
  );

  it.each([
    ["publisher only", { publisher: "Publisher" }],
    ["developer only", { developer: "Developer" }],
    ["release date only", { releaseDate: "2015-04-14" }],
  ])(
    "keeps %s as review-required supporting evidence",
    async (_name, extra) => {
      const { service } = createHarness();
      const result = await service.evaluateSupplierProduct(
        evidence({ ...extra, supplierProductId: `support-${_name}` }),
      );

      expect(result.reasonCode).toBe("SUPPORTING_EVIDENCE_REVIEW_REQUIRED");
    },
  );

  it.each([
    ["UPC", "000123456789"],
    ["EAN", "4006381333931"],
    ["GTIN", "9504000059437"],
    ["PLATFORM_STORE_ID", "steam:271590"],
  ] as const)(
    "uses %s as a trusted strong identifier when verified",
    async (type, value) => {
      const { service } = createHarness();
      const first = await service.evaluateSupplierProduct(
        evidence({
          identifiers: [trustedIdentifier(type, value)],
          supplierProductId: `id-a-${type}`,
        }),
      );
      const second = await service.evaluateSupplierProduct(
        evidence({
          identifiers: [trustedIdentifier(type, value)],
          supplierId: supplierB,
          supplierProductId: `id-b-${type}`,
        }),
      );

      expect(second.productId).toBe(first.productId);
    },
  );
});

const createHarness = (
  audit = new RecordingAudit(),
): {
  readonly audit: RecordingAudit;
  readonly repository: InMemoryCanonicalProductGroupingRepository;
  readonly service: CanonicalProductGroupingService;
} => {
  const repository = new InMemoryCanonicalProductGroupingRepository();
  return {
    audit,
    repository,
    service: new CanonicalProductGroupingService({
      audit,
      now: () => now,
      repository,
    }),
  };
};

const evidence = (
  override: Omit<
    Partial<CanonicalProductEvidence>,
    "supplierId" | "supplierProductId"
  > & {
    readonly supplierId?: SupplierId | string;
    readonly supplierProductId?: string;
  } = {},
): CanonicalProductEvidence => {
  const {
    supplierId: overrideSupplierId,
    supplierProductId: overrideSupplierProductId,
    ...rest
  } = override;
  return {
    identifiers: [],
    lifecycle: "IN_STOCK",
    platforms: ["WINDOWS"],
    productType: "GAME",
    title: "Grand Theft Auto V",
    ...rest,
    supplierId:
      typeof overrideSupplierId === "string"
        ? supplierId(overrideSupplierId)
        : (overrideSupplierId ?? supplierA),
    supplierProductId:
      typeof overrideSupplierProductId === "string"
        ? supplierProductId(overrideSupplierProductId)
        : (overrideSupplierProductId ?? supplierProductId("default-product")),
  };
};

const trustedIdentifier = (
  type: CanonicalProductIdentifierEvidence["type"],
  value: string,
): CanonicalProductIdentifierEvidence => ({
  trustedSource: "fixture",
  type,
  value,
  verified: true,
});

const requiredProductId = (value: ProductId | undefined): ProductId => {
  if (!value) {
    throw new Error("Expected ProductId");
  }
  return value;
};

const requiredMapping = async (
  repository: InMemoryCanonicalProductGroupingRepository,
  input: CanonicalProductEvidence,
) => {
  const mapping = await repository.findMapping(input);
  if (!mapping) {
    throw new Error("Expected canonical product mapping");
  }
  return mapping;
};

describe("canonical product grouping core import boundaries", () => {
  it("has no Kinguin or GAMIVO imports in the grouping core", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("./canonical-product-grouping.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/kinguin|gamivo/iu);
  });

  it("normalizes trusted identifiers and drops invalid Steam IDs", () => {
    expect(
      strongVerifiedIdentifiers([
        trustedIdentifier("STEAM_APP_ID", " 0010 "),
        trustedIdentifier("STEAM_APP_ID", "not-steam"),
      ]),
    ).toEqual([expect.objectContaining({ type: "STEAM_APP_ID", value: "10" })]);
  });
});
