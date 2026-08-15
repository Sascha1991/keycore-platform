import {
  catalogSearchPolicyVersion,
  computeSearchRank,
  createCatalogSearchDocumentSourceText,
  documentMatchesQuery,
  pageSearchResults,
  sortSearchResults,
  type CatalogOperationRecord,
  type CatalogOperationType,
  type CatalogProjectionSourcePort,
  type CatalogSearchDocument,
  type CatalogSearchPage,
  type CatalogSearchProjectionRepository,
  type CatalogSearchQuery,
} from "../../packages/platform/src/catalog/search-operations.js";
import type {
  EditionMarker,
  StorefrontPublicationState,
} from "../../packages/platform/src/contracts.js";
import {
  productId,
  type Platform,
  type ProductId,
  type ProductType,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, QueryParameters } from "./client.js";

interface SearchDocumentRow {
  readonly product_id: string;
  readonly canonical_title: string;
  readonly normalized_search_title: string;
  readonly product_type: ProductType;
  readonly platforms: string[];
  readonly edition: EditionMarker;
  readonly active: boolean;
  readonly germany_publishable: boolean;
  readonly storefront_publication_state: StorefrontPublicationState | null;
  readonly updated_at: Date;
  readonly search_document_version: typeof catalogSearchPolicyVersion;
}

interface SourceRow {
  readonly product_id: string;
  readonly canonical_title: string;
  readonly product_type: ProductType;
  readonly platform: string;
  readonly active: boolean;
  readonly lifecycle: string;
  readonly canonical_metadata: { readonly edition?: EditionMarker } | null;
  readonly updated_at: Date;
  readonly germany_publishable: boolean;
  readonly storefront_publication_state: StorefrontPublicationState | null;
}

interface OperationRow {
  readonly id: string;
  readonly operation_type: CatalogOperationType;
  readonly status: CatalogOperationRecord["status"];
  readonly checkpoint: string | null;
  readonly processed_count: number;
  readonly changed_count: number;
  readonly failed_count: number;
  readonly policy_version: typeof catalogSearchPolicyVersion;
  readonly last_error: string | null;
  readonly started_at: Date;
  readonly completed_at: Date | null;
}

