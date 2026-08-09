import type {
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
  readonly supportsDeltaCatalog: boolean;
  readonly supportsPurchaseStatusReconciliation: boolean;
  readonly supportsDelayedFulfillment: boolean;
  readonly supportsKeyRetrieval: boolean;
  readonly supportsRefundClaims: boolean;
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

export interface PurchaseRequest {
  readonly supplierOfferId: SupplierOfferId;
  readonly orderLineId: OrderLineId;
  readonly clientIdempotencyReference: IdempotencyKey;
  readonly correlationId: CorrelationId;
}

export interface PurchaseReceipt {
  readonly supplierPurchaseReference: string;
  readonly acceptedAt: Date;
  readonly rateLimit?: RateLimitMetadata;
}

export interface SupplierKeyHandle {
  readonly supplierPurchaseReference: string;
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

export interface SupplierPort {
  readonly identity: SupplierIdentity;
  readonly capabilities: SupplierCapabilities;

  listCatalog(page: PageRequest): Promise<Page<ProductSummary>>;
  listCatalogDelta?(
    request: CatalogDeltaRequest,
  ): Promise<Page<ProductSummary>>;
  getProduct(productId: SupplierProductId): Promise<ProductSummary | null>;
  getOffer(offerId: SupplierOfferId): Promise<OfferSummary | null>;
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
