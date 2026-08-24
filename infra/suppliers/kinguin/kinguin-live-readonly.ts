import {
  SupplierError,
  correlationId,
  supplierId,
  supplierOfferId,
  supplierProductId,
  type SupplierOfferId,
  type SupplierProductId,
} from "../../../packages/platform/src/contracts.js";
import {
  FetchKinguinHttpTransport,
  InMemoryKinguinOfferProductIndex,
  KinguinHttpClient,
  KinguinSupplier,
  createKinguinConfigFromEnv,
  type KinguinConfig,
  type KinguinHttpRequest,
  type KinguinHttpResponse,
  type KinguinHttpTransport,
  type KinguinProduct,
  type SecretProvider,
} from "./kinguin-supplier.js";

type JsonObject = Readonly<Record<string, unknown>>;

export interface KinguinReadonlyVerificationResult {
  readonly environment: KinguinConfig["environment"];
  readonly endpointsTested: readonly string[];
  readonly inspectedProductRecords: number;
  readonly authentication: "SUCCEEDED" | "FAILED" | "SKIPPED";
  readonly pagination: "SUCCEEDED" | "FAILED" | "SKIPPED";
  readonly normalization: "SUCCEEDED" | "FAILED" | "SKIPPED";
  readonly offerResolution: "SUCCEEDED" | "FAILED" | "SKIPPED";
  readonly referenceData: "SUCCEEDED" | "FAILED" | "SKIPPED";
  readonly updatedSince: "SUCCEEDED" | "FAILED" | "SKIPPED";
  readonly forbiddenRequestCount: number;
  readonly keyRetrievalRequestCount: number;
  readonly mutationRequestCount: number;
  readonly differences: readonly string[];
  readonly parserFixesMade: readonly string[];
  readonly requests: readonly {
    readonly method: string;
    readonly path: string;
  }[];
}

export class EnvSecretProvider implements SecretProvider {
  public constructor(
    private readonly env: Readonly<Record<string, string | undefined>>,
  ) {}

  public async getSecret(name: string): Promise<string | null> {
    return this.env[name] ?? null;
  }
}

export class KinguinLiveReadonlyGuardedTransport implements KinguinHttpTransport {
  public readonly requests: { method: string; path: string }[] = [];
  public forbiddenRequestCount = 0;
  public keyRetrievalRequestCount = 0;
  public mutationRequestCount = 0;

  public constructor(
    private readonly options: {
      readonly enabled: boolean;
      readonly baseUrl: string;
      readonly delegate: KinguinHttpTransport;
      readonly allowOrderStatusLookup?: boolean;
    },
  ) {}

  public async send(request: KinguinHttpRequest): Promise<KinguinHttpResponse> {
    this.assertAllowed(request);
    this.requests.push({
      method: request.method,
      path: this.safePath(request.path),
    });
    const response = await this.options.delegate.send(request);
    this.assertSafeRedirect(response);
    return response;
  }

  public assertAllowed(
    request: Pick<KinguinHttpRequest, "method" | "path">,
  ): void {
    if (!this.options.enabled) {
      this.reject("liveReadonlyDisabled");
    }
    if (request.method !== "GET") {
      this.mutationRequestCount += 1;
      this.reject("liveReadonlyMethod");
    }
    const url = this.parseUrl(request.path, "liveReadonlyUrl");
    const baseUrl = this.parseUrl(this.options.baseUrl, "liveReadonlyBaseUrl");
    if (url.protocol !== "https:" || baseUrl.protocol !== "https:") {
      this.reject("liveReadonlyProtocol");
    }
    if (!this.isApprovedKinguinHost(baseUrl.hostname)) {
      this.reject("liveReadonlyBaseHost");
    }
    if (url.hostname !== baseUrl.hostname) {
      this.reject("liveReadonlyHost");
    }
    const apiPath = this.apiPath(url, baseUrl);
    const safeOrderLookup =
      Boolean(this.options.allowOrderStatusLookup) &&
      /^\/v1\/order\/[^/]+$/u.test(apiPath);
    if (
      (/\/order(?:\/|$)/iu.test(apiPath) && !safeOrderLookup) ||
      /\/keys(?:\/|$)/iu.test(apiPath)
    ) {
      this.forbiddenRequestCount += 1;
      if (/\/keys(?:\/|$)/iu.test(apiPath)) {
        this.keyRetrievalRequestCount += 1;
      }
      this.reject("liveReadonlyForbiddenPath");
    }
    if (!this.isAllowedPath(apiPath)) {
      this.reject("liveReadonlyPath");
    }
  }

