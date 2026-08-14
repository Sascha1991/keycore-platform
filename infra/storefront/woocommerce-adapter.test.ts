import { describe, expect, it } from "vitest";

import {
  currency,
  money,
  productId,
  storefrontChannel,
  storefrontProductId,
  type StorefrontProductRepresentation,
} from "../../packages/platform/src/contracts.js";
import {
  moneyToWooPrice,
  toWooCommerceProductPayload,
  WooCommerceStorefrontAdapter,
  type WooCommerceHttpClient,
} from "./woocommerce-adapter.js";

const storefront = storefrontChannel("KEYRANO_DE");
const representation: StorefrontProductRepresentation = {
  lifecycle: "IN_STOCK",
  metadata: {
    fingerprint: "fingerprint-1",
    keycoreProductId: productId("11111111-1111-4111-8111-111111111111"),
    publicationVersion: "storefront-publication-v1",
  },
  platforms: ["WINDOWS"],
  price: money(1999n, currency("EUR")),
  productId: productId("11111111-1111-4111-8111-111111111111"),
  productType: "GAME",
  purchasable: true,
  safeDescription: "Safe customer-facing description.",
  safeIdentifiers: [{ type: "STEAM_APP_ID", value: "1091500" }],
  slug: "cyberpunk-2077",
  stockStatus: "IN_STOCK",
  storefrontStatus: "PUBLISH",
  title: "Cyberpunk 2077",
};

