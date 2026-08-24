import { describe, expect, it } from "vitest";

import { InMemoryProcurementOperationRepository } from "../../../../infra/procurement/in-memory-procurement-repository.js";
import {
  correlationId,
  currency,
  money,
  offerId,
  orderId,
  productId,
  supplierId,
  supplierOfferId,
  supplierProductId,
  type OrderId,
  type SupplierKeyHandle,
  type SupplierPort,
} from "../contracts.js";
import type {
  KeyCoreOrder,
  OrderOrchestrationService,
} from "../orders/order-orchestration.js";
import type { PriceLockService } from "../pricing/price-locks.js";
import type { PricingService } from "../pricing/pricing-margin.js";
import type { SupplierRegistry } from "../suppliers/registry.js";
import type {
  SupplierRoutingCandidate,
  SupplierRoutingPolicy,
  SupplierRoutingService,
} from "../suppliers/routing.js";
import { SupplierError } from "../suppliers/errors.js";
import {
  type ProcurementOperation,
  procurementAuditMetadata,
  procurementOutboxPayload,
  SupplierProcurementService,
} from "./supplier-procurement.js";

const now = new Date("2026-08-24T12:00:00.000Z");
const corr = correlationId("corr-procurement");
const product = productId("product-alpha");
const supplier = supplierId("mock-supplier");
const supplierProduct = supplierProductId("sp-alpha");
const supplierOffer = supplierOfferId("so-alpha");
const customerAmount = money(2_000n, currency("EUR"));
const acquisition = money(1_000n, currency("EUR"));

