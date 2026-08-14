import {
  StorefrontAmbiguousError,
  storefrontProductId,
  type ProductId,
  type StorefrontChannel,
  type StorefrontPort,
  type StorefrontProductId,
  type StorefrontProductRepresentation,
  type StorefrontRemoteProductSnapshot,
} from "../../packages/platform/src/contracts.js";

export interface WooCommerceConfig {
  readonly baseUrl: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly storefront: StorefrontChannel;
}

export interface WooCommerceHttpClient {
  request(input: {
    readonly method: "GET" | "POST" | "PUT";
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  }): Promise<{
    readonly status: number;
    readonly body: unknown;
  }>;
}

export class FetchWooCommerceHttpClient implements WooCommerceHttpClient {
  public constructor(private readonly fetchFn: typeof fetch = fetch) {}

  public async request(input: {
    readonly method: "GET" | "POST" | "PUT";
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  }): Promise<{ readonly status: number; readonly body: unknown }> {
    const requestInit: RequestInit = {
      headers: input.headers,
      method: input.method,
    };
    if (input.body !== undefined) {
      requestInit.body = input.body;
    }
    try {
      const response = await this.fetchFn(input.url, requestInit);
      const text = await response.text();
      return {
        body: text.length > 0 ? (JSON.parse(text) as unknown) : null,
        status: response.status,
      };
    } catch (error) {
      if (isMutatingMethod(input.method)) {
        throw new StorefrontAmbiguousError(
          `WooCommerce ${input.method} request outcome is ambiguous`,
        );
      }
      throw error;
    }
  }
}

export class WooCommerceStorefrontAdapter implements StorefrontPort {
  private readonly baseUrl: URL;

  public constructor(
    private readonly config: WooCommerceConfig,
    private readonly client: WooCommerceHttpClient = new FetchWooCommerceHttpClient(),
  ) {
    this.baseUrl = validateBaseUrl(config.baseUrl);
    if (
      config.consumerKey.trim().length === 0 ||
      config.consumerSecret.trim().length === 0
    ) {
      throw new Error(
        "WooCommerce credentials must be provided by configuration",
      );
    }
  }

  public async validateConfiguration(): Promise<
    "HEALTHY" | "DEGRADED" | "OUTAGE"
  > {
    const response = await this.client.request({
      headers: this.headers(),
      method: "GET",
      url: this.endpoint("products", { per_page: "1" }),
    });
    if (response.status >= 200 && response.status < 300) {
      return "HEALTHY";
    }
    return response.status === 401 || response.status === 403
      ? "OUTAGE"
      : "DEGRADED";
  }

  public async createProduct(
    product: StorefrontProductRepresentation,
  ): Promise<StorefrontProductId> {
    const response = await this.client.request({
      body: JSON.stringify(
        toWooCommerceProductPayload(product, this.config.storefront),
      ),
      headers: this.headers(),
      method: "POST",
      url: this.endpoint("products"),
    });
    assertSuccess(response.status, "WooCommerce product create failed");
    let id: number;
    try {
      id = readWooProductId(response.body);
    } catch {
      throw new StorefrontAmbiguousError(
        "WooCommerce product create succeeded but remote product ID was unreadable",
      );
    }
    return storefrontProductId(String(id));
  }

  public async updateProduct(input: {
    readonly remoteProductId: StorefrontProductId;
    readonly product: StorefrontProductRepresentation;
  }): Promise<void> {
    const response = await this.client.request({
      body: JSON.stringify(
        toWooCommerceProductPayload(input.product, this.config.storefront),
      ),
      headers: this.headers(),
      method: "PUT",
      url: this.endpoint(
        `products/${encodeURIComponent(input.remoteProductId)}`,
      ),
    });
    assertSuccess(response.status, "WooCommerce product update failed");
  }

  public async unpublishProduct(input: {
    readonly remoteProductId: StorefrontProductId;
    readonly productId: ProductId;
    readonly storefront: StorefrontChannel;
  }): Promise<void> {
    const response = await this.client.request({
      body: JSON.stringify({
        catalog_visibility: "hidden",
        meta_data: keycoreMetadata({
          fingerprint: "unpublished",
          productId: input.productId,
          storefront: input.storefront,
        }),
        status: "draft",
        stock_status: "outofstock",
      }),
      headers: this.headers(),
      method: "PUT",
      url: this.endpoint(
        `products/${encodeURIComponent(input.remoteProductId)}`,
      ),
    });
    assertSuccess(response.status, "WooCommerce product unpublish failed");
  }

