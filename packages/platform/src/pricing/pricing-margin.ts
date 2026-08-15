import { createHash, randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type { Money } from "../domain/money.js";
import { money } from "../domain/money.js";
import type {
  CorrelationId,
  OfferId,
  ProductId,
} from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import type { SafePayload } from "../queue/job.js";
import type {
  StorefrontCanonicalProduct,
  StorefrontOfferSummary,
  StorefrontPriceProvider,
} from "../storefront/publication.js";

export const pricingPolicyVersion = "pricing-policy-v1" as const;

export type PricingStatus = "QUOTED" | "BLOCKED" | "REVIEW_REQUIRED";

export const pricingReasonCodes = [
  "NO_ELIGIBLE_OFFER",
  "PRICING_DISABLED",
  "UNKNOWN_SUPPLIER_FEE",
  "UNSUPPORTED_CURRENCY",
  "MISSING_FX_RATE",
  "STALE_FX_RATE",
  "UNKNOWN_TAX_TREATMENT",
  "BELOW_MINIMUM_PROFIT",
  "BELOW_MINIMUM_SELL_PRICE",
  "INVALID_COST",
  "STALE_PRICE_INPUT",
  "MANUAL_PRICE_UNSAFE",
  "CONFIGURATION_MISSING",
  "CONFLICT",
] as const;

export type PricingReasonCode = (typeof pricingReasonCodes)[number];

export type RoundingPolicy =
  | { readonly mode: "MINOR_UNIT_UP" }
  | {
      readonly mode: "PSYCHOLOGICAL_ENDING";
      readonly endingMinor: bigint;
    };

export interface PricingPolicy {
  readonly policyId: string;
  readonly policyVersion: typeof pricingPolicyVersion;
  readonly version: number;
  readonly enabled: boolean;
  readonly currency: Money["currency"];
  readonly markupBasisPoints: bigint;
  readonly targetMarginBasisPoints?: bigint;
  readonly fixedMarkup: Money;
  readonly minimumProfit: Money;
  readonly minimumSellPrice: Money;
  readonly rounding: RoundingPolicy;
  readonly quoteTtlMs?: number;
  readonly effectiveAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly actorRef?: string;
  readonly reason?: string;
}

export interface ProductPricingOverride {
  readonly productId: ProductId;
  readonly version: number;
  readonly enabled: boolean;
  readonly markupBasisPoints?: bigint | null;
  readonly targetMarginBasisPoints?: bigint | null;
  readonly fixedMarkup?: Money | null;
  readonly minimumProfit?: Money | null;
  readonly minimumSellPrice?: Money | null;
  readonly rounding?: RoundingPolicy | null;
  readonly quoteTtlMs?: number | null;
  readonly manualSellPrice?: Money | null;
  readonly manualPriceVersion?: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly actorRef?: string;
  readonly reason?: string;
}

export interface PricingPolicyUpdate {
  readonly expectedVersion: number;
  readonly actorRef: string;
  readonly reason: string;
  readonly enabled?: boolean;
  readonly markupBasisPoints?: bigint;
  readonly targetMarginBasisPoints?: bigint | null;
  readonly fixedMarkup?: Money;
  readonly minimumProfit?: Money;
  readonly minimumSellPrice?: Money;
  readonly rounding?: RoundingPolicy;
  readonly quoteTtlMs?: number | null;
}

export interface ProductPricingOverrideUpdate {
  readonly productId: ProductId;
  readonly expectedVersion?: number;
  readonly actorRef: string;
  readonly reason: string;
  readonly enabled?: boolean;
  readonly markupBasisPoints?: bigint | null;
  readonly targetMarginBasisPoints?: bigint | null;
  readonly fixedMarkup?: Money | null;
  readonly minimumProfit?: Money | null;
  readonly minimumSellPrice?: Money | null;
  readonly rounding?: RoundingPolicy | null;
  readonly quoteTtlMs?: number | null;
  readonly manualSellPrice?: Money | null;
}

export interface AcquisitionCostInput {
  readonly productId: ProductId;
  readonly offerId: OfferId;
  readonly baseSupplierPrice: Money;
  readonly capturedAt: Date;
  readonly costVersion: string;
  readonly requiredFeeKnown: boolean;
  readonly fixedFee?: Money;
  readonly percentageFeeBasisPoints?: bigint;
}

export interface TaxAssessment {
  readonly known: boolean;
  readonly taxAmount: Money;
  readonly treatment: "CONFIGURED_FIXTURE" | "UNKNOWN";
  readonly policyVersion: string;
}

export interface ExchangeRateQuote {
  readonly sourceCurrency: Money["currency"];
  readonly targetCurrency: Money["currency"];
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly version: string;
  readonly observedAt: Date;
  readonly validUntil?: Date;
}

export interface ExchangeRatePort {
  quote(input: {
    readonly sourceCurrency: Money["currency"];
    readonly targetCurrency: Money["currency"];
    readonly at: Date;
  }): Promise<ExchangeRateQuote | null>;
}

export interface TaxPolicyPort {
  assess(input: {
    readonly productId: ProductId;
    readonly offerId: OfferId;
    readonly subtotal: Money;
    readonly calculatedAt: Date;
  }): Promise<TaxAssessment>;
}

export interface PricingPolicyRepository {
  getActivePolicy(): Promise<PricingPolicy | null>;
  updateActivePolicy(update: PricingPolicyUpdate): Promise<PricingPolicy>;
}

export interface ProductPricingOverrideRepository {
  getOverride(productId: ProductId): Promise<ProductPricingOverride | null>;
  updateOverride(
    update: ProductPricingOverrideUpdate,
  ): Promise<ProductPricingOverride>;
  clearOverride(input: {
    readonly productId: ProductId;
    readonly expectedVersion: number;
    readonly actorRef: string;
    readonly reason: string;
  }): Promise<void>;
}

export interface PriceSnapshotRepository {
  saveSnapshot(quote: SellPriceQuote): Promise<void>;
}

export interface PricingOfferSourcePort {
  loadPriceableOffers(input: {
    readonly productId: ProductId;
    readonly eligibleOfferIds?: readonly OfferId[];
  }): Promise<readonly AcquisitionCostInput[]>;
}

export interface PricingStorefrontReevaluationPort {
  requestStorefrontReevaluation(input: {
    readonly productId: ProductId;
    readonly correlationId: CorrelationId;
  }): Promise<void>;
}

export interface SellPriceQuote {
  readonly productId: ProductId;
  readonly offerId: OfferId;
  readonly currency: Money["currency"];
  readonly acquisitionCost: Money;
  readonly knownFees: Money;
  readonly taxAmount: Money;
  readonly preRoundingPrice: Money;
  readonly sellPrice: Money;
  readonly expectedProfit: Money;
  readonly hardMinimumProfit?: Money;
  readonly hardMinimumSellPrice?: Money;
  readonly marginBasisPoints: bigint;
  readonly markupBasisPoints: bigint;
  readonly pricingPolicyVersion: typeof pricingPolicyVersion;
  readonly pricingPolicyRecordVersion: number;
  readonly productOverrideVersion?: number;
  readonly manualPriceVersion?: number;
  readonly fxRateVersion?: string;
  readonly taxPolicyVersion: string;
  readonly sourceFingerprint: string;
  readonly calculatedAt: Date;
  readonly validUntil?: Date;
  readonly status: PricingStatus;
  readonly reasonCode?: PricingReasonCode;
}

export interface ProductPriceSelection {
  readonly productId: ProductId;
  readonly status: PricingStatus;
  readonly selectedQuote?: SellPriceQuote;
  readonly quotes: readonly SellPriceQuote[];
  readonly reasonCode?: PricingReasonCode;
}

export interface PricingServiceOptions {
  readonly policyRepository: PricingPolicyRepository;
  readonly overrideRepository: ProductPricingOverrideRepository;
  readonly offerSource: PricingOfferSourcePort;
  readonly taxPolicy: TaxPolicyPort;
  readonly snapshots?: PriceSnapshotRepository;
  readonly exchangeRates?: ExchangeRatePort;
  readonly audit?: AuditEventPort;
  readonly storefrontReevaluation?: PricingStorefrontReevaluationPort;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
  readonly maxInputAgeMs?: number;
}

export class PricingConfigurationConflictError extends Error {
  public constructor(message = "Pricing configuration version conflict") {
    super(message);
    this.name = "PricingConfigurationConflictError";
  }
}

export class PricingConfigurationValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PricingConfigurationValidationError";
  }
}

