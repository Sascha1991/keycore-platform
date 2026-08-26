import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  CustomerOrderIdentityService,
  CustomerRegistrationService,
  FakeCustomerEmailVerificationDeliveryPort,
  FakeGuestOrderClaimDeliveryPort,
  GuestOrderClaimService,
  PersistedGuestOrderClaimIssuanceAuthority,
  PersistedGuestOrderClaimAuthority,
  correlationId,
  orderId,
  productId,
  type CorrelationId,
  type CustomerId,
  type EmailVerificationAuthorityPort,
  type OrderId,
} from "../../packages/platform/src/contracts.js";
import { PostgresCustomerOrderIdentityRepository } from "./customer-order-identity-repositories.js";
import { PostgresCustomerRegistrationChallengeRepository } from "./customer-registration-repositories.js";
import { PostgresGuestOrderClaimRepository } from "./guest-order-claim-repositories.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const now = new Date("2026-08-26T15:00:00.000Z");
const claimCode = "pg-claim-code-with-enough-entropy-842913";

describePostgres("PostgresGuestOrderClaimRepository", () => {
  it("persists hash-only claim credentials, reissues safely and consumes once under concurrency", async () => {
    const database = await initDatabase();
    try {
      const boundary = new TestTransactionBoundary(database);
      const identityRepository = new PostgresCustomerOrderIdentityRepository(
        boundary,
      );
      const claimRepository = new PostgresGuestOrderClaimRepository(boundary);
      const challengeRepository =
        new PostgresCustomerRegistrationChallengeRepository(boundary);
      const claimDelivery = new FakeGuestOrderClaimDeliveryPort();
      const claimService = new GuestOrderClaimService({
        claimTtlMs: 604_800_000,
        delivery: claimDelivery,
        issuanceAuthority: new PersistedGuestOrderClaimIssuanceAuthority(
          identityRepository,
        ),
        now: () => now,
        repository: claimRepository,
        tokenFactory: () => claimCode,
      });
      const registrationService = registrationServiceFor(
        identityRepository,
        challengeRepository,
        claimRepository,
      );
      const guestOrder = await insertGuestOrder(
        database,
        "pg-guest@example.com",
      );
      const buyer = await createVerifiedCustomer(
        identityRepository,
        "pg-guest@example.com",
      );

      await expect(
        claimService.issueGuestOrderClaim({
          checkoutEmail: "pg-guest@example.com",
          correlationId: correlationId("ks0805-pg-issue"),
          orderId: guestOrder,
        }),
      ).resolves.toEqual({ status: "ISSUED" });
      expect(claimDelivery.deliveries[0]?.rawClaimCode).toBe(claimCode);
      const stored = await database.query<{
        readonly token_hash: string;
        readonly checkout_email_normalized: string | null;
      }>(
        `
          SELECT c.token_hash, o.checkout_email_normalized
          FROM guest_order_claim_challenges c
          JOIN keycore_orders o ON o.id = c.order_id
          WHERE c.order_id = $1
        `,
        [guestOrder],
      );
      expect(stored.rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(stored.rows[0]?.token_hash).not.toBe(claimCode);
      expect(stored.rows[0]?.checkout_email_normalized).toBe(
        "pg-guest@example.com",
      );

      const race = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          registrationService.claimGuestOrder({
            claimCode,
            correlationId: correlationId(`ks0805-pg-claim-${index}`),
            principal: {
              authenticationContext: {
                assurance: "AUTHENTICATED",
                provider: "TEST",
              },
              customerId: buyer,
            },
          }),
        ),
      );
      expect(race.filter((result) => result.status === "CLAIMED")).toHaveLength(
        1,
      );
      expect(
        race.filter((result) => result.status === "CLAIM_DENIED"),
      ).toHaveLength(9);
      await expect(
        database.query(
          "SELECT customer_id::text FROM keycore_orders WHERE id = $1",
          [guestOrder],
        ),
      ).resolves.toMatchObject({
        rows: [expect.objectContaining({ customer_id: buyer })],
      });
    } finally {
      await database.cleanup();
    }
  }, 30_000);

  it("keeps legacy null-email orders unclaimable, enforces immutable snapshots and token hash uniqueness", async () => {
    const database = await initDatabase();
    try {
      const boundary = new TestTransactionBoundary(database);
      const claimRepository = new PostgresGuestOrderClaimRepository(boundary);
      const claimService = new GuestOrderClaimService({
        delivery: new FakeGuestOrderClaimDeliveryPort(),
        issuanceAuthority: new PersistedGuestOrderClaimIssuanceAuthority(
          new PostgresCustomerOrderIdentityRepository(boundary),
        ),
        now: () => now,
        repository: claimRepository,
        tokenFactory: () => claimCode,
      });
      const legacyOrder = await insertGuestOrder(database, null);
      await expect(
        claimService.inspectOrderClaim({ orderId: legacyOrder }),
      ).resolves.toMatchObject({
        activeClaimCount: 0,
        hasCheckoutEmailSnapshot: false,
        isOwned: false,
      });
      await expect(
        claimService.issueGuestOrderClaim({
          checkoutEmail: "legacy@example.com",
          correlationId: correlationId("ks0805-pg-legacy-backfill-denied"),
          orderId: legacyOrder,
        }),
      ).resolves.toMatchObject({
        reasonCode: "CHECKOUT_EMAIL_SNAPSHOT_REQUIRED",
        status: "CLAIM_ISSUE_DENIED",
      });
      await expect(
        database.query(
          `
            UPDATE keycore_orders
            SET checkout_email_normalized = 'legacy@example.com'
            WHERE id = $1
          `,
          [legacyOrder],
        ),
      ).rejects.toThrow(/immutable/u);

      const snapshottedOrder = await insertGuestOrder(
        database,
        "snapshot@example.com",
      );
      await expect(
        database.query(
          `
            UPDATE keycore_orders
            SET checkout_email_normalized = 'changed@example.com'
            WHERE id = $1
          `,
          [snapshottedOrder],
        ),
      ).rejects.toThrow(/immutable/u);
      await expect(
        database.query(
          `
            UPDATE keycore_orders
            SET checkout_email_normalized = NULL
            WHERE id = $1
          `,
          [snapshottedOrder],
        ),
      ).rejects.toThrow(/immutable/u);
      await expect(
        database.query(
          `
            INSERT INTO guest_order_claim_challenges(
              id, order_id, email_normalized_snapshot, purpose, token_hash,
              created_at, expires_at, record_version
            )
            VALUES (
              gen_random_uuid(), $1, 'legacy@example.com', 'GUEST_ORDER_CLAIM',
              'a', $2, $3, 1
            )
          `,
          [legacyOrder, now, new Date(now.getTime() + 60_000)],
        ),
      ).rejects.toThrow();
    } finally {
      await database.cleanup();
    }
  }, 30_000);
});

