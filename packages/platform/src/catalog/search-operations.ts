import type { Platform, ProductType } from "../domain/catalog.js";
import type { AuditEvent } from "../domain/audit.js";
import type { CorrelationId, ProductId } from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import type { SafePayload } from "../queue/job.js";
import {
  normalizeProductTitle,
  type EditionMarker,
} from "./canonical-product-grouping.js";
import type { StorefrontPublicationState } from "../storefront/publication.js";

export const catalogSearchPolicyVersion = "catalog-search-v1" as const;

export const catalogChangeCategories = [
  "TITLE",
  "PLATFORM",
  "EDITION",
  "ACTIVE",
  "GERMANY_ELIGIBILITY",
  "AVAILABILITY",
  "GROUPING",
  "STOREFRONT_PUBLICATION",
  "WEBHOOK_REFRESH_SIGNAL",
] as const;

export type CatalogChangeCategory = (typeof catalogChangeCategories)[number];

export interface CatalogSearchDocument {
  readonly productId: ProductId;
  readonly canonicalTitle: string;
  readonly normalizedSearchTitle: string;
  readonly productType: ProductType;
  readonly platforms: readonly Platform[];
  readonly edition: EditionMarker;
  readonly active: boolean;
  readonly germanyPublishable: boolean;
  readonly storefrontPublicationState?: StorefrontPublicationState;
  readonly updatedAt: Date;
  readonly searchDocumentVersion: typeof catalogSearchPolicyVersion;
}

export interface CatalogSearchQuery {
  readonly text?: string;
  readonly productId?: ProductId;
  readonly platforms?: readonly Platform[];
  readonly productTypes?: readonly ProductType[];
  readonly editions?: readonly EditionMarker[];
  readonly active?: boolean;
  readonly germanyPublishable?: boolean;
  readonly publicationStates?: readonly StorefrontPublicationState[];
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CatalogSearchResult {
  readonly document: CatalogSearchDocument;
  readonly rank: CatalogSearchRank;
}

export interface CatalogSearchPage {
  readonly items: readonly CatalogSearchResult[];
  readonly nextCursor?: string;
}

export interface CatalogSearchRank {
  readonly class: 0 | 1 | 2 | 3;
  readonly normalizedTitle: string;
  readonly productId: ProductId;
}

export class CatalogSearchCursorError extends Error {
  public constructor(message = "Invalid catalog search cursor") {
    super(message);
    this.name = "CatalogSearchCursorError";
  }
}

export interface CatalogSearchPort {
  search(query: CatalogSearchQuery): Promise<CatalogSearchPage>;
  findByProductId(productId: ProductId): Promise<CatalogSearchDocument | null>;
}

export interface CatalogSearchProjectionRepository {
  upsertSearchDocument(document: CatalogSearchDocument): Promise<boolean>;
  findByProductId(productId: ProductId): Promise<CatalogSearchDocument | null>;
  searchDocuments(query: CatalogSearchQuery): Promise<CatalogSearchPage>;
  listProductIdsForReindex(input: {
    readonly afterProductId?: ProductId;
    readonly limit: number;
  }): Promise<readonly ProductId[]>;
  beginOperation(input: {
    readonly operationType: CatalogOperationType;
    readonly startedAt: Date;
  }): Promise<CatalogOperationRecord>;
  updateOperation(
    record: CatalogOperationRecord,
  ): Promise<CatalogOperationRecord>;
}

export interface CatalogProjectionSourcePort {
  loadSearchDocument(
    productId: ProductId,
  ): Promise<CatalogSearchDocument | null>;
}

export type CatalogOperationType =
  | "SEARCH_REINDEX"
  | "PRODUCT_REFRESH"
  | "BATCH_REFRESH"
  | "GERMANY_ELIGIBILITY_RECALCULATION"
  | "GROUPING_REEVALUATION"
  | "STOREFRONT_REEVALUATION_REQUEST";

export type CatalogOperationStatus = "RUNNING" | "COMPLETED" | "FAILED";

export interface CatalogOperationRecord {
  readonly operationId: string;
  readonly operationType: CatalogOperationType;
  readonly status: CatalogOperationStatus;
  readonly checkpoint?: string;
  readonly processedCount: number;
  readonly changedCount: number;
  readonly failedCount: number;
  readonly startedAt: Date;
  readonly completedAt?: Date;
  readonly policyVersion: typeof catalogSearchPolicyVersion;
  readonly lastError?: string;
}

export interface CatalogProductChangedEvent {
  readonly eventType: "CATALOG_PRODUCT_CHANGED";
  readonly productId: ProductId;
  readonly changeCategories: readonly CatalogChangeCategory[];
  readonly correlationId: CorrelationId;
  readonly catalogVersion: typeof catalogSearchPolicyVersion;
  readonly observedAt: string;
}

export interface CatalogProductUpdateSignal {
  readonly supplier: "KINGUIN" | "MOCK" | "UNKNOWN";
  readonly supplierProductReference: string;
  readonly receivedAt: Date;
  readonly verified: boolean;
  readonly sourceTimestamp?: Date;
  readonly correlationId: CorrelationId;
}

export interface CatalogStorefrontReevaluationPort {
  requestStorefrontReevaluation(input: {
    readonly productId: ProductId;
    readonly correlationId: CorrelationId;
  }): Promise<void>;
}

export interface CatalogSearchServiceOptions {
  readonly repository: CatalogSearchProjectionRepository;
}

export class CatalogSearchService implements CatalogSearchPort {
  public constructor(private readonly options: CatalogSearchServiceOptions) {}

