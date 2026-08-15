import {
  catalogSearchPolicyVersion,
  computeSearchRank,
  documentMatchesQuery,
  pageSearchResults,
  sortSearchResults,
  type CatalogOperationRecord,
  type CatalogOperationType,
  type CatalogProjectionSourcePort,
  type CatalogSearchDocument,
  type CatalogSearchProjectionRepository,
  type CatalogSearchQuery,
  type CatalogSearchPage,
  type CatalogStorefrontReevaluationPort,
} from "../../packages/platform/src/catalog/search-operations.js";
import {
  productId,
  type CorrelationId,
  type ProductId,
} from "../../packages/platform/src/contracts.js";

export class InMemoryCatalogSearchRepository
  implements CatalogSearchProjectionRepository, CatalogProjectionSourcePort
{
  private readonly documents = new Map<string, CatalogSearchDocument>();
  private readonly source = new Map<string, CatalogSearchDocument>();
  private readonly operations = new Map<string, CatalogOperationRecord>();
  private nextOperationSequence = 1;

  public constructor(seed?: readonly CatalogSearchDocument[]) {
    for (const document of seed ?? []) {
      this.source.set(document.productId, document);
    }
  }

  public async upsertSearchDocument(
    document: CatalogSearchDocument,
  ): Promise<boolean> {
    const prior = this.documents.get(document.productId);
    this.documents.set(document.productId, canonicalDocument(document));
    return (
      JSON.stringify(prior) !== JSON.stringify(canonicalDocument(document))
    );
  }

  public async findByProductId(
    productId: ProductId,
  ): Promise<CatalogSearchDocument | null> {
    return this.documents.get(productId) ?? null;
  }

  public async searchDocuments(
    query: CatalogSearchQuery,
  ): Promise<CatalogSearchPage> {
    const results = [...this.documents.values()]
      .filter((document) => documentMatchesQuery(document, query))
      .map((document) => ({
        document,
        rank: computeSearchRank(document, query.text),
      }))
      .filter(
        (
          result,
        ): result is {
          readonly document: CatalogSearchDocument;
          readonly rank: NonNullable<ReturnType<typeof computeSearchRank>>;
        } => result.rank !== null,
      );
    return pageSearchResults(sortSearchResults(results), query);
  }

  public async listProductIdsForReindex(input: {
    readonly afterProductId?: ProductId;
    readonly limit: number;
  }): Promise<readonly ProductId[]> {
    return [...this.source.keys()]
      .sort()
      .filter(
        (candidateProductId) =>
          !input.afterProductId || candidateProductId > input.afterProductId,
      )
      .slice(0, input.limit)
      .map((candidateProductId) => productId(candidateProductId));
  }

  public async beginOperation(input: {
    readonly operationType: CatalogOperationType;
    readonly startedAt: Date;
  }): Promise<CatalogOperationRecord> {
    const record: CatalogOperationRecord = {
      changedCount: 0,
      failedCount: 0,
      operationId: `catalog-operation-${this.nextOperationSequence}`,
      operationType: input.operationType,
      policyVersion: catalogSearchPolicyVersion,
      processedCount: 0,
      startedAt: input.startedAt,
      status: "RUNNING",
    };
    this.nextOperationSequence += 1;
    this.operations.set(record.operationId, record);
    return record;
  }

  public async updateOperation(
    record: CatalogOperationRecord,
  ): Promise<CatalogOperationRecord> {
    this.operations.set(record.operationId, record);
    return record;
  }

  public async loadSearchDocument(
    productId: ProductId,
  ): Promise<CatalogSearchDocument | null> {
    return this.source.get(productId) ?? null;
  }

  public putSourceDocument(document: CatalogSearchDocument): void {
    this.source.set(document.productId, canonicalDocument(document));
  }

  public listDocuments(): readonly CatalogSearchDocument[] {
    return [...this.documents.values()].sort((left, right) =>
      left.productId.localeCompare(right.productId),
    );
  }

  public listOperations(): readonly CatalogOperationRecord[] {
    return [...this.operations.values()];
  }
}

export class InMemoryCatalogStorefrontReevaluationQueue implements CatalogStorefrontReevaluationPort {
  public readonly requests: {
    readonly productId: ProductId;
    readonly correlationId: CorrelationId;
  }[] = [];

  public async requestStorefrontReevaluation(input: {
    readonly productId: ProductId;
    readonly correlationId: CorrelationId;
  }): Promise<void> {
    this.requests.push(input);
  }
}

const canonicalDocument = (
  document: CatalogSearchDocument,
): CatalogSearchDocument => ({
  ...document,
  platforms: [...document.platforms].sort(),
});