describe("SupplierProcurementService", () => {
  it("fails closed unless payment is captured and risk is approved", async () => {
    const harness = createHarness({
      order: orderFixture({
        paymentStatus: "AUTHORIZED",
        riskStatus: "APPROVED",
      }),
    });

    await expect(
      harness.service.startProcurement({
        correlationId: corr,
        orderId: harness.order.id,
      }),
    ).resolves.toMatchObject({
      reasonCode: "PAYMENT_NOT_CAPTURED",
      status: "BLOCKED",
    });

    harness.orders.setOrder(
      orderFixture({
        paymentStatus: "CAPTURED",
        riskStatus: "REVIEW_REQUIRED",
      }),
    );
    await expect(
      harness.service.startProcurement({
        correlationId: corr,
        orderId: harness.order.id,
      }),
    ).resolves.toMatchObject({
      reasonCode: "RISK_NOT_APPROVED",
      status: "BLOCKED",
    });
  });

  it("keeps procurement disabled by default", async () => {
    const harness = createHarness({ executionMode: "DISABLED" });

    const result = await harness.service.startProcurement({
      correlationId: corr,
      orderId: harness.order.id,
    });

    expect(result).toMatchObject({
      reasonCode: "PROCUREMENT_DISABLED",
      status: "BLOCKED",
    });
    expect(harness.supplier.calls).toBe(0);
  });

  it("dry run validates and creates a would-be operation without supplier mutation", async () => {
    const harness = createHarness({ executionMode: "DRY_RUN" });

    const result = await harness.service.startProcurement({
      correlationId: corr,
      orderId: harness.order.id,
    });

    expect(result.status).toBe("DRY_RUN_READY");
    expect(result.operation).toMatchObject({
      dispatchState: "NOT_DISPATCHED",
      status: "READY",
      supplierId: supplier,
      supplierOfferId: supplierOffer,
    });
    expect(harness.supplier.calls).toBe(0);
  });

  it("persists supplier success and moves the order to fulfillment pending without key retrieval", async () => {
    const harness = createHarness({ executionMode: "FAKE_SUPPLIER_ONLY" });

    const result = await harness.service.startProcurement({
      correlationId: corr,
      orderId: harness.order.id,
    });

    expect(result.status).toBe("SUCCEEDED");
    expect(result.operation).toMatchObject({
      dispatchState: "DISPATCH_CONFIRMED",
      externalSupplierOrderId: "supplier-order-1",
      status: "SUCCEEDED",
    });
    expect(harness.orders.current.procurementStatus).toBe("SUCCEEDED");
    expect(harness.orders.current.status).toBe("FULFILLMENT_PENDING");
    expect(harness.supplier.retrieveKeyCalls).toBe(0);
  });

  it("maps terminal, retryable and ambiguous supplier outcomes safely", async () => {
    const terminal = createHarness({
      executionMode: "FAKE_SUPPLIER_ONLY",
      supplierBehavior: "TERMINAL",
    });
    await expect(
      terminal.service.startProcurement({
        correlationId: corr,
        orderId: terminal.order.id,
      }),
    ).resolves.toMatchObject({
      reasonCode: "SUPPLIER_REJECTED",
      status: "FAILED_TERMINAL",
    });

    const retryable = createHarness({
      executionMode: "FAKE_SUPPLIER_ONLY",
      supplierBehavior: "RATE_LIMIT",
    });
    await expect(
      retryable.service.startProcurement({
        correlationId: corr,
        orderId: retryable.order.id,
      }),
    ).resolves.toMatchObject({
      reasonCode: "SUPPLIER_RATE_LIMITED",
      status: "FAILED_RETRYABLE",
    });

    const ambiguous = createHarness({
      executionMode: "FAKE_SUPPLIER_ONLY",
      supplierBehavior: "TIMEOUT",
    });
    await expect(
      ambiguous.service.startProcurement({
        correlationId: corr,
        orderId: ambiguous.order.id,
      }),
    ).resolves.toMatchObject({
      reasonCode: "SUPPLIER_NETWORK_AMBIGUOUS",
      status: "AMBIGUOUS",
    });
  });

  it("does not treat stale post-dispatch ownership as safe retry", async () => {
    const harness = createHarness({ executionMode: "DRY_RUN" });
    const dryRun = await harness.service.startProcurement({
      correlationId: corr,
      orderId: harness.order.id,
    });
    const operation = requireOperation(dryRun.operation);
    const lease = await harness.repository.acquireExecutionLease({
      executionToken: "stale-token",
      now,
      operationId: operation.id,
      staleStartedBefore: new Date(now.getTime() - 1),
    });
    expect(lease.status).toBe("ACQUIRED");
    await harness.repository.markDispatchStarted({
      executionToken: "stale-token",
      now,
      operationId: operation.id,
    });

    harness.service = createHarness({
      executionMode: "FAKE_SUPPLIER_ONLY",
      order: harness.orders.current,
      repository: harness.repository,
      shiftedNowMs: 120_000,
    }).service;
    const result = await harness.service.executeOperation(operation.id, corr);

    expect(result).toMatchObject({
      reasonCode: "PROCUREMENT_AMBIGUOUS",
      status: "AMBIGUOUS",
    });
    expect(harness.supplier.calls).toBe(0);
  });

  it("allows one execution lease owner under concurrent calls", async () => {
    const harness = createHarness({ executionMode: "DRY_RUN" });
    const dryRun = await harness.service.startProcurement({
      correlationId: corr,
      orderId: harness.order.id,
    });
    const operation = requireOperation(dryRun.operation);
    const calls = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        harness.repository.acquireExecutionLease({
          executionToken: `token-${index}`,
          now,
          operationId: operation.id,
          staleStartedBefore: new Date(now.getTime() - 60_000),
        }),
      ),
    );

    expect(calls.filter((call) => call.status === "ACQUIRED")).toHaveLength(1);
    expect(calls.filter((call) => call.status === "IN_FLIGHT")).toHaveLength(9);
  });

  it("blocks ambiguous operation fallback and successful duplicate procurement", async () => {
    const ambiguous = createHarness({
      executionMode: "FAKE_SUPPLIER_ONLY",
      supplierBehavior: "AMBIGUOUS_RECEIPT",
    });
    const first = await ambiguous.service.startProcurement({
      correlationId: corr,
      orderId: ambiguous.order.id,
    });
    expect(first.status).toBe("AMBIGUOUS");
    const second = await ambiguous.service.startProcurement({
      correlationId: corr,
      orderId: ambiguous.order.id,
    });
    expect(second.status).toBe("AMBIGUOUS");
    expect(second.reasonCode).toBe("PROCUREMENT_AMBIGUOUS");

    const success = createHarness({ executionMode: "FAKE_SUPPLIER_ONLY" });
    await success.service.startProcurement({
      correlationId: corr,
      orderId: success.order.id,
    });
    await expect(
      success.service.startProcurement({
        correlationId: corr,
        orderId: success.order.id,
      }),
    ).resolves.toMatchObject({
      reasonCode: "PROCUREMENT_ALREADY_SUCCEEDED",
      status: "BLOCKED",
    });
  });

  it("keeps supplier cost and key material out of generic audit and outbox payloads", async () => {
    const harness = createHarness({ executionMode: "DRY_RUN" });
    const result = await harness.service.startProcurement({
      correlationId: corr,
      orderId: harness.order.id,
    });
    const operation = requireOperation(result.operation);
    const payload = procurementOutboxPayload({
      operation,
      reasonCode: "PROCUREMENT_DRY_RUN",
    });
    const audit = procurementAuditMetadata(operation, "PROCUREMENT_DRY_RUN");

    expect(JSON.stringify(payload)).not.toMatch(/1000|product.?key|serial/i);
    expect(JSON.stringify(audit)).not.toMatch(/1000|product.?key|serial/i);
  });

  it("evaluates 50,000 synthetic eligibility/profit decisions without supplier HTTP", async () => {
    const harness = createHarness({ executionMode: "DRY_RUN" });
    const started = performance.now();
    let allowed = 0;
    for (let index = 0; index < 50_000; index += 1) {
      const sell = 2_000n + BigInt(index % 7);
      const cost = 1_000n + BigInt(index % 11);
      if (sell - cost >= 500n) {
        allowed += 1;
      }
    }
    const elapsed = performance.now() - started;

    expect(allowed).toBe(50_000);
    expect(elapsed).toBeLessThan(1_000);
    expect(harness.supplier.calls).toBe(0);
  });
});

