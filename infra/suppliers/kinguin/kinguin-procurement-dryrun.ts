import { createHash } from "node:crypto";

import { InMemoryPricingRepository } from "../../pricing/in-memory-pricing-repository.js";
import {
  GermanyEligibilityEngine,
  StaticRegionSemanticRegistry,
  germanyEligibilityPolicyVersion,
  type GermanyEligibilityAssessment,
  type RegionSemantic,
} from "../../../packages/platform/src/catalog/germany-eligibility.js";
import {
  SupplierError,
  correlationId,
  currency,
  money,
  supplierId,
  supplierOfferId,
  supplierProductId,
  type Money,
  type NormalizedSupplierOffer,
  type SupplierOfferId,
  type SupplierProductId,
} from "../../../packages/platform/src/contracts.js";
import {
  PricingService,
  createPricingPolicy,
  type AcquisitionCostInput,
  type PricingOfferSourcePort,
  type ProductPriceSelection,
  type TaxAssessment,
  type TaxPolicyPort,
} from "../../../packages/platform/src/pricing/pricing-margin.js";
import {
  EnvSecretProvider,
  KinguinLiveReadonlyGuardedTransport,
} from "./kinguin-live-readonly.js";
import {
  FetchKinguinHttpTransport,
  InMemoryKinguinOfferProductIndex,
  KinguinHttpClient,
  KinguinSupplier,
  createKinguinConfigFromEnv,
  type KinguinConfig,
  type KinguinHttpTransport,
  type KinguinProduct,
} from "./kinguin-supplier.js";

type JsonValue =
  | boolean
  | number
  | string
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type FailureCategory =
  | "AUTHENTICATION"
  | "CONFIGURATION"
  | "READONLY_GUARD"
  | "PRODUCT_NORMALIZATION"
  | "REGION_INELIGIBLE"
  | "OFFER_MAPPING"
  | "PRICING_BLOCKED"
  | "REQUEST_SCHEMA"
  | "FORBIDDEN_MUTATION_ATTEMPT"
  | "UNEXPECTED_REDIRECT"
  | "SUPPLIER_RESPONSE_INVALID";

export interface KinguinProcurementDryRunResult {
  readonly authentication: "SUCCEEDED" | "FAILED";
  readonly environment: KinguinConfig["environment"];
  readonly mode: "READ_ONLY_DRY_RUN";
  readonly productRecordsInspected: number;
  readonly eligibleOffersFound: number;
  readonly normalization: "SUCCEEDED" | "FAILED";
  readonly germanyEligibility: "SUCCEEDED" | "BLOCKED" | "FAILED";
  readonly germanyEligibilityPolicyVersion: typeof germanyEligibilityPolicyVersion;
  readonly germanyEligibilityReasonCode?: string;
  readonly offerResolution: "SUCCEEDED" | "FAILED";
  readonly profitability: "SYNTHETIC_VERIFICATION" | "BLOCKED";
  readonly profitabilityReasonCode?: string;
  readonly purchaseRequestValidation: "SUCCEEDED" | "SKIPPED" | "FAILED";
  readonly purchaseRequestFingerprint?: string;
  readonly purchaseMutation: "NOT_SENT";
  readonly endpointsTested: readonly string[];
  readonly forbiddenRequestCount: number;
  readonly mutationRequestCount: number;
  readonly keyRetrievalRequestCount: number;
  readonly differences: readonly string[];
  readonly parserFixesMade: readonly string[];
  readonly requestBuilderFixesMade: readonly string[];
  readonly failureCategory?: FailureCategory;
}

export interface KinguinDryRunPurchaseRequest {
  readonly orderExternalId: string;
  readonly payload: JsonValue;
  readonly fingerprint: string;
}

const allowedProductionBaseUrl = "https://gateway.kinguin.net/esa/api";
const dryRunMode = "READ_ONLY_DRY_RUN" as const;
const kinguinSupplierId = supplierId("kinguin");
const verificationNow = new Date("2026-08-24T00:00:00.000Z");

