import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  CustomerAuthenticationService,
  correlationId,
  customerId,
  hashCustomerSessionToken,
  type CustomerAuthenticationAuthorityPort,
  type CustomerId,
  type CustomerIdentityProvider,
  type VerifiedCustomerAuthenticationAssertion,
} from "../../packages/platform/src/contracts.js";
import { PostgresCustomerAuthSessionRepository } from "./customer-authentication-repositories.js";
import type { Queryable, TransactionalQueryable } from "./client.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const now = new Date("2026-08-25T10:00:00.000Z");

describePostgres("PostgresCustomerAuthSessionRepository", () => {
  it("persists hash-only customer sessions and enforces lifecycle operations", async () => {
    const database = await initDatabase();
    try {
      const boundary = new TestTransactionBoundary(database);
      const repository = new PostgresCustomerAuthSessionRepository(boundary);
      const customer = await insertCustomer(database);
      const binding = await insertBinding(database, customer, "pg-subject");
      const service = new CustomerAuthenticationService({
        authority: new FakeAuthenticationAuthority(assertion("pg-subject")),
        now: () => now,
        repository,
      });

      const created = await service.createSession({
        correlationId: correlationId("corr-pg-auth-create"),
      });
      expect(created).toMatchObject({
        customerId: customer,
        status: "CREATED",
      });
      const rawToken = requireToken(created);
      const stored = await database.query<{
        readonly session_token_hash: string;
        readonly identity_binding_id: string;
      }>(
        `
          SELECT session_token_hash, identity_binding_id::text
          FROM customer_auth_sessions
          WHERE id = $1
        `,
        [requireSessionId(created)],
      );
      expect(stored.rows[0]?.session_token_hash).toBe(
        hashCustomerSessionToken(rawToken),
      );
      expect(JSON.stringify(stored.rows)).not.toContain(rawToken);
      expect(stored.rows[0]?.identity_binding_id).toBe(binding);
      await expect(
        repository.findIdentityBindingById({ identityBindingId: binding }),
      ).resolves.toMatchObject({
        customerId: customer,
        id: binding,
        provider: "TEST",
      });

      await expect(
        repository.createSession({
          session: {
            authAssurance: "AUTHENTICATED",
            authContextId: "collision-context",
            authenticatedAt: now,
            createdAt: now,
            customerId: customer,
            expiresAt: new Date(now.getTime() + 60_000),
            id: randomUUID(),
            identityBindingId: binding,
            lastSeenAt: now,
            provider: "TEST",
            recordVersion: 1,
            revokedAt: null,
            sessionTokenHash: hashCustomerSessionToken(rawToken),
          },
        }),
      ).resolves.toEqual({ status: "TOKEN_HASH_COLLISION" });
      await expect(
        repository.createSession({
          session: {
            authAssurance: "AUTHENTICATED",
            authContextId: "provider-mismatch-context",
            authenticatedAt: now,
            createdAt: now,
            customerId: customer,
            expiresAt: new Date(now.getTime() + 60_000),
            id: randomUUID(),
            identityBindingId: binding,
            lastSeenAt: now,
            provider: "WOOCOMMERCE",
            recordVersion: 1,
            revokedAt: null,
            sessionTokenHash: hashCustomerSessionToken(
              "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            ),
          },
        }),
      ).resolves.toEqual({ status: "IDENTITY_BINDING_NOT_FOUND" });
      await expect(
        database.query(
          `
            UPDATE customer_identity_bindings
            SET provider = 'WOOCOMMERCE'
            WHERE id = $1
          `,
          [binding],
        ),
      ).rejects.toThrow();

      await expect(
        service.resolveSession({
          correlationId: correlationId("corr-pg-auth-resolve"),
          rawSessionToken: rawToken,
        }),
      ).resolves.toMatchObject({ status: "AUTHENTICATED" });

      const rotated = await service.rotateSession({
        correlationId: correlationId("corr-pg-auth-rotate"),
        rawSessionToken: rawToken,
      });
      expect(rotated).toMatchObject({ status: "ROTATED" });
      await expect(
        service.resolveSession({
          correlationId: correlationId("corr-pg-auth-old"),
          rawSessionToken: rawToken,
        }),
      ).resolves.toEqual({ reasonCode: "SESSION_INVALID", status: "INVALID" });

      const nextToken =
        rotated.status === "ROTATED" ? rotated.rawSessionToken : "";
      await expect(
        service.revokeSession({
          correlationId: correlationId("corr-pg-auth-revoke"),
          rawSessionToken: nextToken,
        }),
      ).resolves.toEqual({ status: "REVOKED" });
      await expect(
        service.resolveSession({
          correlationId: correlationId("corr-pg-auth-revoked"),
          rawSessionToken: nextToken,
        }),
      ).resolves.toEqual({ reasonCode: "SESSION_REVOKED", status: "REVOKED" });
    } finally {
      await database.cleanup();
    }
  }, 30_000);

  it("rejects invalid database session invariants", async () => {
    const database = await initDatabase();
    try {
      const customer = await insertCustomer(database);
      const binding = await insertBinding(database, customer, "pg-invalid");
      await expect(
        database.query(
          `
            INSERT INTO customer_auth_sessions(
              id, customer_id, identity_binding_id, provider,
              session_token_hash, created_at, authenticated_at, expires_at,
              last_seen_at, record_version, auth_assurance, auth_context_id
            )
            VALUES (
              $1, $2, $3, 'TEST', $4, $5, $5, $5, $5, 1,
              'AUTHENTICATED', 'invalid-context'
            )
          `,
          [randomUUID(), customer, binding, "not-a-sha256-hash", now],
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
    schemaName: `customer_auth_${randomUUID().replaceAll("-", "_")}`,
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

const insertCustomer = async (
  database: PostgresTestDatabase,
): Promise<CustomerId> => {
  const id = customerId(randomUUID());
  await database.query(
    `
      INSERT INTO keycore_customers(
        id, email_normalized, email_verification_state, record_version,
        created_at, updated_at
      )
      VALUES ($1, $2, 'VERIFIED', 1, $3, $3)
    `,
    [id, `${id}@example.com`, now],
  );
  return id;
};

const insertBinding = async (
  database: PostgresTestDatabase,
  targetCustomerId: CustomerId,
  providerSubject: string,
): Promise<string> => {
  const result = await database.query<{ readonly id: string }>(
    `
      INSERT INTO customer_identity_bindings(
        id, customer_id, provider, provider_subject, created_at
      )
      VALUES ($1, $2, 'TEST', $3, $4)
      RETURNING id::text
    `,
    [randomUUID(), targetCustomerId, providerSubject, now],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Expected identity binding fixture");
  }
  return row.id;
};

const assertion = (
  providerSubject: string,
  provider: CustomerIdentityProvider = "TEST",
): VerifiedCustomerAuthenticationAssertion => ({
  assurance: "AUTHENTICATED",
  authContextId: "pg-auth-context",
  authenticatedAt: now,
  expiresAt: new Date(now.getTime() + 28_800_000),
  provider,
  providerSubject,
});

class FakeAuthenticationAuthority implements CustomerAuthenticationAuthorityPort {
  public constructor(
    private readonly authAssertion: VerifiedCustomerAuthenticationAssertion,
  ) {}

  public async verifiedAuthenticationAssertion() {
    return { assertion: this.authAssertion, status: "AUTHORIZED" as const };
  }
}

const requireToken = (
  result: Awaited<ReturnType<CustomerAuthenticationService["createSession"]>>,
): string => {
  if (result.status !== "CREATED") {
    throw new Error("Expected created auth fixture");
  }
  return result.rawSessionToken;
};

const requireSessionId = (
  result: Awaited<ReturnType<CustomerAuthenticationService["createSession"]>>,
): string => {
  if (result.status !== "CREATED") {
    throw new Error("Expected created auth fixture");
  }
  return result.sessionId;
};
