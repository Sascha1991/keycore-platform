import { createHash } from "node:crypto";

import {
  isPlausibleGuestOrderClaimCode,
  orderId,
} from "../../packages/platform/src/contracts.js";
import type { TransactionalQueryable } from "./client.js";
import { publishableStagingCatalog } from "../storefront/staging-catalog.js";

export const stagingGuestOrderId = orderId(
  "20000000-0000-4000-8000-000000000015",
);
export const stagingGuestClaimChallengeId =
  "60000000-0000-4000-8000-000000000015";
const stagingGuestPriceLockId = "50000000-0000-4000-8000-000000000015";

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
  readonly guestClaimFixture: "ACTIVE" | "CONSUMED";
}

export const seedSyntheticStagingCheckoutData = async (
  database: TransactionalQueryable,
  input: {
    readonly environment: string | undefined;
    readonly deploymentId: string | undefined;
    readonly guestClaimCode: string | undefined;
  },
): Promise<StagingCheckoutSeedResult> => {
  if (
    input.environment !== "STAGING" ||
    !input.deploymentId ||
    !/^staging-[a-z0-9][a-z0-9-]{2,62}$/u.test(input.deploymentId)
  ) {
    throw new Error("STAGING_CHECKOUT_SEED_ENVIRONMENT_REQUIRED");
  }
  if (
    !input.guestClaimCode?.startsWith("SYNTHETIC_") ||
    input.guestClaimCode.includes("GENERATE_LOCALLY") ||
    !isPlausibleGuestOrderClaimCode(input.guestClaimCode)
  ) {
    throw new Error("STAGING_GUEST_CLAIM_CODE_REQUIRED");
  }
  const guestClaimHash = createHash("sha256")
    .update(input.guestClaimCode)
    .digest("hex");

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

    const guestProduct = publishableStagingCatalog()[0];
    if (!guestProduct) throw new Error("STAGING_GUEST_CLAIM_PRODUCT_REQUIRED");
    await client.query(
      `
        INSERT INTO price_locks(
          id, product_id, currency, locked_sell_price_minor,
          pricing_quote_fingerprint, source_fingerprint, pricing_policy_version,
          pricing_policy_record_version, tax_policy_version, fee_policy_version,
          status, record_version, idempotency_key, idempotency_fingerprint,
          correlation_id, created_at, expires_at
        )
        VALUES (
          $1, $2, 'EUR', $3, 'staging-guest-claim-quote-v1',
          'staging-guest-claim-source-v1', 'staging-pricing-policy-v1', 1,
          'staging-tax-v1', 'staging-fee-v1', 'CONSUMED', 1,
          'staging-guest-claim-lock-v1', 'staging-guest-claim-lock-fingerprint-v1',
          'phase-12-account-transport-seed', statement_timestamp(),
          statement_timestamp() + interval '7 days'
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        stagingGuestPriceLockId,
        guestProduct.productId,
        guestProduct.priceMinor,
      ],
    );
    await client.query(
      `
        INSERT INTO keycore_orders(
          id, product_id, price_lock_id, checkout_email_normalized,
          customer_amount_minor, currency, quantity, status, payment_status,
          procurement_status, fulfillment_status, risk_status, refund_status,
          record_version, idempotency_key, idempotency_fingerprint,
          correlation_id, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, 'EUR', 1, 'FULFILLMENT_PENDING', 'CAPTURED',
          'SUCCEEDED', 'PENDING', 'APPROVED', 'NOT_REQUESTED', 1,
          'staging-guest-claim-order-v1', 'staging-guest-claim-order-fingerprint-v1',
          'phase-12-account-transport-seed', statement_timestamp(), statement_timestamp()
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        stagingGuestOrderId,
        guestProduct.productId,
        stagingGuestPriceLockId,
        stagingCheckoutCustomers[0].emailNormalized,
        guestProduct.priceMinor,
      ],
    );
    await client.query(
      `
        INSERT INTO guest_order_claim_challenges(
          id, order_id, email_normalized_snapshot, purpose, token_hash,
          created_at, expires_at, consumed_at, revoked_at, record_version
        )
        SELECT $1, $2, $3, 'GUEST_ORDER_CLAIM', $4,
          statement_timestamp(), statement_timestamp() + interval '7 days',
          NULL, NULL, 1
        WHERE EXISTS (
          SELECT 1 FROM keycore_orders WHERE id = $2 AND customer_id IS NULL
        )
        ON CONFLICT (id) DO NOTHING
      `,
      [
        stagingGuestClaimChallengeId,
        stagingGuestOrderId,
        stagingCheckoutCustomers[0].emailNormalized,
        guestClaimHash,
      ],
    );

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

    const guestFixture = await client.query<{
      readonly customer_id: string | null;
      readonly checkout_email_normalized: string;
      readonly token_hash: string;
      readonly consumed_at: Date | null;
      readonly revoked_at: Date | null;
    }>(
      `
        SELECT o.customer_id::text, o.checkout_email_normalized,
          c.token_hash, c.consumed_at, c.revoked_at
        FROM keycore_orders o
        JOIN guest_order_claim_challenges c ON c.order_id = o.id
        WHERE o.id = $1 AND c.id = $2
      `,
      [stagingGuestOrderId, stagingGuestClaimChallengeId],
    );
    const guest = guestFixture.rows[0];
    if (
      !guest ||
      guest.checkout_email_normalized !==
        stagingCheckoutCustomers[0].emailNormalized ||
      guest.token_hash !== guestClaimHash ||
      guest.revoked_at ||
      (guest.customer_id !== null &&
        guest.customer_id !== stagingCheckoutCustomers[0].customerId) ||
      Boolean(guest.consumed_at) !== Boolean(guest.customer_id)
    ) {
      throw new Error("STAGING_GUEST_CLAIM_FIXTURE_IDENTITY_CONFLICT");
    }

    return {
      customerCount: customerRows.rows.length,
      guestClaimFixture: guest.consumed_at ? "CONSUMED" : "ACTIVE",
      productCount: productRows.rows.length,
      status: "SEEDED",
    };
  });
};
