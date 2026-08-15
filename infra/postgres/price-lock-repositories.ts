import {
  currency,
  money,
  productId,
  type Money,
} from "../../packages/platform/src/contracts.js";
import type {
  PriceLock,
  PriceLockCreatePersistenceResult,
  PriceLockReasonCode,
  PriceLockRepository,
  PriceLockStatus,
  PriceLockStatusUpdateResult,
} from "../../packages/platform/src/pricing/price-locks.js";
import type { CorrelationId } from "../../packages/platform/src/domain/identifiers.js";
import type { Queryable } from "./client.js";

interface PriceLockRow {
  readonly id: string;
  readonly product_id: string;
  readonly currency: string;
  readonly locked_sell_price_minor: string;
  readonly pricing_quote_fingerprint: string;
  readonly source_fingerprint: string;
  readonly pricing_policy_version: string;
  readonly pricing_policy_record_version: number;
  readonly product_override_version: number | null;
  readonly manual_price_version: number | null;
  readonly tax_policy_version: string;
  readonly fee_policy_version: string;
  readonly fx_rate_version: string | null;
  readonly status: PriceLockStatus;
  readonly record_version: number;
  readonly idempotency_key: string | null;
  readonly idempotency_fingerprint: string | null;
  readonly correlation_id: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly invalidated_at: Date | null;
  readonly reason_code: PriceLockReasonCode | null;
}

export class PostgresPriceLockRepository implements PriceLockRepository {
  public constructor(private readonly db: Queryable) {}

  public async create(lock: PriceLock): Promise<PriceLock> {
    const row = await queryOne<PriceLockRow>(
      this.db,
      `
        INSERT INTO price_locks(
          id, product_id, currency, locked_sell_price_minor,
          pricing_quote_fingerprint, source_fingerprint,
          pricing_policy_version, pricing_policy_record_version,
          product_override_version, manual_price_version, tax_policy_version,
          fee_policy_version, fx_rate_version, status, record_version,
          idempotency_key, idempotency_fingerprint, correlation_id,
          created_at, expires_at, consumed_at, invalidated_at, reason_code
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
        )
        RETURNING ${priceLockReturning}
      `,
      [
        lock.id,
        lock.productId,
        lock.currency,
        lock.lockedSellPrice.amountMinor.toString(),
        lock.pricingQuoteFingerprint,
        lock.sourceOfferFingerprint,
        lock.pricingPolicyVersion,
        lock.pricingPolicyRecordVersion,
        lock.productOverrideVersion ?? null,
        lock.manualPriceVersion ?? null,
        lock.taxPolicyVersion,
        lock.feePolicyVersion,
        lock.fxRateVersion ?? null,
        lock.status,
        lock.recordVersion,
        lock.idempotencyKey ?? null,
        lock.idempotencyFingerprint ?? null,
        lock.correlationId,
        lock.createdAt,
        lock.expiresAt,
        lock.consumedAt ?? null,
        lock.invalidatedAt ?? null,
        lock.reasonCode ?? null,
      ],
    );
    return lockFromRow(row);
  }

  public async createIdempotently(
    lock: PriceLock,
  ): Promise<PriceLockCreatePersistenceResult> {
    const inserted = await this.db.query<PriceLockRow>(
      `
        INSERT INTO price_locks(
          id, product_id, currency, locked_sell_price_minor,
          pricing_quote_fingerprint, source_fingerprint,
          pricing_policy_version, pricing_policy_record_version,
          product_override_version, manual_price_version, tax_policy_version,
          fee_policy_version, fx_rate_version, status, record_version,
          idempotency_key, idempotency_fingerprint, correlation_id,
          created_at, expires_at, consumed_at, invalidated_at, reason_code
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
        )
        ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
        DO NOTHING
        RETURNING ${priceLockReturning}
      `,
      priceLockValues(lock),
    );
    const insertedRow = inserted.rows[0];
    if (insertedRow) {
      return { lock: lockFromRow(insertedRow), status: "CREATED" };
    }

    if (!lock.idempotencyKey) {
      const existing = await this.findById(lock.id);
      if (existing) {
        return { lock: existing, status: "EXISTING_CONFLICT" };
      }
      throw new Error("Price lock insert failed without idempotency conflict");
    }
    const existing = await this.findByIdempotencyKey(lock.idempotencyKey);
    if (!existing) {
      throw new Error("Price lock idempotency conflict row not found");
    }
    return existing.idempotencyFingerprint === lock.idempotencyFingerprint
      ? { lock: existing, status: "EXISTING_SAME" }
      : { lock: existing, status: "EXISTING_CONFLICT" };
  }

  public async findById(lockId: string): Promise<PriceLock | null> {
    const result = await this.db.query<PriceLockRow>(
      `
        SELECT ${priceLockReturning}
        FROM price_locks
        WHERE id = $1
      `,
      [lockId],
    );
    const row = result.rows[0];
    return row ? lockFromRow(row) : null;
  }

  public async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PriceLock | null> {
    const result = await this.db.query<PriceLockRow>(
      `
        SELECT ${priceLockReturning}
        FROM price_locks
        WHERE idempotency_key = $1
      `,
      [idempotencyKey],
    );
    const row = result.rows[0];
    return row ? lockFromRow(row) : null;
  }

