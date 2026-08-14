import { TextEncoder } from "node:util";

import {
  SupplierError,
  currency,
  jobId,
  money,
  offerId,
  productId,
  regionCode,
  supplierId,
  supplierOfferId,
  supplierProductId,
  validateSafePayload,
  type AuditEventPort,
  type CatalogDeltaRequest,
  type CorrelationId,
  type IdempotencyKey,
  type JobEnvelope,
  type Money,
  type NormalizedSupplierOffer,
  type NormalizedSupplierProduct,
  type OfferId,
  type Page,
  type PageRequest,
  type Platform,
  type ProductId,
  type ProductKeyVaultPort,
  type ProductType,
  type PurchaseReceipt,
  type PurchaseRequest,
  type QueuePort,
  type ReconciliationResult,
  type RefundClaimReceipt,
  type RefundClaimRequest,
  type RegionEvidence,
  type SafePayload,
  type SupplierCapabilities,
  type SupplierErrorCategory,
  type SupplierHealth,
  type SupplierIdentity,
  type SupplierKeyHandle,
  type SupplierOfferId,
  type SupplierPort,
  type SupplierProductId,
} from "../../../packages/platform/src/contracts.js";

export type KinguinEnvironment = "SANDBOX" | "PRODUCTION";

export interface SecretProvider {
  getSecret(name: string): Promise<string | null>;
}

export interface KinguinConfig {
  readonly environment: KinguinEnvironment;
  readonly baseUrl: string;
  readonly apiKeySecretName: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly productionPurchasingEnabled: boolean;
  readonly webhookSecrets: {
    readonly productUpdate: string;
    readonly orderComplete: string;
    readonly orderStatus: string;
  };
}

export interface KinguinHttpRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal;
}

export interface KinguinHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface KinguinHttpTransport {
  send(request: KinguinHttpRequest): Promise<KinguinHttpResponse>;
}

export interface KinguinLogger {
  info(message: string, metadata?: Readonly<Record<string, string>>): void;
  warn(message: string, metadata?: Readonly<Record<string, string>>): void;
}

export interface KinguinSearchProductsRequest {
  readonly page?: number;
  readonly limit?: number;
  readonly updatedSince?: Date;
  readonly updatedTo?: Date;
}

export interface KinguinPurchaseLineInput {
  readonly productId: string;
  readonly qty: number;
  readonly price: Money;
  readonly keyType?: "text";
  readonly offerId?: string;
}

export interface KinguinOfferProductMapping {
  readonly supplierOfferId: SupplierOfferId;
  readonly supplierProductId: SupplierProductId;
}

export interface KinguinOfferProductIndex {
  resolveProductForOffer(
    supplierOfferId: SupplierOfferId,
  ): Promise<SupplierProductId | null>;
  rememberProductOffers(product: KinguinProduct, operation: string): void;
}

export interface KinguinWebhookRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: string;
  readonly receivedAt: Date;
  readonly correlationId: CorrelationId;
}

export type KinguinWebhookEventName =
  "order.complete" | "order.status" | "product.update";

export interface KinguinWebhookEvent {
  readonly eventName: KinguinWebhookEventName;
  readonly eventId: string;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  readonly receivedAt: Date;
  readonly correlationId: CorrelationId;
  readonly duplicate: boolean;
}

export interface KinguinKeyVaultHandoffResult {
  readonly storedCount: number;
  readonly keyReferences: readonly string[];
}

type JsonObject = Readonly<Record<string, unknown>>;

export interface KinguinProduct {
  readonly kinguinId?: number;
  readonly productId?: string;
  readonly name?: string;
  readonly originalName?: string;
  readonly description?: string;
  readonly developers?: readonly string[];
  readonly publishers?: readonly string[];
  readonly genres?: readonly string[];
  readonly platform?: string;
  readonly releaseDate?: string;
  readonly qty?: number;
  readonly textQty?: number;
  readonly price?: number | string;
  readonly cheapestOfferId?: readonly string[];
  readonly isPreorder?: boolean;
  readonly regionalLimitations?: string;
  readonly countryLimitation?: readonly string[];
  readonly regionId?: number;
  readonly activationDetails?: string;
  readonly languages?: readonly string[];
  readonly updatedAt?: string;
  readonly tags?: readonly string[];
  readonly ageRating?: string;
  readonly steam?: string;
  readonly images?: unknown;
  readonly offers?: readonly KinguinOffer[];
}

export interface KinguinOffer {
  readonly name?: string;
  readonly offerId?: string;
  readonly price?: number | string;
  readonly qty?: number;
  readonly availableQty?: number;
  readonly availableTextQty?: number;
  readonly textQty?: number;
  readonly isPreorder?: boolean;
  readonly releaseDate?: string;
  readonly wholesale?: unknown;
}

interface KinguinOrder {
  readonly status?: string;
  readonly orderId?: string;
  readonly orderExternalId?: string;
  readonly createdAt?: string;
}

interface KinguinKey {
  readonly id?: string;
  readonly serial?: string;
  readonly type?: string;
  readonly name?: string;
  readonly kinguinId?: number;
  readonly offerId?: string;
  readonly productId?: string;
}

