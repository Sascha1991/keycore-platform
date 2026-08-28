import { describe, expect, it } from "vitest";

import {
  correlationId,
  currency,
  money,
  offerId as keycoreOfferId,
  productId as keycoreProductId,
  supplierId,
  supplierOfferId,
  supplierProductId,
  type Money,
  type AuditEvent,
  type NormalizedSupplierOffer,
  type NormalizedSupplierProduct,
  type OperationsControlGate,
} from "../../../packages/platform/src/contracts.js";

const allowOperationsControl = {
  evaluate: async () => ({ status: "ALLOWED" as const }),
};
import { parseCandidateListArgs } from "../../../scripts/kinguin-list-live-test-candidates.js";
import { SupplierError } from "../../../packages/platform/src/suppliers/errors.js";
import {
  EnvSecretProvider,
  KinguinLiveReadonlyGuardedTransport,
} from "./kinguin-live-readonly.js";
import {
  buildControlledPurchaseRequest,
  controlledLiveConfigFromEnv,
  createControlledLiveServiceFromEnv,
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
const canaryApiKey = ["SUPER", "SECRET"].join("_");
const canaryExecutionToken = ["EXECUTION", "SECRET"].join("_");
const canaryProductKey = ["PRODUCT", "KEY", "ABCDE-12345"].join("_");
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

  it("discovers candidates through bounded readonly pagination", async () => {
    const transport = new FakeTransport({
      productPages: [
        [productFixture({ offers: [] })],
        [productFixture({ productId: "product-page-2" })],
      ],
    });
    const result = await serviceFixture({ transport }).listCandidates({
      maxCandidates: 10,
      maxPages: 10,
      pageSize: 20,
    });

    expect(result).toMatchObject({
      eligibleCandidatesFound: 1,
      pagesInspected: 2,
      productRecordsInspected: 2,
      searchStoppedBecause: "END_OF_RESULTS",
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.mutationRequestCount).toBe(0);
    expect(
      transport.requests.every((request) => request.method === "GET"),
    ).toBe(true);
    expect(
      transport.requests.some((request) => request.path.includes("/keys")),
    ).toBe(false);
    expect(
      transport.requests.some((request) => request.path.includes("/v2/order")),
    ).toBe(false);
  });

  it("stops candidate discovery after maxCandidates and deduplicates repeated offers", async () => {
    const duplicate = productFixture({
      offers: [
        offerFixture({ offerId: "offer-duplicate", price: 1.99 }),
        offerFixture({ offerId: "offer-duplicate", price: 1.99 }),
        offerFixture({ offerId: "offer-second", price: 2.99 }),
      ],
      productId: "product-duplicate",
    });
    const transport = new FakeTransport({
      productPages: [[duplicate], [productFixture({ productId: "unread" })]],
    });
    const result = await serviceFixture({ transport }).listCandidates({
      maxCandidates: 2,
      maxPages: 10,
      pageSize: 20,
    });

    expect(result.searchStoppedBecause).toBe("MAX_CANDIDATES");
    expect(result.pagesInspected).toBe(1);
    expect(
      result.candidates.map((candidate) => candidate.supplierOfferId),
    ).toEqual(["offer-duplicate", "offer-second"]);
  });

  it("stops candidate discovery after empty page or maxPages", async () => {
    const emptyTransport = new FakeTransport({
      productPages: [[productFixture({ offers: [] })], []],
    });
    const emptyResult = await serviceFixture({
      transport: emptyTransport,
    }).listCandidates({
      maxCandidates: 10,
      maxPages: 10,
      pageSize: 20,
    });
    expect(emptyResult).toMatchObject({
      pagesInspected: 2,
      productRecordsInspected: 1,
      searchStoppedBecause: "END_OF_RESULTS",
    });

    const maxPagesTransport = new FakeTransport({
      forceNextCursor: true,
      productPages: [
        [productFixture({ offers: [] })],
        [productFixture({ offers: [], productId: "product-page-2" })],
        [productFixture({ productId: "product-page-3" })],
      ],
    });
    const maxPagesResult = await serviceFixture({
      transport: maxPagesTransport,
    }).listCandidates({
      maxCandidates: 10,
      maxPages: 2,
      pageSize: 20,
    });
    expect(maxPagesResult.searchStoppedBecause).toBe("MAX_PAGES");
    expect(maxPagesResult.pagesInspected).toBe(2);
    expect(
      maxPagesTransport.requests.filter((request) => {
        const url = new URL(request.path);
        return url.pathname.endsWith("/v1/products");
      }),
    ).toHaveLength(2);
  });

  it("caps candidate page size, max pages and max candidates", async () => {
    const transport = new FakeTransport({
      forceNextCursor: true,
      productPages: Array.from({ length: 30 }, (_, index) => [
        productFixture({
          productId: `product-${index}`,
          offers: [
            offerFixture({
              offerId: `offer-${index}`,
              price: ((100 + index) / 100).toFixed(2),
            }),
          ],
        }),
      ]),
    });
    const result = await serviceFixture({ transport }).listCandidates({
      maxCandidates: 100,
      maxPages: 100,
      pageSize: 100,
    });

    expect(result.candidates).toHaveLength(20);
    expect(result.searchStoppedBecause).toBe("MAX_CANDIDATES");
    const productRequests = transport.requests.filter((request) => {
      const url = new URL(request.path);
      return url.pathname.endsWith("/v1/products");
    });
    expect(productRequests[0]?.query).toMatchObject({ limit: 20, page: 1 });
    expect(productRequests.length).toBeLessThanOrEqual(25);
  });

  it("keeps eligibility, availability and currency filters fail-closed during discovery", async () => {
    const transport = new FakeTransport({
      productPages: [
        [
          productFixture({
            productId: "ineligible",
            regionalLimitations: "CIS",
          }),
          productFixture({
            productId: "unknown-region",
            regionId: 999,
            regionalLimitations: "Unknown Mars",
          }),
          productFixture({ productId: "unavailable", qty: 0 }),
          productFixture({
            offers: [offerFixture({ offerId: "zero-price", price: 0 })],
            productId: "zero-price",
          }),
          productFixture({
            offers: [offerFixture({ offerId: "valid", price: 3.49 })],
            productId: "valid",
          }),
        ],
      ],
    });
    const result = await serviceFixture({ transport }).listCandidates({
      maxCandidates: 10,
      maxPages: 1,
      pageSize: 20,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      supplierOfferId: "valid",
      supplierProductId: "valid",
    });
  });

  it("excludes unsupported currency during candidate discovery", async () => {
    const service = new ControlledLiveProcurementService({
      config: controlledLiveConfigFromEnv(env),
      offerIndex: new InMemoryKinguinOfferProductIndex(),
      readOnlySupplier: new StubCandidateSupplier({
        offer: {
          ...normalizedOfferFixture("usd-product", "usd-offer", 100n),
          offer: {
            ...normalizedOfferFixture("usd-product", "usd-offer", 100n).offer,
            currentPrice: money(100n, currency("USD")),
          },
        },
      }) as unknown as KinguinSupplier,
      repository: new InMemoryControlledProcurementApprovalRepository(),
    });

    const result = await service.listCandidates({
      maxCandidates: 10,
      maxPages: 1,
      pageSize: 20,
    });

    expect(result.candidates).toHaveLength(0);
  });

  it("sorts candidate prices numerically with deterministic tie-breaking", async () => {
    const transport = new FakeTransport({
      productPages: [
        [
          productFixture({
            offers: [offerFixture({ offerId: "offer-1000", price: 10 })],
            productId: "product-d",
          }),
          productFixture({
            offers: [offerFixture({ offerId: "offer-99", price: 0.99 })],
            productId: "product-c",
          }),
          productFixture({
            offers: [offerFixture({ offerId: "offer-900", price: 9 })],
            productId: "product-b",
          }),
          productFixture({
            offers: [
              offerFixture({ offerId: "offer-100", price: 1 }),
              offerFixture({ offerId: "offer-z", price: 1 }),
            ],
            productId: "product-a",
          }),
        ],
      ],
    });
    const result = await serviceFixture({ transport }).listCandidates({
      maxCandidates: 10,
      maxPages: 1,
      pageSize: 20,
    });

    expect(
      result.candidates.map((candidate) => [
        candidate.currentAcquisitionAmountMinor,
        candidate.supplierProductId,
        candidate.supplierOfferId,
      ]),
    ).toEqual([
      ["99", "product-c", "offer-99"],
      ["100", "product-a", "offer-100"],
      ["100", "product-a", "offer-z"],
      ["900", "product-b", "offer-900"],
      ["1000", "product-d", "offer-1000"],
    ]);
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

  it("blocks controlled live purchase before claim and POST when operations are paused", async () => {
    const repository = new InMemoryControlledProcurementApprovalRepository();
    const mutationTransport = new FakeTransport();
    const service = serviceFixture({
      mutationTransport,
      operationsControlGate: {
        evaluate: async () => ({
          reasonCode: "OPERATIONS_CONTROL_PAUSED",
          status: "DENIED",
        }),
      },
      repository,
    });
    const prepared = await service.prepare(prepareInput());
    await expect(
      service.execute({
        approvalId: prepared.approvalId,
        correlationId: correlationId("operations-paused"),
        executionToken: prepared.oneTimeExecutionToken,
      }),
    ).resolves.toMatchObject({
      reasonCode: "OPERATIONS_CONTROL_PAUSED",
      status: "BLOCKED",
    });
    expect(mutationTransport.requests).toHaveLength(0);
    await expect(
      repository.findById(prepared.approvalId),
    ).resolves.toMatchObject({
      dispatchState: "NOT_DISPATCHED",
      status: "APPROVED",
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

  it("persists and returns safe normalized diagnostics for definitive Kinguin 4xx rejections", async () => {
    const repository = new InMemoryControlledProcurementApprovalRepository();
    const audit = new CapturingAudit();
    const prepared = await serviceFixture({ repository }).prepare(
      prepareInput(),
    );
    const result = await serviceFixture({
      audit,
      mutationTransport: new FakeTransport({
        orderRawBody: JSON.stringify({
          detail: `api-key=${canaryApiKey} token=${canaryExecutionToken}`,
          kind: "InsufficientBalance",
          status: 400,
        }),
        status: 400,
      }),
      repository,
    }).execute({
      approvalId: prepared.approvalId,
      correlationId: correlationId("execute"),
      executionToken: prepared.oneTimeExecutionToken,
    });
    const persisted = await repository.findById(prepared.approvalId);

    expect(result).toMatchObject({
      reasonCode: "KINGUIN_INSUFFICIENT_BALANCE",
      safeReasonCode: "KINGUIN_INSUFFICIENT_BALANCE",
      status: "PROCUREMENT_REJECTED",
      supplierErrorCategory: "INSUFFICIENT_BALANCE",
      supplierErrorCode: "InsufficientBalance",
      supplierHttpStatus: 400,
    });
    expect(persisted?.rejectionDiagnostic).toEqual({
      safeReasonCode: "KINGUIN_INSUFFICIENT_BALANCE",
      supplier: "Kinguin",
      supplierErrorCategory: "INSUFFICIENT_BALANCE",
      supplierErrorCode: "InsufficientBalance",
      supplierHttpStatus: 400,
    });
    expect(JSON.stringify(result)).not.toContain(canaryApiKey);
    expect(safeStringify(persisted)).not.toContain(canaryExecutionToken);
    expect(JSON.stringify(audit.events)).not.toContain(canaryApiKey);
  });

  it("maps documented and status-based Kinguin rejection diagnostics safely", async () => {
    const cases = [
      [401, { kind: "Authorization", status: 401 }, "AUTHENTICATION"],
      [403, { kind: "Authorization", status: 403 }, "AUTHORIZATION"],
      [400, { kind: "ConstraintViolation", status: 400 }, "VALIDATION"],
      [422, { kind: "ConstraintViolation", status: 422 }, "VALIDATION"],
      [404, { kind: "ProductUnavailable", status: 404 }, "PRODUCT_UNAVAILABLE"],
      [409, { kind: "ResourceLock", status: 409 }, "SUPPLIER_REJECTION"],
      [429, { kind: "Http", status: 429 }, "RATE_LIMIT"],
      [
        418,
        { kind: "UnexpectedDocumentedKind", status: 418 },
        "SUPPLIER_REJECTION",
      ],
    ] as const;
    for (const [status, body, category] of cases) {
      const repository = new InMemoryControlledProcurementApprovalRepository();
      const prepared = await serviceFixture({ repository }).prepare(
        prepareInput(),
      );
      const result = await serviceFixture({
        mutationTransport: new FakeTransport({
          orderRawBody: JSON.stringify(body),
          status,
        }),
        repository,
      }).execute({
        approvalId: prepared.approvalId,
        correlationId: correlationId(`execute-${status}`),
        executionToken: prepared.oneTimeExecutionToken,
      });

      expect(result.status).toBe("PROCUREMENT_REJECTED");
      expect(result.supplierHttpStatus).toBe(status);
      expect(result.supplierErrorCategory).toBe(category);
      expect(result.supplierErrorCode).toBe(body.kind);
    }
  });

  it("does not persist arbitrary messages, HTML, huge bodies or unsafe machine codes", async () => {
    for (const orderRawBody of [
      JSON.stringify({
        debug: canaryProductKey,
        kind: `api-key=${canaryApiKey}`,
        message: `api-key=${canaryApiKey} token=${canaryExecutionToken}`,
        status: 400,
      }),
      `<html>api-key=${canaryApiKey} token=${canaryExecutionToken}</html>`,
      `${"x".repeat(20_000)}${canaryProductKey}`,
    ]) {
      const repository = new InMemoryControlledProcurementApprovalRepository();
      const prepared = await serviceFixture({ repository }).prepare(
        prepareInput(),
      );
      const result = await serviceFixture({
        mutationTransport: new FakeTransport({ orderRawBody, status: 400 }),
        repository,
      }).execute({
        approvalId: prepared.approvalId,
        correlationId: correlationId("execute-unsafe-body"),
        executionToken: prepared.oneTimeExecutionToken,
      });
      const persisted = await repository.findById(prepared.approvalId);
      const serialized = safeStringify({ persisted, result });

      expect(result.status).toBe("PROCUREMENT_REJECTED");
      expect(result.supplierErrorCode).toBeNull();
      expect(serialized).not.toContain(canaryApiKey);
      expect(serialized).not.toContain(canaryExecutionToken);
      expect(serialized).not.toContain(canaryProductKey);
      expect(serialized).not.toContain("<html>");
      expect(serialized).not.toContain("message");
    }
  });

  it("keeps 5xx, timeouts and malformed possible-success responses ambiguous without retry", async () => {
    for (const transport of [
      new FakeTransport({ orderRawBody: "{}", status: 500 }),
      new ThrowingTransport(),
      new FakeTransport({ orderResponse: { malformed: true } }),
    ]) {
      const repository = new InMemoryControlledProcurementApprovalRepository();
      const prepared = await serviceFixture({ repository }).prepare(
        prepareInput(),
      );
      const result = await serviceFixture({
        mutationTransport: transport,
        repository,
      }).execute({
        approvalId: prepared.approvalId,
        correlationId: correlationId("execute-ambiguous"),
        executionToken: prepared.oneTimeExecutionToken,
      });

      expect(result.status).toBe("AMBIGUOUS");
      expect(
        transport.requests.filter((request) => request.method === "POST"),
      ).toHaveLength(1);
    }
  });

  it("returns persisted safe rejection diagnostics from reconciliation", async () => {
    const repository = new InMemoryControlledProcurementApprovalRepository();
    const prepared = await serviceFixture({ repository }).prepare(
      prepareInput(),
    );
    const result = await serviceFixture({
      mutationTransport: new FakeTransport({
        orderRawBody: JSON.stringify({
          kind: "ProductUnavailable",
          status: 404,
        }),
        status: 404,
      }),
      repository,
    }).execute({
      approvalId: prepared.approvalId,
      correlationId: correlationId("execute-rejected"),
      executionToken: prepared.oneTimeExecutionToken,
    });
    expect(result.status).toBe("PROCUREMENT_REJECTED");

    const reconciliation = await serviceFixture({ repository }).reconcile({
      approvalId: prepared.approvalId,
    });

    expect(reconciliation).toMatchObject({
      safeReasonCode: "KINGUIN_PRODUCT_UNAVAILABLE",
      status: "CONFIRMED_REJECTION",
      supplierErrorCategory: "PRODUCT_UNAVAILABLE",
      supplierErrorCode: "ProductUnavailable",
      supplierHttpStatus: 404,
    });
  });

  it("keeps historical rejected approvals without diagnostics as unknown/null", async () => {
    const repository = new InMemoryControlledProcurementApprovalRepository();
    const prepared = await serviceFixture({ repository }).prepare(
      prepareInput(),
    );
    const claim = await repository.claim({
      approvalId: prepared.approvalId,
      now,
      tokenHash: hashExecutionToken(prepared.oneTimeExecutionToken),
    });
    expect(claim.status).toBe("CLAIMED");
    await repository.markDispatchStarted({
      approvalId: prepared.approvalId,
      now,
    });
    await repository.markRejected({
      approvalId: prepared.approvalId,
      now,
      reasonCode: "controlledPlaceOrder",
    });

    const reconciliation = await serviceFixture({ repository }).reconcile({
      approvalId: prepared.approvalId,
    });

    expect(reconciliation).toMatchObject({
      status: "CONFIRMED_REJECTION",
    });
    expect(reconciliation.safeReasonCode).toBeUndefined();
    expect(reconciliation.supplierHttpStatus).toBeUndefined();
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

  it("enforces real execution composition validators before controlled POST capability", () => {
    for (const unsafeEnv of [
      { ...env, KINGUIN_API_BASE_URL: "https://example.com/esa/api" },
      { ...env, KINGUIN_API_BASE_URL: "http://gateway.kinguin.net/esa/api" },
      { ...env, KINGUIN_ENVIRONMENT: "SANDBOX" },
      { ...env, KINGUIN_API_KEY: "" },
      { ...env, KINGUIN_API_BASE_URL: "https://gateway.kinguin.net/api" },
    ]) {
      expect(() =>
        createControlledLiveServiceFromEnv({
          env: unsafeEnv,
          mode: "CONTROLLED_MUTATION",
          repository: new InMemoryControlledProcurementApprovalRepository(),
        }),
      ).toThrow(SupplierError);
    }

    expect(() =>
      createControlledLiveServiceFromEnv({
        env,
        mode: "CONTROLLED_MUTATION",
        repository: new InMemoryControlledProcurementApprovalRepository(),
      }),
    ).not.toThrow();
  });

  it("enforces real readonly command composition and keeps it without POST capability", async () => {
    expect(() =>
      createControlledLiveServiceFromEnv({
        env: { ...env, KEYCORE_ALLOW_KINGUIN_LIVE_READONLY: "false" },
        mode: "READ_ONLY",
        repository: new InMemoryControlledProcurementApprovalRepository(),
      }),
    ).toThrow(SupplierError);
    expect(() =>
      createControlledLiveServiceFromEnv({
        env: { ...env, KINGUIN_API_BASE_URL: "https://example.com/esa/api" },
        mode: "READ_ONLY",
        repository: new InMemoryControlledProcurementApprovalRepository(),
      }),
    ).toThrow(SupplierError);

    const repository = new InMemoryControlledProcurementApprovalRepository();
    const transport = new FakeTransport();
    const service = createControlledLiveServiceFromEnv({
      env,
      mode: "READ_ONLY",
      readOnlyTransport: transport,
      repository,
    });
    const prepared = await service.prepare(prepareInput());
    const execute = await service.execute({
      approvalId: prepared.approvalId,
      correlationId: correlationId("readonly-execute"),
      executionToken: prepared.oneTimeExecutionToken,
    });

    expect(execute).toMatchObject({
      reasonCode: "CONTROLLED_MUTATION_MODE_REQUIRED",
      status: "BLOCKED",
    });
    expect(
      transport.requests.every((request) => request.method === "GET"),
    ).toBe(true);
  });

  it("uses guarded readonly reconciliation instead of a generic mutating transport", async () => {
    const repository = new InMemoryControlledProcurementApprovalRepository();
    const transport = new FakeTransport({
      orderLookupResponse: {
        orderExternalId: "keycore-liveverify-fixed",
        orderId: "KNG-ORDER-1",
        status: "completed",
      },
    });
    const service = createControlledLiveServiceFromEnv({
      env,
      mode: "READ_ONLY",
      readOnlyTransport: transport,
      repository,
    });
    const prepared = await service.prepare(prepareInput());
    const claim = await repository.claim({
      approvalId: prepared.approvalId,
      now,
      tokenHash: hashExecutionToken(prepared.oneTimeExecutionToken),
    });
    expect(claim.status).toBe("CLAIMED");
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

    await service.reconcile({ approvalId: prepared.approvalId });

    expect(transport.requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "GET",
    ]);
    expect(
      transport.requests.some((request) => request.path.includes("/keys")),
    ).toBe(false);
  });

  it("pins controlled mutation transport to the production Kinguin order endpoint", async () => {
    await expect(
      new KinguinControlledOrderTransport({
        baseUrl: "https://example.com/esa/api",
        delegate: new FakeTransport(),
      }).createOrder(request("POST", "/v2/order")),
    ).rejects.toHaveProperty(
      "context.operation",
      "CONTROLLED_ORDER_ENDPOINT_BLOCKED",
    );
    await expect(
      new KinguinControlledOrderTransport({
        baseUrl: env.KINGUIN_API_BASE_URL,
        delegate: new FakeTransport(),
      }).createOrder({
        ...request("POST", "/v2/order"),
        path: "https://gateway.kinguin.net/esa/api/v2/order?replay=true",
      }),
    ).rejects.toHaveProperty(
      "context.operation",
      "CONTROLLED_ORDER_ENDPOINT_BLOCKED",
    );
  });

  it("rejects invalid CLI numeric arguments for candidate discovery", () => {
    expect(() => parseCandidateListArgs(["--page-size", "0"])).toThrow(
      /Invalid --page-size/u,
    );
    expect(() => parseCandidateListArgs(["--max-pages", "-1"])).toThrow(
      /Invalid --max-pages/u,
    );
    expect(() =>
      parseCandidateListArgs(["--max-candidates", "not-a-number"]),
    ).toThrow(/Invalid --max-candidates/u);
    expect(parseCandidateListArgs(["--page-size", "20"])).toEqual({
      pageSize: 20,
    });
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
    readonly audit?: CapturingAudit;
    readonly config?: ReturnType<typeof controlledLiveConfigFromEnv>;
    readonly allowOrderLookup?: boolean;
    readonly mutationTransport?: KinguinHttpTransport;
    readonly offerIndex?: InMemoryKinguinOfferProductIndex;
    readonly operationsControlGate?: OperationsControlGate;
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
    operationsControlGate:
      options.operationsControlGate ?? allowOperationsControl,
    ...(options.audit ? { audit: options.audit } : {}),
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

const offerFixture = (
  overrides: Partial<NonNullable<KinguinProduct["offers"]>[number]> = {},
): NonNullable<KinguinProduct["offers"]>[number] => ({
  availableQty: 12,
  isPreorder: false,
  name: "Synthetic Kinguin Offer",
  offerId: "offer-alpha",
  price: 5.79,
  qty: 12,
  textQty: 12,
  ...overrides,
});

const productFixture = (
  overrides: Partial<KinguinProduct> = {},
): KinguinProduct => {
  const productReference = overrides.productId ?? "product-alpha";
  const offers = overrides.offers ?? [
    offerFixture({
      offerId: overrides.productId
        ? `offer-${productReference}`
        : "offer-alpha",
      name: "Synthetic Kinguin Product Steam CD Key",
      price: overrides.price ?? 5.79,
      qty: overrides.qty ?? 12,
      textQty: overrides.qty ?? 12,
    }),
  ];
  return {
    activationDetails: "Activate on Steam",
    cheapestOfferId: offers[0]?.offerId ? [offers[0].offerId] : [],
    isPreorder: false,
    kinguinId: 1949,
    name: "Synthetic Kinguin Product Steam CD Key",
    offers,
    originalName: "Synthetic Kinguin Product",
    platform: "PC Steam",
    price: overrides.price ?? 5.79,
    productId: productReference,
    qty: overrides.qty ?? 12,
    regionId: overrides.regionId ?? 3,
    regionalLimitations: overrides.regionalLimitations ?? "REGION FREE",
    textQty: overrides.qty ?? 12,
    updatedAt: "2026-01-01T00:00:00+00:00",
    ...overrides,
  };
};

const normalizedProductFixture = (
  productReference: string,
): NormalizedSupplierProduct => ({
  changedAt: now,
  lifecycle: "IN_STOCK",
  product: {
    platforms: ["WINDOWS"],
    productId: keycoreProductId(`supplier:kinguin:${productReference}`),
    title: `Synthetic ${productReference}`,
    type: "GAME",
  },
  supplier: {
    contractVersion: { major: 1, minor: 0 },
    displayName: "Kinguin",
    supplierId: supplierId("kinguin"),
  },
  supplierProductId: supplierProductId(productReference),
});

const normalizedOfferFixture = (
  productReference: string,
  offerReference: string,
  amountMinor: bigint,
): NormalizedSupplierOffer => ({
  capturedAt: now,
  offer: {
    availability: "IN_STOCK",
    currentPrice: money(amountMinor, currency("EUR")),
    germanyCompatibility: "REVIEW_REQUIRED",
    offerId: keycoreOfferId(`supplier:kinguin:${offerReference}`),
    productId: keycoreProductId(`supplier:kinguin:${productReference}`),
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
      supplierRegionId: "3",
    },
  },
  supplier: {
    contractVersion: { major: 1, minor: 0 },
    displayName: "Kinguin",
    supplierId: supplierId("kinguin"),
  },
  supplierOfferId: supplierOfferId(offerReference),
  supplierProductId: supplierProductId(productReference),
  supplierReferenceMetadata: {},
});

class StubCandidateSupplier {
  public constructor(
    private readonly input: {
      readonly offer: NormalizedSupplierOffer;
    },
  ) {}

  public async searchProducts(): Promise<{
    readonly items: readonly NormalizedSupplierProduct[];
  }> {
    return {
      items: [normalizedProductFixture(this.input.offer.supplierProductId)],
    };
  }

  public async getProductWithOffers(): Promise<{
    readonly product: NormalizedSupplierProduct;
    readonly offers: readonly NormalizedSupplierOffer[];
  }> {
    return {
      offers: [this.input.offer],
      product: normalizedProductFixture(this.input.offer.supplierProductId),
    };
  }
}

class FakeTransport implements KinguinHttpTransport {
  public readonly requests: KinguinHttpRequest[] = [];

  public constructor(
    private readonly options: {
      readonly orderLookupResponse?: unknown;
      readonly orderRawBody?: string;
      readonly orderResponse?: unknown;
      readonly product?: KinguinProduct;
      readonly productPages?: readonly (readonly KinguinProduct[])[];
      readonly forceNextCursor?: boolean;
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
        body:
          this.options.orderRawBody ??
          JSON.stringify(
            this.options.orderResponse ?? {
              createdAt: now.toISOString(),
              orderId: "KNG-ORDER-1",
              status: "processing",
            },
          ),
        headers: { "x-debug-secret": `api-key=${canaryApiKey}` },
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
      const productReference = decodeURIComponent(path.split("/").at(-1) ?? "");
      const product = this.productByReference(productReference);
      return {
        body: JSON.stringify(
          product ?? this.options.product ?? productFixture(),
        ),
        headers: {},
        status: 200,
      };
    }
    if (path === "/v1/products") {
      const page =
        typeof requestInput.query?.page === "number"
          ? requestInput.query.page
          : 1;
      const pageItems =
        this.options.productPages?.[page - 1] ??
        (this.options.product ? [this.options.product] : [productFixture()]);
      const itemCount =
        this.options.productPages && !this.options.forceNextCursor
          ? this.options.productPages.length *
            Number(requestInput.query?.limit ?? pageItems.length)
          : page * Number(requestInput.query?.limit ?? pageItems.length) + 1;
      return {
        body: JSON.stringify({
          item_count: itemCount,
          results: pageItems,
        }),
        headers: {},
        status: 200,
      };
    }
    return { body: "[]", headers: {}, status: 200 };
  }

  private productByReference(reference: string): KinguinProduct | null {
    const products = [
      ...(this.options.productPages?.flat() ?? []),
      ...(this.options.product ? [this.options.product] : []),
    ];
    return (
      products.find(
        (product) =>
          product.productId === reference ||
          `kinguin-id:${product.kinguinId ?? ""}` === reference,
      ) ?? null
    );
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

class CapturingAudit {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const safeStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, current) =>
    typeof current === "bigint" ? current.toString() : current,
  );
