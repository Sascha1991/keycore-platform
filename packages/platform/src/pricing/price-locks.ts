import { createHash, randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type { Money } from "../domain/money.js";
import type { CorrelationId, ProductId } from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import type { SafePayload } from "../queue/job.js";
import type {
  PricingService,
  ProductPriceSelection,
  SellPriceQuote,
} from "./pricing-margin.js";

export type PriceLockStatus =
  | "ACTIVE"
  | "CONSUMED"
  | "EXPIRED"
  | "INVALIDATED"
  | "REPRICE_REQUIRED"
  | "BLOCKED";

export type PriceLockValidationStatus =
  "SAFE" | "REPRICE_REQUIRED" | "BLOCKED" | "EXPIRED" | "CONSUMED" | "CONFLICT";

export const priceLockReasonCodes = [
  "PRICE_LOCK_CREATED",
  "PRICE_LOCK_EXPIRED",
  "PRICE_LOCK_ALREADY_CONSUMED",
  "SUPPLIER_PRICE_INCREASED",
  "NO_ELIGIBLE_OFFER",
  "PROFIT_FLOOR_VIOLATION",
  "PRICING_POLICY_CHANGED",
  "PRODUCT_OVERRIDE_CHANGED",
  "MANUAL_PRICE_CHANGED",
  "TAX_POLICY_CHANGED",
  "FEE_POLICY_CHANGED",
  "FX_RATE_CHANGED",
  "STALE_INPUT",
  "PRICING_DISABLED",
  "UNKNOWN_REQUIRED_FEE",
  "UNKNOWN_TAX_TREATMENT",
  "MISSING_FX_RATE",
  "STALE_FX_RATE",
  "PRICE_LOCK_AMOUNT_MISMATCH",
  "CURRENCY_MISMATCH",
  "LOCK_FINGERPRINT_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_LOCK_REQUEST",
  "PRICE_LOCK_SAFE",
  "PRICE_LOCK_CONSUMED",
] as const;

export type PriceLockReasonCode = (typeof priceLockReasonCodes)[number];

export interface PriceLock {
  readonly id: string;
  readonly productId: ProductId;
  readonly currency: Money["currency"];
  readonly lockedSellPrice: Money;
  readonly pricingQuoteFingerprint: string;
  readonly sourceOfferFingerprint: string;
  readonly pricingPolicyVersion: string;
  readonly pricingPolicyRecordVersion: number;
  readonly productOverrideVersion?: number | null;
  readonly manualPriceVersion?: number | null;
  readonly taxPolicyVersion: string;
  readonly feePolicyVersion: string;
  readonly fxRateVersion?: string | null;
  readonly status: PriceLockStatus;
  readonly recordVersion: number;
  readonly idempotencyKey?: string | null;
  readonly idempotencyFingerprint?: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt?: Date | null;
  readonly invalidatedAt?: Date | null;
  readonly reasonCode?: PriceLockReasonCode | null;
  readonly correlationId: CorrelationId;
}

export interface CustomerSafePriceLock {
  readonly priceLockId: string;
  readonly productId: ProductId;
  readonly price: Money;
  readonly expiresAt: Date;
}

export interface PriceLockCreateResult {
  readonly status: "CREATED" | "IDEMPOTENT" | "CONFLICT" | "BLOCKED";
  readonly lock?: PriceLock;
  readonly reasonCode?: PriceLockReasonCode;
}

export interface PriceLockValidationResult {
  readonly status: PriceLockValidationStatus;
  readonly lock: PriceLock;
  readonly reasonCode: PriceLockReasonCode;
  readonly safeOfferFingerprint?: string;
  readonly evaluatedAt: Date;
}

export interface PriceLockConsumptionResult {
  readonly status: "CONSUMED" | "CONFLICT" | "EXPIRED" | "BLOCKED";
  readonly lock: PriceLock;
  readonly reasonCode: PriceLockReasonCode;
}

export interface PriceLockRepository {
  create(lock: PriceLock): Promise<PriceLock>;
  findById(lockId: string): Promise<PriceLock | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<PriceLock | null>;
  updateStatus(input: {
    readonly lockId: string;
    readonly expectedVersion: number;
    readonly status: PriceLockStatus;
    readonly reasonCode: PriceLockReasonCode;
    readonly now: Date;
  }): Promise<PriceLock>;
  consumeIfActive(input: {
    readonly lockId: string;
    readonly expectedVersion: number;
    readonly now: Date;
  }): Promise<PriceLock | null>;
}

export interface PriceLockServiceOptions {
  readonly repository: PriceLockRepository;
  readonly pricing: PricingService;
  readonly audit?: AuditEventPort;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
}

export class PriceLockService {
  private readonly now: () => Date;
  private readonly environment: AuditEvent["environment"];

  public constructor(private readonly options: PriceLockServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.environment = options.environment ?? "LOCAL";
  }

  public async createPriceLock(input: {
    readonly quote: SellPriceQuote;
    readonly expiresAt: Date;
    readonly idempotencyKey: string;
    readonly correlationId: CorrelationId;
  }): Promise<PriceLockCreateResult> {
    const createdAt = this.now();
    const rejection = validateLockableQuote(
      input.quote,
      input.expiresAt,
      createdAt,
    );
    if (rejection) {
      return { reasonCode: rejection, status: "BLOCKED" };
    }

    const fingerprint = priceLockIdempotencyFingerprint({
      expiresAt: input.expiresAt,
      quote: input.quote,
    });
    const existing = await this.options.repository.findByIdempotencyKey(
      input.idempotencyKey,
    );
    if (existing) {
      if (existing.idempotencyFingerprint === fingerprint) {
        return existing.reasonCode
          ? {
              lock: existing,
              reasonCode: existing.reasonCode,
              status: "IDEMPOTENT",
            }
          : { lock: existing, status: "IDEMPOTENT" };
      }
      await this.audit({
        correlationId: input.correlationId,
        eventType: "PRICING_PRICE_LOCK_CONFLICT",
        lock: existing,
        outcome: "DENIED",
        reasonCode: "IDEMPOTENCY_CONFLICT",
      });
      return { reasonCode: "IDEMPOTENCY_CONFLICT", status: "CONFLICT" };
    }

    const lock: PriceLock = {
      correlationId: input.correlationId,
      createdAt,
      currency: input.quote.currency,
      expiresAt: input.expiresAt,
      feePolicyVersion: feePolicyVersion(input.quote),
      id: randomUUID(),
      idempotencyFingerprint: fingerprint,
      idempotencyKey: input.idempotencyKey,
      lockedSellPrice: input.quote.sellPrice,
      pricingPolicyRecordVersion: input.quote.pricingPolicyRecordVersion,
      pricingPolicyVersion: input.quote.pricingPolicyVersion,
      pricingQuoteFingerprint: input.quote.sourceFingerprint,
      productId: input.quote.productId,
      productOverrideVersion: input.quote.productOverrideVersion ?? null,
      manualPriceVersion: input.quote.manualPriceVersion ?? null,
      recordVersion: 1,
      sourceOfferFingerprint: input.quote.sourceFingerprint,
      status: "ACTIVE",
      taxPolicyVersion: input.quote.taxPolicyVersion,
      ...(input.quote.fxRateVersion
        ? { fxRateVersion: input.quote.fxRateVersion }
        : {}),
      reasonCode: "PRICE_LOCK_CREATED",
    };
    const created = await this.options.repository.create(lock);
    await this.audit({
      correlationId: input.correlationId,
      eventType: "PRICING_PRICE_LOCK_CREATED",
      lock: created,
      outcome: "SUCCEEDED",
      reasonCode: "PRICE_LOCK_CREATED",
    });
    return {
      lock: created,
      reasonCode: "PRICE_LOCK_CREATED",
      status: "CREATED",
    };
  }

  public async getPriceLock(lockId: string): Promise<PriceLock | null> {
    return this.options.repository.findById(lockId);
  }

  public async validatePriceLock(
    lockId: string,
    correlationId: CorrelationId,
  ): Promise<PriceLockValidationResult> {
    const lock = await this.requireLock(lockId);
    const evaluatedAt = this.now();
    const terminal = await this.terminalValidation(lock, evaluatedAt);
    if (terminal) {
      await this.auditValidation(terminal, correlationId);
      return terminal;
    }

    const current = await this.options.pricing.quoteProduct({
      correlationId,
      productId: lock.productId,
    });
    const result = await this.evaluateAgainstCurrentSelection({
      correlationId,
      current,
      evaluatedAt,
      lock,
    });
    await this.auditValidation(result, correlationId);
    return result;
  }

  public async consumePriceLock(input: {
    readonly lockId: string;
    readonly expectedVersion: number;
    readonly correlationId: CorrelationId;
  }): Promise<PriceLockConsumptionResult> {
    const validation = await this.validatePriceLock(
      input.lockId,
      input.correlationId,
    );
    if (validation.status !== "SAFE") {
      return {
        lock: validation.lock,
        reasonCode: validation.reasonCode,
        status:
          validation.status === "EXPIRED"
            ? "EXPIRED"
            : validation.status === "CONSUMED" ||
                validation.status === "CONFLICT"
              ? "CONFLICT"
              : "BLOCKED",
      };
    }
    if (validation.lock.recordVersion !== input.expectedVersion) {
      return {
        lock: validation.lock,
        reasonCode: "LOCK_FINGERPRINT_CONFLICT",
        status: "CONFLICT",
      };
    }
    const consumed = await this.options.repository.consumeIfActive({
      expectedVersion: input.expectedVersion,
      lockId: input.lockId,
      now: this.now(),
    });
    if (!consumed) {
      const latest = await this.requireLock(input.lockId);
      return {
        lock: latest,
        reasonCode: "PRICE_LOCK_ALREADY_CONSUMED",
        status: "CONFLICT",
      };
    }
    await this.audit({
      correlationId: input.correlationId,
      eventType: "PRICING_PRICE_LOCK_CONSUMED",
      lock: consumed,
      outcome: "SUCCEEDED",
      reasonCode: "PRICE_LOCK_CONSUMED",
    });
    return {
      lock: consumed,
      reasonCode: "PRICE_LOCK_CONSUMED",
      status: "CONSUMED",
    };
  }

  public customerSafeRepresentation(lock: PriceLock): CustomerSafePriceLock {
    return {
      expiresAt: lock.expiresAt,
      price: lock.lockedSellPrice,
      priceLockId: lock.id,
      productId: lock.productId,
    };
  }

  private async terminalValidation(
    lock: PriceLock,
    evaluatedAt: Date,
  ): Promise<PriceLockValidationResult | null> {
    if (lock.status === "CONSUMED") {
      return {
        evaluatedAt,
        lock,
        reasonCode: "PRICE_LOCK_ALREADY_CONSUMED",
        status: "CONSUMED",
      };
    }
    if (
      lock.status === "EXPIRED" ||
      lock.expiresAt.getTime() <= evaluatedAt.getTime()
    ) {
      const expired =
        lock.status === "EXPIRED"
          ? lock
          : await this.options.repository.updateStatus({
              expectedVersion: lock.recordVersion,
              lockId: lock.id,
              now: evaluatedAt,
              reasonCode: "PRICE_LOCK_EXPIRED",
              status: "EXPIRED",
            });
      return {
        evaluatedAt,
        lock: expired,
        reasonCode: "PRICE_LOCK_EXPIRED",
        status: "EXPIRED",
      };
    }
    if (
      lock.status === "INVALIDATED" ||
      lock.status === "REPRICE_REQUIRED" ||
      lock.status === "BLOCKED"
    ) {
      return {
        evaluatedAt,
        lock,
        reasonCode: lock.reasonCode ?? "LOCK_FINGERPRINT_CONFLICT",
        status:
          lock.status === "REPRICE_REQUIRED" ? "REPRICE_REQUIRED" : "BLOCKED",
      };
    }
    return null;
  }

  private async evaluateAgainstCurrentSelection(input: {
    readonly lock: PriceLock;
    readonly current: ProductPriceSelection;
    readonly evaluatedAt: Date;
    readonly correlationId: CorrelationId;
  }): Promise<PriceLockValidationResult> {
    const safeQuotes = input.current.quotes
      .filter((quote) => quote.status === "QUOTED")
      .filter((quote) => this.lockedPriceStillSafe(input.lock, quote))
      .sort(
        (left, right) =>
          Number(
            left.acquisitionCost.amountMinor -
              right.acquisitionCost.amountMinor,
          ) || left.offerId.localeCompare(right.offerId),
      );
    const safeQuote = safeQuotes[0];
    if (safeQuote) {
      return {
        evaluatedAt: input.evaluatedAt,
        lock: input.lock,
        reasonCode: "PRICE_LOCK_SAFE",
        safeOfferFingerprint: safeQuote.sourceFingerprint,
        status: "SAFE",
      };
    }

    const reasonCode = mapPricingSelectionReason(input.current);
    const status = revalidationStatusFor(reasonCode);
    const updated = await this.options.repository.updateStatus({
      expectedVersion: input.lock.recordVersion,
      lockId: input.lock.id,
      now: input.evaluatedAt,
      reasonCode,
      status: status === "REPRICE_REQUIRED" ? "REPRICE_REQUIRED" : "BLOCKED",
    });
    return {
      evaluatedAt: input.evaluatedAt,
      lock: updated,
      reasonCode,
      status,
    };
  }

  private lockedPriceStillSafe(
    lock: PriceLock,
    quote: SellPriceQuote,
  ): boolean {
    if (quote.productId !== lock.productId) {
      return false;
    }
    if (
      quote.currency !== lock.currency ||
      quote.sellPrice.currency !== lock.currency
    ) {
      return false;
    }
    if (lock.lockedSellPrice.amountMinor <= 0n) {
      return false;
    }
    if (
      quote.hardMinimumSellPrice &&
      lock.lockedSellPrice.amountMinor < quote.hardMinimumSellPrice.amountMinor
    ) {
      return false;
    }
    if (!quote.hardMinimumProfit) {
      return false;
    }
    const lockedProfit =
      lock.lockedSellPrice.amountMinor - quote.acquisitionCost.amountMinor;
    return lockedProfit >= quote.hardMinimumProfit.amountMinor;
  }

  private async requireLock(lockId: string): Promise<PriceLock> {
    const lock = await this.options.repository.findById(lockId);
    if (!lock) {
      throw new Error("Price lock not found");
    }
    return lock;
  }

  private async auditValidation(
    result: PriceLockValidationResult,
    correlationId: CorrelationId,
  ): Promise<void> {
    await this.audit({
      correlationId,
      eventType:
        result.status === "SAFE"
          ? "PRICING_PRICE_LOCK_VALIDATED"
          : result.status === "REPRICE_REQUIRED"
            ? "PRICING_PRICE_LOCK_REPRICE_REQUIRED"
            : result.status === "EXPIRED"
              ? "PRICING_PRICE_LOCK_EXPIRED"
              : result.status === "CONSUMED"
                ? "PRICING_PRICE_LOCK_CONSUMED"
                : "PRICING_PRICE_LOCK_BLOCKED",
      lock: result.lock,
      outcome: result.status === "SAFE" ? "SUCCEEDED" : "DENIED",
      reasonCode: result.reasonCode,
    });
  }

  private async audit(input: {
    readonly lock: PriceLock;
    readonly eventType: AuditEvent["eventType"];
    readonly correlationId: CorrelationId;
    readonly outcome: AuditEvent["outcome"];
    readonly reasonCode: PriceLockReasonCode;
  }): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "price-lock-service", type: "SERVICE" },
      correlationId: input.correlationId,
      entity: { id: input.lock.id, type: "PRICE_LOCK" },
      environment: this.environment,
      eventType: input.eventType,
      metadata: {
        correlationId: input.correlationId,
        currency: input.lock.currency,
        priceLockId: input.lock.id,
        pricingPolicyVersion: input.lock.pricingPolicyVersion,
        productId: input.lock.productId,
        reasonCode: input.reasonCode,
        status: input.lock.status,
      },
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }
}

