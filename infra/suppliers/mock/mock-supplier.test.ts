import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  SupplierRegistry,
  correlationId,
  idempotencyKey,
  offerId,
  orderLineId,
  productId,
  supplierId,
  supplierOfferId,
  supplierProductId,
  validateRegionEvidence,
  type OfferId,
  type ProductId,
  type SupplierOfferId,
  type SupplierProductId,
} from "../../../packages/platform/src/contracts.js";
import { runSupplierContractTests } from "../contract/supplier-contract-suite.js";
import {
  MockSupplier,
  createGeneratedMockSupplierFixtures,
  createDefaultMockSupplierFixtures,
  defaultGeneratedMockCatalogSize,
  type MockOfferFixture,
  type MockProductFixture,
} from "./mock-supplier.js";

const setup = {
  createSupplier: () => new MockSupplier(),
  delayedOfferId: supplierOfferId("so-alpha-usd"),
  knownOfferId: supplierOfferId("so-alpha-eur"),
  knownProductId: supplierProductId("sp-alpha"),
  missingOfferId: supplierOfferId("so-missing"),
  missingProductId: supplierProductId("sp-missing"),
  unavailableOfferId: supplierOfferId("so-beta-eur"),
};

const collectPrimitiveValues = (value: unknown): string[] => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return [String(value)];
  }

  if (value instanceof Date) {
    return [value.toISOString()];
  }

  if (Array.isArray(value)) {
    return value.flatMap(collectPrimitiveValues);
  }

  if (typeof value === "object") {
    return Object.values(value).flatMap(collectPrimitiveValues);
  }

  return [];
};

runSupplierContractTests(setup);

describe("supplier registry", () => {
  it("registers, resolves, lists, and rejects duplicate or unknown suppliers", () => {
    const registry = new SupplierRegistry();
    const supplier = new MockSupplier();

    registry.register(supplier);

    expect(registry.resolve(supplier.identity.supplierId)).toBe(supplier);
    expect(registry.list()).toEqual([
      {
        capabilities: supplier.capabilities,
        identity: supplier.identity,
      },
    ]);
    expect(() => registry.register(supplier)).toThrow("CONFLICT");
    expect(() => registry.resolve(supplierId("unknown-supplier"))).toThrow(
      "NOT_FOUND",
    );
    expect(JSON.stringify(registry.list())).not.toMatch(
      /(secret|token|password|credential|bearer)/iu,
    );
  });
});