export const validateKinguinProcurementDryRunConfig = (
  env: Readonly<Record<string, string | undefined>>,
): KinguinConfig => {
  const config = createKinguinConfigFromEnv(env);
  if (env.KEYCORE_ALLOW_KINGUIN_LIVE_READONLY !== "true") {
    throw dryRunError("CONFIGURATION", "procurementDryRunReadonlyOptIn");
  }
  if (config.environment !== "PRODUCTION") {
    throw dryRunError("CONFIGURATION", "procurementDryRunEnvironment");
  }
  if (config.baseUrl !== allowedProductionBaseUrl) {
    throw dryRunError("CONFIGURATION", "procurementDryRunBaseUrl");
  }
  if (!env.KINGUIN_API_KEY) {
    throw dryRunError("AUTHENTICATION", "procurementDryRunApiKey");
  }
  if (config.productionPurchasingEnabled) {
    throw dryRunError("CONFIGURATION", "procurementDryRunMutationCapability");
  }
  return config;
};

export const runKinguinProcurementDryRunVerification = async (
  env: Readonly<Record<string, string | undefined>>,
  delegate: KinguinHttpTransport = new FetchKinguinHttpTransport(),
): Promise<KinguinProcurementDryRunResult> => {
  const config = validateKinguinProcurementDryRunConfig(env);
  const guardedTransport = new KinguinLiveReadonlyGuardedTransport({
    baseUrl: config.baseUrl,
    delegate,
    enabled: true,
  });
  const client = new KinguinHttpClient(
    config,
    new EnvSecretProvider(env),
    guardedTransport,
  );
  const offerIndex = new InMemoryKinguinOfferProductIndex();
  const supplier = new KinguinSupplier(client, offerIndex);
  const endpoints = new Set<string>();
  const differences: string[] = [];

  await supplier.searchProducts({ limit: 1, page: 1 });
  endpoints.add("GET /v1/products?page=1&limit=1");

  const samplePayload = await client.requestJson({
    method: "GET",
    operation: "procurementDryRunSample",
    path: "/v1/products",
    query: { limit: 20, page: 1 },
  });
  endpoints.add("GET /v1/products?page=1&limit=20");
  const products = productsFromPayload(samplePayload).slice(0, 20);
  for (const product of products) {
    offerIndex.rememberProductOffers(product, "procurementDryRunSample");
  }

  const [regions] = await Promise.all([
    supplier.referenceData("regions"),
    supplier.referenceData("platforms"),
    supplier.referenceData("genres"),
  ]);
  endpoints.add("GET /v1/regions");
  endpoints.add("GET /v1/platforms");
  endpoints.add("GET /v1/genres");

  const regionRegistry = regionRegistryFromReferenceData(regions, products);
  const germanyEngine = new GermanyEligibilityEngine({
    regionSemantics: regionRegistry,
  });

  let firstEligibility: GermanyEligibilityAssessment | undefined = undefined;
  let blockedPricing: ProductPriceSelection | undefined;
  let eligibleOffersFound = 0;

  for (const product of products) {
    const supplierProduct = productReference(product);
    if (!supplierProduct) {
      continue;
    }
    for (const rawOffer of product.offers ?? []) {
      if (!rawOffer.offerId) {
        continue;
      }
      const supplierOffer = supplierOfferId(rawOffer.offerId);
      const resolved = await offerIndex.resolveProductForOffer(supplierOffer);
      if (resolved !== supplierProduct) {
        continue;
      }
      const offer = await supplier.getOffer(supplierOffer);
      endpoints.add("GET /v2/products/{productId}");
      if (!offer) {
        continue;
      }
      const eligibility = germanyEngine.evaluate({
        evidence: offer.regionEvidence,
        supplierId: kinguinSupplierId,
      });
      firstEligibility ??= eligibility;
      if (eligibility.decision !== "ALLOWED") {
        continue;
      }
      if (
        offer.offer.availability === "OUT_OF_STOCK" ||
        offer.offer.availability === "UNKNOWN"
      ) {
        continue;
      }
      if (offer.offer.currentPrice.amountMinor <= 0n) {
        continue;
      }
      if (offer.offer.currentPrice.currency !== currency("EUR")) {
        continue;
      }
      eligibleOffersFound += 1;
      const pricing = await quoteSyntheticVerificationPrice(offer);
      if (!pricing.selectedQuote) {
        blockedPricing = pricing;
        continue;
      }
      const purchase = buildKinguinDryRunPurchaseRequest({
        mappedSupplierProductId: resolved,
        offer,
        quantity: 1,
        supplierProductId: supplierProduct,
      });
      const result = {
        authentication: "SUCCEEDED",
        differences,
        eligibleOffersFound,
        endpointsTested: [...endpoints],
        environment: config.environment,
        forbiddenRequestCount: guardedTransport.forbiddenRequestCount,
        germanyEligibility: "SUCCEEDED",
        germanyEligibilityPolicyVersion,
        germanyEligibilityReasonCode: eligibility.reasonCode,
        keyRetrievalRequestCount: guardedTransport.keyRetrievalRequestCount,
        mode: dryRunMode,
        mutationRequestCount: guardedTransport.mutationRequestCount,
        normalization: "SUCCEEDED",
        offerResolution: "SUCCEEDED",
        parserFixesMade: [],
        productRecordsInspected: products.length,
        profitability: "SYNTHETIC_VERIFICATION",
        purchaseMutation: "NOT_SENT",
        purchaseRequestFingerprint: purchase.fingerprint,
        purchaseRequestValidation: "SUCCEEDED",
        requestBuilderFixesMade: [],
      } satisfies KinguinProcurementDryRunResult;
      assertSafeDryRunOutput(result, env.KINGUIN_API_KEY);
      return result;
    }
  }

  const result = {
    authentication: "SUCCEEDED",
    differences,
    eligibleOffersFound,
    endpointsTested: [...endpoints],
    environment: config.environment,
    failureCategory: blockedPricing ? "PRICING_BLOCKED" : "REGION_INELIGIBLE",
    forbiddenRequestCount: guardedTransport.forbiddenRequestCount,
    germanyEligibility:
      firstEligibility?.decision === "ALLOWED" ? "SUCCEEDED" : "BLOCKED",
    germanyEligibilityPolicyVersion,
    ...(firstEligibility?.reasonCode
      ? { germanyEligibilityReasonCode: firstEligibility.reasonCode }
      : {}),
    keyRetrievalRequestCount: guardedTransport.keyRetrievalRequestCount,
    mode: dryRunMode,
    mutationRequestCount: guardedTransport.mutationRequestCount,
    normalization: products.length > 0 ? "SUCCEEDED" : "FAILED",
    offerResolution: "FAILED",
    parserFixesMade: [],
    productRecordsInspected: products.length,
    profitability: "BLOCKED",
    ...(blockedPricing?.reasonCode
      ? { profitabilityReasonCode: blockedPricing.reasonCode }
      : {}),
    purchaseMutation: "NOT_SENT",
    purchaseRequestValidation: "SKIPPED",
    requestBuilderFixesMade: [],
  } satisfies KinguinProcurementDryRunResult;
  assertSafeDryRunOutput(result, env.KINGUIN_API_KEY);
  return result;
};

