import { randomUUID } from "node:crypto";

import type { Availability } from "../domain/catalog.js";
import type { AuditEvent } from "../domain/audit.js";
import type { Money } from "../domain/money.js";
import type {
  CorrelationId,
  ProductId,
  SupplierId,
  SupplierOfferId,
  SupplierProductId,
} from "../domain/identifiers.js";
import type {
  GermanyCompatibilityDecision,
  RegionEvidence,
} from "../domain/region.js";
import type {
  NormalizedSupplierOffer,
  SupplierCapabilities,
  SupplierErrorCategory,
  SupplierHealth,
} from "../ports/supplier.js";
import type { AuditEventPort, ClockPort } from "../ports/core.js";
import type { SupplierObservabilityPort } from "./observability.js";
import type { SupplierRegistry } from "./registry.js";
import { SupplierError } from "./errors.js";

export const routingRejectionReasonCodes = [
  "SUPPLIER_UNAVAILABLE",
  "SUPPLIER_DISABLED",
  "SUPPLIER_DRAINING",
  "UNSUPPORTED_CAPABILITY",
  "PRODUCT_OR_OFFER_UNAVAILABLE",
  "OUT_OF_STOCK",
  "HEALTH_OUTAGE",
  "HEALTH_UNKNOWN",
  "MISSING_PRICE",
  "INVALID_PRICE",
  "STALE_PRICE",
  "REGION_BLOCKED",
  "REGION_REVIEW_REQUIRED",
  "REGION_DISABLED",
  "REGION_UNKNOWN_OR_CONTRADICTORY",
  "VPN_REQUIRED",
  "FOREIGN_ACCOUNT_REQUIRED",
  "UNSUPPORTED_CURRENCY",
  "RATE_LIMITED",
  "MANUAL_REVIEW_REQUIRED",
] as const;

export type RoutingRejectionReasonCode =
  (typeof routingRejectionReasonCodes)[number];

export type SupplierOperationalState = "ENABLED" | "DISABLED" | "DRAINING";

export type RoutingCapabilityRequirement =
  | "PRICE_LOOKUP"
  | "REGION_EVIDENCE"
  | "PURCHASE"
  | "RECONCILIATION"
  | "KEY_RETRIEVAL"
  | "REFUND_CLAIM";

export interface ProductSupplierOfferMapping {
  readonly productId: ProductId;
  readonly supplierId: SupplierId;
  readonly supplierProductId: SupplierProductId;
  readonly supplierOfferId: SupplierOfferId;
}

export interface ProductSupplierMappingPort {
  findSupplierOffers(
    productId: ProductId,
  ): Promise<readonly ProductSupplierOfferMapping[]>;
}

export interface RegionEligibilityPort {
  evaluate(request: {
    readonly supplierId: SupplierId;
    readonly supplierOfferId: SupplierOfferId;
    readonly regionEvidence: RegionEvidence;
  }): Promise<GermanyCompatibilityDecision>;
}

export interface CurrencyConversionPort {
  convert(request: {
    readonly money: Money;
    readonly toCurrency: Money["currency"];
    readonly capturedAt: Date;
  }): Promise<Money | null>;
}

export interface SupplierRoutingPolicy {
  readonly version: string;
  readonly allowedSupplierIds?: readonly SupplierId[];
  readonly supplierStates?: Readonly<Record<string, SupplierOperationalState>>;
  readonly supplierPriority?: readonly SupplierId[];
  readonly maxPriceAgeMs: number;
  readonly requiredHealth: SupplierHealth["status"];
  readonly allowedCurrencies: readonly Money["currency"][];
  readonly allowDegradedSuppliers: boolean;
  readonly allowUnknownHealth: boolean;
  readonly allowReviewRequired: boolean;
  readonly requiredCapabilities: readonly RoutingCapabilityRequirement[];
  readonly comparisonCurrency?: Money["currency"];
}

export interface SupplierCandidateFailure {
  readonly supplierId: SupplierId;
  readonly supplierOfferId?: SupplierOfferId;
  readonly category: SupplierErrorCategory;
  readonly reasonCode: RoutingRejectionReasonCode;
}

