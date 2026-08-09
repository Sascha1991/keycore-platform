import {
  assertSupplierCapability,
  correlationId,
  currency,
  idempotencyKey,
  money,
  offerId,
  orderLineId,
  productId,
  regionCode,
  supplierId,
  supplierOfferId,
  supplierProductId,
  SupplierError,
  type Availability,
  type CatalogDeltaRequest,
  type Money,
  type NormalizedSupplierOffer,
  type NormalizedSupplierProduct,
  type Page,
  type PageRequest,
  type Platform,
  type PriceSnapshot,
  type ProductType,
  type PurchaseReceipt,
  type PurchaseRequest,
  type RateLimitMetadata,
  type ReconciliationResult,
  type RefundClaimReceipt,
  type RefundClaimRequest,
  type RegionEvidence,
  type SupplierCapabilities,
  type SupplierHealth,
  type SupplierIdentity,
  type SupplierKeyHandle,
  type SupplierObservabilityPort,
  type SupplierOfferId,
  type SupplierPort,
  type SupplierProductId,
} from "../../../packages/platform/src/contracts.js";

export type MockPurchaseScenario =
  | "ACCEPTED_IMMEDIATE"
  | "DELAYED_FULFILLMENT"
  | "UNAVAILABLE"
  | "TRANSIENT_ERROR"
  | "TERMINAL_REJECTION"
  | "AMBIGUOUS";

export type MockFault =
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "TRANSIENT_ERROR"
  | "TERMINAL_ERROR"
  | "MALFORMED_RESPONSE_SIMULATION";

export interface MockProductFixture {
  readonly supplierProductId: SupplierProductId;
  readonly keycoreProductId: ReturnType<typeof productId>;
  readonly title: string;
  readonly type: ProductType;
  readonly platforms: readonly Platform[];
  readonly lifecycle: Availability;
  readonly changedAt: Date;
}

export interface MockOfferFixture {
  readonly supplierOfferId: SupplierOfferId;
  readonly supplierProductId: SupplierProductId;
  readonly keycoreOfferId: ReturnType<typeof offerId>;
  readonly price: Money;
  readonly availability: Availability;
  readonly regionEvidence: RegionEvidence;
  readonly capturedAt: Date;
  readonly changedAt: Date;
  readonly purchaseScenario: MockPurchaseScenario;
  readonly supplierReferenceMetadata?: Readonly<
    Record<string, string | number | boolean | null>
  >;
}

export interface MockSupplierOptions {
  readonly identity?: SupplierIdentity;
  readonly capabilities?: Partial<SupplierCapabilities>;
  readonly products?: readonly MockProductFixture[];
  readonly offers?: readonly MockOfferFixture[];
  readonly health?: SupplierHealth;
  readonly faultByOperation?: Readonly<Record<string, MockFault>>;
  readonly observability?: SupplierObservabilityPort;
}

interface PurchaseRecord {
  readonly semanticRequest: string;
  readonly receipt: PurchaseReceipt;
  readonly scenario: MockPurchaseScenario;
}

const defaultCapabilities: SupplierCapabilities = {
  supportsDelayedFulfillment: true,
  supportsDeltaCatalog: true,
  supportsFullCatalog: true,
  supportsHealthRateLimitInfo: true,
  supportsKeyRetrieval: true,
  supportsPriceLookup: true,
  supportsPurchase: true,
  supportsPurchaseStatusReconciliation: true,
  supportsRefundClaims: true,
  supportsRegionEvidence: true,
};

const defaultIdentity: SupplierIdentity = {
  contractVersion: { major: 1, minor: 0 },
  displayName: "Mock Supplier",
  supplierId: supplierId("mock-supplier"),
};

const fixedNow = new Date("2026-01-01T00:00:00.000Z");

const safeRateLimit = (): RateLimitMetadata => ({
  limit: 1_000,
  remaining: 999,
  resetAt: new Date("2026-01-01T01:00:00.000Z"),
});