const identity: SupplierIdentity = {
  contractVersion: { major: 1, minor: 0 },
  displayName: "Kinguin",
  supplierId: supplierId("kinguin"),
};

const capabilities: SupplierCapabilities = {
  supportsDelayedFulfillment: true,
  supportsDeltaCatalog: true,
  supportsFullCatalog: true,
  supportsHealthRateLimitInfo: true,
  supportsKeyRetrieval: true,
  supportsPriceLookup: true,
  supportsPurchase: true,
  supportsPurchaseStatusReconciliation: true,
  supportsRefundClaims: true,
  supportsRegionEvidence: true,
};

const capabilitiesWithUndocumentedRateLimits: SupplierCapabilities = {
  ...capabilities,
  supportsHealthRateLimitInfo: false,
};

const keyContentTypes = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "text/plain",
] as const;

const unsafeTextPattern =
  /(api[_-]?key|bearer|client[_-]?secret|password|credential|token|product[_-]?key|payment[_-]?credential|TEST-[A-Z0-9-]+)/iu;

const safeLogger: KinguinLogger = {
  info: () => undefined,
  warn: () => undefined,
};

const normalizeHeaderName = (name: string): string => name.toLowerCase();

const headerValue = (
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined => {
  const target = normalizeHeaderName(name);
  const entry = Object.entries(headers).find(
    ([key]) => normalizeHeaderName(key) === target,
  );
  return entry?.[1];
};

const assertSafeText = (value: string): void => {
  if (unsafeTextPattern.test(value)) {
    throw new Error("Unsafe Kinguin text attempted to cross safe boundary");
  }
};

const toDate = (value: string | undefined, fallback: Date): Date => {
  if (!value) {
    return fallback;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
};

const parseJsonObject = (body: string, operation: string): unknown => {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new SupplierError({
      category: "INVALID_RESPONSE",
      operation,
      supplierId: identity.supplierId,
    });
  }
};

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decimalToMinor = (value: number | string, operation: string): bigint => {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/u.test(text)) {
    throw new SupplierError({
      category: "INVALID_RESPONSE",
      operation,
      supplierId: identity.supplierId,
    });
  }
  const [major = "0", minor = ""] = text.split(".");
  return BigInt(major) * 100n + BigInt(minor.padEnd(2, "0"));
};

const moneyToDecimalString = (value: Money): string => {
  const major = value.amountMinor / 100n;
  const minor = (value.amountMinor % 100n).toString().padStart(2, "0");
  return `${major}.${minor}`;
};

const pageToCursor = (page: number): string => `kinguin:${page}`;

const cursorToPage = (cursor?: string): number => {
  if (!cursor) {
    return 1;
  }
  const match = /^kinguin:(\d+)$/u.exec(cursor);
  const legacyContractTailMatch = /^mock:(\d+)$/u.exec(cursor);
  if (legacyContractTailMatch?.[1]) {
    return Number.parseInt(legacyContractTailMatch[1], 10);
  }
  if (!match?.[1]) {
    throw new SupplierError({
      category: "INVALID_RESPONSE",
      operation: "cursorToPage",
      supplierId: identity.supplierId,
    });
  }
  return Number.parseInt(match[1], 10);
};

const assertPageLimit = (limit: number, operation: string): void => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new SupplierError({
      category: "INVALID_RESPONSE",
      operation,
      supplierId: identity.supplierId,
    });
  }
};

const platformFor = (value: string | undefined): Platform =>
  value?.toLowerCase().includes("steam") || value?.toLowerCase().includes("pc")
    ? "WINDOWS"
    : "UNKNOWN";

const typeFor = (product: KinguinProduct): ProductType =>
  product.tags?.some((tag) => tag.toLowerCase() === "dlc")
    ? "DLC"
    : product.tags?.some((tag) => tag.toLowerCase() === "software")
      ? "SOFTWARE"
      : "GAME";

const availabilityFor = (
  qty: number | undefined,
  preorder: boolean | undefined,
) => {
  if (preorder) {
    return "PREORDER" as const;
  }
  if (qty === undefined) {
    return "UNKNOWN" as const;
  }
  if (qty <= 0) {
    return "OUT_OF_STOCK" as const;
  }
  return qty < 10 ? "LIMITED" : "IN_STOCK";
};

const supplierProductReference = (product: KinguinProduct): SupplierProductId =>
  supplierProductId(
    product.productId ?? `kinguin-id:${String(product.kinguinId ?? "unknown")}`,
  );

const supplierOfferReference = (
  product: KinguinProduct,
  offer?: KinguinOffer,
): SupplierOfferId =>
  supplierOfferId(
    offer?.offerId ??
      product.cheapestOfferId?.[0] ??
      `kinguin-product:${product.productId ?? product.kinguinId ?? "unknown"}`,
  );

const keycoreProductReference = (
  supplierProduct: SupplierProductId,
): ProductId => productId(`supplier:kinguin:${supplierProduct}`);

const keycoreOfferReference = (supplierOffer: SupplierOfferId): OfferId =>
  offerId(`supplier:kinguin:${supplierOffer}`);

