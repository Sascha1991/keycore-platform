import {
  customerId,
  type CustomerAuthSession,
  type CustomerAuthSessionRepository,
  type CustomerId,
  type CustomerIdentityBinding,
  type CustomerIdentityProvider,
  type CustomerAuthenticationAssurance,
  type KeyCoreCustomer,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface SessionRow {
  readonly id: string;
  readonly customer_id: string;
  readonly identity_binding_id: string;
  readonly provider: CustomerIdentityProvider;
  readonly session_token_hash: string;
  readonly created_at: Date;
  readonly authenticated_at: Date;
  readonly expires_at: Date;
  readonly last_seen_at: Date;
  readonly revoked_at: Date | null;
  readonly record_version: number;
  readonly auth_assurance: CustomerAuthenticationAssurance;
  readonly auth_context_id: string;
}

interface BindingRow {
  readonly id: string;
  readonly customer_id: string;
  readonly provider: CustomerIdentityProvider;
  readonly provider_subject: string;
  readonly created_at: Date;
}

interface CustomerRow {
  readonly id: string;
  readonly email_normalized: string;
  readonly email_verification_state: "UNVERIFIED" | "VERIFIED";
  readonly record_version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresCustomerAuthSessionRepository implements CustomerAuthSessionRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async findIdentityBindingByProviderSubject(input: {
    readonly provider: CustomerIdentityProvider;
    readonly providerSubject: string;
  }): Promise<CustomerIdentityBinding | null> {
    const result = await this.db.query<BindingRow>(
      `
        SELECT ${bindingReturning}
        FROM customer_identity_bindings
        WHERE provider = $1 AND provider_subject = $2
      `,
      [input.provider, input.providerSubject],
    );
    return result.rows[0] ? bindingFromRow(result.rows[0]) : null;
  }

  public findIdentityBindingById(input: {
    readonly identityBindingId: string;
  }): Promise<CustomerIdentityBinding | null> {
    return findBindingById(this.db, input.identityBindingId);
  }

  public async findCustomerById(
    requestedCustomerId: CustomerId,
  ): Promise<KeyCoreCustomer | null> {
    return findCustomerById(this.db, requestedCustomerId);
  }

  public async createSession(input: {
    readonly session: CustomerAuthSession;
  }): Promise<
    | { readonly status: "CREATED"; readonly session: CustomerAuthSession }
    | { readonly status: "TOKEN_HASH_COLLISION" }
    | { readonly status: "CUSTOMER_NOT_FOUND" }
    | { readonly status: "IDENTITY_BINDING_NOT_FOUND" }
  > {
    return this.db.transaction(async (client) => {
      const customer = await findCustomerById(client, input.session.customerId);
      if (!customer) {
        return { status: "CUSTOMER_NOT_FOUND" };
      }
      const binding = await findBindingById(
        client,
        input.session.identityBindingId,
      );
      if (
        !binding ||
        binding.customerId !== input.session.customerId ||
        binding.provider !== input.session.provider
      ) {
        return { status: "IDENTITY_BINDING_NOT_FOUND" };
      }
      const inserted = await client.query<SessionRow>(
        `
          INSERT INTO customer_auth_sessions(
            id, customer_id, identity_binding_id, provider, session_token_hash,
            created_at, authenticated_at, expires_at, last_seen_at, revoked_at,
            record_version, auth_assurance, auth_context_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, $12)
          ON CONFLICT (session_token_hash) DO NOTHING
          RETURNING ${sessionReturning}
        `,
        [
          input.session.id,
          input.session.customerId,
          input.session.identityBindingId,
          input.session.provider,
          input.session.sessionTokenHash,
          input.session.createdAt,
          input.session.authenticatedAt,
          input.session.expiresAt,
          input.session.lastSeenAt,
          input.session.recordVersion,
          input.session.authAssurance,
          input.session.authContextId,
        ],
      );
      return inserted.rows[0]
        ? { session: sessionFromRow(inserted.rows[0]), status: "CREATED" }
        : { status: "TOKEN_HASH_COLLISION" };
    });
  }

  public async findSessionByTokenHash(input: {
    readonly sessionTokenHash: string;
  }): Promise<CustomerAuthSession | null> {
    const result = await this.db.query<SessionRow>(
      `
        SELECT
          s.id::text,
          s.customer_id::text,
          s.identity_binding_id::text,
          s.provider,
          s.session_token_hash,
          s.created_at,
          s.authenticated_at,
          s.expires_at,
          s.last_seen_at,
          s.revoked_at,
          s.record_version,
          s.auth_assurance,
          s.auth_context_id
        FROM customer_auth_sessions s
        JOIN keycore_customers c ON c.id = s.customer_id
        JOIN customer_identity_bindings b
          ON b.id = s.identity_binding_id
         AND b.customer_id = s.customer_id
         AND b.provider = s.provider
        WHERE s.session_token_hash = $1
      `,
      [input.sessionTokenHash],
    );
    return result.rows[0] ? sessionFromRow(result.rows[0]) : null;
  }

  public async touchSession(input: {
    readonly sessionId: string;
    readonly minLastSeenAt: Date;
    readonly now: Date;
  }): Promise<void> {
    await this.db.query(
      `
        UPDATE customer_auth_sessions
        SET last_seen_at = $2,
          record_version = record_version + 1
        WHERE id = $1
          AND revoked_at IS NULL
          AND last_seen_at <= $3
      `,
      [input.sessionId, input.now, input.minLastSeenAt],
    );
  }

  public async rotateSessionToken(input: {
    readonly sessionId: string;
    readonly expectedTokenHash: string;
    readonly nextTokenHash: string;
    readonly now: Date;
  }): Promise<
    | { readonly status: "ROTATED"; readonly session: CustomerAuthSession }
    | { readonly status: "STALE_SESSION" }
    | { readonly status: "TOKEN_HASH_COLLISION" }
  > {
    try {
      const result = await this.db.query<SessionRow>(
        `
          UPDATE customer_auth_sessions
          SET session_token_hash = $3,
            last_seen_at = $4,
            record_version = record_version + 1
          WHERE id = $1
            AND session_token_hash = $2
            AND revoked_at IS NULL
          RETURNING ${sessionReturning}
        `,
        [
          input.sessionId,
          input.expectedTokenHash,
          input.nextTokenHash,
          input.now,
        ],
      );
      return result.rows[0]
        ? { session: sessionFromRow(result.rows[0]), status: "ROTATED" }
        : { status: "STALE_SESSION" };
    } catch (error) {
      if (error instanceof Error && error.message.includes("duplicate key")) {
        return { status: "TOKEN_HASH_COLLISION" };
      }
      throw error;
    }
  }

  public async revokeSessionById(input: {
    readonly sessionId: string;
    readonly now: Date;
  }): Promise<"REVOKED" | "ALREADY_REVOKED" | "NOT_FOUND"> {
    return this.db.transaction(async (client) => {
      const current = await client.query<SessionRow>(
        `
          SELECT ${sessionReturning}
          FROM customer_auth_sessions
          WHERE id = $1
          FOR UPDATE
        `,
        [input.sessionId],
      );
      const row = current.rows[0];
      if (!row) {
        return "NOT_FOUND";
      }
      if (row.revoked_at) {
        return "ALREADY_REVOKED";
      }
      await client.query(
        `
          UPDATE customer_auth_sessions
          SET revoked_at = $2,
            record_version = record_version + 1
          WHERE id = $1
        `,
        [input.sessionId, input.now],
      );
      return "REVOKED";
    });
  }

  public async revokeAllCustomerSessions(input: {
    readonly customerId: CustomerId;
    readonly now: Date;
  }): Promise<{ readonly revokedCount: number }> {
    const result = await this.db.query(
      `
        UPDATE customer_auth_sessions
        SET revoked_at = $2,
          record_version = record_version + 1
        WHERE customer_id = $1
          AND revoked_at IS NULL
      `,
      [input.customerId, input.now],
    );
    return { revokedCount: result.rowCount ?? 0 };
  }

  public async inspectSession(input: {
    readonly sessionId: string;
  }): Promise<CustomerAuthSession | null> {
    const result = await this.db.query<SessionRow>(
      `
        SELECT ${sessionReturning}
        FROM customer_auth_sessions
        WHERE id = $1
      `,
      [input.sessionId],
    );
    return result.rows[0] ? sessionFromRow(result.rows[0]) : null;
  }
}

const sessionReturning = `
  id::text, customer_id::text, identity_binding_id::text, provider,
  session_token_hash, created_at, authenticated_at, expires_at, last_seen_at,
  revoked_at, record_version, auth_assurance, auth_context_id
`;

const bindingReturning = `
  id::text, customer_id::text, provider, provider_subject, created_at
`;

const customerReturning = `
  id::text, email_normalized, email_verification_state, record_version,
  created_at, updated_at
`;

const findCustomerById = async (
  db: Queryable,
  requestedCustomerId: CustomerId,
): Promise<KeyCoreCustomer | null> => {
  const result = await db.query<CustomerRow>(
    `
      SELECT ${customerReturning}
      FROM keycore_customers
      WHERE id = $1
    `,
    [requestedCustomerId],
  );
  return result.rows[0]
    ? {
        createdAt: result.rows[0].created_at,
        emailNormalized: result.rows[0].email_normalized,
        emailVerificationState: result.rows[0].email_verification_state,
        id: customerId(result.rows[0].id),
        recordVersion: result.rows[0].record_version,
        updatedAt: result.rows[0].updated_at,
      }
    : null;
};

const findBindingById = async (
  db: Queryable,
  bindingId: string,
): Promise<CustomerIdentityBinding | null> => {
  const result = await db.query<BindingRow>(
    `
      SELECT ${bindingReturning}
      FROM customer_identity_bindings
      WHERE id = $1
    `,
    [bindingId],
  );
  return result.rows[0] ? bindingFromRow(result.rows[0]) : null;
};

const bindingFromRow = (row: BindingRow): CustomerIdentityBinding => ({
  createdAt: row.created_at,
  customerId: customerId(row.customer_id),
  id: row.id,
  provider: row.provider,
  providerSubject: row.provider_subject,
});

const sessionFromRow = (row: SessionRow): CustomerAuthSession => ({
  authAssurance: row.auth_assurance,
  authContextId: row.auth_context_id,
  authenticatedAt: row.authenticated_at,
  createdAt: row.created_at,
  customerId: customerId(row.customer_id),
  expiresAt: row.expires_at,
  id: row.id,
  identityBindingId: row.identity_binding_id,
  lastSeenAt: row.last_seen_at,
  provider: row.provider,
  recordVersion: row.record_version,
  revokedAt: row.revoked_at,
  sessionTokenHash: row.session_token_hash,
});