  public async search(query: CatalogSearchQuery): Promise<CatalogSearchPage> {
    return this.options.repository.searchDocuments(sanitizeSearchQuery(query));
  }

  public async findByProductId(
    productId: ProductId,
  ): Promise<CatalogSearchDocument | null> {
    return this.options.repository.findByProductId(productId);
  }
}

export interface CatalogOperationsServiceOptions {
  readonly projectionRepository: CatalogSearchProjectionRepository;
  readonly projectionSource: CatalogProjectionSourcePort;
  readonly storefrontReevaluation?: CatalogStorefrontReevaluationPort;
  readonly audit?: AuditEventPort;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
  readonly reindexBatchSize?: number;
}

export class CatalogOperationsService {
  private readonly now: () => Date;
  private readonly reindexBatchSize: number;
  private readonly environment: AuditEvent["environment"];

  public constructor(
    private readonly options: CatalogOperationsServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.reindexBatchSize = options.reindexBatchSize ?? 200;
    this.environment = options.environment ?? "LOCAL";
  }

  public async refreshProduct(input: {
    readonly productId: ProductId;
    readonly correlationId: CorrelationId;
    readonly changeCategories?: readonly CatalogChangeCategory[];
    readonly requestStorefrontReevaluation?: boolean;
  }): Promise<{
    readonly changed: boolean;
    readonly document: CatalogSearchDocument | null;
  }> {
    const document = await this.options.projectionSource.loadSearchDocument(
      input.productId,
    );
    const changed = document
      ? await this.options.projectionRepository.upsertSearchDocument(document)
      : false;

    await this.audit({
      correlationId: input.correlationId,
      eventType: "CATALOG_PRODUCT_REFRESHED",
      metadata: {
        changed,
        productId: input.productId,
        searchDocumentVersion: catalogSearchPolicyVersion,
      },
      productId: input.productId,
    });

    if (
      input.requestStorefrontReevaluation ??
      shouldReevaluateStorefront(input.changeCategories ?? [])
    ) {
      await this.options.storefrontReevaluation?.requestStorefrontReevaluation({
        correlationId: input.correlationId,
        productId: input.productId,
      });
    }

    return { changed, document };
  }

  public async refreshBatch(input: {
    readonly productIds: readonly ProductId[];
    readonly correlationId: CorrelationId;
    readonly changeCategories?: readonly CatalogChangeCategory[];
  }): Promise<CatalogOperationRecord> {
    const startedAt = this.now();
    let operation = await this.options.projectionRepository.beginOperation({
      operationType: "BATCH_REFRESH",
      startedAt,
    });
    for (const productId of input.productIds.slice(0, this.reindexBatchSize)) {
      try {
        const result = await this.refreshProduct({
          correlationId: input.correlationId,
          productId,
          ...(input.changeCategories
            ? { changeCategories: input.changeCategories }
            : {}),
        });
        operation = {
          ...operation,
          changedCount: operation.changedCount + (result.changed ? 1 : 0),
          checkpoint: productId,
          processedCount: operation.processedCount + 1,
        };
      } catch (error) {
        operation = {
          ...operation,
          failedCount: operation.failedCount + 1,
          lastError:
            error instanceof Error ? error.message : "Unknown item failure",
        };
      }
      operation =
        await this.options.projectionRepository.updateOperation(operation);
    }
    return this.completeOperation(operation);
  }