export class PricingService {
  private readonly now: () => Date;
  private readonly environment: AuditEvent["environment"];
  private readonly maxInputAgeMs: number;

  public constructor(private readonly options: PricingServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.environment = options.environment ?? "LOCAL";
    this.maxInputAgeMs = options.maxInputAgeMs ?? 300_000;
  }

  public async quoteProduct(input: {
    readonly productId: ProductId;
    readonly eligibleOfferIds?: readonly OfferId[];
    readonly correlationId: CorrelationId;
  }): Promise<ProductPriceSelection> {
    const policy = await this.options.policyRepository.getActivePolicy();
    const override = await this.options.overrideRepository.getOverride(
      input.productId,
    );
    const costs = await this.options.offerSource.loadPriceableOffers({
      productId: input.productId,
      ...(input.eligibleOfferIds
        ? { eligibleOfferIds: input.eligibleOfferIds }
        : {}),
    });

    if (costs.length === 0) {
      return this.blockedSelection(input.productId, [], "NO_ELIGIBLE_OFFER");
    }

    const quotes = await Promise.all(
      costs.map((cost) => this.quoteOffer({ cost, override, policy })),
    );
    for (const quote of quotes) {
      await this.options.snapshots?.saveSnapshot(quote);
      await this.auditQuote(quote, input.correlationId);
    }

    const selected = selectBestQuote(quotes);
    if (!selected) {
      return this.blockedSelection(
        input.productId,
        quotes,
        quotes[0]?.reasonCode ?? "CONFIGURATION_MISSING",
      );
    }
    return {
      productId: input.productId,
      quotes,
      selectedQuote: selected,
      status: "QUOTED",
    };
  }

