import { randomUUID } from "node:crypto";

import type { QueryResult, QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  productId,
  publicationRecord,
  storefrontChannel,
  storefrontProductId,
  type ProductId,
  type StorefrontPublicationSnapshot,
} from "../../packages/platform/src/contracts.js";
import { PostgresStorefrontPublicationRepository } from "./storefront-publication-repositories.js";
import { PostgresTestDatabase } from "./test-database.js";

const databaseUrl = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const schemaName = `ks_storefront_${randomUUID().replaceAll("-", "_")}`;
const now = new Date("2026-08-15T00:00:00.000Z");
const storefront = storefrontChannel("KEYRANO_DE");
const firstProductId = productId("11111111-1111-4111-8111-111111111111");
const secondProductId = productId("22222222-2222-4222-8222-222222222222");

let database: PostgresTestDatabase | undefined;

const query = async <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values?: readonly unknown[],
): Promise<QueryResult<T>> => {
  if (!database) {
    throw new Error("PostgreSQL client is not initialized");
  }

  return database.query<T>(sql, values);
};

describePostgres("PostgreSQL storefront publication persistence", () => {
  beforeAll(async () => {
    database = await PostgresTestDatabase.initialize({
      connectionString: databaseUrl,
      schemaName,
    });
    await insertProduct(firstProductId, "Cyberpunk 2077");
    await insertProduct(secondProductId, "The Witcher 3");
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  it("persists ProductId plus storefront to remote WooCommerce product mappings", async () => {
    const repository = repositoryWithEmptySnapshot();
    await repository.savePublication(
      publicationRecord({
        fingerprint: "fingerprint-1",
        now,
        productId: firstProductId,
        remoteProductId: storefrontProductId("woo-123"),
        slug: "cyberpunk-2077",
        state: "PUBLISHED",
        storefront,
      }),
    );

    const restarted = repositoryWithEmptySnapshot();

    await expect(
      restarted.findPublication({ productId: firstProductId, storefront }),
    ).resolves.toMatchObject({
      fingerprint: "fingerprint-1",
      productId: firstProductId,
      remoteProductId: "woo-123",
      slug: "cyberpunk-2077",
      state: "PUBLISHED",
    });
  });

  it("fails closed when an existing ProductId/storefront mapping changes remote ID", async () => {
    const repository = repositoryWithEmptySnapshot();

    await expect(
      repository.savePublication(
        publicationRecord({
          now,
          productId: firstProductId,
          remoteProductId: storefrontProductId("woo-other"),
          state: "PUBLISHED",
          storefront,
        }),
      ),
    ).rejects.toThrow("MAPPING_CONFLICT_PRODUCT_STOREFRONT");

    await expect(
      repository.findPublication({ productId: firstProductId, storefront }),
    ).resolves.toMatchObject({ remoteProductId: "woo-123" });
  });

  it("fails closed when the same remote WooCommerce ID is assigned to another ProductId", async () => {
    const repository = repositoryWithEmptySnapshot();

    await expect(
      repository.savePublication(
        publicationRecord({
          now,
          productId: secondProductId,
          remoteProductId: storefrontProductId("woo-123"),
          state: "PUBLISHED",
          storefront,
        }),
      ),
    ).rejects.toThrow("MAPPING_CONFLICT_REMOTE_STOREFRONT");

    await expect(
      repository.findPublication({ productId: secondProductId, storefront }),
    ).resolves.toBeNull();
  });

  it("detects reserved slugs only within the same storefront", async () => {
    const repository = repositoryWithEmptySnapshot();

    await expect(
      repository.isSlugReserved({
        productId: secondProductId,
        slug: "cyberpunk-2077",
        storefront,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.isSlugReserved({
        productId: firstProductId,
        slug: "cyberpunk-2077",
        storefront,
      }),
    ).resolves.toBe(false);
  });
});

const repositoryWithEmptySnapshot = () =>
  new PostgresStorefrontPublicationRepository(
    { query },
    async (): Promise<StorefrontPublicationSnapshot> => ({
      mappings: [],
      offers: [],
      product: null,
    }),
  );

const insertProduct = async (id: ProductId, title: string): Promise<void> => {
  await query(
    `
      INSERT INTO products(
        id, product_type, title, platform, lifecycle, active,
        canonical_metadata_confidence, canonical_metadata
      )
      VALUES ($1, 'GAME', $2, 'WINDOWS', 'IN_STOCK', true, 'HIGH', '{}'::jsonb)
    `,
    [id, title],
  );
};