export const priceLockRevalidationJobPayload = (input: {
  readonly productId: ProductId;
  readonly correlationId: CorrelationId;
  readonly reason: string;
}): SafePayload => ({
  correlationId: input.correlationId,
  productId: input.productId,
  reason: input.reason,
});

export const priceLockIdempotencyFingerprint = (input: {
  readonly quote: SellPriceQuote;
  readonly expiresAt: Date;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        currency: input.quote.currency,
        expiresAt: input.expiresAt.toISOString(),
        fxRateVersion: input.quote.fxRateVersion ?? "",
        manualPriceVersion: input.quote.manualPriceVersion ?? "",
        policyRecordVersion: input.quote.pricingPolicyRecordVersion,
        policyVersion: input.quote.pricingPolicyVersion,
        productId: input.quote.productId,
        quoteFingerprint: input.quote.sourceFingerprint,
        sellPrice: input.quote.sellPrice.amountMinor.toString(),
        taxPolicyVersion: input.quote.taxPolicyVersion,
      }),
    )
    .digest("hex");

const validateLockableQuote = (
  quote: SellPriceQuote,
  expiresAt: Date,
  now: Date,
): PriceLockReasonCode | null => {
  if (quote.status !== "QUOTED") {
    return "INVALID_LOCK_REQUEST";
  }
  if (quote.sellPrice.amountMinor <= 0n) {
    return "INVALID_LOCK_REQUEST";
  }
  if (expiresAt.getTime() <= now.getTime()) {
    return "PRICE_LOCK_EXPIRED";
  }
  if (quote.validUntil && quote.validUntil.getTime() <= now.getTime()) {
    return "STALE_INPUT";
  }
  if (quote.validUntil && expiresAt.getTime() > quote.validUntil.getTime()) {
    return "STALE_INPUT";
  }
  if (!quote.hardMinimumProfit) {
    return "STALE_INPUT";
  }
  return null;
};