  public async reindex(input: {
    readonly correlationId: CorrelationId;
    readonly afterProductId?: ProductId;
  }): Promise<CatalogOperationRecord> {
    const startedAt = this.now();
    let operation = await this.options.projectionRepository.beginOperation({
      operationType: "SEARCH_REINDEX",
      startedAt,
    });
    let afterProductId = input.afterProductId;
    await this.audit({
      correlationId: input.correlationId,
      eventType: "CATALOG_SEARCH_REINDEX_STARTED",
      metadata: { policyVersion: catalogSearchPolicyVersion },
    });

    try {
      let batch: readonly ProductId[];
      do {
        batch =
          await this.options.projectionRepository.listProductIdsForReindex({
            limit: this.reindexBatchSize,
            ...(afterProductId ? { afterProductId } : {}),
          });
        for (const productId of batch) {
          const result = await this.refreshProduct({
            correlationId: input.correlationId,
            productId,
            requestStorefrontReevaluation: false,
          });
          operation = {
            ...operation,
            changedCount: operation.changedCount + (result.changed ? 1 : 0),
            checkpoint: productId,
            processedCount: operation.processedCount + 1,
          };
          afterProductId = productId;
        }
        operation =
          await this.options.projectionRepository.updateOperation(operation);
      } while (batch.length === this.reindexBatchSize);

      const completed = await this.completeOperation(operation);
      await this.audit({
        correlationId: input.correlationId,
        eventType: "CATALOG_SEARCH_REINDEX_COMPLETED",
        metadata: {
          changedCount: completed.changedCount,
          policyVersion: catalogSearchPolicyVersion,
          processedCount: completed.processedCount,
        },
      });
      return completed;
    } catch (error) {
      const failed = await this.options.projectionRepository.updateOperation({
        ...operation,
        lastError:
          error instanceof Error ? error.message : "Unknown reindex failure",
        status: "FAILED",
      });
      await this.audit({
        correlationId: input.correlationId,
        eventType: "CATALOG_SEARCH_REINDEX_FAILED",
        metadata: {
          failedCount: failed.failedCount,
          policyVersion: catalogSearchPolicyVersion,
          processedCount: failed.processedCount,
        },
      });
      return failed;
    }
  }

  public async handleCatalogProductChanged(
    event: CatalogProductChangedEvent,
  ): Promise<{ readonly changed: boolean }> {
    const result = await this.refreshProduct({
      changeCategories: event.changeCategories,
      correlationId: event.correlationId,
      productId: event.productId,
    });
    return { changed: result.changed };
  }

  public acceptWebhookProductUpdateSignal(
    signal: CatalogProductUpdateSignal,
  ): CatalogProductChangedEvent | null {
    if (!signal.verified) {
      return null;
    }
    return createCatalogProductChangedEvent({
      changeCategories: ["WEBHOOK_REFRESH_SIGNAL"],
      correlationId: signal.correlationId,
      observedAt: signal.receivedAt,
      productId: signal.supplierProductReference as ProductId,
    });
  }

  private async completeOperation(
    operation: CatalogOperationRecord,
  ): Promise<CatalogOperationRecord> {
    return this.options.projectionRepository.updateOperation({
      ...operation,
      completedAt: this.now(),
      status: operation.failedCount > 0 ? "FAILED" : "COMPLETED",
    });
  }

  private async audit(input: {
    readonly eventType: AuditEvent["eventType"];
    readonly correlationId: CorrelationId;
    readonly metadata: Readonly<Record<string, string | number | boolean>>;
    readonly productId?: ProductId;
  }): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "catalog-operations-service", type: "SERVICE" },
      correlationId: input.correlationId,
      entity: { id: input.productId ?? "catalog-search", type: "PRODUCT" },
      environment: this.environment,
      eventType: input.eventType,
      metadata: input.metadata,
      outcome:
        input.eventType === "CATALOG_SEARCH_REINDEX_FAILED"
          ? "FAILED"
          : "SUCCEEDED",
      reasonCode: catalogSearchPolicyVersion,
      timestampUtc: this.now(),
      uuid: `audit-${input.eventType}-${input.correlationId}-${this.now().getTime()}`,
    });
  }
}

export const createCatalogProductChangedEvent = (input: {
  readonly productId: ProductId;
  readonly changeCategories: readonly CatalogChangeCategory[];
  readonly correlationId: CorrelationId;
  readonly observedAt: Date;
}): CatalogProductChangedEvent => ({
  catalogVersion: catalogSearchPolicyVersion,
  changeCategories: [...new Set(input.changeCategories)].sort(),
  correlationId: input.correlationId,
  eventType: "CATALOG_PRODUCT_CHANGED",
  observedAt: input.observedAt.toISOString(),
  productId: input.productId,
});

export const catalogSearchRefreshJobPayload = (input: {
  readonly productId: ProductId;
  readonly correlationId: CorrelationId;
  readonly changeCategories: readonly CatalogChangeCategory[];
}): SafePayload => ({
  catalogVersion: catalogSearchPolicyVersion,
  changeCategories: [...input.changeCategories].sort(),
  correlationId: input.correlationId,
  productId: input.productId,
});