  public async readProduct(
    remoteProductId: StorefrontProductId,
  ): Promise<StorefrontRemoteProductSnapshot | null> {
    const response = await this.client.request({
      headers: this.headers(),
      method: "GET",
      url: this.endpoint(`products/${encodeURIComponent(remoteProductId)}`),
    });
    if (response.status === 404) {
      return null;
    }
    assertSuccess(response.status, "WooCommerce product read failed");
    return readWooProductSnapshot(response.body, remoteProductId);
  }

  private endpoint(
    path: string,
    query?: Readonly<Record<string, string>>,
  ): string {
    const url = new URL(`/wp-json/wc/v3/${path}`, this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private headers(): Readonly<Record<string, string>> {
    return {
      Authorization: `Basic ${Buffer.from(
        `${this.config.consumerKey}:${this.config.consumerSecret}`,
      ).toString("base64")}`,
      "Content-Type": "application/json",
    };
  }
}

export const wooCommerceConfigFromEnv = (
  env: NodeJS.ProcessEnv,
  storefront: StorefrontChannel,
): WooCommerceConfig => ({
  baseUrl: env.WOOCOMMERCE_BASE_URL ?? "",
  consumerKey: env.WOOCOMMERCE_CONSUMER_KEY ?? "",
  consumerSecret: env.WOOCOMMERCE_CONSUMER_SECRET ?? "",
  storefront,
});

export const toWooCommerceProductPayload = (
  product: StorefrontProductRepresentation,
  storefront = "KEYCORE",
): Readonly<Record<string, unknown>> => ({
  catalog_visibility:
    product.stockStatus === "IN_STOCK" && product.purchasable
      ? "visible"
      : "hidden",
  description: product.safeDescription ?? "",
  downloadable: false,
  manage_stock: false,
  meta_data: keycoreMetadata({
    fingerprint: product.metadata.fingerprint,
    productId: product.productId,
    storefront,
  }),
  name: product.title,
  regular_price: moneyToWooPrice(product.price),
  short_description: product.safeDescription ?? "",
  slug: product.slug,
  status: product.storefrontStatus === "PUBLISH" ? "publish" : "draft",
  stock_status: product.stockStatus === "IN_STOCK" ? "instock" : "outofstock",
  type: "simple",
  virtual: true,
});

export const moneyToWooPrice = (money: {
  readonly amountMinor: bigint;
}): string => {
  const cents = money.amountMinor.toString().padStart(3, "0");
  return `${cents.slice(0, -2)}.${cents.slice(-2)}`;
};

const keycoreMetadata = (input: {
  readonly productId: ProductId;
  readonly fingerprint: string;
  readonly storefront: string;
}): readonly { readonly key: string; readonly value: string }[] => [
  { key: "keycore_product_id", value: input.productId },
  { key: "keycore_publication_version", value: "storefront-publication-v1" },
  { key: "keycore_publication_fingerprint", value: input.fingerprint },
  { key: "keycore_storefront", value: input.storefront },
];

const validateBaseUrl = (value: string): URL => {
  const url = new URL(value);
  if (url.protocol !== "https:" && !localUrl(url)) {
    throw new Error("WooCommerce base URL must use HTTPS unless local");
  }
  return url;
};

const localUrl = (url: URL): boolean =>
  url.hostname === "localhost" ||
  url.hostname === "127.0.0.1" ||
  url.hostname.endsWith(".localhost");

const assertSuccess = (status: number, message: string): void => {
  if (status < 200 || status >= 300) {
    throw new Error(message);
  }
};

const isMutatingMethod = (method: "GET" | "POST" | "PUT"): boolean =>
  method === "POST" || method === "PUT";

const readWooProductId = (body: unknown): number => {
  if (
    body &&
    typeof body === "object" &&
    "id" in body &&
    typeof body.id === "number"
  ) {
    return body.id;
  }
  throw new Error("WooCommerce product response did not include a numeric ID");
};

const readWooProductSnapshot = (
  body: unknown,
  fallbackRemoteProductId: StorefrontProductId,
): StorefrontRemoteProductSnapshot => {
  if (!body || typeof body !== "object") {
    throw new Error("WooCommerce product response was not an object");
  }
  const record = body as Readonly<Record<string, unknown>>;
  const remoteProductId =
    typeof record.id === "number" || typeof record.id === "string"
      ? storefrontProductId(String(record.id))
      : fallbackRemoteProductId;

  return {
    metadata: readMetadata(record.meta_data),
    remoteProductId,
    ...(typeof record.catalog_visibility === "string"
      ? { catalogVisibility: record.catalog_visibility }
      : {}),
    ...(typeof record.status === "string" ? { status: record.status } : {}),
  };
};

const readMetadata = (metadata: unknown): Readonly<Record<string, string>> => {
  if (!Array.isArray(metadata)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const item of metadata) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Readonly<Record<string, unknown>>;
    if (typeof record.key === "string" && typeof record.value === "string") {
      result[record.key] = record.value;
    }
  }
  return result;
};