export interface SupplierRoutingCandidate {
  readonly supplierId: SupplierId;
  readonly supplierProductId: SupplierProductId;
  readonly supplierOfferId: SupplierOfferId;
  readonly productId: ProductId;
  readonly offer: NormalizedSupplierOffer;
  readonly price: Money;
  readonly comparablePrice?: Money;
  readonly availability: Availability;
  readonly regionEvidence: RegionEvidence;
  readonly regionDecision: GermanyCompatibilityDecision;
  readonly supplierHealth: SupplierHealth;
  readonly capabilities: SupplierCapabilities;
  readonly capturedAt: Date;
  readonly safeMetadata: Readonly<
    Record<string, string | number | boolean | null>
  >;
  readonly status: "ELIGIBLE" | "REJECTED";
  readonly rejectionReasons: readonly RoutingRejectionReasonCode[];
}

export type SupplierSelectionStatus =
  | "SELECTED"
  | "NO_ELIGIBLE_SUPPLIER"
  | "MANUAL_REVIEW_REQUIRED"
  | "NON_COMPARABLE"
  | "DEGRADED_ONLY";

export interface SupplierSelectionResult {
  readonly status: SupplierSelectionStatus;
  readonly selectedCandidate?: SupplierRoutingCandidate;
  readonly evaluatedCandidates: readonly SupplierRoutingCandidate[];
  readonly failures: readonly SupplierCandidateFailure[];
  readonly rejectionReasons: readonly RoutingRejectionReasonCode[];
  readonly correlationId: CorrelationId;
  readonly evaluatedAt: Date;
  readonly policyVersion: string;
}

export type PurchaseAttemptState =
  | "NOT_STARTED"
  | "FAILED_TERMINAL"
  | "FAILED_RETRYABLE"
  | "AMBIGUOUS"
  | "SUCCEEDED";

export type FallbackAction =
  "SAFE_TO_TRY_NEXT" | "RECONCILE_CURRENT_SUPPLIER_FIRST" | "NO_FALLBACK";

export interface SupplierPurchaseAttempt {
  readonly supplierId: SupplierId;
  readonly supplierOfferId: SupplierOfferId;
  readonly state: PurchaseAttemptState;
}

export interface SupplierFallbackPlan {
  readonly action: FallbackAction;
  readonly orderedCandidates: readonly SupplierRoutingCandidate[];
  readonly reasonCode: string;
  readonly correlationId: CorrelationId;
  readonly policyVersion: string;
}

export interface SupplierRoutingRequest {
  readonly productId: ProductId;
  readonly correlationId: CorrelationId;
}

const hasSupplier = (
  values: readonly SupplierId[] | undefined,
  supplierId: SupplierId,
): boolean => values === undefined || values.includes(supplierId);

const supplierState = (
  policy: SupplierRoutingPolicy,
  supplierId: SupplierId,
): SupplierOperationalState => policy.supplierStates?.[supplierId] ?? "ENABLED";

const requiresCapability = (
  capabilities: SupplierCapabilities,
  requirement: RoutingCapabilityRequirement,
): boolean => {
  switch (requirement) {
    case "PRICE_LOOKUP":
      return capabilities.supportsPriceLookup;
    case "REGION_EVIDENCE":
      return capabilities.supportsRegionEvidence;
    case "PURCHASE":
      return capabilities.supportsPurchase;
    case "RECONCILIATION":
      return capabilities.supportsPurchaseStatusReconciliation;
    case "KEY_RETRIEVAL":
      return capabilities.supportsKeyRetrieval;
    case "REFUND_CLAIM":
      return capabilities.supportsRefundClaims;
  }
};

const priceAgeMs = (now: Date, capturedAt: Date): number =>
  now.getTime() - capturedAt.getTime();

const isPositiveMoney = (moneyValue: Money): boolean =>
  moneyValue.amountMinor >= 0n && moneyValue.currency.length === 3;

const uniqueReasons = (
  reasons: readonly RoutingRejectionReasonCode[],
): readonly RoutingRejectionReasonCode[] => [...new Set(reasons)];

const errorCategory = (error: unknown): SupplierErrorCategory =>
  error instanceof SupplierError ? error.category : "UNKNOWN";