const feePolicyVersion = (quote: SellPriceQuote): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        knownFees: quote.knownFees.amountMinor.toString(),
        sourceFingerprint: quote.sourceFingerprint,
      }),
    )
    .digest("hex");

const mapPricingSelectionReason = (
  selection: ProductPriceSelection,
): PriceLockReasonCode => {
  const reason = selection.reasonCode ?? selection.quotes[0]?.reasonCode;
  switch (reason) {
    case "NO_ELIGIBLE_OFFER":
      return "NO_ELIGIBLE_OFFER";
    case "PRICING_DISABLED":
      return "PRICING_DISABLED";
    case "UNKNOWN_SUPPLIER_FEE":
      return "UNKNOWN_REQUIRED_FEE";
    case "UNKNOWN_TAX_TREATMENT":
      return "UNKNOWN_TAX_TREATMENT";
    case "MISSING_FX_RATE":
      return "MISSING_FX_RATE";
    case "STALE_FX_RATE":
      return "STALE_FX_RATE";
    case "STALE_PRICE_INPUT":
      return "STALE_INPUT";
    case "UNSUPPORTED_CURRENCY":
      return "CURRENCY_MISMATCH";
    default:
      return selection.quotes.some((quote) => quote.status === "QUOTED")
        ? "PROFIT_FLOOR_VIOLATION"
        : "SUPPLIER_PRICE_INCREASED";
  }
};

const revalidationStatusFor = (
  reasonCode: PriceLockReasonCode,
): Exclude<
  PriceLockValidationStatus,
  "SAFE" | "EXPIRED" | "CONSUMED" | "CONFLICT"
> =>
  reasonCode === "NO_ELIGIBLE_OFFER" ||
  reasonCode === "PROFIT_FLOOR_VIOLATION" ||
  reasonCode === "SUPPLIER_PRICE_INCREASED"
    ? "REPRICE_REQUIRED"
    : "BLOCKED";
