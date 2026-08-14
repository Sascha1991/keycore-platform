import type { Availability, PriceSnapshot } from "../domain/catalog.js";
import type {
  SupplierId,
  SupplierOfferId,
  SupplierProductId,
} from "../domain/identifiers.js";
import type { Money } from "../domain/money.js";
import type {
  GermanyCompatibilityDecision,
  GermanyCompatibilityReasonCode,
  RegionEvidence,
} from "../domain/region.js";
import type {
  NormalizedSupplierOffer,
  NormalizedSupplierProduct,
  Page,
  PageRequest,
  SupplierIdentity,
  SupplierPort,
} from "../ports/supplier.js";
import {
  germanyEligibilityPolicyVersion,
  type GermanyEligibilityEngine,
  type GermanyEligibilityAssessment,
} from "./germany-eligibility.js";

export type CatalogSyncMode = "FULL" | "INCREMENTAL" | "WEBHOOK";
export type CatalogSyncRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED";

export interface CatalogSyncRun {
  readonly runId: string;
  readonly supplierId: SupplierId;
  readonly mode: CatalogSyncMode;
  readonly startedAt: Date;
  readonly completedAt?: Date;
  readonly failedAt?: Date;
  readonly status: CatalogSyncRunStatus;
  readonly errorMessage?: string;
  readonly metrics: CatalogSyncMetrics;
}

export interface CatalogSyncMetrics {
  readonly productsSeen: number;
  readonly productsUpserted: number;
  readonly offersSeen: number;
  readonly offersUpserted: number;
  readonly offersAllowedForGermany: number;
  readonly offersBlockedForGermany: number;
  readonly offersReviewRequiredForGermany: number;
  readonly offersDisabledForGermany: number;
  readonly staleProductsDeactivated: number;
  readonly staleOffersDeactivated: number;
  readonly pagesFetched: number;
  readonly errors: number;
}

export interface CatalogSupplierProductRecord {
  readonly supplierId: SupplierId;
  readonly supplierProductId: SupplierProductId;
  readonly title: string;
  readonly productType: string;
  readonly platforms: readonly string[];
  readonly lifecycle: Availability;
  readonly changedAt: Date;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly active: boolean;
  readonly lastSyncRunId: string;
}

export interface CatalogSupplierOfferRecord {
  readonly supplierId: SupplierId;
  readonly supplierOfferId: SupplierOfferId;
  readonly supplierProductId: SupplierProductId;
  readonly availability: Availability;
  readonly currentPrice: Money;
  readonly changedAt: Date;
  readonly capturedAt: Date;
  readonly germanyDecision: GermanyCompatibilityDecision;
  readonly germanyReasonCode: GermanyCompatibilityReasonCode;
  readonly germanyPolicyVersion: typeof germanyEligibilityPolicyVersion;
  readonly regionEvidence: RegionEvidence;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly active: boolean;
  readonly lastSyncRunId: string;
}

export interface CatalogSyncCheckpoint {
  readonly supplierId: SupplierId;
  readonly mode: "FULL" | "INCREMENTAL";
  readonly cursor?: string;
  readonly highWatermark?: Date;
  readonly completedAt?: Date;
}

