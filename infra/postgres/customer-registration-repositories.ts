import {
  customerId,
  type CustomerEmailVerificationChallenge,
  type CustomerEmailVerificationPurpose,
  type CustomerRegistrationChallengeRepository,
  type CustomerRegistrationInspection,
  type CustomerId,
  type EmailVerificationState,
  type KeyCoreCustomer,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface ChallengeRow {
  readonly id: string;
  readonly customer_id: string;
  readonly email_normalized_snapshot: string;
  readonly purpose: CustomerEmailVerificationPurpose;
  readonly token_hash: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly revoked_at: Date | null;
  readonly record_version: number;
}

interface CustomerRow {
  readonly id: string;
  readonly email_normalized: string;
  readonly email_verification_state: EmailVerificationState;
  readonly record_version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface InspectionRow {
  readonly customer_id: string;
  readonly email_verification_state: EmailVerificationState;
  readonly active_challenge_count: string;
  readonly last_challenge_created_at: Date | null;
  readonly identity_binding_count: string;
}

export class PostgresCustomerRegistrationChallengeRepository implements CustomerRegistrationChallengeRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async createChallenge(input: {
    readonly challenge: CustomerEmailVerificationChallenge;
    readonly now: Date;
  }): Promise<"CREATED" | "TOKEN_HASH_COLLISION"> {
    return this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 8002))",
        [
          `${input.challenge.customerId}:${input.challenge.purpose}:${input.challenge.emailNormalizedSnapshot}`,
        ],
      );
      await client.query(
        `
          UPDATE customer_email_verification_challenges
          SET revoked_at = $4,
            record_version = record_version + 1
          WHERE customer_id = $1
            AND purpose = $2
            AND email_normalized_snapshot = $3
            AND consumed_at IS NULL
            AND revoked_at IS NULL
        `,
        [
          input.challenge.customerId,
          input.challenge.purpose,
          input.challenge.emailNormalizedSnapshot,
          input.now,
        ],
      );
      const inserted = await client.query<ChallengeRow>(
        `
          INSERT INTO customer_email_verification_challenges(
            id, customer_id, email_normalized_snapshot, purpose, token_hash,
            created_at, expires_at, consumed_at, revoked_at, record_version
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8)
          ON CONFLICT (token_hash) DO NOTHING
          RETURNING ${challengeReturning}
        `,
        [
          input.challenge.id,
          input.challenge.customerId,
          input.challenge.emailNormalizedSnapshot,
          input.challenge.purpose,
          input.challenge.tokenHash,
          input.challenge.createdAt,
          input.challenge.expiresAt,
          input.challenge.recordVersion,
        ],
      );
      return inserted.rows[0] ? "CREATED" : "TOKEN_HASH_COLLISION";
    });
  }

  public async consumeChallenge(input: {
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<
    | {
        readonly status: "CONSUMED";
        readonly challenge: CustomerEmailVerificationChallenge;
        readonly customer: KeyCoreCustomer;
      }
    | { readonly status: "INVALID"; readonly reasonCode: string }
  > {
    return this.db.transaction(async (client) => {
      const locked = await client.query<ChallengeRow>(
        `
          SELECT ${challengeReturning}
          FROM customer_email_verification_challenges
          WHERE token_hash = $1
          FOR UPDATE SKIP LOCKED
        `,
        [input.tokenHash],
      );
      const challenge = locked.rows[0]
        ? challengeFromRow(locked.rows[0])
        : null;
      if (!challenge) {
        return { reasonCode: "TOKEN_NOT_FOUND", status: "INVALID" };
      }
      if (challenge.consumedAt) {
        return { reasonCode: "TOKEN_CONSUMED", status: "INVALID" };
      }
      if (challenge.revokedAt) {
        return { reasonCode: "TOKEN_REVOKED", status: "INVALID" };
      }
      if (challenge.expiresAt.getTime() <= input.now.getTime()) {
        return { reasonCode: "TOKEN_EXPIRED", status: "INVALID" };
      }
      const customer = await findCustomerById(client, challenge.customerId);
      if (!customer) {
        return { reasonCode: "CUSTOMER_NOT_FOUND", status: "INVALID" };
      }
      if (customer.emailNormalized !== challenge.emailNormalizedSnapshot) {
        return { reasonCode: "EMAIL_SNAPSHOT_MISMATCH", status: "INVALID" };
      }
      const consumed = await client.query<ChallengeRow>(
        `
          UPDATE customer_email_verification_challenges
          SET consumed_at = $2,
            record_version = record_version + 1
          WHERE id = $1
            AND consumed_at IS NULL
            AND revoked_at IS NULL
          RETURNING ${challengeReturning}
        `,
        [challenge.id, input.now],
      );
      const row = consumed.rows[0];
      return row
        ? {
            challenge: challengeFromRow(row),
            customer,
            status: "CONSUMED",
          }
        : { reasonCode: "TOKEN_CONSUMED", status: "INVALID" };
    });
  }

  public async inspectCustomerRegistration(
    requestedCustomerId: CustomerId,
  ): Promise<CustomerRegistrationInspection | null> {
    const result = await this.db.query<InspectionRow>(
      `
        SELECT
          c.id::text AS customer_id,
          c.email_verification_state,
          COUNT(ch.id) FILTER (
            WHERE ch.consumed_at IS NULL AND ch.revoked_at IS NULL
          )::text AS active_challenge_count,
          MAX(ch.created_at) AS last_challenge_created_at,
          COUNT(DISTINCT b.id)::text AS identity_binding_count
        FROM keycore_customers c
        LEFT JOIN customer_email_verification_challenges ch
          ON ch.customer_id = c.id
        LEFT JOIN customer_identity_bindings b
          ON b.customer_id = c.id
        WHERE c.id = $1
        GROUP BY c.id, c.email_verification_state
      `,
      [requestedCustomerId],
    );
    const row = result.rows[0];
    return row
      ? {
          activeChallengeCount: Number(row.active_challenge_count),
          customerId: customerId(row.customer_id),
          identityBindingCount: Number(row.identity_binding_count),
          lastChallengeCreatedAt: row.last_challenge_created_at,
          verificationState: row.email_verification_state,
        }
      : null;
  }
}

const challengeReturning = `
  id::text, customer_id::text, email_normalized_snapshot, purpose, token_hash,
  created_at, expires_at, consumed_at, revoked_at, record_version
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
      FOR UPDATE
    `,
    [requestedCustomerId],
  );
  return result.rows[0] ? customerFromRow(result.rows[0]) : null;
};

const challengeFromRow = (
  row: ChallengeRow,
): CustomerEmailVerificationChallenge => ({
  consumedAt: row.consumed_at,
  createdAt: row.created_at,
  customerId: customerId(row.customer_id),
  emailNormalizedSnapshot: row.email_normalized_snapshot,
  expiresAt: row.expires_at,
  id: row.id,
  purpose: row.purpose,
  recordVersion: row.record_version,
  revokedAt: row.revoked_at,
  tokenHash: row.token_hash,
});

const customerFromRow = (row: CustomerRow): KeyCoreCustomer => ({
  createdAt: row.created_at,
  emailNormalized: row.email_normalized,
  emailVerificationState: row.email_verification_state,
  id: customerId(row.id),
  recordVersion: row.record_version,
  updatedAt: row.updated_at,
});
