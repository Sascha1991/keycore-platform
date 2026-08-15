import { describe, expect, it } from "vitest";

import {
  InMemoryCatalogSearchRepository,
  InMemoryCatalogStorefrontReevaluationQueue,
} from "../../../../infra/catalog/in-memory-search-operations.js";
import {
  CatalogOperationsService,
  CatalogSearchCursorError,
  CatalogSearchService,
  catalogSearchPolicyVersion,
  catalogSearchRefreshJobPayload,
  createCatalogSearchDocumentSourceText,
  createCatalogProductChangedEvent,
  shouldReevaluateStorefront,
  type CatalogSearchDocument,
} from "./search-operations.js";
import {
  correlationId,
  productId,
  type CorrelationId,
  type ProductId,
} from "../contracts.js";

const now = new Date("2026-08-15T00:00:00.000Z");

describe("CatalogSearchService", () => {
  it("supports exact ProductId lookup", async () => {
    const { service } = await searchableCatalog([
      document({
        productId: productId("00000000-0000-4000-8000-000000000001"),
      }),
    ]);

    await expect(
      service.findByProductId(
        productId("00000000-0000-4000-8000-000000000001"),
      ),
    ).resolves.toMatchObject({ canonicalTitle: "Alpha Game" });
  });

  it("handles exact, case-insensitive, whitespace and punctuation-normalized title search", async () => {
    const { service } = await searchableCatalog([
      document({
        canonicalTitle: "Elder Scrolls: Deluxe Edition",
        productId: productId("00000000-0000-4000-8000-000000000001"),
      }),
    ]);

    await expect(
      titles(service, "elder scrolls deluxe edition"),
    ).resolves.toEqual(["Elder Scrolls: Deluxe Edition"]);
    await expect(titles(service, "  ELDER   SCROLLS ")).resolves.toEqual([
      "Elder Scrolls: Deluxe Edition",
    ]);
    await expect(titles(service, "elder-scrolls")).resolves.toEqual([
      "Elder Scrolls: Deluxe Edition",
    ]);
  });

  it("applies platform, ProductType, edition, active, Germany and publication filters", async () => {
    const { service } = await searchableCatalog([
      document({
        canonicalTitle: "Windows Game Deluxe",
        edition: "DELUXE",
        germanyPublishable: true,
        platforms: ["WINDOWS"],
        productId: productId("00000000-0000-4000-8000-000000000001"),
        productType: "GAME",
        storefrontPublicationState: "PUBLISHED",
      }),
      document({
        active: false,
        canonicalTitle: "Linux Tool",
        germanyPublishable: false,
        platforms: ["LINUX"],
        productId: productId("00000000-0000-4000-8000-000000000002"),
        productType: "SOFTWARE",
        storefrontPublicationState: "BLOCKED",
      }),
    ]);

    const page = await service.search({
      active: true,
      editions: ["DELUXE"],
      germanyPublishable: true,
      platforms: ["WINDOWS"],
      productTypes: ["GAME"],
      publicationStates: ["PUBLISHED"],
      text: "windows",
    });

    expect(page.items.map((item) => item.document.canonicalTitle)).toEqual([
      "Windows Game Deluxe",
    ]);
  });

  it("uses deterministic ranking and ProductId tie-breakers", async () => {
    const { service } = await searchableCatalog([
      document({
        canonicalTitle: "Halo",
        productId: productId("00000000-0000-4000-8000-000000000003"),
      }),
      document({
        canonicalTitle: "Halo Infinite",
        productId: productId("00000000-0000-4000-8000-000000000002"),
      }),
      document({
        canonicalTitle: "The Halo Archive",
        productId: productId("00000000-0000-4000-8000-000000000001"),
      }),
      document({
        canonicalTitle: "Halo Infinite",
        productId: productId("00000000-0000-4000-8000-000000000000"),
      }),
    ]);

    await expect(ids(service, "halo")).resolves.toEqual([
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000000",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001",
    ]);
  });

  it("bounds default and maximum page size", async () => {
    const docs = Array.from({ length: 250 }, (_, index) =>
      document({
        canonicalTitle: `Catalog Product ${index.toString().padStart(3, "0")}`,
        productId: uuidProduct(index),
      }),
    );
    const { service } = await searchableCatalog(docs);

    expect((await service.search({})).items).toHaveLength(50);
    expect((await service.search({ limit: 500 })).items).toHaveLength(200);
  });

  it("uses cursor pagination without duplicate results and rejects invalid cursors", async () => {
    const { service } = await searchableCatalog(
      Array.from({ length: 5 }, (_, index) =>
        document({
          canonicalTitle: `Cursor Product ${index}`,
          productId: uuidProduct(index),
        }),
      ),
    );

    const first = await service.search({ limit: 2, text: "cursor" });
    const second = await service.search({
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
      limit: 2,
      text: "cursor",
    });
    expect(new Set([...idsFromPage(first), ...idsFromPage(second)]).size).toBe(
      4,
    );
    await expect(service.search({ cursor: "not-a-cursor" })).rejects.toThrow(
      CatalogSearchCursorError,
    );
  });

  it("does not use search similarity as canonical grouping evidence", async () => {
    const { service } = await searchableCatalog([
      document({
        canonicalTitle: "Same Supplier Title",
        productId: productId("00000000-0000-4000-8000-000000000001"),
      }),
      document({
        canonicalTitle: "Same Supplier Title",
        productId: productId("00000000-0000-4000-8000-000000000002"),
      }),
    ]);

    const page = await service.search({ text: "same supplier title" });
    expect(page.items).toHaveLength(2);
    expect(page.items.map((item) => item.document.productId)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
  });
});

describe("CatalogOperationsService", () => {
  it("creates, refreshes and persists versioned projections idempotently", async () => {
    const repository = new InMemoryCatalogSearchRepository([
      document({
        canonicalTitle: "Projection Product",
        productId: productId("00000000-0000-4000-8000-000000000001"),
      }),
    ]);
    const service = operations(repository);

    expect(
      await service.refreshProduct({
        correlationId: cid("refresh-1"),
        productId: productId("00000000-0000-4000-8000-000000000001"),
      }),
    ).toMatchObject({ changed: true });
    expect(
      await service.refreshProduct({
        correlationId: cid("refresh-2"),
        productId: productId("00000000-0000-4000-8000-000000000001"),
      }),
    ).toMatchObject({ changed: false });
    expect(repository.listDocuments()[0]?.searchDocumentVersion).toBe(
      catalogSearchPolicyVersion,
    );
  });

  it("refreshes changed title, platform, eligibility and disabled state", async () => {
    const id = productId("00000000-0000-4000-8000-000000000001");
    const repository = new InMemoryCatalogSearchRepository([
      document({ productId: id }),
    ]);
    const service = operations(repository);
    await service.refreshProduct({
      correlationId: cid("initial"),
      productId: id,
    });

    repository.putSourceDocument(
      document({
        active: false,
        canonicalTitle: "Changed Title",
        germanyPublishable: false,
        platforms: ["LINUX"],
        productId: id,
      }),
    );
    await service.refreshProduct({
      changeCategories: ["TITLE", "PLATFORM", "GERMANY_ELIGIBILITY", "ACTIVE"],
      correlationId: cid("changed"),
      productId: id,
    });

    expect(repository.listDocuments()[0]).toMatchObject({
      active: false,
      canonicalTitle: "Changed Title",
      germanyPublishable: false,
      platforms: ["LINUX"],
    });
  });

  it("reindexes from persisted canonical source without supplier or WooCommerce calls", async () => {
    const repository = new InMemoryCatalogSearchRepository([
      document({ productId: uuidProduct(1) }),
      document({ productId: uuidProduct(2) }),
      document({ productId: uuidProduct(3) }),
    ]);
    const service = operations(repository, { reindexBatchSize: 2 });

    const result = await service.reindex({ correlationId: cid("reindex") });

    expect(result).toMatchObject({
      changedCount: 3,
      processedCount: 3,
      status: "COMPLETED",
    });
    expect(repository.listDocuments()).toHaveLength(3);
  });

  it("keeps reindex restart safe and deterministic", async () => {
    const repository = new InMemoryCatalogSearchRepository(
      Array.from({ length: 4 }, (_, index) =>
        document({ productId: uuidProduct(index) }),
      ),
    );
    const service = operations(repository, { reindexBatchSize: 2 });

    await service.reindex({ correlationId: cid("first") });
    const second = await service.reindex({
      afterProductId: uuidProduct(1),
      correlationId: cid("second"),
    });

    expect(second.processedCount).toBe(2);
    expect(repository.listDocuments().map((item) => item.productId)).toEqual([
      "00000000-0000-4000-8000-000000000000",
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    ]);
  });

  it("records item-level batch failures without silently completing", async () => {
    class FailingSourceRepository extends InMemoryCatalogSearchRepository {
      public override async loadSearchDocument(): Promise<CatalogSearchDocument | null> {
        throw new Error("safe item failure");
      }
    }
    const failingRepository = new FailingSourceRepository([
      document({ productId: uuidProduct(1) }),
    ]);
    const service = operations(failingRepository);

    const result = await service.refreshBatch({
      correlationId: cid("batch-fail"),
      productIds: [uuidProduct(1)],
    });

    expect(result.status).toBe("FAILED");
    expect(result.failedCount).toBe(1);
  });

  it("schedules storefront reevaluation only for material changes and uses safe payloads", async () => {
    const repository = new InMemoryCatalogSearchRepository([
      document({ productId: uuidProduct(1) }),
    ]);
    const storefront = new InMemoryCatalogStorefrontReevaluationQueue();
    const service = operations(repository, { storefront });

    await service.refreshProduct({
      changeCategories: ["GERMANY_ELIGIBILITY"],
      correlationId: cid("material"),
      productId: uuidProduct(1),
    });
    await service.refreshProduct({
      changeCategories: ["WEBHOOK_REFRESH_SIGNAL"],
      correlationId: cid("signal"),
      productId: uuidProduct(1),
    });

    expect(storefront.requests).toEqual([
      { correlationId: cid("material"), productId: uuidProduct(1) },
    ]);
    expect(
      catalogSearchRefreshJobPayload({
        changeCategories: ["GERMANY_ELIGIBILITY"],
        correlationId: cid("payload"),
        productId: uuidProduct(1),
      }),
    ).toEqual({
      catalogVersion: catalogSearchPolicyVersion,
      changeCategories: ["GERMANY_ELIGIBILITY"],
      correlationId: cid("payload"),
      productId: uuidProduct(1),
    });
  });

  it("handles duplicate and out-of-order catalog change events safely", async () => {
    const repository = new InMemoryCatalogSearchRepository([
      document({
        productId: uuidProduct(1),
        updatedAt: new Date("2026-08-15T01:00:00.000Z"),
      }),
    ]);
    const service = operations(repository);
    const event = createCatalogProductChangedEvent({
      changeCategories: ["TITLE", "TITLE"],
      correlationId: cid("event"),
      observedAt: new Date("2026-08-14T01:00:00.000Z"),
      productId: uuidProduct(1),
    });

    expect(event.changeCategories).toEqual(["TITLE"]);
    await service.handleCatalogProductChanged(event);
    const duplicate = await service.handleCatalogProductChanged(event);
    expect(duplicate.changed).toBe(false);
  });

  it("uses verified Kinguin product.update webhook as a refresh signal only", () => {
    const repository = new InMemoryCatalogSearchRepository();
    const service = operations(repository);
    const accepted = service.acceptWebhookProductUpdateSignal({
      correlationId: cid("webhook"),
      receivedAt: now,
      supplier: "KINGUIN",
      supplierProductReference: "00000000-0000-4000-8000-000000000001",
      verified: true,
    });
    const rejected = service.acceptWebhookProductUpdateSignal({
      correlationId: cid("webhook-bad"),
      receivedAt: now,
      supplier: "KINGUIN",
      supplierProductReference: "00000000-0000-4000-8000-000000000001",
      verified: false,
    });

    expect(accepted).toMatchObject({
      changeCategories: ["WEBHOOK_REFRESH_SIGNAL"],
      eventType: "CATALOG_PRODUCT_CHANGED",
    });
    expect(rejected).toBeNull();
  });

  it("keeps security-sensitive fields out of search records and queue payloads", async () => {
    const safe = document({ productId: uuidProduct(1) });
    const serialized = JSON.stringify([
      safe,
      catalogSearchRefreshJobPayload({
        changeCategories: ["TITLE"],
        correlationId: cid("safe"),
        productId: uuidProduct(1),
      }),
    ]).toLowerCase();

    expect(serialized).not.toContain("api");
    expect(serialized).not.toContain("suppliercost");
    expect(serialized).not.toContain("productkey");
    expect(serialized).not.toContain("rawpayload");
  });

  it("measures 50,000-product projection rebuild and paginated search without external calls", async () => {
    const docs = Array.from({ length: 50_000 }, (_, index) =>
      document({
        canonicalTitle: `Scale Product ${index.toString().padStart(5, "0")}`,
        germanyPublishable: index % 2 === 0,
        productId: uuidProduct(index),
      }),
    );
    const repository = new InMemoryCatalogSearchRepository(docs);
    const service = operations(repository, { reindexBatchSize: 5_000 });
    const search = new CatalogSearchService({ repository });
    const started = performance.now();

    const reindex = await service.reindex({ correlationId: cid("scale") });
    const exact = await search.findByProductId(uuidProduct(42));
    const filtered = await search.search({
      germanyPublishable: true,
      limit: 25,
      text: "scale product 0004",
    });
    const elapsedMs = Math.round(performance.now() - started);

    expect(reindex.processedCount).toBe(50_000);
    expect(exact?.canonicalTitle).toBe("Scale Product 00042");
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(15_000);
  });
});

describe("Catalog change helpers", () => {
  it("classifies material storefront changes explicitly", () => {
    expect(shouldReevaluateStorefront(["TITLE"])).toBe(true);
    expect(shouldReevaluateStorefront(["AVAILABILITY"])).toBe(true);
    expect(shouldReevaluateStorefront(["WEBHOOK_REFRESH_SIGNAL"])).toBe(false);
  });

  it("builds deterministic search source text with stable platform ordering", () => {
    const left = document({
      platforms: ["LINUX", "WINDOWS"],
      productId: uuidProduct(1),
    });
    const right = document({
      platforms: ["WINDOWS", "LINUX"],
      productId: uuidProduct(2),
    });

    expect(createCatalogSearchDocumentSourceText(left)).toBe(
      createCatalogSearchDocumentSourceText(right),
    );
  });
});

const searchableCatalog = async (
  docs: readonly CatalogSearchDocument[],
): Promise<{
  readonly service: CatalogSearchService;
  readonly repository: InMemoryCatalogSearchRepository;
}> => {
  const repository = new InMemoryCatalogSearchRepository(docs);
  const service = operations(repository);
  for (const doc of docs) {
    await service.refreshProduct({
      correlationId: cid(`seed-${doc.productId}`),
      productId: doc.productId,
      requestStorefrontReevaluation: false,
    });
  }
  return {
    repository,
    service: new CatalogSearchService({ repository }),
  };
};

const operations = (
  repository: InMemoryCatalogSearchRepository,
  options?: {
    readonly reindexBatchSize?: number;
    readonly storefront?: InMemoryCatalogStorefrontReevaluationQueue;
  },
): CatalogOperationsService =>
  new CatalogOperationsService({
    projectionRepository: repository,
    projectionSource: repository,
    now: () => now,
    ...(options?.reindexBatchSize
      ? { reindexBatchSize: options.reindexBatchSize }
      : {}),
    ...(options?.storefront
      ? { storefrontReevaluation: options.storefront }
      : {}),
  });

const titles = async (
  service: CatalogSearchService,
  text: string,
): Promise<readonly string[]> =>
  (await service.search({ text })).items.map(
    (item) => item.document.canonicalTitle,
  );

const ids = async (
  service: CatalogSearchService,
  text: string,
): Promise<readonly string[]> =>
  (await service.search({ text })).items.map((item) => item.document.productId);

const idsFromPage = (page: {
  readonly items: readonly { readonly document: CatalogSearchDocument }[];
}): readonly string[] => page.items.map((item) => item.document.productId);

const document = (
  input: Partial<CatalogSearchDocument> & {
    readonly productId?: ProductId;
  } = {},
): CatalogSearchDocument => {
  const title = input.canonicalTitle ?? "Alpha Game";
  return {
    active: input.active ?? true,
    canonicalTitle: title,
    edition: input.edition ?? "STANDARD",
    germanyPublishable: input.germanyPublishable ?? true,
    normalizedSearchTitle:
      input.normalizedSearchTitle ??
      title
        .normalize("NFKC")
        .trim()
        .toLowerCase()
        .replace(/[._:|()[\]{}]+/gu, " ")
        .replace(/\s*[-/]\s*/gu, " ")
        .replace(/\s+/gu, " "),
    platforms: input.platforms ?? ["WINDOWS"],
    productId:
      input.productId ?? productId("00000000-0000-4000-8000-000000000001"),
    productType: input.productType ?? "GAME",
    searchDocumentVersion: catalogSearchPolicyVersion,
    updatedAt: input.updatedAt ?? now,
    ...(input.storefrontPublicationState
      ? { storefrontPublicationState: input.storefrontPublicationState }
      : {}),
  };
};

const uuidProduct = (index: number): ProductId =>
  productId(`00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`);

const cid = (value: string): CorrelationId => correlationId(value);
