import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createPricingPolicy,
  PricingConfigurationConflictError,
} from "../../packages/platform/src/pricing/pricing-margin.js";
import {
  currency,
  money,
  offerId,
  productId,
  type OfferId,
  type ProductId,
} from "../../packages/platform/src/contracts.js";
import {
  insertInitialPricingPolicy,
  PostgresPricingRepository,
} from "./pricing-repositories.js";
import { PostgresTestDatabase } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const eur = currency("EUR");

describe.skipIf(!connectionString)("PostgresPricingRepository", () => {
  it("persists global policy, overrides, manual price and snapshots across repository restart", async () => {
    const database = await initDatabase();
    try {
      const repository = new PostgresPricingRepository(database);
      const { canonicalProductId, internalOfferId } =
        await insertFixtureOffer(database);
      await insertInitialPricingPolicy(
        database,
        createPricingPolicy({
          currency: eur,
          fixedMarkup: money(0n, eur),
          markupBasisPoints: 1_000n,
          minimumProfit: money(200n, eur),
          minimumSellPrice: money(0n, eur),
          now: new Date("2026-08-15T00:00:00.000Z"),
          policyId: "00000000-0000-4000-8000-000000000901",
          quoteTtlMs: 60_000,
        }),
      );

      const updatedPolicy = await repository.updateActivePolicy({
        actorRef: "admin-pricing",
        expectedVersion: 1,
        fixedMarkup: money(50n, eur),
        reason: "integration test",
      });
      const override = await repository.updateOverride({
        actorRef: "admin-pricing",
        manualSellPrice: money(1_999n, eur),
        productId: canonicalProductId,
        reason: "manual test",
      });
      await repository.saveSnapshot({
        acquisitionCost: money(1_150n, eur),
        calculatedAt: new Date("2026-08-15T00:01:00.000Z"),
        currency: eur,
        expectedProfit: money(849n, eur),
        knownFees: money(150n, eur),
        manualPriceVersion: 1,
        marginBasisPoints: 4_247n,
        markupBasisPoints: 7_382n,
        offerId: internalOfferId,
        preRoundingPrice: money(1_999n, eur),
        pricingPolicyRecordVersion: updatedPolicy.version,
        pricingPolicyVersion: updatedPolicy.policyVersion,
        productId: canonicalProductId,
        productOverrideVersion: override.version,
        sellPrice: money(1_999n, eur),
        sourceFingerprint: "snapshot-fingerprint",
        status: "QUOTED",
        taxAmount: money(0n, eur),
        taxPolicyVersion: "tax-v1",
        validUntil: new Date("2026-08-15T00:02:00.000Z"),
      });

      const restarted = new PostgresPricingRepository(database);
      await expect(restarted.getActivePolicy()).resolves.toMatchObject({
        fixedMarkup: money(50n, eur),
        version: 2,
      });
      await expect(
        restarted.getOverride(canonicalProductId),
      ).resolves.toMatchObject({
        manualPriceVersion: 1,
        manualSellPrice: money(1_999n, eur),
        version: 1,
      });
      await expect(snapshotCount(database, canonicalProductId)).resolves.toBe(
        1,
      );
      await repository.saveSnapshot({
        acquisitionCost: money(1_150n, eur),
        calculatedAt: new Date("2026-08-15T00:01:00.000Z"),
        currency: eur,
        expectedProfit: money(849n, eur),
        knownFees: money(150n, eur),
        manualPriceVersion: 1,
        marginBasisPoints: 4_247n,
        markupBasisPoints: 7_382n,
        offerId: internalOfferId,
        preRoundingPrice: money(1_999n, eur),
        pricingPolicyRecordVersion: updatedPolicy.version,
        pricingPolicyVersion: updatedPolicy.policyVersion,
        productId: canonicalProductId,
        productOverrideVersion: override.version,
        sellPrice: money(1_999n, eur),
        sourceFingerprint: "snapshot-fingerprint",
        status: "QUOTED",
        taxAmount: money(0n, eur),
        taxPolicyVersion: "tax-v1",
      });
      await expect(snapshotCount(database, canonicalProductId)).resolves.toBe(
        1,
      );
    } finally {
      await database.cleanup();
    }
  });

  it("fails stale optimistic updates safely", async () => {
    const database = await initDatabase();
    try {
      const repository = new PostgresPricingRepository(database);
      const { canonicalProductId } = await insertFixtureOffer(database);
      await insertInitialPricingPolicy(
        database,
        createPricingPolicy({
          currency: eur,
          fixedMarkup: money(0n, eur),
          markupBasisPoints: 1_000n,
          minimumProfit: money(200n, eur),
          minimumSellPrice: money(0n, eur),
          now: new Date("2026-08-15T00:00:00.000Z"),
          policyId: "00000000-0000-4000-8000-000000000902",
        }),
      );

      await repository.updateActivePolicy({
        actorRef: "admin",
        expectedVersion: 1,
        markupBasisPoints: 1_100n,
        reason: "first",
      });
      await expect(
        repository.updateActivePolicy({
          actorRef: "admin",
          expectedVersion: 1,
          markupBasisPoints: 1_200n,
          reason: "stale",
        }),
      ).rejects.toBeInstanceOf(PricingConfigurationConflictError);

      await repository.updateOverride({
        actorRef: "admin",
        markupBasisPoints: 800n,
        productId: canonicalProductId,
        reason: "first",
      });
      await expect(
        repository.updateOverride({
          actorRef: "admin",
          expectedVersion: 0,
          markupBasisPoints: 900n,
          productId: canonicalProductId,
          reason: "stale",
        }),
      ).rejects.toBeInstanceOf(PricingConfigurationConflictError);
    } finally {
      await database.cleanup();
    }
  });
});