export interface CatalogAuditEvent {
  readonly eventType:
    | "CATALOG_SYNC_STARTED"
    | "CATALOG_SYNC_SUCCEEDED"
    | "CATALOG_SYNC_FAILED"
    | "CATALOG_WEBHOOK_NORMALIZED";
  readonly supplierId: SupplierId;
  readonly mode: CatalogSyncMode;
  readonly runId?: string;
  readonly occurredAt: Date;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface CatalogAuditPort {
  record(event: CatalogAuditEvent): Promise<void>;
}

export interface CatalogOfferDiscoveryPort {
  listOffersForProduct(input: {
    readonly supplier: SupplierPort;
    readonly product: NormalizedSupplierProduct;
  }): Promise<readonly NormalizedSupplierOffer[]>;
}

export interface CatalogSyncRepository {
  beginRun(input: {
    readonly supplierId: SupplierId;
    readonly mode: CatalogSyncMode;
    readonly startedAt: Date;
  }): Promise<CatalogSyncRun>;
  completeRun(input: {
    readonly runId: string;
    readonly completedAt: Date;
    readonly metrics: CatalogSyncMetrics;
  }): Promise<CatalogSyncRun>;
  failRun(input: {
    readonly runId: string;
    readonly failedAt: Date;
    readonly errorMessage: string;
    readonly metrics: CatalogSyncMetrics;
  }): Promise<CatalogSyncRun>;
  upsertProduct(input: {
    readonly product: NormalizedSupplierProduct;
    readonly runId: string;
    readonly observedAt: Date;
  }): Promise<void>;
  upsertOffer(input: {
    readonly offer: NormalizedSupplierOffer;
    readonly assessment: GermanyEligibilityAssessment;
    readonly runId: string;
    readonly observedAt: Date;
  }): Promise<void>;
  deactivateStaleFullSyncRecords(input: {
    readonly supplierId: SupplierId;
    readonly runId: string;
    readonly observedAt: Date;
  }): Promise<{
    readonly products: number;
    readonly offers: number;
  }>;
  getCheckpoint(input: {
    readonly supplierId: SupplierId;
    readonly mode: "FULL" | "INCREMENTAL";
  }): Promise<CatalogSyncCheckpoint | null>;
  saveCheckpoint(input: CatalogSyncCheckpoint): Promise<void>;
  getOfferMapping(input: {
    readonly supplierId: SupplierId;
    readonly supplierOfferId: SupplierOfferId;
  }): Promise<SupplierProductId | null>;
}

export interface CatalogSyncServiceOptions {
  readonly repository: CatalogSyncRepository;
  readonly offerDiscovery: CatalogOfferDiscoveryPort;
  readonly eligibilityEngine: GermanyEligibilityEngine;
  readonly audit?: CatalogAuditPort;
  readonly now?: () => Date;
  readonly pageLimit?: number;
  readonly incrementalOverlapMs?: number;
}

export interface CatalogSyncResult {
  readonly run: CatalogSyncRun;
  readonly checkpoint?: CatalogSyncCheckpoint;
  readonly unsupported?: boolean;
}

export class CatalogSyncService {
  private readonly now: () => Date;
  private readonly pageLimit: number;
  private readonly incrementalOverlapMs: number;

  public constructor(private readonly options: CatalogSyncServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.pageLimit = options.pageLimit ?? 100;
    this.incrementalOverlapMs = options.incrementalOverlapMs ?? 300_000;
  }

  public async runFullSync(supplier: SupplierPort): Promise<CatalogSyncResult> {
    return this.runPagedSync({
      fetchPage: (page) => supplier.listCatalog(page),
      mode: "FULL",
      supplier,
    });
  }

  public async runIncrementalSync(
    supplier: SupplierPort,
  ): Promise<CatalogSyncResult> {
    if (
      !supplier.capabilities.supportsDeltaCatalog ||
      !supplier.listCatalogDelta
    ) {
      const startedAt = this.now();
      const run = await this.options.repository.beginRun({
        mode: "INCREMENTAL",
        startedAt,
        supplierId: supplier.identity.supplierId,
      });
      const metrics = zeroMetrics(1);
      const completed = await this.options.repository.completeRun({
        completedAt: startedAt,
        metrics,
        runId: run.runId,
      });
      return { run: completed, unsupported: true };
    }

    const checkpoint = await this.options.repository.getCheckpoint({
      mode: "INCREMENTAL",
      supplierId: supplier.identity.supplierId,
    });
    const since = new Date(
      (checkpoint?.highWatermark?.getTime() ?? 0) - this.incrementalOverlapMs,
    );
    const highWatermark = this.now();

    return this.runPagedSync({
      fetchPage: async (page) =>
        supplier.listCatalogDelta?.({ page, since }) ?? emptyPage(),
      highWatermark,
      mode: "INCREMENTAL",
      supplier,
    });
  }

  public async ingestWebhook(input: {
    readonly supplier: SupplierPort;
    readonly product: NormalizedSupplierProduct;
    readonly offers: readonly NormalizedSupplierOffer[];
  }): Promise<CatalogSyncResult> {
    const startedAt = this.now();
    const run = await this.options.repository.beginRun({
      mode: "WEBHOOK",
      startedAt,
      supplierId: input.supplier.identity.supplierId,
    });
    const metrics = mutableMetrics();

    await this.options.audit?.record({
      eventType: "CATALOG_WEBHOOK_NORMALIZED",
      metadata: { offerCount: input.offers.length },
      mode: "WEBHOOK",
      occurredAt: startedAt,
      runId: run.runId,
      supplierId: input.supplier.identity.supplierId,
    });

    try {
      await this.processProduct(
        input.supplier.identity,
        input.product,
        input.offers,
        run.runId,
        metrics,
      );
      const completed = await this.options.repository.completeRun({
        completedAt: this.now(),
        metrics: freezeMetrics(metrics),
        runId: run.runId,
      });
      return { run: completed };
    } catch (error) {
      const failed = await this.fail(run.runId, error, metrics);
      return { run: failed };
    }
  }

