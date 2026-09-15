import type {
  AdminMutationContext,
  PromotionCampaign,
  PromotionCreateInput,
  PromotionDetail,
  PromotionListInput,
  PromotionOverview,
  PromotionQuote,
  PromotionRepository,
  PromotionReservation,
  PromotionUpdateInput,
} from "../../packages/platform/src/contracts.js";
import {
  calculatePromotionDiscount,
  effectivePromotionStatus,
  promotionCode,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";

interface CampaignRow {
  readonly id: string;
  readonly operation_id: string;
  readonly name: string;
  readonly internal_description: string;
  readonly code: string;
  readonly lifecycle: PromotionCampaign["lifecycle"];
  readonly discount_type: PromotionCampaign["discountType"];
  readonly discount_value: string;
  readonly currency: "EUR";
  readonly product_scope: PromotionCampaign["productScope"];
  readonly product_ids: string[];
  readonly starts_at: Date | null;
  readonly ends_at: Date | null;
  readonly minimum_subtotal_minor: string | null;
  readonly usage_limit: string | null;
  readonly consumed_count: string;
  readonly reserved_count: string;
  readonly record_version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface RedemptionRow {
  readonly state: "RESERVED" | "CONSUMED" | "RELEASED";
  readonly checkout_token: string;
  readonly campaign_id: string;
  readonly code_snapshot: string;
  readonly discount_type_snapshot: PromotionCampaign["discountType"];
  readonly discount_value_snapshot: string;
  readonly base_amount_minor: string;
  readonly discount_amount_minor: string;
  readonly final_amount_minor: string;
  readonly currency: "EUR";
  readonly expires_at: Date;
}

export class PostgresPromotionRepository implements PromotionRepository {
  public constructor(private readonly database: TransactionalQueryable) {}

  public async list(
    input: PromotionListInput,
    now: Date,
  ): Promise<PromotionOverview> {
    const values: unknown[] = [now];
    const parameter = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };
    const predicates: string[] = [];
    if (input.search) {
      const search = input.search.trim();
      predicates.push(
        `(campaign.id::text = ${parameter(search)} OR campaign.name ILIKE ${parameter(`%${escapeLike(search)}%`)} ESCAPE '\\' OR campaign.code ILIKE ${parameter(`%${escapeLike(search)}%`)} ESCAPE '\\')`,
      );
    }
    if (input.status)
      predicates.push(
        `${effectiveStatusSql("campaign", "$1")} = ${parameter(input.status)}`,
      );
    if (input.discountType)
      predicates.push(
        `campaign.discount_type = ${parameter(input.discountType)}`,
      );
    if (input.productScope)
      predicates.push(
        `campaign.product_scope = ${parameter(input.productScope)}`,
      );
    if (input.usage === "LIMITED")
      predicates.push("campaign.usage_limit IS NOT NULL");
    if (input.usage === "UNLIMITED")
      predicates.push("campaign.usage_limit IS NULL");
    if (input.usage === "LIMIT_REACHED")
      predicates.push(
        `${usageCountSql("campaign", "$1")} >= campaign.usage_limit`,
      );
    const where =
      predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
    const countWhere = `WHERE $1::timestamptz IS NOT NULL${
      predicates.length > 0 ? ` AND ${predicates.join(" AND ")}` : ""
    }`;
    const countValues = [...values];
    const offset = (input.page - 1) * input.limit;
    const order = promotionOrder(input.sort);
    const [rows, filteredCount, metrics] = await Promise.all([
      this.database.query<CampaignRow>(
        `${selectCampaigns("$1")} ${where} ORDER BY ${order} LIMIT ${parameter(input.limit)} OFFSET ${parameter(offset)}`,
        values,
      ),
      this.database.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count FROM promotion_campaigns campaign ${countWhere}`,
        countValues,
      ),
      this.database.query<{
        readonly total: string;
        readonly active: string;
        readonly planned: string;
        readonly attention: string;
      }>(
        `SELECT count(*)::text AS total,
          count(*) FILTER (WHERE ${effectiveStatusSql("campaign", "$1")} = 'ACTIVE')::text AS active,
          count(*) FILTER (WHERE ${effectiveStatusSql("campaign", "$1")} = 'PLANNED')::text AS planned,
          count(*) FILTER (WHERE campaign.usage_limit IS NOT NULL AND ${usageCountSql("campaign", "$1")} >= campaign.usage_limit)::text AS attention
         FROM promotion_campaigns campaign`,
        [now],
      ),
    ]);
    const metric = required(metrics.rows[0]);
    return {
      active: Number(metric.active),
      attention: Number(metric.attention),
      campaigns: rows.rows.map(mapCampaign),
      limit: input.limit,
      page: input.page,
      planned: Number(metric.planned),
      total: Number(metric.total),
      totalCount: Number(required(filteredCount.rows[0]).count),
    };
  }

  public async find(id: string, now: Date): Promise<PromotionDetail | null> {
    const [campaignResult, usageResult, productResult] = await Promise.all([
      this.database.query<CampaignRow>(
        `${selectCampaigns("$2")} WHERE campaign.id = $1::uuid`,
        [id, now],
      ),
      this.database.query<{
        readonly order_id: string;
        readonly consumed_at: Date;
        readonly discount_amount_minor: string;
        readonly final_amount_minor: string;
        readonly currency: "EUR";
      }>(
        `SELECT order_id::text, consumed_at, discount_amount_minor::text, final_amount_minor::text, currency
         FROM promotion_redemptions
         WHERE campaign_id = $1::uuid AND state = 'CONSUMED'
         ORDER BY consumed_at DESC, id DESC LIMIT 10`,
        [id],
      ),
      this.database.query<{
        readonly id: string;
        readonly title: string;
        readonly platform: string;
        readonly active: boolean;
      }>(
        `SELECT product.id::text, product.title, product.platform, product.active
         FROM promotion_campaign_products selected
         JOIN products product ON product.id = selected.product_id
         WHERE selected.campaign_id = $1::uuid
         ORDER BY product.title, product.id LIMIT 50`,
        [id],
      ),
    ]);
    const row = campaignResult.rows[0];
    return row
      ? {
          ...mapCampaign(row),
          recentUsage: usageResult.rows.map((usage) => ({
            consumedAt: usage.consumed_at,
            currency: usage.currency,
            discountAmountMinor: BigInt(usage.discount_amount_minor),
            finalAmountMinor: BigInt(usage.final_amount_minor),
            orderId: usage.order_id,
          })),
          selectedProducts: productResult.rows,
        }
      : null;
  }

  public async create(
    input: PromotionCreateInput,
    context: AdminMutationContext,
  ): Promise<{
    readonly id: string;
    readonly status: "CREATED" | "IDEMPOTENT" | "DUPLICATE";
  }> {
    return this.database.transaction(async (client) => {
      const existing = await client.query<{ readonly id: string }>(
        "SELECT id::text FROM promotion_campaigns WHERE operation_id = $1::uuid FOR UPDATE",
        [input.operationId],
      );
      if (existing.rows[0])
        return { id: existing.rows[0].id, status: "IDEMPOTENT" };
      const inserted = await client.query<{ readonly id: string }>(
        `INSERT INTO promotion_campaigns(
          id, operation_id, name, internal_description, code, discount_type,
          discount_value, currency, product_scope, starts_at, ends_at,
          minimum_subtotal_minor, usage_limit, created_at, updated_at
        ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
        ON CONFLICT DO NOTHING
        RETURNING id::text`,
        [
          input.id,
          input.operationId,
          input.name,
          input.internalDescription,
          input.code,
          input.discountType,
          input.discountValue.toString(),
          input.currency,
          input.productScope,
          input.startsAt,
          input.endsAt,
          input.minimumSubtotalMinor?.toString() ?? null,
          input.usageLimit?.toString() ?? null,
          context.at,
        ],
      );
      if (!inserted.rows[0]) {
        const replay = await client.query<{ readonly id: string }>(
          "SELECT id::text FROM promotion_campaigns WHERE operation_id = $1::uuid",
          [input.operationId],
        );
        return replay.rows[0]
          ? { id: replay.rows[0].id, status: "IDEMPOTENT" }
          : { id: input.id, status: "DUPLICATE" };
      }
      await appendAudit(client, context, input.id, "ADMIN_PROMOTION_CREATED", {
        lifecycle: "DRAFT",
      });
      return { id: input.id, status: "CREATED" };
    });
  }

  public async update(
    input: PromotionUpdateInput,
    context: AdminMutationContext,
  ): Promise<"UPDATED" | "STALE" | "NOT_FOUND" | "IMMUTABLE"> {
    return this.database.transaction(async (client) => {
      const current = await client.query<CampaignRow>(
        `${selectCampaigns("$2")} WHERE campaign.id = $1::uuid FOR UPDATE OF campaign`,
        [input.id, context.at],
      );
      const row = current.rows[0];
      if (!row) return "NOT_FOUND";
      if (row.record_version !== input.expectedVersion) return "STALE";
      if (row.lifecycle === "ARCHIVED") return "IMMUTABLE";
      if (
        BigInt(row.consumed_count) > 0n &&
        (row.code !== input.code ||
          row.discount_type !== input.discountType ||
          BigInt(row.discount_value) !== input.discountValue)
      )
        return "IMMUTABLE";
      if (
        input.usageLimit !== null &&
        input.usageLimit < BigInt(row.consumed_count)
      )
        return "IMMUTABLE";
      await client.query(
        `UPDATE promotion_campaigns SET name = $2, internal_description = $3,
          code = $4, discount_type = $5, discount_value = $6, currency = $7,
          product_scope = $8, starts_at = $9, ends_at = $10,
          minimum_subtotal_minor = $11, usage_limit = $12,
          record_version = record_version + 1, updated_at = $13 WHERE id = $1::uuid`,
        [
          input.id,
          input.name,
          input.internalDescription,
          input.code,
          input.discountType,
          input.discountValue.toString(),
          input.currency,
          input.productScope,
          input.startsAt,
          input.endsAt,
          input.minimumSubtotalMinor?.toString() ?? null,
          input.usageLimit?.toString() ?? null,
          context.at,
        ],
      );
      await appendAudit(
        client,
        context,
        input.id,
        "ADMIN_PROMOTION_UPDATED",
        {},
      );
      return "UPDATED";
    });
  }

  public async setProductEligibility(
    input: {
      readonly id: string;
      readonly expectedVersion: number;
      readonly productId: string;
      readonly selected: boolean;
    },
    context: AdminMutationContext,
  ): Promise<"UPDATED" | "STALE" | "NOT_FOUND" | "INVALID"> {
    return this.database.transaction(async (client) => {
      const campaign = await client.query<{
        readonly record_version: number;
        readonly lifecycle: string;
        readonly product_scope: string;
      }>(
        "SELECT record_version, lifecycle, product_scope FROM promotion_campaigns WHERE id = $1::uuid FOR UPDATE",
        [input.id],
      );
      const row = campaign.rows[0];
      if (!row) return "NOT_FOUND";
      if (row.record_version !== input.expectedVersion) return "STALE";
      if (
        row.lifecycle === "ARCHIVED" ||
        row.product_scope !== "SELECTED_PRODUCTS"
      )
        return "INVALID";
      const product = await client.query(
        "SELECT id FROM products WHERE id = $1::uuid",
        [input.productId],
      );
      if (!product.rows[0]) return "INVALID";
      if (input.selected)
        await client.query(
          "INSERT INTO promotion_campaign_products(campaign_id, product_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING",
          [input.id, input.productId],
        );
      else
        await client.query(
          "DELETE FROM promotion_campaign_products WHERE campaign_id = $1::uuid AND product_id = $2::uuid",
          [input.id, input.productId],
        );
      await client.query(
        "UPDATE promotion_campaigns SET record_version = record_version + 1, updated_at = $2 WHERE id = $1::uuid",
        [input.id, context.at],
      );
      await appendAudit(
        client,
        context,
        input.id,
        input.selected
          ? "ADMIN_PROMOTION_PRODUCT_ADDED"
          : "ADMIN_PROMOTION_PRODUCT_REMOVED",
        { productId: input.productId },
      );
      return "UPDATED";
    });
  }

  public async searchProducts(search: string, limit: number) {
    const result = await this.database.query<{
      readonly id: string;
      readonly title: string;
      readonly platform: string;
      readonly active: boolean;
    }>(
      `SELECT id::text, title, platform, active FROM products
       WHERE ($1 = '' OR id::text = $1 OR title ILIKE $2 ESCAPE '\\')
       ORDER BY active DESC, title, id LIMIT $3`,
      [search, `%${escapeLike(search)}%`, limit],
    );
    return result.rows;
  }

  public async transition(
    input: {
      readonly id: string;
      readonly expectedVersion: number;
      readonly lifecycle: PromotionCampaign["lifecycle"];
    },
    context: AdminMutationContext,
  ): Promise<"UPDATED" | "STALE" | "NOT_FOUND" | "INVALID"> {
    return this.database.transaction(async (client) => {
      const current = await client.query<CampaignRow>(
        `${selectCampaigns("$2")} WHERE campaign.id = $1::uuid FOR UPDATE OF campaign`,
        [input.id, context.at],
      );
      const row = current.rows[0];
      if (!row) return "NOT_FOUND";
      if (row.record_version !== input.expectedVersion) return "STALE";
      const valid =
        (input.lifecycle === "ENABLED" &&
          (row.lifecycle === "DRAFT" || row.lifecycle === "DISABLED")) ||
        (input.lifecycle === "DISABLED" && row.lifecycle === "ENABLED") ||
        (input.lifecycle === "ARCHIVED" &&
          (row.lifecycle === "DRAFT" || row.lifecycle === "DISABLED"));
      if (!valid) return "INVALID";
      if (
        input.lifecycle === "ENABLED" &&
        ((row.ends_at !== null && row.ends_at <= context.at) ||
          (row.product_scope === "SELECTED_PRODUCTS" &&
            row.product_ids.length === 0))
      )
        return "INVALID";
      await client.query(
        "UPDATE promotion_campaigns SET lifecycle = $2, record_version = record_version + 1, updated_at = $3 WHERE id = $1::uuid",
        [input.id, input.lifecycle, context.at],
      );
      await appendAudit(
        client,
        context,
        input.id,
        "ADMIN_PROMOTION_LIFECYCLE_CHANGED",
        { lifecycle: input.lifecycle },
      );
      return "UPDATED";
    });
  }

  public async quote(
    input: {
      readonly code: string;
      readonly productId: string;
      readonly baseAmountMinor: bigint;
      readonly currency: "EUR";
      readonly maximumDiscountMinor?: bigint;
    },
    now: Date,
  ): Promise<PromotionQuote | null> {
    const result = await this.database.query<CampaignRow>(
      `${selectCampaigns("$2")} WHERE campaign.code = $1`,
      [safeCode(input.code), now],
    );
    return quoteFrom(result.rows[0], input, now);
  }

  public async findReservation(
    checkoutToken: string,
    now: Date,
  ): Promise<PromotionReservation | null> {
    const result = await this.database.query<RedemptionRow>(
      `${selectRedemption} WHERE checkout_token = $1`,
      [checkoutToken],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.state === "RELEASED" ||
      (row.state === "RESERVED" && row.expires_at <= now)
    )
      return null;
    return mapReservation(row);
  }

  public async reserve(
    input: {
      readonly checkoutToken: string;
      readonly code: string;
      readonly productId: string;
      readonly baseAmountMinor: bigint;
      readonly currency: "EUR";
      readonly expiresAt: Date;
      readonly maximumDiscountMinor?: bigint;
    },
    now: Date,
  ): Promise<PromotionReservation | null> {
    return this.database.transaction(async (client) => {
      const existing = await client.query<RedemptionRow>(
        `${selectRedemption} WHERE checkout_token = $1 FOR UPDATE`,
        [input.checkoutToken],
      );
      const replay = existing.rows[0];
      if (replay) {
        if (replay.state === "RESERVED" && replay.expires_at <= now) {
          await client.query(
            "UPDATE promotion_redemptions SET state = 'RELEASED', released_at = $2, updated_at = $2 WHERE checkout_token = $1 AND state = 'RESERVED'",
            [input.checkoutToken, now],
          );
          return null;
        }
        return replay.state === "RESERVED" || replay.state === "CONSUMED"
          ? mapReservation(replay)
          : null;
      }
      const result = await client.query<CampaignRow>(
        `${selectCampaigns("$2")} WHERE campaign.code = $1 FOR UPDATE OF campaign`,
        [safeCode(input.code), now],
      );
      const row = result.rows[0];
      const quote = quoteFrom(row, input, now);
      if (!quote || !row || input.expiresAt <= now) return null;
      await client.query(
        "UPDATE promotion_redemptions SET state = 'RELEASED', released_at = $2, updated_at = $2 WHERE campaign_id = $1::uuid AND state = 'RESERVED' AND expires_at <= $2",
        [quote.campaignId, now],
      );
      const capacity = await client.query<{ readonly used: string }>(
        "SELECT count(*)::text AS used FROM promotion_redemptions WHERE campaign_id = $1::uuid AND (state = 'CONSUMED' OR (state = 'RESERVED' AND expires_at > $2))",
        [quote.campaignId, now],
      );
      if (
        row.usage_limit !== null &&
        BigInt(required(capacity.rows[0]).used) >= BigInt(row.usage_limit)
      )
        return null;
      await client.query(
        `INSERT INTO promotion_redemptions(
          campaign_id, checkout_token, product_id, state, expires_at,
          code_snapshot, campaign_name_snapshot, discount_type_snapshot,
          discount_value_snapshot, base_amount_minor, discount_amount_minor,
          final_amount_minor, currency, created_at, updated_at
        ) VALUES ($1::uuid, $2, $3::uuid, 'RESERVED', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
        [
          quote.campaignId,
          input.checkoutToken,
          input.productId,
          input.expiresAt,
          quote.code,
          row.name,
          quote.discountType,
          quote.configuredValue.toString(),
          quote.baseAmountMinor.toString(),
          quote.discountAmountMinor.toString(),
          quote.finalAmountMinor.toString(),
          quote.currency,
          now,
        ],
      );
      return {
        ...quote,
        checkoutToken: input.checkoutToken,
        expiresAt: input.expiresAt,
        state: "RESERVED",
      };
    });
  }

  public async consume(
    input: { readonly checkoutToken: string; readonly orderId: string },
    now: Date,
  ): Promise<"CONSUMED" | "IDEMPOTENT" | "UNAVAILABLE"> {
    return this.database.transaction(async (client) => {
      const current = await client.query<{
        readonly state: string;
        readonly order_id: string | null;
        readonly expires_at: Date;
      }>(
        "SELECT state, order_id::text, expires_at FROM promotion_redemptions WHERE checkout_token = $1 FOR UPDATE",
        [input.checkoutToken],
      );
      const row = current.rows[0];
      if (!row) return "UNAVAILABLE";
      if (row.state === "CONSUMED")
        return row.order_id === input.orderId ? "IDEMPOTENT" : "UNAVAILABLE";
      if (row.state !== "RESERVED" || row.expires_at <= now)
        return "UNAVAILABLE";
      const updated = await client.query(
        `UPDATE promotion_redemptions SET state = 'CONSUMED', order_id = $2::uuid,
          consumed_at = $3, updated_at = $3 WHERE checkout_token = $1 AND state = 'RESERVED'`,
        [input.checkoutToken, input.orderId, now],
      );
      return updated.rowCount === 1 ? "CONSUMED" : "UNAVAILABLE";
    });
  }

  public async release(checkoutToken: string, now: Date): Promise<void> {
    await this.database.query(
      "UPDATE promotion_redemptions SET state = 'RELEASED', released_at = $2, updated_at = $2 WHERE checkout_token = $1 AND state = 'RESERVED'",
      [checkoutToken, now],
    );
  }
}

const selectCampaigns = (nowParameter: string): string => `SELECT
  campaign.id::text, campaign.operation_id::text, campaign.name,
  campaign.internal_description, campaign.code, campaign.lifecycle,
  campaign.discount_type, campaign.discount_value::text, campaign.currency,
  campaign.product_scope, campaign.starts_at, campaign.ends_at,
  campaign.minimum_subtotal_minor::text, campaign.usage_limit::text,
  campaign.record_version, campaign.created_at, campaign.updated_at,
  ARRAY(SELECT product.product_id::text FROM promotion_campaign_products product WHERE product.campaign_id = campaign.id ORDER BY product.product_id) AS product_ids,
  (SELECT count(*)::text FROM promotion_redemptions redemption WHERE redemption.campaign_id = campaign.id AND redemption.state = 'CONSUMED') AS consumed_count,
  (SELECT count(*)::text FROM promotion_redemptions redemption WHERE redemption.campaign_id = campaign.id AND redemption.state = 'RESERVED' AND redemption.expires_at > ${nowParameter}) AS reserved_count
  FROM promotion_campaigns campaign`;

const selectRedemption = `SELECT state, checkout_token, campaign_id::text,
  code_snapshot, discount_type_snapshot, discount_value_snapshot::text,
  base_amount_minor::text, discount_amount_minor::text,
  final_amount_minor::text, currency, expires_at FROM promotion_redemptions`;

const mapCampaign = (row: CampaignRow): PromotionCampaign => ({
  code: row.code,
  consumedCount: BigInt(row.consumed_count),
  createdAt: row.created_at,
  currency: row.currency,
  discountType: row.discount_type,
  discountValue: BigInt(row.discount_value),
  endsAt: row.ends_at,
  hasCommittedUsage: BigInt(row.consumed_count) > 0n,
  id: row.id,
  internalDescription: row.internal_description,
  lifecycle: row.lifecycle,
  minimumSubtotalMinor:
    row.minimum_subtotal_minor === null
      ? null
      : BigInt(row.minimum_subtotal_minor),
  name: row.name,
  operationId: row.operation_id,
  productIds: row.product_ids,
  productScope: row.product_scope,
  recordVersion: row.record_version,
  reservedCount: BigInt(row.reserved_count),
  startsAt: row.starts_at,
  updatedAt: row.updated_at,
  usageLimit: row.usage_limit === null ? null : BigInt(row.usage_limit),
});

const mapReservation = (row: RedemptionRow): PromotionReservation => ({
  baseAmountMinor: BigInt(row.base_amount_minor),
  campaignId: row.campaign_id,
  checkoutToken: row.checkout_token,
  code: row.code_snapshot,
  configuredValue: BigInt(row.discount_value_snapshot),
  currency: row.currency,
  discountAmountMinor: BigInt(row.discount_amount_minor),
  discountType: row.discount_type_snapshot,
  expiresAt: row.expires_at,
  finalAmountMinor: BigInt(row.final_amount_minor),
  state: row.state as "RESERVED" | "CONSUMED",
});

const quoteFrom = (
  row: CampaignRow | undefined,
  input: {
    readonly productId: string;
    readonly baseAmountMinor: bigint;
    readonly currency: "EUR";
    readonly maximumDiscountMinor?: bigint;
  },
  now: Date,
): PromotionQuote | null => {
  if (!row) return null;
  const campaign = mapCampaign(row);
  if (
    effectivePromotionStatus(campaign, now) !== "ACTIVE" ||
    campaign.currency !== input.currency ||
    (campaign.minimumSubtotalMinor !== null &&
      input.baseAmountMinor < campaign.minimumSubtotalMinor) ||
    (campaign.productScope === "SELECTED_PRODUCTS" &&
      !campaign.productIds.includes(input.productId)) ||
    (campaign.usageLimit !== null &&
      campaign.consumedCount + campaign.reservedCount >= campaign.usageLimit) ||
    input.baseAmountMinor < 2n
  )
    return null;
  const discount = calculatePromotionDiscount(
    campaign.discountType,
    campaign.discountValue,
    input.baseAmountMinor,
  );
  if (
    discount <= 0n ||
    (input.maximumDiscountMinor !== undefined &&
      discount > input.maximumDiscountMinor)
  )
    return null;
  return {
    baseAmountMinor: input.baseAmountMinor,
    campaignId: campaign.id,
    code: campaign.code,
    configuredValue: campaign.discountValue,
    currency: "EUR",
    discountAmountMinor: discount,
    discountType: campaign.discountType,
    finalAmountMinor: input.baseAmountMinor - discount,
  };
};

const effectiveStatusSql = (alias: string, now: string): string =>
  `CASE WHEN ${alias}.lifecycle <> 'ENABLED' THEN ${alias}.lifecycle WHEN ${alias}.starts_at IS NOT NULL AND ${alias}.starts_at > ${now} THEN 'PLANNED' WHEN ${alias}.ends_at IS NOT NULL AND ${alias}.ends_at <= ${now} THEN 'EXPIRED' ELSE 'ACTIVE' END`;
const usageCountSql = (alias: string, now: string): string =>
  `(SELECT count(*) FROM promotion_redemptions usage WHERE usage.campaign_id = ${alias}.id AND (usage.state = 'CONSUMED' OR (usage.state = 'RESERVED' AND usage.expires_at > ${now})))`;
const promotionOrder = (sort: PromotionListInput["sort"]): string =>
  ({
    NAME_ASC: "campaign.name ASC, campaign.id ASC",
    NAME_DESC: "campaign.name DESC, campaign.id DESC",
    UPDATED_ASC: "campaign.updated_at ASC, campaign.id ASC",
    UPDATED_DESC: "campaign.updated_at DESC, campaign.id DESC",
  })[sort];
const escapeLike = (value: string): string => value.replace(/[\\%_]/gu, "\\$&");
const safeCode = (value: string): string => {
  try {
    return promotionCode(value);
  } catch {
    return "";
  }
};
const required = <T>(value: T | undefined): T => {
  if (!value) throw new Error("Expected PostgreSQL query result");
  return value;
};
const appendAudit = async (
  client: Queryable,
  context: AdminMutationContext,
  id: string,
  reasonCode: string,
  metadata: Readonly<Record<string, string>>,
): Promise<void> => {
  await client.query(
    `INSERT INTO audit_events(id, event_type, timestamp_utc, actor, correlation_id, entity, environment, outcome, reason_code, metadata)
     VALUES (gen_random_uuid(), 'ADMIN_ACTION', $1, $2::jsonb, $3, $4::jsonb, $5, 'SUCCEEDED', $6, $7::jsonb)`,
    [
      context.at,
      JSON.stringify({ id: context.actorId, type: "ADMIN" }),
      context.correlationId,
      JSON.stringify({ id, type: "PROMOTION_CAMPAIGN" }),
      context.environment,
      reasonCode,
      JSON.stringify({ action: reasonCode, ...metadata }),
    ],
  );
};