export class PostgresCatalogSearchRepository
  implements CatalogSearchProjectionRepository, CatalogProjectionSourcePort
{
  public constructor(private readonly db: Queryable) {}

  public async upsertSearchDocument(
    document: CatalogSearchDocument,
  ): Promise<boolean> {
    const prior = await this.findByProductId(document.productId);
    await this.db.query(
      `
        INSERT INTO catalog_search_documents(
          product_id, canonical_title, normalized_search_title, product_type,
          platforms, edition, active, germany_publishable,
          storefront_publication_state, updated_at, search_document_version,
          search_text
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_tsvector('simple', $12))
        ON CONFLICT (product_id)
        DO UPDATE SET
          canonical_title = EXCLUDED.canonical_title,
          normalized_search_title = EXCLUDED.normalized_search_title,
          product_type = EXCLUDED.product_type,
          platforms = EXCLUDED.platforms,
          edition = EXCLUDED.edition,
          active = EXCLUDED.active,
          germany_publishable = EXCLUDED.germany_publishable,
          storefront_publication_state = EXCLUDED.storefront_publication_state,
          updated_at = EXCLUDED.updated_at,
          search_document_version = EXCLUDED.search_document_version,
          search_text = EXCLUDED.search_text
      `,
      [
        document.productId,
        document.canonicalTitle,
        document.normalizedSearchTitle,
        document.productType,
        [...document.platforms].sort(),
        document.edition,
        document.active,
        document.germanyPublishable,
        document.storefrontPublicationState ?? null,
        document.updatedAt,
        document.searchDocumentVersion,
        createCatalogSearchDocumentSourceText(document),
      ],
    );
    return JSON.stringify(prior) !== JSON.stringify(document);
  }

  public async findByProductId(
    canonicalProductId: ProductId,
  ): Promise<CatalogSearchDocument | null> {
    const result = await this.db.query<SearchDocumentRow>(
      `
        SELECT product_id::text, canonical_title, normalized_search_title,
          product_type, platforms, edition, active, germany_publishable,
          storefront_publication_state, updated_at, search_document_version
        FROM catalog_search_documents
        WHERE product_id = $1
      `,
      [canonicalProductId],
    );
    const row = result.rows[0];
    return row ? documentFromRow(row) : null;
  }

  public async searchDocuments(
    query: CatalogSearchQuery,
  ): Promise<CatalogSearchPage> {
    const { whereSql, values } = buildWhere(query);
    const result = await this.db.query<SearchDocumentRow>(
      `
        SELECT product_id::text, canonical_title, normalized_search_title,
          product_type, platforms, edition, active, germany_publishable,
          storefront_publication_state, updated_at, search_document_version
        FROM catalog_search_documents
        ${whereSql}
        ORDER BY normalized_search_title, product_id
        LIMIT $${values.length + 1}
      `,
      [...values, (query.limit ?? 50) + 201],
    );
    const ranked = result.rows
      .map(documentFromRow)
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
    return pageSearchResults(sortSearchResults(ranked), query);
  }

  public async listProductIdsForReindex(input: {
    readonly afterProductId?: ProductId;
    readonly limit: number;
  }): Promise<readonly ProductId[]> {
    const result = await this.db.query<{ readonly id: string }>(
      `
        SELECT id::text
        FROM products
        WHERE ($1::uuid IS NULL OR id > $1::uuid)
        ORDER BY id
        LIMIT $2
      `,
      [input.afterProductId ?? null, input.limit],
    );
    return result.rows.map((row) => productId(row.id));
  }

  public async beginOperation(input: {
    readonly operationType: CatalogOperationType;
    readonly startedAt: Date;
  }): Promise<CatalogOperationRecord> {
    const row = await this.queryOne<OperationRow>(
      `
        INSERT INTO catalog_operations(operation_type, status, policy_version, started_at)
        VALUES ($1, 'RUNNING', $2, $3)
        RETURNING id::text, operation_type, status, checkpoint,
          processed_count, changed_count, failed_count, policy_version,
          last_error, started_at, completed_at
      `,
      [input.operationType, catalogSearchPolicyVersion, input.startedAt],
    );
    return operationFromRow(row);
  }

  public async updateOperation(
    record: CatalogOperationRecord,
  ): Promise<CatalogOperationRecord> {
    const row = await this.queryOne<OperationRow>(
      `
        UPDATE catalog_operations
        SET status = $2,
          checkpoint = $3,
          processed_count = $4,
          changed_count = $5,
          failed_count = $6,
          last_error = $7,
          completed_at = $8,
          updated_at = now()
        WHERE id = $1
        RETURNING id::text, operation_type, status, checkpoint,
          processed_count, changed_count, failed_count, policy_version,
          last_error, started_at, completed_at
      `,
      [
        record.operationId,
        record.status,
        record.checkpoint ?? null,
        record.processedCount,
        record.changedCount,
        record.failedCount,
        record.lastError ?? null,
        record.completedAt ?? null,
      ],
    );
    return operationFromRow(row);
  }

  public async loadSearchDocument(
    canonicalProductId: ProductId,
  ): Promise<CatalogSearchDocument | null> {
    const result = await this.db.query<SourceRow>(
      `
        SELECT products.id::text AS product_id,
          products.title AS canonical_title,
          products.product_type,
          products.platform,
          products.active,
          products.lifecycle,
          products.canonical_metadata,
          products.updated_at,
          EXISTS (
            SELECT 1
            FROM offers
            JOIN supplier_offers ON supplier_offers.id = offers.supplier_offer_id
            JOIN region_decisions ON region_decisions.offer_id = offers.id
            WHERE offers.product_id = products.id
              AND supplier_offers.active = true
              AND offers.availability IN ('IN_STOCK', 'LIMITED')
              AND region_decisions.decision = 'ALLOWED'
          ) AS germany_publishable,
          (
            SELECT state
            FROM storefront_publications
            WHERE storefront_publications.product_id = products.id
            ORDER BY storefront, updated_at DESC
            LIMIT 1
          ) AS storefront_publication_state
        FROM products
        WHERE products.id = $1
      `,
      [canonicalProductId],
    );
    const row = result.rows[0];
    return row ? sourceFromRow(row) : null;
  }

  private async queryOne<TRow>(
    text: string,
    values: QueryParameters,
  ): Promise<TRow> {
    const result = await this.db.query<TRow & Record<string, unknown>>(
      text,
      values,
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Expected PostgreSQL query to return one row");
    }
    return row;
  }
}

