import {
  PricingConfigurationConflictError,
  validatePricingPolicy,
  validatePricingPolicyUpdate,
  validateProductPricingOverride,
  validateProductPricingOverrideUpdate,
  type PriceSnapshotRepository,
  type PricingPolicy,
  type PricingPolicyRepository,
  type PricingPolicyUpdate,
  type ProductPricingOverride,
  type ProductPricingOverrideRepository,
  type ProductPricingOverrideUpdate,
  type RoundingPolicy,
  type SellPriceQuote,
  type pricingPolicyVersion,
} from "../../packages/platform/src/pricing/pricing-margin.js";
import {
  currency,
  money,
  productId,
  type Money,
  type ProductId,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, QueryParameters } from "./client.js";

interface PricingPolicyRow {
  readonly id: string;
  readonly policy_version: typeof pricingPolicyVersion;
  readonly record_version: number;
  readonly enabled: boolean;
  readonly currency: string;
  readonly markup_basis_points: string;
  readonly target_margin_basis_points: string | null;
  readonly fixed_markup_minor: string;
  readonly minimum_profit_minor: string;
  readonly minimum_sell_price_minor: string;
  readonly rounding: unknown;
  readonly quote_ttl_ms: number | null;
  readonly actor_ref: string | null;
  readonly reason: string | null;
  readonly effective_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ProductPricingOverrideRow {
  readonly product_id: string;
  readonly record_version: number;
  readonly enabled: boolean;
  readonly markup_basis_points: string | null;
  readonly target_margin_basis_points: string | null;
  readonly fixed_markup_minor: string | null;
  readonly fixed_markup_currency: string | null;
  readonly minimum_profit_minor: string | null;
  readonly minimum_profit_currency: string | null;
  readonly minimum_sell_price_minor: string | null;
  readonly minimum_sell_price_currency: string | null;
  readonly rounding: unknown | null;
  readonly quote_ttl_ms: number | null;
  readonly manual_sell_price_minor: string | null;
  readonly manual_sell_price_currency: string | null;
  readonly manual_price_version: number | null;
  readonly actor_ref: string | null;
  readonly reason: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export class PostgresPricingPolicyRepository implements PricingPolicyRepository {
  public constructor(private readonly db: Queryable) {}

  public async getActivePolicy(): Promise<PricingPolicy | null> {
    const result = await this.db.query<PricingPolicyRow>(
      `
        SELECT id::text, policy_version, record_version, enabled, currency,
          markup_basis_points::text, target_margin_basis_points::text,
          fixed_markup_minor::text, minimum_profit_minor::text,
          minimum_sell_price_minor::text, rounding, quote_ttl_ms, actor_ref,
          reason, effective_at, created_at, updated_at
        FROM pricing_policies
        WHERE active = true
        LIMIT 1
      `,
    );
    const row = result.rows[0];
    return row ? policyFromRow(row) : null;
  }

  public async updateActivePolicy(
    update: PricingPolicyUpdate,
  ): Promise<PricingPolicy> {
    validatePricingPolicyUpdate(update);
    const current = await this.getActivePolicy();
    if (!current) {
      throw new Error("No active pricing policy configured");
    }
    if (current.version !== update.expectedVersion) {
      throw new PricingConfigurationConflictError();
    }

    const next = {
      enabled: update.enabled ?? current.enabled,
      fixedMarkup: update.fixedMarkup ?? current.fixedMarkup,
      markupBasisPoints: update.markupBasisPoints ?? current.markupBasisPoints,
      minimumProfit: update.minimumProfit ?? current.minimumProfit,
      minimumSellPrice: update.minimumSellPrice ?? current.minimumSellPrice,
      quoteTtlMs:
        update.quoteTtlMs === undefined
          ? current.quoteTtlMs
          : update.quoteTtlMs,
      rounding: update.rounding ?? current.rounding,
      targetMarginBasisPoints:
        update.targetMarginBasisPoints === undefined
          ? current.targetMarginBasisPoints
          : update.targetMarginBasisPoints,
    };
    const row = await queryOne<PricingPolicyRow>(
      this.db,
      `
        UPDATE pricing_policies
        SET record_version = record_version + 1,
          enabled = $2,
          markup_basis_points = $3,
          target_margin_basis_points = $4,
          fixed_markup_minor = $5,
          minimum_profit_minor = $6,
          minimum_sell_price_minor = $7,
          rounding = $8::jsonb,
          quote_ttl_ms = $9,
          actor_ref = $10,
          reason = $11,
          updated_at = now()
        WHERE id = $1 AND record_version = $12
        RETURNING id::text, policy_version, record_version, enabled, currency,
          markup_basis_points::text, target_margin_basis_points::text,
          fixed_markup_minor::text, minimum_profit_minor::text,
          minimum_sell_price_minor::text, rounding, quote_ttl_ms, actor_ref,
          reason, effective_at, created_at, updated_at
      `,
      [
        current.policyId,
        next.enabled,
        next.markupBasisPoints.toString(),
        next.targetMarginBasisPoints?.toString() ?? null,
        next.fixedMarkup.amountMinor.toString(),
        next.minimumProfit.amountMinor.toString(),
        next.minimumSellPrice.amountMinor.toString(),
        JSON.stringify(roundingToJson(next.rounding)),
        next.quoteTtlMs ?? null,
        update.actorRef,
        update.reason,
        update.expectedVersion,
      ],
      () => new PricingConfigurationConflictError(),
    );
    return policyFromRow(row);
  }
}

export class PostgresProductPricingOverrideRepository implements ProductPricingOverrideRepository {
  public constructor(private readonly db: Queryable) {}

  public async getOverride(
    canonicalProductId: ProductId,
  ): Promise<ProductPricingOverride | null> {
    const result = await this.db.query<ProductPricingOverrideRow>(
      `
        SELECT product_id::text, record_version, enabled,
          markup_basis_points::text, target_margin_basis_points::text,
          fixed_markup_minor::text, fixed_markup_currency,
          minimum_profit_minor::text, minimum_profit_currency,
          minimum_sell_price_minor::text, minimum_sell_price_currency,
          rounding, quote_ttl_ms,
          manual_sell_price_minor::text, manual_sell_price_currency,
          manual_price_version, actor_ref, reason, created_at, updated_at
        FROM product_pricing_overrides
        WHERE product_id = $1
      `,
      [canonicalProductId],
    );
    const row = result.rows[0];
    return row ? overrideFromRow(row) : null;
  }

  public async updateOverride(
    update: ProductPricingOverrideUpdate,
  ): Promise<ProductPricingOverride> {
    validateProductPricingOverrideUpdate(update);
    const current = await this.getOverride(update.productId);
    if (
      update.expectedVersion !== undefined &&
      current?.version !== update.expectedVersion
    ) {
      throw new PricingConfigurationConflictError();
    }
    const nextVersion = (current?.version ?? 0) + 1;
    const manualSellPrice =
      update.manualSellPrice === undefined
        ? current?.manualSellPrice
        : update.manualSellPrice;
    const manualPriceVersion =
      update.manualSellPrice === undefined
        ? current?.manualPriceVersion
        : update.manualSellPrice === null
          ? null
          : (current?.manualPriceVersion ?? 0) + 1;
    const row = await queryOne<ProductPricingOverrideRow>(
      this.db,
      `
        INSERT INTO product_pricing_overrides(
          product_id, record_version, enabled, markup_basis_points,
          target_margin_basis_points, fixed_markup_minor, fixed_markup_currency,
          minimum_profit_minor, minimum_profit_currency,
          minimum_sell_price_minor, minimum_sell_price_currency,
          rounding, quote_ttl_ms,
          manual_sell_price_minor, manual_sell_price_currency,
          manual_price_version, actor_ref, reason
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (product_id)
        DO UPDATE SET
          record_version = EXCLUDED.record_version,
          enabled = EXCLUDED.enabled,
          markup_basis_points = EXCLUDED.markup_basis_points,
          target_margin_basis_points = EXCLUDED.target_margin_basis_points,
          fixed_markup_minor = EXCLUDED.fixed_markup_minor,
          fixed_markup_currency = EXCLUDED.fixed_markup_currency,
          minimum_profit_minor = EXCLUDED.minimum_profit_minor,
          minimum_profit_currency = EXCLUDED.minimum_profit_currency,
          minimum_sell_price_minor = EXCLUDED.minimum_sell_price_minor,
          minimum_sell_price_currency = EXCLUDED.minimum_sell_price_currency,
          rounding = EXCLUDED.rounding,
          quote_ttl_ms = EXCLUDED.quote_ttl_ms,
          manual_sell_price_minor = EXCLUDED.manual_sell_price_minor,
          manual_sell_price_currency = EXCLUDED.manual_sell_price_currency,
          manual_price_version = EXCLUDED.manual_price_version,
          actor_ref = EXCLUDED.actor_ref,
          reason = EXCLUDED.reason,
          updated_at = now()
        WHERE product_pricing_overrides.record_version = $19
        RETURNING product_id::text, record_version, enabled,
          markup_basis_points::text, target_margin_basis_points::text,
          fixed_markup_minor::text, fixed_markup_currency,
          minimum_profit_minor::text, minimum_profit_currency,
          minimum_sell_price_minor::text, minimum_sell_price_currency,
          rounding, quote_ttl_ms,
          manual_sell_price_minor::text, manual_sell_price_currency,
          manual_price_version, actor_ref, reason, created_at, updated_at
      `,
      [
        update.productId,
        nextVersion,
        update.enabled ?? current?.enabled ?? true,
        optionalBigInt(update.markupBasisPoints, current?.markupBasisPoints),
        optionalBigInt(
          update.targetMarginBasisPoints,
          current?.targetMarginBasisPoints,
        ),
        optionalMoney(update.fixedMarkup, current?.fixedMarkup),
        optionalMoneyCurrency(update.fixedMarkup, current?.fixedMarkup),
        optionalMoney(update.minimumProfit, current?.minimumProfit),
        optionalMoneyCurrency(update.minimumProfit, current?.minimumProfit),
        optionalMoney(update.minimumSellPrice, current?.minimumSellPrice),
        optionalMoneyCurrency(
          update.minimumSellPrice,
          current?.minimumSellPrice,
        ),
        optionalRounding(update.rounding, current?.rounding),
        update.quoteTtlMs === undefined
          ? (current?.quoteTtlMs ?? null)
          : update.quoteTtlMs,
        manualSellPrice?.amountMinor.toString() ?? null,
        manualSellPrice?.currency ?? null,
        manualPriceVersion ?? null,
        update.actorRef,
        update.reason,
        current?.version ?? 0,
      ],
      () => new PricingConfigurationConflictError(),
    );
    return overrideFromRow(row);
  }

  public async clearOverride(input: {
    readonly productId: ProductId;
    readonly expectedVersion: number;
  }): Promise<void> {
    const result = await this.db.query(
      `
        DELETE FROM product_pricing_overrides
        WHERE product_id = $1 AND record_version = $2
      `,
      [input.productId, input.expectedVersion],
    );
    if (result.rowCount !== 1) {
      throw new PricingConfigurationConflictError();
    }
  }
}

export class PostgresPriceSnapshotRepository implements PriceSnapshotRepository {
  public constructor(private readonly db: Queryable) {}

  public async saveSnapshot(quote: SellPriceQuote): Promise<void> {
    await this.db.query(
      `
        INSERT INTO product_price_snapshots(
          product_id, offer_id, currency, sell_price_minor,
          pricing_policy_version, pricing_policy_record_version,
          product_override_version, manual_price_version, source_fingerprint,
          status, reason_code, calculated_at, valid_until
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (product_id, offer_id, source_fingerprint) DO NOTHING
      `,
      [
        quote.productId,
        quote.offerId,
        quote.currency,
        quote.sellPrice.amountMinor.toString(),
        quote.pricingPolicyVersion,
        quote.pricingPolicyRecordVersion,
        quote.productOverrideVersion ?? null,
        quote.manualPriceVersion ?? null,
        quote.sourceFingerprint,
        quote.status,
        quote.reasonCode ?? null,
        quote.calculatedAt,
        quote.validUntil ?? null,
      ],
    );
  }
}

export class PostgresPricingRepository
  implements
    PricingPolicyRepository,
    ProductPricingOverrideRepository,
    PriceSnapshotRepository
{
  private readonly policies: PostgresPricingPolicyRepository;
  private readonly overrides: PostgresProductPricingOverrideRepository;
  private readonly snapshots: PostgresPriceSnapshotRepository;

  public constructor(db: Queryable) {
    this.policies = new PostgresPricingPolicyRepository(db);
    this.overrides = new PostgresProductPricingOverrideRepository(db);
    this.snapshots = new PostgresPriceSnapshotRepository(db);
  }

  public getActivePolicy(): Promise<PricingPolicy | null> {
    return this.policies.getActivePolicy();
  }

  public updateActivePolicy(
    update: PricingPolicyUpdate,
  ): Promise<PricingPolicy> {
    return this.policies.updateActivePolicy(update);
  }

  public getOverride(
    canonicalProductId: ProductId,
  ): Promise<ProductPricingOverride | null> {
    return this.overrides.getOverride(canonicalProductId);
  }

  public updateOverride(
    update: ProductPricingOverrideUpdate,
  ): Promise<ProductPricingOverride> {
    return this.overrides.updateOverride(update);
  }

  public clearOverride(input: {
    readonly productId: ProductId;
    readonly expectedVersion: number;
    readonly actorRef: string;
    readonly reason: string;
  }): Promise<void> {
    void input.actorRef;
    void input.reason;
    return this.overrides.clearOverride(input);
  }

  public saveSnapshot(quote: SellPriceQuote): Promise<void> {
    return this.snapshots.saveSnapshot(quote);
  }
}

export const insertInitialPricingPolicy = async (
  db: Queryable,
  policy: PricingPolicy,
): Promise<void> => {
  validatePricingPolicy(policy);
  await db.query(
    `
      INSERT INTO pricing_policies(
        id, policy_version, record_version, active, enabled, currency,
        markup_basis_points, target_margin_basis_points, fixed_markup_minor,
        minimum_profit_minor, minimum_sell_price_minor, rounding, quote_ttl_ms,
        actor_ref, reason, effective_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16, $17)
    `,
    [
      policy.policyId,
      policy.policyVersion,
      policy.version,
      policy.enabled,
      policy.currency,
      policy.markupBasisPoints.toString(),
      policy.targetMarginBasisPoints?.toString() ?? null,
      policy.fixedMarkup.amountMinor.toString(),
      policy.minimumProfit.amountMinor.toString(),
      policy.minimumSellPrice.amountMinor.toString(),
      JSON.stringify(roundingToJson(policy.rounding)),
      policy.quoteTtlMs ?? null,
      policy.actorRef ?? null,
      policy.reason ?? null,
      policy.effectiveAt,
      policy.createdAt,
      policy.updatedAt,
    ],
  );
};

const policyFromRow = (row: PricingPolicyRow): PricingPolicy =>
  validatePricingPolicy({
    createdAt: row.created_at,
    currency: currency(row.currency),
    effectiveAt: row.effective_at,
    enabled: row.enabled,
    fixedMarkup: moneyFrom(row.fixed_markup_minor, row.currency),
    markupBasisPoints: BigInt(row.markup_basis_points),
    minimumProfit: moneyFrom(row.minimum_profit_minor, row.currency),
    minimumSellPrice: moneyFrom(row.minimum_sell_price_minor, row.currency),
    policyId: row.id,
    policyVersion: row.policy_version,
    rounding: roundingFromJson(row.rounding),
    updatedAt: row.updated_at,
    version: row.record_version,
    ...(row.actor_ref ? { actorRef: row.actor_ref } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.quote_ttl_ms ? { quoteTtlMs: row.quote_ttl_ms } : {}),
    ...(row.target_margin_basis_points
      ? { targetMarginBasisPoints: BigInt(row.target_margin_basis_points) }
      : {}),
  });

export const hydrateProductPricingOverrideRow = (
  row: ProductPricingOverrideRow,
): ProductPricingOverride => {
  assertPairedMoneyColumns(
    row.manual_sell_price_minor,
    row.manual_sell_price_currency,
    "Manual sell price",
  );
  assertPairedMoneyColumns(
    row.fixed_markup_minor,
    row.fixed_markup_currency,
    "Fixed markup override",
  );
  assertPairedMoneyColumns(
    row.minimum_profit_minor,
    row.minimum_profit_currency,
    "Minimum profit override",
  );
  assertPairedMoneyColumns(
    row.minimum_sell_price_minor,
    row.minimum_sell_price_currency,
    "Minimum sell price override",
  );
  return validateProductPricingOverride({
    createdAt: row.created_at,
    enabled: row.enabled,
    productId: productId(row.product_id),
    updatedAt: row.updated_at,
    version: row.record_version,
    ...(row.actor_ref ? { actorRef: row.actor_ref } : {}),
    ...(row.fixed_markup_minor && row.fixed_markup_currency
      ? {
          fixedMarkup: moneyFrom(
            row.fixed_markup_minor,
            row.fixed_markup_currency,
          ),
        }
      : {}),
    ...(row.manual_sell_price_minor && row.manual_sell_price_currency
      ? {
          manualPriceVersion: row.manual_price_version,
          manualSellPrice: moneyFrom(
            row.manual_sell_price_minor,
            row.manual_sell_price_currency,
          ),
        }
      : row.manual_price_version === null
        ? {}
        : { manualPriceVersion: row.manual_price_version }),
    ...(row.markup_basis_points
      ? { markupBasisPoints: BigInt(row.markup_basis_points) }
      : {}),
    ...(row.minimum_profit_minor && row.minimum_profit_currency
      ? {
          minimumProfit: moneyFrom(
            row.minimum_profit_minor,
            row.minimum_profit_currency,
          ),
        }
      : {}),
    ...(row.minimum_sell_price_minor && row.minimum_sell_price_currency
      ? {
          minimumSellPrice: moneyFrom(
            row.minimum_sell_price_minor,
            row.minimum_sell_price_currency,
          ),
        }
      : {}),
    ...(row.quote_ttl_ms ? { quoteTtlMs: row.quote_ttl_ms } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.rounding ? { rounding: roundingFromJson(row.rounding) } : {}),
    ...(row.target_margin_basis_points
      ? { targetMarginBasisPoints: BigInt(row.target_margin_basis_points) }
      : {}),
  });
};

const overrideFromRow = hydrateProductPricingOverrideRow;

const optionalBigInt = (
  update: bigint | null | undefined,
  current: bigint | null | undefined,
): string | null =>
  update === undefined
    ? (current?.toString() ?? null)
    : (update?.toString() ?? null);

const optionalMoney = (
  update: Money | null | undefined,
  current: Money | null | undefined,
): string | null =>
  update === undefined
    ? (current?.amountMinor.toString() ?? null)
    : (update?.amountMinor.toString() ?? null);

const optionalMoneyCurrency = (
  update: Money | null | undefined,
  current: Money | null | undefined,
): string | null =>
  update === undefined
    ? (current?.currency ?? null)
    : (update?.currency ?? null);

const optionalRounding = (
  update: RoundingPolicy | null | undefined,
  current: RoundingPolicy | null | undefined,
): string | null =>
  update === undefined
    ? current
      ? JSON.stringify(roundingToJson(current))
      : null
    : update
      ? JSON.stringify(roundingToJson(update))
      : null;

const moneyFrom = (amountMinor: string, moneyCurrency: string): Money =>
  money(BigInt(amountMinor), currency(moneyCurrency));

const assertPairedMoneyColumns = (
  amountMinor: string | null,
  moneyCurrency: string | null,
  label: string,
): void => {
  if (
    (amountMinor === null && moneyCurrency !== null) ||
    (amountMinor !== null && moneyCurrency === null)
  ) {
    throw new Error(`${label} amount and currency must be stored together`);
  }
};

const roundingToJson = (rounding: RoundingPolicy): Record<string, string> =>
  rounding.mode === "MINOR_UNIT_UP"
    ? { mode: rounding.mode }
    : { endingMinor: rounding.endingMinor.toString(), mode: rounding.mode };

const roundingFromJson = (value: unknown): RoundingPolicy => {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid persisted pricing rounding policy");
  }
  const record = value as Record<string, unknown>;
  if (record.mode === "MINOR_UNIT_UP") {
    return { mode: "MINOR_UNIT_UP" };
  }
  if (
    record.mode === "PSYCHOLOGICAL_ENDING" &&
    typeof record.endingMinor === "string"
  ) {
    return {
      endingMinor: BigInt(record.endingMinor),
      mode: "PSYCHOLOGICAL_ENDING",
    };
  }
  throw new Error("Invalid persisted pricing rounding policy");
};

const queryOne = async <TRow>(
  db: Queryable,
  text: string,
  values: QueryParameters,
  emptyError: () => Error = () =>
    new Error("Expected PostgreSQL query to return one row"),
): Promise<TRow> => {
  const result = await db.query<TRow & Record<string, unknown>>(text, values);
  const row = result.rows[0];
  if (!row) {
    throw emptyError();
  }
  return row;
};
