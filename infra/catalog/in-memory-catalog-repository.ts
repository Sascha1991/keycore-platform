import type {
  CatalogSupplierOfferRecord,
  CatalogSupplierProductRecord,
  CatalogSyncCheckpoint,
  CatalogSyncMetrics,
  CatalogSyncMode,
  CatalogSyncRepository,
  CatalogSyncRun,
} from "../../packages/platform/src/catalog/synchronization.js";
import type {
  SupplierId,
  SupplierOfferId,
  SupplierProductId,
} from "../../packages/platform/src/contracts.js";

export class InMemoryCatalogSyncRepository implements CatalogSyncRepository {
  private readonly products = new Map<string, CatalogSupplierProductRecord>();
  private readonly offers = new Map<string, CatalogSupplierOfferRecord>();
  private readonly runs = new Map<string, CatalogSyncRun>();
  private readonly checkpoints = new Map<string, CatalogSyncCheckpoint>();
  private nextRunSequence = 1;

  public async beginRun(input: {
    readonly supplierId: SupplierId;
    readonly mode: CatalogSyncMode;
    readonly startedAt: Date;
  }): Promise<CatalogSyncRun> {
    const run: CatalogSyncRun = {
      metrics: zeroMetrics(),
      mode: input.mode,
      runId: `catalog-run-${this.nextRunSequence}`,
      startedAt: input.startedAt,
      status: "RUNNING",
      supplierId: input.supplierId,
    };
    this.nextRunSequence += 1;
    this.runs.set(run.runId, run);
    return run;
  }

  public async completeRun(input: {
    readonly runId: string;
    readonly completedAt: Date;
    readonly metrics: CatalogSyncMetrics;
  }): Promise<CatalogSyncRun> {
    const run = this.getRun(input.runId);
    const completed = {
      ...run,
      completedAt: input.completedAt,
      metrics: input.metrics,
      status: "SUCCEEDED" as const,
    };
    this.runs.set(input.runId, completed);
    return completed;
  }

  public async failRun(input: {
    readonly runId: string;
    readonly failedAt: Date;
    readonly errorMessage: string;
    readonly metrics: CatalogSyncMetrics;
  }): Promise<CatalogSyncRun> {
    const run = this.getRun(input.runId);
    const failed = {
      ...run,
      errorMessage: input.errorMessage,
      failedAt: input.failedAt,
      metrics: input.metrics,
      status: "FAILED" as const,
    };
    this.runs.set(input.runId, failed);
    return failed;
  }

  public async upsertProduct(
    input: Parameters<CatalogSyncRepository["upsertProduct"]>[0],
  ): Promise<void> {
    const key = productKey(
      input.product.supplier.supplierId,
      input.product.supplierProductId,
    );
    const existing = this.products.get(key);
    this.products.set(key, {
      active: true,
      changedAt: input.product.changedAt,
      firstSeenAt: existing?.firstSeenAt ?? input.observedAt,
      lastSeenAt: input.observedAt,
      lastSyncRunId: input.runId,
      lifecycle: input.product.lifecycle,
      platforms: input.product.product.platforms,
      productType: input.product.product.type,
      supplierId: input.product.supplier.supplierId,
      supplierProductId: input.product.supplierProductId,
      title: input.product.product.title,
    });
  }

  public async upsertOffer(
    input: Parameters<CatalogSyncRepository["upsertOffer"]>[0],
  ): Promise<void> {
    const key = offerKey(
      input.offer.supplier.supplierId,
      input.offer.supplierOfferId,
    );
    const existing = this.offers.get(key);
    if (
      existing &&
      existing.supplierProductId !== input.offer.supplierProductId
    ) {
      throw new Error(
        "Supplier offer/product mapping changed without reconciliation",
      );
    }

    this.offers.set(key, {
      active: true,
      availability: input.offer.offer.availability,
      capturedAt: input.offer.capturedAt,
      changedAt: input.offer.capturedAt,
      currentPrice: input.offer.offer.currentPrice,
      firstSeenAt: existing?.firstSeenAt ?? input.observedAt,
      germanyDecision: input.assessment.decision,
      germanyPolicyVersion: input.assessment.policyVersion,
      germanyReasonCode: input.assessment.reasonCode,
      lastSeenAt: input.observedAt,
      lastSyncRunId: input.runId,
      regionEvidence: input.offer.regionEvidence,
      supplierId: input.offer.supplier.supplierId,
      supplierOfferId: input.offer.supplierOfferId,
      supplierProductId: input.offer.supplierProductId,
    });
  }

