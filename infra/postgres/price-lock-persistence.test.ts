import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { describe, expect, it } from "vitest";

import {
  currency,
  money,
  productId,
  type CorrelationId,
  type ProductId,
} from "../../packages/platform/src/contracts.js";
import {
  PriceLockService,
  type PriceLock,
} from "../../packages/platform/src/pricing/price-locks.js";
import type { PricingService } from "../../packages/platform/src/pricing/pricing-margin.js";
import { PostgresPriceLockRepository } from "./price-lock-repositories.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";

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
        lock: {
          invalidatedAt: new Date("2026-08-15T00:01:00.000Z"),
          recordVersion: 2,
          status: "REPRICE_REQUIRED",
        },
        status: "UPDATED",
      });
    } finally {
      await database.cleanup();
    }
  });

  it("rejects invalid lock money, expiry and partial idempotency tuples at the database boundary", async () => {
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

      await expect(
        insertRawPriceLock(database, canonicalProductId, {
          idempotencyFingerprint: "fingerprint-without-key",
          idempotencyKey: null,
        }),
      ).rejects.toThrow();
      await expect(
        insertRawPriceLock(database, canonicalProductId, {
          idempotencyFingerprint: null,
          idempotencyKey: "key-without-fingerprint",
        }),
      ).rejects.toThrow();
      await expect(
        insertRawPriceLock(database, canonicalProductId, {
          id: randomUUID(),
          idempotencyFingerprint: null,
          idempotencyKey: null,
        }),
      ).resolves.toBeDefined();

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

  it("creates idempotently under concurrent same-key and same-fingerprint calls", async () => {
    const database = await initDatabase();
    try {
      const canonicalProductId = await insertFixtureProduct(database);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_value, index) =>
          withRepositoryClient(database.schemaName, async (repository) =>
            repository.createIdempotently(
              priceLockFixture(canonicalProductId, {
                id: randomUUID(),
                idempotencyFingerprint: "same-fingerprint",
                idempotencyKey: "same-key-race",
                pricingQuoteFingerprint: `quote-${index}`,
              }),
            ),
          ),
        ),
      );

      expect(
        results.filter((result) => result.status === "CREATED"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "EXISTING_SAME"),
      ).toHaveLength(9);
      expect(new Set(results.map((result) => result.lock.id)).size).toBe(1);
      await expect(lockCount(database, canonicalProductId)).resolves.toBe(1);

      await withRepositoryClient(database.schemaName, async (repository) => {
        const restarted = await repository.createIdempotently(
          priceLockFixture(canonicalProductId, {
            id: randomUUID(),
            idempotencyFingerprint: "same-fingerprint",
            idempotencyKey: "same-key-race",
          }),
        );
        expect(restarted).toMatchObject({
          lock: { id: results[0]?.lock.id },
          status: "EXISTING_SAME",
        });
      });
    } finally {
      await database.cleanup();
    }
  });

  it("returns idempotency conflicts under concurrent same-key and different-fingerprint calls", async () => {
    const database = await initDatabase();
    try {
      const canonicalProductId = await insertFixtureProduct(database);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_value, index) =>
          withRepositoryClient(database.schemaName, async (repository) =>
            repository.createIdempotently(
              priceLockFixture(canonicalProductId, {
                id: randomUUID(),
                idempotencyFingerprint: `fingerprint-${index}`,
                idempotencyKey: "conflicting-key-race",
              }),
            ),
          ),
        ),
      );

      expect(
        results.filter((result) => result.status === "CREATED"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "EXISTING_CONFLICT"),
      ).toHaveLength(9);
      expect(new Set(results.map((result) => result.lock.id)).size).toBe(1);
      await expect(lockCount(database, canonicalProductId)).resolves.toBe(1);
    } finally {
      await database.cleanup();
    }
  });

  it("returns explicit conflicts for concurrent status transitions without generic row errors", async () => {
    const database = await initDatabase();
    try {
      const canonicalProductId = await insertFixtureProduct(database);
      const repository = new PostgresPriceLockRepository(database);
      const lock = await repository.create(
        priceLockFixture(canonicalProductId),
      );

      const results = await Promise.all(
        Array.from({ length: 10 }, (_value, index) =>
          withRepositoryClient(database.schemaName, async (clientRepository) =>
            clientRepository.updateStatus({
              expectedVersion: lock.recordVersion,
              lockId: lock.id,
              now: new Date("2026-08-15T00:01:00.000Z"),
              reasonCode:
                index % 2 === 0 ? "PROFIT_FLOOR_VIOLATION" : "PRICING_DISABLED",
              status: index % 2 === 0 ? "REPRICE_REQUIRED" : "BLOCKED",
            }),
          ),
        ),
      );

      expect(
        results.filter((result) => result.status === "UPDATED"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "CONFLICT"),
      ).toHaveLength(9);
      expect(
        results.every(
          (result) =>
            result.status === "UPDATED" || result.currentLock !== null,
        ),
      ).toBe(true);
      await expect(repository.findById(lock.id)).resolves.toMatchObject({
        lockedSellPrice: money(1_300n, eur),
        recordVersion: 2,
      });
    } finally {
      await database.cleanup();
    }
  });

  it("validates concurrent expiry as deterministic fail-closed EXPIRED results", async () => {
    const database = await initDatabase();
    try {
      const canonicalProductId = await insertFixtureProduct(database);
      const repository = new PostgresPriceLockRepository(database);
      const lock = await repository.create(
        priceLockFixture(canonicalProductId, {
          expiresAt: new Date("2026-08-15T00:00:01.000Z"),
        }),
      );

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          withRepositoryClient(
            database.schemaName,
            async (clientRepository) => {
              const service = new PriceLockService({
                now: () => new Date("2026-08-15T00:01:00.000Z"),
                pricing: {} as PricingService,
                repository: clientRepository,
              });
              return service.validatePriceLock(lock.id, correlationId);
            },
          ),
        ),
      );

      expect(results.every((result) => result.status === "EXPIRED")).toBe(true);
      await expect(repository.findById(lock.id)).resolves.toMatchObject({
        recordVersion: 2,
        status: "EXPIRED",
      });
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

      const results = await Promise.all(
        Array.from({ length: 2 }, () =>
          withRepositoryClient(database.schemaName, async (clientRepository) =>
            clientRepository.consumeIfActive({
              expectedVersion: lock.recordVersion,
              lockId: lock.id,
              now: new Date("2026-08-15T00:01:00.000Z"),
            }),
          ),
        ),
      );

      expect(results.map((result) => result?.status ?? "NONE").sort()).toEqual([
        "CONSUMED",
        "NONE",
      ]);
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

const withRepositoryClient = async <TResult>(
  schemaName: string,
  action: (repository: PostgresPriceLockRepository) => Promise<TResult>,
): Promise<TResult> => {
  if (!connectionString) {
    throw new Error("KEYCORE_TEST_DATABASE_URL is required");
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `SET search_path TO ${quoteIdentifier(schemaName)}, public`,
    );
    return await action(new PostgresPriceLockRepository(client));
  } finally {
    await client.end();
  }
};