const knownRegionEvidence = (): RegionEvidence => ({
  activationRestrictions: [],
  allowedCountries: [regionCode("DE")],
  excludedCountries: [],
  hasContradictoryEvidence: false,
  hasMissingValues: false,
  hasUnknownValues: false,
  requiresForeignAccount: false,
  requiresVpn: false,
  supplierRegion: {
    documentedSemanticsSummary: "Synthetic Germany-allowed fixture",
    supplierRegionId: "mock-de",
  },
});

const unknownRegionEvidence = (): RegionEvidence => ({
  activationRestrictions: [],
  allowedCountries: [],
  excludedCountries: [],
  hasContradictoryEvidence: false,
  hasMissingValues: true,
  hasUnknownValues: true,
  requiresForeignAccount: "UNKNOWN",
  requiresVpn: "UNKNOWN",
  supplierRegion: {
    documentedSemanticsSummary: "Synthetic unknown fixture",
    supplierRegionId: "mock-unknown",
  },
});

const contradictoryRegionEvidence = (): RegionEvidence => ({
  activationRestrictions: [
    { kind: "UNKNOWN", description: "Synthetic conflict" },
  ],
  allowedCountries: [regionCode("DE")],
  excludedCountries: [regionCode("DE")],
  hasContradictoryEvidence: true,
  hasMissingValues: false,
  hasUnknownValues: false,
  requiresForeignAccount: false,
  requiresVpn: false,
  supplierRegion: {
    documentedSemanticsSummary: "Synthetic contradictory fixture",
    supplierRegionId: "mock-conflict",
  },
});

export const createDefaultMockSupplierFixtures = (): {
  readonly products: readonly MockProductFixture[];
  readonly offers: readonly MockOfferFixture[];
} => {
  const products: readonly MockProductFixture[] = [
    {
      changedAt: new Date("2026-01-01T00:01:00.000Z"),
      keycoreProductId: productId("product-mock-alpha"),
      lifecycle: "IN_STOCK",
      platforms: ["WINDOWS"],
      supplierProductId: supplierProductId("sp-alpha"),
      title: "Synthetic Alpha",
      type: "GAME",
    },
    {
      changedAt: new Date("2026-01-01T00:02:00.000Z"),
      keycoreProductId: productId("product-mock-beta"),
      lifecycle: "LIMITED",
      platforms: ["MACOS", "LINUX"],
      supplierProductId: supplierProductId("sp-beta"),
      title: "Synthetic Beta",
      type: "SOFTWARE",
    },
    {
      changedAt: new Date("2026-01-01T00:03:00.000Z"),
      keycoreProductId: productId("product-mock-gamma"),
      lifecycle: "UNKNOWN",
      platforms: ["UNKNOWN"],
      supplierProductId: supplierProductId("sp-gamma"),
      title: "Synthetic Gamma",
      type: "UNKNOWN",
    },
  ];

  const offers: readonly MockOfferFixture[] = [
    {
      availability: "IN_STOCK",
      capturedAt: fixedNow,
      changedAt: new Date("2026-01-01T00:04:00.000Z"),
      keycoreOfferId: offerId("offer-mock-alpha-eur"),
      price: money(1_299n, currency("EUR")),
      purchaseScenario: "ACCEPTED_IMMEDIATE",
      regionEvidence: knownRegionEvidence(),
      supplierOfferId: supplierOfferId("so-alpha-eur"),
      supplierProductId: supplierProductId("sp-alpha"),
      supplierReferenceMetadata: { fixture: "alpha", tier: 1 },
    },
    {
      availability: "LIMITED",
      capturedAt: fixedNow,
      changedAt: new Date("2026-01-01T00:05:00.000Z"),
      keycoreOfferId: offerId("offer-mock-alpha-usd"),
      price: money(1_499n, currency("USD")),
      purchaseScenario: "DELAYED_FULFILLMENT",
      regionEvidence: unknownRegionEvidence(),
      supplierOfferId: supplierOfferId("so-alpha-usd"),
      supplierProductId: supplierProductId("sp-alpha"),
      supplierReferenceMetadata: { fixture: "alpha-delayed", tier: 2 },
    },
    {
      availability: "OUT_OF_STOCK",
      capturedAt: fixedNow,
      changedAt: new Date("2026-01-01T00:06:00.000Z"),
      keycoreOfferId: offerId("offer-mock-beta-eur"),
      price: money(899n, currency("EUR")),
      purchaseScenario: "UNAVAILABLE",
      regionEvidence: contradictoryRegionEvidence(),
      supplierOfferId: supplierOfferId("so-beta-eur"),
      supplierProductId: supplierProductId("sp-beta"),
    },
    {
      availability: "PREORDER",
      capturedAt: fixedNow,
      changedAt: new Date("2026-01-01T00:07:00.000Z"),
      keycoreOfferId: offerId("offer-mock-gamma-eur"),
      price: money(2_499n, currency("EUR")),
      purchaseScenario: "AMBIGUOUS",
      regionEvidence: unknownRegionEvidence(),
      supplierOfferId: supplierOfferId("so-gamma-eur"),
      supplierProductId: supplierProductId("sp-gamma"),
    },
    {
      availability: "UNKNOWN",
      capturedAt: fixedNow,
      changedAt: new Date("2026-01-01T00:08:00.000Z"),
      keycoreOfferId: offerId("offer-mock-beta-terminal"),
      price: money(999n, currency("EUR")),
      purchaseScenario: "TERMINAL_REJECTION",
      regionEvidence: unknownRegionEvidence(),
      supplierOfferId: supplierOfferId("so-beta-terminal"),
      supplierProductId: supplierProductId("sp-beta"),
    },
  ];

  return { offers, products };
};

