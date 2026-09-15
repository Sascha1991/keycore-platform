import { randomUUID } from "node:crypto";

import type {
  AuditEvent,
  AuditEventPort,
  CorrelationId,
} from "../contracts.js";
import { validateAuditEvent } from "../contracts.js";
import {
  AdminAccessError,
  hasAdminCapability,
  type AdminPrincipal,
} from "../admin/admin-orders.js";
import type { AdminMutationContext } from "../admin/admin-staff.js";

export const promotionLifecycles = [
  "DRAFT",
  "ENABLED",
  "DISABLED",
  "ARCHIVED",
] as const;
export type PromotionLifecycle = (typeof promotionLifecycles)[number];
export const promotionDiscountTypes = ["PERCENTAGE", "FIXED_AMOUNT"] as const;
export type PromotionDiscountType = (typeof promotionDiscountTypes)[number];
export const promotionProductScopes = [
  "ALL_ELIGIBLE_PRODUCTS",
  "SELECTED_PRODUCTS",
] as const;
export type PromotionProductScope = (typeof promotionProductScopes)[number];
export const promotionEffectiveStatuses = [
  "DRAFT",
  "PLANNED",
  "ACTIVE",
  "DISABLED",
  "EXPIRED",
  "ARCHIVED",
] as const;
export type PromotionEffectiveStatus =
  (typeof promotionEffectiveStatuses)[number];
export type PromotionSort =
  "UPDATED_DESC" | "UPDATED_ASC" | "NAME_ASC" | "NAME_DESC";