const initDatabase = async (): Promise<PostgresTestDatabase> =>
  PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `guest_claim_${randomUUID().replaceAll("-", "_")}`,
  });

const registrationServiceFor = (
  identityRepository: PostgresCustomerOrderIdentityRepository,
  challengeRepository: PostgresCustomerRegistrationChallengeRepository,
  claimRepository: PostgresGuestOrderClaimRepository,
): CustomerRegistrationService =>
  new CustomerRegistrationService({
    challengeRepository,
    claimAuthority: new PersistedGuestOrderClaimAuthority({
      now: () => now,
      repository: claimRepository,
    }),
    delivery: new FakeCustomerEmailVerificationDeliveryPort(),
    identityRepository,
    identityService: new CustomerOrderIdentityService({
      now: () => now,
      repository: identityRepository,
    }),
    now: () => now,
  });

const createVerifiedCustomer = async (
  repository: PostgresCustomerOrderIdentityRepository,
  email: string,
): Promise<CustomerId> => {
  const service = new CustomerOrderIdentityService({
    emailVerificationAuthority: new FakeEmailVerificationAuthority(),
    now: () => now,
    repository,
  });
  const created = await service.createCustomer({
    correlationId: correlationId(`ks0805-pg-create-${email}`),
    email,
  });
  if (!("customer" in created)) {
    throw new Error("Expected PostgreSQL guest claim customer fixture");
  }
  await service.markEmailVerified({
    correlationId: correlationId(`ks0805-pg-verify-${email}`),
    customerId: created.customer.id,
    expectedCustomerVersion: 1,
  });
  return created.customer.id;
};