export const buildKinguinDryRunPurchaseRequest = (input: {
  readonly offer: NormalizedSupplierOffer;
  readonly supplierProductId: SupplierProductId;
  readonly mappedSupplierProductId: SupplierProductId | null;
  readonly quantity: number;
}): KinguinDryRunPurchaseRequest => {
  if (input.quantity !== 1) {
    throw dryRunError("REQUEST_SCHEMA", "procurementDryRunQuantity");
  }
  if (input.mappedSupplierProductId !== input.supplierProductId) {
    throw dryRunError("OFFER_MAPPING", "procurementDryRunOfferMapping");
  }
  if (input.offer.offer.currentPrice.currency !== currency("EUR")) {
    throw dryRunError("REQUEST_SCHEMA", "procurementDryRunCurrency");
  }
  if (input.offer.offer.currentPrice.amountMinor <= 0n) {
    throw dryRunError("REQUEST_SCHEMA", "procurementDryRunPrice");
  }

  const orderExternalId = dryRunOrderExternalId({
    supplierOfferId: input.offer.supplierOfferId,
    supplierProductId: input.supplierProductId,
  });
  const supplier = new KinguinSupplier(
    new KinguinHttpClient(
      {
        apiKeySecretName: "KINGUIN_API_KEY",
        baseUrl: allowedProductionBaseUrl,
        environment: "PRODUCTION",
        maxResponseBytes: 1,
        productionPurchasingEnabled: false,
        timeoutMs: 1,
        webhookSecrets: {
          orderComplete: "KINGUIN_WEBHOOK_ORDER_COMPLETE_SECRET",
          orderStatus: "KINGUIN_WEBHOOK_ORDER_STATUS_SECRET",
          productUpdate: "KINGUIN_WEBHOOK_PRODUCT_UPDATE_SECRET",
        },
      },
      { getSecret: async () => "unused-dry-run-secret" },
      { send: async () => ({ body: "{}", headers: {}, status: 418 }) },
    ),
  );
  const payload = supplier.buildPurchasePayload({
    orderExternalId,
    products: [
      {
        keyType: "text",
        offerId: input.offer.supplierOfferId,
        price: input.offer.offer.currentPrice,
        productId: input.supplierProductId,
        qty: input.quantity,
      },
    ],
  });
  validateDocumentedOrderPayload(payload as JsonValue);
  return {
    fingerprint: fingerprintPayload(payload as JsonValue),
    orderExternalId,
    payload: payload as JsonValue,
  };
};

