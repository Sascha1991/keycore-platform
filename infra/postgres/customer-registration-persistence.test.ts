import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { InMemoryCustomerRegistrationRateLimitPort } from "../../packages/platform/src/contracts.js";
import {
  CustomerOrderIdentityService,
  CustomerRegistrationService,
  FakeCustomerEmailVerificationDeliveryPort,
  correlationId,
} from "../../packages/platform/src/contracts.js";
import { PostgresCustomerOrderIdentityRepository } from "./customer-order-identity-repositories.js";
import { PostgresCustomerRegistrationChallengeRepository } from "./customer-registration-repositories.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const now = new Date("2026-08-25T12:00:00.000Z");

describePostgres("PostgresCustomerRegistrationChallengeRepository", () => {
  it("persists hash-only challenges, reissues deterministically and consumes once under concurrency", async () => {
    const database = await initDatabase();
    try {
      const boundary = new TestTransactionBoundary(database);
      const identityRepository = new PostgresCustomerOrderIdentityRepository(
        boundary,
      );
      const challengeRepository =
        new PostgresCustomerRegistrationChallengeRepository(boundary);
      const delivery = new FakeCustomerEmailVerificationDeliveryPort();
      const service = serviceFor(
        identityRepository,
        challengeRepository,
        delivery,
      );

      await expect(
        service.register({
          correlationId: correlationId("corr-pg-register-1"),
          email: "pg-register@example.com",
        }),
      ).resolves.toEqual({ status: "REGISTRATION_ACCEPTED" });
      const first = required(delivery.deliveries[0]);
      await expect(
        database.query(
          "SELECT token_hash FROM customer_email_verification_challenges WHERE id = $1",
          [first.challengeId],
        ),
      ).resolves.toMatchObject({
        rows: [expect.objectContaining({ token_hash: expect.any(String) })],
      });
      const persisted = await database.query<{ readonly token_hash: string }>(
        "SELECT token_hash FROM customer_email_verification_challenges WHERE id = $1",
        [first.challengeId],
      );
      expect(required(persisted.rows[0]).token_hash).not.toBe(
        first.rawVerificationToken,
      );

      await service.register({
        correlationId: correlationId("corr-pg-register-2"),
        email: "pg-register@example.com",
      });
      const second = required(delivery.deliveries[1]);
      await expect(
        service.verifyEmail({
          correlationId: correlationId("corr-pg-verify-revoked"),
          rawVerificationToken: first.rawVerificationToken,
        }),
      ).resolves.toEqual({ status: "VERIFICATION_INVALID" });
      const race = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          service.verifyEmail({
            correlationId: correlationId(`corr-pg-verify-${index}`),
            rawVerificationToken: second.rawVerificationToken,
          }),
        ),
      );
      expect(
        race.filter((result) => result.status === "VERIFIED"),
      ).toHaveLength(1);
      expect(
        race.filter((result) => result.status === "VERIFICATION_INVALID"),
      ).toHaveLength(9);
      const inspection = await service.inspectCustomerRegistration({
        customerId: second.customerId,
      });
      expect(inspection).toMatchObject({
        activeChallengeCount: 0,
        identityBindingCount: 0,
        verificationState: "VERIFIED",
      });
    } finally {
      await database.cleanup();
    }
  }, 30_000);
});

const initDatabase = async (): Promise<PostgresTestDatabase> =>
  PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `customer_registration_${randomUUID().replaceAll("-", "_")}`,
  });

const serviceFor = (
  identityRepository: PostgresCustomerOrderIdentityRepository,
  challengeRepository: PostgresCustomerRegistrationChallengeRepository,
  delivery: FakeCustomerEmailVerificationDeliveryPort,
): CustomerRegistrationService => {
  const identityService = new CustomerOrderIdentityService({
    now: () => now,
    repository: identityRepository,
  });
  return new CustomerRegistrationService({
    challengeRepository,
    delivery,
    identityRepository,
    identityService,
    now: () => now,
    rateLimit: new InMemoryCustomerRegistrationRateLimitPort(),
  });
};

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
    throw new Error("Expected PostgreSQL customer registration fixture");
  }
  return value;
};
