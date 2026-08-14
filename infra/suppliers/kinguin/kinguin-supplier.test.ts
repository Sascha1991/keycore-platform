import { describe, expect, it } from "vitest";

import {
  SupplierError,
  SupplierRegistry,
  SupplierRoutingService,
  correlationId,
  currency,
  idempotencyKey,
  money,
  orderLineId,
  productId,
  supplierId,
  supplierOfferId,
  supplierProductId,
  type AuditEvent,
  type AuditEventPort,
  type JobEnvelope,
  type ProductSupplierMappingPort,
  type ProductSupplierOfferMapping,
  type ProductKeyVaultPort,
  type QueuePort,
  type SafePayload,
} from "../../../packages/platform/src/contracts.js";
import { runSupplierContractTests } from "../contract/supplier-contract-suite.js";
import {
  InMemoryKinguinOfferProductIndex,
  KinguinHttpClient,
  KinguinSupplier,
  KinguinWebhookReceiver,
  assertNoUnsafeKinguinText,
  createKinguinConfigFromEnv,
  mapRegionEvidence,
  type KinguinConfig,
  type KinguinHttpRequest,
  type KinguinHttpResponse,
  type KinguinHttpTransport,
  type SecretProvider,
} from "./kinguin-supplier.js";

const now = new Date("2026-02-01T00:00:00.000Z");
const fixtureHeaderValue = "zzz";
const textSerial = "TEST-AAAAA-BBBBB-CCCCC";

const product = {
  activationDetails: "Activate on Steam",
  ageRating: "PEGI 18",
  cheapestOfferId: ["offer-alpha"],
  countryLimitation: ["PR", "PS"],
  description: "Synthetic Kinguin fixture",
  developers: ["Fixture Dev"],
  genres: ["Action"],
  images: { cover: { thumbnail: "https://example.invalid/thumb.jpg" } },
  isPreorder: false,
  kinguinId: 1949,
  languages: ["English"],
  name: "Synthetic Kinguin Product Steam CD Key",
  offers: [
    {
      availableQty: 12,
      availableTextQty: 12,
      isPreorder: false,
      name: "Synthetic Kinguin Product Steam CD Key",
      offerId: "offer-alpha",
      price: 5.79,
      qty: 12,
      releaseDate: "2020-10-07",
      textQty: 12,
      wholesale: { enabled: false },
    },
    {
      isPreorder: true,
      name: "Synthetic Kinguin Product Preorder",
      offerId: "offer-delayed",
      price: 6.79,
      qty: 1,
      releaseDate: "2026-10-07",
      textQty: 1,
    },
    {
      isPreorder: false,
      name: "Synthetic Kinguin Product Unavailable",
      offerId: "offer-unavailable",
      price: 7.79,
      qty: 0,
      releaseDate: "2020-10-07",
      textQty: 0,
    },
  ],
  originalName: "Synthetic Kinguin Product",
  platform: "PC Steam",
  price: 5.79,
  productId: "product-alpha",
  publishers: ["Fixture Publisher"],
  qty: 12,
  regionId: 3,
  regionalLimitations: "REGION FREE",
  releaseDate: "2020-10-07",
  steam: "12345",
  tags: ["base"],
  textQty: 12,
  updatedAt: "2026-01-01T00:00:00+00:00",
};

const productPage = [
  product,
  {
    ...product,
    cheapestOfferId: ["offer-beta"],
    kinguinId: 1950,
    name: "Synthetic Kinguin Product Beta",
    offers: [
      {
        availableQty: 8,
        availableTextQty: 8,
        isPreorder: false,
        name: "Synthetic Kinguin Product Beta Steam CD Key",
        offerId: "offer-beta",
        price: 8.79,
        qty: 8,
        releaseDate: "2020-10-07",
        textQty: 8,
      },
    ],
    originalName: "Synthetic Kinguin Product Beta",
    productId: "product-beta",
    updatedAt: "2026-01-01T00:02:00+00:00",
  },
  {
    ...product,
    cheapestOfferId: ["offer-gamma"],
    kinguinId: 1951,
    name: "Synthetic Kinguin Product Gamma",
    offers: [
      {
        availableQty: 4,
        availableTextQty: 4,
        isPreorder: false,
        name: "Synthetic Kinguin Product Gamma Steam CD Key",
        offerId: "offer-gamma",
        price: 9.79,
        qty: 4,
        releaseDate: "2020-10-07",
        textQty: 4,
      },
    ],
    originalName: "Synthetic Kinguin Product Gamma",
    productId: "product-gamma",
    updatedAt: "2026-01-01T00:03:00+00:00",
  },
];