export interface PromotionCampaign {
  readonly id: string;
  readonly operationId: string;
  readonly name: string;
  readonly internalDescription: string;
  readonly code: string;
  readonly lifecycle: PromotionLifecycle;
  readonly discountType: PromotionDiscountType;
  /** Percentage basis points or fixed EUR minor units. */
  readonly discountValue: bigint;
  readonly currency: "EUR";
  readonly productScope: PromotionProductScope;
  readonly productIds: readonly string[];
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly minimumSubtotalMinor: bigint | null;
  readonly usageLimit: bigint | null;
  readonly consumedCount: bigint;
  readonly reservedCount: bigint;
  readonly hasCommittedUsage: boolean;
  readonly recordVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PromotionUsageEvidence {
  readonly orderId: string;
  readonly consumedAt: Date;
  readonly discountAmountMinor: bigint;
  readonly finalAmountMinor: bigint;
  readonly currency: "EUR";
}

export interface PromotionDetail extends PromotionCampaign {
  readonly recentUsage: readonly PromotionUsageEvidence[];
  readonly selectedProducts: readonly PromotionProductOption[];
}

export interface PromotionProductOption {
  readonly id: string;
  readonly title: string;
  readonly platform: string;
  readonly active: boolean;
}

export interface PromotionOverview {
  readonly campaigns: readonly PromotionCampaign[];
  readonly totalCount: number;
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly active: number;
  readonly planned: number;
  readonly attention: number;
}

export interface PromotionQuote {
  readonly campaignId: string;
  readonly code: string;
  readonly discountType: PromotionDiscountType;
  readonly configuredValue: bigint;
  readonly baseAmountMinor: bigint;
  readonly discountAmountMinor: bigint;
  readonly finalAmountMinor: bigint;
  readonly currency: "EUR";
}

export interface PromotionReservation extends PromotionQuote {
  readonly checkoutToken: string;
  readonly expiresAt: Date;
  readonly state: "RESERVED" | "CONSUMED";
}

export interface PromotionListInput {
  readonly search?: string;
  readonly status?: PromotionEffectiveStatus;
  readonly discountType?: PromotionDiscountType;
  readonly productScope?: PromotionProductScope;
  readonly usage?: "LIMITED" | "UNLIMITED" | "LIMIT_REACHED";
  readonly sort: PromotionSort;
  readonly page: number;
  readonly limit: number;
}

export interface PromotionCreateInput {
  readonly id: string;
  readonly operationId: string;
  readonly name: string;
  readonly internalDescription: string;
  readonly code: string;
  readonly discountType: PromotionDiscountType;
  readonly discountValue: bigint;
  readonly currency: "EUR";
  readonly productScope: PromotionProductScope;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly minimumSubtotalMinor: bigint | null;
  readonly usageLimit: bigint | null;
}

export interface PromotionUpdateInput extends Omit<
  PromotionCreateInput,
  "id" | "operationId"
> {
  readonly id: string;
  readonly expectedVersion: number;
}

export interface PromotionRepository {
  list(input: PromotionListInput, now: Date): Promise<PromotionOverview>;
  find(id: string, now: Date): Promise<PromotionDetail | null>;
  create(
    input: PromotionCreateInput,
    context: AdminMutationContext,
  ): Promise<{
    readonly id: string;
    readonly status: "CREATED" | "IDEMPOTENT" | "DUPLICATE";
  }>;
  update(
    input: PromotionUpdateInput,
    context: AdminMutationContext,
  ): Promise<"UPDATED" | "STALE" | "NOT_FOUND" | "IMMUTABLE">;
  setProductEligibility(
    input: {
      readonly id: string;
      readonly expectedVersion: number;
      readonly productId: string;
      readonly selected: boolean;
    },
    context: AdminMutationContext,
  ): Promise<"UPDATED" | "STALE" | "NOT_FOUND" | "INVALID">;
  searchProducts(
    search: string,
    limit: number,
  ): Promise<readonly PromotionProductOption[]>;
  transition(
    input: {
      readonly id: string;
      readonly expectedVersion: number;
      readonly lifecycle: PromotionLifecycle;
    },
    context: AdminMutationContext,
  ): Promise<"UPDATED" | "STALE" | "NOT_FOUND" | "INVALID">;
  quote(
    input: {
      readonly code: string;
      readonly productId: string;
      readonly baseAmountMinor: bigint;
      readonly currency: "EUR";
      readonly maximumDiscountMinor?: bigint;
    },
    now: Date,
  ): Promise<PromotionQuote | null>;
  findReservation(
    checkoutToken: string,
    now: Date,
  ): Promise<PromotionReservation | null>;
  reserve(
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
  ): Promise<PromotionReservation | null>;
  consume(
    input: { readonly checkoutToken: string; readonly orderId: string },
    now: Date,
  ): Promise<"CONSUMED" | "IDEMPOTENT" | "UNAVAILABLE">;
  release(checkoutToken: string, now: Date): Promise<void>;
}

export class PromotionConflictError extends Error {
  public constructor(public readonly reason: "STALE" | "IMMUTABLE") {
    super(`Promotion mutation conflict: ${reason}`);
    this.name = "PromotionConflictError";
  }
}

export class AdminPromotionService {
  public constructor(
    private readonly repository: PromotionRepository,
    private readonly audit: AuditEventPort,
    private readonly environment: AuditEvent["environment"],
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async list(
    principal: AdminPrincipal,
    query: Readonly<Record<string, string | undefined>>,
    correlationId: CorrelationId,
  ): Promise<PromotionOverview> {
    await this.require(principal, "PROMOTION_VIEW", correlationId);
    return this.repository.list(parseListInput(query), this.now());
  }

  public async detail(
    principal: AdminPrincipal,
    id: string,
    correlationId: CorrelationId,
  ): Promise<PromotionDetail | null> {
    await this.require(principal, "PROMOTION_VIEW", correlationId);
    return this.repository.find(canonicalUuid(id), this.now());
  }

  public async searchProducts(
    principal: AdminPrincipal,
    search: string,
    correlationId: CorrelationId,
  ): Promise<readonly PromotionProductOption[]> {
    await this.require(principal, "PROMOTION_MANAGE", correlationId);
    return this.repository.searchProducts(optionalBoundedText(search, 120), 20);
  }

  public async create(
    principal: AdminPrincipal,
    input: Readonly<Record<string, string>>,
    correlationId: CorrelationId,
  ): Promise<string> {
    await this.require(principal, "PROMOTION_MANAGE", correlationId);
    const result = await this.repository.create(
      {
        ...parseMutationInput(input),
        id: randomUUID(),
        operationId: canonicalUuid(input.operationId ?? ""),
      },
      this.context(principal, correlationId),
    );
    if (result.status === "DUPLICATE")
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    return result.id;
  }

  public async update(
    principal: AdminPrincipal,
    id: string,
    input: Readonly<Record<string, string>>,
    correlationId: CorrelationId,
  ): Promise<void> {
    await this.require(principal, "PROMOTION_MANAGE", correlationId);
    const result = await this.repository.update(
      {
        ...parseMutationInput(input),
        expectedVersion: positiveInteger(input.expectedVersion ?? ""),
        id: canonicalUuid(id),
      },
      this.context(principal, correlationId),
    );
    this.assertMutationResult(result);
  }

  public async setProductEligibility(
    principal: AdminPrincipal,
    id: string,
    input: Readonly<Record<string, string>>,
    correlationId: CorrelationId,
  ): Promise<void> {
    await this.require(principal, "PROMOTION_MANAGE", correlationId);
    const result = await this.repository.setProductEligibility(
      {
        expectedVersion: positiveInteger(input.expectedVersion ?? ""),
        id: canonicalUuid(id),
        productId: canonicalUuid(input.productId ?? ""),
        selected:
          input.action === "add"
            ? true
            : input.action === "remove"
              ? false
              : invalid(),
      },
      this.context(principal, correlationId),
    );
    this.assertMutationResult(result);
  }

  public async transition(
    principal: AdminPrincipal,
    id: string,
    input: Readonly<Record<string, string>>,
    correlationId: CorrelationId,
  ): Promise<void> {
    await this.require(principal, "PROMOTION_MANAGE", correlationId);
    const lifecycle = promotionLifecycles.includes(
      input.lifecycle as PromotionLifecycle,
    )
      ? (input.lifecycle as PromotionLifecycle)
      : invalid();
    if (lifecycle === "DRAFT") invalid();
    const result = await this.repository.transition(
      {
        expectedVersion: positiveInteger(input.expectedVersion ?? ""),
        id: canonicalUuid(id),
        lifecycle,
      },
      this.context(principal, correlationId),
    );
    this.assertMutationResult(result);
  }

  private assertMutationResult(
    result: "UPDATED" | "STALE" | "NOT_FOUND" | "INVALID" | "IMMUTABLE",
  ): void {
    if (result === "NOT_FOUND")
      throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    if (result === "STALE" || result === "IMMUTABLE")
      throw new PromotionConflictError(result);
    if (result !== "UPDATED") throw new AdminAccessError("ADMIN_INPUT_INVALID");
  }

  private async require(
    principal: AdminPrincipal,
    capability: "PROMOTION_VIEW" | "PROMOTION_MANAGE",
    correlationId: CorrelationId,
  ): Promise<void> {
    if (
      hasAdminCapability(principal, "ADMIN_ACCESS") &&
      hasAdminCapability(principal, capability)
    )
      return;
    await this.audit.append(
      validateAuditEvent({
        actor: { id: principal.adminId, type: "ADMIN" },
        correlationId,
        entity: { id: "admin-promotions", type: "ADMIN_PORTAL" },
        environment: this.environment,
        eventType: "ADMIN_ACTION",
        metadata: {
          action: "ADMIN_PROMOTION_ACCESS_DENIED",
          requiredCapability: capability,
        },
        outcome: "DENIED",
        reasonCode: "ADMIN_ACCESS_DENIED",
        timestampUtc: this.now(),
        uuid: randomUUID(),
      }),
    );
    throw new AdminAccessError("ADMIN_ACCESS_DENIED");
  }

  private context(
    principal: AdminPrincipal,
    correlationId: CorrelationId,
  ): AdminMutationContext {
    return {
      actorId: principal.adminId,
      at: this.now(),
      correlationId,
      environment: this.environment,
    };
  }
}

export const effectivePromotionStatus = (
  campaign: Pick<PromotionCampaign, "lifecycle" | "startsAt" | "endsAt">,
  now: Date,
): PromotionEffectiveStatus => {
  if (campaign.lifecycle !== "ENABLED") return campaign.lifecycle;
  if (campaign.startsAt && now < campaign.startsAt) return "PLANNED";
  if (campaign.endsAt && now >= campaign.endsAt) return "EXPIRED";
  return "ACTIVE";
};

export const calculatePromotionDiscount = (
  type: PromotionDiscountType,
  value: bigint,
  base: bigint,
): bigint => {
  const calculated = type === "PERCENTAGE" ? (base * value) / 10_000n : value;
  return calculated >= base ? base - 1n : calculated;
};

export const promotionCode = (value: string): string => {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/u.test(normalized)) invalid();
  return normalized;
};

export const parsePercentageBasisPoints = (value: string): bigint => {
  const normalized = value.trim().replace(",", ".");
  if (!/^(?:[1-9][0-9]?)(?:\.[0-9]{1,2})?$/u.test(normalized)) invalid();
  const [whole = "0", fraction = ""] = normalized.split(".");
  const basisPoints = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (basisPoints < 1n || basisPoints > 9_999n) invalid();
  return basisPoints;
};

export const parseEuroMinorUnits = (value: string): bigint => {
  const normalized = value.trim().replace(",", ".");
  if (!/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/u.test(normalized)) invalid();
  const [whole = "0", fraction = ""] = normalized.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount < 1n) invalid();
  return amount;
};

