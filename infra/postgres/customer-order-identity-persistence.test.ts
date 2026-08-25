import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  CustomerOrderIdentityService,
  PersistedCustomerOrderAuthorizationPort,
  StaticAuthenticatedCustomerPrincipalProvider,
  correlationId,
  orderId,
  productId,
  type CorrelationId,
  type CustomerId,
  type CustomerIdentityBindingAuthorityPort,
  type EmailVerificationAuthorityPort,
  type OrderId,
  type OrderOwnershipBindingAuthorityPort,
} from "../../packages/platform/src/contracts.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";
import { PostgresCustomerOrderIdentityRepository } from "./customer-order-identity-repositories.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const now = new Date("2026-08-25T00:00:00.000Z");

describePostgres("PostgresCustomerOrderIdentityRepository", () => {
  it("persists trusted verification, binding, ownership and fail-closed delivery authorization", async () => {
    const database = await initDatabase();
    try {
      const boundary = new TestTransactionBoundary(database);
      const repository = new PostgresCustomerOrderIdentityRepository(boundary);
      const service = serviceFor(repository, "subject-1");
      const product = await insertProduct(database);
      const targetOrder = await insertOrder(
        database,
        product,
        await insertPriceLock(database, product),
        {
          fulfillmentStatus: "PENDING",
          procurementStatus: "SUCCEEDED",
          status: "FULFILLMENT_PENDING",
        },
      );
      const otherOrder = await insertOrder(
        database,
        product,
        await insertPriceLock(database, product),
        {
          fulfillmentStatus: "PENDING",
          procurementStatus: "SUCCEEDED",
          status: "FULFILLMENT_PENDING",
        },
      );

      const race = await Promise.all(
        Array.from({ length: 5 }, () =>
          service.createCustomer({
            correlationId: correlationId("corr-pg-owner"),
            email: "Owner@Example.COM",
          }),
        ),
      );
      expect(race.filter((result) => result.status === "CREATED")).toHaveLength(
        1,
      );
      expect(
        race.filter((result) => result.status === "EXISTING"),
      ).toHaveLength(4);
      const owner = requiredCustomer(required(race[0]));
      await expect(repository.findCustomerById(owner)).resolves.toMatchObject({
        emailVerificationState: "UNVERIFIED",
      });

      await expect(
        service.markEmailVerified({
          correlationId: correlationId("corr-pg-owner"),
          customerId: owner,
          expectedCustomerVersion: 0,
        }),
      ).resolves.toMatchObject({ status: "STALE_WRITER" });
      await expect(
        service.markEmailVerified({
          correlationId: correlationId("corr-pg-owner"),
          customerId: owner,
          expectedCustomerVersion: 1,
        }),
      ).resolves.toMatchObject({
        customer: { emailVerificationState: "VERIFIED", recordVersion: 2 },
        status: "VERIFIED",
      });
      await expect(
        new CustomerOrderIdentityService({
          now: () => now,
          repository,
        }).markEmailVerified({
          correlationId: correlationId("corr-pg-owner-denied"),
          customerId: owner,
          expectedCustomerVersion: 2,
        }),
      ).resolves.toEqual({ status: "UNTRUSTED_AUTHORITY" });

      const otherCustomer = requiredCustomer(
        await service.createCustomer({
          correlationId: correlationId("corr-pg-other"),
          email: "other@example.com",
        }),
      );
      await service.markEmailVerified({
        correlationId: correlationId("corr-pg-other"),
        customerId: otherCustomer,
        expectedCustomerVersion: 1,
      });
      await expect(
        repository.bindIdentity({
          binding: {
            createdAt: now,
            customerId: "00000000-0000-4000-8000-000000000001" as CustomerId,
            id: randomUUID(),
            provider: "TEST",
            providerSubject: "missing-customer",
          },
        }),
      ).resolves.toEqual({ status: "CUSTOMER_NOT_FOUND" });
      await expect(
        new CustomerOrderIdentityService({
          now: () => now,
          repository,
        }).bindIdentity({
          correlationId: correlationId("corr-pg-bind-denied"),
          customerId: owner,
        }),
      ).resolves.toEqual({ status: "UNTRUSTED_AUTHORITY" });
      const sameBindingRace = await Promise.all(
        Array.from({ length: 5 }, () =>
          service.bindIdentity({
            correlationId: correlationId("corr-pg-bind-id"),
            customerId: owner,
          }),
        ),
      );
      expect(
        sameBindingRace.filter((result) => result.status === "BOUND"),
      ).toHaveLength(1);
      expect(
        sameBindingRace.filter((result) => result.status === "ALREADY_BOUND"),
      ).toHaveLength(4);
      await expect(
        service.bindIdentity({
          correlationId: correlationId("corr-pg-bind-conflict"),
          customerId: otherCustomer,
        }),
      ).resolves.toEqual({ status: "IDENTITY_CONFLICT" });

      await expect(
        new CustomerOrderIdentityService({
          identityBindingAuthority: new FakeIdentityBindingAuthority(
            " bad-subject",
          ),
          now: () => now,
          repository,
        }).bindIdentity({
          correlationId: correlationId("corr-pg-bind-invalid"),
          customerId: otherCustomer,
        }),
      ).resolves.toEqual({ status: "INVALID_PROVIDER_SUBJECT" });

      await expect(
        new CustomerOrderIdentityService({
          now: () => now,
          repository,
        }).bindOrderOwnership({
          correlationId: correlationId("corr-pg-owner-bind-denied"),
          customerId: owner,
          expectedOrderVersion: 1,
          orderId: targetOrder,
        }),
      ).resolves.toEqual({ status: "UNTRUSTED_AUTHORITY" });
      await expect(
        service.bindOrderOwnership({
          correlationId: correlationId("corr-pg-owner-bind"),
          customerId: owner,
          expectedOrderVersion: 0,
          orderId: targetOrder,
        }),
      ).resolves.toMatchObject({ status: "STALE_WRITER" });
      await expect(
        service.bindOrderOwnership({
          correlationId: correlationId("corr-pg-owner-bind"),
          customerId: owner,
          expectedOrderVersion: 1,
          orderId: targetOrder,
        }),
      ).resolves.toMatchObject({ status: "BOUND" });
      await expect(
        service.bindOrderOwnership({
          correlationId: correlationId("corr-pg-owner-bind"),
          customerId: otherCustomer,
          expectedOrderVersion: 2,
          orderId: targetOrder,
        }),
      ).resolves.toMatchObject({ status: "OWNERSHIP_CONFLICT" });
      await expect(
        database.query(
          "UPDATE keycore_orders SET customer_id = $2 WHERE id = $1",
          [targetOrder, otherCustomer],
        ),
      ).rejects.toThrow("customer ownership is immutable");

      const fulfillmentId = await insertReadyFulfillment(database, targetOrder);
      const legacyFulfillmentId = await insertReadyFulfillment(database, null);
      const wrongOrderFulfillmentId = await insertReadyFulfillment(
        database,
        otherOrder,
      );
      const auth = authorization(repository, owner);

      await expect(
        auth.authorizeDelivery(authz(owner, targetOrder, fulfillmentId)),
      ).resolves.toEqual({ status: "AUTHORIZED" });
      await expect(
        auth.authorizeDelivery(authz(owner, targetOrder, legacyFulfillmentId)),
      ).resolves.toEqual({ status: "DENIED" });
      await expect(
        auth.authorizeDelivery(
          authz(owner, targetOrder, wrongOrderFulfillmentId),
        ),
      ).resolves.toEqual({ status: "DENIED" });
      await expect(
        authorization(repository, otherCustomer).authorizeDelivery(
          authz(owner, targetOrder, fulfillmentId),
        ),
      ).resolves.toEqual({ status: "DENIED" });
      await expect(
        authorization(repository, owner, "TEST").authorizeDelivery(
          authz(owner, targetOrder, fulfillmentId),
        ),
      ).resolves.toEqual({ status: "DENIED" });
      await expect(
        service.bindOrderOwnership({
          correlationId: correlationId("corr-pg-owner-bind"),
          customerId: owner,
          expectedOrderVersion: 2,
          orderId: targetOrder,
        }),
      ).resolves.toMatchObject({ status: "ALREADY_BOUND" });
    } finally {
      await database.cleanup();
    }
  }, 30_000);
});

