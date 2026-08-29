import {
  currency,
  money,
  offerId,
  productId,
  regionCode,
  supplierId,
  supplierOfferId,
  supplierProductId,
  type CatalogDeltaRequest,
  type CatalogOfferDiscoveryPort,
  type NormalizedSupplierOffer,
  type NormalizedSupplierProduct,
  type Page,
  type PageRequest,
  type PriceSnapshot,
  type PurchaseReceipt,
  type ReconciliationResult,
  type RefundClaimReceipt,
  type RegionEvidence,
  type SupplierHealth,
  type SupplierKeyHandle,
  type SupplierPort,
} from "../../packages/platform/src/contracts.js";

export const scaleProductCount = 50_000;
export const scalePageSize = 500;
export const scaleBaselineOfferCount = 60_000;
export const scaleRefreshOfferCount = 55_500;
export const scaleFinalProductCount = 50_100;
export const scaleFinalOfferCount = 60_610;
export const scaleStaleProductCount = 100;
export const scaleStaleOfferCount = 5_110;

export type ScalePhase = "BASELINE" | "REFRESH";
type OfferSlot = "PRIMARY" | "SECONDARY" | "TERTIARY";

const baselineAt = new Date("2026-08-29T00:00:00.000Z");
const refreshAt = new Date("2026-08-30T00:00:00.000Z");
const identity = {
  contractVersion: { major: 1, minor: 0 },
  displayName: "Deterministic Catalog Scale Supplier",
  supplierId: supplierId("synthetic-scale-supplier"),
} as const;

export class DeterministicScaleSupplier implements SupplierPort {
  public readonly identity = identity;
  public readonly capabilities = {
    supportsDelayedFulfillment: false,
    supportsDeltaCatalog: true,
    supportsFullCatalog: true,
    supportsHealthRateLimitInfo: false,
    supportsKeyRetrieval: false,
    supportsPriceLookup: true,
    supportsPurchase: false,
    supportsPurchaseStatusReconciliation: false,
    supportsRefundClaims: false,
    supportsRegionEvidence: true,
  } as const;
  public maxMaterializedProducts = 0;
  private phase: ScalePhase = "BASELINE";
  private readonly pageCounts = new Map<ScalePhase, number>();

  public setPhase(phase: ScalePhase): void {
    this.phase = phase;
  }

  public currentPhase(): ScalePhase {
    return this.phase;
  }

  public pagesFetched(phase: ScalePhase): number {
    return this.pageCounts.get(phase) ?? 0;
  }

  public async listCatalog(
    request: PageRequest,
  ): Promise<Page<NormalizedSupplierProduct>> {
    const offset = parseCursor(request.cursor);
    const limit = Math.min(request.limit, scalePageSize);
    const remaining = Math.max(0, scaleProductCount - offset);
    const count = Math.min(limit, remaining);
    const firstIndex = this.phase === "BASELINE" ? 0 : scaleStaleProductCount;
    const items = Array.from({ length: count }, (_, position) =>
      scaleProduct(firstIndex + offset + position, this.phase),
    );
    this.maxMaterializedProducts = Math.max(
      this.maxMaterializedProducts,
      items.length,
    );
    this.pageCounts.set(this.phase, (this.pageCounts.get(this.phase) ?? 0) + 1);
    const nextOffset = offset + count;
    return nextOffset < scaleProductCount
      ? { items, nextCursor: String(nextOffset) }
      : { items };
  }

  public async listCatalogDelta(
    request: CatalogDeltaRequest,
  ): Promise<Page<NormalizedSupplierProduct>> {
    return this.listCatalog(request.page);
  }

  public async getProduct(
    externalId: ReturnType<typeof supplierProductId>,
  ): Promise<NormalizedSupplierProduct | null> {
    const index = indexFromProductId(externalId);
    return index === null ? null : scaleProduct(index, this.phase);
  }