const encodeCursor = (index: number): string => `mock:${index}`;

const decodeCursor = (cursor?: string): number => {
  if (!cursor) {
    return 0;
  }

  const match = /^mock:(\d+)$/u.exec(cursor);
  if (!match?.[1]) {
    throw new SupplierError({
      category: "INVALID_RESPONSE",
      operation: "decodeCursor",
      supplierId: defaultIdentity.supplierId,
    });
  }

  return Number.parseInt(match[1], 10);
};

const pageItems = <TItem>(
  items: readonly TItem[],
  page: PageRequest,
): Page<TItem> => {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100) {
    throw new SupplierError({
      category: "INVALID_RESPONSE",
      operation: "pageItems",
      supplierId: defaultIdentity.supplierId,
    });
  }

  const start = decodeCursor(page.cursor);
  const selected = items.slice(start, start + page.limit);
  const nextIndex = start + selected.length;

  if (nextIndex < items.length) {
    return {
      items: selected,
      nextCursor: encodeCursor(nextIndex),
    };
  }

  return { items: selected };
};

export class MockSupplier implements SupplierPort {
  public readonly identity: SupplierIdentity;
  public readonly capabilities: SupplierCapabilities;
  private readonly products: readonly MockProductFixture[];
  private readonly offers: readonly MockOfferFixture[];
  private readonly purchases = new Map<string, PurchaseRecord>();
  private readonly refunds = new Map<string, RefundClaimReceipt>();
  private readonly faultByOperation: Readonly<Record<string, MockFault>>;
  private readonly observability: SupplierObservabilityPort | undefined;
  private readonly health: SupplierHealth;

  public constructor(options: MockSupplierOptions = {}) {
    const fixtures = createDefaultMockSupplierFixtures();
    this.identity = options.identity ?? defaultIdentity;
    this.capabilities = { ...defaultCapabilities, ...options.capabilities };
    this.products = [...(options.products ?? fixtures.products)].sort(
      (left, right) =>
        left.supplierProductId.localeCompare(right.supplierProductId),
    );
    this.offers = [...(options.offers ?? fixtures.offers)].sort((left, right) =>
      left.supplierOfferId.localeCompare(right.supplierOfferId),
    );
    this.faultByOperation = options.faultByOperation ?? {};
    this.observability = options.observability;
    this.health =
      options.health ??
      ({
        checkedAt: fixedNow,
        rateLimit: safeRateLimit(),
        status: "HEALTHY",
      } satisfies SupplierHealth);
    this.validateRateLimit(this.health.rateLimit);
  }

