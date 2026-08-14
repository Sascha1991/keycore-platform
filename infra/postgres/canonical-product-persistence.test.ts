import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CanonicalProductGroupingService,
  productId,
  supplierId,
  supplierProductId,
  type CanonicalProductEvidence,
  type CanonicalProductIdentifierEvidence,
  type ProductId,
} from "../../packages/platform/src/contracts.js";
import { loadMigrations } from "./migrations.js";
import { PostgresCanonicalProductGroupingRepository } from "./canonical-product-repositories.js";

const databaseUrl = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const schemaName = `ks_grouping_${randomUUID().replaceAll("-", "_")}`;
const now = new Date("2026-08-15T00:00:00.000Z");

let client: Client | undefined;

const query = async <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values?: readonly unknown[],
): Promise<QueryResult<T>> => {
  if (!client) {
    throw new Error("PostgreSQL client is not initialized");
  }

  return client.query<T>(sql, values ? [...values] : undefined);
};

const applyAllMigrations = async (): Promise<void> => {
  const migrations = await loadMigrations();
  for (const migration of migrations) {
    await query(migration.upSql);
    await query(
      "INSERT INTO keycore_migrations(version, name) VALUES ($1, $2)",
      [migration.version, migration.name],
    );
  }
};

const rollbackAllMigrations = async (): Promise<void> => {
  const migrations = [...(await loadMigrations())].reverse();
  for (const migration of migrations) {
    await query(migration.downSql);
  }
};

describePostgres("PostgreSQL canonical product grouping persistence", () => {
  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await query(`CREATE SCHEMA ${schemaName}`);
    await query(`SET search_path TO ${schemaName}, public`);
    await applyAllMigrations();
  });

  afterAll(async () => {
    if (client) {
      await query(`SET search_path TO ${schemaName}, public`);
      await rollbackAllMigrations();
      await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await client.end();
    }
  });

  it("persists canonical mappings and allows two suppliers to map to one product", async () => {
    const repository = new PostgresCanonicalProductGroupingRepository({
      query,
    });
    const service = new CanonicalProductGroupingService({
      now: () => now,
      repository,
    });
    const first = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "271590")],
        supplierId: "supplier-a",
        supplierProductId: "a-gta",
      }),
    );
    const second = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "271590")],
        supplierId: "supplier-b",
        supplierProductId: "b-gta",
      }),
    );

    expect(second.productId).toBe(first.productId);
    await expect(
      repository.listSupplierProductsForCanonicalProduct(
        requiredProductId(first.productId),
      ),
    ).resolves.toHaveLength(2);

    const counts = await query<{
      identifiers: string;
      mappings: string;
      unique_index_exists: string;
    }>(
      `
        SELECT
          (SELECT count(*) FROM canonical_product_identifiers)::text AS identifiers,
          (SELECT count(*) FROM supplier_product_canonical_mappings)::text AS mappings,
          (SELECT count(*) FROM pg_indexes WHERE schemaname = $1 AND indexname = 'supplier_products_supplier_product_internal_unique')::text AS unique_index_exists
      `,
      [schemaName],
    );

    expect(counts.rows[0]).toMatchObject({
      identifiers: "1",
      mappings: "2",
      unique_index_exists: "0",
    });
  });

  it("survives repository restart and never silently reassigns an existing mapping", async () => {
    const repository = new PostgresCanonicalProductGroupingRepository({
      query,
    });
    const service = new CanonicalProductGroupingService({
      now: () => now,
      repository,
    });
    const input = evidence({
      identifiers: [trustedIdentifier("OFFICIAL_PRODUCT_ID", "persisted")],
      supplierProductId: "persisted-product",
    });
    const created = await service.evaluateSupplierProduct(input);
    const restarted = new PostgresCanonicalProductGroupingRepository({
      query,
    });

    await expect(restarted.findMapping(input)).resolves.toMatchObject({
      productId: created.productId,
    });
    await restarted.createOrUpdateMapping({
      mapping: {
        ...(await requiredMapping(restarted, input)),
        productId: productId(randomUUID()),
      },
    });

    await expect(restarted.findMapping(input)).resolves.toMatchObject({
      productId: created.productId,
      reasonCode: "MAPPED_PRODUCT_REASSIGNMENT_REVIEW_REQUIRED",
      state: "REVIEW_REQUIRED",
    });
  });
});

const evidence = (
  override: {
    readonly identifiers?: readonly CanonicalProductIdentifierEvidence[];
    readonly supplierId?: string;
    readonly supplierProductId?: string;
  } = {},
): CanonicalProductEvidence => ({
  identifiers: override.identifiers ?? [],
  lifecycle: "IN_STOCK",
  platforms: ["WINDOWS"],
  productType: "GAME",
  supplierId: supplierId(override.supplierId ?? "supplier-a"),
  supplierProductId: supplierProductId(
    override.supplierProductId ?? "supplier-product",
  ),
  title: "Grand Theft Auto V",
});

const trustedIdentifier = (
  type: CanonicalProductIdentifierEvidence["type"],
  value: string,
): CanonicalProductIdentifierEvidence => ({
  trustedSource: "fixture",
  type,
  value,
  verified: true,
});

const requiredProductId = (value: ProductId | undefined): ProductId => {
  if (!value) {
    throw new Error("Expected ProductId");
  }
  return value;
};

const requiredMapping = async (
  repository: PostgresCanonicalProductGroupingRepository,
  input: CanonicalProductEvidence,
) => {
  const mapping = await repository.findMapping(input);
  if (!mapping) {
    throw new Error("Expected mapping");
  }
  return mapping;
};