const buildWhere = (
  query: CatalogSearchQuery,
): { readonly whereSql: string; readonly values: QueryParameters } => {
  const predicates: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    predicates.push(sql.replace("?", `$${values.length}`));
  };

  if (query.productId) {
    add("product_id = ?::uuid", query.productId);
  }
  if (query.active !== undefined) {
    add("active = ?", query.active);
  }
  if (query.germanyPublishable !== undefined) {
    add("germany_publishable = ?", query.germanyPublishable);
  }
  if (query.productTypes?.length) {
    add("product_type = ANY(?::text[])", [...query.productTypes]);
  }
  if (query.editions?.length) {
    add("edition = ANY(?::text[])", [...query.editions]);
  }
  if (query.platforms?.length) {
    add("platforms && ?::text[]", [...query.platforms]);
  }
  if (query.publicationStates?.length) {
    add("storefront_publication_state = ANY(?::text[])", [
      ...query.publicationStates,
    ]);
  }
  if (query.text) {
    add(
      "(normalized_search_title LIKE ? OR search_text @@ plainto_tsquery('simple', ?))",
      `${query.text}%`,
    );
    values.push(query.text);
    predicates[predicates.length - 1] =
      predicates[predicates.length - 1]?.replace("?", `$${values.length}`) ??
      "";
  }

  return {
    values,
    whereSql: predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "",
  };
};

const documentFromRow = (row: SearchDocumentRow): CatalogSearchDocument => ({
  active: row.active,
  canonicalTitle: row.canonical_title,
  edition: row.edition,
  germanyPublishable: row.germany_publishable,
  normalizedSearchTitle: row.normalized_search_title,
  platforms: row.platforms as readonly Platform[],
  productId: productId(row.product_id),
  productType: row.product_type,
  searchDocumentVersion: row.search_document_version,
  updatedAt: row.updated_at,
  ...(row.storefront_publication_state
    ? { storefrontPublicationState: row.storefront_publication_state }
    : {}),
});

const sourceFromRow = (row: SourceRow): CatalogSearchDocument => ({
  active: row.active,
  canonicalTitle: row.canonical_title,
  edition: row.canonical_metadata?.edition ?? "UNKNOWN",
  germanyPublishable: row.germany_publishable,
  normalizedSearchTitle: row.canonical_title
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[._:|()[\]{}]+/gu, " ")
    .replace(/\s*[-/]\s*/gu, " ")
    .replace(/\s+/gu, " "),
  platforms: row.platform
    .split(",")
    .filter((platform) => platform.length > 0) as readonly Platform[],
  productId: productId(row.product_id),
  productType: row.product_type,
  searchDocumentVersion: catalogSearchPolicyVersion,
  updatedAt: row.updated_at,
  ...(row.storefront_publication_state
    ? { storefrontPublicationState: row.storefront_publication_state }
    : {}),
});

const operationFromRow = (row: OperationRow): CatalogOperationRecord => ({
  changedCount: row.changed_count,
  failedCount: row.failed_count,
  operationId: row.id,
  operationType: row.operation_type,
  policyVersion: row.policy_version,
  processedCount: row.processed_count,
  startedAt: row.started_at,
  status: row.status,
  ...(row.checkpoint ? { checkpoint: row.checkpoint } : {}),
  ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  ...(row.last_error ? { lastError: row.last_error } : {}),
});