  public async updateStatus(input: {
    readonly lockId: string;
    readonly expectedVersion: number;
    readonly status: PriceLockStatus;
    readonly reasonCode: PriceLockReasonCode;
    readonly now: Date;
  }): Promise<PriceLockStatusUpdateResult> {
    const result = await this.db.query<PriceLockRow>(
      `
        UPDATE price_locks
        SET status = $3,
          record_version = record_version + 1,
          reason_code = $4,
          invalidated_at = CASE
            WHEN $3 IN ('INVALIDATED', 'REPRICE_REQUIRED', 'BLOCKED')
              THEN $5
            ELSE invalidated_at
          END
        WHERE id = $1 AND record_version = $2
        RETURNING ${priceLockReturning}
      `,
      [
        input.lockId,
        input.expectedVersion,
        input.status,
        input.reasonCode,
        input.now,
      ],
    );
    const row = result.rows[0];
    if (row) {
      return { lock: lockFromRow(row), status: "UPDATED" };
    }
    return {
      currentLock: await this.findById(input.lockId),
      status: "CONFLICT",
    };
  }

  public async consumeIfActive(input: {
    readonly lockId: string;
    readonly expectedVersion: number;
    readonly now: Date;
  }): Promise<PriceLock | null> {
    const result = await this.db.query<PriceLockRow>(
      `
        UPDATE price_locks
        SET status = 'CONSUMED',
          record_version = record_version + 1,
          consumed_at = $3,
          reason_code = 'PRICE_LOCK_CONSUMED'
        WHERE id = $1
          AND record_version = $2
          AND status = 'ACTIVE'
          AND expires_at > $3
        RETURNING ${priceLockReturning}
      `,
      [input.lockId, input.expectedVersion, input.now],
    );
    const row = result.rows[0];
    return row ? lockFromRow(row) : null;
  }
}

const priceLockReturning = `
  id::text, product_id::text, currency, locked_sell_price_minor::text,
  pricing_quote_fingerprint, source_fingerprint, pricing_policy_version,
  pricing_policy_record_version, product_override_version,
  manual_price_version, tax_policy_version, fee_policy_version,
  fx_rate_version, status, record_version, idempotency_key,
  idempotency_fingerprint, correlation_id, created_at, expires_at,
  consumed_at, invalidated_at, reason_code
`;

const priceLockValues = (lock: PriceLock): readonly unknown[] => [
  lock.id,
  lock.productId,
  lock.currency,
  lock.lockedSellPrice.amountMinor.toString(),
  lock.pricingQuoteFingerprint,
  lock.sourceOfferFingerprint,
  lock.pricingPolicyVersion,
  lock.pricingPolicyRecordVersion,
  lock.productOverrideVersion ?? null,
  lock.manualPriceVersion ?? null,
  lock.taxPolicyVersion,
  lock.feePolicyVersion,
  lock.fxRateVersion ?? null,
  lock.status,
  lock.recordVersion,
  lock.idempotencyKey ?? null,
  lock.idempotencyFingerprint ?? null,
  lock.correlationId,
  lock.createdAt,
  lock.expiresAt,
  lock.consumedAt ?? null,
  lock.invalidatedAt ?? null,
  lock.reasonCode ?? null,
];

const lockFromRow = (row: PriceLockRow): PriceLock => ({
  correlationId: row.correlation_id as CorrelationId,
  createdAt: row.created_at,
  currency: currency(row.currency),
  expiresAt: row.expires_at,
  feePolicyVersion: row.fee_policy_version,
  id: row.id,
  lockedSellPrice: moneyFrom(row.locked_sell_price_minor, row.currency),
  pricingPolicyRecordVersion: row.pricing_policy_record_version,
  pricingPolicyVersion: row.pricing_policy_version,
  pricingQuoteFingerprint: row.pricing_quote_fingerprint,
  productId: productId(row.product_id),
  recordVersion: row.record_version,
  sourceOfferFingerprint: row.source_fingerprint,
  status: row.status,
  taxPolicyVersion: row.tax_policy_version,
  ...(row.consumed_at ? { consumedAt: row.consumed_at } : {}),
  ...(row.fx_rate_version ? { fxRateVersion: row.fx_rate_version } : {}),
  ...(row.idempotency_fingerprint
    ? { idempotencyFingerprint: row.idempotency_fingerprint }
    : {}),
  ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
  ...(row.invalidated_at ? { invalidatedAt: row.invalidated_at } : {}),
  ...(row.manual_price_version
    ? { manualPriceVersion: row.manual_price_version }
    : {}),
  ...(row.product_override_version
    ? { productOverrideVersion: row.product_override_version }
    : {}),
  ...(row.reason_code ? { reasonCode: row.reason_code } : {}),
});

const moneyFrom = (amountMinor: string, moneyCurrency: string): Money =>
  money(BigInt(amountMinor), currency(moneyCurrency));

const queryOne = async <TRow>(
  db: Queryable,
  text: string,
  values: readonly unknown[],
): Promise<TRow> => {
  const result = await db.query<TRow & Record<string, unknown>>(text, values);
  const row = result.rows[0];
  if (!row) {
    throw new Error("Expected PostgreSQL query to return one row");
  }
  return row;
};
