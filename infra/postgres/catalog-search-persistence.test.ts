import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CatalogOperationsService,
  CatalogSearchService,
  catalogSearchPolicyVersion,
} from "../../packages/platform/src/catalog/search-operations.js";
import {
  correlationId,
  productId,
  storefrontChannel,
} from "../../packages/platform/src/contracts.js";
import { PostgresCatalogSearchRepository } from "./catalog-search-repositories.js";
import { PostgresTestDatabase } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;

describe.skipIf(!connectionString)("PostgresCatalogSearchRepository", () => {
  it("persists versioned projections and searches with filters/cursors", async () => {
    const database = await initDatabase();
    try {
      const repository = new PostgresCatalogSearchRepository(database);
      const firstProductId = await insertCanonicalProduct(database, {
        title: "Postgres Search Deluxe",
        platform: "WINDOWS",
        edition: "DELUXE",
        active: true,
      });
      const secondProductId = await insertCanonicalProduct(database, {
        title: "Postgres Search Standard",
        platform: "LINUX",
        edition: "STANDARD",
        active: true,
      });
      await insertAllowedOffer(database, firstProductId);
      await insertPublication(database, firstProductId, "PUBLISHED");

      const service = new CatalogOperationsService({
        projectionRepository: repository,
        projectionSource: repository,
        now: () => new Date("2026-08-15T00:00:00.000Z"),
      });
      await service.refreshBatch({
        correlationId: correlationId("postgres-search"),
        productIds: [firstProductId, secondProductId],
      });

      const search = new CatalogSearchService({ repository });
      const filteredPage = await search.search({
        editions: ["DELUXE"],
        germanyPublishable: true,
        limit: 1,
        platforms: ["WINDOWS"],
        publicationStates: ["PUBLISHED"],
        text: "postgres search",
      });
      const firstPage = await search.search({
        limit: 1,
        text: "postgres search",
      });
      const secondPage = await search.search({
        ...(firstPage.nextCursor ? { cursor: firstPage.nextCursor } : {}),
        limit: 1,
        text: "postgres search",
      });

      expect(filteredPage.items).toHaveLength(1);
      expect(filteredPage.items[0]?.document).toMatchObject({
        productId: firstProductId,
        searchDocumentVersion: catalogSearchPolicyVersion,
      });
      expect(firstPage.nextCursor).toBeDefined();
      expect(
        secondPage.items.map((item) => item.document.productId),
      ).not.toEqual(firstPage.items.map((item) => item.document.productId));
      await expect(
        searchVectorText(database, firstProductId),
      ).resolves.toContain("postgres");
      await expect(searchGinIndexCount(database)).resolves.toBe(1);
    } finally {
      await database.cleanup();
    }
  });

  it("refreshes search_text when canonical title or platform changes", async () => {
    const database = await initDatabase();
    try {
      const repository = new PostgresCatalogSearchRepository(database);
      const canonicalProductId = await insertCanonicalProduct(database, {
        title: "Original Search Title",
        platform: "WINDOWS",
        edition: "STANDARD",
        active: true,
      });
      const service = new CatalogOperationsService({
        projectionRepository: repository,
        projectionSource: repository,
      });

      await service.refreshProduct({
        correlationId: correlationId("postgres-search-vector-initial"),
        productId: canonicalProductId,
      });
      await database.query(
        `
          UPDATE products
          SET title = 'Updated Vector Title',
            platform = 'LINUX,WINDOWS',
            updated_at = now()
          WHERE id = $1
        `,
        [canonicalProductId],
      );
      await service.refreshProduct({
        correlationId: correlationId("postgres-search-vector-updated"),
        productId: canonicalProductId,
      });

      const vector = await searchVectorText(database, canonicalProductId);
      const search = new CatalogSearchService({ repository });
      const page = await search.search({
        platforms: ["LINUX"],
        text: "updated vector",
      });

      expect(vector).toContain("updated");
      expect(vector).toContain("linux");
      expect(page.items.map((item) => item.document.productId)).toEqual([
        canonicalProductId,
      ]);
    } finally {
      await database.cleanup();
    }
  });

  it("runs restartable reindex and records durable operation checkpoints", async () => {
    const database = await initDatabase();
    try {
      const repository = new PostgresCatalogSearchRepository(database);
      const ids = [
        await insertCanonicalProduct(database, {
          id: productId("00000000-0000-4000-8000-000000000101"),
          title: "Reindex A",
          platform: "WINDOWS",
          edition: "STANDARD",
          active: true,
        }),
        await insertCanonicalProduct(database, {
          id: productId("00000000-0000-4000-8000-000000000102"),
          title: "Reindex B",
          platform: "WINDOWS",
          edition: "STANDARD",
          active: true,
        }),
      ].sort();
      const service = new CatalogOperationsService({
        projectionRepository: repository,
        projectionSource: repository,
        reindexBatchSize: 1,
      });

      const result = await service.reindex({
        correlationId: correlationId("postgres-reindex"),
      });
      const restarted = await service.reindex({
        correlationId: correlationId("postgres-reindex-restart"),
        ...(ids[0] ? { afterProductId: ids[0] } : {}),
      });

      expect(result.status).toBe("COMPLETED");
      expect(result.processedCount).toBe(2);
      expect(result.checkpoint).toBe(ids[1]);
      expect(restarted.processedCount).toBe(1);
      const secondId = ids[1];
      if (!secondId) {
        throw new Error("Expected second product id");
      }
      await expect(repository.findByProductId(secondId)).resolves.toMatchObject(
        {
          canonicalTitle: "Reindex B",
        },
      );
    } finally {
      await database.cleanup();
    }
  });
});