  public async listCatalog(
    page: PageRequest,
  ): Promise<Page<NormalizedSupplierProduct>> {
    this.throwFault("listCatalog");
    assertSupplierCapability(this.capabilities.supportsFullCatalog, {
      category: "UNSUPPORTED_CAPABILITY",
      operation: "listCatalog",
      supplierId: this.identity.supplierId,
    });

    return pageItems(
      this.products.map((product) => this.normalizeProduct(product)),
      page,
    );
  }

  public async listCatalogDelta(
    request: CatalogDeltaRequest,
  ): Promise<Page<NormalizedSupplierProduct>> {
    this.throwFault("listCatalogDelta");
    assertSupplierCapability(this.capabilities.supportsDeltaCatalog, {
      category: "UNSUPPORTED_CAPABILITY",
      operation: "listCatalogDelta",
      supplierId: this.identity.supplierId,
    });

    const changed = this.products.filter(
      (product) => product.changedAt.getTime() > request.since.getTime(),
    );
    return pageItems(
      changed.map((product) => this.normalizeProduct(product)),
      request.page,
    );
  }

  public async getProduct(
    productReference: SupplierProductId,
  ): Promise<NormalizedSupplierProduct | null> {
    this.throwFault("getProduct");
    const product = this.products.find(
      (candidate) => candidate.supplierProductId === productReference,
    );
    return product ? this.normalizeProduct(product) : null;
  }

  public async getOffer(
    offerReference: SupplierOfferId,
  ): Promise<NormalizedSupplierOffer | null> {
    this.throwFault("getOffer");
    const offer = this.offers.find(
      (candidate) => candidate.supplierOfferId === offerReference,
    );
    return offer ? this.normalizeOffer(offer) : null;
  }

  public async getCurrentPrice(
    offerReference: SupplierOfferId,
  ): Promise<PriceSnapshot> {
    this.throwFault("getCurrentPrice");
    assertSupplierCapability(this.capabilities.supportsPriceLookup, {
      category: "UNSUPPORTED_CAPABILITY",
      operation: "getCurrentPrice",
      supplierId: this.identity.supplierId,
    });
    const offer = await this.getRequiredOffer(
      offerReference,
      "getCurrentPrice",
    );

    return {
      availability: offer.availability,
      capturedAt: offer.capturedAt,
      offerId: offer.keycoreOfferId,
      price: offer.price,
    };
  }

  public async getRegionEvidence(
    offerReference: SupplierOfferId,
  ): Promise<RegionEvidence> {
    this.throwFault("getRegionEvidence");
    assertSupplierCapability(this.capabilities.supportsRegionEvidence, {
      category: "UNSUPPORTED_CAPABILITY",
      operation: "getRegionEvidence",
      supplierId: this.identity.supplierId,
    });
    const offer = await this.getRequiredOffer(
      offerReference,
      "getRegionEvidence",
    );
    return offer.regionEvidence;
  }

  public async submitPurchase(
    request: PurchaseRequest,
  ): Promise<PurchaseReceipt> {
    this.throwFault("submitPurchase", request.correlationId);
    assertSupplierCapability(this.capabilities.supportsPurchase, {
      category: "UNSUPPORTED_CAPABILITY",
      correlationId: request.correlationId,
      operation: "submitPurchase",
      supplierId: this.identity.supplierId,
    });
    this.observability?.record({
      correlationId: request.correlationId,
      occurredAt: fixedNow,
      operation: "submitPurchase",
      safeReference: request.supplierOfferId,
      supplierId: this.identity.supplierId,
      type: "SUPPLIER_PURCHASE_SUBMITTED",
    });

    const offer = await this.getRequiredOffer(
      request.supplierOfferId,
      "submitPurchase",
    );
    const semanticRequest = [
      request.supplierOfferId,
      request.orderLineId,
      request.correlationId,
    ].join("|");
    const existing = this.purchases.get(request.clientIdempotencyReference);
    if (existing) {
      if (existing.semanticRequest !== semanticRequest) {
        throw new SupplierError({
          category: "CONFLICT",
          correlationId: request.correlationId,
          operation: "submitPurchase",
          supplierId: this.identity.supplierId,
        });
      }

      return existing.receipt;
    }

    const receipt = this.receiptForScenario(offer.purchaseScenario, request);
    this.purchases.set(request.clientIdempotencyReference, {
      receipt,
      scenario: offer.purchaseScenario,
      semanticRequest,
    });
    return receipt;
  }

