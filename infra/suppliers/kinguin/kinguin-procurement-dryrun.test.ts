import { describe, expect, it } from "vitest";

import {
  SupplierError,
  currency,
  money,
  offerId,
  productId,
  regionCode,
  supplierId,
  supplierOfferId,
  supplierProductId,
  type Money,
  type NormalizedSupplierOffer,
  type SupplierOfferId,
  type SupplierProductId,
} from "../../../packages/platform/src/contracts.js";
import { GermanyEligibilityEngine } from "../../../packages/platform/src/catalog/germany-eligibility.js";
import { KinguinLiveReadonlyGuardedTransport } from "./kinguin-live-readonly.js";
import {
  assertEligibleForKinguinDryRunPurchase,
  buildKinguinDryRunPurchaseRequest,
  runKinguinProcurementDryRunVerification,
  validateKinguinProcurementDryRunConfig,
} from "./kinguin-procurement-dryrun.js";
import type {
  KinguinHttpRequest,
  KinguinHttpResponse,
  KinguinHttpTransport,
  KinguinProduct,
} from "./kinguin-supplier.js";

const readonlyCredentialFixture = "dryrun-fixture-token";
const allowedBaseUrl = "https://gateway.kinguin.net/esa/api";
const baseEnv = {
  KEYCORE_ALLOW_KINGUIN_LIVE_READONLY: "true",
  KINGUIN_API_BASE_URL: allowedBaseUrl,
  KINGUIN_API_KEY: readonlyCredentialFixture,
  KINGUIN_ENVIRONMENT: "PRODUCTION",
} satisfies Readonly<Record<string, string>>;

const product = {
  activationDetails: "Activate on Steam",
  cheapestOfferId: ["offer-alpha"],
  countryLimitation: [],
  isPreorder: false,
  kinguinId: 1949,
  name: "Synthetic Kinguin Product Steam CD Key",
  offers: [
    {
      availableTextQty: 12,
      isPreorder: false,
      name: "Synthetic Kinguin Product Steam CD Key",
      offerId: "offer-alpha",
      price: 5.79,
      qty: 12,
      textQty: 12,
    },
  ],
  originalName: "Synthetic Kinguin Product",
  platform: "PC Steam",
  price: 5.79,
  productId: "product-alpha",
  qty: 12,
  regionId: 3,
  regionalLimitations: "REGION FREE",
  tags: ["base"],
  textQty: 12,
  updatedAt: "2026-01-01T00:00:00+00:00",
} satisfies KinguinProduct;

