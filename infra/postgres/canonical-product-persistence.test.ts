import { randomUUID } from "node:crypto";

import type { QueryResult, QueryResultRow } from "pg";
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
import { PostgresTestDatabase } from "./test-database.js";

const databaseUrl = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const schemaName = `ks_grouping_${randomUUID().replaceAll("-", "_")}`;
const now = new Date("2026-08-15T00:00:00.000Z");

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

const loadMigration = async (version: string) => {
  const migration = (await loadMigrations()).find(
    (candidate) => candidate.version === version,
  );
  if (!migration) {
    throw new Error(`Expected migration ${version}`);
  }
  return migration;
};

describePostgres("PostgreSQL canonical product grouping persistence", () => {
  beforeAll(async () => {
    database = await PostgresTestDatabase.initialize({
      connectionString: databaseUrl,
      schemaName,
    });
  });

  afterAll(async () => {
    await database?.cleanup();
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

  it("rolls back migration 004 without restoring the incompatible legacy unique index", async () => {
    const migration = await loadMigration("004");
    const repository = new PostgresCanonicalProductGroupingRepository({
      query,
    });
    const service = new CanonicalProductGroupingService({
      now: () => now,
      repository,
    });
    const first = await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "424242")],
        supplierId: "rollback-supplier-a",
        supplierProductId: "rollback-a",
      }),
    );
    await service.evaluateSupplierProduct(
      evidence({
        identifiers: [trustedIdentifier("STEAM_APP_ID", "424242")],
        supplierId: "rollback-supplier-b",
        supplierProductId: "rollback-b",
      }),
    );
    const canonicalProductId = requiredProductId(first.productId);

    const beforeRollback =
      await supplierProductProjectionCount(canonicalProductId);
    expect(beforeRollback).toBe("2");

    await query(migration.downSql);

    await expect(
      tableExists("supplier_product_canonical_mappings"),
    ).resolves.toBe(false);
    await expect(legacySupplierProductUniqueIndexExists()).resolves.toBe(false);
    await expect(
      supplierProductProjectionCount(canonicalProductId),
    ).resolves.toBe("2");

    await query(migration.upSql);
    await expect(
      tableExists("supplier_product_canonical_mappings"),
    ).resolves.toBe(true);
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

const supplierProductProjectionCount = async (
  canonicalProductId: ProductId,
): Promise<string> => {
  const result = await query<{ count: string }>(
    "SELECT count(*)::text FROM supplier_products WHERE product_id = $1",
    [canonicalProductId],
  );
  return result.rows[0]?.count ?? "0";
};

const tableExists = async (tableName: string): Promise<boolean> => {
  const result = await query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2
      )
    `,
    [schemaName, tableName],
  );
  return result.rows[0]?.exists ?? false;
};

const legacySupplierProductUniqueIndexExists = async (): Promise<boolean> => {
  const result = await query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = $1
          AND indexname = 'supplier_products_supplier_product_internal_unique'
      )
    `,
    [schemaName],
  );
  return result.rows[0]?.exists ?? false;
};
