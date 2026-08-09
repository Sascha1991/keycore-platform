import type {
  OfferId,
  ProductId,
  SupplierId,
  SupplierOfferId,
  SupplierProductId,
} from "./identifiers.js";
import type { Money } from "./money.js";
import type { GermanyCompatibilityDecision } from "./region.js";

export const platforms = [
  "WINDOWS",
  "MACOS",
  "LINUX",
  "XBOX",
  "PLAYSTATION",
  "NINTENDO",
  "MOBILE",
  "WEB",
  "UNKNOWN",
] as const;

export type Platform = (typeof platforms)[number];

export const productTypes = [
  "GAME",
  "SOFTWARE",
  "DLC",
  "SUBSCRIPTION",
  "GIFT_CARD",
  "UNKNOWN",
] as const;

export type ProductType = (typeof productTypes)[number];

export const availabilityStates = [
  "IN_STOCK",
  "OUT_OF_STOCK",
  "LIMITED",
  "PREORDER",
  "UNKNOWN",
] as const;

export type Availability = (typeof availabilityStates)[number];

export interface ProductSummary {
  readonly productId: ProductId;
  readonly title: string;
  readonly type: ProductType;
  readonly platforms: readonly Platform[];
}

export interface SupplierProductReference {
  readonly supplierId: SupplierId;
  readonly supplierProductId: SupplierProductId;
}

export interface SupplierOfferReference {
  readonly supplierId: SupplierId;
  readonly supplierOfferId: SupplierOfferId;
}

export interface OfferSummary {
  readonly offerId: OfferId;
  readonly productId: ProductId;
  readonly availability: Availability;
  readonly currentPrice: Money;
  readonly germanyCompatibility: GermanyCompatibilityDecision;
}

export interface PriceSnapshot {
  readonly offerId: OfferId;
  readonly capturedAt: Date;
  readonly price: Money;
  readonly availability: Availability;
}