  public async reconcilePurchase(
    supplierPurchaseReference: string,
  ): Promise<ReconciliationResult> {
    this.throwFault("reconcilePurchase");
    assertSupplierCapability(
      this.capabilities.supportsPurchaseStatusReconciliation,
      {
        category: "UNSUPPORTED_CAPABILITY",
        operation: "reconcilePurchase",
        supplierId: this.identity.supplierId,
        supplierReference: supplierPurchaseReference,
      },
    );

    const record = [...this.purchases.values()].find(
      (purchase) =>
        purchase.receipt.supplierPurchaseReference ===
        supplierPurchaseReference,
    );
    if (!record) {
      throw new SupplierError({
        category: "NOT_FOUND",
        operation: "reconcilePurchase",
        supplierId: this.identity.supplierId,
        supplierReference: supplierPurchaseReference,
      });
    }

    if (record.scenario === "AMBIGUOUS") {
      return {
        observedAt: fixedNow,
        outcome: "STILL_AMBIGUOUS",
        reason: "SYNTHETIC_AMBIGUOUS_SUPPLIER_STATE",
      };
    }

    if (
      record.scenario === "TERMINAL_REJECTION" ||
      record.scenario === "UNAVAILABLE"
    ) {
      return {
        observedAt: fixedNow,
        outcome: "MANUAL_REVIEW_REQUIRED",
        reason: "SYNTHETIC_SUPPLIER_FAILURE",
      };
    }

    return {
      observedAt: fixedNow,
      outcome: "RESOLVED",
      reason: "SYNTHETIC_PURCHASE_OBSERVED",
    };
  }

  public async retrieveKey(
    supplierPurchaseReference: string,
  ): Promise<SupplierKeyHandle> {
    this.throwFault("retrieveKey");
    assertSupplierCapability(this.capabilities.supportsKeyRetrieval, {
      category: "UNSUPPORTED_CAPABILITY",
      operation: "retrieveKey",
      supplierId: this.identity.supplierId,
      supplierReference: supplierPurchaseReference,
    });

    return {
      keyReference: `mock-handle:${supplierPurchaseReference}`,
      receivedAt: fixedNow,
      supplierPurchaseReference,
    };
  }

  public async getHealth(): Promise<SupplierHealth> {
    this.throwFault("getHealth");
    return this.health;
  }

  public async submitRefundClaim(
    request: RefundClaimRequest,
  ): Promise<RefundClaimReceipt> {
    this.throwFault("submitRefundClaim", request.correlationId);
    assertSupplierCapability(this.capabilities.supportsRefundClaims, {
      category: "UNSUPPORTED_CAPABILITY",
      correlationId: request.correlationId,
      operation: "submitRefundClaim",
      supplierId: this.identity.supplierId,
      supplierReference: request.supplierPurchaseReference,
    });

    const semantic = `${request.supplierPurchaseReference}|${request.orderLineId}`;
    const existing = this.refunds.get(semantic);
    if (existing) {
      return existing;
    }

    const receipt = {
      acceptedAt: fixedNow,
      supplierClaimReference: `mock-claim:${request.supplierPurchaseReference}`,
    };
    this.refunds.set(semantic, receipt);
    return receipt;
  }

  private normalizeProduct(
    fixture: MockProductFixture,
  ): NormalizedSupplierProduct {
    return {
      changedAt: fixture.changedAt,
      lifecycle: fixture.lifecycle,
      product: {
        platforms: fixture.platforms,
        productId: fixture.keycoreProductId,
        title: fixture.title,
        type: fixture.type,
      },
      supplier: this.identity,
      supplierProductId: fixture.supplierProductId,
    };
  }