  public async updateGlobalPolicy(input: {
    readonly update: PricingPolicyUpdate;
    readonly correlationId: CorrelationId;
  }): Promise<PricingPolicy> {
    validatePricingPolicyUpdate(input.update);
    const policy = await this.options.policyRepository.updateActivePolicy(
      input.update,
    );
    await this.auditConfigurationChange({
      actorRef: input.update.actorRef,
      correlationId: input.correlationId,
      eventType: "PRICING_GLOBAL_POLICY_CHANGED",
      metadata: {
        changedFields: changedGlobalFields(input.update).join(","),
        policyRecordVersion: policy.version,
        pricingPolicyVersion: policy.policyVersion,
        reason: input.update.reason,
      },
    });
    return policy;
  }

  public async updateProductOverride(input: {
    readonly update: ProductPricingOverrideUpdate;
    readonly correlationId: CorrelationId;
  }): Promise<ProductPricingOverride> {
    validateProductPricingOverrideUpdate(input.update);
    const override = await this.options.overrideRepository.updateOverride(
      input.update,
    );
    await this.auditConfigurationChange({
      actorRef: input.update.actorRef,
      correlationId: input.correlationId,
      eventType: input.update.manualSellPrice
        ? "PRICING_MANUAL_PRICE_SET"
        : "PRICING_PRODUCT_OVERRIDE_SET",
      metadata: {
        changedFields: changedOverrideFields(input.update).join(","),
        overrideVersion: override.version,
        productId: input.update.productId,
        reason: input.update.reason,
      },
      productId: input.update.productId,
    });
    await this.options.storefrontReevaluation?.requestStorefrontReevaluation({
      correlationId: input.correlationId,
      productId: input.update.productId,
    });
    return override;
  }