const lateProduct = {
  ...product,
  cheapestOfferId: ["offer-late"],
  countryLimitation: [],
  kinguinId: 2050,
  offers: [
    {
      availableQty: 3,
      availableTextQty: 3,
      isPreorder: false,
      name: "Synthetic Kinguin Product Late Steam CD Key",
      offerId: "offer-late",
      price: 10.79,
      qty: 3,
      releaseDate: "2020-10-07",
      textQty: 3,
    },
  ],
  productId: "product-late",
  regionId: 3,
  regionalLimitations: "REGION FREE",
};

class StaticMappingPort implements ProductSupplierMappingPort {
  public constructor(
    private readonly mappings: readonly ProductSupplierOfferMapping[],
  ) {}

  public async findSupplierOffers() {
    return this.mappings;
  }
}

class StaticSecrets implements SecretProvider {
  public constructor(
    private readonly values: Readonly<Record<string, string>>,
  ) {}

  public async getSecret(name: string): Promise<string | null> {
    return this.values[name] ?? null;
  }
}

class FakeTransport implements KinguinHttpTransport {
  public readonly requests: KinguinHttpRequest[] = [];
  public readonly logs: string[] = [];
  public timeoutOperation: string | undefined;
  public responses = new Map<string, KinguinHttpResponse>();

  public constructor() {
    this.respond("GET", "/v1/products", {
      item_count: productPage.length,
      results: productPage,
    });
    this.respond("GET", "/v2/products/product-alpha", product);
    this.respond("GET", "/v2/products/product-late", lateProduct);
    this.respond("GET", "/v1/order/order-alpha", {
      orderExternalId: "idem-alpha",
      orderId: "order-alpha",
      status: "completed",
    });
    this.respond(
      "POST",
      "/v2/order",
      {
        createdAt: "2026-01-01T00:00:00+00:00",
        orderExternalId: "idem-alpha",
        orderId: "order-alpha",
        status: "processing",
      },
      201,
    );
    this.respond("GET", "/v2/order/order-alpha/keys", [
      {
        id: "key-alpha",
        kinguinId: 1949,
        name: "Synthetic",
        offerId: "offer-alpha",
        productId: "product-alpha",
        serial: textSerial,
        type: "text/plain",
      },
    ]);
    this.respond("POST", "/v2/order/order-alpha/keys/return", [
      { id: "key-alpha", status: "DELIVERED" },
    ]);
    this.respond("GET", "/v1/regions", [{ id: 3, name: "REGION FREE" }]);
    this.respond("GET", "/v1/platforms", ["PC Steam"]);
    this.respond("GET", "/v1/genres", ["Action"]);
  }

