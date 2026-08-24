import {
  currency,
  money,
  orderId,
  type KeyCoreOrder,
  type OrderId,
} from "../../packages/platform/src/contracts.js";
import type {
  PaymentProvider,
  PaymentCreationLeaseResult,
  PaymentRecord,
  PaymentRepository,
  PaymentReservationResult,
  PaymentStatus,
  PaymentUpdateResult,
} from "../../packages/platform/src/payments/stripe-payments.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface PaymentRow {
  readonly id: string;
  readonly order_id: string;
  readonly provider: PaymentProvider;
  readonly external_payment_id: string | null;
  readonly amount_minor: string;
  readonly currency: string;
  readonly status: PaymentStatus;
  readonly record_version: number;
  readonly operation_version: number;
  readonly stripe_idempotency_key: string;
  readonly provider_fingerprint: string | null;
  readonly reconciliation_required: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly last_provider_event_at: Date | null;
  readonly create_attempt_token: string | null;
  readonly create_attempt_started_at: Date | null;
}

export class PostgresPaymentRepository implements PaymentRepository {
  public constructor(private readonly db: TransactionalQueryable) {}

  public async reserveForOrder(input: {
    readonly order: KeyCoreOrder;
    readonly stripeIdempotencyKey: string;
    readonly now: Date;
  }): Promise<PaymentReservationResult> {
    return this.db.transaction(async (client) => {
      await lockOrderPayment(client, input.order.id);
      const existing = await findByOrder(client, {
        orderId: input.order.id,
        provider: "STRIPE",
      });
      if (existing) {
        return { payment: existing, status: "EXISTING" };
      }
      const inserted = await client.query<PaymentRow>(
        `
          INSERT INTO order_payments(
            order_id, provider, amount_minor, currency, status,
            record_version, operation_version, stripe_idempotency_key,
            reconciliation_required, created_at, updated_at
          )
          VALUES ($1, 'STRIPE', $2, $3, 'CREATION_PENDING', 1, 1, $4, false, $5, $5)
          RETURNING ${paymentReturning}
        `,
        [
          input.order.id,
          input.order.customerAmount.amountMinor.toString(),
          input.order.currency,
          input.stripeIdempotencyKey,
          input.now,
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        throw new Error("Expected PostgreSQL payment insert to return one row");
      }
      return { payment: paymentFromRow(row), status: "CREATED" };
    });
  }

  public async findByOrder(input: {
    readonly orderId: OrderId;
    readonly provider: PaymentProvider;
  }): Promise<PaymentRecord | null> {
    return findByOrder(this.db, input);
  }

  public async findByExternalPaymentId(input: {
    readonly provider: PaymentProvider;
    readonly externalPaymentId: string;
  }): Promise<PaymentRecord | null> {
    const result = await this.db.query<PaymentRow>(
      `
        SELECT ${paymentReturning}
        FROM order_payments
        WHERE provider = $1 AND external_payment_id = $2
      `,
      [input.provider, input.externalPaymentId],
    );
    const row = result.rows[0];
    return row ? paymentFromRow(row) : null;
  }

  public async acquireCreateLease(input: {
    readonly paymentId: string;
    readonly leaseToken: string;
    readonly staleAfter: Date;
    readonly now: Date;
  }): Promise<PaymentCreationLeaseResult> {
    const updated = await this.db.query<PaymentRow>(
      `
        UPDATE order_payments
        SET create_attempt_token = $2,
          create_attempt_started_at = $3,
          record_version = record_version + 1,
          updated_at = $3
        WHERE id = $1
          AND external_payment_id IS NULL
          AND status IN ('CREATION_PENDING', 'CREATE_OUTCOME_UNKNOWN')
          AND (
            create_attempt_token IS NULL
            OR create_attempt_started_at <= $4
          )
        RETURNING ${paymentReturning}
      `,
      [input.paymentId, input.leaseToken, input.now, input.staleAfter],
    );
    const row = updated.rows[0];
    if (row) {
      return {
        leaseToken: input.leaseToken,
        payment: paymentFromRow(row),
        status: "ACQUIRED",
      };
    }
    const current = await findById(this.db, input.paymentId);
    if (!current) {
      throw new Error("Payment not found");
    }
    return {
      payment: current,
      status: isCreateLeaseEligible(current) ? "IN_FLIGHT" : "NOT_ELIGIBLE",
    };
  }

  public async markProviderCreated(input: {
    readonly paymentId: string;
    readonly leaseToken: string;
    readonly externalPaymentId: string;
    readonly providerFingerprint: string;
    readonly status: PaymentStatus;
    readonly lastProviderEventAt: Date;
    readonly now: Date;
  }): Promise<PaymentUpdateResult> {
    const updated = await this.db.query<PaymentRow>(
      `
        UPDATE order_payments
        SET external_payment_id = $3,
          provider_fingerprint = $4,
          status = $5,
          last_provider_event_at = $6,
          create_attempt_token = NULL,
          create_attempt_started_at = NULL,
          reconciliation_required = false,
          record_version = record_version + 1,
          updated_at = $7
        WHERE id = $1
          AND create_attempt_token = $2
          AND (
            external_payment_id IS NULL
            OR external_payment_id = $3
          )
        RETURNING ${paymentReturning}
      `,
      [
        input.paymentId,
        input.leaseToken,
        input.externalPaymentId,
        input.providerFingerprint,
        input.status,
        input.lastProviderEventAt,
        input.now,
      ],
    );
    const row = updated.rows[0];
    if (row) {
      return { payment: paymentFromRow(row), status: "UPDATED" };
    }
    return {
      payment: await findById(this.db, input.paymentId),
      status: "CONFLICT",
    };
  }

  public async updateFromProvider(input: {
    readonly paymentId: string;
    readonly expectedVersion: number;
    readonly providerFingerprint: string;
    readonly status: PaymentStatus;
    readonly lastProviderEventAt: Date;
    readonly reconciliationRequired: boolean;
    readonly now: Date;
  }): Promise<PaymentUpdateResult> {
    const current = await findById(this.db, input.paymentId);
    if (!current || current.recordVersion !== input.expectedVersion) {
      return { payment: current, status: "CONFLICT" };
    }
    if (isNonRegressingNoop(current, input.status, input.lastProviderEventAt)) {
      return { payment: current, status: "NOOP" };
    }
    const updated = await this.db.query<PaymentRow>(
      `
        UPDATE order_payments
        SET provider_fingerprint = $3,
          status = $4,
          last_provider_event_at = $5,
          reconciliation_required = $6,
          record_version = record_version + 1,
          updated_at = $7
        WHERE id = $1 AND record_version = $2
        RETURNING ${paymentReturning}
      `,
      [
        input.paymentId,
        input.expectedVersion,
        input.providerFingerprint,
        input.status,
        input.lastProviderEventAt,
        input.reconciliationRequired,
        input.now,
      ],
    );
    const row = updated.rows[0];
    return row
      ? { payment: paymentFromRow(row), status: "UPDATED" }
      : {
          payment: await findById(this.db, input.paymentId),
          status: "CONFLICT",
        };
  }

  public async markCreateOutcomeUnknown(input: {
    readonly paymentId: string;
    readonly leaseToken: string;
    readonly now: Date;
  }): Promise<PaymentUpdateResult> {
    const updated = await this.db.query<PaymentRow>(
      `
        UPDATE order_payments
        SET status = 'CREATE_OUTCOME_UNKNOWN',
          reconciliation_required = true,
          create_attempt_token = NULL,
          create_attempt_started_at = NULL,
          record_version = record_version + 1,
          updated_at = $3
        WHERE id = $1 AND create_attempt_token = $2
        RETURNING ${paymentReturning}
      `,
      [input.paymentId, input.leaseToken, input.now],
    );
    const row = updated.rows[0];
    return row
      ? { payment: paymentFromRow(row), status: "UPDATED" }
      : {
          payment: await findById(this.db, input.paymentId),
          status: "CONFLICT",
        };
  }

  public async markCreateRejected(input: {
    readonly paymentId: string;
    readonly leaseToken: string;
    readonly providerFingerprint: string;
    readonly now: Date;
  }): Promise<PaymentUpdateResult> {
    const updated = await this.db.query<PaymentRow>(
      `
        UPDATE order_payments
        SET status = 'FAILED',
          provider_fingerprint = $3,
          reconciliation_required = false,
          create_attempt_token = NULL,
          create_attempt_started_at = NULL,
          record_version = record_version + 1,
          updated_at = $4
        WHERE id = $1 AND create_attempt_token = $2
        RETURNING ${paymentReturning}
      `,
      [input.paymentId, input.leaseToken, input.providerFingerprint, input.now],
    );
    const row = updated.rows[0];
    return row
      ? { payment: paymentFromRow(row), status: "UPDATED" }
      : {
          payment: await findById(this.db, input.paymentId),
          status: "CONFLICT",
        };
  }

  public async markReconciliationRequired(input: {
    readonly paymentId: string;
    readonly expectedVersion: number;
    readonly providerFingerprint?: string;
    readonly now: Date;
  }): Promise<PaymentUpdateResult> {
    const updated = await this.db.query<PaymentRow>(
      `
        UPDATE order_payments
        SET provider_fingerprint = COALESCE($3, provider_fingerprint),
          status = 'RECONCILIATION_REQUIRED',
          reconciliation_required = true,
          create_attempt_token = NULL,
          create_attempt_started_at = NULL,
          record_version = record_version + 1,
          updated_at = $4
        WHERE id = $1 AND record_version = $2
        RETURNING ${paymentReturning}
      `,
      [
        input.paymentId,
        input.expectedVersion,
        input.providerFingerprint ?? null,
        input.now,
      ],
    );
    const row = updated.rows[0];
    return row
      ? { payment: paymentFromRow(row), status: "UPDATED" }
      : {
          payment: await findById(this.db, input.paymentId),
          status: "CONFLICT",
        };
  }
}

const paymentReturning = `
  id::text, order_id::text, provider, external_payment_id, amount_minor::text,
  currency, status, record_version, operation_version, stripe_idempotency_key,
  provider_fingerprint, reconciliation_required, created_at, updated_at,
  last_provider_event_at, create_attempt_token, create_attempt_started_at
`;

const findById = async (
  db: Queryable,
  paymentId: string,
): Promise<PaymentRecord | null> => {
  const result = await db.query<PaymentRow>(
    `
      SELECT ${paymentReturning}
      FROM order_payments
      WHERE id = $1
    `,
    [paymentId],
  );
  const row = result.rows[0];
  return row ? paymentFromRow(row) : null;
};

const findByOrder = async (
  db: Queryable,
  input: { readonly orderId: OrderId; readonly provider: PaymentProvider },
): Promise<PaymentRecord | null> => {
  const result = await db.query<PaymentRow>(
    `
      SELECT ${paymentReturning}
      FROM order_payments
      WHERE order_id = $1 AND provider = $2
    `,
    [input.orderId, input.provider],
  );
  const row = result.rows[0];
  return row ? paymentFromRow(row) : null;
};

const lockOrderPayment = async (
  db: Queryable,
  requestedOrderId: OrderId,
): Promise<void> => {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7002))", [
    requestedOrderId,
  ]);
};

