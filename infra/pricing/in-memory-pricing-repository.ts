import {
  PricingConfigurationConflictError,
  pricingPolicyVersion,
  type PriceSnapshotRepository,
  type PricingPolicy,
  type PricingPolicyRepository,
  type PricingPolicyUpdate,
  type ProductPricingOverride,
  type ProductPricingOverrideRepository,
  type ProductPricingOverrideUpdate,
  type SellPriceQuote,
} from "../../packages/platform/src/pricing/pricing-margin.js";
import type { ProductId } from "../../packages/platform/src/contracts.js";

export class InMemoryPricingRepository
  implements
    PricingPolicyRepository,
    ProductPricingOverrideRepository,
    PriceSnapshotRepository
{
  private activePolicy: PricingPolicy | null;
  private readonly overrides = new Map<string, ProductPricingOverride>();
  private readonly snapshots: SellPriceQuote[] = [];

  public constructor(policy: PricingPolicy | null = null) {
    this.activePolicy = policy;
  }

  public async getActivePolicy(): Promise<PricingPolicy | null> {
    return this.activePolicy;
  }

  public async updateActivePolicy(
    update: PricingPolicyUpdate,
  ): Promise<PricingPolicy> {
    const current = this.activePolicy;
    if (!current) {
      throw new Error("No active pricing policy configured");
    }
    if (current.version !== update.expectedVersion) {
      throw new PricingConfigurationConflictError();
    }
    const updated: PricingPolicy = {
      ...current,
      actorRef: update.actorRef,
      enabled: update.enabled ?? current.enabled,
      fixedMarkup: update.fixedMarkup ?? current.fixedMarkup,
      markupBasisPoints: update.markupBasisPoints ?? current.markupBasisPoints,
      minimumProfit: update.minimumProfit ?? current.minimumProfit,
      minimumSellPrice: update.minimumSellPrice ?? current.minimumSellPrice,
      policyVersion: pricingPolicyVersion,
      reason: update.reason,
      rounding: update.rounding ?? current.rounding,
      updatedAt: new Date(current.updatedAt.getTime() + 1),
      version: current.version + 1,
      ...(update.quoteTtlMs !== undefined
        ? update.quoteTtlMs === null
          ? {}
          : { quoteTtlMs: update.quoteTtlMs }
        : current.quoteTtlMs
          ? { quoteTtlMs: current.quoteTtlMs }
          : {}),
      ...(update.targetMarginBasisPoints !== undefined
        ? update.targetMarginBasisPoints === null
          ? {}
          : { targetMarginBasisPoints: update.targetMarginBasisPoints }
        : current.targetMarginBasisPoints !== undefined
          ? { targetMarginBasisPoints: current.targetMarginBasisPoints }
          : {}),
    };
    this.activePolicy = updated;
    return updated;
  }

  public async getOverride(
    productId: ProductId,
  ): Promise<ProductPricingOverride | null> {
    return this.overrides.get(productId) ?? null;
  }

  public async updateOverride(
    update: ProductPricingOverrideUpdate,
  ): Promise<ProductPricingOverride> {
    const current = this.overrides.get(update.productId);
    if (
      update.expectedVersion !== undefined &&
      current?.version !== update.expectedVersion
    ) {
      throw new PricingConfigurationConflictError();
    }
    const now = current
      ? new Date(current.updatedAt.getTime() + 1)
      : new Date("2026-08-15T00:00:00.000Z");
    const updated: ProductPricingOverride = {
      createdAt: current?.createdAt ?? now,
      enabled: update.enabled ?? current?.enabled ?? true,
      productId: update.productId,
      updatedAt: now,
      version: (current?.version ?? 0) + 1,
      ...(update.actorRef ? { actorRef: update.actorRef } : {}),
      ...(update.fixedMarkup !== undefined
        ? { fixedMarkup: update.fixedMarkup }
        : current?.fixedMarkup !== undefined
          ? { fixedMarkup: current.fixedMarkup }
          : {}),
      ...(update.manualSellPrice !== undefined
        ? {
            manualPriceVersion:
              update.manualSellPrice === null
                ? null
                : (current?.manualPriceVersion ?? 0) + 1,
            manualSellPrice: update.manualSellPrice,
          }
        : current?.manualSellPrice !== undefined
          ? {
              manualPriceVersion: current.manualPriceVersion,
              manualSellPrice: current.manualSellPrice,
            }
          : {}),
      ...(update.markupBasisPoints !== undefined
        ? { markupBasisPoints: update.markupBasisPoints }
        : current?.markupBasisPoints !== undefined
          ? { markupBasisPoints: current.markupBasisPoints }
          : {}),
      ...(update.minimumProfit !== undefined
        ? { minimumProfit: update.minimumProfit }
        : current?.minimumProfit !== undefined
          ? { minimumProfit: current.minimumProfit }
          : {}),
      ...(update.minimumSellPrice !== undefined
        ? { minimumSellPrice: update.minimumSellPrice }
        : current?.minimumSellPrice !== undefined
          ? { minimumSellPrice: current.minimumSellPrice }
          : {}),
      ...(update.quoteTtlMs !== undefined
        ? { quoteTtlMs: update.quoteTtlMs }
        : current?.quoteTtlMs !== undefined
          ? { quoteTtlMs: current.quoteTtlMs }
          : {}),
      ...(update.reason ? { reason: update.reason } : {}),
      ...(update.rounding !== undefined
        ? { rounding: update.rounding }
        : current?.rounding !== undefined
          ? { rounding: current.rounding }
          : {}),
      ...(update.targetMarginBasisPoints !== undefined
        ? { targetMarginBasisPoints: update.targetMarginBasisPoints }
        : current?.targetMarginBasisPoints !== undefined
          ? { targetMarginBasisPoints: current.targetMarginBasisPoints }
          : {}),
    };
    this.overrides.set(update.productId, updated);
    return updated;
  }

  public async clearOverride(input: {
    readonly productId: ProductId;
    readonly expectedVersion: number;
  }): Promise<void> {
    const current = this.overrides.get(input.productId);
    if (!current || current.version !== input.expectedVersion) {
      throw new PricingConfigurationConflictError();
    }
    this.overrides.delete(input.productId);
  }

  public async saveSnapshot(quote: SellPriceQuote): Promise<void> {
    this.snapshots.push(quote);
  }

  public listSnapshots(): readonly SellPriceQuote[] {
    return this.snapshots;
  }
}