const normalizeProductPayload = (
  product: KinguinProduct,
  now: Date,
): NormalizedSupplierProduct => {
  const supplierProduct = supplierProductReference(product);
  return {
    changedAt: toDate(product.updatedAt, now),
    lifecycle: availabilityFor(product.qty, product.isPreorder),
    product: {
      platforms: [platformFor(product.platform)],
      productId: keycoreProductReference(supplierProduct),
      title:
        product.originalName ?? product.name ?? `Kinguin ${supplierProduct}`,
      type: typeFor(product),
    },
    supplier: identity,
    supplierProductId: supplierProduct,
  };
};

const normalizeOfferPayload = (
  product: KinguinProduct,
  offer: KinguinOffer | undefined,
  now: Date,
): NormalizedSupplierOffer => {
  const supplierProduct = supplierProductReference(product);
  const supplierOffer = supplierOfferReference(product, offer);
  const priceValue = offer?.price ?? product.price;
  if (priceValue === undefined) {
    throw new SupplierError({
      category: "INVALID_RESPONSE",
      operation: "normalizeOfferPayload",
      supplierId: identity.supplierId,
      supplierReference: supplierOffer,
    });
  }
  const price = money(
    decimalToMinor(priceValue, "normalizeOfferPayload"),
    currency("EUR"),
  );
  const availability = availabilityFor(
    offer?.qty ?? product.qty,
    offer?.isPreorder ?? product.isPreorder,
  );

  return {
    capturedAt: now,
    offer: {
      availability,
      currentPrice: price,
      germanyCompatibility: "REVIEW_REQUIRED",
      offerId: keycoreOfferReference(supplierOffer),
      productId: keycoreProductReference(supplierProduct),
    },
    regionEvidence: mapRegionEvidence(product),
    supplier: identity,
    supplierOfferId: supplierOffer,
    supplierProductId: supplierProduct,
    supplierReferenceMetadata: {
      isPreorder: offer?.isPreorder ?? product.isPreorder ?? false,
      kinguinId: product.kinguinId ?? null,
      productId: product.productId ?? null,
      regionId: product.regionId ?? null,
      textQty: offer?.textQty ?? product.textQty ?? null,
    },
  };
};

export class InMemoryKinguinOfferProductIndex implements KinguinOfferProductIndex {
  private readonly productByOffer = new Map<string, SupplierProductId>();

  public constructor(mappings: readonly KinguinOfferProductMapping[] = []) {
    for (const mapping of mappings) {
      this.remember(mapping.supplierOfferId, mapping.supplierProductId, "seed");
    }
  }

  public async resolveProductForOffer(
    supplierOffer: SupplierOfferId,
  ): Promise<SupplierProductId | null> {
    return this.productByOffer.get(supplierOffer) ?? null;
  }

  public rememberProductOffers(
    product: KinguinProduct,
    operation: string,
  ): void {
    const supplierProduct = supplierProductReference(product);
    for (const offer of product.offers ?? []) {
      const offerId = supplierOfferReference(product, offer);
      this.remember(offerId, supplierProduct, operation);
    }
    for (const cheapestOffer of product.cheapestOfferId ?? []) {
      this.remember(supplierOfferId(cheapestOffer), supplierProduct, operation);
    }
  }

  private remember(
    supplierOffer: SupplierOfferId,
    supplierProduct: SupplierProductId,
    operation: string,
  ): void {
    const existing = this.productByOffer.get(supplierOffer);
    if (existing !== undefined && existing !== supplierProduct) {
      throw new SupplierError({
        category: "CONFLICT",
        operation,
        supplierId: identity.supplierId,
        supplierReference: supplierOffer,
      });
    }
    this.productByOffer.set(supplierOffer, supplierProduct);
  }
}

export const mapRegionEvidence = (product: KinguinProduct): RegionEvidence => {
  const excludedCountries = (product.countryLimitation ?? []).map((code) =>
    regionCode(code),
  );
  const limitation = product.regionalLimitations?.toLowerCase() ?? "";
  const activation = product.activationDetails?.toLowerCase() ?? "";
  const hasStructuredRegion =
    product.regionId !== undefined || product.countryLimitation !== undefined;
  const claimsRegionFree = limitation.includes("region free");
  const requiresVpn = activation.includes("vpn") ? true : false;
  const requiresForeignAccount =
    activation.includes("foreign account") || activation.includes("new account")
      ? true
      : false;
  const contradictory =
    (claimsRegionFree && excludedCountries.length > 0) ||
    (claimsRegionFree && excludedCountries.some((code) => code === "DE"));

  const evidence: Omit<RegionEvidence, "supplierRegion"> = {
    activationRestrictions: [
      ...(requiresVpn ? [{ kind: "VPN_REQUIRED" as const }] : []),
      ...(requiresForeignAccount
        ? [{ kind: "FOREIGN_ACCOUNT_REQUIRED" as const }]
        : []),
      ...(excludedCountries.length > 0
        ? [{ kind: "COUNTRY_RESTRICTED" as const }]
        : []),
    ],
    allowedCountries: [],
    excludedCountries,
    hasContradictoryEvidence: contradictory,
    hasMissingValues: !hasStructuredRegion,
    hasUnknownValues: !hasStructuredRegion,
    requiresForeignAccount,
    requiresVpn,
  };
  return product.regionId !== undefined
    ? {
        ...evidence,
        supplierRegion: {
          documentedSemanticsSummary:
            product.regionalLimitations ?? "Kinguin region identifier",
          documentedSemanticsUrl:
            "https://github.com/kinguinltdhk/Kinguin-eCommerce-API/blob/master/api/products/v1/README.md#regions",
          supplierRegionId: String(product.regionId),
        },
      }
    : evidence;
};