  public async quoteOffer(input: {
    readonly cost: AcquisitionCostInput;
    readonly policy: PricingPolicy | null;
    readonly override: ProductPricingOverride | null;
  }): Promise<SellPriceQuote> {
    const calculatedAt = this.now();
    const blocked = (
      reasonCode: PricingReasonCode,
      partial: Partial<SellPriceQuote> = {},
    ): SellPriceQuote => {
      const fingerprintInput = sourceFingerprintInput({
        cost: input.cost,
        policy: input.policy,
        taxPolicyVersion: partial.taxPolicyVersion ?? "unknown-tax",
        ...(partial.fxRateVersion
          ? { fxRateVersion: partial.fxRateVersion }
          : {}),
        ...(input.override?.manualPriceVersion
          ? { manualPriceVersion: input.override.manualPriceVersion }
          : {}),
        ...(input.override?.version
          ? { overrideVersion: input.override.version }
          : {}),
      });
      return quoteRecord({
        acquisitionCost:
          partial?.acquisitionCost ?? input.cost.baseSupplierPrice,
        calculatedAt,
        currency: partial?.currency ?? input.cost.baseSupplierPrice.currency,
        expectedProfit:
          partial?.expectedProfit ??
          money(0n, partial?.currency ?? input.cost.baseSupplierPrice.currency),
        knownFees:
          partial?.knownFees ??
          money(0n, partial?.currency ?? input.cost.baseSupplierPrice.currency),
        offerId: input.cost.offerId,
        preRoundingPrice:
          partial?.preRoundingPrice ??
          money(0n, partial?.currency ?? input.cost.baseSupplierPrice.currency),
        pricingPolicyRecordVersion: input.policy?.version ?? 0,
        productId: input.cost.productId,
        reasonCode,
        sellPrice:
          partial?.sellPrice ??
          money(0n, partial?.currency ?? input.cost.baseSupplierPrice.currency),
        sourceFingerprint: sourceFingerprint(fingerprintInput),
        status:
          reasonCode === "UNKNOWN_TAX_TREATMENT"
            ? "REVIEW_REQUIRED"
            : "BLOCKED",
        taxAmount:
          partial?.taxAmount ??
          money(0n, partial?.currency ?? input.cost.baseSupplierPrice.currency),
        taxPolicyVersion: partial?.taxPolicyVersion ?? "unknown-tax",
        ...(partial?.fxRateVersion
          ? { fxRateVersion: partial.fxRateVersion }
          : {}),
        ...(input.override?.manualPriceVersion
          ? { manualPriceVersion: input.override.manualPriceVersion }
          : {}),
        ...(input.override?.version
          ? { productOverrideVersion: input.override.version }
          : {}),
      });
    };

    if (!input.policy) {
      return blocked("CONFIGURATION_MISSING");
    }
    if (!input.policy.enabled || input.override?.enabled === false) {
      return blocked("PRICING_DISABLED");
    }
    if (input.cost.baseSupplierPrice.amountMinor <= 0n) {
      return blocked("INVALID_COST");
    }
    if (!input.cost.requiredFeeKnown) {
      return blocked("UNKNOWN_SUPPLIER_FEE");
    }
    if (
      calculatedAt.getTime() - input.cost.capturedAt.getTime() >
      this.maxInputAgeMs
    ) {
      return blocked("STALE_PRICE_INPUT");
    }

    const convertedBase = await this.convertIfNeeded({
      at: calculatedAt,
      moneyValue: input.cost.baseSupplierPrice,
      targetCurrency: input.policy.currency,
    });
    if (convertedBase.status !== "OK") {
      return blocked(convertedBase.reasonCode);
    }

    const fixedFee = ensureCurrency(
      input.cost.fixedFee ?? money(0n, input.policy.currency),
      input.policy.currency,
    );
    if (!fixedFee) {
      return blocked("UNSUPPORTED_CURRENCY");
    }

    const percentageFee = multiplyBasisPointsUp(
      convertedBase.money.amountMinor,
      input.cost.percentageFeeBasisPoints ?? 0n,
    );
    const knownFees = money(
      fixedFee.amountMinor + percentageFee,
      input.policy.currency,
    );
    const subtotal = money(
      convertedBase.money.amountMinor + knownFees.amountMinor,
      input.policy.currency,
    );
    const tax = await this.options.taxPolicy.assess({
      calculatedAt,
      offerId: input.cost.offerId,
      productId: input.cost.productId,
      subtotal,
    });
    if (!tax.known) {
      return blocked("UNKNOWN_TAX_TREATMENT", {
        acquisitionCost: subtotal,
        currency: input.policy.currency,
        knownFees,
        taxPolicyVersion: tax.policyVersion,
        ...(convertedBase.fxRateVersion
          ? { fxRateVersion: convertedBase.fxRateVersion }
          : {}),
      });
    }
    if (tax.taxAmount.currency !== input.policy.currency) {
      return blocked("UNSUPPORTED_CURRENCY");
    }

    const effective = effectivePolicy(input.policy, input.override);
    const totalCost = money(
      subtotal.amountMinor + tax.taxAmount.amountMinor,
      input.policy.currency,
    );
    const manualPrice = input.override?.manualSellPrice;
    const formulaPrice = manualPrice
      ? ensureCurrency(manualPrice, input.policy.currency)
      : calculatedFormulaPrice(totalCost, effective);
    if (!formulaPrice) {
      return blocked("UNSUPPORTED_CURRENCY");
    }

    const safeFloor = minimumSafePrice(totalCost, effective);
    if (formulaPrice.amountMinor < safeFloor.amountMinor) {
      return blocked(
        manualPrice ? "MANUAL_PRICE_UNSAFE" : "BELOW_MINIMUM_PROFIT",
        {
          acquisitionCost: totalCost,
          currency: input.policy.currency,
          knownFees,
          preRoundingPrice: formulaPrice,
          sellPrice: formulaPrice,
          taxAmount: tax.taxAmount,
          taxPolicyVersion: tax.policyVersion,
          ...(convertedBase.fxRateVersion
            ? { fxRateVersion: convertedBase.fxRateVersion }
            : {}),
        },
      );
    }

    const rounded = roundPrice(formulaPrice, effective.rounding);
    const sellPrice =
      rounded.amountMinor < safeFloor.amountMinor
        ? roundPrice(safeFloor, effective.rounding)
        : rounded;
    if (sellPrice.amountMinor < effective.minimumSellPrice.amountMinor) {
      return blocked("BELOW_MINIMUM_SELL_PRICE");
    }
    const expectedProfit = money(
      sellPrice.amountMinor - totalCost.amountMinor,
      input.policy.currency,
    );
    if (expectedProfit.amountMinor < effective.minimumProfit.amountMinor) {
      return blocked(
        manualPrice ? "MANUAL_PRICE_UNSAFE" : "BELOW_MINIMUM_PROFIT",
      );
    }

    return quoteRecord({
      acquisitionCost: totalCost,
      calculatedAt,
      currency: input.policy.currency,
      expectedProfit,
      hardMinimumProfit: effective.minimumProfit,
      hardMinimumSellPrice: effective.minimumSellPrice,
      knownFees,
      offerId: input.cost.offerId,
      preRoundingPrice: formulaPrice,
      pricingPolicyRecordVersion: input.policy.version,
      productId: input.cost.productId,
      sellPrice,
      sourceFingerprint: sourceFingerprint(
        sourceFingerprintInput({
          cost: input.cost,
          policy: input.policy,
          taxPolicyVersion: tax.policyVersion,
          ...(convertedBase.fxRateVersion
            ? { fxRateVersion: convertedBase.fxRateVersion }
            : {}),
          ...(input.override?.manualPriceVersion
            ? { manualPriceVersion: input.override.manualPriceVersion }
            : {}),
          ...(input.override?.version
            ? { overrideVersion: input.override.version }
            : {}),
        }),
      ),
      status: "QUOTED",
      taxAmount: tax.taxAmount,
      taxPolicyVersion: tax.policyVersion,
      ...(convertedBase.fxRateVersion
        ? { fxRateVersion: convertedBase.fxRateVersion }
        : {}),
      ...(input.override?.manualPriceVersion
        ? { manualPriceVersion: input.override.manualPriceVersion }
        : {}),
      ...(input.override?.version
        ? { productOverrideVersion: input.override.version }
        : {}),
      ...(input.policy.quoteTtlMs
        ? {
            validUntil: new Date(
              calculatedAt.getTime() + input.policy.quoteTtlMs,
            ),
          }
        : {}),
    });
  }