  public respond(
    method: string,
    path: string,
    body: unknown,
    status = 200,
  ): void {
    this.responses.set(`${method} ${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      status,
    });
  }

  public async send(request: KinguinHttpRequest): Promise<KinguinHttpResponse> {
    this.requests.push(request);
    this.logs.push(
      JSON.stringify({
        body: request.body,
        headers: Object.keys(request.headers),
        path: request.path,
      }),
    );
    if (this.timeoutOperation && request.path.includes(this.timeoutOperation)) {
      throw new SupplierError({
        category: "TIMEOUT",
        operation: "fakeTransport",
        supplierId: supplierId("kinguin"),
      });
    }
    const url = new URL(request.path);
    const apiPath = url.pathname.replace(/^\/esa\/api/u, "") || "/";
    if (
      apiPath === "/v1/products" &&
      request.query?.updatedSince === "2026-01-02T00:00:00.000Z"
    ) {
      return {
        body: JSON.stringify({ item_count: 0, results: [] }),
        headers: { "content-type": "application/json" },
        status: 200,
      };
    }
    const response = this.responses.get(`${request.method} ${apiPath}`);
    if (!response) {
      return { body: "{}", headers: {}, status: 404 };
    }
    if (apiPath === "/v1/products" && response.status === 200) {
      let parsed: {
        readonly item_count?: number;
        readonly results?: readonly unknown[];
      };
      try {
        parsed = JSON.parse(response.body) as typeof parsed;
      } catch {
        return response;
      }
      if (Array.isArray(parsed.results)) {
        const limit = Number(request.query?.limit ?? 25);
        const page = Number(request.query?.page ?? 1);
        const start = (page - 1) * limit;
        return {
          ...response,
          body: JSON.stringify({
            item_count: parsed.item_count ?? parsed.results.length,
            results: parsed.results.slice(start, start + limit),
          }),
        };
      }
    }
    return response;
  }
}

class CapturingQueue implements QueuePort {
  public readonly jobs: JobEnvelope[] = [];

  public async enqueue<TPayload extends SafePayload>(
    job: JobEnvelope<TPayload>,
  ): Promise<void> {
    this.jobs.push(job);
  }
}

class CapturingAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class CapturingVault implements ProductKeyVaultPort {
  public readonly stored: Uint8Array[] = [];

  public async storeReceivedKey(
    request: Parameters<ProductKeyVaultPort["storeReceivedKey"]>[0],
  ) {
    this.stored.push(request.receivedSecretMaterial);
    return `record-${this.stored.length}` as never;
  }

  public async retrieveForAuthorizedReveal(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  public async rotateKeyEncryptionMetadata(): Promise<void> {
    return undefined;
  }

  public async retireKey(): Promise<void> {
    return undefined;
  }
}

const config = (): KinguinConfig => ({
  apiKeySecretName: "KINGUIN_API_KEY",
  baseUrl: "https://gateway.kinguin.net/esa/api",
  environment: "SANDBOX",
  maxResponseBytes: 1_000_000,
  productionPurchasingEnabled: false,
  timeoutMs: 5_000,
  webhookSecrets: {
    orderComplete: "KINGUIN_WEBHOOK_ORDER_COMPLETE_SECRET",
    orderStatus: "KINGUIN_WEBHOOK_ORDER_STATUS_SECRET",
    productUpdate: "KINGUIN_WEBHOOK_PRODUCT_UPDATE_SECRET",
  },
});

const createHarness = () => {
  const transport = new FakeTransport();
  const secrets = new StaticSecrets({
    KINGUIN_API_KEY: fixtureHeaderValue,
    KINGUIN_WEBHOOK_ORDER_COMPLETE_SECRET: "whc",
    KINGUIN_WEBHOOK_ORDER_STATUS_SECRET: "whs",
    KINGUIN_WEBHOOK_PRODUCT_UPDATE_SECRET: "whp",
  });
  const client = new KinguinHttpClient(config(), secrets, transport);
  const supplier = new KinguinSupplier(
    client,
    new InMemoryKinguinOfferProductIndex([
      {
        supplierOfferId: supplierOfferId("offer-alpha"),
        supplierProductId: supplierProductId("product-alpha"),
      },
      {
        supplierOfferId: supplierOfferId("offer-delayed"),
        supplierProductId: supplierProductId("product-alpha"),
      },
      {
        supplierOfferId: supplierOfferId("offer-unavailable"),
        supplierProductId: supplierProductId("product-alpha"),
      },
      {
        supplierOfferId: supplierOfferId("offer-late"),
        supplierProductId: supplierProductId("product-late"),
      },
    ]),
  );
  return { client, secrets, supplier, transport };
};

describe("Kinguin connector foundation", () => {
  it("adds X-Api-Key header and keeps API key absent from logs and errors", async () => {
    const { supplier, transport } = createHarness();
    await supplier.listCatalog({ limit: 25 });

    expect(transport.requests[0]?.headers["X-Api-Key"]).toBe(
      fixtureHeaderValue,
    );
    expect(transport.logs.join("\n")).not.toContain(fixtureHeaderValue);
    await expect(
      new KinguinSupplier(
        new KinguinHttpClient(config(), new StaticSecrets({}), transport),
      ).listCatalog({ limit: 25 }),
    ).rejects.toMatchObject({ category: "AUTHENTICATION" });
  });

  it("supports product search pagination and documented maximum page size", async () => {
    const { supplier, transport } = createHarness();
    transport.respond("GET", "/v1/products", {
      item_count: 101,
      results: [product],
    });
    const page = await supplier.listCatalog({ limit: 100 });

    expect(page.nextCursor).toBe("kinguin:2");
    expect(transport.requests.at(-1)?.query).toMatchObject({ limit: 100 });
    await expect(supplier.listCatalog({ limit: 101 })).rejects.toMatchObject({
      category: "INVALID_RESPONSE",
    });
  });

  it("gets product, maps not found, normalizes product, offer and EUR money", async () => {
    const { supplier, transport } = createHarness();
    transport.respond("GET", "/v2/products/missing", {}, 404);
    const found = await supplier.getProduct(supplierProductId("product-alpha"));
    const missing = await supplier.getProduct(supplierProductId("missing"));
    const offer = await supplier.getOffer(supplierOfferId("offer-alpha"));

    expect(found).toMatchObject({
      product: { platforms: ["WINDOWS"], title: "Synthetic Kinguin Product" },
      supplierProductId: "product-alpha",
    });
    expect(missing).toBeNull();
    expect(offer).toMatchObject({
      offer: { currentPrice: money(579n, currency("EUR")) },
      supplierOfferId: "offer-alpha",
    });
  });

  it("maps regionId, treats countryLimitation as exclusions and keeps missing/contradictory evidence review-required", () => {
    const evidence = mapRegionEvidence(product);
    const missing = mapRegionEvidence({ productId: "missing" });
    const contradictory = mapRegionEvidence({
      countryLimitation: ["DE"],
      productId: "conflict",
      regionId: 3,
      regionalLimitations: "Region free",
    });

    expect(evidence.supplierRegion?.supplierRegionId).toBe("3");
    expect(evidence.excludedCountries).toEqual(["PR", "PS"]);
    expect(evidence.allowedCountries).toEqual([]);
    expect(missing.hasMissingValues).toBe(true);
    expect(missing.hasUnknownValues).toBe(true);
    expect(contradictory.hasContradictoryEvidence).toBe(true);
  });

  it("sends updatedSince and updatedTo delta requests and reads reference endpoints", async () => {
    const { supplier, transport } = createHarness();
    await supplier.listCatalogDelta({
      page: { limit: 25 },
      since: new Date("2026-01-01T00:00:00.000Z"),
    });
    await supplier.searchProducts({
      limit: 25,
      updatedTo: new Date("2026-02-01T00:00:00.000Z"),
    });
    await expect(supplier.referenceData("regions")).resolves.toEqual([
      { id: 3, name: "REGION FREE" },
    ]);
    await expect(supplier.referenceData("platforms")).resolves.toEqual([
      "PC Steam",
    ]);
    await expect(supplier.referenceData("genres")).resolves.toEqual(["Action"]);

    expect(transport.requests[0]?.query).toMatchObject({
      updatedSince: "2026-01-01T00:00:00.000Z",
    });
    expect(transport.requests[1]?.query).toMatchObject({
      updatedTo: "2026-02-01T00:00:00.000Z",
    });
  });

  it("maps purchase request, orderExternalId and rejects documented qty/product limits before request", async () => {
    const { supplier, transport } = createHarness();
    await supplier.placeOrder({
      orderExternalId: "order-line-alpha",
      products: [
        {
          keyType: "text",
          offerId: "offer-alpha",
          price: money(579n, currency("EUR")),
          productId: "product-alpha",
          qty: 1,
        },
      ],
    });

    expect(transport.requests.at(-1)?.body).toEqual({
      orderExternalId: "order-line-alpha",
      products: [
        {
          keyType: "text",
          offerId: "offer-alpha",
          price: "5.79",
          productId: "product-alpha",
          qty: 1,
        },
      ],
    });
    expect(() =>
      supplier.buildPurchasePayload({
        orderExternalId: "too-many",
        products: [
          {
            price: money(100n, currency("EUR")),
            productId: "product-alpha",
            qty: 10,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      supplier.buildPurchasePayload({
        orderExternalId: "too-many-products",
        products: Array.from({ length: 11 }, () => ({
          price: money(100n, currency("EUR")),
          productId: "product-alpha",
          qty: 1,
        })),
      }),
    ).toThrow();
  });

  it("omits undocumented numeric rate limits from default health", async () => {
    const { supplier } = createHarness();
    const health = await supplier.getHealth();

    expect(health.status).toBe("UNKNOWN");
    expect(health.rateLimit).toBeUndefined();
    expect(supplier.capabilities.supportsHealthRateLimitInfo).toBe(false);
  });

  it("keeps Kinguin routable when policy allows unknown health and other rules pass", async () => {
    const { supplier } = createHarness();
    const registry = new SupplierRegistry();
    registry.register(supplier);
    const routing = new SupplierRoutingService(
      registry,
      new StaticMappingPort([
        {
          productId: productId("canonical-kinguin-late"),
          supplierId: supplierId("kinguin"),
          supplierOfferId: supplierOfferId("offer-late"),
          supplierProductId: supplierProductId("product-late"),
        },
      ]),
      { evaluate: async () => "ALLOWED" },
      { now: () => now },
    );

    const result = await routing.selectSupplier(
      {
        correlationId: correlationId("corr-kinguin-routing"),
        productId: productId("canonical-kinguin-late"),
      },
      {
        allowedCurrencies: [currency("EUR")],
        allowDegradedSuppliers: false,
        allowReviewRequired: false,
        allowUnknownHealth: true,
        comparisonCurrency: currency("EUR"),
        maxPriceAgeMs: 7 * 24 * 60 * 60 * 1_000,
        requiredCapabilities: ["PRICE_LOOKUP", "REGION_EVIDENCE", "PURCHASE"],
        requiredHealth: "HEALTHY",
        version: "kinguin-test-policy",
      },
    );

    expect(result.status).toBe("SELECTED");
    expect(result.selectedCandidate?.supplierId).toBe(supplierId("kinguin"));
    expect(result.rejectionReasons).not.toContain("RATE_LIMITED");
  });

  it("resolves offers outside the first catalog page through explicit offer-product mapping", async () => {
    const { supplier, transport } = createHarness();
    const offer = await supplier.getOffer(supplierOfferId("offer-late"));

    expect(offer).toMatchObject({
      supplierOfferId: "offer-late",
      supplierProductId: "product-late",
    });
    expect(transport.requests.at(-1)?.path).toBe(
      "https://gateway.kinguin.net/esa/api/v2/products/product-late",
    );
    expect(
      transport.requests.some((request) => {
        const url = new URL(request.path);
        return url.pathname === "/v1/products" && request.query?.page === 1;
      }),
    ).toBe(false);
  });

  it("submits purchases with exact mapped product and offer without a catalog scan", async () => {
    const { supplier, transport } = createHarness();
    const receipt = await supplier.submitPurchase({
      clientIdempotencyReference: idempotencyKey("idem-late"),
      correlationId: correlationId("corr-late"),
      orderLineId: orderLineId("line-late"),
      supplierOfferId: supplierOfferId("offer-late"),
    });
    const purchaseRequest = transport.requests.find((request) => {
      const url = new URL(request.path);
      return request.method === "POST" && url.pathname.endsWith("/v2/order");
    });

    expect(receipt.state).toBe("ACCEPTED");
    expect(purchaseRequest?.body).toEqual({
      orderExternalId: "idem-late",
      products: [
        {
          keyType: "text",
          offerId: "offer-late",
          price: "10.79",
          productId: "product-late",
          qty: 1,
        },
      ],
    });
    expect(
      transport.requests.some((request) => {
        const url = new URL(request.path);
        return url.pathname === "/v1/products";
      }),
    ).toBe(false);
  });

  it("fails closed for unknown and conflicting offer-product mappings", async () => {
    const { client, transport } = createHarness();
    const missingSupplier = new KinguinSupplier(client);
    await expect(
      missingSupplier.getOffer(supplierOfferId("offer-late")),
    ).resolves.toBeNull();

    transport.respond("GET", "/v2/products/product-alpha", {
      ...lateProduct,
      productId: "product-different",
    });
    const conflictingSupplier = new KinguinSupplier(
      client,
      new InMemoryKinguinOfferProductIndex([
        {
          supplierOfferId: supplierOfferId("offer-late"),
          supplierProductId: supplierProductId("product-alpha"),
        },
      ]),
    );
    await expect(
      conflictingSupplier.getOffer(supplierOfferId("offer-late")),
    ).rejects.toMatchObject({ category: "CONFLICT" });
  });

  it("keeps offer lookup deterministic for repeated mapped lookups", async () => {
    const { supplier, transport } = createHarness();
    const first = await supplier.getOffer(supplierOfferId("offer-late"));
    const second = await supplier.getOffer(supplierOfferId("offer-late"));

    expect(first).toEqual(second);
    expect(
      transport.requests
        .map((request) => new URL(request.path).pathname)
        .filter((path) => path.endsWith("/v2/products/product-late")),
    ).toHaveLength(2);
  });

  it("treats purchase timeout as ambiguous and routing does not fallback after ambiguous purchase", async () => {
    const { supplier, transport } = createHarness();
    transport.timeoutOperation = "/v2/order";
    const receipt = await supplier.submitPurchase({
      clientIdempotencyReference: idempotencyKey("idem-timeout"),
      correlationId: correlationId("corr-timeout"),
      orderLineId: orderLineId("line-timeout"),
      supplierOfferId: supplierOfferId("offer-alpha"),
    });
    const selectedOffer = await supplier.getOffer(
      supplierOfferId("offer-alpha"),
    );
    if (!selectedOffer) {
      throw new Error("Expected Kinguin synthetic offer");
    }
    const selection = {
      correlationId: correlationId("corr-timeout"),
      evaluatedAt: now,
      evaluatedCandidates: [
        {
          availability: "IN_STOCK",
          capabilities: supplier.capabilities,
          capturedAt: now,
          offer: selectedOffer,
          price: money(579n, currency("EUR")),
          productId: "product-alpha" as never,
          regionDecision: "REVIEW_REQUIRED",
          regionEvidence: mapRegionEvidence(product),
          rejectionReasons: [],
          safeMetadata: {},
          status: "ELIGIBLE",
          supplierHealth: { checkedAt: now, status: "HEALTHY" },
          supplierId: supplierId("kinguin"),
          supplierOfferId: supplierOfferId("offer-alpha"),
          supplierProductId: supplierProductId("product-alpha"),
        },
      ],
      failures: [],
      policyVersion: "test",
      rejectionReasons: [],
      status: "SELECTED",
    } as const;
    const registry = new SupplierRegistry();
    registry.register(supplier);
    const routing = new SupplierRoutingService(
      registry,
      { findSupplierOffers: async () => [] },
      { evaluate: async () => "REVIEW_REQUIRED" },
      { now: () => now },
    );
    const plan = await routing.createFallbackPlan({
      attempts: [
        {
          state: "AMBIGUOUS",
          supplierId: supplierId("kinguin"),
          supplierOfferId: supplierOfferId("offer-alpha"),
        },
      ],
      selection,
    });

    expect(receipt.state).toBe("AMBIGUOUS");
    expect(plan.action).toBe("RECONCILE_CURRENT_SUPPLIER_FIRST");
    expect(plan.orderedCandidates).toEqual([]);
  });

  it("maps reconciliation states", async () => {
    const { supplier, transport } = createHarness();
    await expect(
      supplier.reconcilePurchase("order-alpha"),
    ).resolves.toMatchObject({
      outcome: "RESOLVED",
    });
    transport.respond("GET", "/v1/order/order-alpha", {
      orderId: "order-alpha",
      status: "processing",
    });
    await expect(
      supplier.reconcilePurchase("order-alpha"),
    ).resolves.toMatchObject({
      outcome: "STILL_AMBIGUOUS",
    });
  });

  it("keeps text and image key retrieval behind handles and stores synthetic serials only through KeyVault", async () => {
    const { supplier, transport } = createHarness();
    const handle = await supplier.retrieveKey("order-alpha");
    transport.respond("GET", "/v2/order/order-alpha/keys", [
      {
        id: "key-image",
        productId: "product-alpha",
        serial: "VEVTVC1JTUFHRS1PTkxZ",
        type: "image/png",
      },
    ]);
    const imageHandle = await supplier.retrieveKey("order-alpha");
    const vault = new CapturingVault();
    const audit = new CapturingAudit();
    const queue = new CapturingQueue();
    transport.respond("GET", "/v2/order/order-alpha/keys", [
      {
        id: "key-alpha",
        productId: "product-alpha",
        serial: textSerial,
        type: "text/plain",
      },
    ]);
    const handoff = await supplier.storeDownloadedKeys({
      audit,
      correlationId: correlationId("corr-key"),
      keyVault: vault,
      orderLineId: orderLineId("line-key"),
      orderReference: "order-alpha",
      queue,
    });

    expect(handle.keyReference).toBe("kinguin-key:key-alpha");
    expect(imageHandle.keyReference).toBe("kinguin-key:key-image");
    expect(handoff.storedCount).toBe(1);
    expect(new TextDecoder().decode(vault.stored[0])).toBe(textSerial);
    expect(JSON.stringify(audit.events)).not.toContain(textSerial);
    expect(JSON.stringify(queue.jobs)).not.toContain(textSerial);
  });

  it("maps key return requests", async () => {
    const { supplier } = createHarness();
    await expect(supplier.returnKeys("order-alpha")).resolves.toEqual([
      { id: "key-alpha", status: "DELIVERED" },
    ]);
    await expect(
      supplier.submitRefundClaim({
        correlationId: correlationId("corr-return"),
        orderLineId: orderLineId("line-return"),
        supplierPurchaseReference: "order-alpha",
      }),
    ).resolves.toMatchObject({
      supplierClaimReference: "kinguin-return:order-alpha",
    });
  });

  it("validates product.update, order.status and deprecated order.complete webhooks", async () => {
    const { secrets } = createHarness();
    const queue = new CapturingQueue();
    const receiver = new KinguinWebhookReceiver(config(), secrets, queue);
    const productEvent = await receiver.receive({
      correlationId: correlationId("corr-webhook-product"),
      headers: {
        "X-Event-Name": "product.update",
        "X-Event-Secret": "whp",
      },
      rawBody: JSON.stringify({
        kinguinId: 1949,
        productId: "product-alpha",
        updatedAt: "2026-01-01T00:00:00.000+00:00",
      }),
      receivedAt: now,
    });
    const statusEvent = await receiver.receive({
      correlationId: correlationId("corr-webhook-status"),
      headers: {
        "X-Event-Name": "order.status",
        "X-Event-Secret": "whs",
      },
      rawBody: JSON.stringify({
        orderExternalId: "idem-alpha",
        orderId: "order-alpha",
        status: "completed",
        updatedAt: "2026-01-01T00:00:01.000+00:00",
      }),
      receivedAt: now,
    });
    const completeEvent = await receiver.receive({
      correlationId: correlationId("corr-webhook-complete"),
      headers: {
        "X-Event-Name": "order.complete",
        "X-Event-Secret": "whc",
      },
      rawBody: JSON.stringify({
        orderExternalId: "idem-alpha",
        orderId: "order-alpha",
        status: "completed",
        updatedAt: "2026-01-01T00:00:02.000+00:00",
      }),
      receivedAt: now,
    });

    expect(productEvent.eventName).toBe("product.update");
    expect(statusEvent.eventName).toBe("order.status");
    expect(completeEvent.eventName).toBe("order.complete");
    expect(queue.jobs).toHaveLength(3);
  });

  it("rejects invalid and duplicate webhooks and keeps webhook secret out of output", async () => {
    const { secrets } = createHarness();
    const receiver = new KinguinWebhookReceiver(config(), secrets);
    const request = {
      correlationId: correlationId("corr-webhook"),
      headers: {
        "X-Event-Name": "product.update",
        "X-Event-Secret": "whp",
      },
      rawBody: JSON.stringify({
        productId: "product-alpha",
        updatedAt: "2026-01-01T00:00:00.000+00:00",
      }),
      receivedAt: now,
    };
    const first = await receiver.receive(request);
    const second = await receiver.receive(request);

    expect(second.duplicate).toBe(true);
    expect(JSON.stringify(first)).not.toContain("whp");
    await expect(
      receiver.receive({
        ...request,
        headers: { "X-Event-Name": "product.update" },
      }),
    ).rejects.toMatchObject({ category: "AUTHORIZATION" });
    await expect(
      receiver.receive({ ...request, rawBody: "{" }),
    ).rejects.toMatchObject({ category: "INVALID_RESPONSE" });
  });

  it("maps malformed JSON, authentication, rate-limit, timeout and transient failures", async () => {
    const { supplier, transport } = createHarness();
    transport.responses.set("GET /v1/products", {
      body: "{",
      headers: {},
      status: 200,
    });
    await expect(supplier.listCatalog({ limit: 25 })).rejects.toMatchObject({
      category: "INVALID_RESPONSE",
    });
    for (const [status, category] of [
      [401, "AUTHENTICATION"],
      [429, "RATE_LIMIT"],
      [500, "TRANSIENT"],
    ] as const) {
      transport.responses.set("GET /v1/products", {
        body: "{}",
        headers: {},
        status,
      });
      await expect(supplier.listCatalog({ limit: 25 })).rejects.toMatchObject({
        category,
      });
    }
    transport.timeoutOperation = "/v1/products";
    await expect(supplier.listCatalog({ limit: 25 })).rejects.toMatchObject({
      category: "TIMEOUT",
    });
  });

  it("uses config placeholders without enabling production purchasing", () => {
    const loaded = createKinguinConfigFromEnv({
      KINGUIN_API_BASE_URL: "https://sandbox.example.invalid/api",
      KINGUIN_ENVIRONMENT: "PRODUCTION",
    });
    expect(loaded.environment).toBe("PRODUCTION");
    expect(loaded.productionPurchasingEnabled).toBe(false);
  });

  it("keeps source free of live HTTP in CI and no Kinguin import leaks into Core/domain", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("infra/suppliers/kinguin/kinguin-supplier.ts", "utf8"),
    );
    const coreContracts = await import("node:fs/promises").then((fs) =>
      fs.readFile("packages/platform/src/ports/supplier.ts", "utf8"),
    );
    expect(source).not.toMatch(/apiKey\s*[:=]\s*["']/u);
    expect(coreContracts).not.toMatch(/kinguin/iu);
  });

  it("rejects unsafe log text helpers", () => {
    expect(() => assertNoUnsafeKinguinText(textSerial)).toThrow();
  });
});

runSupplierContractTests({
  createSupplier: () => createHarness().supplier,
  delayedOfferId: supplierOfferId("offer-delayed"),
  knownOfferId: supplierOfferId("offer-alpha"),
  knownProductId: supplierProductId("product-alpha"),
  missingOfferId: supplierOfferId("missing-offer"),
  missingProductId: supplierProductId("missing-product"),
  unavailableOfferId: supplierOfferId("offer-unavailable"),
});
