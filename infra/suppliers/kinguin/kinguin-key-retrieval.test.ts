import { describe, expect, it } from "vitest";

import {
  correlationId,
  supplierId,
} from "../../../packages/platform/src/contracts.js";
import { SupplierError } from "../../../packages/platform/src/suppliers/errors.js";
import { EnvSecretProvider } from "./kinguin-live-readonly.js";
import {
  KinguinControlledKeyRetrievalTransport,
  KinguinKeyRetrievalAdapter,
} from "./kinguin-key-retrieval.js";
import {
  KinguinHttpClient,
  KinguinSupplier,
  type KinguinHttpRequest,
  type KinguinHttpResponse,
  type KinguinHttpTransport,
} from "./kinguin-supplier.js";

const baseUrl = "https://gateway.kinguin.net/esa/api";
const canaryProductKey = [
  "KEYCORE_TEST",
  "PRODUCT",
  "KEY",
  "DO_NOT_LEAK_12345",
].join("_");

describe("Kinguin controlled key retrieval", () => {
  it("downloads documented key response through GET only and normalizes secret material", async () => {
    const transport = new CapturingTransport([
      {
        id: "key-1",
        kinguinId: 1949,
        name: "Anno 2070",
        offerId: "offer-alpha",
        productId: "product-alpha",
        serial: canaryProductKey,
        type: "text/plain",
      },
    ]);
    const adapter = adapterWith(transport);

    const result = await adapter.retrievePurchasedKeys({
      correlationId: correlationId("retrieve"),
      expectedQuantity: 1,
      externalSupplierOrderId: "GE1373B866F3",
      supplierId: supplierId("kinguin"),
    });

    expect(result.status).toBe("RETRIEVED");
    if (result.status !== "RETRIEVED") {
      throw new Error("Expected retrieved keys");
    }
    expect(result.keys).toHaveLength(1);
    expect(Buffer.from(result.keys[0]?.material ?? []).toString("utf8")).toBe(
      canaryProductKey,
    );
    expect(transport.requests.map((request) => request.method)).toEqual([
      "GET",
    ]);
    expect(transport.requests[0]?.path).toContain(
      "/v2/order/GE1373B866F3/keys",
    );
  });

  it("returns pending for zero keys without exposing order detail", async () => {
    await expect(
      adapterWith(new CapturingTransport([])).retrievePurchasedKeys({
        correlationId: correlationId("retrieve"),
        expectedQuantity: 1,
        externalSupplierOrderId: "GE1373B866F3",
        supplierId: supplierId("kinguin"),
      }),
    ).resolves.toEqual({
      reasonCode: "FULFILLMENT_KEY_NOT_AVAILABLE_YET",
      status: "PENDING",
    });
  });

  it("blocks non-key retrieval paths, key return and redirects", async () => {
    const guard = new KinguinControlledKeyRetrievalTransport({
      baseUrl,
      delegate: new CapturingTransport([]),
    });
    await expect(
      guard.retrieveKeys(request("POST", "/v2/order/GE1373B866F3/keys")),
    ).rejects.toThrow(SupplierError);
    await expect(
      guard.retrieveKeys(request("POST", "/v2/order/GE1373B866F3/keys/return")),
    ).rejects.toThrow(SupplierError);
    await expect(
      guard.retrieveKeys(request("GET", "/v1/order/GE1373B866F3")),
    ).rejects.toThrow(SupplierError);
    await expect(
      new KinguinControlledKeyRetrievalTransport({
        baseUrl,
        delegate: new CapturingTransport([], 302),
      }).retrieveKeys(request("GET", "/v2/order/GE1373B866F3/keys")),
    ).rejects.toThrow(SupplierError);
  });

  it("rejects malformed supplier key response without leaking serial", async () => {
    await expect(
      adapterWith(
        new CapturingTransport([
          {
            id: "key-1",
            serial: canaryProductKey,
            type: "application/json",
          },
        ]),
      ).retrievePurchasedKeys({
        correlationId: correlationId("retrieve"),
        expectedQuantity: 1,
        externalSupplierOrderId: "GE1373B866F3",
        supplierId: supplierId("kinguin"),
      }),
    ).rejects.toThrow(SupplierError);
  });
});

const adapterWith = (
  transport: KinguinHttpTransport,
): KinguinKeyRetrievalAdapter => {
  const guard = new KinguinControlledKeyRetrievalTransport({
    baseUrl,
    delegate: transport,
  });
  const supplier = new KinguinSupplier(
    new KinguinHttpClient(
      {
        apiKeySecretName: "KINGUIN_API_KEY",
        baseUrl,
        environment: "PRODUCTION",
        maxResponseBytes: 1_000_000,
        productionPurchasingEnabled: false,
        timeoutMs: 10_000,
        webhookSecrets: {
          orderComplete: "",
          orderStatus: "",
          productUpdate: "",
        },
      },
      new EnvSecretProvider({ KINGUIN_API_KEY: "synthetic-fixture-key" }),
      { send: (input) => guard.retrieveKeys(input) },
    ),
  );
  return new KinguinKeyRetrievalAdapter(supplier);
};

const request = (
  method: KinguinHttpRequest["method"],
  path: string,
): KinguinHttpRequest => ({
  headers: { "X-Api-Key": "synthetic-fixture-key" },
  maxResponseBytes: 1_000_000,
  method,
  path: new URL(path, baseUrl).toString(),
  timeoutMs: 10_000,
});

class CapturingTransport implements KinguinHttpTransport {
  public readonly requests: KinguinHttpRequest[] = [];

  public constructor(
    private readonly body: unknown,
    private readonly status = 200,
  ) {}

  public async send(
    requestInput: KinguinHttpRequest,
  ): Promise<KinguinHttpResponse> {
    this.requests.push(requestInput);
    return {
      body: JSON.stringify(this.body),
      headers: {},
      status: this.status,
    };
  }
}
