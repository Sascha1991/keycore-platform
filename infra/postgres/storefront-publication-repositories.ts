import {
  productId,
  storefrontProductId,
  type ProductId,
  type StorefrontChannel,
  type StorefrontProductId,
  type StorefrontPublicationRecord,
  type StorefrontPublicationRepository,
  type StorefrontPublicationSnapshot,
} from "../../packages/platform/src/contracts.js";
import { StorefrontMappingConflictError } from "../../packages/platform/src/contracts.js";
import type { Queryable } from "./client.js";

interface PublicationRow {
  readonly product_id: string;
  readonly storefront: string;
  readonly remote_product_id: string | null;
  readonly state: StorefrontPublicationRecord["state"];
  readonly publication_version: StorefrontPublicationRecord["publicationVersion"];
  readonly fingerprint: string | null;
  readonly slug: string | null;
  readonly last_attempt_at: Date | null;
  readonly last_success_at: Date | null;
  readonly last_error_classification: string | null;
  readonly reconciliation_required: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresStorefrontPublicationRepository implements StorefrontPublicationRepository {
  public constructor(
    private readonly db: Queryable,
    private readonly snapshotLoader: (
      productId: ProductId,
    ) => Promise<StorefrontPublicationSnapshot>,
  ) {}

  public async loadSnapshot(
    requestedProductId: ProductId,
  ): Promise<StorefrontPublicationSnapshot> {
    return this.snapshotLoader(requestedProductId);
  }

  public async findPublication(input: {
    readonly productId: ProductId;
    readonly storefront: StorefrontChannel;
  }): Promise<StorefrontPublicationRecord | null> {
    const result = await this.db.query<PublicationRow>(
      `
        SELECT product_id::text, storefront, remote_product_id, state,
          publication_version, fingerprint, slug, last_attempt_at,
          last_success_at, last_error_classification, reconciliation_required,
          created_at, updated_at
        FROM storefront_publications
        WHERE product_id = $1 AND storefront = $2
      `,
      [input.productId, input.storefront],
    );
    return result.rows[0] ? publicationFromRow(result.rows[0]) : null;
  }

  public async findPublicationByRemoteId(input: {
    readonly remoteProductId: StorefrontProductId;
    readonly storefront: StorefrontChannel;
  }): Promise<StorefrontPublicationRecord | null> {
    const result = await this.db.query<PublicationRow>(
      `
        SELECT product_id::text, storefront, remote_product_id, state,
          publication_version, fingerprint, slug, last_attempt_at,
          last_success_at, last_error_classification, reconciliation_required,
          created_at, updated_at
        FROM storefront_publications
        WHERE remote_product_id = $1 AND storefront = $2
      `,
      [input.remoteProductId, input.storefront],
    );
    return result.rows[0] ? publicationFromRow(result.rows[0]) : null;
  }

  public async isSlugReserved(input: {
    readonly slug: string;
    readonly productId: ProductId;
    readonly storefront: StorefrontChannel;
  }): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM storefront_publications
          WHERE slug = $1 AND storefront = $2 AND product_id <> $3
        )
      `,
      [input.slug, input.storefront, input.productId],
    );
    return result.rows[0]?.exists ?? false;
  }

  public async savePublication(
    record: StorefrontPublicationRecord,
  ): Promise<StorefrontPublicationRecord> {
    const existing = await this.findPublication(record);
    if (
      existing?.remoteProductId &&
      record.remoteProductId &&
      existing.remoteProductId !== record.remoteProductId
    ) {
      throw new StorefrontMappingConflictError(
        "MAPPING_CONFLICT_PRODUCT_STOREFRONT",
      );
    }
    if (record.remoteProductId) {
      const remoteConflict = await this.findPublicationByRemoteId({
        remoteProductId: record.remoteProductId,
        storefront: record.storefront,
      });
      if (remoteConflict && remoteConflict.productId !== record.productId) {
        throw new StorefrontMappingConflictError(
          "MAPPING_CONFLICT_REMOTE_STOREFRONT",
        );
      }
    }

    const result = await this.db.query<PublicationRow>(
      `
        INSERT INTO storefront_publications(
          product_id, storefront, remote_product_id, state,
          publication_version, fingerprint, slug, last_attempt_at,
          last_success_at, last_error_classification,
          reconciliation_required, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (product_id, storefront)
        DO UPDATE SET
          remote_product_id = EXCLUDED.remote_product_id,
          state = EXCLUDED.state,
          publication_version = EXCLUDED.publication_version,
          fingerprint = EXCLUDED.fingerprint,
          slug = EXCLUDED.slug,
          last_attempt_at = EXCLUDED.last_attempt_at,
          last_success_at = EXCLUDED.last_success_at,
          last_error_classification = EXCLUDED.last_error_classification,
          reconciliation_required = EXCLUDED.reconciliation_required,
          updated_at = EXCLUDED.updated_at
        RETURNING product_id::text, storefront, remote_product_id, state,
          publication_version, fingerprint, slug, last_attempt_at,
          last_success_at, last_error_classification,
          reconciliation_required, created_at, updated_at
      `,
      [
        record.productId,
        record.storefront,
        record.remoteProductId ?? null,
        record.state,
        record.publicationVersion,
        record.fingerprint ?? null,
        record.slug ?? null,
        record.lastAttemptAt ?? null,
        record.lastSuccessAt ?? null,
        record.lastErrorClassification ?? null,
        record.reconciliationRequired,
        record.createdAt,
        record.updatedAt,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Expected storefront publication upsert row");
    }
    return publicationFromRow(row);
  }
}

const publicationFromRow = (
  row: PublicationRow,
): StorefrontPublicationRecord => ({
  createdAt: row.created_at,
  productId: productId(row.product_id),
  publicationVersion: row.publication_version,
  reconciliationRequired: row.reconciliation_required,
  state: row.state,
  storefront: row.storefront as StorefrontChannel,
  updatedAt: row.updated_at,
  ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}),
  ...(row.last_attempt_at ? { lastAttemptAt: row.last_attempt_at } : {}),
  ...(row.last_error_classification
    ? { lastErrorClassification: row.last_error_classification }
    : {}),
  ...(row.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
  ...(row.remote_product_id
    ? { remoteProductId: storefrontProductId(row.remote_product_id) }
    : {}),
  ...(row.slug ? { slug: row.slug } : {}),
});
