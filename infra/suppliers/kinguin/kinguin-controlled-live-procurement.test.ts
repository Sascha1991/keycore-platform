import { describe, expect, it } from "vitest";

import {
  correlationId,
  currency,
  money,
  supplierOfferId,
  supplierProductId,
  type Money,
} from "../../../packages/platform/src/contracts.js";
import { SupplierError } from "../../../packages/platform/src/suppliers/errors.js";
import {
  EnvSecretProvider,
  KinguinLiveReadonlyGuardedTransport,
} from "./kinguin-live-readonly.js";
import {
  buildControlledPurchaseRequest,
  controlledLiveConfigFromEnv,
  generateExecutionToken,
  hashExecutionToken,
  InMemoryControlledProcurementApprovalRepository,
  KinguinControlledOrderTransport,
  ControlledLiveProcurementService,
  validateControlledMutationConfig,
  validateControlledReadOnlyConfig,
  type ControlledProcurementApprovalRepository,
} from "./kinguin-controlled-live-procurement.js";
import {
  InMemoryKinguinOfferProductIndex,
  KinguinHttpClient,
  KinguinSupplier,
  createKinguinConfigFromEnv,
  type KinguinHttpRequest,
  type KinguinHttpResponse,
  type KinguinHttpTransport,
  type KinguinProduct,
} from "./kinguin-supplier.js";

const fixtureCredential = "readonly-fixture-credential";
const env = {
  KEYCORE_ALLOW_KINGUIN_LIVE_READONLY: "true",
  KEYCORE_KINGUIN_CONTROLLED_MUTATION_MODE: "CONTROLLED_VERIFICATION_ONE_TIME",
  KINGUIN_API_BASE_URL: "https://gateway.kinguin.net/esa/api",
  KINGUIN_API_KEY: fixtureCredential,
  KINGUIN_CONTROLLED_APPROVAL_TTL_MS: "300000",
  KINGUIN_CONTROLLED_ORDER_TIMEOUT_MS: "10000",
  KINGUIN_ENVIRONMENT: "PRODUCTION",
} satisfies Readonly<Record<string, string>>;

const productId = supplierProductId("product-alpha");
const offerId = supplierOfferId("offer-alpha");
const now = new Date("2026-08-24T12:00:00.000Z");