  private async convertIfNeeded(input: {
    readonly moneyValue: Money;
    readonly targetCurrency: Money["currency"];
    readonly at: Date;
  }): Promise<
    | {
        readonly status: "OK";
        readonly money: Money;
        readonly fxRateVersion?: string;
      }
    | { readonly status: "BLOCKED"; readonly reasonCode: PricingReasonCode }
  > {
    if (input.moneyValue.currency === input.targetCurrency) {
      return { money: input.moneyValue, status: "OK" };
    }
    const quote = await this.options.exchangeRates?.quote({
      at: input.at,
      sourceCurrency: input.moneyValue.currency,
      targetCurrency: input.targetCurrency,
    });
    if (!quote) {
      return { reasonCode: "MISSING_FX_RATE", status: "BLOCKED" };
    }
    if (quote.validUntil && quote.validUntil.getTime() < input.at.getTime()) {
      return { reasonCode: "STALE_FX_RATE", status: "BLOCKED" };
    }
    if (quote.denominator <= 0n || quote.numerator <= 0n) {
      return { reasonCode: "MISSING_FX_RATE", status: "BLOCKED" };
    }
    return {
      fxRateVersion: quote.version,
      money: money(
        divideUp(
          input.moneyValue.amountMinor * quote.numerator,
          quote.denominator,
        ),
        input.targetCurrency,
      ),
      status: "OK",
    };
  }

  private blockedSelection(
    productIdValue: ProductId,
    quotes: readonly SellPriceQuote[],
    reasonCode: PricingReasonCode,
  ): ProductPriceSelection {
    return {
      productId: productIdValue,
      quotes,
      reasonCode,
      status:
        reasonCode === "UNKNOWN_TAX_TREATMENT" ? "REVIEW_REQUIRED" : "BLOCKED",
    };
  }