export const computeSearchRank = (
  document: CatalogSearchDocument,
  queryText?: string,
): CatalogSearchRank | null => {
  const normalizedQuery = normalizeSearchText(queryText ?? "");
  if (normalizedQuery.length === 0) {
    return rank(document, 3);
  }
  if (document.normalizedSearchTitle === normalizedQuery) {
    return rank(document, 0);
  }
  if (document.normalizedSearchTitle.startsWith(normalizedQuery)) {
    return rank(document, 1);
  }
  const searchable = [
    document.normalizedSearchTitle,
    document.productType,
    document.edition,
    ...document.platforms,
  ]
    .join(" ")
    .toLowerCase();
  const tokens = normalizedQuery.split(" ");
  if (tokens.every((token) => searchable.includes(token))) {
    return rank(document, 2);
  }
  return null;
};

export const documentMatchesQuery = (
  document: CatalogSearchDocument,
  query: CatalogSearchQuery,
): boolean => {
  if (query.productId && document.productId !== query.productId) {
    return false;
  }
  if (query.active !== undefined && document.active !== query.active) {
    return false;
  }
  if (
    query.germanyPublishable !== undefined &&
    document.germanyPublishable !== query.germanyPublishable
  ) {
    return false;
  }
  if (
    query.productTypes?.length &&
    !query.productTypes.includes(document.productType)
  ) {
    return false;
  }
  if (query.editions?.length && !query.editions.includes(document.edition)) {
    return false;
  }
  if (
    query.platforms?.length &&
    !query.platforms.some((platform) => document.platforms.includes(platform))
  ) {
    return false;
  }
  if (
    query.publicationStates?.length &&
    (!document.storefrontPublicationState ||
      !query.publicationStates.includes(document.storefrontPublicationState))
  ) {
    return false;
  }
  return true;
};

export const sortSearchResults = (
  results: readonly CatalogSearchResult[],
): readonly CatalogSearchResult[] => [...results].sort(compareSearchResults);

export const pageSearchResults = (
  results: readonly CatalogSearchResult[],
  query: CatalogSearchQuery,
): CatalogSearchPage => {
  const sanitized = sanitizeSearchQuery(query);
  const cursor = sanitized.cursor ? decodeCursor(sanitized.cursor) : null;
  const afterCursor = cursor
    ? results.filter((result) => compareRank(result.rank, cursor) > 0)
    : results;
  const items = afterCursor.slice(0, sanitized.limit);
  const last = items.at(-1);
  return {
    items,
    ...(afterCursor.length > items.length && last
      ? { nextCursor: encodeCursor(last.rank) }
      : {}),
  };
};

export const sanitizeSearchQuery = (
  query: CatalogSearchQuery,
): CatalogSearchQuery & { readonly limit: number } => {
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Catalog search limit must be a positive integer");
  }
  return {
    ...query,
    limit: Math.min(limit, 200),
    ...(query.text ? { text: normalizeSearchText(query.text) } : {}),
  };
};

export const normalizeSearchText = (value: string): string =>
  normalizeProductTitle(value).replace(/[^\p{Letter}\p{Number}\s]+/gu, " ");

export const shouldReevaluateStorefront = (
  categories: readonly CatalogChangeCategory[],
): boolean =>
  categories.some((category) =>
    [
      "TITLE",
      "ACTIVE",
      "GERMANY_ELIGIBILITY",
      "AVAILABILITY",
      "GROUPING",
      "STOREFRONT_PUBLICATION",
    ].includes(category),
  );

const rank = (
  document: CatalogSearchDocument,
  rankClass: CatalogSearchRank["class"],
): CatalogSearchRank => ({
  class: rankClass,
  normalizedTitle: document.normalizedSearchTitle,
  productId: document.productId,
});

const compareSearchResults = (
  left: CatalogSearchResult,
  right: CatalogSearchResult,
): number => compareRank(left.rank, right.rank);

const compareRank = (
  left: CatalogSearchRank,
  right: CatalogSearchRank,
): number =>
  left.class - right.class ||
  left.normalizedTitle.localeCompare(right.normalizedTitle) ||
  left.productId.localeCompare(right.productId);

const encodeCursor = (rankValue: CatalogSearchRank): string =>
  Buffer.from(JSON.stringify(rankValue), "utf8").toString("base64url");

const decodeCursor = (cursor: string): CatalogSearchRank => {
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CatalogSearchRank>;
    if (
      (decoded.class === 0 ||
        decoded.class === 1 ||
        decoded.class === 2 ||
        decoded.class === 3) &&
      typeof decoded.normalizedTitle === "string" &&
      typeof decoded.productId === "string"
    ) {
      return decoded as CatalogSearchRank;
    }
  } catch {
    throw new CatalogSearchCursorError();
  }
  throw new CatalogSearchCursorError();
};