const initDatabase = async (): Promise<PostgresTestDatabase> =>
  PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `customer_identity_${randomUUID().replaceAll("-", "_")}`,
  });

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

const serviceFor = (
  repository: PostgresCustomerOrderIdentityRepository,
  providerSubject: string,
): CustomerOrderIdentityService =>
  new CustomerOrderIdentityService({
    emailVerificationAuthority: new FakeEmailVerificationAuthority(),
    identityBindingAuthority: new FakeIdentityBindingAuthority(providerSubject),
    now: () => now,
    orderOwnershipAuthority: new FakeOrderOwnershipAuthority(),
    repository,
  });

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
        providerEvidenceId: `email-evidence:${input.correlationId}`,
        verifiedAt: now,
      },
      status: "AUTHORIZED" as const,
    };
  }
}

class FakeIdentityBindingAuthority implements CustomerIdentityBindingAuthorityPort {
  public constructor(private readonly providerSubject: string) {}

  public async verifiedIdentitySubject(input: {
    readonly customerId: CustomerId;
    readonly correlationId: CorrelationId;
  }) {
    return {
      provider: "TEST" as const,
      providerEvidenceId: `identity-evidence:${input.customerId}:${input.correlationId}`,
      providerSubject: this.providerSubject,
      status: "AUTHORIZED" as const,
    };
  }
}

class FakeOrderOwnershipAuthority implements OrderOwnershipBindingAuthorityPort {
  public async verifiedOrderOwnership(input: {
    readonly orderId: OrderId;
    readonly customerId: CustomerId;
    readonly correlationId: CorrelationId;
  }) {
    return {
      actorId: "checkout-service",
      actorType: "SERVICE" as const,
      providerEvidenceId: `ownership-evidence:${input.customerId}:${input.orderId}:${input.correlationId}`,
      status: "AUTHORIZED" as const,
    };
  }
}