const insertGuestOrder = async (
  database: PostgresTestDatabase,
  checkoutEmailNormalized: string | null,
): Promise<OrderId> => {
  const targetProduct = await insertProduct(database);
  const lockId = await insertPriceLock(database, targetProduct);
  const id = orderId(randomUUID());
  await database.query(
    `
      INSERT INTO keycore_orders(
        id, product_id, price_lock_id, checkout_email_normalized,
        customer_amount_minor, currency,
        quantity, status, payment_status, procurement_status,
        fulfillment_status, risk_status, refund_status, record_version,
        idempotency_key, idempotency_fingerprint, correlation_id,
        created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, 1300, 'EUR', 1, 'FULFILLMENT_PENDING', 'CAPTURED',
        'SUCCEEDED', 'PENDING', 'APPROVED', 'NOT_REQUESTED', 1,
        $5, $6, $7, $8, $8
      )
    `,
    [
      id,
      targetProduct,
      lockId,
      checkoutEmailNormalized,
      `order-idem-${id}`,
      `order-fingerprint-${id}`,
      "ks0805-pg-order",
      now,
    ],
  );
  return id;
};

const insertProduct = async (
  database: PostgresTestDatabase,
): Promise<ReturnType<typeof productId>> => {
  const result = await database.query<{ readonly id: string }>(
    `
      INSERT INTO products(product_type, title, platform, lifecycle, active, canonical_metadata_confidence)
      VALUES ('GAME', 'Guest Claim Fixture', 'WINDOWS', 'IN_STOCK', true, 'HIGH')
      RETURNING id::text
    `,
  );
  return productId(required(result.rows[0]).id);
};

const insertPriceLock = async (
  database: PostgresTestDatabase,
  targetProductId: ReturnType<typeof productId>,
): Promise<string> => {
  const id = randomUUID();
  await database.query(
    `
      INSERT INTO price_locks(
        id, product_id, currency, locked_sell_price_minor,
        pricing_quote_fingerprint, source_fingerprint, pricing_policy_version,
        pricing_policy_record_version, tax_policy_version, fee_policy_version,
        status, record_version, idempotency_key, idempotency_fingerprint,
        correlation_id, created_at, expires_at
      )
      VALUES (
        $1, $2, 'EUR', 1300, $3, $4, 'pricing-policy-v1', 1,
        'tax-v1', 'fee-v1', 'CONSUMED', 1, $5, $6, $7, $8, $9
      )
    `,
    [
      id,
      targetProductId,
      `quote-${id}`,
      `source-${id}`,
      `idem-${id}`,
      `fingerprint-${id}`,
      "ks0805-pg-lock",
      now,
      new Date(now.getTime() + 60_000),
    ],
  );
  return id;
};

class FakeEmailVerificationAuthority implements EmailVerificationAuthorityPort {
  public async verifiedEmailEvidence(input: {
    readonly customerId: CustomerId;
    readonly emailNormalized: string;
    readonly correlationId: CorrelationId;
  }) {
    return {
      evidence: {
        customerId: input.customerId,
        emailNormalized: input.emailNormalized,
        provider: "TEST" as const,
        providerEvidenceId: `ks0805-pg-email:${input.correlationId}`,
        verifiedAt: now,
      },
      status: "AUTHORIZED" as const,
    };
  }
}

class TestTransactionBoundary implements TransactionalQueryable {
  public constructor(private readonly database: PostgresTestDatabase) {}

  public query<TResult extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<TResult>> {
    return this.database.query<TResult>(sql, values);
  }

  public async transaction<TResult>(
    callback: (client: Queryable) => Promise<TResult>,
  ): Promise<TResult> {
    if (!connectionString) {
      throw new Error("KEYCORE_TEST_DATABASE_URL is required");
    }
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await client.query(
        `SET search_path TO ${quoteIdentifier(this.database.schemaName)}, public`,
      );
      await client.query("BEGIN");
      const queryable: Queryable = {
        query: async <TRow extends QueryResultRow = QueryResultRow>(
          sql: string,
          values?: readonly unknown[],
        ): Promise<QueryResult<TRow>> =>
          client.query<TRow>(sql, values ? [...values] : undefined),
      };
      const result = await callback(queryable);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  }
}

const required = <TValue>(value: TValue | null | undefined): TValue => {
  if (!value) {
    throw new Error("Expected PostgreSQL guest claim fixture");
  }
  return value;
};