const parseMutationInput = (
  input: Readonly<Record<string, string>>,
): Omit<PromotionCreateInput, "id" | "operationId"> => {
  const discountType = promotionDiscountTypes.includes(
    input.discountType as PromotionDiscountType,
  )
    ? (input.discountType as PromotionDiscountType)
    : invalid();
  const productScope = promotionProductScopes.includes(
    input.productScope as PromotionProductScope,
  )
    ? (input.productScope as PromotionProductScope)
    : invalid();
  const startsAt = optionalDate(input.startsAt ?? "");
  const endsAt = optionalDate(input.endsAt ?? "");
  if (startsAt && endsAt && startsAt >= endsAt) invalid();
  return {
    code: promotionCode(input.code ?? ""),
    currency: "EUR",
    discountType,
    discountValue:
      discountType === "PERCENTAGE"
        ? parsePercentageBasisPoints(input.discountValue ?? "")
        : parseEuroMinorUnits(input.discountValue ?? ""),
    endsAt,
    internalDescription: optionalBoundedText(
      input.internalDescription ?? "",
      500,
    ),
    minimumSubtotalMinor: optionalMoney(input.minimumSubtotal ?? ""),
    name: boundedText(input.name ?? "", 120),
    productScope,
    startsAt,
    usageLimit: optionalPositiveBigInt(input.usageLimit ?? ""),
  };
};