const insertProduct = async (
  database: PostgresTestDatabase,
): Promise<ReturnType<typeof productId>> => {
  const result = await database.query<{ readonly id: string }>(
    `
      INSERT INTO products(product_type, title, platform, lifecycle, active, canonical_metadata_confidence)
      VALUES ('GAME', 'Customer Identity Fixture', 'WINDOWS', 'IN_STOCK', true, 'HIGH')
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
      "corr-pg-customer-identity",
      now,
      new Date(now.getTime() + 60_000),
    ],
  );
  return id;
};

const insertOrder = async (
  database: PostgresTestDatabase,
  targetProductId: ReturnType<typeof productId>,
  lockId: string,
  state: {
    readonly status: string;
    readonly procurementStatus: string;
    readonly fulfillmentStatus: string;
  },
): Promise<OrderId> => {
  const id = orderId(randomUUID());
  await database.query(
    `
      INSERT INTO keycore_orders(
        id, product_id, price_lock_id, customer_amount_minor, currency,
        quantity, status, payment_status, procurement_status,
        fulfillment_status, risk_status, refund_status, record_version,
        idempotency_key, idempotency_fingerprint, correlation_id,
        created_at, updated_at
      )
      VALUES (
        $1, $2, $3, 1300, 'EUR', 1, $4, 'CAPTURED', $5, $6,
        'APPROVED', 'NOT_REQUESTED', 1, $7, $8, $9, $10, $10
      )
    `,
    [
      id,
      targetProductId,
      lockId,
      state.status,
      state.procurementStatus,
      state.fulfillmentStatus,
      `order-idem-${id}`,
      `order-fingerprint-${id}`,
      "corr-pg-customer-identity",
      now,
    ],
  );
  return id;
};

const insertReadyFulfillment = async (
  database: PostgresTestDatabase,
  linkedOrderId: OrderId | null,
): Promise<string> => {
  const fulfillmentId = randomUUID();
  await database.query(
    `
      INSERT INTO fulfillment_operations(
        id, order_id, supplier_id, external_supplier_order_id,
        expected_quantity, status, retrieval_state, delivery_state,
        encrypted_secret_id, record_version, correlation_id, created_at,
        updated_at, retrieved_at
      )
      VALUES (
        $1, $2, 'supplier-test', $3, 1, 'DELIVERY_PENDING', 'RETRIEVED',
        'PENDING', NULL, 1, 'corr-pg-customer-identity', $4, $4, $4
      )
    `,
    [fulfillmentId, linkedOrderId, `external-${fulfillmentId}`, now],
  );
  const secret = await database.query<{ readonly id: string }>(
    `
      INSERT INTO fulfillment_secrets(
        fulfillment_id, ciphertext, encryption_nonce, encryption_tag,
        wrapped_data_encryption_key, encryption_key_id, encryption_version,
        encryption_algorithm, created_at
      )
      VALUES (
        $1, decode('abcdef', 'hex'), decode('000000000000000000000000', 'hex'),
        decode('00000000000000000000000000000000', 'hex'),
        decode('abcdef', 'hex'), 'test-key-id', 1, 'AES-256-GCM-v1', $2
      )
      RETURNING id::text
    `,
    [fulfillmentId, now],
  );
  await database.query(
    "UPDATE fulfillment_operations SET encrypted_secret_id = $2 WHERE id = $1",
    [fulfillmentId, required(secret.rows[0]).id],
  );
  return fulfillmentId;
};

const authorization = (
  repository: PostgresCustomerOrderIdentityRepository,
  principalCustomerId: CustomerId,
  assurance: "AUTHENTICATED" | "TEST" = "AUTHENTICATED",
): PersistedCustomerOrderAuthorizationPort =>
  new PersistedCustomerOrderAuthorizationPort({
    principalProvider: new StaticAuthenticatedCustomerPrincipalProvider({
      authenticationContext: { assurance, provider: "TEST" },
      customerId: principalCustomerId,
    }),
    repository,
  });

const authz = (
  requestedCustomerId: CustomerId,
  requestedOrderId: OrderId,
  fulfillmentId: string,
) => ({
  customerId: requestedCustomerId,
  expiresAt: new Date(now.getTime() + 60_000),
  fulfillmentId,
  issuedAt: now,
  orderId: requestedOrderId,
  purpose: "customer-key-delivery" as const,
  version: 1 as const,
});

const requiredCustomer = (
  result: Awaited<ReturnType<CustomerOrderIdentityService["createCustomer"]>>,
): CustomerId => {
  if (!("customer" in result)) {
    throw new Error("Expected customer test fixture");
  }
  return result.customer.id;
};

const required = <TValue>(value: TValue | undefined): TValue => {
  if (!value) {
    throw new Error("Expected PostgreSQL customer identity fixture");
  }
  return value;
};