describe("WooCommerce storefront adapter", () => {
  it("requires HTTPS except for local development URLs", () => {
    expect(
      () =>
        new WooCommerceStorefrontAdapter(
          config({ baseUrl: "http://store.example.test" }),
          new CapturingWooClient(),
        ),
    ).toThrow("HTTPS");

    expect(
      () =>
        new WooCommerceStorefrontAdapter(
          config({ baseUrl: "http://localhost:8080" }),
          new CapturingWooClient(),
        ),
    ).not.toThrow();
  });

  it("requires credentials from configuration", () => {
    expect(
      () =>
        new WooCommerceStorefrontAdapter(
          config({ consumerSecret: "" }),
          new CapturingWooClient(),
        ),
    ).toThrow("credentials");
  });

  it("creates products with WooCommerce wc/v3 POST and returns the remote ID", async () => {
    const client = new CapturingWooClient({ status: 201, body: { id: 123 } });
    const adapter = new WooCommerceStorefrontAdapter(config(), client);

    await expect(adapter.createProduct(representation)).resolves.toBe("123");

    expect(client.requests[0]).toMatchObject({
      method: "POST",
      url: "https://woo.example.test/wp-json/wc/v3/products",
    });
    expect(client.requests[0]?.headers.Authorization).toMatch(/^Basic /u);
    expect(readRequestBody(client.requests[0]).meta_data).toContainEqual({
      key: "keycore_storefront",
      value: "KEYRANO_DE",
    });
  });

  it("updates by known remote WooCommerce ID and never searches by title", async () => {
    const client = new CapturingWooClient({ status: 200, body: { id: 123 } });
    const adapter = new WooCommerceStorefrontAdapter(config(), client);

    await adapter.updateProduct({
      product: representation,
      remoteProductId: storefrontProductId("123"),
    });

    expect(client.requests[0]).toMatchObject({
      method: "PUT",
      url: "https://woo.example.test/wp-json/wc/v3/products/123",
    });
    expect(client.requests[0]?.url).not.toContain("search");
  });

  it("unpublishes with draft and hidden catalog visibility instead of hard delete", async () => {
    const client = new CapturingWooClient({ status: 200, body: { id: 123 } });
    const adapter = new WooCommerceStorefrontAdapter(config(), client);

    await adapter.unpublishProduct({
      productId: representation.productId,
      remoteProductId: storefrontProductId("123"),
      storefront,
    });

    const body = readRequestBody(client.requests[0]);
    expect(client.requests[0]).toMatchObject({
      method: "PUT",
      url: "https://woo.example.test/wp-json/wc/v3/products/123",
    });
    expect(body).toMatchObject({
      catalog_visibility: "hidden",
      status: "draft",
      stock_status: "outofstock",
    });
  });

  it("maps safe product fields to WooCommerce without supplier internals", () => {
    const payload = toWooCommerceProductPayload(representation);
    const serialized = JSON.stringify(payload);

    expect(payload).toMatchObject({
      downloadable: false,
      manage_stock: false,
      name: "Cyberpunk 2077",
      regular_price: "19.99",
      slug: "cyberpunk-2077",
      status: "publish",
      stock_status: "instock",
      type: "simple",
      virtual: true,
    });
    expect(serialized).not.toMatch(
      /supplier(Id|OfferId|ProductId)?|supplierCost|credential|secret|productKey|customerEmail|orderReference/iu,
    );
  });

  it("formats minor-unit prices for WooCommerce strings", () => {
    expect(moneyToWooPrice(money(0n, currency("EUR")))).toBe("0.00");
    expect(moneyToWooPrice(money(5n, currency("EUR")))).toBe("0.05");
    expect(moneyToWooPrice(money(123456n, currency("EUR")))).toBe("1234.56");
  });

  it("returns healthy, degraded, and outage statuses without exposing credentials", async () => {
    await expect(
      new WooCommerceStorefrontAdapter(
        config(),
        new CapturingWooClient({ status: 200, body: [] }),
      ).validateConfiguration(),
    ).resolves.toBe("HEALTHY");
    await expect(
      new WooCommerceStorefrontAdapter(
        config(),
        new CapturingWooClient({ status: 500, body: {} }),
      ).validateConfiguration(),
    ).resolves.toBe("DEGRADED");
    await expect(
      new WooCommerceStorefrontAdapter(
        config(),
        new CapturingWooClient({ status: 401, body: {} }),
      ).validateConfiguration(),
    ).resolves.toBe("OUTAGE");
  });

  it("reads by known remote ID and treats 404 as absent", async () => {
    const client = new CapturingWooClient({ status: 404, body: {} });
    const adapter = new WooCommerceStorefrontAdapter(config(), client);

    await expect(adapter.readProduct(storefrontProductId("321"))).resolves.toBe(
      null,
    );
    expect(client.requests[0]).toMatchObject({
      method: "GET",
      url: "https://woo.example.test/wp-json/wc/v3/products/321",
    });
  });

  it("reads a safe remote product snapshot from WooCommerce metadata", async () => {
    const client = new CapturingWooClient({
      body: {
        catalog_visibility: "visible",
        id: 321,
        meta_data: [
          { key: "keycore_product_id", value: representation.productId },
          {
            key: "keycore_publication_version",
            value: "storefront-publication-v1",
          },
        ],
        status: "publish",
      },
      status: 200,
    });
    const adapter = new WooCommerceStorefrontAdapter(config(), client);

    await expect(
      adapter.readProduct(storefrontProductId("321")),
    ).resolves.toEqual({
      catalogVisibility: "visible",
      metadata: {
        keycore_product_id: representation.productId,
        keycore_publication_version: "storefront-publication-v1",
      },
      remoteProductId: "321",
      status: "publish",
    });
  });
});

class CapturingWooClient implements WooCommerceHttpClient {
  public readonly requests: {
    readonly method: "GET" | "POST" | "PUT";
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  }[] = [];

  public constructor(
    private readonly response: {
      readonly status: number;
      readonly body: unknown;
    } = {
      body: { id: 123 },
      status: 200,
    },
  ) {}

  public async request(input: {
    readonly method: "GET" | "POST" | "PUT";
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  }): Promise<{ readonly status: number; readonly body: unknown }> {
    this.requests.push(input);
    return this.response;
  }
}

const config = (
  override: Partial<{
    readonly baseUrl: string;
    readonly consumerKey: string;
    readonly consumerSecret: string;
  }> = {},
) => ({
  baseUrl: "https://woo.example.test",
  consumerKey: "ck_test_placeholder",
  consumerSecret: "cs_test_placeholder",
  storefront,
  ...override,
});

const readRequestBody = (request: { readonly body?: string } | undefined) => {
  if (!request?.body) {
    throw new Error("Expected request body");
  }
  return JSON.parse(request.body) as Record<string, unknown>;
};