  public async deactivateStaleFullSyncRecords(input: {
    readonly supplierId: SupplierId;
    readonly runId: string;
    readonly observedAt: Date;
  }): Promise<{ readonly products: number; readonly offers: number }> {
    let products = 0;
    let offers = 0;

    for (const [key, product] of this.products) {
      if (
        product.supplierId === input.supplierId &&
        product.active &&
        product.lastSyncRunId !== input.runId
      ) {
        this.products.set(key, {
          ...product,
          active: false,
          lastSeenAt: input.observedAt,
        });
        products += 1;
      }
    }

    for (const [key, offer] of this.offers) {
      if (
        offer.supplierId === input.supplierId &&
        offer.active &&
        offer.lastSyncRunId !== input.runId
      ) {
        this.offers.set(key, {
          ...offer,
          active: false,
          lastSeenAt: input.observedAt,
        });
        offers += 1;
      }
    }

    return { offers, products };
  }

  public async getCheckpoint(input: {
    readonly supplierId: SupplierId;
    readonly mode: "FULL" | "INCREMENTAL";
  }): Promise<CatalogSyncCheckpoint | null> {
    return (
      this.checkpoints.get(checkpointKey(input.supplierId, input.mode)) ?? null
    );
  }

  public async saveCheckpoint(input: CatalogSyncCheckpoint): Promise<void> {
    this.checkpoints.set(checkpointKey(input.supplierId, input.mode), input);
  }

  public async getOfferMapping(input: {
    readonly supplierId: SupplierId;
    readonly supplierOfferId: SupplierOfferId;
  }): Promise<SupplierProductId | null> {
    return (
      this.offers.get(offerKey(input.supplierId, input.supplierOfferId))
        ?.supplierProductId ?? null
    );
  }

  public getProduct(input: {
    readonly supplierId: SupplierId;
    readonly supplierProductId: SupplierProductId;
  }): CatalogSupplierProductRecord | null {
    return (
      this.products.get(
        productKey(input.supplierId, input.supplierProductId),
      ) ?? null
    );
  }

  public getOffer(input: {
    readonly supplierId: SupplierId;
    readonly supplierOfferId: SupplierOfferId;
  }): CatalogSupplierOfferRecord | null {
    return (
      this.offers.get(offerKey(input.supplierId, input.supplierOfferId)) ?? null
    );
  }

  public listOffers(): readonly CatalogSupplierOfferRecord[] {
    return [...this.offers.values()].sort((left, right) =>
      left.supplierOfferId.localeCompare(right.supplierOfferId),
    );
  }

  public listProducts(): readonly CatalogSupplierProductRecord[] {
    return [...this.products.values()].sort((left, right) =>
      left.supplierProductId.localeCompare(right.supplierProductId),
    );
  }

  public listRuns(): readonly CatalogSyncRun[] {
    return [...this.runs.values()];
  }

  private getRun(runId: string): CatalogSyncRun {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Unknown catalog sync run ${runId}`);
    }

    return run;
  }
}

const productKey = (
  supplierId: SupplierId,
  supplierProductId: SupplierProductId,
): string => `${supplierId}:${supplierProductId}`;

const offerKey = (
  supplierId: SupplierId,
  supplierOfferId: SupplierOfferId,
): string => `${supplierId}:${supplierOfferId}`;

const checkpointKey = (
  supplierId: SupplierId,
  mode: "FULL" | "INCREMENTAL",
): string => `${supplierId}:${mode}`;

const zeroMetrics = (): CatalogSyncMetrics => ({
  errors: 0,
  offersAllowedForGermany: 0,
  offersBlockedForGermany: 0,
  offersDisabledForGermany: 0,
  offersReviewRequiredForGermany: 0,
  offersSeen: 0,
  offersUpserted: 0,
  pagesFetched: 0,
  productsSeen: 0,
  productsUpserted: 0,
  staleOffersDeactivated: 0,
  staleProductsDeactivated: 0,
});