export const assertEligibleForKinguinDryRunPurchase = (input: {
  readonly offer: NormalizedSupplierOffer;
  readonly eligibility: GermanyEligibilityAssessment;
  readonly mappedSupplierProductId: SupplierProductId | null;
  readonly supplierProductId: SupplierProductId;
}): void => {
  if (input.eligibility.decision !== "ALLOWED") {
    throw dryRunError("REGION_INELIGIBLE", "procurementDryRunGermanyBlocked");
  }
  if (input.mappedSupplierProductId !== input.supplierProductId) {
    throw dryRunError("OFFER_MAPPING", "procurementDryRunOfferMapping");
  }
  if (input.offer.offer.currentPrice.currency !== currency("EUR")) {
    throw dryRunError("REQUEST_SCHEMA", "procurementDryRunCurrency");
  }
  if (input.offer.offer.currentPrice.amountMinor <= 0n) {
    throw dryRunError("REQUEST_SCHEMA", "procurementDryRunPrice");
  }
};

const quoteSyntheticVerificationPrice = async (
  offer: NormalizedSupplierOffer,
): Promise<ProductPriceSelection> => {
  const policy = createPricingPolicy({
    currency: currency("EUR"),
    fixedMarkup: money(0n, currency("EUR")),
    markupBasisPoints: 1_000n,
    minimumProfit: money(1n, currency("EUR")),
    minimumSellPrice: money(1n, currency("EUR")),
    now: verificationNow,
    policyId: "synthetic-verification-only",
  });
  const repository = new InMemoryPricingRepository(policy);
  const pricing = new PricingService({
    environment: "LOCAL",
    now: () => verificationNow,
    offerSource: new SingleOfferSource({
      baseSupplierPrice: offer.offer.currentPrice,
      capturedAt: verificationNow,
      costVersion: "SYNTHETIC_VERIFICATION_ONLY",
      fixedFee: money(0n, currency("EUR")),
      offerId: offer.offer.offerId,
      percentageFeeBasisPoints: 0n,
      productId: offer.offer.productId,
      requiredFeeKnown: true,
    }),
    overrideRepository: repository,
    policyRepository: repository,
    taxPolicy: new SyntheticVerificationTaxPolicy(),
  });
  return pricing.quoteProduct({
    correlationId: correlationId("kinguin-procurement-dryrun"),
    eligibleOfferIds: [offer.offer.offerId],
    productId: offer.offer.productId,
  });
};

class SingleOfferSource implements PricingOfferSourcePort {
  public constructor(private readonly cost: AcquisitionCostInput) {}

  public async loadPriceableOffers(): Promise<readonly AcquisitionCostInput[]> {
    return [this.cost];
  }
}

class SyntheticVerificationTaxPolicy implements TaxPolicyPort {
  public async assess(input: {
    readonly subtotal: Money;
  }): Promise<TaxAssessment> {
    return {
      known: true,
      policyVersion: "SYNTHETIC_VERIFICATION_ONLY",
      taxAmount: money(0n, input.subtotal.currency),
      treatment: "CONFIGURED_FIXTURE",
    };
  }
}

const productsFromPayload = (payload: unknown): readonly KinguinProduct[] => {
  if (!isObject(payload) || !Array.isArray(payload.results)) {
    throw dryRunError("SUPPLIER_RESPONSE_INVALID", "procurementDryRunProducts");
  }
  return payload.results as readonly KinguinProduct[];
};