  private parseUrl(value: string, operation: string): URL {
    try {
      return new URL(value);
    } catch {
      this.reject(operation);
    }
  }

  private apiPath(url: URL, baseUrl: URL): string {
    const basePath = baseUrl.pathname.replace(/\/$/u, "");
    if (basePath && !url.pathname.startsWith(`${basePath}/`)) {
      this.reject("liveReadonlyBasePath");
    }
    return url.pathname.slice(basePath.length) || "/";
  }

  private isApprovedKinguinHost(hostname: string): boolean {
    return hostname === "kinguin.net" || hostname.endsWith(".kinguin.net");
  }

  private isAllowedPath(path: string): boolean {
    return (
      path === "/v1/products" ||
      /^\/v2\/products\/[^/]+$/u.test(path) ||
      (Boolean(this.options.allowOrderStatusLookup) &&
        /^\/v1\/order\/[^/]+$/u.test(path)) ||
      path === "/v1/regions" ||
      path === "/v1/platforms" ||
      path === "/v1/genres"
    );
  }

  private safePath(value: string): string {
    const url = new URL(value);
    return `${url.pathname}${url.search}`;
  }

  private assertSafeRedirect(response: KinguinHttpResponse): void {
    if (response.status < 300 || response.status >= 400) {
      return;
    }
    const location = response.headers.location ?? response.headers.Location;
    if (!location) {
      return;
    }
    try {
      this.assertAllowed({ method: "GET", path: location });
    } catch {
      this.reject("liveReadonlyRedirect");
    }
  }