  public async getOffer(
    externalId: ReturnType<typeof supplierOfferId>,
  ): Promise<NormalizedSupplierOffer | null> {
    const parsed = parseOfferId(externalId);
    return parsed ? scaleOffer(parsed.index, parsed.slot, this.phase) : null;
  }

  public async getCurrentPrice(
    externalId: ReturnType<typeof supplierOfferId>,
  ): Promise<PriceSnapshot> {
    const offer = await this.getOffer(externalId);
    if (!offer) throw new Error("Synthetic scale offer not found");
    return {
      availability: offer.offer.availability,
      capturedAt: offer.capturedAt,
      offerId: offer.offer.offerId,
      price: offer.offer.currentPrice,
    };
  }

  public async getRegionEvidence(
    externalId: ReturnType<typeof supplierOfferId>,
  ): Promise<RegionEvidence> {
    const offer = await this.getOffer(externalId);
    if (!offer) throw new Error("Synthetic scale offer not found");
    return offer.regionEvidence;
  }

  public async submitPurchase(): Promise<PurchaseReceipt> {
    throw new Error("Catalog scale source does not support purchase");
  }

  public async reconcilePurchase(): Promise<ReconciliationResult> {
    throw new Error("Catalog scale source does not support reconciliation");
  }

  public async retrieveKey(): Promise<SupplierKeyHandle> {
    throw new Error("Catalog scale source does not support key retrieval");
  }

  public async getHealth(): Promise<SupplierHealth> {
    return { checkedAt: baselineAt, status: "HEALTHY" };
  }

  public async submitRefundClaim(): Promise<RefundClaimReceipt> {
    throw new Error("Catalog scale source does not support refund claims");
  }
}

export class DeterministicScaleOfferDiscovery implements CatalogOfferDiscoveryPort {
  public maxMaterializedOffers = 0;

  public constructor(private readonly supplier: DeterministicScaleSupplier) {}

  public async listOffersForProduct(input: {
    readonly product: NormalizedSupplierProduct;
  }): Promise<readonly NormalizedSupplierOffer[]> {
    const index = indexFromProductId(input.product.supplierProductId);
    if (index === null)
      throw new Error("Synthetic scale product ID is invalid");
    const phase = this.supplier.currentPhase();
    const offers = offerSlots(index, phase).map((slot) =>
      scaleOffer(index, slot, phase),
    );
    this.maxMaterializedOffers = Math.max(
      this.maxMaterializedOffers,
      offers.length,
    );
    return offers;
  }
}

export const scaleProduct = (
  index: number,
  phase: ScalePhase,
): NormalizedSupplierProduct => {
  const changed = phase === "REFRESH" && index >= 2_100 && index < 2_600;
  return {
    changedAt: changed || index >= scaleProductCount ? refreshAt : baselineAt,
    lifecycle: "IN_STOCK",
    product: {
      platforms: ["WINDOWS"],
      productId: productId(`scale-product-${serial(index)}`),
      title: `Synthetic Scale Product ${serial(index)}${changed ? " Updated" : ""}`,
      type: "GAME",
    },
    supplier: identity,
    supplierProductId: supplierProductId(`scale-sp-${serial(index)}`),
  };
};

export const scaleOffer = (
  index: number,
  slot: OfferSlot,
  phase: ScalePhase,
): NormalizedSupplierOffer => {
  const changed = offerChanged(index, slot, phase);
  const availability = availabilityFor(index, phase);
  const suffix = slot.toLowerCase();
  return {
    capturedAt: changed ? refreshAt : baselineAt,
    offer: {
      availability,
      currentPrice: money(priceFor(index, slot, phase), currency("EUR")),
      germanyCompatibility: "REVIEW_REQUIRED",
      offerId: offerId(`scale-offer-${serial(index)}-${suffix}`),
      productId: productId(`scale-product-${serial(index)}`),
    },
    regionEvidence: evidenceFor(index, phase),
    supplier: identity,
    supplierOfferId: supplierOfferId(`scale-so-${serial(index)}-${suffix}`),
    supplierProductId: supplierProductId(`scale-sp-${serial(index)}`),
    supplierReferenceMetadata: {
      dataset: "ks-11-03-v1",
      index,
      phase: changed ? "REFRESHED" : "BASELINE",
      slot,
    },
  };
};