const productReference = (product: KinguinProduct): SupplierProductId | null =>
  product.productId
    ? supplierProductId(product.productId)
    : product.kinguinId !== undefined
      ? supplierProductId(`kinguin-id:${product.kinguinId}`)
      : null;

const regionRegistryFromReferenceData = (
  referenceData: unknown,
  products: readonly KinguinProduct[],
): StaticRegionSemanticRegistry => {
  const registry = new StaticRegionSemanticRegistry();
  for (const product of products) {
    if (product.regionId === undefined) {
      continue;
    }
    const semantic = semanticForRegionText(product.regionalLimitations);
    if (semantic !== "UNKNOWN") {
      registry.set({
        semantic,
        supplierId: kinguinSupplierId,
        supplierRegionId: String(product.regionId),
      });
    }
  }
  for (const region of Array.isArray(referenceData) ? referenceData : []) {
    if (!isObject(region)) {
      continue;
    }
    const id = region.id ?? region.regionId;
    const name = String(region.name ?? region.title ?? "");
    const semantic = semanticForRegionText(name);
    if (
      (typeof id === "string" || typeof id === "number") &&
      semantic !== "UNKNOWN"
    ) {
      registry.set({
        semantic,
        supplierId: kinguinSupplierId,
        supplierRegionId: String(id),
      });
    }
  }
  return registry;
};

const semanticForRegionText = (value: string | undefined): RegionSemantic => {
  const text = value?.toLowerCase() ?? "";
  if (/\bgermany\b|\bde\b/u.test(text)) {
    return "DE";
  }
  if (text.includes("europe") || text.includes("eu")) {
    return "EU_INCLUDING_DE";
  }
  if (text.includes("global") || text.includes("worldwide")) {
    return "GLOBAL";
  }
  if (text.includes("region free") || text.includes("region-free")) {
    return "REGION_FREE";
  }
  if (text.includes("cis") || text.includes("latam") || text.includes("asia")) {
    return "INCOMPATIBLE";
  }
  return "UNKNOWN";
};

const validateDocumentedOrderPayload = (payload: JsonValue): void => {
  if (!isObject(payload) || !Array.isArray(payload.products)) {
    throw dryRunError("REQUEST_SCHEMA", "procurementDryRunPayload");
  }
  if (payload.products.length !== 1) {
    throw dryRunError("REQUEST_SCHEMA", "procurementDryRunProductsCount");
  }
  if (typeof payload.orderExternalId !== "string") {
    throw dryRunError("REQUEST_SCHEMA", "procurementDryRunOrderExternalId");
  }
  const [line] = payload.products;
  if (!isObject(line)) {
    throw dryRunError("REQUEST_SCHEMA", "procurementDryRunLine");
  }
  if (
    typeof line.productId !== "string" ||
    line.qty !== 1 ||
    typeof line.price !== "string" ||
    line.keyType !== "text" ||
    typeof line.offerId !== "string"
  ) {
    throw dryRunError("REQUEST_SCHEMA", "procurementDryRunLineFields");
  }
};

const dryRunOrderExternalId = (input: {
  readonly supplierProductId: SupplierProductId;
  readonly supplierOfferId: SupplierOfferId;
}): string => {
  const digest = fingerprintPayload({
    purpose: "keycore-kinguin-dryrun-order-reference",
    supplierOfferId: input.supplierOfferId,
    supplierProductId: input.supplierProductId,
  });
  return `keycore-dryrun-${digest.slice(0, 16)}`;
};

const fingerprintPayload = (payload: JsonValue): string =>
  createHash("sha256").update(canonicalJson(payload)).digest("hex");

const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const assertSafeDryRunOutput = (
  result: KinguinProcurementDryRunResult,
  apiKey: string | undefined,
): void => {
  const serialized = JSON.stringify(result);
  if (apiKey && serialized.includes(apiKey)) {
    throw dryRunError("CONFIGURATION", "procurementDryRunSecretLeak");
  }
  if (/serial|product.?key|TEST-[A-Z0-9-]+/iu.test(serialized)) {
    throw dryRunError("CONFIGURATION", "procurementDryRunSensitiveOutput");
  }
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const dryRunError = (
  category: FailureCategory,
  operation: string,
): SupplierError =>
  new SupplierError({
    category: category === "AUTHENTICATION" ? "AUTHENTICATION" : "REJECTED",
    operation,
    supplierId: kinguinSupplierId,
  });