const firstReasonForFailure = (
  category: SupplierErrorCategory,
): RoutingRejectionReasonCode => {
  if (category === "RATE_LIMIT") {
    return "RATE_LIMITED";
  }
  if (category === "OUT_OF_STOCK") {
    return "OUT_OF_STOCK";
  }
  if (category === "UNSUPPORTED_CAPABILITY") {
    return "UNSUPPORTED_CAPABILITY";
  }

  return "SUPPLIER_UNAVAILABLE";
};

const priorityIndex = (
  policy: SupplierRoutingPolicy,
  supplierId: SupplierId,
): number => {
  const index = policy.supplierPriority?.indexOf(supplierId) ?? -1;
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
};

const healthRank = (health: SupplierHealth["status"]): number =>
  health === "HEALTHY"
    ? 0
    : health === "DEGRADED"
      ? 1
      : health === "UNKNOWN"
        ? 2
        : 3;

const availabilityRank = (availability: Availability): number => {
  switch (availability) {
    case "IN_STOCK":
      return 0;
    case "LIMITED":
      return 1;
    case "PREORDER":
      return 2;
    case "UNKNOWN":
      return 3;
    case "OUT_OF_STOCK":
      return 4;
  }
};

const safeAuditMetadata = (
  result: SupplierSelectionResult,
): AuditEvent["metadata"] => ({
  candidateCount: result.evaluatedCandidates.length,
  policyVersion: result.policyVersion,
  rejectionReasons: result.rejectionReasons.join(","),
  selectedSupplierId: result.selectedCandidate?.supplierId ?? null,
  selectedSupplierOfferId: result.selectedCandidate?.supplierOfferId ?? null,
  status: result.status,
});

export class SupplierRoutingService {
  public constructor(
    private readonly registry: SupplierRegistry,
    private readonly mappings: ProductSupplierMappingPort,
    private readonly regionEligibility: RegionEligibilityPort,
    private readonly clock: ClockPort,
    private readonly observability?: SupplierObservabilityPort,
    private readonly auditEvents?: AuditEventPort,
    private readonly environment: AuditEvent["environment"] = "CI",
  ) {}

  public async selectSupplier(
    request: SupplierRoutingRequest,
    policy: SupplierRoutingPolicy,
    currencyConversion?: CurrencyConversionPort,
  ): Promise<SupplierSelectionResult> {
    const evaluatedAt = this.clock.now();
    this.observability?.record({
      correlationId: request.correlationId,
      occurredAt: evaluatedAt,
      operation: "selectSupplier",
      supplierId: "routing" as SupplierId,
      type: "SUPPLIER_ROUTING_EVALUATION_STARTED",
    });

    const mappings = await this.mappings.findSupplierOffers(request.productId);
    const discovered = await Promise.all(
      mappings.map((mapping) =>
        this.discoverCandidate(
          mapping,
          request,
          policy,
          evaluatedAt,
          currencyConversion,
        ),
      ),
    );
    const candidates = discovered.flatMap((result) => result.candidate ?? []);
    const failures = discovered.flatMap((result) => result.failure ?? []);
    const eligible = candidates.filter(
      (candidate) => candidate.status === "ELIGIBLE",
    );
    const rejectionReasons = uniqueReasons([
      ...candidates.flatMap((candidate) => candidate.rejectionReasons),
      ...failures.map((failure) => failure.reasonCode),
    ]);
    const result = this.resultForCandidates({
      candidates,
      correlationId: request.correlationId,
      evaluatedAt,
      failures,
      policy,
      rejectionReasons,
      sortedEligible: this.rankEligible(eligible, policy),
    });

    await this.auditSelection(result);
    return result;
  }

