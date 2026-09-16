import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { correlationId } from "../../packages/platform/src/contracts.js";
import { publishableStagingCatalog } from "../storefront/staging-catalog.js";
import type { Queryable, TransactionalQueryable } from "./client.js";
import { PostgresAdminOrderReadRepository } from "./admin-repositories.js";
import { PostgresPromotionRepository } from "./promotion-repository.js";
import { seedSyntheticStagingCheckoutData } from "./staging-checkout-seed.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const now = new Date("2026-09-15T10:00:00.000Z");
const productId = publishableStagingCatalog()[0]?.productId;
const context = {
  actorId: "admin-promotion-test",
  at: now,
  correlationId: correlationId("promotion-persistence-test"),
  environment: "STAGING" as const,
};

describe.skipIf(!connectionString)("promotion persistence", () => {
  it("persists draft-first campaigns, server-side product search, filters and lifecycle", async () => {
    await withDatabase(async (database) => {
      const repository = new PostgresPromotionRepository(database);
      const campaignId = await createCampaign(repository, {
        productScope: "SELECTED_PRODUCTS",
      });
      await expect(
        repository.create(
          {
            code: "STAGING20",
            currency: "EUR",
            discountType: "FIXED_AMOUNT",
            discountValue: 100n,
            endsAt: null,
            id: "71000000-0000-4000-8000-000000000002",
            internalDescription: "Duplicate normalized code",
            minimumSubtotalMinor: null,
            name: "Duplicate code",
            operationId: randomUUID(),
            productScope: "ALL_ELIGIBLE_PRODUCTS",
            startsAt: null,
            usageLimit: null,
          },
          context,
        ),
      ).resolves.toMatchObject({ status: "DUPLICATE" });

      await expect(
        repository.quote(quoteInput("STAGING20"), now),
      ).resolves.toBeNull();
      await expect(repository.searchProducts("Neonpfad", 20)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: requiredProductId(), active: true }),
        ]),
      );
      await expect(
        repository.setProductEligibility(
          {
            expectedVersion: 1,
            id: campaignId,
            productId: requiredProductId(),
            selected: true,
          },
          context,
        ),
      ).resolves.toBe("UPDATED");
      await expect(
        repository.transition(
          { expectedVersion: 2, id: campaignId, lifecycle: "ENABLED" },
          context,
        ),
      ).resolves.toBe("UPDATED");
      await expect(
        repository.quote(quoteInput("staging20"), now),
      ).resolves.toMatchObject({
        code: "STAGING20",
        discountAmountMinor: 259n,
        finalAmountMinor: 1_040n,
      });

      const overview = await repository.list(
        {
          limit: 10,
          page: 1,
          search: "staging",
          sort: "NAME_ASC",
          status: "ACTIVE",
        },
        now,
      );
      expect(overview).toMatchObject({ active: 1, total: 1, totalCount: 1 });
      expect(overview.campaigns[0]).toMatchObject({
        id: campaignId,
        productIds: [requiredProductId()],
      });
      await expect(
        repository.list({ limit: 25, page: 1, sort: "UPDATED_DESC" }, now),
      ).resolves.toMatchObject({ total: 1, totalCount: 1 });
    });
  }, 30_000);

  it("serializes the final global use across independent PostgreSQL connections", async () => {
    await withDatabase(async (database) => {
      const repository = new PostgresPromotionRepository(database);
      await createCampaign(repository, { usageLimit: 1n });
      await repository.transition(
        { expectedVersion: 1, id: campaignId, lifecycle: "ENABLED" },
        context,
      );

      const firstDb = await SchemaDatabase.connect(
        requiredConnectionString(),
        database.schemaName,
      );
      const secondDb = await SchemaDatabase.connect(
        requiredConnectionString(),
        database.schemaName,
      );
      try {
        const expiry = new Date("2026-09-15T10:15:00.000Z");
        const results = await Promise.all([
          new PostgresPromotionRepository(firstDb).reserve(
            {
              ...quoteInput("STAGING20"),
              checkoutToken: "a".repeat(64),
              expiresAt: expiry,
            },
            now,
          ),
          new PostgresPromotionRepository(secondDb).reserve(
            {
              ...quoteInput("STAGING20"),
              checkoutToken: "b".repeat(64),
              expiresAt: expiry,
            },
            now,
          ),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        await expect(
          database.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM promotion_redemptions WHERE state = 'RESERVED'",
          ),
        ).resolves.toMatchObject({ rows: [{ count: "1" }] });
      } finally {
        await Promise.all([firstDb.close(), secondDb.close()]);
      }
    });
  }, 30_000);

  it("releases failed attempts and keeps consumed order evidence immutable", async () => {
    await withDatabase(async (database) => {
      const repository = new PostgresPromotionRepository(database);
      await createCampaign(repository);
      await repository.transition(
        { expectedVersion: 1, id: campaignId, lifecycle: "ENABLED" },
        context,
      );
      const expiry = new Date("2026-09-15T10:15:00.000Z");
      const releasedToken = "c".repeat(64);
      await expect(
        repository.reserve(
          {
            ...quoteInput("STAGING20"),
            checkoutToken: releasedToken,
            expiresAt: expiry,
          },
          now,
        ),
      ).resolves.toMatchObject({ state: "RESERVED" });
      await repository.release(releasedToken, now);
      await expect(
        repository.findReservation(releasedToken, now),
      ).resolves.toBeNull();

      const consumedToken = "d".repeat(64);
      await repository.reserve(
        {
          ...quoteInput("STAGING20"),
          checkoutToken: consumedToken,
          expiresAt: expiry,
        },
        now,
      );
      await expect(
        repository.consume(
          { checkoutToken: consumedToken, orderId: seededOrderId },
          now,
        ),
      ).resolves.toBe("CONSUMED");
      await expect(
        repository.consume(
          { checkoutToken: consumedToken, orderId: seededOrderId },
          now,
        ),
      ).resolves.toBe("IDEMPOTENT");
      await expect(
        repository.findReservation(consumedToken, now),
      ).resolves.toMatchObject({
        discountAmountMinor: 259n,
        finalAmountMinor: 1_040n,
        state: "CONSUMED",
      });
      await expect(
        database.query(
          "UPDATE promotion_redemptions SET discount_amount_minor = 1 WHERE checkout_token = $1",
          [consumedToken],
        ),
      ).rejects.toThrow(/immutable/iu);
      await expect(repository.find(campaignId, now)).resolves.toMatchObject({
        consumedCount: 1n,
        hasCommittedUsage: true,
        recentUsage: [expect.objectContaining({ orderId: seededOrderId })],
      });
      await expect(
        repository.update(
          {
            code: "STAGING20",
            currency: "EUR",
            discountType: "PERCENTAGE",
            discountValue: 2_000n,
            endsAt: null,
            expectedVersion: 2,
            id: campaignId,
            internalDescription: "Synthetic persistence test",
            minimumSubtotalMinor: null,
            name: "Staging 20",
            productScope: "ALL_ELIGIBLE_PRODUCTS",
            startsAt: null,
            usageLimit: 0n,
          },
          context,
        ),
      ).resolves.toBe("IMMUTABLE");
      await expect(
        new PostgresAdminOrderReadRepository(database).findDetail(
          seededOrderId as Parameters<
            PostgresAdminOrderReadRepository["findDetail"]
          >[0],
        ),
      ).resolves.toMatchObject({
        promotion: {
          baseAmountMinor: "1299",
          campaignId,
          campaignName: "Staging 20",
          code: "STAGING20",
          discountAmountMinor: "259",
          discountType: "PERCENTAGE",
          discountValue: "2000",
          finalAmountMinor: "1040",
        },
      });
    });
  }, 30_000);
});