const categoryForStatus = (status: number): SupplierErrorCategory => {
  if (status === 401) {
    return "AUTHENTICATION";
  }
  if (status === 403) {
    return "AUTHORIZATION";
  }
  if (status === 404) {
    return "NOT_FOUND";
  }
  if (status === 409) {
    return "CONFLICT";
  }
  if (status === 429) {
    return "RATE_LIMIT";
  }
  if (status >= 500) {
    return "TRANSIENT";
  }
  return "REJECTED";
};

export class FetchKinguinHttpTransport implements KinguinHttpTransport {
  public async send(request: KinguinHttpRequest): Promise<KinguinHttpResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    request.signal?.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
    try {
      const url = new URL(
        request.path,
        request.path.startsWith("http")
          ? undefined
          : "https://gateway.kinguin.net/esa/api",
      );
      for (const [key, value] of Object.entries(request.query ?? {})) {
        url.searchParams.set(key, String(value));
      }
      const init: RequestInit = {
        headers: request.headers,
        method: request.method,
        redirect: "manual",
        signal: controller.signal,
      };
      if (request.body !== undefined) {
        init.body = JSON.stringify(request.body);
      }
      const response = await fetch(url, init);
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > request.maxResponseBytes) {
        throw new SupplierError({
          category: "INVALID_RESPONSE",
          operation: "httpResponseSize",
          supplierId: identity.supplierId,
        });
      }
      return {
        body,
        headers: Object.fromEntries(response.headers.entries()),
        status: response.status,
      };
    } catch (error) {
      if (error instanceof SupplierError) {
        throw error;
      }
      throw new SupplierError({
        category: "TIMEOUT",
        operation: "httpTransport",
        supplierId: identity.supplierId,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class KinguinHttpClient {
  public constructor(
    private readonly config: KinguinConfig,
    private readonly secrets: SecretProvider,
    private readonly transport: KinguinHttpTransport,
    private readonly logger: KinguinLogger = safeLogger,
  ) {}

  public async requestJson(request: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly query?: Readonly<Record<string, string | number | boolean>>;
    readonly body?: unknown;
    readonly operation: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown> {
    const apiKey = await this.secrets.getSecret(this.config.apiKeySecretName);
    if (!apiKey) {
      throw new SupplierError({
        category: "AUTHENTICATION",
        operation: request.operation,
        supplierId: identity.supplierId,
      });
    }
    const baseUrl = this.config.baseUrl.endsWith("/")
      ? this.config.baseUrl
      : `${this.config.baseUrl}/`;
    const path = new URL(request.path.replace(/^\//u, ""), baseUrl).toString();
    this.logger.info("Kinguin request", { operation: request.operation });
    let response: KinguinHttpResponse;
    try {
      response = await this.transport.send({
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Api-Key": apiKey,
        },
        maxResponseBytes: this.config.maxResponseBytes,
        method: request.method,
        path,
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.query !== undefined ? { query: request.query } : {}),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
        timeoutMs: this.config.timeoutMs,
      });
    } catch (error) {
      if (error instanceof SupplierError) {
        throw error;
      }
      throw new SupplierError({
        category: "TIMEOUT",
        operation: request.operation,
        supplierId: identity.supplierId,
      });
    }
    if (response.status >= 300) {
      throw new SupplierError({
        category: categoryForStatus(response.status),
        operation: request.operation,
        supplierId: identity.supplierId,
      });
    }
    return parseJsonObject(response.body, request.operation);
  }
}

export class KinguinSupplier implements SupplierPort {
  public readonly identity = identity;
  public readonly capabilities = capabilitiesWithUndocumentedRateLimits;
  private readonly purchases = new Map<
    IdempotencyKey,
    { readonly receipt: PurchaseReceipt; readonly semantic: string }
  >();
  private readonly refundClaims = new Map<string, RefundClaimReceipt>();

  public constructor(
    private readonly client: KinguinHttpClient,
    private readonly offerProductIndex: KinguinOfferProductIndex = new InMemoryKinguinOfferProductIndex(),
  ) {}

  public async listCatalog(
    page: PageRequest,
  ): Promise<Page<NormalizedSupplierProduct>> {
    const result = await this.searchProducts({
      limit: page.limit,
      page: cursorToPage(page.cursor),
    });
    return result;
  }

  public async listCatalogDelta(
    request: CatalogDeltaRequest,
  ): Promise<Page<NormalizedSupplierProduct>> {
    return this.searchProducts({
      limit: request.page.limit,
      page: cursorToPage(request.page.cursor),
      updatedSince: request.since,
    });
  }

  public async searchProducts(
    request: KinguinSearchProductsRequest,
  ): Promise<Page<NormalizedSupplierProduct>> {
    const page = request.page ?? 1;
    const limit = request.limit ?? 25;
    assertPageLimit(limit, "searchProducts");
    const payload = await this.client.requestJson({
      method: "GET",
      operation: "searchProducts",
      path: "/v1/products",
      query: {
        limit,
        page,
        ...(request.updatedSince
          ? { updatedSince: request.updatedSince.toISOString() }
          : {}),
        ...(request.updatedTo
          ? { updatedTo: request.updatedTo.toISOString() }
          : {}),
      },
    });
    if (!isObject(payload) || !Array.isArray(payload.results)) {
      throw new SupplierError({
        category: "INVALID_RESPONSE",
        operation: "searchProducts",
        supplierId: identity.supplierId,
      });
    }
    const now = new Date();
    const items = payload.results.map((item) => {
      const product = item as KinguinProduct;
      this.offerProductIndex.rememberProductOffers(product, "searchProducts");
      return normalizeProductPayload(product, now);
    });
    const itemCount =
      typeof payload.item_count === "number"
        ? payload.item_count
        : items.length;
    return page * limit < itemCount
      ? { items, nextCursor: pageToCursor(page + 1) }
      : { items };
  }

  public async getProduct(
    productReference: SupplierProductId,
  ): Promise<NormalizedSupplierProduct | null> {
    try {
      const payload = await this.client.requestJson({
        method: "GET",
        operation: "getProduct",
        path: `/v2/products/${encodeURIComponent(productReference)}`,
      });
      if (!isObject(payload)) {
        throw new SupplierError({
          category: "INVALID_RESPONSE",
          operation: "getProduct",
          supplierId: identity.supplierId,
        });
      }
      const product = payload as KinguinProduct;
      this.offerProductIndex.rememberProductOffers(product, "getProduct");
      return normalizeProductPayload(product, new Date());
    } catch (error) {
      if (error instanceof SupplierError && error.category === "NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  public async getOffer(
    offerReference: SupplierOfferId,
  ): Promise<NormalizedSupplierOffer | null> {
    try {
      const product = await this.productForOffer(offerReference, "getOffer");
      const offer = product.offers?.find(
        (candidate) => candidate.offerId === offerReference,
      );
      return offer ? normalizeOfferPayload(product, offer, new Date()) : null;
    } catch (error) {
      if (error instanceof SupplierError && error.category === "NOT_FOUND") {
        return null;
      }
      throw error;
    }
  }

  public async getCurrentPrice(offerReference: SupplierOfferId) {
    const offer = await this.getOffer(offerReference);
    if (!offer) {
      throw new SupplierError({
        category: "NOT_FOUND",
        operation: "getCurrentPrice",
        supplierId: identity.supplierId,
        supplierReference: offerReference,
      });
    }
    return {
      availability: offer.offer.availability,
      capturedAt: offer.capturedAt,
      offerId: offer.offer.offerId,
      price: offer.offer.currentPrice,
    };
  }

  public async getRegionEvidence(
    offerReference: SupplierOfferId,
  ): Promise<RegionEvidence> {
    const offer = await this.getOffer(offerReference);
    if (!offer) {
      throw new SupplierError({
        category: "NOT_FOUND",
        operation: "getRegionEvidence",
        supplierId: identity.supplierId,
        supplierReference: offerReference,
      });
    }
    return offer.regionEvidence;
  }

  public async submitPurchase(
    request: PurchaseRequest,
  ): Promise<PurchaseReceipt> {
    const offer = await this.getOffer(request.supplierOfferId);
    if (!offer) {
      throw new SupplierError({
        category: "NOT_FOUND",
        correlationId: request.correlationId,
        operation: "submitPurchase",
        supplierId: identity.supplierId,
        supplierReference: request.supplierOfferId,
      });
    }
    if (offer.offer.availability === "OUT_OF_STOCK") {
      throw new SupplierError({
        category: "OUT_OF_STOCK",
        correlationId: request.correlationId,
        operation: "submitPurchase",
        supplierId: identity.supplierId,
        supplierReference: request.supplierOfferId,
      });
    }
    const semantic = [
      request.supplierOfferId,
      request.orderLineId,
      request.correlationId,
    ].join("|");
    const existing = this.purchases.get(request.clientIdempotencyReference);
    if (existing) {
      if (existing.semantic !== semantic) {
        throw new SupplierError({
          category: "CONFLICT",
          correlationId: request.correlationId,
          operation: "submitPurchase",
          supplierId: identity.supplierId,
        });
      }
      return existing.receipt;
    }
    try {
      const payload = await this.placeOrder({
        orderExternalId: request.clientIdempotencyReference,
        products: [
          {
            keyType: "text",
            offerId: request.supplierOfferId,
            price: offer.offer.currentPrice,
            productId: offer.supplierProductId,
            qty: 1,
          },
        ],
      });
      const receipt: PurchaseReceipt = {
        acceptedAt: toDate(payload.createdAt, new Date()),
        state:
          payload.status === "completed"
            ? "FULFILLED"
            : offer.offer.availability === "PREORDER"
              ? "DELAYED"
              : "ACCEPTED",
        supplierPurchaseReference:
          payload.orderId ?? String(request.clientIdempotencyReference),
      };
      this.purchases.set(request.clientIdempotencyReference, {
        receipt,
        semantic,
      });
      return receipt;
    } catch (error) {
      if (error instanceof SupplierError && error.category === "TIMEOUT") {
        return {
          acceptedAt: new Date(),
          state: "AMBIGUOUS",
          supplierPurchaseReference: `ambiguous:${request.clientIdempotencyReference}`,
        };
      }
      throw error;
    }
  }

  public async reconcilePurchase(
    supplierPurchaseReference: string,
  ): Promise<ReconciliationResult> {
    const orderReference = supplierPurchaseReference.replace(
      /^ambiguous:/u,
      "",
    );
    const payload = await this.client.requestJson({
      method: "GET",
      operation: "reconcilePurchase",
      path: `/v1/order/${encodeURIComponent(orderReference)}`,
    });
    if (!isObject(payload)) {
      throw new SupplierError({
        category: "INVALID_RESPONSE",
        operation: "reconcilePurchase",
        supplierId: identity.supplierId,
      });
    }
    const status = String((payload as KinguinOrder).status ?? "unknown");
    if (status === "completed") {
      return {
        observedAt: new Date(),
        outcome: "RESOLVED",
        reason: "KINGUIN_ORDER_COMPLETED",
      };
    }
    if (status === "processing") {
      return {
        observedAt: new Date(),
        outcome: "STILL_AMBIGUOUS",
        reason: "KINGUIN_ORDER_PROCESSING",
      };
    }
    return {
      observedAt: new Date(),
      outcome: "MANUAL_REVIEW_REQUIRED",
      reason: `KINGUIN_ORDER_${status.toUpperCase()}`,
    };
  }

  public async retrieveKey(
    supplierPurchaseReference: string,
  ): Promise<SupplierKeyHandle> {
    const keys = await this.downloadKeys(supplierPurchaseReference, {
      limit: 1,
      page: 1,
    });
    const first = keys[0];
    if (!first?.id) {
      throw new SupplierError({
        category: "NOT_FOUND",
        operation: "retrieveKey",
        supplierId: identity.supplierId,
        supplierReference: supplierPurchaseReference,
      });
    }
    return {
      keyReference: `kinguin-key:${first.id}`,
      receivedAt: new Date(),
      supplierPurchaseReference,
    };
  }

  public async getHealth(): Promise<SupplierHealth> {
    return {
      checkedAt: new Date(),
      status: "UNKNOWN",
    };
  }

  public async submitRefundClaim(
    request: RefundClaimRequest,
  ): Promise<RefundClaimReceipt> {
    const claimKey = `${request.supplierPurchaseReference}|${request.orderLineId}`;
    const existing = this.refundClaims.get(claimKey);
    if (existing) {
      return existing;
    }
    await this.returnKeys(request.supplierPurchaseReference);
    const receipt = {
      acceptedAt: new Date(),
      supplierClaimReference: `kinguin-return:${request.supplierPurchaseReference}`,
    } satisfies RefundClaimReceipt;
    this.refundClaims.set(claimKey, receipt);
    return receipt;
  }

  public buildPurchasePayload(request: {
    readonly orderExternalId: IdempotencyKey | string;
    readonly products: readonly KinguinPurchaseLineInput[];
  }): JsonObject {
    if (request.products.length > 10) {
      throw new SupplierError({
        category: "REJECTED",
        operation: "buildPurchasePayload",
        supplierId: identity.supplierId,
      });
    }
    return {
      orderExternalId: String(request.orderExternalId),
      products: request.products.map((line) => {
        if (line.qty > 9) {
          throw new SupplierError({
            category: "REJECTED",
            operation: "buildPurchasePayload",
            supplierId: identity.supplierId,
          });
        }
        return {
          keyType: line.keyType,
          offerId: line.offerId,
          price: moneyToDecimalString(line.price),
          productId: line.productId,
          qty: line.qty,
        };
      }),
    };
  }

  public async placeOrder(request: {
    readonly orderExternalId: IdempotencyKey | string;
    readonly products: readonly KinguinPurchaseLineInput[];
  }): Promise<KinguinOrder> {
    const payload = await this.client.requestJson({
      body: this.buildPurchasePayload(request),
      method: "POST",
      operation: "placeOrder",
      path: "/v2/order",
    });
    if (!isObject(payload)) {
      throw new SupplierError({
        category: "INVALID_RESPONSE",
        operation: "placeOrder",
        supplierId: identity.supplierId,
      });
    }
    return payload as KinguinOrder;
  }

  public async downloadKeys(
    orderReference: string,
    page: { readonly page: number; readonly limit: number },
  ): Promise<readonly KinguinKey[]> {
    assertPageLimit(page.limit, "downloadKeys");
    const payload = await this.client.requestJson({
      method: "GET",
      operation: "downloadKeys",
      path: `/v2/order/${encodeURIComponent(orderReference)}/keys`,
      query: page,
    });
    if (!Array.isArray(payload)) {
      throw new SupplierError({
        category: "INVALID_RESPONSE",
        operation: "downloadKeys",
        supplierId: identity.supplierId,
      });
    }
    payload.forEach((item) => {
      const key = item as KinguinKey;
      if (!keyContentTypes.includes(key.type as never)) {
        throw new SupplierError({
          category: "INVALID_RESPONSE",
          operation: "downloadKeys",
          supplierId: identity.supplierId,
        });
      }
    });
    return payload as readonly KinguinKey[];
  }

  public async storeDownloadedKeys(request: {
    readonly orderReference: string;
    readonly orderLineId: Parameters<
      ProductKeyVaultPort["storeReceivedKey"]
    >[0]["orderLineId"];
    readonly correlationId: CorrelationId;
    readonly keyVault: ProductKeyVaultPort;
    readonly audit?: AuditEventPort;
    readonly queue?: QueuePort;
  }): Promise<KinguinKeyVaultHandoffResult> {
    const keys = await this.downloadKeys(request.orderReference, {
      limit: 100,
      page: 1,
    });
    const keyReferences: string[] = [];
    for (const key of keys) {
      if (!key.serial || !key.id) {
        throw new SupplierError({
          category: "INVALID_RESPONSE",
          operation: "storeDownloadedKeys",
          supplierId: identity.supplierId,
        });
      }
      const material = new TextEncoder().encode(key.serial);
      const recordId = await request.keyVault.storeReceivedKey({
        correlationId: request.correlationId,
        orderLineId: request.orderLineId,
        receivedSecretMaterial: material,
      });
      keyReferences.push(`kinguin-key:${key.id}:${recordId}`);
    }
    await request.audit?.append({
      actor: { id: "kinguin-adapter", type: "SERVICE" },
      correlationId: request.correlationId,
      entity: { id: request.orderReference, type: "supplier_order" },
      environment: "CI",
      eventType: "PROCUREMENT_KEY_HANDOFF",
      metadata: { keyCount: keys.length, supplierId: "kinguin" },
      outcome: "SUCCEEDED",
      reasonCode: "KINGUIN_KEYS_STORED",
      timestampUtc: new Date(),
      uuid: crypto.randomUUID(),
    });
    if (request.queue) {
      const payload = validateSafePayload({
        keyCount: keys.length,
        orderLineId: request.orderLineId,
        supplierOrderReference: request.orderReference,
      });
      await request.queue.enqueue({
        attempt: { attempt: 1, maxAttempts: 1 },
        correlationId: request.correlationId,
        createdAt: new Date(),
        idempotencyKey: request.orderReference as IdempotencyKey,
        jobId: jobId(`kinguin-key-handoff-${request.orderReference}`),
        jobType: "kinguin.key-handoff.completed",
        payload,
        schemaVersion: 1,
      } satisfies JobEnvelope<SafePayload>);
    }
    return { keyReferences, storedCount: keys.length };
  }

  public async returnKeys(
    orderReference: string,
  ): Promise<readonly JsonObject[]> {
    const payload = await this.client.requestJson({
      method: "POST",
      operation: "returnKeys",
      path: `/v2/order/${encodeURIComponent(orderReference)}/keys/return`,
    });
    if (!Array.isArray(payload)) {
      throw new SupplierError({
        category: "INVALID_RESPONSE",
        operation: "returnKeys",
        supplierId: identity.supplierId,
      });
    }
    return payload as readonly JsonObject[];
  }

  public async referenceData(
    kind: "genres" | "platforms" | "regions",
  ): Promise<unknown> {
    return this.client.requestJson({
      method: "GET",
      operation: `referenceData.${kind}`,
      path: `/v1/${kind}`,
    });
  }

  private async productForOffer(
    offerReference: SupplierOfferId,
    operation: string,
  ): Promise<KinguinProduct> {
    const productReference =
      await this.offerProductIndex.resolveProductForOffer(offerReference);
    if (!productReference) {
      throw new SupplierError({
        category: "NOT_FOUND",
        operation,
        supplierId: identity.supplierId,
        supplierReference: offerReference,
      });
    }
    const payload = await this.client.requestJson({
      method: "GET",
      operation,
      path: `/v2/products/${encodeURIComponent(productReference)}`,
    });
    if (!isObject(payload)) {
      throw new SupplierError({
        category: "INVALID_RESPONSE",
        operation,
        supplierId: identity.supplierId,
      });
    }
    const product = payload as KinguinProduct;
    const resolvedProductReference = supplierProductReference(product);
    if (resolvedProductReference !== productReference) {
      throw new SupplierError({
        category: "CONFLICT",
        operation,
        supplierId: identity.supplierId,
        supplierReference: offerReference,
      });
    }
    this.offerProductIndex.rememberProductOffers(product, operation);
    const matchingOfferProduct =
      await this.offerProductIndex.resolveProductForOffer(offerReference);
    if (matchingOfferProduct !== productReference) {
      throw new SupplierError({
        category: "CONFLICT",
        operation,
        supplierId: identity.supplierId,
        supplierReference: offerReference,
      });
    }
    const productContainsOffer = product.offers?.some(
      (offer) => offer.offerId === offerReference,
    );
    if (!productContainsOffer) {
      throw new SupplierError({
        category: "NOT_FOUND",
        operation,
        supplierId: identity.supplierId,
        supplierReference: offerReference,
      });
    }
    return product;
  }
}

export class KinguinWebhookReceiver {
  private readonly processed = new Set<string>();

  public constructor(
    private readonly config: KinguinConfig,
    private readonly secrets: SecretProvider,
    private readonly queue?: QueuePort,
  ) {}

  public async receive(
    request: KinguinWebhookRequest,
  ): Promise<KinguinWebhookEvent> {
    const eventName = headerValue(request.headers, "X-Event-Name");
    const providedSecret = headerValue(request.headers, "X-Event-Secret");
    if (
      eventName !== "product.update" &&
      eventName !== "order.status" &&
      eventName !== "order.complete"
    ) {
      throw new SupplierError({
        category: "REJECTED",
        operation: "receiveWebhook",
        supplierId: identity.supplierId,
      });
    }
    const secretName =
      eventName === "product.update"
        ? this.config.webhookSecrets.productUpdate
        : eventName === "order.complete"
          ? this.config.webhookSecrets.orderComplete
          : this.config.webhookSecrets.orderStatus;
    const expectedSecret = await this.secrets.getSecret(secretName);
    if (
      !expectedSecret ||
      !providedSecret ||
      expectedSecret !== providedSecret
    ) {
      throw new SupplierError({
        category: "AUTHORIZATION",
        operation: "receiveWebhook",
        supplierId: identity.supplierId,
      });
    }
    const payload = parseJsonObject(request.rawBody, "receiveWebhook");
    if (!isObject(payload)) {
      throw new SupplierError({
        category: "INVALID_RESPONSE",
        operation: "receiveWebhook",
        supplierId: identity.supplierId,
      });
    }
    const eventId = this.eventId(eventName, payload);
    const duplicate = this.processed.has(eventId);
    this.processed.add(eventId);
    const safePayload = this.safeWebhookPayload(eventName, payload);
    if (!duplicate && this.queue) {
      await this.queue.enqueue({
        attempt: { attempt: 1, maxAttempts: 3 },
        correlationId: request.correlationId,
        createdAt: request.receivedAt,
        entityReferenceId: eventId,
        idempotencyKey: eventId as IdempotencyKey,
        jobId: jobId(`kinguin-webhook-${eventId}`),
        jobType: `kinguin.webhook.${eventName}`,
        payload: validateSafePayload(safePayload),
        schemaVersion: 1,
      });
    }
    return {
      correlationId: request.correlationId,
      duplicate,
      eventId,
      eventName,
      payload: safePayload,
      receivedAt: request.receivedAt,
    };
  }

  private eventId(eventName: string, payload: JsonObject): string {
    const primary = String(
      payload.productId ??
        payload.orderId ??
        payload.orderExternalId ??
        "unknown",
    );
    const updatedAt = String(payload.updatedAt ?? "unknown");
    return `${eventName}:${primary}:${updatedAt}`;
  }

  private safeWebhookPayload(
    eventName: KinguinWebhookEventName,
    payload: JsonObject,
  ): Readonly<Record<string, string | number | boolean | null>> {
    if (eventName === "product.update") {
      return {
        kinguinId:
          typeof payload.kinguinId === "number" ? payload.kinguinId : null,
        productId:
          typeof payload.productId === "string" ? payload.productId : null,
        updatedAt:
          typeof payload.updatedAt === "string" ? payload.updatedAt : null,
      };
    }
    return {
      orderExternalId:
        typeof payload.orderExternalId === "string"
          ? payload.orderExternalId
          : null,
      orderId: typeof payload.orderId === "string" ? payload.orderId : null,
      status: typeof payload.status === "string" ? payload.status : null,
      updatedAt:
        typeof payload.updatedAt === "string" ? payload.updatedAt : null,
    };
  }
}

export const createKinguinConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): KinguinConfig => ({
  apiKeySecretName: "KINGUIN_API_KEY",
  baseUrl: env.KINGUIN_API_BASE_URL ?? "https://gateway.kinguin.net/esa/api",
  environment:
    env.KINGUIN_ENVIRONMENT === "PRODUCTION" ? "PRODUCTION" : "SANDBOX",
  maxResponseBytes: 1_000_000,
  productionPurchasingEnabled: false,
  timeoutMs: 5_000,
  webhookSecrets: {
    orderComplete: "KINGUIN_WEBHOOK_ORDER_COMPLETE_SECRET",
    orderStatus: "KINGUIN_WEBHOOK_ORDER_STATUS_SECRET",
    productUpdate: "KINGUIN_WEBHOOK_PRODUCT_UPDATE_SECRET",
  },
});

export const assertNoUnsafeKinguinText = assertSafeText;