  public async createFallbackPlan(request: {
    readonly selection: SupplierSelectionResult;
    readonly attempts: readonly SupplierPurchaseAttempt[];
  }): Promise<SupplierFallbackPlan> {
    const ambiguousAttempt = request.attempts.find(
      (attempt) => attempt.state === "AMBIGUOUS",
    );
    if (ambiguousAttempt) {
      const plan = {
        action: "RECONCILE_CURRENT_SUPPLIER_FIRST",
        correlationId: request.selection.correlationId,
        orderedCandidates: [],
        policyVersion: request.selection.policyVersion,
        reasonCode: "AMBIGUOUS_PURCHASE_REQUIRES_RECONCILIATION",
      } satisfies SupplierFallbackPlan;
      this.observability?.record({
        correlationId: plan.correlationId,
        occurredAt: request.selection.evaluatedAt,
        operation: "createFallbackPlan",
        safeReference: ambiguousAttempt.supplierOfferId,
        supplierId: ambiguousAttempt.supplierId,
        type: "SUPPLIER_RECONCILIATION_REQUIRED_BEFORE_FALLBACK",
      });
      await this.auditFallbackBlocked(plan, ambiguousAttempt);
      return plan;
    }

    const attempted = new Set(
      request.attempts.map(
        (attempt) => `${attempt.supplierId}|${attempt.supplierOfferId}`,
      ),
    );
    const remaining = request.selection.evaluatedCandidates.filter(
      (candidate) =>
        candidate.status === "ELIGIBLE" &&
        !attempted.has(`${candidate.supplierId}|${candidate.supplierOfferId}`),
    );
    const action = remaining.length > 0 ? "SAFE_TO_TRY_NEXT" : "NO_FALLBACK";
    const plan = {
      action,
      correlationId: request.selection.correlationId,
      orderedCandidates: remaining,
      policyVersion: request.selection.policyVersion,
      reasonCode:
        action === "SAFE_TO_TRY_NEXT"
          ? "TERMINAL_FAILURE_ALLOWS_SAFE_FALLBACK"
          : "NO_ELIGIBLE_FALLBACK",
    } satisfies SupplierFallbackPlan;
    this.observability?.record({
      correlationId: plan.correlationId,
      occurredAt: request.selection.evaluatedAt,
      operation: "createFallbackPlan",
      supplierId: "routing" as SupplierId,
      type: "SUPPLIER_FALLBACK_PLAN_CREATED",
    });
    return plan;
  }

  private async discoverCandidate(
    mapping: ProductSupplierOfferMapping,
    request: SupplierRoutingRequest,
    policy: SupplierRoutingPolicy,
    evaluatedAt: Date,
    currencyConversion: CurrencyConversionPort | undefined,
  ): Promise<{
    readonly candidate?: SupplierRoutingCandidate;
    readonly failure?: SupplierCandidateFailure;
  }> {
    try {
      const supplier = this.registry.resolve(mapping.supplierId);
      const [offer, price, regionEvidence, supplierHealth] = await Promise.all([
        supplier.getOffer(mapping.supplierOfferId),
        supplier.getCurrentPrice(mapping.supplierOfferId),
        supplier.getRegionEvidence(mapping.supplierOfferId),
        supplier.getHealth(),
      ]);

      if (!offer) {
        return {
          candidate: this.rejectedCandidateFromMissingOffer(
            mapping,
            price,
            regionEvidence,
            supplierHealth,
            supplier.capabilities,
          ),
        };
      }

      const regionDecision = await this.regionEligibility.evaluate({
        regionEvidence,
        supplierId: mapping.supplierId,
        supplierOfferId: mapping.supplierOfferId,
      });
      const comparablePrice = await this.comparablePrice(
        price.price,
        policy,
        price.capturedAt,
        currencyConversion,
      );
      const rejectionReasons = await this.evaluateCandidate({
        capabilities: supplier.capabilities,
        comparablePrice,
        mapping,
        offer,
        policy,
        price,
        regionDecision,
        regionEvidence,
        supplierHealth,
        now: evaluatedAt,
      });
      const candidateBase = {
        availability: price.availability,
        capabilities: supplier.capabilities,
        capturedAt: price.capturedAt,
        offer,
        price: price.price,
        productId: request.productId,
        regionDecision,
        regionEvidence,
        rejectionReasons,
        safeMetadata: offer.supplierReferenceMetadata,
        status: rejectionReasons.length === 0 ? "ELIGIBLE" : "REJECTED",
        supplierHealth,
        supplierId: mapping.supplierId,
        supplierOfferId: mapping.supplierOfferId,
        supplierProductId: mapping.supplierProductId,
      } satisfies Omit<SupplierRoutingCandidate, "comparablePrice">;
      const candidate = (
        comparablePrice ? { ...candidateBase, comparablePrice } : candidateBase
      ) satisfies SupplierRoutingCandidate;

      this.observability?.record({
        correlationId: request.correlationId,
        occurredAt: evaluatedAt,
        operation: "discoverCandidate",
        safeReference: mapping.supplierOfferId,
        supplierId: mapping.supplierId,
        type:
          candidate.status === "ELIGIBLE"
            ? "SUPPLIER_CANDIDATE_OBTAINED"
            : "SUPPLIER_CANDIDATE_REJECTED",
      });
      return { candidate };
    } catch (error: unknown) {
      const category = errorCategory(error);
      return {
        failure: {
          category,
          reasonCode: firstReasonForFailure(category),
          supplierId: mapping.supplierId,
          supplierOfferId: mapping.supplierOfferId,
        },
      };
    }
  }

