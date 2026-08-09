import type {
  Availability,
  OfferSummary,
  PriceSnapshot,
  ProductSummary,
} from "../domain/catalog.js";
import type {
  CorrelationId,
  IdempotencyKey,
  OrderLineId,
  SupplierId,
  SupplierOfferId,
  SupplierProductId,
} from "../domain/identifiers.js";
import type { RegionEvidence } from "../domain/region.js";
import type { ReconciliationResult } from "../domain/workflow.js";

export interface ContractVersion {
  readonly major: number;
  readonly minor: number;
}

export interface PageRequest {
  readonly cursor?: string;
  readonly limit: number;
}

export interface Page<TItem> {
  readonly items: readonly TItem[];
  readonly nextCursor?: string;
}

export interface RateLimitMetadata {
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetAt?: Date;
}

export interface SupplierCapabilities {
  readonly supportsFullCatalog: boolean;
  readonly supportsDeltaCatalog: boolean;
  readonly supportsPriceLookup: boolean;
  readonly supportsRegionEvidence: boolean;
  readonly supportsPurchase: boolean;
  readonly supportsPurchaseStatusReconciliation: boolean;
  readonly supportsDelayedFulfillment: boolean;
  readonly supportsKeyRetrieval: boolean;
  readonly supportsRefundClaims: boolean;
  readonly supportsHealthRateLimitInfo: boolean;
}

export interface SupplierIdentity {
  readonly supplierId: SupplierId;
  readonly displayName: string;
  readonly contractVersion: ContractVersion;
}

export interface CatalogDeltaRequest {
  readonly since: Date;
  readonly page: PageRequest;
}

export interface NormalizedSupplierProduct {
  readonly supplier: SupplierIdentity;
  readonly supplierProductId: SupplierProductId;
  readonly product: ProductSummary;
  readonly lifecycle: Availability;
  readonly changedAt: Date;
}

export interface NormalizedSupplierOffer {
  readonly supplier: SupplierIdentity;
  readonly supplierOfferId: SupplierOfferId;
  readonly supplierProductId: SupplierProductId;
  readonly offer: OfferSummary;
  readonly regionEvidence: RegionEvidence;
  readonly capturedAt: Date;
  readonly supplierReferenceMetadata: Readonly<
    Record<string, string | number | boolean | null>
  >;
}

export interface PurchaseRequest {
  readonly supplierOfferId: SupplierOfferId;
  readonly orderLineId: OrderLineId;
  readonly clientIdempotencyReference: IdempotencyKey;
  readonly correlationId: CorrelationId;
}

export interface PurchaseReceipt {
  readonly supplierPurchaseReference: string;
  readonly acceptedAt: Date;
  readonly state:
    | "ACCEPTED"
    | "FULFILLED"
    | "DELAYED"
    | "OUT_OF_STOCK"
    | "REJECTED"
    | "AMBIGUOUS";
  readonly rateLimit?: RateLimitMetadata;
}

export interface SupplierKeyHandle {
  readonly supplierPurchaseReference: string;
  readonly keyReference: string;
  readonly receivedAt: Date;
}

export interface SupplierHealth {
  readonly status: "HEALTHY" | "DEGRADED" | "OUTAGE" | "UNKNOWN";
  readonly checkedAt: Date;
  readonly rateLimit?: RateLimitMetadata;
}

export interface RefundClaimRequest {
  readonly supplierPurchaseReference: string;
  readonly orderLineId: OrderLineId;
  readonly correlationId: CorrelationId;
}

export interface RefundClaimReceipt {
  readonly supplierClaimReference: string;
  readonly acceptedAt: Date;
}

export const supplierErrorCategories = [
  "AUTHENTICATION",
  "AUTHORIZATION",
  "RATE_LIMIT",
  "TIMEOUT",
  "TRANSIENT",
  "INVALID_RESPONSE",
  "NOT_FOUND",
  "OUT_OF_STOCK",
  "REJECTED",
  "CONFLICT",
  "UNSUPPORTED_CAPABILITY",
  "UNKNOWN",
] as const;

export type SupplierErrorCategory = (typeof supplierErrorCategories)[number];

export interface SupplierErrorContext {
  readonly supplierId: SupplierId;
  readonly operation: string;
  readonly category: SupplierErrorCategory;
  readonly correlationId?: CorrelationId;
  readonly supplierReference?: string;
}

export interface SupplierPort {
  readonly identity: SupplierIdentity;
  readonly capabilities: SupplierCapabilities;

  listCatalog(page: PageRequest): Promise<Page<NormalizedSupplierProduct>>;
  listCatalogDelta?(
    request: CatalogDeltaRequest,
  ): Promise<Page<NormalizedSupplierProduct>>;
  getProduct(
    productId: SupplierProductId,
  ): Promise<NormalizedSupplierProduct | null>;
  getOffer(offerId: SupplierOfferId): Promise<NormalizedSupplierOffer | null>;
  getCurrentPrice(offerId: SupplierOfferId): Promise<PriceSnapshot>;
  getRegionEvidence(offerId: SupplierOfferId): Promise<RegionEvidence>;
  submitPurchase(request: PurchaseRequest): Promise<PurchaseReceipt>;
  reconcilePurchase(
    supplierPurchaseReference: string,
  ): Promise<ReconciliationResult>;
  retrieveKey?(supplierPurchaseReference: string): Promise<SupplierKeyHandle>;
  getHealth(): Promise<SupplierHealth>;
  submitRefundClaim?(request: RefundClaimRequest): Promise<RefundClaimReceipt>;
}