describe("controlled Kinguin live procurement", () => {
  it("requires explicit product and offer for preparation", async () => {
    const service = serviceFixture();
    await expect(
      service.prepare({
        correlationId: correlationId("corr"),
        maximumAcquisitionAmount: eur(600),
        quantity: 1,
        supplierOfferId: "" as typeof offerId,
        supplierProductId: productId,
      }),
    ).rejects.toThrow(SupplierError);
    await expect(
      service.prepare({
        correlationId: correlationId("corr"),
        maximumAcquisitionAmount: eur(600),
        quantity: 1,
        supplierOfferId: offerId,
        supplierProductId: "" as typeof productId,
      }),
    ).rejects.toThrow(SupplierError);
  });

  it("rejects unavailable, DE-ineligible, unknown-region and mapping-mismatched offers", async () => {
    await expect(
      serviceFixture({
        product: productFixture({ qty: 0 }),
      }).prepare(prepareInput()),
    ).rejects.toHaveProperty("context.operation", "OFFER_NOT_AVAILABLE");
    await expect(
      serviceFixture({
        product: productFixture({ regionalLimitations: "CIS" }),
      }).prepare(prepareInput()),
    ).rejects.toHaveProperty("context.operation", "GERMANY_INELIGIBLE");
    await expect(
      serviceFixture({
        product: productFixture({
          regionalLimitations: "Unknown Mars",
          regionId: 999,
        }),
      }).prepare(prepareInput()),
    ).rejects.toHaveProperty("context.operation", "REGION_REVIEW_REQUIRED");
    const mapping = new InMemoryKinguinOfferProductIndex([
      {
        supplierOfferId: offerId,
        supplierProductId: supplierProductId("different-product"),
      },
    ]);
    await expect(
      serviceFixture({ offerIndex: mapping }).prepare(prepareInput()),
    ).rejects.toHaveProperty("context.operation", "OFFER_MAPPING_CHANGED");
  });

  it("rejects invalid quantity, unsupported currency, invalid max and price increases", async () => {
    await expect(
      serviceFixture().prepare({ ...prepareInput(), quantity: 2 as 1 }),
    ).rejects.toHaveProperty("context.operation", "QUANTITY_MUST_BE_ONE");
    await expect(
      serviceFixture().prepare({
        ...prepareInput(),
        maximumAcquisitionAmount: money(600n, currency("USD")),
      }),
    ).rejects.toHaveProperty("context.operation", "INVALID_MAXIMUM_PRICE");
    await expect(
      serviceFixture().prepare({
        ...prepareInput(),
        maximumAcquisitionAmount: eur(0),
      }),
    ).rejects.toHaveProperty("context.operation", "INVALID_MAXIMUM_PRICE");
    await expect(
      serviceFixture().prepare({
        ...prepareInput(),
        maximumAcquisitionAmount: eur(500),
      }),
    ).rejects.toHaveProperty(
      "context.operation",
      "CURRENT_PRICE_EXCEEDS_APPROVAL_MAXIMUM",
    );
  });

  it("creates an approval manifest and sends zero POST requests during preparation", async () => {
    const transport = new FakeTransport();
    const repository = new InMemoryControlledProcurementApprovalRepository();
    const result = await serviceFixture({ repository, transport }).prepare(
      prepareInput(),
    );
    const persisted = await repository.findById(result.approvalId);

    expect(result.status).toBe("PREPARED");
    expect(result.purchaseMutation).toBe("NOT_SENT");
    expect(result.message).toBe("NO PURCHASE HAS BEEN SENT.");
    expect(result.orderExternalId).toMatch(/^keycore-liveverify-/u);
    expect(result.requestFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.oneTimeExecutionToken.length).toBeGreaterThanOrEqual(40);
    expect(persisted?.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(safeStringify(persisted)).not.toContain(
      result.oneTimeExecutionToken,
    );
    expect(
      transport.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(0);
  });

  it("uses stable fingerprints and binds price into the fingerprint", () => {
    const base = buildControlledPurchaseRequest({
      amount: eur(579),
      orderExternalId: "keycore-liveverify-fixed",
      supplierOfferId: offerId,
      supplierProductId: productId,
    });
    const repeated = buildControlledPurchaseRequest({
      amount: eur(579),
      orderExternalId: "keycore-liveverify-fixed",
      supplierOfferId: offerId,
      supplierProductId: productId,
    });
    const changedPrice = buildControlledPurchaseRequest({
      amount: eur(578),
      orderExternalId: "keycore-liveverify-fixed",
      supplierOfferId: offerId,
      supplierProductId: productId,
    });

    expect(repeated.fingerprint).toBe(base.fingerprint);
    expect(changedPrice.fingerprint).not.toBe(base.fingerprint);
  });

  it("generates high-entropy tokens, rejects wrong/expired/cancelled/different tokens and claims once", async () => {
    expect(
      new Set(Array.from({ length: 20 }, generateExecutionToken)).size,
    ).toBe(20);
    const repository = new InMemoryControlledProcurementApprovalRepository();
    const prepared = await serviceFixture({ repository }).prepare(
      prepareInput(),
    );

    await expect(
      repository.claim({
        approvalId: prepared.approvalId,
        now,
        tokenHash: hashExecutionToken("wrong-token"),
      }),
    ).resolves.toMatchObject({ status: "TOKEN_INVALID" });

    const claim = await repository.claim({
      approvalId: prepared.approvalId,
      now,
      tokenHash: hashExecutionToken(prepared.oneTimeExecutionToken),
    });
    expect(claim.status).toBe("CLAIMED");
    await expect(
      repository.claim({
        approvalId: prepared.approvalId,
        now,
        tokenHash: hashExecutionToken(prepared.oneTimeExecutionToken),
      }),
    ).resolves.toMatchObject({ status: "APPROVAL_ALREADY_CONSUMED" });

    const expiredRepo = new InMemoryControlledProcurementApprovalRepository();
    const expired = await serviceFixture({
      config: { ...controlledLiveConfigFromEnv(env), approvalTtlMs: 1 },
      repository: expiredRepo,
    }).prepare(prepareInput());
    await expect(
      expiredRepo.claim({
        approvalId: expired.approvalId,
        now: new Date(now.getTime() + 10_000),
        tokenHash: hashExecutionToken(expired.oneTimeExecutionToken),
      }),
    ).resolves.toMatchObject({ status: "APPROVAL_EXPIRED" });

    const cancelledRepo = new InMemoryControlledProcurementApprovalRepository();
    const cancelled = await serviceFixture({
      repository: cancelledRepo,
    }).prepare(prepareInput());
    await cancelledRepo.cancel({ approvalId: cancelled.approvalId, now });
    await expect(
      cancelledRepo.claim({
        approvalId: cancelled.approvalId,
        now,
        tokenHash: hashExecutionToken(cancelled.oneTimeExecutionToken),
      }),
    ).resolves.toMatchObject({ status: "APPROVAL_CANCELLED" });
  });

  it("allows only one owner across ten concurrent claims without raw errors", async () => {
    const repository = new InMemoryControlledProcurementApprovalRepository();
    const prepared = await serviceFixture({ repository }).prepare(
      prepareInput(),
    );
    const claims = await Promise.all(
      Array.from({ length: 10 }, () =>
        repository.claim({
          approvalId: prepared.approvalId,
          now,
          tokenHash: hashExecutionToken(prepared.oneTimeExecutionToken),
        }),
      ),
    );
    expect(claims.filter((claim) => claim.status === "CLAIMED")).toHaveLength(
      1,
    );
    expect(
      claims.filter((claim) => claim.status === "APPROVAL_ALREADY_CONSUMED"),
    ).toHaveLength(9);
  });

  it("blocks final preflight for price, currency, missing offer, mapping and eligibility changes", async () => {
    await expectExecuteBlock({
      changedProduct: productFixture({ price: 5.78 }),
      reasonCode: "REQUEST_FINGERPRINT_CHANGED",
    });
    await expectExecuteBlock({
      changedProduct: productFixture({ price: 6.0 }),
      reasonCode: "CURRENT_PRICE_EXCEEDS_APPROVAL_MAXIMUM",
    });
    await expectExecuteBlock({
      changedProduct: productFixture({ offers: [] }),
      reasonCode: "OFFER_NOT_FOUND",
    });
    await expectExecuteBlock({
      changedProduct: productFixture({ regionalLimitations: "CIS" }),
      reasonCode: "GERMANY_INELIGIBLE",
    });
  });

  it("blocks execution without controlled mutation mode and readonly opt-in cannot enable mutation", async () => {
    const repository = new InMemoryControlledProcurementApprovalRepository();
    const prepared = await serviceFixture({ repository }).prepare(
      prepareInput(),
    );
    const result = await serviceFixture({
      config: {
        ...controlledLiveConfigFromEnv(env),
        productionPurchasingEnabled: false,
      },
      repository,
    }).execute({
      approvalId: prepared.approvalId,
      correlationId: correlationId("execute"),
      executionToken: prepared.oneTimeExecutionToken,
    });

    expect(result).toMatchObject({
      reasonCode: "CONTROLLED_MUTATION_MODE_REQUIRED",
      status: "BLOCKED",
    });
  });

  it("claims before dispatch, persists DISPATCH_STARTED before the one allowed POST, and confirms success", async () => {
    const repository = new InMemoryControlledProcurementApprovalRepository();
    const mutationTransport = new FakeTransport({
      orderResponse: {
        createdAt: now.toISOString(),
        orderExternalId: "keycore-liveverify-fixed",
        orderId: "KNG-ORDER-1",
        status: "processing",
      },
    });
    const prepared = await serviceFixture({ repository }).prepare(
      prepareInput(),
    );
    const result = await serviceFixture({
      mutationTransport,
      repository,
    }).execute({
      approvalId: prepared.approvalId,
      correlationId: correlationId("execute"),
      executionToken: prepared.oneTimeExecutionToken,
    });
    const persisted = await repository.findById(prepared.approvalId);

    expect(result.status).toBe("PROCUREMENT_CONFIRMED");
    expect(persisted?.status).toBe("PROCUREMENT_CONFIRMED");
    expect(persisted?.dispatchState).toBe("DISPATCH_CONFIRMED");
    expect(
      mutationTransport.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1);
    await expect(
      serviceFixture({ mutationTransport, repository }).execute({
        approvalId: prepared.approvalId,
        correlationId: correlationId("execute-again"),
        executionToken: prepared.oneTimeExecutionToken,
      }),
    ).resolves.toMatchObject({ status: "BLOCKED" });
  });

  it("does not retry, fallback or send a second POST for malformed, timeout or rejection outcomes", async () => {
    for (const [transport, expected] of [
      [new FakeTransport({ orderResponse: { malformed: true } }), "AMBIGUOUS"],
      [new ThrowingTransport(), "AMBIGUOUS"],
      [
        new FakeTransport({ status: 404, orderResponse: {} }),
        "PROCUREMENT_REJECTED",
      ],
    ] as const) {
      const repository = new InMemoryControlledProcurementApprovalRepository();
      const prepared = await serviceFixture({ repository }).prepare(
        prepareInput(),
      );
      const result = await serviceFixture({
        mutationTransport: transport,
        repository,
      }).execute({
        approvalId: prepared.approvalId,
        correlationId: correlationId("execute"),
        executionToken: prepared.oneTimeExecutionToken,
      });
      expect(result.status).toBe(expected);
      expect(
        transport.requests.filter((request) => request.method === "POST"),
      ).toHaveLength(1);
    }
  });

  it("blocks non-order paths and POST redirects in controlled mutation transport", async () => {
    const guard = new KinguinControlledOrderTransport({
      baseUrl: env.KINGUIN_API_BASE_URL,
      delegate: new FakeTransport(),
    });
    await expect(
      guard.createOrder(request("GET", "/v2/order")),
    ).rejects.toThrow(SupplierError);
    await expect(
      guard.createOrder(request("POST", "/v2/order/order-alpha/keys")),
    ).rejects.toThrow(SupplierError);
    await expect(
      new KinguinControlledOrderTransport({
        baseUrl: env.KINGUIN_API_BASE_URL,
        delegate: new FakeTransport({ status: 302 }),
      }).createOrder(request("POST", "/v2/order")),
    ).rejects.toThrow(SupplierError);
  });

  it("reconciles with GET-only behavior and never retrieves keys", async () => {
    const repository = new InMemoryControlledProcurementApprovalRepository();
    const prepared = await serviceFixture({ repository }).prepare(
      prepareInput(),
    );
    const claimed = await repository.claim({
      approvalId: prepared.approvalId,
      now,
      tokenHash: hashExecutionToken(prepared.oneTimeExecutionToken),
    });
    if (claimed.status !== "CLAIMED") {
      throw new Error("Expected claim");
    }
    await repository.markDispatchStarted({
      approvalId: prepared.approvalId,
      now,
    });
    await repository.markAmbiguous({
      approvalId: prepared.approvalId,
      externalSupplierOrderId: "KNG-ORDER-1",
      now,
      reasonCode: "SUPPLIER_MUTATION_OUTCOME_AMBIGUOUS",
    });
    const transport = new FakeTransport({
      orderLookupResponse: {
        orderExternalId: prepared.orderExternalId,
        orderId: "KNG-ORDER-1",
        status: "completed",
      },
    });
    const result = await serviceFixture({
      allowOrderLookup: true,
      repository,
      transport,
    }).reconcile({
      approvalId: prepared.approvalId,
    });

    expect(result.status).toBe("CONFIRMED_SUCCESS");
    expect(transport.requests.map((item) => item.method)).toEqual(["GET"]);
    expect(transport.requests.some((item) => item.path.includes("/keys"))).toBe(
      false,
    );
  });

  it("keeps API keys, execution tokens, raw supplier payloads and product keys out of safe output", async () => {
    const repository = new InMemoryControlledProcurementApprovalRepository();
    const prepared = await serviceFixture({ repository }).prepare(
      prepareInput(),
    );
    const serialized = JSON.stringify(prepared);

    expect(serialized).not.toContain(fixtureCredential);
    expect(serialized).not.toMatch(/serial|product.?key|raw|X-Api-Key/iu);
    expect(
      safeStringify(await repository.findById(prepared.approvalId)),
    ).not.toContain(prepared.oneTimeExecutionToken);
  });

  it("validates live config boundaries and dry-run cannot instantiate mutation capability", () => {
    expect(() =>
      validateControlledReadOnlyConfig({ ...env, KINGUIN_API_KEY: "" }),
    ).toThrow(SupplierError);
    expect(() =>
      validateControlledReadOnlyConfig({
        ...env,
        KEYCORE_ALLOW_KINGUIN_LIVE_READONLY: "false",
      }),
    ).toThrow(SupplierError);
    expect(() =>
      validateControlledMutationConfig({
        ...env,
        KEYCORE_KINGUIN_CONTROLLED_MUTATION_MODE: undefined,
      }),
    ).toThrow(SupplierError);
  });
});

const expectExecuteBlock = async (input: {
  readonly changedProduct: KinguinProduct;
  readonly reasonCode: string;
}): Promise<void> => {
  const repository = new InMemoryControlledProcurementApprovalRepository();
  const prepared = await serviceFixture({ repository }).prepare(prepareInput());
  const result = await serviceFixture({
    product: input.changedProduct,
    repository,
  }).execute({
    approvalId: prepared.approvalId,
    correlationId: correlationId("execute"),
    executionToken: prepared.oneTimeExecutionToken,
  });
  expect(result).toMatchObject({
    reasonCode: input.reasonCode,
    status: "BLOCKED",
  });
};

const prepareInput = (
  overrides: {
    readonly maximumAcquisitionAmount?: Money;
  } = {},
) => ({
  correlationId: correlationId("prepare"),
  maximumAcquisitionAmount: overrides.maximumAcquisitionAmount ?? eur(579),
  quantity: 1 as const,
  supplierOfferId: offerId,
  supplierProductId: productId,
});

const serviceFixture = (
  options: {
    readonly config?: ReturnType<typeof controlledLiveConfigFromEnv>;
    readonly allowOrderLookup?: boolean;
    readonly mutationTransport?: KinguinHttpTransport;
    readonly offerIndex?: InMemoryKinguinOfferProductIndex;
    readonly product?: KinguinProduct;
    readonly repository?: ControlledProcurementApprovalRepository;
    readonly transport?: FakeTransport;
  } = {},
): ControlledLiveProcurementService => {
  const config = createKinguinConfigFromEnv(env);
  const transport =
    options.transport ??
    new FakeTransport(options.product ? { product: options.product } : {});
  const offerIndex =
    options.offerIndex ??
    new InMemoryKinguinOfferProductIndex([
      { supplierOfferId: offerId, supplierProductId: productId },
    ]);
  const readOnlyClient = new KinguinHttpClient(
    config,
    new EnvSecretProvider(env),
    options.allowOrderLookup
      ? transport
      : new KinguinLiveReadonlyGuardedTransport({
          baseUrl: config.baseUrl,
          delegate: transport,
          enabled: true,
        }),
  );
  const mutationGuard = new KinguinControlledOrderTransport({
    baseUrl: config.baseUrl,
    delegate: options.mutationTransport ?? new FakeTransport(),
  });
  const orderClient = new KinguinHttpClient(
    config,
    new EnvSecretProvider(env),
    { send: (requestInput) => mutationGuard.createOrder(requestInput) },
  );
  return new ControlledLiveProcurementService({
    config: options.config ?? controlledLiveConfigFromEnv(env),
    offerIndex,
    orderClient,
    readOnlySupplier: new KinguinSupplier(readOnlyClient, offerIndex),
    repository:
      options.repository ??
      new InMemoryControlledProcurementApprovalRepository(),
    now: () => now,
  });
};

const request = (
  method: KinguinHttpRequest["method"],
  path: string,
): KinguinHttpRequest => ({
  headers: { "X-Api-Key": fixtureCredential },
  maxResponseBytes: 1_000_000,
  method,
  path: new URL(path, env.KINGUIN_API_BASE_URL).toString(),
  timeoutMs: 10_000,
});

const eur = (amountMinor: number): Money =>
  money(BigInt(amountMinor), currency("EUR"));

const productFixture = (
  overrides: Partial<KinguinProduct> = {},
): KinguinProduct => ({
  activationDetails: "Activate on Steam",
  cheapestOfferId: ["offer-alpha"],
  isPreorder: false,
  kinguinId: 1949,
  name: "Synthetic Kinguin Product Steam CD Key",
  offers: [
    {
      availableQty: 12,
      isPreorder: false,
      name: "Synthetic Kinguin Product Steam CD Key",
      offerId: "offer-alpha",
      price: overrides.price ?? 5.79,
      qty: overrides.qty ?? 12,
      textQty: overrides.qty ?? 12,
    },
  ],
  originalName: "Synthetic Kinguin Product",
  platform: "PC Steam",
  price: overrides.price ?? 5.79,
  productId: "product-alpha",
  qty: overrides.qty ?? 12,
  regionId: overrides.regionId ?? 3,
  regionalLimitations: overrides.regionalLimitations ?? "REGION FREE",
  textQty: overrides.qty ?? 12,
  updatedAt: "2026-01-01T00:00:00+00:00",
  ...overrides,
});

class FakeTransport implements KinguinHttpTransport {
  public readonly requests: KinguinHttpRequest[] = [];

  public constructor(
    private readonly options: {
      readonly orderLookupResponse?: unknown;
      readonly orderResponse?: unknown;
      readonly product?: KinguinProduct;
      readonly status?: number;
    } = {},
  ) {}

  public async send(
    requestInput: KinguinHttpRequest,
  ): Promise<KinguinHttpResponse> {
    this.requests.push(requestInput);
    const url = new URL(requestInput.path);
    const path = url.pathname.replace("/esa/api", "");
    if (requestInput.method === "POST") {
      return {
        body: JSON.stringify(
          this.options.orderResponse ?? {
            createdAt: now.toISOString(),
            orderId: "KNG-ORDER-1",
            status: "processing",
          },
        ),
        headers: {},
        status: this.options.status ?? 201,
      };
    }
    if (path.startsWith("/v1/order/")) {
      return {
        body: JSON.stringify(
          this.options.orderLookupResponse ?? {
            orderId: "KNG-ORDER-1",
            status: "processing",
          },
        ),
        headers: {},
        status: 200,
      };
    }
    if (path.startsWith("/v2/products/")) {
      return {
        body: JSON.stringify(this.options.product ?? productFixture()),
        headers: {},
        status: 200,
      };
    }
    if (path === "/v1/products") {
      return {
        body: JSON.stringify({
          item_count: 1,
          results: [this.options.product ?? productFixture()],
        }),
        headers: {},
        status: 200,
      };
    }
    return { body: "[]", headers: {}, status: 200 };
  }
}

class ThrowingTransport implements KinguinHttpTransport {
  public readonly requests: KinguinHttpRequest[] = [];

  public async send(
    requestInput: KinguinHttpRequest,
  ): Promise<KinguinHttpResponse> {
    this.requests.push(requestInput);
    throw new Error("network timeout after dispatch");
  }
}

const safeStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, current) =>
    typeof current === "bigint" ? current.toString() : current,
  );