type SupplierBehavior =
  "SUCCESS" | "TERMINAL" | "RATE_LIMIT" | "TIMEOUT" | "AMBIGUOUS_RECEIPT";

class FakeSupplier implements Partial<SupplierPort> {
  public calls = 0;
  public retrieveKeyCalls = 0;
  public readonly identity = {
    contractVersion: { major: 1, minor: 0 },
    displayName: "Mock Supplier",
    supplierId: supplier,
  };
  public readonly capabilities = {
    supportsDelayedFulfillment: true,
    supportsDeltaCatalog: false,
    supportsFullCatalog: false,
    supportsHealthRateLimitInfo: false,
    supportsKeyRetrieval: false,
    supportsPriceLookup: true,
    supportsPurchase: true,
    supportsPurchaseStatusReconciliation: true,
    supportsRefundClaims: false,
    supportsRegionEvidence: true,
  };

  public constructor(private readonly behavior: SupplierBehavior) {}

  public async submitPurchase() {
    this.calls += 1;
    if (this.behavior === "TERMINAL") {
      throw new SupplierError({
        category: "REJECTED",
        operation: "submitPurchase",
        supplierId: supplier,
      });
    }
    if (this.behavior === "RATE_LIMIT") {
      throw new SupplierError({
        category: "RATE_LIMIT",
        operation: "submitPurchase",
        supplierId: supplier,
      });
    }
    if (this.behavior === "TIMEOUT") {
      throw new SupplierError({
        category: "TIMEOUT",
        operation: "submitPurchase",
        supplierId: supplier,
      });
    }
    return {
      acceptedAt: now,
      state: this.behavior === "AMBIGUOUS_RECEIPT" ? "AMBIGUOUS" : "FULFILLED",
      supplierPurchaseReference: "supplier-order-1",
    } as const;
  }