  private async comparablePrice(
    price: Money,
    policy: SupplierRoutingPolicy,
    capturedAt: Date,
    currencyConversion: CurrencyConversionPort | undefined,
  ): Promise<Money | undefined> {
    if (
      !policy.comparisonCurrency ||
      price.currency === policy.comparisonCurrency
    ) {
      return price;
    }

    return (
      (await currencyConversion?.convert({
        capturedAt,
        money: price,
        toCurrency: policy.comparisonCurrency,
      })) ?? undefined
    );
  }

  private async evaluateCandidate(request: {
    readonly mapping: ProductSupplierOfferMapping;
    readonly offer: NormalizedSupplierOffer;
    readonly price: {
      readonly price: Money;
      readonly capturedAt: Date;
      readonly availability: Availability;
    };
    readonly regionEvidence: RegionEvidence;
    readonly regionDecision: GermanyCompatibilityDecision;
    readonly supplierHealth: SupplierHealth;
    readonly capabilities: SupplierCapabilities;
    readonly policy: SupplierRoutingPolicy;
    readonly comparablePrice: Money | undefined;
    readonly now: Date;
  }): Promise<readonly RoutingRejectionReasonCode[]> {
    const reasons: RoutingRejectionReasonCode[] = [];
    const state = supplierState(request.policy, request.mapping.supplierId);

    if (
      !hasSupplier(
        request.policy.allowedSupplierIds,
        request.mapping.supplierId,
      )
    ) {
      reasons.push("SUPPLIER_DISABLED");
    }
    if (state === "DISABLED") {
      reasons.push("SUPPLIER_DISABLED");
    }
    if (state === "DRAINING") {
      reasons.push("SUPPLIER_DRAINING");
    }
    if (
      request.policy.requiredCapabilities.some(
        (requirement) => !requiresCapability(request.capabilities, requirement),
      )
    ) {
      reasons.push("UNSUPPORTED_CAPABILITY");
    }
    if (request.price.availability === "OUT_OF_STOCK") {
      reasons.push("OUT_OF_STOCK");
    }
    if (request.price.availability === "UNKNOWN") {
      reasons.push("PRODUCT_OR_OFFER_UNAVAILABLE");
    }
    if (request.supplierHealth.status === "OUTAGE") {
      reasons.push("HEALTH_OUTAGE");
    }
    if (
      request.supplierHealth.status === "UNKNOWN" &&
      !request.policy.allowUnknownHealth
    ) {
      reasons.push("HEALTH_UNKNOWN");
    }
    if (
      request.supplierHealth.status === "DEGRADED" &&
      !request.policy.allowDegradedSuppliers
    ) {
      reasons.push("SUPPLIER_UNAVAILABLE");
    }
    if (
      request.supplierHealth.rateLimit?.remaining !== undefined &&
      request.supplierHealth.rateLimit.remaining <= 0
    ) {
      reasons.push("RATE_LIMITED");
    }
    if (!isPositiveMoney(request.price.price)) {
      reasons.push("INVALID_PRICE");
    }
    if (
      priceAgeMs(request.now, request.price.capturedAt) >
      request.policy.maxPriceAgeMs
    ) {
      reasons.push("STALE_PRICE");
    }
    if (
      !request.policy.allowedCurrencies.includes(request.price.price.currency)
    ) {
      reasons.push("UNSUPPORTED_CURRENCY");
    }
    if (request.regionDecision === "BLOCKED") {
      reasons.push("REGION_BLOCKED");
    }
    if (request.regionDecision === "DISABLED") {
      reasons.push("REGION_DISABLED");
    }
    if (request.regionDecision === "REVIEW_REQUIRED") {
      reasons.push(
        request.policy.allowReviewRequired
          ? "MANUAL_REVIEW_REQUIRED"
          : "REGION_REVIEW_REQUIRED",
      );
    }
    if (
      request.regionEvidence.hasUnknownValues ||
      request.regionEvidence.hasMissingValues ||
      request.regionEvidence.hasContradictoryEvidence
    ) {
      reasons.push("REGION_UNKNOWN_OR_CONTRADICTORY");
    }
    if (request.regionEvidence.requiresVpn === true) {
      reasons.push("VPN_REQUIRED");
    }
    if (request.regionEvidence.requiresForeignAccount === true) {
      reasons.push("FOREIGN_ACCOUNT_REQUIRED");
    }
    if (request.policy.comparisonCurrency && !request.comparablePrice) {
      reasons.push("UNSUPPORTED_CURRENCY");
    }

    return uniqueReasons(reasons);
  }