const parseListInput = (
  query: Readonly<Record<string, string | undefined>>,
): PromotionListInput => {
  const discountType = optionalAllowed(
    query.discountType,
    promotionDiscountTypes,
  );
  const productScope = optionalAllowed(
    query.productScope,
    promotionProductScopes,
  );
  const status = optionalAllowed(query.status, promotionEffectiveStatuses);
  const usage = optionalAllowed(query.usage, [
    "LIMITED",
    "UNLIMITED",
    "LIMIT_REACHED",
  ] as const);
  return {
    ...(discountType ? { discountType } : {}),
    limit: optionalAllowed(query.limit, ["10", "25", "50"] as const)
      ? Number(query.limit)
      : 10,
    page: query.page ? positiveInteger(query.page) : 1,
    ...(productScope ? { productScope } : {}),
    ...(query.search ? { search: optionalBoundedText(query.search, 120) } : {}),
    sort:
      optionalAllowed(query.sort, [
        "UPDATED_DESC",
        "UPDATED_ASC",
        "NAME_ASC",
        "NAME_DESC",
      ] as const) ?? "UPDATED_DESC",
    ...(status ? { status } : {}),
    ...(usage ? { usage } : {}),
  };
};

const optionalAllowed = <T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | undefined => {
  if (!value) return undefined;
  return allowed.includes(value as T) ? (value as T) : invalid();
};
const invalid = (): never => {
  throw new AdminAccessError("ADMIN_INPUT_INVALID");
};
const boundedText = (value: string, max: number): string => {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > max ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  )
    invalid();
  return normalized;
};
const optionalBoundedText = (value: string, max: number): string => {
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized))
    invalid();
  return normalized;
};
const canonicalUuid = (value: string): string => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
    invalid();
  return value.toLowerCase();
};
const positiveBigInt = (value: string): bigint => {
  if (!/^[1-9][0-9]{0,14}$/u.test(value)) invalid();
  return BigInt(value);
};
const optionalPositiveBigInt = (value: string): bigint | null =>
  value.trim() === "" ? null : positiveBigInt(value);
const optionalMoney = (value: string): bigint | null =>
  value.trim() === "" ? null : parseEuroMinorUnits(value);
const positiveInteger = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) invalid();
  return parsed;
};
const optionalDate = (value: string): Date | null => {
  if (!value.trim()) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalid();
  return parsed;
};