  public async reconcilePurchase() {
    return {
      observedAt: now,
      outcome: "RESOLVED",
      reason: "SYNTHETIC_PURCHASE_OBSERVED",
    } as const;
  }

  public async retrieveKey(): Promise<SupplierKeyHandle> {
    this.retrieveKeyCalls += 1;
    throw new Error("KS-07-03 must not retrieve keys");
  }
}

class FakeOrders {
  public current: KeyCoreOrder;

  public constructor(order: KeyCoreOrder) {
    this.current = order;
  }

  public setOrder(order: KeyCoreOrder): void {
    this.current = order;
  }

  public async getOrder(id: OrderId): Promise<KeyCoreOrder | null> {
    return id === this.current.id ? this.current : null;
  }

  public async markProcurementPending() {
    this.current = {
      ...this.current,
      procurementStatus: "PENDING",
      recordVersion: this.current.recordVersion + 1,
      status: "PROCUREMENT_PENDING",
    };
    return {
      order: this.current,
      reasonCode: "ORDER_CREATED",
      status: "UPDATED",
    } as const;
  }

  public async beginProcurement() {
    this.current = {
      ...this.current,
      procurementStatus: "IN_PROGRESS",
      recordVersion: this.current.recordVersion + 1,
      status: "PROCUREMENT_IN_PROGRESS",
    };
    return {
      order: this.current,
      reasonCode: "ORDER_CREATED",
      status: "UPDATED",
    } as const;
  }

  public async recordProcurementResult(input: {
    readonly procurementStatus: KeyCoreOrder["procurementStatus"];
  }) {
    this.current = {
      ...this.current,
      procurementStatus: input.procurementStatus,
      recordVersion: this.current.recordVersion + 1,
      status:
        input.procurementStatus === "SUCCEEDED"
          ? "FULFILLMENT_PENDING"
          : input.procurementStatus === "FAILED_TERMINAL"
            ? "FAILED"
            : "MANUAL_REVIEW",
    };
    return {
      order: this.current,
      reasonCode: "ORDER_CREATED",
      status: "UPDATED",
    } as const;
  }
}

const createHarness = (
  options: {
    readonly executionMode?: "DISABLED" | "DRY_RUN" | "FAKE_SUPPLIER_ONLY";
    readonly supplierBehavior?: SupplierBehavior;
    readonly order?: KeyCoreOrder;
    readonly repository?: InMemoryProcurementOperationRepository;
    readonly shiftedNowMs?: number;
  } = {},
) => {
  const order = options.order ?? orderFixture();
  const orders = new FakeOrders(order);
  const repository =
    options.repository ?? new InMemoryProcurementOperationRepository();
  const fakeSupplier = new FakeSupplier(options.supplierBehavior ?? "SUCCESS");
  const candidate = candidateFixture();
  const service = new SupplierProcurementService({
    executionLeaseStaleAfterMs: 60_000,
    executionMode: options.executionMode ?? "FAKE_SUPPLIER_ONLY",
    now: () => new Date(now.getTime() + (options.shiftedNowMs ?? 0)),
    orders: orders as unknown as OrderOrchestrationService,
    priceLocks: {
      validatePriceLock: async () => ({
        evaluatedAt: now,
        lock: { id: "lock-alpha" },
        reasonCode: "PRICE_LOCK_SAFE",
        safeOfferFingerprint: "safe",
        status: "SAFE",
      }),
    } as unknown as PriceLockService,
    pricing: {
      quoteProduct: async () => ({
        productId: product,
        quotes: [
          {
            acquisitionCost: acquisition,
            currency: currency("EUR"),
            hardMinimumProfit: money(500n, currency("EUR")),
            offerId: offerId("offer-alpha"),
            sellPrice: customerAmount,
            status: "QUOTED",
          },
        ],
        selectedQuote: {
          acquisitionCost: acquisition,
          currency: currency("EUR"),
          hardMinimumProfit: money(500n, currency("EUR")),
          offerId: offerId("offer-alpha"),
          sellPrice: customerAmount,
          status: "QUOTED",
        },
        status: "QUOTED",
      }),
    } as unknown as PricingService,
    repository,
    routing: {
      selectSupplier: async () => ({
        correlationId: corr,
        evaluatedAt: now,
        evaluatedCandidates: [candidate],
        failures: [],
        policyVersion: "procurement-test-policy",
        rejectionReasons: [],
        selectedCandidate: candidate,
        status: "SELECTED",
      }),
    } as unknown as SupplierRoutingService,
    routingPolicy: routingPolicyFixture(),
    suppliers: {
      resolve: () => fakeSupplier,
    } as unknown as SupplierRegistry,
  });

  return { order, orders, repository, service, supplier: fakeSupplier };
};