  private rankEligible(
    eligible: readonly SupplierRoutingCandidate[],
    policy: SupplierRoutingPolicy,
  ): readonly SupplierRoutingCandidate[] {
    return [...eligible].sort((left, right) => {
      const leftPrice = left.comparablePrice ?? left.price;
      const rightPrice = right.comparablePrice ?? right.price;

      return (
        healthRank(left.supplierHealth.status) -
          healthRank(right.supplierHealth.status) ||
        availabilityRank(left.availability) -
          availabilityRank(right.availability) ||
        Number(leftPrice.amountMinor - rightPrice.amountMinor) ||
        priorityIndex(policy, left.supplierId) -
          priorityIndex(policy, right.supplierId) ||
        left.supplierId.localeCompare(right.supplierId) ||
        left.supplierOfferId.localeCompare(right.supplierOfferId)
      );
    });
  }

  private resultForCandidates(request: {
    readonly candidates: readonly SupplierRoutingCandidate[];
    readonly sortedEligible: readonly SupplierRoutingCandidate[];
    readonly failures: readonly SupplierCandidateFailure[];
    readonly rejectionReasons: readonly RoutingRejectionReasonCode[];
    readonly correlationId: CorrelationId;
    readonly evaluatedAt: Date;
    readonly policy: SupplierRoutingPolicy;
  }): SupplierSelectionResult {
    const eligible = request.sortedEligible;
    const eligibleCurrencies = new Set(
      eligible.map(
        (candidate) =>
          candidate.comparablePrice?.currency ?? candidate.price.currency,
      ),
    );

    if (eligible.length === 0) {
      const hasManualReview = request.rejectionReasons.some(
        (reason) =>
          reason === "REGION_REVIEW_REQUIRED" ||
          reason === "MANUAL_REVIEW_REQUIRED" ||
          reason === "REGION_UNKNOWN_OR_CONTRADICTORY",
      );
      const result = {
        correlationId: request.correlationId,
        evaluatedAt: request.evaluatedAt,
        evaluatedCandidates: request.candidates,
        failures: request.failures,
        policyVersion: request.policy.version,
        rejectionReasons: request.rejectionReasons,
        status: hasManualReview
          ? "MANUAL_REVIEW_REQUIRED"
          : "NO_ELIGIBLE_SUPPLIER",
      } satisfies SupplierSelectionResult;
      this.observability?.record({
        correlationId: result.correlationId,
        occurredAt: result.evaluatedAt,
        operation: "selectSupplier",
        supplierId: "routing" as SupplierId,
        type: "SUPPLIER_NO_CANDIDATE_AVAILABLE",
      });
      return result;
    }

    if (!request.policy.comparisonCurrency && eligibleCurrencies.size > 1) {
      return {
        correlationId: request.correlationId,
        evaluatedAt: request.evaluatedAt,
        evaluatedCandidates: request.candidates,
        failures: request.failures,
        policyVersion: request.policy.version,
        rejectionReasons: ["UNSUPPORTED_CURRENCY"],
        status: "NON_COMPARABLE",
      };
    }

    const selectedCandidate = eligible[0];
    if (!selectedCandidate) {
      throw new Error("Expected eligible candidate");
    }

    const result = {
      correlationId: request.correlationId,
      evaluatedAt: request.evaluatedAt,
      evaluatedCandidates: request.candidates,
      failures: request.failures,
      policyVersion: request.policy.version,
      rejectionReasons: request.rejectionReasons,
      selectedCandidate,
      status:
        selectedCandidate.supplierHealth.status === "DEGRADED"
          ? "DEGRADED_ONLY"
          : "SELECTED",
    } satisfies SupplierSelectionResult;
    this.observability?.record({
      correlationId: result.correlationId,
      occurredAt: result.evaluatedAt,
      operation: "selectSupplier",
      safeReference: selectedCandidate.supplierOfferId,
      supplierId: selectedCandidate.supplierId,
      type: "SUPPLIER_CANDIDATE_SELECTED",
    });
    return result;
  }