  private async runPagedSync(input: {
    readonly supplier: SupplierPort;
    readonly mode: "FULL" | "INCREMENTAL";
    readonly fetchPage: (
      page: PageRequest,
    ) => Promise<Page<NormalizedSupplierProduct>>;
    readonly highWatermark?: Date;
  }): Promise<CatalogSyncResult> {
    const startedAt = this.now();
    const run = await this.options.repository.beginRun({
      mode: input.mode,
      startedAt,
      supplierId: input.supplier.identity.supplierId,
    });
    const metrics = mutableMetrics();

    await this.options.audit?.record({
      eventType: "CATALOG_SYNC_STARTED",
      metadata: {},
      mode: input.mode,
      occurredAt: startedAt,
      runId: run.runId,
      supplierId: input.supplier.identity.supplierId,
    });

    try {
      let cursor: string | undefined;
      do {
        const pageRequest: PageRequest = cursor
          ? { cursor, limit: this.pageLimit }
          : { limit: this.pageLimit };
        const page = await input.fetchPage(pageRequest);
        metrics.pagesFetched += 1;
        for (const product of page.items) {
          const offers = await this.options.offerDiscovery.listOffersForProduct(
            {
              product,
              supplier: input.supplier,
            },
          );
          await this.processProduct(
            input.supplier.identity,
            product,
            offers,
            run.runId,
            metrics,
          );
        }
        cursor = page.nextCursor;
      } while (cursor);

      if (input.mode === "FULL") {
        const stale =
          await this.options.repository.deactivateStaleFullSyncRecords({
            observedAt: this.now(),
            runId: run.runId,
            supplierId: input.supplier.identity.supplierId,
          });
        metrics.staleProductsDeactivated = stale.products;
        metrics.staleOffersDeactivated = stale.offers;
      }

      const completedAt = this.now();
      const checkpoint: CatalogSyncCheckpoint = {
        completedAt,
        highWatermark: input.highWatermark ?? completedAt,
        mode: input.mode,
        supplierId: input.supplier.identity.supplierId,
      };
      await this.options.repository.saveCheckpoint(checkpoint);
      const completed = await this.options.repository.completeRun({
        completedAt,
        metrics: freezeMetrics(metrics),
        runId: run.runId,
      });
      await this.options.audit?.record({
        eventType: "CATALOG_SYNC_SUCCEEDED",
        metadata: {
          offersSeen: completed.metrics.offersSeen,
          productsSeen: completed.metrics.productsSeen,
        },
        mode: input.mode,
        occurredAt: completedAt,
        runId: run.runId,
        supplierId: input.supplier.identity.supplierId,
      });

      return { checkpoint, run: completed };
    } catch (error) {
      const failed = await this.fail(run.runId, error, metrics);
      await this.options.audit?.record({
        eventType: "CATALOG_SYNC_FAILED",
        metadata: { errors: failed.metrics.errors },
        mode: input.mode,
        occurredAt: failed.failedAt ?? this.now(),
        runId: run.runId,
        supplierId: input.supplier.identity.supplierId,
      });
      return { run: failed };
    }
  }

  private async processProduct(
    supplier: SupplierIdentity,
    product: NormalizedSupplierProduct,
    offers: readonly NormalizedSupplierOffer[],
    runId: string,
    metrics: MutableCatalogSyncMetrics,
  ): Promise<void> {
    if (product.supplier.supplierId !== supplier.supplierId) {
      throw new Error("Catalog product supplier identity mismatch");
    }

    await this.options.repository.upsertProduct({
      observedAt: this.now(),
      product,
      runId,
    });
    metrics.productsSeen += 1;
    metrics.productsUpserted += 1;

    for (const offer of offers) {
      if (offer.supplier.supplierId !== supplier.supplierId) {
        throw new Error("Catalog offer supplier identity mismatch");
      }
      if (offer.supplierProductId !== product.supplierProductId) {
        throw new Error("Catalog offer/product mapping mismatch");
      }

      const existingMapping = await this.options.repository.getOfferMapping({
        supplierId: supplier.supplierId,
        supplierOfferId: offer.supplierOfferId,
      });
      if (existingMapping && existingMapping !== offer.supplierProductId) {
        throw new Error(
          "Supplier offer/product mapping changed without reconciliation",
        );
      }

      const assessment = this.options.eligibilityEngine.evaluate({
        evidence: offer.regionEvidence,
        supplierId: supplier.supplierId,
      });

      await this.options.repository.upsertOffer({
        assessment,
        observedAt: this.now(),
        offer,
        runId,
      });
      metrics.offersSeen += 1;
      metrics.offersUpserted += 1;
      incrementDecision(metrics, assessment.decision);
    }
  }