describe("Kinguin procurement dry-run verification", () => {
  it("blocks missing read-only opt-in before live verification", () => {
    expect(() =>
      validateKinguinProcurementDryRunConfig({
        ...baseEnv,
        KEYCORE_ALLOW_KINGUIN_LIVE_READONLY: "false",
      }),
    ).toThrow(SupplierError);
  });

  it("blocks missing API key before live verification", () => {
    expect(() =>
      validateKinguinProcurementDryRunConfig({
        ...baseEnv,
        KINGUIN_API_KEY: undefined,
      }),
    ).toThrow(SupplierError);
  });

  it("blocks wrong base URL before live verification", () => {
    expect(() =>
      validateKinguinProcurementDryRunConfig({
        ...baseEnv,
        KINGUIN_API_BASE_URL: "https://example.invalid/esa/api",
      }),
    ).toThrow(SupplierError);
  });

  it("blocks non-HTTPS requests in the read-only guard", async () => {
    await expect(
      guarded().send(
        request("GET", "http://gateway.kinguin.net/esa/api/v1/products"),
      ),
    ).rejects.toThrow(SupplierError);
  });

  it("blocks POST requests and records the mutation attempt", async () => {
    const guard = guarded();
    await expect(guard.send(request("POST", "/v2/order"))).rejects.toThrow(
      SupplierError,
    );
    expect(guard.mutationRequestCount).toBe(1);
  });

  it("blocks PUT requests", async () => {
    await expect(
      guarded().send(request("PUT", "/v1/products")),
    ).rejects.toThrow(SupplierError);
  });

  it("blocks PATCH requests", async () => {
    await expect(
      guarded().send(request("PATCH", "/v1/products")),
    ).rejects.toThrow(SupplierError);
  });

  it("blocks DELETE requests", async () => {
    await expect(
      guarded().send(request("DELETE", "/v1/products")),
    ).rejects.toThrow(SupplierError);
  });

  it("blocks GET order paths in the dry-run guard", async () => {
    const guard = guarded();
    await expect(
      guard.send(request("GET", "/v1/order/order-alpha")),
    ).rejects.toThrow(SupplierError);
    expect(guard.forbiddenRequestCount).toBe(1);
  });

  it("blocks GET key paths in the dry-run guard", async () => {
    const guard = guarded();
    await expect(
      guard.send(request("GET", "/v2/order/order-alpha/keys")),
    ).rejects.toThrow(SupplierError);
    expect(guard.keyRetrievalRequestCount).toBe(1);
  });

  it("blocks redirects to forbidden hosts", async () => {
    await expect(
      guarded(new RedirectTransport("https://evil.example/v1/products")).send(
        request("GET", "/v1/products"),
      ),
    ).rejects.toThrow(SupplierError);
  });

  it("blocks redirects to order endpoints", async () => {
    await expect(
      guarded(new RedirectTransport(`${allowedBaseUrl}/v2/order`)).send(
        request("GET", "/v1/products"),
      ),
    ).rejects.toThrow(SupplierError);
  });

  it("allows safe product GET requests", async () => {
    await expect(
      guarded().send(request("GET", "/v1/products")),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("builds deterministic purchase requests", () => {
    expect(buildRequest().payload).toEqual(buildRequest().payload);
    expect(buildRequest().fingerprint).toBe(buildRequest().fingerprint);
  });

  it("rejects quantity other than one", () => {
    expect(() => buildRequest({ quantity: 2 })).toThrow(SupplierError);
  });

  it("rejects missing offer-to-product mapping", () => {
    expect(() => buildRequest({ mappedSupplierProductId: null })).toThrow(
      SupplierError,
    );
  });

  it("rejects DE-blocked offers", () => {
    expect(() =>
      assertEligibleForKinguinDryRunPurchase({
        eligibility: blockedEligibility(),
        mappedSupplierProductId: supplierProductId("product-alpha"),
        offer: normalizedOffer(),
        supplierProductId: supplierProductId("product-alpha"),
      }),
    ).toThrow(SupplierError);
  });

  it("rejects unknown region outcomes", () => {
    const eligibility = new GermanyEligibilityEngine().evaluate({
      evidence: normalizedOffer().regionEvidence,
      supplierId: supplierId("kinguin"),
    });

    expect(eligibility.decision).toBe("REVIEW_REQUIRED");
    expect(() =>
      assertEligibleForKinguinDryRunPurchase({
        eligibility,
        mappedSupplierProductId: supplierProductId("product-alpha"),
        offer: normalizedOffer(),
        supplierProductId: supplierProductId("product-alpha"),
      }),
    ).toThrow(SupplierError);
  });

  it("rejects unsupported currencies", () => {
    expect(() => buildRequest({ price: money(579n, currency("USD")) })).toThrow(
      SupplierError,
    );
  });

  it("rejects zero supplier prices", () => {
    expect(() => buildRequest({ price: money(0n, currency("EUR")) })).toThrow(
      SupplierError,
    );
  });

  it("rejects negative supplier prices at the request boundary", () => {
    expect(() =>
      buildRequest({
        price: { amountMinor: -1n, currency: currency("EUR") } as Money,
      }),
    ).toThrow(SupplierError);
  });

  it("keeps request fingerprints stable for the same business input", () => {
    expect(buildRequest().fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(buildRequest().fingerprint).toBe(buildRequest().fingerprint);
  });

  it("keeps secrets absent from command output", async () => {
    const output = await runKinguinProcurementDryRunVerification(
      baseEnv,
      new DryRunFakeTransport(),
    );
    expect(JSON.stringify(output)).not.toContain(readonlyCredentialFixture);
  });

  it("keeps raw supplier payload absent from command output", async () => {
    const output = await runKinguinProcurementDryRunVerification(
      baseEnv,
      new DryRunFakeTransport(),
    );
    expect(JSON.stringify(output)).not.toContain(product.name);
  });

  it("keeps product-key-like material absent from command output", async () => {
    const output = await runKinguinProcurementDryRunVerification(
      baseEnv,
      new DryRunFakeTransport(),
    );
    expect(JSON.stringify(output)).not.toMatch(/TEST-[A-Z0-9-]+|serial/iu);
  });

  it("keeps mutation counters at zero in the successful dry-run", async () => {
    const output = await runKinguinProcurementDryRunVerification(
      baseEnv,
      new DryRunFakeTransport(),
    );

    expect(output.purchaseMutation).toBe("NOT_SENT");
    expect(output.mutationRequestCount).toBe(0);
    expect(output.forbiddenRequestCount).toBe(0);
    expect(output.keyRetrievalRequestCount).toBe(0);
  });
});

const guarded = (
  delegate: KinguinHttpTransport = new DryRunFakeTransport(),
): KinguinLiveReadonlyGuardedTransport =>
  new KinguinLiveReadonlyGuardedTransport({
    baseUrl: allowedBaseUrl,
    delegate,
    enabled: true,
  });

const request = (
  method: KinguinHttpRequest["method"],
  path: string,
): KinguinHttpRequest => ({
  headers: { "X-Api-Key": readonlyCredentialFixture },
  maxResponseBytes: 100_000,
  method,
  path: path.startsWith("http") ? path : `${allowedBaseUrl}${path}`,
  timeoutMs: 1_000,
});

const buildRequest = (
  overrides: {
    readonly mappedSupplierProductId?: SupplierProductId | null;
    readonly price?: Money;
    readonly quantity?: number;
    readonly supplierOfferId?: SupplierOfferId;
    readonly supplierProductId?: SupplierProductId;
  } = {},
) =>
  buildKinguinDryRunPurchaseRequest({
    mappedSupplierProductId:
      overrides.mappedSupplierProductId === undefined
        ? supplierProductId("product-alpha")
        : overrides.mappedSupplierProductId,
    offer: normalizedOffer({
      ...(overrides.price ? { price: overrides.price } : {}),
      ...(overrides.supplierOfferId
        ? { supplierOffer: overrides.supplierOfferId }
        : {}),
      ...(overrides.supplierProductId
        ? { supplierProduct: overrides.supplierProductId }
        : {}),
    }),
    quantity: overrides.quantity ?? 1,
    supplierProductId:
      overrides.supplierProductId ?? supplierProductId("product-alpha"),
  });

const normalizedOffer = (
  overrides: {
    readonly price?: Money;
    readonly supplierOffer?: SupplierOfferId;
    readonly supplierProduct?: SupplierProductId;
  } = {},
): NormalizedSupplierOffer => {
  const supplierProduct =
    overrides.supplierProduct ?? supplierProductId("product-alpha");
  const supplierOffer =
    overrides.supplierOffer ?? supplierOfferId("offer-alpha");
  return {
    capturedAt: new Date("2026-08-24T00:00:00.000Z"),
    offer: {
      availability: "IN_STOCK",
      currentPrice: overrides.price ?? money(579n, currency("EUR")),
      germanyCompatibility: "ALLOWED",
      offerId: offerId(`supplier:kinguin:${supplierOffer}`),
      productId: productId(`supplier:kinguin:${supplierProduct}`),
    },
    regionEvidence: {
      activationRestrictions: [],
      allowedCountries: [],
      excludedCountries: [],
      hasContradictoryEvidence: false,
      hasMissingValues: false,
      hasUnknownValues: false,
      requiresForeignAccount: false,
      requiresVpn: false,
      supplierRegion: {
        documentedSemanticsSummary: "REGION FREE",
        documentedSemanticsUrl:
          "https://github.com/kinguinltdhk/Kinguin-eCommerce-API/blob/master/api/products/v1/README.md#regions",
        supplierRegionId: "3",
      },
    },
    supplier: {
      contractVersion: { major: 1, minor: 0 },
      displayName: "Kinguin",
      supplierId: supplierId("kinguin"),
    },
    supplierOfferId: supplierOffer,
    supplierProductId: supplierProduct,
    supplierReferenceMetadata: { productId: supplierProduct, regionId: 3 },
  };
};

const blockedEligibility = () =>
  new GermanyEligibilityEngine().evaluate({
    evidence: {
      ...normalizedOffer().regionEvidence,
      excludedCountries: [regionCode("DE")],
    },
    supplierId: supplierId("kinguin"),
  });

class DryRunFakeTransport implements KinguinHttpTransport {
  public readonly requests: KinguinHttpRequest[] = [];

  public async send(
    requestInput: KinguinHttpRequest,
  ): Promise<KinguinHttpResponse> {
    this.requests.push(requestInput);
    const url = new URL(requestInput.path);
    const path = url.pathname.replace(/^\/esa\/api/u, "") || "/";
    if (path === "/v1/products") {
      return {
        body: JSON.stringify({ item_count: 1, results: [product] }),
        headers: { "content-type": "application/json" },
        status: 200,
      };
    }
    if (path === "/v2/products/product-alpha") {
      return {
        body: JSON.stringify(product),
        headers: { "content-type": "application/json" },
        status: 200,
      };
    }
    if (path === "/v1/regions") {
      return {
        body: JSON.stringify([{ id: 3, name: "REGION FREE" }]),
        headers: { "content-type": "application/json" },
        status: 200,
      };
    }
    if (path === "/v1/platforms") {
      return {
        body: JSON.stringify(["PC Steam"]),
        headers: { "content-type": "application/json" },
        status: 200,
      };
    }
    if (path === "/v1/genres") {
      return {
        body: JSON.stringify(["Action"]),
        headers: { "content-type": "application/json" },
        status: 200,
      };
    }
    return { body: "{}", headers: {}, status: 404 };
  }
}

class RedirectTransport implements KinguinHttpTransport {
  public constructor(private readonly location: string) {}

  public async send(): Promise<KinguinHttpResponse> {
    return {
      body: "",
      headers: { location: this.location },
      status: 302,
    };
  }
}