  private normalizeOffer(fixture: MockOfferFixture): NormalizedSupplierOffer {
    const product = this.products.find(
      (candidate) => candidate.supplierProductId === fixture.supplierProductId,
    );
    if (!product) {
      throw new SupplierError({
        category: "INVALID_RESPONSE",
        operation: "normalizeOffer",
        supplierId: this.identity.supplierId,
      });
    }

    return {
      capturedAt: fixture.capturedAt,
      offer: {
        availability: fixture.availability,
        currentPrice: fixture.price,
        germanyCompatibility: "REVIEW_REQUIRED",
        offerId: fixture.keycoreOfferId,
        productId: product.keycoreProductId,
      },
      regionEvidence: fixture.regionEvidence,
      supplier: this.identity,
      supplierOfferId: fixture.supplierOfferId,
      supplierProductId: fixture.supplierProductId,
      supplierReferenceMetadata: fixture.supplierReferenceMetadata ?? {},
    };
  }

  private async getRequiredOffer(
    offerReference: SupplierOfferId,
    operation: string,
  ): Promise<MockOfferFixture> {
    const offer = this.offers.find(
      (candidate) => candidate.supplierOfferId === offerReference,
    );
    if (!offer) {
      throw new SupplierError({
        category: "NOT_FOUND",
        operation,
        supplierId: this.identity.supplierId,
        supplierReference: offerReference,
      });
    }

    return offer;
  }

  private receiptForScenario(
    scenario: MockPurchaseScenario,
    request: PurchaseRequest,
  ): PurchaseReceipt {
    if (scenario === "UNAVAILABLE") {
      throw new SupplierError({
        category: "OUT_OF_STOCK",
        correlationId: request.correlationId,
        operation: "submitPurchase",
        supplierId: this.identity.supplierId,
        supplierReference: request.supplierOfferId,
      });
    }

    if (scenario === "TRANSIENT_ERROR") {
      throw new SupplierError({
        category: "TRANSIENT",
        correlationId: request.correlationId,
        operation: "submitPurchase",
        supplierId: this.identity.supplierId,
        supplierReference: request.supplierOfferId,
      });
    }

    if (scenario === "TERMINAL_REJECTION") {
      throw new SupplierError({
        category: "REJECTED",
        correlationId: request.correlationId,
        operation: "submitPurchase",
        supplierId: this.identity.supplierId,
        supplierReference: request.supplierOfferId,
      });
    }

    return {
      acceptedAt: fixedNow,
      rateLimit: safeRateLimit(),
      state:
        scenario === "DELAYED_FULFILLMENT"
          ? "DELAYED"
          : scenario === "AMBIGUOUS"
            ? "AMBIGUOUS"
            : "FULFILLED",
      supplierPurchaseReference: `mock-purchase:${request.clientIdempotencyReference}`,
    };
  }

  private throwFault(
    operation: string,
    requestCorrelationId = correlationId("corr-mock"),
  ): void {
    const fault = this.faultByOperation[operation];
    if (!fault) {
      return;
    }

    const categoryByFault = {
      MALFORMED_RESPONSE_SIMULATION: "INVALID_RESPONSE",
      RATE_LIMITED: "RATE_LIMIT",
      TERMINAL_ERROR: "REJECTED",
      TIMEOUT: "TIMEOUT",
      TRANSIENT_ERROR: "TRANSIENT",
    } as const;

    throw new SupplierError({
      category: categoryByFault[fault],
      correlationId: requestCorrelationId,
      operation,
      supplierId: this.identity.supplierId,
    });
  }

  private validateRateLimit(rateLimit: RateLimitMetadata | undefined): void {
    if (!rateLimit) {
      return;
    }

    if (
      (rateLimit.limit !== undefined && rateLimit.limit < 0) ||
      (rateLimit.remaining !== undefined && rateLimit.remaining < 0) ||
      (rateLimit.limit !== undefined &&
        rateLimit.remaining !== undefined &&
        rateLimit.remaining > rateLimit.limit)
    ) {
      throw new SupplierError({
        category: "INVALID_RESPONSE",
        operation: "validateRateLimit",
        supplierId: this.identity.supplierId,
      });
    }
  }
}

export const createMockPurchaseRequest = (
  offerReference = supplierOfferId("so-alpha-eur"),
): PurchaseRequest => ({
  clientIdempotencyReference: idempotencyKey("idem-mock-1"),
  correlationId: correlationId("corr-mock-purchase"),
  orderLineId: orderLineId("order-line-mock-1"),
  supplierOfferId: offerReference,
});
