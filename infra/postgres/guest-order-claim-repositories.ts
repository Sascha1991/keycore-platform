import {
  customerId,
  orderId,
  type AuthenticatedCustomerPrincipal,
  type EmailVerificationState,
  type GuestOrderClaimChallenge,
  type GuestOrderClaimEvidence,
  type GuestOrderClaimInspection,
  type GuestOrderClaimPurpose,
  type GuestOrderClaimRepository,
  type OrderId,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface ClaimRow {
  readonly id: string;
  readonly order_id: string;
  readonly email_normalized_snapshot: string;
  readonly purpose: GuestOrderClaimPurpose;
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
}

interface OrderRow {
  readonly id: string;
  readonly customer_id: string | null;
  readonly checkout_email_normalized: string | null;
  readonly record_version: number;
  readonly status: string;
  readonly fulfillment_status: string;
}

interface InspectRow {
  readonly order_id: string;
  readonly customer_id: string | null;
  readonly checkout_email_normalized: string | null;
  readonly active_count: string;
  readonly consumed_count: string;
  readonly revoked_count: string;
  readonly expired_count: string;
  readonly last_created_at: Date | null;
}

export class PostgresGuestOrderClaimRepository implements GuestOrderClaimRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async createChallenge(input: {
    readonly challenge: GuestOrderClaimChallenge;
    readonly now: Date;
  }) {
    return this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 8019))",
        [input.challenge.orderId],
      );
      const order = await findOrderForUpdate(client, input.challenge.orderId);
      if (!order) {
        return {
          reasonCode: "ORDER_NOT_FOUND",
          status: "ORDER_NOT_CLAIMABLE" as const,
        };
      }
      if (order.customer_id) {
        return {
          reasonCode: "ORDER_ALREADY_OWNED",
          status: "ORDER_NOT_CLAIMABLE" as const,
        };
      }
      if (
        order.checkout_email_normalized &&
        order.checkout_email_normalized !==
          input.challenge.emailNormalizedSnapshot
      ) {
        return {
          reasonCode: "CHECKOUT_EMAIL_SNAPSHOT_MISMATCH",
          status: "ORDER_NOT_CLAIMABLE" as const,
        };
      }
      if (!order.checkout_email_normalized) {
        return {
          reasonCode: "CHECKOUT_EMAIL_SNAPSHOT_REQUIRED",
          status: "ORDER_NOT_CLAIMABLE" as const,
        };
      }
      await client.query(
        `
          UPDATE guest_order_claim_challenges
          SET revoked_at = $3,
            record_version = record_version + 1
          WHERE order_id = $1
            AND purpose = $2
            AND consumed_at IS NULL
            AND revoked_at IS NULL
        `,
        [input.challenge.orderId, input.challenge.purpose, input.now],
      );
      const inserted = await client.query<ClaimRow>(
        `
          INSERT INTO guest_order_claim_challenges(
            id, order_id, email_normalized_snapshot, purpose, token_hash,
            created_at, expires_at, consumed_at, revoked_at, record_version
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8)
          ON CONFLICT (token_hash) DO NOTHING
          RETURNING ${claimReturning}
        `,
        [
          input.challenge.id,
          input.challenge.orderId,
          input.challenge.emailNormalizedSnapshot,
          input.challenge.purpose,
          input.challenge.tokenHash,
          input.challenge.createdAt,
          input.challenge.expiresAt,
          input.challenge.recordVersion,
        ],
      );
      return inserted.rows[0]
        ? { status: "CREATED" as const }
        : { status: "TOKEN_HASH_COLLISION" as const };
    });
  }

  public async revokeChallenge(input: {
    readonly challengeId: string;
    readonly now: Date;
  }): Promise<"REVOKED" | "ALREADY_INACTIVE" | "NOT_FOUND"> {
    return this.db.transaction(async (client) => {
      const current = await client.query<ClaimRow>(
        `
          SELECT ${claimReturning}
          FROM guest_order_claim_challenges
          WHERE id = $1
          FOR UPDATE
        `,
        [input.challengeId],
      );
      const challenge = current.rows[0] ? claimFromRow(current.rows[0]) : null;
      if (!challenge) {
        return "NOT_FOUND";
      }
      if (challenge.consumedAt || challenge.revokedAt) {
        return "ALREADY_INACTIVE";
      }
      const updated = await client.query<ClaimRow>(
        `
          UPDATE guest_order_claim_challenges
          SET revoked_at = $2,
            record_version = record_version + 1
          WHERE id = $1
            AND consumed_at IS NULL
            AND revoked_at IS NULL
          RETURNING ${claimReturning}
        `,
        [input.challengeId, input.now],
      );
      return updated.rows[0] ? "REVOKED" : "ALREADY_INACTIVE";
    });
  }

  public async consumeClaim(input: {
    readonly tokenHash: string;
    readonly principal: AuthenticatedCustomerPrincipal;
    readonly orderId?: OrderId;
    readonly now: Date;
  }) {
    return this.db.transaction(async (client) => {
      const locked = await client.query<ClaimRow>(
        `
          SELECT ${claimReturning}
          FROM guest_order_claim_challenges
          WHERE token_hash = $1
          FOR UPDATE SKIP LOCKED
        `,
        [input.tokenHash],
      );
      const challenge = locked.rows[0] ? claimFromRow(locked.rows[0]) : null;
      if (!challenge) {
        return { reasonCode: "CLAIM_INVALID", status: "INVALID" as const };
      }
      if (input.orderId !== undefined && input.orderId !== challenge.orderId) {
        return { reasonCode: "CLAIM_INVALID", status: "INVALID" as const };
      }
      if (challenge.consumedAt) {
        return { reasonCode: "CLAIM_CONSUMED", status: "INVALID" as const };
      }
      if (challenge.revokedAt) {
        return { reasonCode: "CLAIM_REVOKED", status: "INVALID" as const };
      }
      if (challenge.expiresAt.getTime() <= input.now.getTime()) {
        return { reasonCode: "CLAIM_EXPIRED", status: "INVALID" as const };
      }
      const customer = await findVerifiedCustomerForUpdate(
        client,
        input.principal.customerId,
      );
      if (
        !customer ||
        customer.email_normalized !== challenge.emailNormalizedSnapshot
      ) {
        return { reasonCode: "CLAIM_INVALID", status: "INVALID" as const };
      }
      const order = await findOrderForUpdate(client, challenge.orderId);
      if (
        !order ||
        order.checkout_email_normalized !== customer.email_normalized
      ) {
        return { reasonCode: "CLAIM_INVALID", status: "INVALID" as const };
      }
      if (order.customer_id && order.customer_id !== customer.id) {
        return { reasonCode: "CLAIM_INVALID", status: "INVALID" as const };
      }
      const consumed = await client.query<ClaimRow>(
        `
          UPDATE guest_order_claim_challenges
          SET consumed_at = $2,
            record_version = record_version + 1
          WHERE id = $1
            AND consumed_at IS NULL
            AND revoked_at IS NULL
          RETURNING ${claimReturning}
        `,
        [challenge.id, input.now],
      );
      const row = consumed.rows[0];
      if (!row) {
        return { reasonCode: "CLAIM_CONSUMED", status: "INVALID" as const };
      }
      return {
        challenge: claimFromRow(row),
        evidence: {
          actorId: "guest-order-claim",
          actorType: "SERVICE",
          customerId: customerId(customer.id),
          expectedOrderVersion: order.record_version,
          orderId: orderId(order.id),
          providerEvidenceId: `guest-order-claim:${challenge.id}`,
        } satisfies GuestOrderClaimEvidence,
        status: "CONSUMED" as const,
      };
    });
  }

  public async inspectOrderClaim(input: {
    readonly orderId: OrderId;
    readonly now: Date;
  }): Promise<GuestOrderClaimInspection | null> {
    const result = await this.db.query<InspectRow>(
      `
        SELECT
          o.id::text AS order_id,
          o.customer_id::text,
          o.checkout_email_normalized,
          COUNT(c.id) FILTER (
            WHERE c.consumed_at IS NULL
              AND c.revoked_at IS NULL
              AND c.expires_at > $2
          )::text AS active_count,
          COUNT(c.id) FILTER (WHERE c.consumed_at IS NOT NULL)::text AS consumed_count,
          COUNT(c.id) FILTER (WHERE c.revoked_at IS NOT NULL)::text AS revoked_count,
          COUNT(c.id) FILTER (
            WHERE c.consumed_at IS NULL
              AND c.revoked_at IS NULL
              AND c.expires_at <= $2
          )::text AS expired_count,
          MAX(c.created_at) AS last_created_at
        FROM keycore_orders o
        LEFT JOIN guest_order_claim_challenges c ON c.order_id = o.id
        WHERE o.id = $1
        GROUP BY o.id, o.customer_id, o.checkout_email_normalized
      `,
      [input.orderId, input.now],
    );
    const row = result.rows[0];
    return row
      ? {
          activeClaimCount: Number(row.active_count),
          claimStateSummary: {
            active: Number(row.active_count),
            consumed: Number(row.consumed_count),
            expired: Number(row.expired_count),
            revoked: Number(row.revoked_count),
          },
          hasCheckoutEmailSnapshot: Boolean(row.checkout_email_normalized),
          isOwned: Boolean(row.customer_id),
          lastClaimCreatedAt: row.last_created_at,
          orderId: orderId(row.order_id),
          ownerCustomerId: row.customer_id ? customerId(row.customer_id) : null,
        }
      : null;
  }
}

