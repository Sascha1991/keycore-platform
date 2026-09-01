import type { TransactionalQueryable } from "./client.js";
import { publishableStagingCatalog } from "../storefront/staging-catalog.js";

export const stagingCheckoutCustomers = [
  {
    customerId: "10000000-0000-4000-8000-000000000001",
    emailNormalized: "customer-a@example.test",
  },
  {
    customerId: "10000000-0000-4000-8000-000000000002",
    emailNormalized: "customer-b@example.test",
  },
] as const;

export interface StagingCheckoutSeedResult {
  readonly status: "SEEDED";
  readonly customerCount: number;
  readonly productCount: number;
}

export const seedSyntheticStagingCheckoutData = async (
  database: TransactionalQueryable,
  input: {
    readonly environment: string | undefined;
    readonly deploymentId: string | undefined;
  },
): Promise<StagingCheckoutSeedResult> => {
  if (
    input.environment !== "STAGING" ||
    !input.deploymentId ||
    !/^staging-[a-z0-9][a-z0-9-]{2,62}$/u.test(input.deploymentId)
  ) {
    throw new Error("STAGING_CHECKOUT_SEED_ENVIRONMENT_REQUIRED");
  }

  return database.transaction(async (client) => {
    for (const product of publishableStagingCatalog()) {
      await client.query(
        `
          INSERT INTO products(
            id, product_type, title, platform, lifecycle, active,
            canonical_metadata_confidence, canonical_metadata
          )
          VALUES ($1, 'GAME', $2, $3, 'ACTIVE', true, 'HIGH', $4::jsonb)
          ON CONFLICT (id) DO NOTHING
        `,
        [
          product.productId,
          product.title,
          product.platform,
          JSON.stringify({
            publicReference: product.publicReference,
            synthetic: true,
          }),
        ],
      );
    }

    for (const customer of stagingCheckoutCustomers) {
      await client.query(
        `
          INSERT INTO keycore_customers(
            id, email_normalized, email_verification_state,
            record_version, created_at, updated_at
          )
          VALUES ($1, $2, 'VERIFIED', 1, statement_timestamp(), statement_timestamp())
          ON CONFLICT (id) DO NOTHING
        `,
        [customer.customerId, customer.emailNormalized],
      );
    }

    const productRows = await client.query<{
      readonly id: string;
      readonly title: string;
      readonly platform: string;
      readonly public_reference: string | null;
    }>(
      `
        SELECT
          id::text, title, platform,
          canonical_metadata->>'publicReference' AS public_reference
        FROM products
        WHERE id = ANY($1::uuid[])
        ORDER BY id
      `,
      [publishableStagingCatalog().map((product) => product.productId)],
    );
    const expectedProducts = [...publishableStagingCatalog()].sort(
      (left, right) => left.productId.localeCompare(right.productId),
    );
    if (
      productRows.rows.length !== expectedProducts.length ||
      productRows.rows.some((row, index) => {
        const expected = expectedProducts[index];
        return (
          !expected ||
          row.id !== expected.productId ||
          row.title !== expected.title ||
          row.platform !== expected.platform ||
          row.public_reference !== expected.publicReference
        );
      })
    ) {
      throw new Error("STAGING_CHECKOUT_PRODUCT_IDENTITY_CONFLICT");
    }

    const customerRows = await client.query<{
      readonly id: string;
      readonly email_normalized: string;
      readonly email_verification_state: string;
    }>(
      `
        SELECT id::text, email_normalized, email_verification_state
        FROM keycore_customers
        WHERE id = ANY($1::uuid[])
        ORDER BY id
      `,
      [stagingCheckoutCustomers.map((customer) => customer.customerId)],
    );
    const expectedCustomers = [...stagingCheckoutCustomers].sort(
      (left, right) => left.customerId.localeCompare(right.customerId),
    );
    if (
      customerRows.rows.length !== expectedCustomers.length ||
      customerRows.rows.some((row, index) => {
        const expected = expectedCustomers[index];
        return (
          !expected ||
          row.id !== expected.customerId ||
          row.email_normalized !== expected.emailNormalized ||
          row.email_verification_state !== "VERIFIED"
        );
      })
    ) {
      throw new Error("STAGING_CHECKOUT_CUSTOMER_IDENTITY_CONFLICT");
    }

    return {
      customerCount: customerRows.rows.length,
      productCount: productRows.rows.length,
      status: "SEEDED",
    };
  });
};