const initDatabase = async (): Promise<PostgresTestDatabase> =>
  PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `pricing_${randomUUID().replaceAll("-", "_")}`,
  });

const insertFixtureOffer = async (
  database: PostgresTestDatabase,
): Promise<{
  readonly canonicalProductId: ProductId;
  readonly internalOfferId: OfferId;
}> => {
  const result = await database.query<{
    readonly product_id: string;
    readonly offer_id: string;
  }>(
    `
      WITH supplier AS (
        INSERT INTO suppliers(supplier_code, display_name)
        VALUES ('pricing-test', 'Pricing Test')
        RETURNING id
      ),
      product AS (
        INSERT INTO products(product_type, title, platform, lifecycle, active, canonical_metadata_confidence)
        VALUES ('GAME', 'Pricing Product', 'WINDOWS', 'IN_STOCK', true, 'HIGH')
        RETURNING id
      ),
      supplier_product AS (
        INSERT INTO supplier_products(
          supplier_id, supplier_product_id, product_id, title, lifecycle,
          active, first_seen_at, last_seen_at
        )
        SELECT supplier.id, 'pricing-sp-' || product.id::text, product.id,
          'Supplier Pricing Product', 'IN_STOCK', true, now(), now()
        FROM supplier, product
        RETURNING id, supplier_id
      ),
      supplier_offer AS (
        INSERT INTO supplier_offers(
          supplier_id, supplier_product_id, supplier_offer_id,
          active, first_seen_at, last_seen_at
        )
        SELECT supplier_id, id, 'pricing-so-' || id::text, true, now(), now()
        FROM supplier_product
        RETURNING id
      ),
      offer AS (
        INSERT INTO offers(product_id, supplier_offer_id, availability)
        SELECT product.id, supplier_offer.id, 'IN_STOCK'
        FROM product, supplier_offer
        RETURNING id, product_id
      )
      SELECT product_id::text, id::text AS offer_id FROM offer
    `,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Expected fixture offer");
  }
  return {
    canonicalProductId: productId(row.product_id),
    internalOfferId: offerId(row.offer_id),
  };
};

const snapshotCount = async (
  database: PostgresTestDatabase,
  canonicalProductId: ProductId,
): Promise<number> => {
  const result = await database.query<{ readonly count: string }>(
    `
      SELECT count(*)::text
      FROM product_price_snapshots
      WHERE product_id = $1
    `,
    [canonicalProductId],
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
};