const claimReturning = `
  id::text, order_id::text, email_normalized_snapshot, purpose, token_hash,
  created_at, expires_at, consumed_at, revoked_at, record_version
`;

const findOrderForUpdate = async (
  db: Queryable,
  requestedOrderId: OrderId,
): Promise<OrderRow | null> => {
  const result = await db.query<OrderRow>(
    `
      SELECT id::text, customer_id::text, checkout_email_normalized,
        record_version, status, fulfillment_status
      FROM keycore_orders
      WHERE id = $1
      FOR UPDATE
    `,
    [requestedOrderId],
  );
  return result.rows[0] ?? null;
};

const findVerifiedCustomerForUpdate = async (
  db: Queryable,
  requestedCustomerId: string,
): Promise<CustomerRow | null> => {
  const result = await db.query<CustomerRow>(
    `
      SELECT id::text, email_normalized, email_verification_state
      FROM keycore_customers
      WHERE id = $1
        AND email_verification_state = 'VERIFIED'
      FOR UPDATE
    `,
    [requestedCustomerId],
  );
  return result.rows[0] ?? null;
};

const claimFromRow = (row: ClaimRow): GuestOrderClaimChallenge => ({
  consumedAt: row.consumed_at,
  createdAt: row.created_at,
  emailNormalizedSnapshot: row.email_normalized_snapshot,
  expiresAt: row.expires_at,
  id: row.id,
  orderId: orderId(row.order_id),
  purpose: row.purpose,
  recordVersion: row.record_version,
  revokedAt: row.revoked_at,
  tokenHash: row.token_hash,
});
