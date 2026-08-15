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
      const page = await search.search({
        editions: ["DELUXE"],
        germanyPublishable: true,
        limit: 1,
        platforms: ["WINDOWS"],
        publicationStates: ["PUBLISHED"],
        text: "postgres search",
      });
      const next = await search.search({
        ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
        limit: 1,
        text: "postgres search",
      });

      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.document).toMatchObject({
        productId: firstProductId,
        searchDocumentVersion: catalogSearchPolicyVersion,
      });
      expect(next.items.map((item) => item.document.productId)).not.toContain(
        firstProductId,
      );
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
          title: "Reindex A",
          platform: "WINDOWS",
          edition: "STANDARD",
          active: true,
        }),
        await insertCanonicalProduct(database, {
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

const initDatabase = async (): Promise<PostgresTestDatabase> =>
  PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `catalog_search_${randomUUID().replaceAll("-", "_")}`,
  });

const insertCanonicalProduct = async (
  database: PostgresTestDatabase,
  input: {
    readonly title: string;
    readonly platform: string;
    readonly edition: string;
    readonly active: boolean;
  },
): Promise<ReturnType<typeof productId>> => {
  const result = await database.query<{ readonly id: string }>(
    `
      INSERT INTO products(
        product_type, title, platform, lifecycle, active,
        canonical_metadata_confidence, canonical_metadata
      )
      VALUES ('GAME', $1, $2, 'IN_STOCK', $3, 'HIGH', $4::jsonb)
      RETURNING id::text
    `,
    [
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
        SELECT id, 'sp-' || $1::text, $1, 'Supplier Product',
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
        SELECT $1, id, 'IN_STOCK'
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
