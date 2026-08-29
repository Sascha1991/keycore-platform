import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { InMemoryCatalogSyncRepository } from "../../../../infra/catalog/in-memory-catalog-repository.js";
import {
  createGeneratedMockSupplierFixtures,
  MockSupplier,
  type MockOfferFixture,
} from "../../../../infra/suppliers/mock/mock-supplier.js";
import {
  CatalogSyncService,
  StaticCatalogOfferDiscovery,
  catalogOfferProductMappingChangedMessage,
  createOfferPriceSnapshot,
  createPriceRevalidationJobPayload,
} from "./synchronization.js";
import {
  GermanyEligibilityEngine,
  germanyEligibilityPolicyVersion,
} from "./germany-eligibility.js";
import type {
  CatalogSyncPageProduct,
  NormalizedSupplierOffer,
  NormalizedSupplierProduct,
} from "../contracts.js";

const fixedNow = new Date("2026-08-14T10:00:00.000Z");

describe("catalog synchronization foundation", () => {
  it("runs a full sync and stores normalized products, offers, mappings and Germany decisions", async () => {
    const fixtures = createGeneratedMockSupplierFixtures({
      productCount: 12,
      seed: "sync",
    });
    const supplier = new MockSupplier(fixtures);
    const repository = new InMemoryCatalogSyncRepository();
    const service = new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      now: () => fixedNow,
      offerDiscovery: new StaticCatalogOfferDiscovery(
        await normalizedOffers(supplier, fixtures.offers),
      ),
      pageLimit: 5,
      repository,
    });

    const result = await service.runFullSync(supplier);

    expect(result.run.status).toBe("SUCCEEDED");
    expect(result.run.metrics.productsSeen).toBe(12);
    expect(result.run.metrics.offersSeen).toBe(14);
    expect(repository.listProducts()).toHaveLength(12);
    expect(repository.listOffers()).toHaveLength(14);
    expect(repository.listOffers()[0]?.germanyPolicyVersion).toBe(
      germanyEligibilityPolicyVersion,
    );
  });

  it("does not persist raw supplier payloads in repository records", async () => {
    const fixtures = createGeneratedMockSupplierFixtures({
      productCount: 1,
      seed: "payload",
    });
    const supplier = new MockSupplier(fixtures);
    const repository = new InMemoryCatalogSyncRepository();
    await new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      offerDiscovery: new StaticCatalogOfferDiscovery(
        await normalizedOffers(supplier, fixtures.offers),
      ),
      repository,
    }).runFullSync(supplier);

    const serialized = JSON.stringify(repository.listOffers(), (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toContain("raw");
  });

  it("keeps durable SupplierId plus SupplierOfferId mapping to SupplierProductId", async () => {
    const fixtures = createGeneratedMockSupplierFixtures({
      productCount: 2,
      seed: "mapping",
    });
    const supplier = new MockSupplier(fixtures);
    const repository = new InMemoryCatalogSyncRepository();
    await new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      offerDiscovery: new StaticCatalogOfferDiscovery(
        await normalizedOffers(supplier, fixtures.offers),
      ),
      repository,
    }).runFullSync(supplier);

    const firstOffer = requiredFixture(fixtures.offers[0]);
    await expect(
      repository.getOfferMapping({
        supplierId: supplier.identity.supplierId,
        supplierOfferId: firstOffer.supplierOfferId,
      }),
    ).resolves.toBe(firstOffer.supplierProductId);
  });

  it("fails closed deterministically if an offer mapping moves to another product without reconciliation", async () => {
    const fixtures = createGeneratedMockSupplierFixtures({
      productCount: 2,
      seed: "swap",
    });
    const supplier = new MockSupplier(fixtures);
    const repository = new InMemoryCatalogSyncRepository();
    const normalOffers = await normalizedOffers(supplier, fixtures.offers);
    await new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      offerDiscovery: new StaticCatalogOfferDiscovery(normalOffers),
      repository,
    }).runFullSync(supplier);
    const originalOffer = requiredOffer(normalOffers[0] ?? null);
    const otherProductOffer = findOfferForDifferentProduct(
      normalOffers,
      originalOffer.supplierProductId,
    );
    const originalCheckpoint = await repository.getCheckpoint({
      mode: "FULL",
      supplierId: supplier.identity.supplierId,
    });

    const moved = {
      ...originalOffer,
      supplierProductId: otherProductOffer.supplierProductId,
    };
    const service = new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      offerDiscovery: new StaticCatalogOfferDiscovery([moved]),
      now: () => new Date("2026-08-14T10:05:00.000Z"),
      repository,
    });
    const secondProduct = await supplier.getProduct(
      otherProductOffer.supplierProductId,
    );

    const result = await service.ingestWebhook({
      offers: [moved],
      product: requiredProduct(secondProduct),
      supplier,
    });

    expect(result.run.status).toBe("FAILED");
    expect(result.run.errorMessage).toBe(
      catalogOfferProductMappingChangedMessage,
    );
    await expect(
      repository.getOfferMapping({
        supplierId: supplier.identity.supplierId,
        supplierOfferId: originalOffer.supplierOfferId,
      }),
    ).resolves.toBe(originalOffer.supplierProductId);
    await expect(
      repository.getCheckpoint({
        mode: "FULL",
        supplierId: supplier.identity.supplierId,
      }),
    ).resolves.toEqual(originalCheckpoint);

    const repeated = await service.ingestWebhook({
      offers: [moved],
      product: requiredProduct(secondProduct),
      supplier,
    });

    expect(repeated.run.status).toBe("FAILED");
    expect(repeated.run.errorMessage).toBe(
      catalogOfferProductMappingChangedMessage,
    );
  });

  it("advances incremental checkpoints only after success", async () => {
    const fixtures = createGeneratedMockSupplierFixtures({
      productCount: 3,
      seed: "delta",
    });
    const supplier = new MockSupplier(fixtures);
    const repository = new InMemoryCatalogSyncRepository();
    const service = new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      now: () => fixedNow,
      offerDiscovery: new StaticCatalogOfferDiscovery(
        await normalizedOffers(supplier, fixtures.offers),
      ),
      repository,
    });

    const result = await service.runIncrementalSync(supplier);

    expect(result.run.status).toBe("SUCCEEDED");
    expect(
      await repository.getCheckpoint({
        mode: "INCREMENTAL",
        supplierId: supplier.identity.supplierId,
      }),
    ).toMatchObject({
      highWatermark: fixedNow,
      mode: "INCREMENTAL",
    });
  });

  it("does not deactivate missing records during incremental sync", async () => {
    const fixtures = createGeneratedMockSupplierFixtures({
      productCount: 4,
      seed: "partial",
    });
    const supplier = new MockSupplier(fixtures);
    const repository = new InMemoryCatalogSyncRepository();
    const service = new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      now: () => fixedNow,
      offerDiscovery: new StaticCatalogOfferDiscovery(
        await normalizedOffers(supplier, fixtures.offers),
      ),
      pageLimit: 2,
      repository,
    });

    await service.runFullSync(supplier);
    await service.runIncrementalSync(supplier);

    expect(repository.listProducts().every((product) => product.active)).toBe(
      true,
    );
  });

  it("deactivates stale records after a later full sync", async () => {
    const fullFixtures = createGeneratedMockSupplierFixtures({
      productCount: 3,
      seed: "stale",
    });
    const reducedFixtures = {
      offers: [requiredFixture(fullFixtures.offers[0])],
      products: [requiredFixture(fullFixtures.products[0])],
    };
    const repository = new InMemoryCatalogSyncRepository();
    await new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      offerDiscovery: new StaticCatalogOfferDiscovery(
        await normalizedOffers(
          new MockSupplier(fullFixtures),
          fullFixtures.offers,
        ),
      ),
      repository,
    }).runFullSync(new MockSupplier(fullFixtures));

    const reducedSupplier = new MockSupplier(reducedFixtures);
    const result = await new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      offerDiscovery: new StaticCatalogOfferDiscovery(
        await normalizedOffers(reducedSupplier, reducedFixtures.offers),
      ),
      repository,
    }).runFullSync(reducedSupplier);

    expect(result.run.metrics.staleProductsDeactivated).toBe(2);
    expect(result.run.metrics.staleOffersDeactivated).toBe(3);
  });

  it("returns a safe unsupported result for suppliers without delta catalog", async () => {
    const supplier = new MockSupplier({
      capabilities: { supportsDeltaCatalog: false },
    });
    const service = new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      offerDiscovery: new StaticCatalogOfferDiscovery([]),
      repository: new InMemoryCatalogSyncRepository(),
    });

    const result = await service.runIncrementalSync(supplier);

    expect(result).toMatchObject({
      unsupported: true,
      run: { status: "SUCCEEDED" },
    });
  });

  it("creates queue-safe price revalidation payloads without secrets", () => {
    const payload = createPriceRevalidationJobPayload({
      requestedAt: fixedNow,
      supplierId: "supplier-a" as never,
      supplierOfferId: "offer-a" as never,
    });

    expect(payload).toEqual({
      kind: "CATALOG_PRICE_REVALIDATION",
      policyVersion: germanyEligibilityPolicyVersion,
      requestedAt: fixedNow.toISOString(),
      supplierId: "supplier-a",
      supplierOfferId: "offer-a",
    });
    expect(JSON.stringify(payload).toLowerCase()).not.toContain("key");
  });

  it("keeps offer price snapshots normalized", async () => {
    const fixtures = createGeneratedMockSupplierFixtures({
      productCount: 1,
      seed: "price",
    });
    const supplier = new MockSupplier(fixtures);
    const offer = await supplier.getOffer(
      requiredFixture(fixtures.offers[0]).supplierOfferId,
    );

    expect(createOfferPriceSnapshot(requiredOffer(offer))).toMatchObject({
      availability: requiredOffer(offer).offer.availability,
      capturedAt: requiredOffer(offer).capturedAt,
      offerId: requiredOffer(offer).offer.offerId,
      price: requiredOffer(offer).offer.currentPrice,
    });
  });

  it("uses bounded repository page upserts when the adapter supports them", async () => {
    const fixtures = createGeneratedMockSupplierFixtures({
      productCount: 12,
      seed: "batch",
    });
    const supplier = new MockSupplier(fixtures);
    const repository = new RecordingBatchCatalogRepository();
    const result = await new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      offerDiscovery: new StaticCatalogOfferDiscovery(
        await normalizedOffers(supplier, fixtures.offers),
      ),
      pageLimit: 5,
      repository,
    }).runFullSync(supplier);

    expect(result.run.status).toBe("SUCCEEDED");
    expect(repository.pageSizes).toEqual([5, 5, 2]);
    expect(repository.listProducts()).toHaveLength(12);
    expect(repository.listOffers()).toHaveLength(14);
  });

  it("fails a batch before persistence when one page repeats an identity", async () => {
    const fixtures = createGeneratedMockSupplierFixtures({
      productCount: 1,
      seed: "duplicate-page",
    });
    const product = requiredFixture(fixtures.products[0]);
    const supplier = new MockSupplier({
      offers: fixtures.offers,
      products: [product, product],
    });
    const repository = new RecordingBatchCatalogRepository();
    const result = await new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      offerDiscovery: new StaticCatalogOfferDiscovery(
        await normalizedOffers(supplier, fixtures.offers),
      ),
      pageLimit: 10,
      repository,
    }).runFullSync(supplier);

    expect(result.run).toMatchObject({
      errorMessage: "Duplicate supplier product identity in catalog page",
      status: "FAILED",
    });
    expect(repository.listProducts()).toHaveLength(0);
    expect(repository.listOffers()).toHaveLength(0);
  });

  it("processes 50,000 synthetic products within the foundation scale budget", async () => {
    const fixtures = createGeneratedMockSupplierFixtures({
      productCount: 50_000,
      seed: "scale",
    });
    const supplier = new MockSupplier(fixtures);
    const start = performance.now();
    const result = await new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      offerDiscovery: new StaticCatalogOfferDiscovery(
        await normalizedOffers(supplier, fixtures.offers),
      ),
      pageLimit: 100,
      repository: new InMemoryCatalogSyncRepository(),
    }).runFullSync(supplier);
    const runtimeMs = performance.now() - start;

    expect(result.run.status).toBe("SUCCEEDED");
    expect(result.run.metrics.productsSeen).toBe(50_000);
    expect(result.run.metrics.offersSeen).toBe(55_000);
    expect(runtimeMs).toBeLessThan(15_000);
  });
});