  private async fail(
    runId: string,
    error: unknown,
    metrics: MutableCatalogSyncMetrics,
  ): Promise<CatalogSyncRun> {
    metrics.errors += 1;
    return this.options.repository.failRun({
      errorMessage:
        error instanceof Error ? error.message : "Unknown catalog sync failure",
      failedAt: this.now(),
      metrics: freezeMetrics(metrics),
      runId,
    });
  }
}

export class StaticCatalogOfferDiscovery implements CatalogOfferDiscoveryPort {
  private readonly offersByProduct = new Map<
    string,
    readonly NormalizedSupplierOffer[]
  >();

  public constructor(offers: readonly NormalizedSupplierOffer[]) {
    for (const offer of offers) {
      const key = mappingKey(
        offer.supplier.supplierId,
        offer.supplierProductId,
      );
      this.offersByProduct.set(key, [
        ...(this.offersByProduct.get(key) ?? []),
        offer,
      ]);
    }
  }

  public async listOffersForProduct(input: {
    readonly product: NormalizedSupplierProduct;
  }): Promise<readonly NormalizedSupplierOffer[]> {
    return [
      ...(this.offersByProduct.get(
        mappingKey(
          input.product.supplier.supplierId,
          input.product.supplierProductId,
        ),
      ) ?? []),
    ].sort((left, right) =>
      left.supplierOfferId.localeCompare(right.supplierOfferId),
    );
  }
}

export interface PriceUpdateJobPayload {
  readonly kind: "CATALOG_PRICE_REVALIDATION";
  readonly supplierId: SupplierId;
  readonly supplierOfferId: SupplierOfferId;
  readonly policyVersion: typeof germanyEligibilityPolicyVersion;
  readonly requestedAt: string;
}

export const createPriceRevalidationJobPayload = (input: {
  readonly supplierId: SupplierId;
  readonly supplierOfferId: SupplierOfferId;
  readonly requestedAt: Date;
}): PriceUpdateJobPayload => ({
  kind: "CATALOG_PRICE_REVALIDATION",
  policyVersion: germanyEligibilityPolicyVersion,
  requestedAt: input.requestedAt.toISOString(),
  supplierId: input.supplierId,
  supplierOfferId: input.supplierOfferId,
});

export const createOfferPriceSnapshot = (
  offer: NormalizedSupplierOffer,
): PriceSnapshot => ({
  availability: offer.offer.availability,
  capturedAt: offer.capturedAt,
  offerId: offer.offer.offerId,
  price: offer.offer.currentPrice,
});

type MutableCatalogSyncMetrics = {
  -readonly [TKey in keyof CatalogSyncMetrics]: CatalogSyncMetrics[TKey];
};

const zeroMetrics = (errors = 0): CatalogSyncMetrics => ({
  errors,
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

const mutableMetrics = (): MutableCatalogSyncMetrics => ({ ...zeroMetrics() });
const freezeMetrics = (
  metrics: MutableCatalogSyncMetrics,
): CatalogSyncMetrics => ({
  ...metrics,
});

const incrementDecision = (
  metrics: MutableCatalogSyncMetrics,
  decision: GermanyCompatibilityDecision,
): void => {
  if (decision === "ALLOWED") {
    metrics.offersAllowedForGermany += 1;
  } else if (decision === "BLOCKED") {
    metrics.offersBlockedForGermany += 1;
  } else if (decision === "DISABLED") {
    metrics.offersDisabledForGermany += 1;
  } else {
    metrics.offersReviewRequiredForGermany += 1;
  }
};

const mappingKey = (
  supplierId: SupplierId,
  supplierProductId: SupplierProductId,
): string => `${supplierId}:${supplierProductId}`;

const emptyPage = <TItem>(): Page<TItem> => ({ items: [] });