  private async auditQuote(
    quote: SellPriceQuote,
    correlationId: CorrelationId,
  ): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "pricing-service", type: "SERVICE" },
      correlationId,
      entity: { id: quote.productId, type: "PRODUCT" },
      environment: this.environment,
      eventType:
        quote.status === "QUOTED"
          ? "PRICING_QUOTE_CALCULATED"
          : "PRICING_QUOTE_BLOCKED",
      metadata: {
        currency: quote.currency,
        priceFingerprint: quote.sourceFingerprint,
        pricingPolicyVersion: quote.pricingPolicyVersion,
        productId: quote.productId,
        reasonCode: quote.reasonCode ?? "",
        status: quote.status,
      },
      outcome: quote.status === "QUOTED" ? "SUCCEEDED" : "DENIED",
      reasonCode: quote.reasonCode ?? "QUOTED",
      timestampUtc: quote.calculatedAt,
      uuid: randomUUID(),
    });
  }

  private async auditConfigurationChange(input: {
    readonly eventType: AuditEvent["eventType"];
    readonly correlationId: CorrelationId;
    readonly actorRef: string;
    readonly metadata: AuditEvent["metadata"];
    readonly productId?: ProductId;
  }): Promise<void> {
    await this.options.audit?.append({
      actor: { id: input.actorRef, type: "ADMIN" },
      correlationId: input.correlationId,
      entity: {
        id: input.productId ?? "global-pricing-policy",
        type: input.productId ? "PRODUCT" : "PRICING_POLICY",
      },
      environment: this.environment,
      eventType: input.eventType,
      metadata: input.metadata,
      outcome: "SUCCEEDED",
      reasonCode: "PRICING_CONFIGURATION_CHANGED",
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }
}

export class PricingStorefrontPriceProvider implements StorefrontPriceProvider {
  public constructor(private readonly pricing: PricingService) {}

  public async quoteSellPrice(input: {
    readonly product: StorefrontCanonicalProduct;
    readonly eligibleOffers: readonly StorefrontOfferSummary[];
    readonly correlationId: CorrelationId;
  }): Promise<Money | null> {
    const selection = await this.pricing.quoteProduct({
      correlationId: input.correlationId,
      eligibleOfferIds: input.eligibleOffers.map((offer) => offer.offerId),
      productId: input.product.productId,
    });
    return selection.selectedQuote?.sellPrice ?? null;
  }
}

export const pricingRecalculationJobPayload = (input: {
  readonly productId: ProductId;
  readonly correlationId: CorrelationId;
  readonly reason: string;
}): SafePayload => ({
  correlationId: input.correlationId,
  productId: input.productId,
  reason: input.reason,
});

export const createPricingPolicy = (input: {
  readonly policyId: string;
  readonly version?: number;
  readonly enabled?: boolean;
  readonly currency: Money["currency"];
  readonly markupBasisPoints: bigint;
  readonly fixedMarkup: Money;
  readonly minimumProfit: Money;
  readonly minimumSellPrice: Money;
  readonly rounding?: RoundingPolicy;
  readonly quoteTtlMs?: number;
  readonly now: Date;
  readonly targetMarginBasisPoints?: bigint;
}): PricingPolicy => {
  const policy: PricingPolicy = {
    createdAt: input.now,
    currency: input.currency,
    effectiveAt: input.now,
    enabled: input.enabled ?? true,
    fixedMarkup: input.fixedMarkup,
    markupBasisPoints: input.markupBasisPoints,
    minimumProfit: input.minimumProfit,
    minimumSellPrice: input.minimumSellPrice,
    policyId: input.policyId,
    policyVersion: pricingPolicyVersion,
    rounding: input.rounding ?? { mode: "MINOR_UNIT_UP" },
    updatedAt: input.now,
    version: input.version ?? 1,
    ...(input.quoteTtlMs !== undefined ? { quoteTtlMs: input.quoteTtlMs } : {}),
    ...(input.targetMarginBasisPoints !== undefined
      ? { targetMarginBasisPoints: input.targetMarginBasisPoints }
      : {}),
  };
  return validatePricingPolicy(policy);
};

export const markupBasisPoints = (input: {
  readonly cost: Money;
  readonly profit: Money;
}): bigint =>
  input.cost.amountMinor === 0n
    ? 0n
    : (input.profit.amountMinor * 10_000n) / input.cost.amountMinor;

export const marginBasisPoints = (input: {
  readonly sellPrice: Money;
  readonly profit: Money;
}): bigint =>
  input.sellPrice.amountMinor === 0n
    ? 0n
    : (input.profit.amountMinor * 10_000n) / input.sellPrice.amountMinor;

export const roundPrice = (price: Money, rounding: RoundingPolicy): Money => {
  if (rounding.mode === "MINOR_UNIT_UP") {
    return price;
  }
  const ending = rounding.endingMinor;
  if (ending < 0n || ending > 99n) {
    throw new Error("Psychological ending must be within minor unit cents");
  }
  const remainder = price.amountMinor % 100n;
  const base = price.amountMinor - remainder;
  const rounded = remainder <= ending ? base + ending : base + 100n + ending;
  return money(rounded, price.currency);
};

export const minimumSafePrice = (
  totalCost: Money,
  policy: EffectivePricingPolicy,
): Money =>
  money(
    maxBigInt(
      totalCost.amountMinor + policy.minimumProfit.amountMinor,
      policy.minimumSellPrice.amountMinor,
    ),
    totalCost.currency,
  );

export interface EffectivePricingPolicy {
  readonly markupBasisPoints: bigint;
  readonly targetMarginBasisPoints?: bigint;
  readonly fixedMarkup: Money;
  readonly minimumProfit: Money;
  readonly minimumSellPrice: Money;
  readonly rounding: RoundingPolicy;
  readonly quoteTtlMs?: number;
}

export const effectivePolicy = (
  policy: PricingPolicy,
  override: ProductPricingOverride | null,
): EffectivePricingPolicy => ({
  fixedMarkup: override?.fixedMarkup ?? policy.fixedMarkup,
  markupBasisPoints: override?.markupBasisPoints ?? policy.markupBasisPoints,
  minimumProfit: override?.minimumProfit ?? policy.minimumProfit,
  minimumSellPrice: override?.minimumSellPrice ?? policy.minimumSellPrice,
  rounding: override?.rounding ?? policy.rounding,
  ...((override?.quoteTtlMs ?? policy.quoteTtlMs)
    ? { quoteTtlMs: override?.quoteTtlMs ?? policy.quoteTtlMs }
    : {}),
  ...((override?.targetMarginBasisPoints ?? policy.targetMarginBasisPoints)
    ? {
        targetMarginBasisPoints:
          override?.targetMarginBasisPoints ?? policy.targetMarginBasisPoints,
      }
    : {}),
});

export const calculatedFormulaPrice = (
  totalCost: Money,
  policy: EffectivePricingPolicy,
): Money => {
  const markupPrice =
    totalCost.amountMinor +
    multiplyBasisPointsUp(totalCost.amountMinor, policy.markupBasisPoints) +
    policy.fixedMarkup.amountMinor;
  const targetMarginPrice =
    policy.targetMarginBasisPoints !== undefined
      ? divideUp(
          totalCost.amountMinor * 10_000n,
          10_000n - policy.targetMarginBasisPoints,
        )
      : 0n;
  return money(
    maxBigInt(
      markupPrice,
      targetMarginPrice,
      minimumSafePrice(totalCost, policy).amountMinor,
    ),
    totalCost.currency,
  );
};

const quoteRecord = (
  input: Omit<
    SellPriceQuote,
    "marginBasisPoints" | "markupBasisPoints" | "pricingPolicyVersion"
  >,
): SellPriceQuote => ({
  ...input,
  marginBasisPoints: marginBasisPoints({
    profit: input.expectedProfit,
    sellPrice: input.sellPrice,
  }),
  markupBasisPoints: markupBasisPoints({
    cost: input.acquisitionCost,
    profit: input.expectedProfit,
  }),
  pricingPolicyVersion,
});

const selectBestQuote = (
  quotes: readonly SellPriceQuote[],
): SellPriceQuote | null =>
  [...quotes]
    .filter((quote) => quote.status === "QUOTED")
    .sort(
      (left, right) =>
        Number(left.sellPrice.amountMinor - right.sellPrice.amountMinor) ||
        left.offerId.localeCompare(right.offerId),
    )[0] ?? null;

const multiplyBasisPointsUp = (amount: bigint, basisPoints: bigint): bigint =>
  divideUp(amount * basisPoints, 10_000n);

const divideUp = (numerator: bigint, denominator: bigint): bigint =>
  (numerator + denominator - 1n) / denominator;

const ensureCurrency = (
  value: Money,
  expectedCurrency: Money["currency"],
): Money | null => (value.currency === expectedCurrency ? value : null);

const maxBigInt = (...values: readonly bigint[]): bigint =>
  values.reduce((left, right) => (left > right ? left : right));

const sourceFingerprint = (input: {
  readonly cost: AcquisitionCostInput;
  readonly policy: PricingPolicy | null;
  readonly overrideVersion?: number;
  readonly manualPriceVersion?: number;
  readonly fxRateVersion?: string;
  readonly taxPolicyVersion: string;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        costVersion: input.cost.costVersion,
        currency: input.cost.baseSupplierPrice.currency,
        fixedFee: input.cost.fixedFee?.amountMinor.toString() ?? "0",
        fxRateVersion: input.fxRateVersion ?? "",
        manualPriceVersion: input.manualPriceVersion ?? "",
        offerId: input.cost.offerId,
        overrideVersion: input.overrideVersion ?? "",
        percentageFeeBasisPoints:
          input.cost.percentageFeeBasisPoints?.toString() ?? "0",
        policyRecordVersion: input.policy?.version ?? 0,
        policyVersion: input.policy?.policyVersion ?? "",
        price: input.cost.baseSupplierPrice.amountMinor.toString(),
        productId: input.cost.productId,
        taxPolicyVersion: input.taxPolicyVersion,
      }),
    )
    .digest("hex");