const normalizedOffers = async (
  supplier: MockSupplier,
  offers: readonly MockOfferFixture[],
): Promise<readonly NormalizedSupplierOffer[]> =>
  Promise.all(
    offers.map(async (offer) =>
      requiredOffer(await supplier.getOffer(offer.supplierOfferId)),
    ),
  );

const requiredOffer = (
  offer: NormalizedSupplierOffer | null,
): NormalizedSupplierOffer => {
  if (!offer) {
    throw new Error("Expected normalized supplier offer fixture");
  }
  return offer;
};

const requiredProduct = (
  product: NormalizedSupplierProduct | null,
): NormalizedSupplierProduct => {
  if (!product) {
    throw new Error("Expected normalized supplier product fixture");
  }
  return product;
};

const findOfferForDifferentProduct = (
  offers: readonly NormalizedSupplierOffer[],
  supplierProductId: string,
): NormalizedSupplierOffer => {
  const offer = offers.find(
    (candidate) => candidate.supplierProductId !== supplierProductId,
  );
  if (!offer) {
    throw new Error("Expected generated fixture with another product offer");
  }
  return offer;
};

const requiredFixture = <TFixture>(fixture: TFixture | undefined): TFixture => {
  if (!fixture) {
    throw new Error("Expected generated fixture");
  }
  return fixture;
};

class RecordingBatchCatalogRepository extends InMemoryCatalogSyncRepository {
  public readonly pageSizes: number[] = [];

  public async upsertPage(input: {
    readonly products: readonly CatalogSyncPageProduct[];
    readonly runId: string;
    readonly observedAt: Date;
  }): Promise<void> {
    this.pageSizes.push(input.products.length);
    for (const product of input.products) {
      await this.upsertProduct({
        observedAt: input.observedAt,
        product: product.product,
        runId: input.runId,
      });
      for (const offer of product.offers) {
        await this.upsertOffer({
          assessment: offer.assessment,
          observedAt: input.observedAt,
          offer: offer.offer,
          runId: input.runId,
        });
      }
    }
  }
}
