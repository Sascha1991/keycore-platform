import { describe, expect, it } from "vitest";

import {
  buildStorefrontRepresentation,
  correlationId,
  currency,
  money,
  offerId,
  productId,
  publicationRecord,
  slugBase,
  storefrontChannel,
  storefrontProductId,
  storefrontReevaluationJobPayload,
  StorefrontAmbiguousError,
  StorefrontPublicationService,
  type AuditEvent,
  type AuditEventPort,
  type StorefrontCanonicalProduct,
  type StorefrontOfferSummary,
  type StorefrontPort,
  type StorefrontPriceProvider,
  type StorefrontProductId,
  type StorefrontProductRepresentation,
  type StorefrontPublicationSnapshot,
  type StorefrontRemoteProductSnapshot,
} from "../contracts.js";
import { InMemoryStorefrontPublicationRepository } from "../../../../infra/storefront/in-memory-publication-repository.js";

const now = new Date("2026-08-15T00:00:00.000Z");
const storefront = storefrontChannel("KEYRANO_DE");
const corr = correlationId("corr-storefront-publication");
const price = money(1999n, currency("EUR"));

describe("Storefront publication foundation", () => {
  it("publishes an active canonical product with an allowed in-stock offer and price", async () => {
    const fixture = createFixture();
    const result = await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(result).toMatchObject({
      outcome: "CREATED",
      reasonCode: "PUBLISHED_CREATED",
      state: "PUBLISHED",
    });
    expect(fixture.remote.creates).toHaveLength(1);
  });

  const blockedCases: readonly {
    readonly name: string;
    readonly snapshot: Partial<StorefrontPublicationSnapshot>;
    readonly reasonCode: string;
  }[] = [
    {
      name: "zero offers",
      reasonCode: "BLOCKED_NO_SUPPLIER_OFFERS",
      snapshot: { offers: [] },
    },
    {
      name: "only BLOCKED Germany offers",
      reasonCode: "BLOCKED_NO_ALLOWED_GERMANY_OFFER",
      snapshot: { offers: [offer({ germanyCompatibility: "BLOCKED" })] },
    },
    {
      name: "only REVIEW_REQUIRED offers",
      reasonCode: "BLOCKED_NO_ALLOWED_GERMANY_OFFER",
      snapshot: {
        offers: [offer({ germanyCompatibility: "REVIEW_REQUIRED" })],
      },
    },
    {
      name: "only DISABLED offers",
      reasonCode: "BLOCKED_NO_ALLOWED_GERMANY_OFFER",
      snapshot: { offers: [offer({ germanyCompatibility: "DISABLED" })] },
    },
    {
      name: "inactive canonical product",
      reasonCode: "BLOCKED_CANONICAL_PRODUCT_INACTIVE",
      snapshot: { product: product({ active: false }) },
    },
    {
      name: "canonical identity review required",
      reasonCode: "BLOCKED_IDENTITY_REVIEW_REQUIRED",
      snapshot: { mappings: [{ state: "REVIEW_REQUIRED" }] },
    },
    {
      name: "missing required storefront fields",
      reasonCode: "BLOCKED_REQUIRED_FIELDS_MISSING",
      snapshot: { product: product({ canonicalTitle: "" }) },
    },
    {
      name: "out-of-stock eligible offers",
      reasonCode: "BLOCKED_NO_IN_STOCK_ELIGIBLE_OFFER",
      snapshot: { offers: [offer({ availability: "OUT_OF_STOCK" })] },
    },
  ];

  for (const testCase of blockedCases) {
    it(`blocks publication for ${testCase.name}`, async () => {
      const fixture = createFixture(testCase.snapshot);
      const result = await fixture.service.publish({
        correlationId: corr,
        productId: fixture.product.productId,
        storefront,
      });

      expect(result.outcome).toBe("BLOCKED");
      expect(result.reasonCode).toBe(testCase.reasonCode);
      expect(fixture.remote.creates).toHaveLength(0);
    });
  }

  it("publishes with ALLOWED plus BLOCKED offers using only the allowed set", async () => {
    const fixture = createFixture({
      offers: [
        offer({ availability: "IN_STOCK", germanyCompatibility: "BLOCKED" }),
        offer({
          availability: "IN_STOCK",
          germanyCompatibility: "ALLOWED",
          offerId: offerId("allowed-offer"),
        }),
      ],
    });
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(fixture.priceProvider.lastEligibleOfferIds).toEqual([
      "allowed-offer",
    ]);
  });

  it("blocks when the sell price boundary returns no price", async () => {
    const fixture = createFixture();
    fixture.priceProvider.nextPrice = null;
    const result = await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(result.reasonCode).toBe("BLOCKED_PRICE_MISSING");
    expect(fixture.remote.creates).toHaveLength(0);
  });

  it("can represent out-of-stock products as not purchasable when policy allows showing them", async () => {
    const fixture = createFixture(
      { offers: [offer({ availability: "OUT_OF_STOCK" })] },
      { hideOutOfStockProducts: false },
    );
    const result = await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(result.representation).toMatchObject({
      purchasable: false,
      stockStatus: "OUT_OF_STOCK",
    });
  });

  it("repeated publication is idempotent and does not create duplicate Woo products", async () => {
    const fixture = createFixture();
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });
    const second = await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(second.outcome).toBe("NO_OP");
    expect(fixture.remote.creates).toHaveLength(1);
  });

  it("uses persisted remote mapping for title updates", async () => {
    const fixture = createFixture();
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });
    fixture.repository.putSnapshot(
      snapshot({
        product: product({ canonicalTitle: "Cyberpunk 2077 Ultimate" }),
      }),
    );
    const result = await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(result.outcome).toBe("UPDATED");
    expect(fixture.remote.updates[0]?.remoteProductId).toBe("woo-1");
  });

  it("updates the existing remote ID on price changes", async () => {
    const fixture = createFixture();
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });
    fixture.priceProvider.nextPrice = money(2499n, currency("EUR"));
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(fixture.remote.updates).toHaveLength(1);
    expect(fixture.remote.updates[0]?.product.price.amountMinor).toBe(2499n);
  });

  it("updates the existing remote ID on stock changes", async () => {
    const fixture = createFixture({}, { hideOutOfStockProducts: false });
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });
    fixture.repository.putSnapshot(
      snapshot({ offers: [offer({ availability: "OUT_OF_STOCK" })] }),
    );
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(fixture.remote.updates[0]?.product.stockStatus).toBe("OUT_OF_STOCK");
  });

  it("does not identify products by title when title collides", async () => {
    const first = createFixture();
    await first.service.publish({
      correlationId: corr,
      productId: first.product.productId,
      storefront,
    });
    const secondProduct = product({
      productId: productId("22222222-2222-4222-8222-222222222222"),
    });
    first.repository.putSnapshot(snapshot({ product: secondProduct }));
    await first.service.publish({
      correlationId: corr,
      productId: secondProduct.productId,
      storefront,
    });

    expect(first.remote.creates).toHaveLength(2);
    expect(first.remote.creates[0]?.product.slug).not.toBe(
      first.remote.creates[1]?.product.slug,
    );
  });

  it("unpublishes without hard delete when Germany eligibility is lost", async () => {
    const fixture = createFixture();
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });
    fixture.repository.putSnapshot(
      snapshot({ offers: [offer({ germanyCompatibility: "BLOCKED" })] }),
    );
    const result = await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(result.outcome).toBe("UNPUBLISHED");
    expect(fixture.remote.unpublishes).toHaveLength(1);
    expect(fixture.remote.deletes).toHaveLength(0);
  });

  it("unpublishes when canonical product is disabled", async () => {
    const fixture = createFixture();
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });
    fixture.repository.putSnapshot(
      snapshot({ product: product({ active: false }) }),
    );
    const result = await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(result.reasonCode).toBe("BLOCKED_CANONICAL_PRODUCT_INACTIVE");
    expect(fixture.remote.unpublishes).toHaveLength(1);
  });

  it("republishes using the existing remote mapping after unpublish", async () => {
    const fixture = createFixture();
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });
    fixture.repository.putSnapshot(
      snapshot({ offers: [offer({ germanyCompatibility: "BLOCKED" })] }),
    );
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });
    fixture.repository.putSnapshot(snapshot());
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(fixture.remote.creates).toHaveLength(1);
    expect(fixture.remote.updates).toHaveLength(1);
  });

  it("records FAILED for remote create failure", async () => {
    const fixture = createFixture();
    fixture.remote.failCreate = true;
    const result = await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(result).toMatchObject({
      outcome: "FAILED",
      reasonCode: "FAILED_REMOTE_CREATE",
      state: "FAILED",
    });
  });

  it("records reconciliation for ambiguous create timeout", async () => {
    const fixture = createFixture();
    fixture.remote.ambiguousCreate = true;
    const result = await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(result.outcome).toBe("RECONCILIATION_REQUIRED");
    expect(result.reasonCode).toBe("RECONCILE_AMBIGUOUS_CREATE");
  });

  it("does not blind-create duplicates after a pending ambiguous create", async () => {
    const fixture = createFixture();
    fixture.remote.ambiguousCreate = true;
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });
    fixture.remote.ambiguousCreate = false;
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(fixture.remote.creates).toHaveLength(1);
  });

  it("handles local persistence failure after remote success as reconciliation", async () => {
    const fixture = createFixture();
    fixture.repository.failOnSaveCall(2);
    const result = await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(result.outcome).toBe("RECONCILIATION_REQUIRED");
    expect(result.reasonCode).toBe(
      "RECONCILE_LOCAL_PERSISTENCE_AFTER_REMOTE_CREATE",
    );
    expect(fixture.remote.creates).toHaveLength(1);
  });

  it("fails closed when one ProductId storefront mapping is changed to another remote ID", async () => {
    const fixture = createFixture();
    await fixture.repository.savePublication(
      publicationRecord({
        now,
        productId: fixture.product.productId,
        remoteProductId: storefrontProductId("woo-existing"),
        state: "PUBLISHED",
        storefront,
      }),
    );
    await expect(
      fixture.repository.savePublication(
        publicationRecord({
          now,
          productId: fixture.product.productId,
          remoteProductId: storefrontProductId("woo-other"),
          state: "PUBLISHED",
          storefront,
        }),
      ),
    ).rejects.toThrow("MAPPING_CONFLICT_PRODUCT_STOREFRONT");
  });

  it("fails closed when one remote ID maps to two ProductIds", async () => {
    const fixture = createFixture();
    await fixture.repository.savePublication(
      publicationRecord({
        now,
        productId: fixture.product.productId,
        remoteProductId: storefrontProductId("woo-shared"),
        state: "PUBLISHED",
        storefront,
      }),
    );
    await expect(
      fixture.repository.savePublication(
        publicationRecord({
          now,
          productId: productId("33333333-3333-4333-8333-333333333333"),
          remoteProductId: storefrontProductId("woo-shared"),
          state: "PUBLISHED",
          storefront,
        }),
      ),
    ).rejects.toThrow("MAPPING_CONFLICT_REMOTE_STOREFRONT");
  });

  it("keeps supplier identifiers and costs out of customer representation", () => {
    const representation = buildStorefrontRepresentation({
      eligibleOffers: [offer()],
      price,
      product: product(),
      slug: "cyberpunk-2077",
      stockStatus: "IN_STOCK",
    });
    const serialized = JSON.stringify(representation, bigIntReplacer);

    expect(serialized).not.toContain("SupplierId");
    expect(serialized).not.toContain("SupplierOfferId");
    expect(serialized).not.toContain("SupplierProductId");
    expect(serialized).not.toContain("supplierCost");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain("TEST-AAAAA-BBBBB-CCCCC");
    expect(serialized).not.toContain("customerEmail");
    expect(serialized).not.toContain("orderReference");
  });

  it("queue payload contains only safe IDs", () => {
    const payload = storefrontReevaluationJobPayload({
      correlationId: corr,
      productId: product().productId,
      storefront,
    });

    expect(payload).toEqual({
      correlationId: corr,
      productId: product().productId,
      storefront,
    });
    expect(JSON.stringify(payload)).not.toContain("supplier");
  });

  it("emits publish, update, unpublish and reconciliation audit events", async () => {
    const fixture = createFixture();
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });
    fixture.priceProvider.nextPrice = money(2999n, currency("EUR"));
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });
    fixture.repository.putSnapshot(
      snapshot({ offers: [offer({ germanyCompatibility: "BLOCKED" })] }),
    );
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });
    const ambiguous = createFixture({
      product: product({
        productId: productId("44444444-4444-4444-8444-444444444444"),
      }),
    });
    ambiguous.remote.ambiguousCreate = true;
    await ambiguous.service.publish({
      correlationId: corr,
      productId: ambiguous.product.productId,
      storefront,
    });

    expect(fixture.audit.events.map((event) => event.eventType)).toEqual([
      "STOREFRONT_PUBLICATION_CREATED",
      "STOREFRONT_PUBLICATION_UPDATED",
      "STOREFRONT_PUBLICATION_UNPUBLISHED",
    ]);
    expect(ambiguous.audit.events[0]?.eventType).toBe(
      "STOREFRONT_PUBLICATION_RECONCILIATION_REQUIRED",
    );
  });

  it("audit metadata remains secret-safe", async () => {
    const fixture = createFixture();
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(JSON.stringify(fixture.audit.events)).not.toMatch(
      /secret|password|supplierCost|productKey|rawResponse/iu,
    );
  });

  it("creates one storefront product for a canonical product with two suppliers", async () => {
    const fixture = createFixture({
      mappings: [{ state: "AUTO_MATCHED" }, { state: "MANUAL_MATCHED" }],
      offers: [
        offer({ offerId: offerId("supplier-a-offer") }),
        offer({ offerId: offerId("supplier-b-offer") }),
      ],
    });
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(fixture.remote.creates).toHaveLength(1);
  });

  it("blocked supplier offer does not block an allowed supplier offer", async () => {
    const fixture = createFixture({
      offers: [
        offer({ germanyCompatibility: "BLOCKED" }),
        offer({ germanyCompatibility: "ALLOWED", offerId: offerId("ok") }),
      ],
    });
    const result = await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });

    expect(result.outcome).toBe("CREATED");
  });

  it("publication mapping persists across repository restart", async () => {
    const fixture = createFixture();
    await fixture.service.publish({
      correlationId: corr,
      productId: fixture.product.productId,
      storefront,
    });
    const restarted = new InMemoryStorefrontPublicationRepository({
      publications: fixture.repository.listPublications(),
      snapshots: [snapshot()],
    });

    await expect(
      restarted.findPublication({
        productId: fixture.product.productId,
        storefront,
      }),
    ).resolves.toMatchObject({ remoteProductId: "woo-1" });
  });

  it("slug generation is deterministic and human readable", () => {
    expect(slugBase("Cyberpunk 2077: Ultimate Edition")).toBe(
      "cyberpunk-2077-ultimate-edition",
    );
  });

  it("evaluates 50,000 publication fingerprints without remote calls", () => {
    const started = performance.now();
    for (let index = 0; index < 50_000; index += 1) {
      buildStorefrontRepresentation({
        eligibleOffers: [offer({ offerId: offerId(`offer-${index}`) })],
        price,
        product: product({
          canonicalTitle: `Synthetic Game ${index}`,
          productId: productId(
            `50000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
          ),
        }),
        slug: `synthetic-game-${index}`,
        stockStatus: "IN_STOCK",
      });
    }
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(5_000);
  });
});

class FixedPriceProvider implements StorefrontPriceProvider {
  public nextPrice = price as ReturnType<typeof money> | null;
  public lastEligibleOfferIds: readonly string[] = [];

  public async quoteSellPrice(input: {
    readonly eligibleOffers: readonly StorefrontOfferSummary[];
  }): Promise<ReturnType<typeof money> | null> {
    this.lastEligibleOfferIds = input.eligibleOffers.map(
      (eligibleOffer) => eligibleOffer.offerId,
    );
    return this.nextPrice;
  }
}

class FakeStorefront implements StorefrontPort {
  public readonly creates: {
    readonly product: StorefrontProductRepresentation;
  }[] = [];
  public readonly updates: {
    readonly remoteProductId: StorefrontProductId;
    readonly product: StorefrontProductRepresentation;
  }[] = [];
  public readonly unpublishes: readonly unknown[] = [];
  public readonly deletes: readonly unknown[] = [];
  public failCreate = false;
  public ambiguousCreate = false;

  public async createProduct(
    product: StorefrontProductRepresentation,
  ): Promise<StorefrontProductId> {
    this.creates.push({ product });
    if (this.ambiguousCreate) {
      throw new StorefrontAmbiguousError();
    }
    if (this.failCreate) {
      throw new Error("Remote create failed");
    }
    return storefrontProductId(`woo-${this.creates.length}`);
  }

  public async updateProduct(input: {
    readonly remoteProductId: StorefrontProductId;
    readonly product: StorefrontProductRepresentation;
  }): Promise<void> {
    this.updates.push(input);
  }

  public async unpublishProduct(input: {
    readonly remoteProductId: StorefrontProductId;
  }): Promise<void> {
    (this.unpublishes as unknown[]).push(input);
  }

  public async readProduct(): Promise<StorefrontRemoteProductSnapshot | null> {
    return null;
  }

  public async validateConfiguration(): Promise<"HEALTHY"> {
    return "HEALTHY";
  }
}

class CapturingAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const createFixture = (
  override: Partial<StorefrontPublicationSnapshot> = {},
  options: { readonly hideOutOfStockProducts?: boolean } = {},
) => {
  const fixtureProduct = override.product ?? product();
  const repository = new InMemoryStorefrontPublicationRepository({
    snapshots: [snapshot({ ...override, product: fixtureProduct })],
  });
  const remote = new FakeStorefront();
  const priceProvider = new FixedPriceProvider();
  const audit = new CapturingAudit();
  const serviceOptions = {
    audit,
    now: () => now,
    priceProvider,
    repository,
    storefront: remote,
    ...(options.hideOutOfStockProducts === undefined
      ? {}
      : { hideOutOfStockProducts: options.hideOutOfStockProducts }),
  };
  const service = new StorefrontPublicationService(serviceOptions);
  return {
    audit,
    priceProvider,
    product: fixtureProduct,
    remote,
    repository,
    service,
  };
};

const snapshot = (
  override: Partial<StorefrontPublicationSnapshot> = {},
): StorefrontPublicationSnapshot => ({
  mappings: [{ state: "AUTO_MATCHED" }],
  offers: [offer()],
  product: product(),
  ...override,
});

const product = (
  override: Partial<StorefrontCanonicalProduct> = {},
): StorefrontCanonicalProduct => ({
  active: true,
  canonicalTitle: "Cyberpunk 2077",
  edition: "STANDARD",
  lifecycle: "IN_STOCK",
  platforms: ["WINDOWS"],
  productId: productId("11111111-1111-4111-8111-111111111111"),
  productType: "GAME",
  safeDescription: "KeyCore catalog product.",
  safeIdentifiers: [{ type: "STEAM_APP_ID", value: "1091500" }],
  ...override,
});

const offer = (
  override: Partial<StorefrontOfferSummary> = {},
): StorefrontOfferSummary => ({
  active: true,
  availability: "IN_STOCK",
  germanyCompatibility: "ALLOWED",
  offerId: offerId("offer-allowed"),
  ...override,
});

const bigIntReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;