export const offerSlots = (
  index: number,
  phase: ScalePhase,
): readonly OfferSlot[] => {
  if (phase === "BASELINE") {
    return index % 5 === 0 ? ["PRIMARY", "SECONDARY"] : ["PRIMARY"];
  }
  return [
    "PRIMARY",
    ...(index % 10 === 0 ? (["SECONDARY"] as const) : []),
    ...(index % 100 === 1 ? (["TERTIARY"] as const) : []),
  ];
};

const categoryFor = (index: number, phase: ScalePhase): number => {
  const baseline = index % 5;
  if (phase === "REFRESH" && index >= 100 && index < 600) {
    return baseline === 0 ? 1 : 0;
  }
  return baseline;
};

const evidenceFor = (index: number, phase: ScalePhase): RegionEvidence => {
  const category = categoryFor(index, phase);
  const base = {
    activationRestrictions: [],
    allowedCountries: [],
    excludedCountries: [],
    hasContradictoryEvidence: false,
    hasMissingValues: false,
    hasUnknownValues: false,
    requiresForeignAccount: false,
    requiresVpn: false,
  } as const;
  if (category === 0 || category === 4) {
    return { ...base, allowedCountries: [regionCode("DE")] };
  }
  if (category === 1) {
    return { ...base, excludedCountries: [regionCode("DE")] };
  }
  if (category === 2) {
    return {
      ...base,
      hasMissingValues: true,
      hasUnknownValues: true,
      requiresForeignAccount: "UNKNOWN",
      requiresVpn: "UNKNOWN",
    };
  }
  return {
    ...base,
    activationRestrictions: [
      { description: "Synthetic VPN-only activation", kind: "VPN_REQUIRED" },
    ],
    requiresVpn: true,
  };
};

const availabilityFor = (index: number, phase: ScalePhase) => {
  const baseline = index % 5 === 4 ? "OUT_OF_STOCK" : "IN_STOCK";
  if (phase === "REFRESH" && index >= 600 && index < 1_100) {
    return baseline === "IN_STOCK" ? "OUT_OF_STOCK" : "IN_STOCK";
  }
  return baseline;
};

const priceFor = (
  index: number,
  slot: OfferSlot,
  phase: ScalePhase,
): bigint => {
  const slotOffset = slot === "PRIMARY" ? 0 : slot === "SECONDARY" ? 75 : 125;
  const refreshOffset =
    phase === "REFRESH" && index >= 1_100 && index < 2_100 ? 111 : 0;
  return BigInt(500 + (index % 5_000) + slotOffset + refreshOffset);
};

const offerChanged = (
  index: number,
  slot: OfferSlot,
  phase: ScalePhase,
): boolean =>
  phase === "REFRESH" &&
  (index >= scaleProductCount ||
    slot === "TERTIARY" ||
    (index >= 100 && index < 2_100));

const indexFromProductId = (value: string): number | null => {
  const match = /^scale-sp-(\d{6})$/u.exec(value);
  return match?.[1] ? Number(match[1]) : null;
};

const parseOfferId = (
  value: string,
): { readonly index: number; readonly slot: OfferSlot } | null => {
  const match = /^scale-so-(\d{6})-(primary|secondary|tertiary)$/u.exec(value);
  if (!match?.[1] || !match[2]) return null;
  return {
    index: Number(match[1]),
    slot: match[2].toUpperCase() as OfferSlot,
  };
};

const parseCursor = (cursor: string | undefined): number => {
  if (!cursor) return 0;
  const value = Number(cursor);
  if (!Number.isInteger(value) || value < 0 || value > scaleProductCount) {
    throw new Error("Synthetic scale cursor is invalid");
  }
  return value;
};

const serial = (index: number): string => index.toString().padStart(6, "0");
