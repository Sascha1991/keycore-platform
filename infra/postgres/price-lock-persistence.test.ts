import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  currency,
  money,
  productId,
  type CorrelationId,
  type ProductId,
} from "../../packages/platform/src/contracts.js";
import type { PriceLock } from "../../packages/platform/src/pricing/price-locks.js";
import { PostgresPriceLockRepository } from "./price-lock-repositories.js";
import { PostgresTestDatabase } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const eur = currency("EUR");
const correlationId = "corr-postgres-price-lock" as CorrelationId;

describe.skipIf(!connectionString)("PostgresPriceLockRepository", () => {
  it("persists active locks, idempotency mapping, status and expiry across repository restart", async () => {
    const database = await initDatabase();
    try {
      const canonicalProductId = await insertFixtureProduct(database);
      const repository = new PostgresPriceLockRepository(database);
      const lock = priceLockFixture(canonicalProductId, {
        idempotencyKey: "pg-idem-1",
      });

      const created = await repository.create(lock);
      const restarted = new PostgresPriceLockRepository(database);

      await expect(restarted.findById(created.id)).resolves.toMatchObject({
        expiresAt: lock.expiresAt,
        lockedSellPrice: money(1_300n, eur),
        status: "ACTIVE",
      });
      await expect(
        restarted.findByIdempotencyKey("pg-idem-1"),
      ).resolves.toMatchObject({
        id: created.id,
        idempotencyFingerprint: lock.idempotencyFingerprint,
      });
      const blocked = await restarted.updateStatus({
        expectedVersion: created.recordVersion,
        lockId: created.id,
        now: new Date("2026-08-15T00:01:00.000Z"),
        reasonCode: "PROFIT_FLOOR_VIOLATION",
        status: "REPRICE_REQUIRED",
      });
      expect(blocked).toMatchObject({
        invalidatedAt: new Date("2026-08-15T00:01:00.000Z"),
        recordVersion: 2,
        status: "REPRICE_REQUIRED",
      });
    } finally {
      await database.cleanup();
    }
  });

  it("rejects invalid lock money, expiry and idempotency states at the database boundary", async () => {
    const database = await initDatabase();
    try {
      const canonicalProductId = await insertFixtureProduct(database);
      await expect(
        database.query(
          `
            INSERT INTO price_locks(
              product_id, currency, locked_sell_price_minor,
              pricing_quote_fingerprint, source_fingerprint,
              pricing_policy_version, pricing_policy_record_version,
              tax_policy_version, fee_policy_version, status, record_version,
              idempotency_key, correlation_id, created_at, expires_at
            )
            VALUES ($1, 'EUR', 0, 'quote', 'source', 'pricing-policy-v1', 1,
              'tax-v1', 'fee-v1', 'ACTIVE', 1, 'bad-idem', $2, $3, $3)
          `,
          [
            canonicalProductId,
            correlationId,
            new Date("2026-08-15T00:00:00.000Z"),
          ],
        ),
      ).rejects.toThrow();

      const repository = new PostgresPriceLockRepository(database);
      await repository.create(
        priceLockFixture(canonicalProductId, { idempotencyKey: "unique-idem" }),
      );
      await expect(
        repository.create(
          priceLockFixture(canonicalProductId, {
            id: "00000000-0000-4000-8000-000000006612",
            idempotencyKey: "unique-idem",
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await database.cleanup();
    }
  });

  it("atomically allows exactly one active lock consumption", async () => {
    const database = await initDatabase();
    try {
      const canonicalProductId = await insertFixtureProduct(database);
      const repository = new PostgresPriceLockRepository(database);
      const lock = await repository.create(
        priceLockFixture(canonicalProductId),
      );

      const [first, second] = await Promise.all([
        repository.consumeIfActive({
          expectedVersion: lock.recordVersion,
          lockId: lock.id,
          now: new Date("2026-08-15T00:01:00.000Z"),
        }),
        repository.consumeIfActive({
          expectedVersion: lock.recordVersion,
          lockId: lock.id,
          now: new Date("2026-08-15T00:01:00.000Z"),
        }),
      ]);

      expect(
        [first?.status ?? "NONE", second?.status ?? "NONE"].sort(),
      ).toEqual(["CONSUMED", "NONE"]);
      await expect(repository.findById(lock.id)).resolves.toMatchObject({
        recordVersion: 2,
        status: "CONSUMED",
      });
    } finally {
      await database.cleanup();
    }
  });
});

const initDatabase = async (): Promise<PostgresTestDatabase> =>
  PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `price_locks_${randomUUID().replaceAll("-", "_")}`,
  });

const insertFixtureProduct = async (
  database: PostgresTestDatabase,
): Promise<ProductId> => {
  const result = await database.query<{ readonly product_id: string }>(
    `
      INSERT INTO products(product_type, title, platform, lifecycle, active, canonical_metadata_confidence)
      VALUES ('GAME', 'Price Lock Product', 'WINDOWS', 'IN_STOCK', true, 'HIGH')
      RETURNING id::text AS product_id
    `,
  );
  return productId(result.rows[0]?.product_id ?? "");
};

const priceLockFixture = (
  canonicalProductId: ProductId,
  overrides: Partial<PriceLock> = {},
): PriceLock => ({
  correlationId,
  createdAt: new Date("2026-08-15T00:00:00.000Z"),
  currency: eur,
  expiresAt: new Date("2026-08-15T00:02:00.000Z"),
  feePolicyVersion: "fee-v1",
  id: "00000000-0000-4000-8000-000000006611",
  idempotencyFingerprint: "idem-fingerprint",
  idempotencyKey: "idem-fixture",
  lockedSellPrice: money(1_300n, eur),
  pricingPolicyRecordVersion: 1,
  pricingPolicyVersion: "pricing-policy-v1",
  pricingQuoteFingerprint: "quote-fingerprint",
  productId: canonicalProductId,
  recordVersion: 1,
  sourceOfferFingerprint: "source-fingerprint",
  status: "ACTIVE",
  taxPolicyVersion: "tax-v1",
  ...overrides,
});