const searchVectorText = async (
  database: PostgresTestDatabase,
  canonicalProductId: ReturnType<typeof productId>,
): Promise<string> => {
  const result = await database.query<{ readonly vector_text: string }>(
    `
      SELECT search_text::text AS vector_text
      FROM catalog_search_documents
      WHERE product_id = $1
    `,
    [canonicalProductId],
  );
  const vector = result.rows[0]?.vector_text;
  if (!vector) {
    throw new Error("Expected persisted search_text vector");
  }
  return vector;
};

const searchGinIndexCount = async (
  database: PostgresTestDatabase,
): Promise<number> => {
  const result = await database.query<{ readonly index_count: string }>(
    `
      SELECT count(*)::text AS index_count
      FROM pg_indexes
      WHERE schemaname = $1
        AND tablename = 'catalog_search_documents'
        AND indexname = 'catalog_search_documents_text_idx'
        AND indexdef ILIKE '%USING gin%'
    `,
    [database.schemaName],
  );
  return Number.parseInt(result.rows[0]?.index_count ?? "0", 10);
};

const initDatabase = async (): Promise<PostgresTestDatabase> =>
  PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `catalog_search_${randomUUID().replaceAll("-", "_")}`,
  });

const insertCanonicalProduct = async (
  database: PostgresTestDatabase,
  input: {
    readonly id?: ReturnType<typeof productId>;
    readonly title: string;
    readonly platform: string;
    readonly edition: string;
    readonly active: boolean;
  },
): Promise<ReturnType<typeof productId>> => {
  const result = await database.query<{ readonly id: string }>(
    `
      INSERT INTO products(
        id, product_type, title, platform, lifecycle, active,
        canonical_metadata_confidence, canonical_metadata
      )
      VALUES (COALESCE($1::uuid, gen_random_uuid()), 'GAME', $2, $3, 'IN_STOCK', $4, 'HIGH', $5::jsonb)
      RETURNING id::text
    `,
    [
      input.id ?? null,
      input.title,
      input.platform,
      input.active,
      JSON.stringify({ edition: input.edition }),
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error("Expected inserted product ID");
  }
  return productId(id);
};

const insertAllowedOffer = async (
  database: PostgresTestDatabase,
  canonicalProductId: ReturnType<typeof productId>,
): Promise<void> => {
  await database.query(
    `
      WITH supplier AS (
        INSERT INTO suppliers(supplier_code, display_name)
        VALUES ('mock', 'Mock')
        ON CONFLICT (supplier_code) DO UPDATE SET updated_at = now()
        RETURNING id
      ),
      supplier_product AS (
        INSERT INTO supplier_products(
          supplier_id, supplier_product_id, product_id, title,
          lifecycle, active, first_seen_at, last_seen_at
        )
        SELECT id, 'sp-' || $1::text, $1::uuid, 'Supplier Product',
          'IN_STOCK', true, now(), now()
        FROM supplier
        RETURNING id, supplier_id
      ),
      supplier_offer AS (
        INSERT INTO supplier_offers(
          supplier_id, supplier_product_id, supplier_offer_id,
          active, first_seen_at, last_seen_at
        )
        SELECT supplier_id, id, 'so-' || $1::text, true, now(), now()
        FROM supplier_product
        RETURNING id
      ),
      offer AS (
        INSERT INTO offers(product_id, supplier_offer_id, availability)
        SELECT $1::uuid, id, 'IN_STOCK'
        FROM supplier_offer
        RETURNING id
      ),
      evidence AS (
        INSERT INTO region_evidence(
          offer_id, allowed_countries, has_missing_values,
          has_unknown_values, source_evidence_version
        )
        SELECT id, ARRAY['DE']::text[], false, false, 'test'
        FROM offer
        RETURNING id, offer_id
      )
      INSERT INTO region_decisions(
        offer_id, region_evidence_id, decision, reason_code,
        policy_version, source_evidence_version
      )
      SELECT offer_id, id, 'ALLOWED', 'REGION_DE_ALLOWED',
        'de-eligibility-v1', 'de-eligibility-v1'
      FROM evidence
    `,
    [canonicalProductId],
  );
};

const insertPublication = async (
  database: PostgresTestDatabase,
  canonicalProductId: ReturnType<typeof productId>,
  state: string,
): Promise<void> => {
  await database.query(
    `
      INSERT INTO storefront_publications(
        product_id, storefront, state, publication_version,
        fingerprint, reconciliation_required
      )
      VALUES ($1, $2, $3, 'storefront-publication-v1', 'fingerprint', false)
    `,
    [canonicalProductId, storefrontChannel("KEYPLANET_DE"), state],
  );
};