const sourceFingerprintInput = (input: {
  readonly cost: AcquisitionCostInput;
  readonly policy: PricingPolicy | null;
  readonly overrideVersion?: number;
  readonly manualPriceVersion?: number;
  readonly fxRateVersion?: string;
  readonly taxPolicyVersion: string;
}): Parameters<typeof sourceFingerprint>[0] => ({
  cost: input.cost,
  policy: input.policy,
  taxPolicyVersion: input.taxPolicyVersion,
  ...(input.fxRateVersion ? { fxRateVersion: input.fxRateVersion } : {}),
  ...(input.manualPriceVersion
    ? { manualPriceVersion: input.manualPriceVersion }
    : {}),
  ...(input.overrideVersion ? { overrideVersion: input.overrideVersion } : {}),
});

const changedGlobalFields = (update: PricingPolicyUpdate): readonly string[] =>
  Object.keys(update)
    .filter((key) => !["expectedVersion", "actorRef", "reason"].includes(key))
    .sort();

const changedOverrideFields = (
  update: ProductPricingOverrideUpdate,
): readonly string[] =>
  Object.keys(update)
    .filter(
      (key) =>
        !["productId", "expectedVersion", "actorRef", "reason"].includes(key),
    )
    .sort();

export const validatePricingPolicy = (policy: PricingPolicy): PricingPolicy => {
  assertPositiveInteger(policy.version, "Pricing policy version");
  assertNonNegativeBasisPoints(
    policy.markupBasisPoints,
    "Pricing markup basis points",
  );
  assertTargetMargin(policy.targetMarginBasisPoints);
  assertNonNegativeMoney(policy.fixedMarkup, "Fixed markup");
  assertNonNegativeMoney(policy.minimumProfit, "Minimum profit");
  assertNonNegativeMoney(policy.minimumSellPrice, "Minimum sell price");
  assertRoundingPolicy(policy.rounding);
  assertPositiveTtl(policy.quoteTtlMs);
  return policy;
};

