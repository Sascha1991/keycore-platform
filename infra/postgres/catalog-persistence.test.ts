import { randomUUID } from "node:crypto";

import type { QueryResult, QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CatalogSyncService,
  GermanyEligibilityEngine,
  StaticCatalogOfferDiscovery,
  catalogOfferProductMappingChangedMessage,
  germanyEligibilityPolicyVersion,
  type NormalizedSupplierOffer,
} from "../../packages/platform/src/contracts.js";
import {
  createGeneratedMockSupplierFixtures,
  MockSupplier,
  type MockOfferFixture,
} from "../suppliers/mock/mock-supplier.js";
import { PostgresCatalogSyncRepository } from "./catalog-repositories.js";
import { PostgresTestDatabase } from "./test-database.js";

const databaseUrl = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const schemaName = `ks_catalog_${randomUUID().replaceAll("-", "_")}`;

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

describePostgres("PostgreSQL catalog synchronization persistence", () => {
  beforeAll(async () => {
    database = await PostgresTestDatabase.initialize({
      connectionString: databaseUrl,
      schemaName,
    });
  });

  afterAll(async () => {
    await database?.cleanup();
  });

  it("persists full sync runs, checkpoints, durable mappings and Germany decisions", async () => {
    const fixtures = createGeneratedMockSupplierFixtures({
      productCount: 3,
      seed: "pg-catalog",
    });
    const supplier = new MockSupplier(fixtures);
    const repository = new PostgresCatalogSyncRepository(requiredDatabase());
    const service = new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      offerDiscovery: new StaticCatalogOfferDiscovery(
        await normalizedOffers(supplier, fixtures.offers),
      ),
      repository,
    });

    const result = await service.runFullSync(supplier);

    expect(result.run.status).toBe("SUCCEEDED");
    expect(result.run.metrics.productsSeen).toBe(3);
    const firstOffer = requiredFixture(fixtures.offers[0]);
    await expect(
      repository.getOfferMapping({
        supplierId: supplier.identity.supplierId,
        supplierOfferId: firstOffer.supplierOfferId,
      }),
    ).resolves.toBe(firstOffer.supplierProductId);

    const counts = await query<{
      products: string;
      offers: string;
      decisions: string;
      checkpoints: string;
    }>(
      `
        SELECT
          (SELECT count(*) FROM supplier_products)::text AS products,
          (SELECT count(*) FROM supplier_offers)::text AS offers,
          (SELECT count(*) FROM region_decisions WHERE policy_version = $1)::text AS decisions,
          (SELECT count(*) FROM catalog_sync_checkpoints)::text AS checkpoints
      `,
      [germanyEligibilityPolicyVersion],
    );

    expect(counts.rows[0]).toMatchObject({
      checkpoints: "1",
      decisions: "4",
      offers: "4",
      products: "3",
    });
  });

  it("rejects supplier offer mapping swaps without changing migrations", async () => {
    const fixtures = createGeneratedMockSupplierFixtures({
      productCount: 2,
      seed: "pg-map",
    });
    const supplier = new MockSupplier(fixtures);
    const repository = new PostgresCatalogSyncRepository(requiredDatabase());
    const normalized = await normalizedOffers(supplier, fixtures.offers);
    await new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      offerDiscovery: new StaticCatalogOfferDiscovery(normalized),
      repository,
    }).runFullSync(supplier);
    const originalOffer = requiredNormalizedOffer(normalized[0]);
    const otherProductOffer = findOfferForDifferentProduct(
      normalized,
      originalOffer.supplierProductId,
    );
    const originalCheckpoint = await repository.getCheckpoint({
      mode: "FULL",
      supplierId: supplier.identity.supplierId,
    });

    const moved = {
      ...originalOffer,
      supplierProductId: otherProductOffer.supplierProductId,
    };
    const product = await supplier.getProduct(
      otherProductOffer.supplierProductId,
    );
    if (!product) {
      throw new Error("Expected generated product");
    }

    const service = new CatalogSyncService({
      eligibilityEngine: new GermanyEligibilityEngine(),
      offerDiscovery: new StaticCatalogOfferDiscovery([moved]),
      repository,
    });
    const result = await service.ingestWebhook({
      offers: [moved],
      product,
      supplier,
    });

    expect(result.run.status).toBe("FAILED");
    expect(result.run.errorMessage).toBe(
      catalogOfferProductMappingChangedMessage,
    );
    await expect(
      repository.getOfferMapping({
        supplierId: supplier.identity.supplierId,
        supplierOfferId: originalOffer.supplierOfferId,
      }),
    ).resolves.toBe(originalOffer.supplierProductId);
    await expect(
      repository.getCheckpoint({
        mode: "FULL",
        supplierId: supplier.identity.supplierId,
      }),
    ).resolves.toEqual(originalCheckpoint);

    const repeated = await service.ingestWebhook({
      offers: [moved],
      product,
      supplier,
    });

    expect(repeated.run.status).toBe("FAILED");
    expect(repeated.run.errorMessage).toBe(
      catalogOfferProductMappingChangedMessage,
    );
  });

  it("enforces the durable region evidence snapshot identity", async () => {
    await expect(
      query(`
        INSERT INTO region_evidence(
          offer_id, allowed_countries, excluded_countries,
          supplier_region_identifier, documented_semantics_reference,
          requires_vpn, requires_foreign_account, activation_restrictions,
          has_missing_values, has_unknown_values, has_contradictory_evidence,
          source_evidence_version, captured_at
        )
        SELECT offer_id, allowed_countries, excluded_countries,
          supplier_region_identifier, documented_semantics_reference,
          requires_vpn, requires_foreign_account, activation_restrictions,
          has_missing_values, has_unknown_values, has_contradictory_evidence,
          source_evidence_version, captured_at
        FROM region_evidence
        ORDER BY id
        LIMIT 1
      `),
    ).rejects.toThrow(
      /region_evidence_offer_version_captured_idx|duplicate key/u,
    );
  });
});

const normalizedOffers = async (
  supplier: MockSupplier,
  offers: readonly MockOfferFixture[],
): Promise<readonly NormalizedSupplierOffer[]> =>
  Promise.all(
    offers.map(async (offer) => {
      const normalized = await supplier.getOffer(offer.supplierOfferId);
      if (!normalized) {
        throw new Error("Expected normalized supplier offer fixture");
      }
      return normalized;
    }),
  );

const requiredNormalizedOffer = (
  offer: NormalizedSupplierOffer | undefined,
): NormalizedSupplierOffer => {
  if (!offer) {
    throw new Error("Expected normalized supplier offer fixture");
  }
  return offer;
};

const findOfferForDifferentProduct = (
  offers: readonly NormalizedSupplierOffer[],
  supplierProductId: string,
): NormalizedSupplierOffer => {
  const offer = offers.find(
    (candidate) => candidate.supplierProductId !== supplierProductId,
  );
  if (!offer) {
    throw new Error("Expected generated fixture with another product offer");
  }
  return offer;
};

const requiredFixture = <TFixture>(fixture: TFixture | undefined): TFixture => {
  if (!fixture) {
    throw new Error("Expected generated fixture");
  }
  return fixture;
};

const requiredDatabase = (): PostgresTestDatabase => {
  if (!database) throw new Error("PostgreSQL client is not initialized");
  return database;
};