const paymentFromRow = (row: PaymentRow): PaymentRecord => ({
  amount: money(BigInt(row.amount_minor), currency(row.currency)),
  createdAt: row.created_at,
  createAttemptStartedAt: row.create_attempt_started_at,
  createAttemptToken: row.create_attempt_token,
  currency: currency(row.currency),
  externalPaymentId: row.external_payment_id,
  id: row.id,
  lastProviderEventAt: row.last_provider_event_at,
  operationVersion: row.operation_version,
  orderId: orderId(row.order_id),
  provider: row.provider,
  providerFingerprint: row.provider_fingerprint,
  reconciliationRequired: row.reconciliation_required,
  recordVersion: row.record_version,
  status: row.status,
  stripeIdempotencyKey: row.stripe_idempotency_key,
  updatedAt: row.updated_at,
});

const isCreateLeaseEligible = (payment: PaymentRecord): boolean =>
  !payment.externalPaymentId &&
  (payment.status === "CREATION_PENDING" ||
    payment.status === "CREATE_OUTCOME_UNKNOWN");

const isNonRegressingNoop = (
  current: PaymentRecord,
  nextStatus: PaymentStatus,
  providerEventAt: Date,
): boolean =>
  current.status === "CAPTURED" && nextStatus !== "CAPTURED"
    ? true
    : Boolean(
        current.lastProviderEventAt &&
        current.lastProviderEventAt.getTime() > providerEventAt.getTime(),
      );