export const validatePricingPolicyUpdate = (
  update: PricingPolicyUpdate,
): PricingPolicyUpdate => {
  assertPositiveInteger(
    update.expectedVersion,
    "Expected pricing policy version",
  );
  if (update.markupBasisPoints !== undefined) {
    assertNonNegativeBasisPoints(
      update.markupBasisPoints,
      "Pricing markup basis points",
    );
  }
  assertTargetMargin(update.targetMarginBasisPoints);
  if (update.fixedMarkup) {
    assertNonNegativeMoney(update.fixedMarkup, "Fixed markup");
  }
  if (update.minimumProfit) {
    assertNonNegativeMoney(update.minimumProfit, "Minimum profit");
  }
  if (update.minimumSellPrice) {
    assertNonNegativeMoney(update.minimumSellPrice, "Minimum sell price");
  }
  if (update.rounding) {
    assertRoundingPolicy(update.rounding);
  }
  assertPositiveTtl(update.quoteTtlMs);
  return update;
};

export const validateProductPricingOverride = (
  override: ProductPricingOverride,
): ProductPricingOverride => {
  assertPositiveInteger(override.version, "Product pricing override version");
  assertOptionalNonNegativeBasisPoints(
    override.markupBasisPoints,
    "Product markup basis points",
  );
  assertTargetMargin(override.targetMarginBasisPoints);
  assertOptionalNonNegativeMoney(override.fixedMarkup, "Fixed markup override");
  assertOptionalNonNegativeMoney(
    override.minimumProfit,
    "Minimum profit override",
  );
  assertOptionalNonNegativeMoney(
    override.minimumSellPrice,
    "Minimum sell price override",
  );
  if (override.rounding) {
    assertRoundingPolicy(override.rounding);
  }
  assertPositiveTtl(override.quoteTtlMs);
  assertManualSellPrice(override.manualSellPrice);
  if (
    override.manualSellPrice &&
    (!override.manualPriceVersion || override.manualPriceVersion <= 0)
  ) {
    throw new PricingConfigurationValidationError(
      "Manual price version must be greater than zero when manual price exists",
    );
  }
  return override;
};

export const validateProductPricingOverrideUpdate = (
  update: ProductPricingOverrideUpdate,
): ProductPricingOverrideUpdate => {
  assertOptionalNonNegativeBasisPoints(
    update.markupBasisPoints,
    "Product markup basis points",
  );
  assertTargetMargin(update.targetMarginBasisPoints);
  assertOptionalNonNegativeMoney(update.fixedMarkup, "Fixed markup override");
  assertOptionalNonNegativeMoney(
    update.minimumProfit,
    "Minimum profit override",
  );
  assertOptionalNonNegativeMoney(
    update.minimumSellPrice,
    "Minimum sell price override",
  );
  if (update.rounding) {
    assertRoundingPolicy(update.rounding);
  }
  assertPositiveTtl(update.quoteTtlMs);
  assertManualSellPrice(update.manualSellPrice);
  return update;
};

const assertManualSellPrice = (value: Money | null | undefined): void => {
  if (value === undefined || value === null) {
    return;
  }
  if (value.amountMinor <= 0n) {
    throw new PricingConfigurationValidationError(
      "Manual sell price must be greater than zero",
    );
  }
};

const assertOptionalNonNegativeMoney = (
  value: Money | null | undefined,
  label: string,
): void => {
  if (value !== undefined && value !== null) {
    assertNonNegativeMoney(value, label);
  }
};

const assertNonNegativeMoney = (value: Money, label: string): void => {
  if (value.amountMinor < 0n) {
    throw new PricingConfigurationValidationError(
      `${label} must not be negative`,
    );
  }
};

const assertOptionalNonNegativeBasisPoints = (
  value: bigint | null | undefined,
  label: string,
): void => {
  if (value !== undefined && value !== null) {
    assertNonNegativeBasisPoints(value, label);
  }
};

const assertNonNegativeBasisPoints = (value: bigint, label: string): void => {
  if (value < 0n) {
    throw new PricingConfigurationValidationError(
      `${label} must not be negative`,
    );
  }
};

const assertTargetMargin = (value: bigint | null | undefined): void => {
  if (value === undefined || value === null) {
    return;
  }
  if (value <= 0n || value >= 10_000n) {
    throw new PricingConfigurationValidationError(
      "Target margin basis points must be greater than zero and less than 10000",
    );
  }
};

const assertPositiveTtl = (value: number | null | undefined): void => {
  if (value === undefined || value === null) {
    return;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new PricingConfigurationValidationError(
      "Quote TTL must be a positive integer when configured",
    );
  }
};

const assertPositiveInteger = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new PricingConfigurationValidationError(
      `${label} must be a positive integer`,
    );
  }
};

const assertRoundingPolicy = (rounding: RoundingPolicy): void => {
  if (rounding.mode === "MINOR_UNIT_UP") {
    return;
  }
  if (rounding.endingMinor < 0n || rounding.endingMinor > 99n) {
    throw new PricingConfigurationValidationError(
      "Psychological ending must be within minor unit cents",
    );
  }
};