const campaignId = "71000000-0000-4000-8000-000000000001";
const seededOrderId = "20000000-0000-4000-8000-000000000015";

const createCampaign = async (
  repository: PostgresPromotionRepository,
  overrides: {
    productScope?: "ALL_ELIGIBLE_PRODUCTS" | "SELECTED_PRODUCTS";
    usageLimit?: bigint | null;
  } = {},
): Promise<string> => {
  await repository.create(
    {
      code: "STAGING20",
      currency: "EUR",
      discountType: "PERCENTAGE",
      discountValue: 2_000n,
      endsAt: null,
      id: campaignId,
      internalDescription: "Synthetic persistence test",
      minimumSubtotalMinor: null,
      name: "Staging 20",
      operationId: randomUUID(),
      productScope: overrides.productScope ?? "ALL_ELIGIBLE_PRODUCTS",
      startsAt: null,
      usageLimit: overrides.usageLimit ?? null,
    },
    context,
  );
  return campaignId;
};

const quoteInput = (code: string) => ({
  baseAmountMinor: 1_299n,
  code,
  currency: "EUR" as const,
  maximumDiscountMinor: 299n,
  productId: requiredProductId(),
});

const requiredProductId = (): string => {
  if (!productId) throw new Error("Synthetic product unavailable");
  return productId;
};

const withDatabase = async (
  action: (database: PostgresTestDatabase) => Promise<void>,
) => {
  const database = await PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `promotion_${randomUUID().replaceAll("-", "")}`,
  });
  try {
    await seedSyntheticStagingCheckoutData(database, {
      deploymentId: "staging-promotion-test",
      environment: "STAGING",
      guestClaimCode: "SYNTHETIC_PROMOTION_CLAIM_TEST_123456789",
    });
    await action(database);
  } finally {
    await database.cleanup();
  }
};

const requiredConnectionString = (): string => {
  if (!connectionString)
    throw new Error("KEYCORE_TEST_DATABASE_URL is required");
  return connectionString;
};

class SchemaDatabase implements TransactionalQueryable {
  private constructor(private readonly client: Client) {}
  public static async connect(
    connection: string,
    schema: string,
  ): Promise<SchemaDatabase> {
    const client = new Client({ connectionString: connection });
    await client.connect();
    await client.query(`SET search_path TO ${quoteIdentifier(schema)}, public`);
    return new SchemaDatabase(client);
  }
  public query<TResult extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<TResult>> {
    return this.client.query<TResult>(sql, values ? [...values] : undefined);
  }
  public async transaction<TResult>(
    action: (client: Queryable) => Promise<TResult>,
  ): Promise<TResult> {
    await this.client.query("BEGIN");
    try {
      const result = await action(this);
      await this.client.query("COMMIT");
      return result;
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }
  public async close(): Promise<void> {
    await this.client.end();
  }
}