describe("mock supplier behavior", () => {
  it("keeps supplier-side IDs distinct from KeyCore IDs", () => {
    const supplierProduct: SupplierProductId = supplierProductId("sp-alpha");
    const supplierOffer: SupplierOfferId = supplierOfferId("so-alpha");
    const keycoreProduct: ProductId = productId("product-alpha");
    const keycoreOffer: OfferId = offerId("offer-alpha");

    expect(supplierProduct).not.toBe(keycoreProduct);
    expect(supplierOffer).not.toBe(keycoreOffer);
    // @ts-expect-error SupplierProductId must not be assignable to ProductId.
    const invalidProductId: ProductId = supplierProduct;
    // @ts-expect-error SupplierOfferId must not be assignable to OfferId.
    const invalidOfferId: OfferId = supplierOffer;
    expect(invalidProductId).toBe("sp-alpha");
    expect(invalidOfferId).toBe("so-alpha");
  });

  it("supports empty catalog state", async () => {
    const supplier = new MockSupplier({ offers: [], products: [] });

    await expect(supplier.listCatalog({ limit: 10 })).resolves.toEqual({
      items: [],
    });
  });

  it("keeps unknown and contradictory region evidence review-required", async () => {
    const supplier = new MockSupplier();
    const unknown = await supplier.getRegionEvidence(
      supplierOfferId("so-alpha-usd"),
    );
    const contradictory = await supplier.getRegionEvidence(
      supplierOfferId("so-beta-eur"),
    );

    expect(validateRegionEvidence(unknown).decision).toBe("REVIEW_REQUIRED");
    expect(validateRegionEvidence(contradictory).reasonCode).toBe(
      "REGION_EVIDENCE_CONTRADICTORY",
    );
  });

  it("represents ambiguous and terminal purchase scenarios", async () => {
    const supplier = new MockSupplier();
    const ambiguous = await supplier.submitPurchase({
      clientIdempotencyReference: idempotencyKey("idem-ambiguous"),
      correlationId: correlationId("corr-ambiguous"),
      orderLineId: orderLineId("line-ambiguous"),
      supplierOfferId: supplierOfferId("so-gamma-eur"),
    });

    expect(ambiguous.state).toBe("AMBIGUOUS");
    await expect(
      supplier.reconcilePurchase(ambiguous.supplierPurchaseReference),
    ).resolves.toMatchObject({ outcome: "STILL_AMBIGUOUS" });
    await expect(
      supplier.submitPurchase({
        clientIdempotencyReference: idempotencyKey("idem-terminal"),
        correlationId: correlationId("corr-terminal"),
        orderLineId: orderLineId("line-terminal"),
        supplierOfferId: supplierOfferId("so-beta-terminal"),
      }),
    ).rejects.toMatchObject({ category: "REJECTED" });
  });

  it("fails optional capabilities predictably when disabled", async () => {
    const supplier = new MockSupplier({
      capabilities: {
        supportsDeltaCatalog: false,
        supportsKeyRetrieval: false,
        supportsRefundClaims: false,
      },
    });
    const receipt = await supplier.submitPurchase({
      clientIdempotencyReference: idempotencyKey("idem-disabled-capability"),
      correlationId: correlationId("corr-disabled-capability"),
      orderLineId: orderLineId("line-disabled-capability"),
      supplierOfferId: supplierOfferId("so-alpha-eur"),
    });

    await expect(
      supplier.listCatalogDelta({
        page: { limit: 10 },
        since: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ category: "UNSUPPORTED_CAPABILITY" });
    await expect(
      supplier.retrieveKey(receipt.supplierPurchaseReference),
    ).rejects.toMatchObject({ category: "UNSUPPORTED_CAPABILITY" });
    await expect(
      supplier.submitRefundClaim({
        correlationId: correlationId("corr-refund-disabled"),
        orderLineId: orderLineId("line-disabled-capability"),
        supplierPurchaseReference: receipt.supplierPurchaseReference,
      }),
    ).rejects.toMatchObject({ category: "UNSUPPORTED_CAPABILITY" });
  });

  it("classifies deterministic fault injection", async () => {
    const cases = [
      ["TIMEOUT", "TIMEOUT"],
      ["RATE_LIMITED", "RATE_LIMIT"],
      ["TRANSIENT_ERROR", "TRANSIENT"],
      ["TERMINAL_ERROR", "REJECTED"],
      ["MALFORMED_RESPONSE_SIMULATION", "INVALID_RESPONSE"],
    ] as const;

    for (const [fault, category] of cases) {
      const supplier = new MockSupplier({
        faultByOperation: { listCatalog: fault },
      });
      await expect(supplier.listCatalog({ limit: 1 })).rejects.toMatchObject({
        category,
      });
    }
  });

  it("validates impossible rate-limit metadata", () => {
    expect(
      () =>
        new MockSupplier({
          health: {
            checkedAt: new Date("2026-01-01T00:00:00.000Z"),
            rateLimit: { limit: 10, remaining: 11 },
            status: "DEGRADED",
          },
        }),
    ).toThrow("INVALID_RESPONSE");
  });

  it("uses deterministic fixtures without real supplier payloads", () => {
    const fixtures = createDefaultMockSupplierFixtures();

    expect(
      fixtures.products.map((product) => product.supplierProductId),
    ).toEqual(["sp-alpha", "sp-beta", "sp-gamma"]);
    expect(
      JSON.stringify(fixtures, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toMatch(
      /(api[_-]?key|bearer|client[_-]?secret|password|credential|token|payment[_-]?credential)/iu,
    );
  });
});

describe("generated large mock supplier catalog", () => {
  let products: readonly MockProductFixture[];
  let offers: readonly MockOfferFixture[];
  let generationDurationMs = 0;

  beforeAll(() => {
    const startedAt = performance.now();
    const generated = createGeneratedMockSupplierFixtures({
      productCount: defaultGeneratedMockCatalogSize,
      seed: "keycore-default",
    });
    generationDurationMs = performance.now() - startedAt;
    products = generated.products;
    offers = generated.offers;
  });

  it("creates exactly 50,000 products with deterministic IDs and ordering", () => {
    const repeated = createGeneratedMockSupplierFixtures({
      productCount: defaultGeneratedMockCatalogSize,
      seed: "keycore-default",
    });
    const sampleIndexes = [0, 1, 24_999, 25_000, 49_998, 49_999];

    expect(products).toHaveLength(50_000);
    expect(generationDurationMs).toBeLessThan(15_000);
    expect(
      sampleIndexes.map((index) => products[index]?.supplierProductId),
    ).toEqual(
      sampleIndexes.map((index) => repeated.products[index]?.supplierProductId),
    );
    expect(sampleIndexes.map((index) => products[index]?.title)).toEqual(
      sampleIndexes.map((index) => repeated.products[index]?.title),
    );
  });

  it("creates unique SupplierProductIds and SupplierOfferIds", () => {
    expect(
      new Set(products.map((product) => product.supplierProductId)).size,
    ).toBe(products.length);
    expect(new Set(offers.map((offer) => offer.supplierOfferId)).size).toBe(
      offers.length,
    );
    expect(offers.length).toBeGreaterThan(products.length);
  });

  it("paginates first, middle, and last pages deterministically", async () => {
    const supplier = new MockSupplier({ offers, products });
    const first = await supplier.listCatalog({ limit: 100 });
    const middle = await supplier.listCatalog({
      cursor: "mock:25000",
      limit: 100,
    });
    const last = await supplier.listCatalog({
      cursor: "mock:49900",
      limit: 100,
    });
    const repeatedMiddle = await supplier.listCatalog({
      cursor: "mock:25000",
      limit: 100,
    });

    expect(first.items).toHaveLength(100);
    expect(first.items[0]?.supplierProductId).toBe("sp-keycore-default-00000");
    expect(middle).toEqual(repeatedMiddle);
    expect(middle.items[0]?.supplierProductId).toBe("sp-keycore-default-25000");
    expect(last.items).toHaveLength(100);
    expect(last.items.at(-1)?.supplierProductId).toBe(
      "sp-keycore-default-49999",
    );
    expect(last.nextCursor).toBeUndefined();
  });

  it("filters generated delta catalog deterministically", async () => {
    const supplier = new MockSupplier({ offers, products });
    const changed = await supplier.listCatalogDelta({
      page: { limit: 100 },
      since: new Date("2026-02-04T17:10:00.000Z"),
    });
    const none = await supplier.listCatalogDelta({
      page: { limit: 100 },
      since: new Date("2026-03-01T00:00:00.000Z"),
    });

    expect(changed.items.length).toBeGreaterThan(0);
    expect(changed.items.length).toBeLessThanOrEqual(100);
    expect(none.items).toEqual([]);
  });

  it("covers all required generated region scenarios", () => {
    const scenarios = new Set(
      offers.map((offer) => offer.supplierReferenceMetadata?.regionScenario),
    );

    expect(scenarios).toEqual(
      new Set([
        "GERMANY",
        "EU",
        "GLOBAL",
        "US_ONLY",
        "LATAM",
        "CIS",
        "ASIA",
        "UNKNOWN",
        "CONTRADICTORY",
        "VPN_REQUIRED",
        "FOREIGN_ACCOUNT_REQUIRED",
      ]),
    );
  });

  it("generates varied product, offer, stock, price and currency data safely", () => {
    const productTypes = new Set(products.map((product) => product.type));
    const platforms = new Set(products.flatMap((product) => product.platforms));
    const availability = new Set(offers.map((offer) => offer.availability));
    const currencies = new Set(
      offers.map((offer) => offer.price.currency.toString()),
    );
    const prices = new Set(
      offers.slice(0, 1_000).map((offer) => offer.price.amountMinor),
    );

    expect(productTypes.size).toBeGreaterThan(1);
    expect(platforms.size).toBeGreaterThan(1);
    expect(availability).toEqual(
      new Set(["IN_STOCK", "OUT_OF_STOCK", "LIMITED", "PREORDER", "UNKNOWN"]),
    );
    expect(currencies).toEqual(new Set(["EUR", "USD", "GBP", "PLN"]));
    expect(prices.size).toBeGreaterThan(100);
  });

  it("contains no credentials or product-key material", () => {
    const sampled = {
      offers: [offers[0], offers[24_999], offers.at(-1)],
      products: [products[0], products[24_999], products.at(-1)],
    };

    expect(collectPrimitiveValues(sampled).join(" ")).not.toMatch(
      /(api[_-]?key|bearer|client[_-]?secret|password|credential|token|product[_-]?key|payment[_-]?credential)/iu,
    );
  });
});

describe("supplier framework static safety checks", () => {
  it("mock supplier performs no network imports", async () => {
    const mockRoot = path.resolve("infra/suppliers/mock");
    const files = await readdir(mockRoot);
    const findings: string[] = [];

    for (const file of files) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) {
        continue;
      }

      const content = await readFile(path.join(mockRoot, file), "utf8");
      if (/node:http|node:https|fetch|axios|kinguin|gamivo/iu.test(content)) {
        findings.push(file);
      }
    }

    expect(findings).toEqual([]);
  });

  it("core supplier framework remains real-supplier neutral", async () => {
    const sourceRoot = path.resolve("packages/platform/src");
    const files = await readdir(path.join(sourceRoot, "suppliers"));
    const findings: string[] = [];

    for (const file of files) {
      const content = await readFile(
        path.join(sourceRoot, "suppliers", file),
        "utf8",
      );
      if (/kinguin|gamivo|stripe|axios|node:http|node:https/iu.test(content)) {
        findings.push(file);
      }
    }

    expect(findings).toEqual([]);
  });
});