  private rejectedCandidateFromMissingOffer(
    mapping: ProductSupplierOfferMapping,
    price: {
      readonly price: Money;
      readonly capturedAt: Date;
      readonly availability: Availability;
    },
    regionEvidence: RegionEvidence,
    supplierHealth: SupplierHealth,
    capabilities: SupplierCapabilities,
  ): SupplierRoutingCandidate {
    return {
      availability: price.availability,
      capabilities,
      capturedAt: price.capturedAt,
      offer: {
        capturedAt: price.capturedAt,
        offer: {
          availability: price.availability,
          currentPrice: price.price,
          germanyCompatibility: "REVIEW_REQUIRED",
          offerId: "missing-offer" as never,
          productId: mapping.productId,
        },
        regionEvidence,
        supplier: {
          contractVersion: { major: 1, minor: 0 },
          displayName: "Unavailable supplier offer",
          supplierId: mapping.supplierId,
        },
        supplierOfferId: mapping.supplierOfferId,
        supplierProductId: mapping.supplierProductId,
        supplierReferenceMetadata: {},
      },
      price: price.price,
      productId: mapping.productId,
      regionDecision: "REVIEW_REQUIRED",
      regionEvidence,
      rejectionReasons: ["PRODUCT_OR_OFFER_UNAVAILABLE"],
      safeMetadata: {},
      status: "REJECTED",
      supplierHealth,
      supplierId: mapping.supplierId,
      supplierOfferId: mapping.supplierOfferId,
      supplierProductId: mapping.supplierProductId,
    };
  }

  private async auditSelection(result: SupplierSelectionResult): Promise<void> {
    if (!this.auditEvents) {
      return;
    }

    await this.auditEvents.append({
      actor: { id: "supplier-routing", type: "SYSTEM" },
      correlationId: result.correlationId,
      entity: { id: "supplier-routing", type: "SUPPLIER_ROUTING" },
      environment: this.environment,
      eventType:
        result.status === "SELECTED" || result.status === "DEGRADED_ONLY"
          ? "SUPPLIER_SELECTION_COMPLETED"
          : "SUPPLIER_SELECTION_FAILED",
      metadata: safeAuditMetadata(result),
      outcome:
        result.status === "SELECTED" || result.status === "DEGRADED_ONLY"
          ? "SUCCEEDED"
          : "FAILED",
      reasonCode: result.status,
      timestampUtc: result.evaluatedAt,
      uuid: randomUUID(),
    });
  }

  private async auditFallbackBlocked(
    plan: SupplierFallbackPlan,
    attempt: SupplierPurchaseAttempt,
  ): Promise<void> {
    if (!this.auditEvents) {
      return;
    }

    await this.auditEvents.append({
      actor: { id: "supplier-routing", type: "SYSTEM" },
      correlationId: plan.correlationId,
      entity: { id: attempt.supplierOfferId, type: "SUPPLIER_OFFER" },
      environment: this.environment,
      eventType: "SUPPLIER_FALLBACK_BLOCKED",
      metadata: {
        policyVersion: plan.policyVersion,
        reasonCode: plan.reasonCode,
        supplierId: attempt.supplierId,
        supplierOfferId: attempt.supplierOfferId,
      },
      outcome: "DENIED",
      reasonCode: plan.reasonCode,
      timestampUtc: this.clock.now(),
      uuid: randomUUID(),
    });
  }
}