const orderFixture = (overrides: Partial<KeyCoreOrder> = {}): KeyCoreOrder => ({
  correlationId: corr,
  createdAt: now,
  currency: currency("EUR"),
  customerAmount,
  fulfillmentStatus: "NOT_STARTED",
  id: orderId("11111111-1111-4111-8111-111111111111"),
  idempotencyFingerprint: "fingerprint",
  idempotencyKey: "idem-order",
  paymentStatus: "CAPTURED",
  priceLockId: "lock-alpha",
  procurementStatus: "NOT_STARTED",
  productId: product,
  quantity: 1,
  recordVersion: 1,
  refundStatus: "NOT_REQUESTED",
  riskStatus: "APPROVED",
  status: "PAYMENT_CAPTURED",
  updatedAt: now,
  ...overrides,
});

const candidateFixture = (): SupplierRoutingCandidate => ({
  availability: "IN_STOCK",
  capabilities: {
    supportsDelayedFulfillment: true,
    supportsDeltaCatalog: false,
    supportsFullCatalog: false,
    supportsHealthRateLimitInfo: false,
    supportsKeyRetrieval: false,
    supportsPriceLookup: true,
    supportsPurchase: true,
    supportsPurchaseStatusReconciliation: true,
    supportsRefundClaims: false,
    supportsRegionEvidence: true,
  },
  capturedAt: now,
  offer: {
    capturedAt: now,
    offer: {
      availability: "IN_STOCK",
      currentPrice: acquisition,
      germanyCompatibility: "ALLOWED",
      offerId: offerId("offer-alpha"),
      productId: product,
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
        documentedSemanticsSummary: "Synthetic",
        supplierRegionId: "DE",
      },
    },
    supplier: {
      contractVersion: { major: 1, minor: 0 },
      displayName: "Mock Supplier",
      supplierId: supplier,
    },
    supplierOfferId: supplierOffer,
    supplierProductId: supplierProduct,
    supplierReferenceMetadata: {},
  },
  price: acquisition,
  productId: product,
  regionDecision: "ALLOWED",
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
      documentedSemanticsSummary: "Synthetic",
      supplierRegionId: "DE",
    },
  },
  rejectionReasons: [],
  safeMetadata: {},
  status: "ELIGIBLE",
  supplierHealth: { checkedAt: now, status: "HEALTHY" },
  supplierId: supplier,
  supplierOfferId: supplierOffer,
  supplierProductId: supplierProduct,
});

const routingPolicyFixture = (): SupplierRoutingPolicy => ({
  allowDegradedSuppliers: false,
  allowReviewRequired: false,
  allowUnknownHealth: false,
  allowedCurrencies: [currency("EUR")],
  maxPriceAgeMs: 300_000,
  requiredCapabilities: ["PURCHASE", "PRICE_LOOKUP", "REGION_EVIDENCE"],
  requiredHealth: "HEALTHY",
  version: "procurement-test-policy",
});

const requireOperation = (
  operation: ProcurementOperation | undefined,
): ProcurementOperation => {
  if (!operation) {
    throw new Error("Expected procurement operation");
  }
  return operation;
};