const lockCount = async (
  database: PostgresTestDatabase,
  canonicalProductId: ProductId,
): Promise<number> => {
  const result = await database.query<{ readonly count: string }>(
    `
      SELECT count(*)::text
      FROM price_locks
      WHERE product_id = $1
    `,
    [canonicalProductId],
  );
  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
};

const insertRawPriceLock = async (
  database: PostgresTestDatabase,
  canonicalProductId: ProductId,
  overrides: {
    readonly id?: string;
    readonly idempotencyKey: string | null;
    readonly idempotencyFingerprint: string | null;
  },
) =>
  database.query(
    `
      INSERT INTO price_locks(
        id, product_id, currency, locked_sell_price_minor,
        pricing_quote_fingerprint, source_fingerprint,
        pricing_policy_version, pricing_policy_record_version,
        tax_policy_version, fee_policy_version, status, record_version,
        idempotency_key, idempotency_fingerprint, correlation_id,
        created_at, expires_at
      )
      VALUES ($1, $2, 'EUR', 1300, 'quote', 'source',
        'pricing-policy-v1', 1, 'tax-v1', 'fee-v1', 'ACTIVE', 1,
        $3, $4, $5, $6, $7)
      RETURNING id
    `,
    [
      overrides.id ?? randomUUID(),
      canonicalProductId,
      overrides.idempotencyKey,
      overrides.idempotencyFingerprint,
      correlationId,
      new Date("2026-08-15T00:00:00.000Z"),
      new Date("2026-08-15T00:02:00.000Z"),
    ],
  );

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