  private reject(operation: string): never {
    throw new SupplierError({
      category: "REJECTED",
      operation,
      supplierId: supplierId("kinguin"),
    });
  }
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const productsFromPayload = (payload: unknown): readonly KinguinProduct[] => {
  if (!isObject(payload) || !Array.isArray(payload.results)) {
    throw new SupplierError({
      category: "INVALID_RESPONSE",
      operation: "liveReadonlyProducts",
      supplierId: supplierId("kinguin"),
    });
  }
  return payload.results as readonly KinguinProduct[];
};

const productReference = (product: KinguinProduct): SupplierProductId | null =>
  product.productId
    ? supplierProductId(product.productId)
    : product.kinguinId !== undefined
      ? supplierProductId(`kinguin-id:${product.kinguinId}`)
      : null;

const offerReference = (product: KinguinProduct): SupplierOfferId | null => {
  const offer = product.offers?.find((candidate) => candidate.offerId);
  return offer?.offerId ? supplierOfferId(offer.offerId) : null;
};

const summarizeDifference = (message: string): string => message;

export const runKinguinReadonlyVerification = async (
  env: Readonly<Record<string, string | undefined>>,
  delegate: KinguinHttpTransport = new FetchKinguinHttpTransport(),
): Promise<KinguinReadonlyVerificationResult> => {
  const config = createKinguinConfigFromEnv(env);
  const enabled = env.KEYCORE_ALLOW_KINGUIN_LIVE_READONLY === "true";
  const transport = new KinguinLiveReadonlyGuardedTransport({
    baseUrl: config.baseUrl,
    delegate,
    enabled,
  });
  const client = new KinguinHttpClient(
    config,
    new EnvSecretProvider(env),
    transport,
  );
  const offerIndex = new InMemoryKinguinOfferProductIndex();
  const supplier = new KinguinSupplier(client, offerIndex);
  const endpoints = new Set<string>();
  const differences: string[] = [];
  let inspected = 0;

  if (!enabled) {
    return {
      authentication: "SKIPPED",
      differences: [summarizeDifference("Live read-only opt-in is disabled.")],
      endpointsTested: [],
      environment: config.environment,
      forbiddenRequestCount: 0,
      inspectedProductRecords: 0,
      keyRetrievalRequestCount: 0,
      mutationRequestCount: 0,
      normalization: "SKIPPED",
      offerResolution: "SKIPPED",
      pagination: "SKIPPED",
      parserFixesMade: [],
      referenceData: "SKIPPED",
      requests: [],
      updatedSince: "SKIPPED",
    };
  }

  await supplier.searchProducts({ limit: 1, page: 1 });
  endpoints.add("GET /v1/products?page=1&limit=1");

  const samplePayload = await client.requestJson({
    method: "GET",
    operation: "liveReadonlySample",
    path: "/v1/products",
    query: { limit: 5, page: 1 },
  });
  endpoints.add("GET /v1/products?page=1&limit=5");
  const sampleProducts = productsFromPayload(samplePayload).slice(0, 5);
  inspected += sampleProducts.length;
  for (const product of sampleProducts) {
    offerIndex.rememberProductOffers(product, "liveReadonlySample");
  }

  await supplier.listCatalog({ limit: 5 });
  endpoints.add("GET /v1/products?page=1&limit=5");

  const sampleWithOffer = sampleProducts.find(
    (product) => productReference(product) && offerReference(product),
  );
  let offerResolution: KinguinReadonlyVerificationResult["offerResolution"] =
    "SKIPPED";
  if (sampleWithOffer) {
    const supplierOffer = offerReference(sampleWithOffer);
    const supplierProduct = productReference(sampleWithOffer);
    if (supplierOffer && supplierProduct) {
      offerIndex.rememberProductOffers(sampleWithOffer, "liveReadonlyOffer");
      const offer = await supplier.getOffer(supplierOffer);
      if (!offer || offer.supplierProductId !== supplierProduct) {
        throw new SupplierError({
          category: "INVALID_RESPONSE",
          operation: "liveReadonlyOfferResolution",
          supplierId: supplierId("kinguin"),
        });
      }
      endpoints.add("GET /v2/products/{productId}");
      offerResolution = "SUCCEEDED";
    }
  } else {
    differences.push(
      summarizeDifference(
        "Small product sample did not contain a usable offer.",
      ),
    );
  }

  await supplier.referenceData("regions");
  await supplier.referenceData("platforms");
  await supplier.referenceData("genres");
  endpoints.add("GET /v1/regions");
  endpoints.add("GET /v1/platforms");
  endpoints.add("GET /v1/genres");

  await supplier.listCatalog({ limit: 2 });
  await supplier.listCatalog({ cursor: "kinguin:2", limit: 2 });
  endpoints.add("GET /v1/products?page=1&limit=2");
  endpoints.add("GET /v1/products?page=2&limit=2");

  await supplier.listCatalogDelta({
    page: { limit: 2 },
    since: new Date(Date.now() - 24 * 60 * 60 * 1_000),
  });
  endpoints.add("GET /v1/products?updatedSince=<recent>&limit=2");

  if (inspected > 20) {
    throw new SupplierError({
      category: "REJECTED",
      operation: "liveReadonlyProductLimit",
      supplierId: supplierId("kinguin"),
    });
  }

  return {
    authentication: "SUCCEEDED",
    differences,
    endpointsTested: [...endpoints],
    environment: config.environment,
    forbiddenRequestCount: transport.forbiddenRequestCount,
    inspectedProductRecords: inspected,
    keyRetrievalRequestCount: transport.keyRetrievalRequestCount,
    mutationRequestCount: transport.mutationRequestCount,
    normalization: "SUCCEEDED",
    offerResolution,
    pagination: "SUCCEEDED",
    parserFixesMade: [],
    referenceData: "SUCCEEDED",
    requests: transport.requests,
    updatedSince: "SUCCEEDED",
  };
};

export const readonlyVerificationCorrelationId = correlationId(
  "kinguin-readonly-verification",
);
