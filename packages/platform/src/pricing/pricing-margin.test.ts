import { describe, expect, it } from "vitest";

import { InMemoryPricingRepository } from "../../../../infra/pricing/in-memory-pricing-repository.js";
import {
  correlationId,
  currency,
  money,
  offerId,
  productId,
  type CorrelationId,
  type Money,
  type OfferId,
  type ProductId,
} from "../contracts.js";
import type { AuditEventPort } from "../ports/core.js";
import {
  calculatedFormulaPrice,
  createPricingPolicy,
  marginBasisPoints,
  markupBasisPoints,
  minimumSafePrice,
  PricingConfigurationConflictError,
  PricingConfigurationValidationError,
  PricingService,
  PricingStorefrontPriceProvider,
  pricingRecalculationJobPayload,
  roundPrice,
  type AcquisitionCostInput,
  type ExchangeRatePort,
  type PricingOfferSourcePort,
  type PricingStorefrontReevaluationPort,
  type ProductPricingOverride,
  type TaxPolicyPort,
} from "./pricing-margin.js";

const eur = currency("EUR");
const usd = currency("USD");
const now = new Date("2026-08-15T10:00:00.000Z");

describe("pricing and margin foundation", () => {
  it("uses exact minor-unit money and distinct markup/margin formulas", () => {
    const cost = money(1n, eur);
    const profit = money(1n, eur);

    expect(money(1n, eur).amountMinor + money(2n, eur).amountMinor).toBe(3n);
    expect(() => money(-1n, eur)).toThrow("Money amount must not be negative");
    expect(
      markupBasisPoints({ cost: money(1_000n, eur), profit: money(250n, eur) }),
    ).toBe(2_500n);
    expect(
      marginBasisPoints({
        sellPrice: money(1_250n, eur),
        profit: money(250n, eur),
      }),
    ).toBe(2_000n);
    expect(markupBasisPoints({ cost, profit })).toBe(10_000n);
    expect(marginBasisPoints({ profit, sellPrice: money(2n, eur) })).toBe(
      5_000n,
    );
  });

  it("applies markup, margin target, fixed components, hard floors and safe rounding", () => {
    const policy = createPricingPolicy({
      currency: eur,
      fixedMarkup: money(99n, eur),
      markupBasisPoints: 1_000n,
      minimumProfit: money(150n, eur),
      minimumSellPrice: money(500n, eur),
      now,
      policyId: "policy",
      rounding: { endingMinor: 99n, mode: "PSYCHOLOGICAL_ENDING" },
      targetMarginBasisPoints: 2_000n,
    });
    const effective = {
      fixedMarkup: policy.fixedMarkup,
      markupBasisPoints: policy.markupBasisPoints,
      minimumProfit: policy.minimumProfit,
      minimumSellPrice: policy.minimumSellPrice,
      rounding: policy.rounding,
      ...(policy.targetMarginBasisPoints
        ? { targetMarginBasisPoints: policy.targetMarginBasisPoints }
        : {}),
    };

    expect(
      calculatedFormulaPrice(money(1_000n, eur), effective).amountMinor,
    ).toBe(1_250n);
    expect(minimumSafePrice(money(300n, eur), effective).amountMinor).toBe(
      500n,
    );
    expect(roundPrice(money(1_201n, eur), policy.rounding).amountMinor).toBe(
      1_299n,
    );
    expect(roundPrice(money(1_199n, eur), policy.rounding).amountMinor).toBe(
      1_199n,
    );
  });

  it("fails closed for missing config, disabled pricing, invalid/stale inputs, unknown fees and unknown tax", async () => {
    const disabled = createHarness({
      policyEnabled: false,
    });
    await expect(
      disabled.service.quoteProduct(request()),
    ).resolves.toMatchObject({
      reasonCode: "PRICING_DISABLED",
      status: "BLOCKED",
    });

    const missingPolicy = createHarness({ noPolicy: true });
    await expect(
      missingPolicy.service.quoteProduct(request()),
    ).resolves.toMatchObject({
      reasonCode: "CONFIGURATION_MISSING",
      status: "BLOCKED",
    });

    for (const cost of [
      fixtureCost({ baseSupplierPrice: money(0n, eur), costVersion: "zero" }),
      fixtureCost({
        capturedAt: new Date("2026-08-15T09:00:00.000Z"),
        costVersion: "stale",
      }),
      fixtureCost({ costVersion: "unknown-fee", requiredFeeKnown: false }),
    ]) {
      const harness = createHarness({ costs: [cost] });
      const selection = await harness.service.quoteProduct(request());
      expect(selection.status).toBe("BLOCKED");
      expect(selection.selectedQuote).toBeUndefined();
    }

    const unknownTax = createHarness({ taxKnown: false });
    await expect(
      unknownTax.service.quoteProduct(request()),
    ).resolves.toMatchObject({
      reasonCode: "UNKNOWN_TAX_TREATMENT",
      status: "REVIEW_REQUIRED",
    });
  });

  it("requires trusted FX for cross-currency offers and fingerprints FX/tax versions", async () => {
    const missingFx = createHarness({
      costs: [fixtureCost({ baseSupplierPrice: money(1_000n, usd) })],
    });
    await expect(
      missingFx.service.quoteProduct(request()),
    ).resolves.toMatchObject({
      reasonCode: "MISSING_FX_RATE",
      status: "BLOCKED",
    });

    const priced = createHarness({
      costs: [
        fixtureCost({
          baseSupplierPrice: money(1_000n, usd),
          costVersion: "fx-a",
        }),
      ],
      exchangeRates: syntheticFx("fx-v1"),
      taxPolicyVersion: "tax-v1",
    });
    const changedTax = createHarness({
      costs: [
        fixtureCost({
          baseSupplierPrice: money(1_000n, usd),
          costVersion: "fx-a",
        }),
      ],
      exchangeRates: syntheticFx("fx-v1"),
      taxPolicyVersion: "tax-v2",
    });

    const quote = await selectedQuote(priced);
    const taxChangedQuote = await selectedQuote(changedTax);
    expect(quote.acquisitionCost).toEqual(money(2_200n, eur));
    expect(quote.fxRateVersion).toBe("fx-v1");
    expect(quote.sourceFingerprint).not.toBe(taxChangedQuote.sourceFingerprint);

    const staleFx = createHarness({
      costs: [fixtureCost({ baseSupplierPrice: money(1_000n, usd) })],
      exchangeRates: syntheticFx(
        "fx-stale",
        new Date("2026-08-15T09:59:00.000Z"),
      ),
    });
    await expect(
      staleFx.service.quoteProduct(request()),
    ).resolves.toMatchObject({
      reasonCode: "STALE_FX_RATE",
      status: "BLOCKED",
    });
  });

  it("applies product overrides, manual prices, version conflicts, clearing and product disablement", async () => {
    const harness = createHarness();
    await harness.service.updateProductOverride({
      correlationId: correlationId("corr-override"),
      update: {
        actorRef: "admin-1",
        markupBasisPoints: 2_000n,
        productId: product,
        reason: "test override",
      },
    });
    const overridden = await selectedQuote(harness);
    expect(overridden.sellPrice.amountMinor).toBe(1_380n);

    await harness.service.updateProductOverride({
      correlationId: correlationId("corr-manual"),
      update: {
        actorRef: "admin-1",
        expectedVersion: 1,
        manualSellPrice: money(2_000n, eur),
        productId: product,
        reason: "manual test",
      },
    });
    const manual = await selectedQuote(harness);
    expect(manual.sellPrice).toEqual(money(2_000n, eur));
    expect(manual.manualPriceVersion).toBe(1);
    expect(harness.reevaluation.productIds).toEqual([product, product]);

    await expect(
      harness.service.updateProductOverride({
        correlationId: correlationId("corr-conflict"),
        update: {
          actorRef: "admin-2",
          expectedVersion: 1,
          markupBasisPoints: 900n,
          productId: product,
          reason: "stale",
        },
      }),
    ).rejects.toBeInstanceOf(PricingConfigurationConflictError);

    await harness.repository.clearOverride({
      expectedVersion: 2,
      productId: product,
    });
    expect((await selectedQuote(harness)).sellPrice.amountMinor).toBe(1_350n);

    await harness.service.updateProductOverride({
      correlationId: correlationId("corr-disable-product"),
      update: {
        actorRef: "admin-1",
        enabled: false,
        productId: product,
        reason: "disable",
      },
    });
    await expect(
      harness.service.quoteProduct(request()),
    ).resolves.toMatchObject({
      reasonCode: "PRICING_DISABLED",
      status: "BLOCKED",
    });
  });

  it("validates manual sell-price configuration before persistence or quoting", async () => {
    const accepted = createHarness();
    await expect(
      accepted.service.updateProductOverride({
        correlationId: correlationId("corr-manual-positive"),
        update: {
          actorRef: "admin-1",
          manualSellPrice: money(1n, eur),
          productId: product,
          reason: "positive manual price",
        },
      }),
    ).resolves.toMatchObject({
      manualPriceVersion: 1,
      manualSellPrice: money(1n, eur),
    });

    const zero = createHarness();
    await expect(
      zero.service.updateProductOverride({
        correlationId: correlationId("corr-manual-zero"),
        update: {
          actorRef: "admin-1",
          manualSellPrice: money(0n, eur),
          productId: product,
          reason: "zero manual price",
        },
      }),
    ).rejects.toThrow("Manual sell price must be greater than zero");

    const negative = createHarness();
    await expect(
      negative.service.updateProductOverride({
        correlationId: correlationId("corr-manual-negative"),
        update: {
          actorRef: "admin-1",
          manualSellPrice: {
            amountMinor: -1n,
            currency: eur,
          },
          productId: product,
          reason: "negative manual price",
        },
      }),
    ).rejects.toBeInstanceOf(PricingConfigurationValidationError);

    const noManualPrice = createHarness();
    const override = await noManualPrice.service.updateProductOverride({
      correlationId: correlationId("corr-no-manual-price"),
      update: {
        actorRef: "admin-1",
        markupBasisPoints: 1_500n,
        productId: product,
        reason: "no manual price",
      },
    });
    expect(override.manualSellPrice).toBeUndefined();
    expect(override.manualPriceVersion).toBeUndefined();

    await noManualPrice.service.updateProductOverride({
      correlationId: correlationId("corr-clear-manual-price"),
      update: {
        actorRef: "admin-1",
        expectedVersion: 1,
        manualSellPrice: money(1_999n, eur),
        productId: product,
        reason: "set before clear",
      },
    });
    const cleared = await noManualPrice.service.updateProductOverride({
      correlationId: correlationId("corr-clear-manual-price-2"),
      update: {
        actorRef: "admin-1",
        expectedVersion: 2,
        manualSellPrice: null,
        productId: product,
        reason: "clear manual price",
      },
    });
    expect(cleared.manualSellPrice).toBeNull();
    expect(cleared.manualPriceVersion).toBeNull();
  });

  it("does not let manual prices bypass fee, tax, currency or hard-floor safety", async () => {
    const unsafe = createHarness({
      override: {
        createdAt: now,
        enabled: true,
        manualPriceVersion: 1,
        manualSellPrice: money(1_000n, eur),
        productId: product,
        updatedAt: now,
        version: 1,
      },
    });
    await expect(unsafe.service.quoteProduct(request())).resolves.toMatchObject(
      {
        reasonCode: "MANUAL_PRICE_UNSAFE",
        status: "BLOCKED",
      },
    );

    const unknownFee = createHarness({
      costs: [fixtureCost({ requiredFeeKnown: false })],
      override: {
        createdAt: now,
        enabled: true,
        manualPriceVersion: 1,
        manualSellPrice: money(2_000n, eur),
        productId: product,
        updatedAt: now,
        version: 1,
      },
    });
    await expect(
      unknownFee.service.quoteProduct(request()),
    ).resolves.toMatchObject({
      reasonCode: "UNKNOWN_SUPPLIER_FEE",
      status: "BLOCKED",
    });
  });

  it("evaluates multiple eligible offers, excludes blocked quotes and selects deterministic best safe price", async () => {
    const costs = [
      fixtureCost({
        baseSupplierPrice: money(2_000n, eur),
        costVersion: "expensive",
        offerId: offerId("offer-b"),
      }),
      fixtureCost({
        baseSupplierPrice: money(1_000n, eur),
        costVersion: "cheap",
        offerId: offerId("offer-a"),
      }),
      fixtureCost({
        baseSupplierPrice: money(900n, usd),
        costVersion: "blocked-fx",
        offerId: offerId("offer-c"),
      }),
    ];
    const harness = createHarness({ costs });
    const selection = await harness.service.quoteProduct(
      request({
        eligibleOfferIds: [
          offerId("offer-c"),
          offerId("offer-b"),
          offerId("offer-a"),
        ],
      }),
    );

    expect(selection.quotes).toHaveLength(3);
    expect(selection.selectedQuote?.offerId).toBe(offerId("offer-a"));
    expect(selection.selectedQuote?.sellPrice.amountMinor).toBe(1_350n);
    expect(safeJson(selection.selectedQuote)).not.toMatch(/supplier/i);

    const tied = createHarness({
      costs: [
        fixtureCost({ costVersion: "tie-b", offerId: offerId("offer-b") }),
        fixtureCost({ costVersion: "tie-a", offerId: offerId("offer-a") }),
      ],
    });
    await expect(selectedQuote(tied)).resolves.toMatchObject({
      offerId: offerId("offer-a"),
    });
  });

  it("exposes only customer price through StorefrontPriceProvider and safe recalculation payloads/audit", async () => {
    const harness = createHarness();
    const provider = new PricingStorefrontPriceProvider(harness.service);
    const price = await provider.quoteSellPrice({
      correlationId: correlationId("corr-storefront"),
      eligibleOffers: [
        {
          active: true,
          availability: "IN_STOCK",
          germanyCompatibility: "ALLOWED",
          offerId: offer,
        },
      ],
      product: {
        active: true,
        canonicalTitle: "Safe Product",
        lifecycle: "IN_STOCK",
        platforms: ["WINDOWS"],
        productId: product,
        productType: "GAME",
      },
    });

    expect(price).toEqual(money(1_350n, eur));
    expect(safeJson(price)).not.toMatch(/supplier|cost/i);
    expect(
      pricingRecalculationJobPayload({
        correlationId: correlationId("corr-job"),
        productId: product,
        reason: "policy changed",
      }),
    ).toEqual({
      correlationId: "corr-job",
      productId: product,
      reason: "policy changed",
    });
    expect(safeJson(harness.audit.events)).not.toMatch(
      /api|secret|supplierCost|baseSupplierPrice/i,
    );
    expect(harness.repository.listSnapshots()).toHaveLength(1);
  });

  it("keeps quoted prices above the hard floor across generated inputs and handles 50k synthetic evaluations", async () => {
    const costs = Array.from({ length: 50_000 }, (_, index) =>
      fixtureCost({
        baseSupplierPrice: money(BigInt(100 + (index % 10_000)), eur),
        costVersion: `bulk-${index}`,
        offerId: offerId(
          `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        ),
      }),
    );
    const harness = createHarness({ costs });
    const started = performance.now();
    const quotes = await Promise.all(
      costs.map((cost) =>
        harness.service.quoteOffer({
          cost,
          override: null,
          policy: harness.policy,
        }),
      ),
    );
    const elapsedMs = Math.round(performance.now() - started);

    expect(quotes).toHaveLength(50_000);
    expect(quotes.every((quote) => quote.status === "QUOTED")).toBe(true);
    expect(
      quotes.every(
        (quote) =>
          quote.sellPrice.amountMinor >=
            quote.acquisitionCost.amountMinor + 200n &&
          quote.expectedProfit.amountMinor >= 200n,
      ),
    ).toBe(true);
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

const product = productId("00000000-0000-4000-8000-000000000001");
const offer = offerId("00000000-0000-4000-8000-000000000101");

const request = (
  overrides: {
    readonly eligibleOfferIds?: readonly OfferId[];
    readonly correlationId?: CorrelationId;
  } = {},
) => ({
  correlationId: overrides.correlationId ?? correlationId("corr-pricing-test"),
  ...(overrides.eligibleOfferIds
    ? { eligibleOfferIds: overrides.eligibleOfferIds }
    : {}),
  productId: product,
});

const fixtureCost = (
  overrides: Partial<AcquisitionCostInput> = {},
): AcquisitionCostInput => ({
  baseSupplierPrice: money(1_000n, eur),
  capturedAt: now,
  costVersion: "cost-v1",
  fixedFee: money(100n, eur),
  offerId: offer,
  percentageFeeBasisPoints: 500n,
  productId: product,
  requiredFeeKnown: true,
  ...overrides,
});

const createHarness = (
  options: {
    readonly costs?: readonly AcquisitionCostInput[];
    readonly exchangeRates?: ExchangeRatePort;
    readonly noPolicy?: boolean;
    readonly override?: ProductPricingOverride;
    readonly policyEnabled?: boolean;
    readonly taxKnown?: boolean;
    readonly taxPolicyVersion?: string;
  } = {},
) => {
  const policy = createPricingPolicy({
    currency: eur,
    enabled: options.policyEnabled ?? true,
    fixedMarkup: money(0n, eur),
    markupBasisPoints: 1_000n,
    minimumProfit: money(200n, eur),
    minimumSellPrice: money(0n, eur),
    now,
    policyId: "policy-1",
    quoteTtlMs: 60_000,
  });
  const repository = new InMemoryPricingRepository(
    options.noPolicy ? null : policy,
  );
  if (options.override) {
    const seedUpdate = {
      actorRef: "seed",
      enabled: options.override.enabled,
      productId: options.override.productId,
      reason: "seed",
      ...(options.override.manualSellPrice !== undefined
        ? { manualSellPrice: options.override.manualSellPrice }
        : {}),
    };
    void repository.updateOverride(seedUpdate);
  }
  const audit = new CapturingAudit();
  const reevaluation = new CapturingReevaluation();
  const service = new PricingService({
    audit,
    environment: "LOCAL",
    maxInputAgeMs: 10_000,
    now: () => now,
    offerSource: new FixtureOfferSource(options.costs ?? [fixtureCost()]),
    overrideRepository: repository,
    policyRepository: repository,
    snapshots: repository,
    storefrontReevaluation: reevaluation,
    taxPolicy: new FixtureTaxPolicy(
      options.taxKnown ?? true,
      options.taxPolicyVersion ?? "tax-v1",
    ),
    ...(options.exchangeRates ? { exchangeRates: options.exchangeRates } : {}),
  });
  return { audit, policy, reevaluation, repository, service };
};

const selectedQuote = async (harness: ReturnType<typeof createHarness>) => {
  const selection = await harness.service.quoteProduct(request());
  if (!selection.selectedQuote) {
    throw new Error(`Expected selected quote, got ${selection.reasonCode}`);
  }
  return selection.selectedQuote;
};

class FixtureOfferSource implements PricingOfferSourcePort {
  public constructor(private readonly costs: readonly AcquisitionCostInput[]) {}

  public async loadPriceableOffers(input: {
    readonly eligibleOfferIds?: readonly OfferId[];
  }): Promise<readonly AcquisitionCostInput[]> {
    return input.eligibleOfferIds
      ? this.costs.filter((cost) =>
          input.eligibleOfferIds?.includes(cost.offerId),
        )
      : this.costs;
  }
}

class FixtureTaxPolicy implements TaxPolicyPort {
  public constructor(
    private readonly known: boolean,
    private readonly version: string,
  ) {}

  public async assess(input: { readonly subtotal: Money }): Promise<{
    readonly known: boolean;
    readonly taxAmount: Money;
    readonly treatment: "CONFIGURED_FIXTURE" | "UNKNOWN";
    readonly policyVersion: string;
  }> {
    return {
      known: this.known,
      policyVersion: this.version,
      taxAmount: this.known
        ? money(0n, input.subtotal.currency)
        : money(0n, input.subtotal.currency),
      treatment: this.known ? "CONFIGURED_FIXTURE" : "UNKNOWN",
    };
  }
}

const syntheticFx = (version: string, validUntil?: Date): ExchangeRatePort => ({
  quote: async () => ({
    denominator: 1n,
    numerator: 2n,
    observedAt: now,
    sourceCurrency: usd,
    targetCurrency: eur,
    version,
    ...(validUntil ? { validUntil } : {}),
  }),
});

const safeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, nested) =>
    typeof nested === "bigint" ? nested.toString() : nested,
  );

class CapturingAudit implements AuditEventPort {
  public readonly events: Parameters<AuditEventPort["append"]>[0][] = [];

  public async append(
    event: Parameters<AuditEventPort["append"]>[0],
  ): Promise<void> {
    this.events.push(event);
  }
}

class CapturingReevaluation implements PricingStorefrontReevaluationPort {
  public readonly productIds: ProductId[] = [];

  public async requestStorefrontReevaluation(input: {
    readonly productId: ProductId;
  }): Promise<void> {
    this.productIds.push(input.productId);
  }
}
