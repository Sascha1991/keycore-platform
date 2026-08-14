import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  SupplierRegistry,
  SupplierRoutingService,
  correlationId,
  currency,
  money,
  offerId,
  productId,
  regionCode,
  supplierId,
  supplierOfferId,
  supplierProductId,
  type AuditEvent,
  type AuditEventPort,
  type ClockPort,
  type CurrencyConversionPort,
  type GermanyCompatibilityDecision,
  type ProductId,
  type ProductSupplierMappingPort,
  type ProductSupplierOfferMapping,
  type RegionEligibilityPort,
  type RegionEvidence,
  type SupplierId,
  type SupplierObservabilityEvent,
  type SupplierObservabilityPort,
  type SupplierOfferId,
  type SupplierProductId,
  type SupplierRoutingPolicy,
} from "../../../packages/platform/src/contracts.js";
import {
  MockSupplier,
  type MockOfferFixture,
  type MockSupplierOptions,
} from "../mock/mock-supplier.js";

const now = new Date("2026-01-10T00:00:00.000Z");
const canonicalProductId = productId("canonical-product-routing");
const supplierAId = supplierId("mock-supplier-a");
const supplierBId = supplierId("mock-supplier-b");
const supplierCId = supplierId("mock-supplier-c");
const supplierAOfferId = supplierOfferId("a-offer-1");
const supplierBOfferId = supplierOfferId("b-offer-1");
const supplierCOfferId = supplierOfferId("c-offer-1");
const supplierAProductId = supplierProductId("a-product-1");
const supplierBProductId = supplierProductId("b-product-1");
const supplierCProductId = supplierProductId("c-product-1");

class StaticMappingPort implements ProductSupplierMappingPort {
  public constructor(
    private readonly mappings: readonly ProductSupplierOfferMapping[],
  ) {}

  public async findSupplierOffers(
    productReference: ProductId,
  ): Promise<readonly ProductSupplierOfferMapping[]> {
    return this.mappings.filter(
      (mapping) => mapping.productId === productReference,
    );
  }
}

class StaticRegionEligibility implements RegionEligibilityPort {
  public constructor(
    private readonly decisions: Readonly<
      Record<string, GermanyCompatibilityDecision>
    >,
  ) {}

  public async evaluate(request: {
    readonly supplierId: SupplierId;
    readonly supplierOfferId: SupplierOfferId;
    readonly regionEvidence: RegionEvidence;
  }): Promise<GermanyCompatibilityDecision> {
    return this.decisions[request.supplierId] ?? "ALLOWED";
  }
}

class CapturingObservability implements SupplierObservabilityPort {
  public readonly events: SupplierObservabilityEvent[] = [];

  public record(event: SupplierObservabilityEvent): void {
    this.events.push(event);
  }
}

class CapturingAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const clock: ClockPort = {
  now: () => now,
};

const safeEvidence = (): RegionEvidence => ({
  activationRestrictions: [],
  allowedCountries: [regionCode("DE")],
  excludedCountries: [],
  hasContradictoryEvidence: false,
  hasMissingValues: false,
  hasUnknownValues: false,
  requiresForeignAccount: false,
  requiresVpn: false,
});

const reviewEvidence = (): RegionEvidence => ({
  activationRestrictions: [],
  allowedCountries: [],
  excludedCountries: [],
  hasContradictoryEvidence: false,
  hasMissingValues: true,
  hasUnknownValues: true,
  requiresForeignAccount: "UNKNOWN",
  requiresVpn: "UNKNOWN",
});

const vpnEvidence = (): RegionEvidence => ({
  activationRestrictions: [{ kind: "VPN_REQUIRED" }],
  allowedCountries: [regionCode("DE")],
  excludedCountries: [],
  hasContradictoryEvidence: false,
  hasMissingValues: false,
  hasUnknownValues: false,
  requiresForeignAccount: false,
  requiresVpn: true,
});

const supplier = (request: {
  readonly supplierReference: SupplierId;
  readonly productReference: SupplierProductId;
  readonly offerReference: SupplierOfferId;
  readonly amountMinor: bigint;
  readonly currencyCode?: "EUR" | "USD";
  readonly availability?: "IN_STOCK" | "OUT_OF_STOCK" | "LIMITED" | "UNKNOWN";
  readonly capturedAt?: Date;
  readonly evidence?: RegionEvidence;
  readonly health?: "HEALTHY" | "DEGRADED" | "OUTAGE" | "UNKNOWN";
  readonly rateLimitRemaining?: number;
  readonly title?: string;
  readonly capabilities?: MockSupplierOptions["capabilities"];
  readonly faultByOperation?: MockSupplierOptions["faultByOperation"];
}): MockSupplier => {
  const offer: MockOfferFixture = {
    availability: request.availability ?? "IN_STOCK",
    capturedAt: request.capturedAt ?? now,
    changedAt: request.capturedAt ?? now,
    keycoreOfferId: offerId(`kc-${request.offerReference}`),
    price: money(request.amountMinor, currency(request.currencyCode ?? "EUR")),
    purchaseScenario: "ACCEPTED_IMMEDIATE",
    regionEvidence: request.evidence ?? safeEvidence(),
    supplierOfferId: request.offerReference,
    supplierProductId: request.productReference,
    supplierReferenceMetadata: {
      fixture: "routing",
      supplier: request.supplierReference,
    },
  };

  const options: MockSupplierOptions = {
    health: {
      checkedAt: now,
      rateLimit: {
        limit: 100,
        remaining: request.rateLimitRemaining ?? 50,
        resetAt: new Date("2026-01-10T01:00:00.000Z"),
      },
      status: request.health ?? "HEALTHY",
    },
    identity: {
      contractVersion: { major: 1, minor: 0 },
      displayName: request.supplierReference,
      supplierId: request.supplierReference,
    },
    offers: [offer],
    products: [
      {
        changedAt: now,
        keycoreProductId: canonicalProductId,
        lifecycle: request.availability ?? "IN_STOCK",
        platforms: ["WINDOWS"],
        supplierProductId: request.productReference,
        title: request.title ?? `Synthetic ${request.supplierReference}`,
        type: "GAME",
      },
    ],
  };

  return new MockSupplier({
    ...options,
    ...(request.capabilities ? { capabilities: request.capabilities } : {}),
    ...(request.faultByOperation
      ? { faultByOperation: request.faultByOperation }
      : {}),
  });
};

const mappings = (): readonly ProductSupplierOfferMapping[] => [
  {
    productId: canonicalProductId,
    supplierId: supplierAId,
    supplierOfferId: supplierAOfferId,
    supplierProductId: supplierAProductId,
  },
  {
    productId: canonicalProductId,
    supplierId: supplierBId,
    supplierOfferId: supplierBOfferId,
    supplierProductId: supplierBProductId,
  },
];

const threeSupplierMappings = (): readonly ProductSupplierOfferMapping[] => [
  ...mappings(),
  {
    productId: canonicalProductId,
    supplierId: supplierCId,
    supplierOfferId: supplierCOfferId,
    supplierProductId: supplierCProductId,
  },
];

const basePolicy = (
  override: Partial<SupplierRoutingPolicy> = {},
): SupplierRoutingPolicy => ({
  allowedCurrencies: [currency("EUR")],
  allowDegradedSuppliers: false,
  allowReviewRequired: false,
  allowUnknownHealth: false,
  comparisonCurrency: currency("EUR"),
  maxPriceAgeMs: 7 * 24 * 60 * 60 * 1_000,
  requiredCapabilities: ["PRICE_LOOKUP", "REGION_EVIDENCE", "PURCHASE"],
  requiredHealth: "HEALTHY",
  supplierPriority: [supplierAId, supplierBId],
  version: "test-policy-v1",
  ...override,
});

const basePolicyWithoutFx = (
  override: Partial<Omit<SupplierRoutingPolicy, "comparisonCurrency">> = {},
): SupplierRoutingPolicy => {
  return {
    allowedCurrencies: [currency("EUR")],
    allowDegradedSuppliers: false,
    allowReviewRequired: false,
    allowUnknownHealth: false,
    maxPriceAgeMs: 7 * 24 * 60 * 60 * 1_000,
    requiredCapabilities: ["PRICE_LOOKUP", "REGION_EVIDENCE", "PURCHASE"],
    requiredHealth: "HEALTHY",
    supplierPriority: [supplierAId, supplierBId],
    version: "test-policy-v1",
    ...override,
  };
};

const createRouting = (
  request: {
    readonly supplierA?: MockSupplier;
    readonly supplierB?: MockSupplier;
    readonly supplierC?: MockSupplier;
    readonly region?: RegionEligibilityPort;
    readonly mappingPort?: ProductSupplierMappingPort;
    readonly observability?: SupplierObservabilityPort;
    readonly audit?: AuditEventPort;
  } = {},
): SupplierRoutingService => {
  const registry = new SupplierRegistry();
  registry.register(
    request.supplierA ??
      supplier({
        amountMinor: 1_000n,
        offerReference: supplierAOfferId,
        productReference: supplierAProductId,
        supplierReference: supplierAId,
      }),
  );
  registry.register(
    request.supplierB ??
      supplier({
        amountMinor: 1_500n,
        offerReference: supplierBOfferId,
        productReference: supplierBProductId,
        supplierReference: supplierBId,
      }),
  );
  if (request.supplierC) {
    registry.register(request.supplierC);
  }

  return new SupplierRoutingService(
    registry,
    request.mappingPort ?? new StaticMappingPort(mappings()),
    request.region ?? new StaticRegionEligibility({}),
    clock,
    request.observability,
    request.audit,
    "CI",
  );
};

const select = (
  routing: SupplierRoutingService,
  policy = basePolicy(),
  conversion?: CurrencyConversionPort,
) =>
  routing.selectSupplier(
    {
      correlationId: correlationId("corr-routing-test"),
      productId: canonicalProductId,
    },
    policy,
    conversion,
  );

describe("multi-supplier routing foundation", () => {
  it("registers two suppliers and preserves supplier-specific IDs", async () => {
    const result = await select(createRouting());

    expect(result.evaluatedCandidates).toHaveLength(2);
    expect(
      result.evaluatedCandidates.map((candidate) => candidate.supplierId),
    ).toEqual([supplierAId, supplierBId]);
    expect(
      result.evaluatedCandidates.map(
        (candidate) => candidate.supplierProductId,
      ),
    ).toEqual([supplierAProductId, supplierBProductId]);
  });

  it("selects the lowest eligible same-currency supplier", async () => {
    const result = await select(createRouting());

    expect(result.status).toBe("SELECTED");
    expect(result.selectedCandidate?.supplierId).toBe(supplierAId);
  });

  it("rejects blocked or review-required cheapest suppliers and selects safe fallback", async () => {
    await expect(
      select(
        createRouting({
          region: new StaticRegionEligibility({ [supplierAId]: "BLOCKED" }),
        }),
      ),
    ).resolves.toMatchObject({
      selectedCandidate: { supplierId: supplierBId },
      status: "SELECTED",
    });

    await expect(
      select(
        createRouting({
          region: new StaticRegionEligibility({
            [supplierAId]: "REVIEW_REQUIRED",
          }),
        }),
      ),
    ).resolves.toMatchObject({
      selectedCandidate: { supplierId: supplierBId },
      status: "SELECTED",
    });
  });

  it("rejects disabled, out-of-stock, outage, unknown-health and stale suppliers", async () => {
    await expect(
      select(
        createRouting(),
        basePolicy({
          supplierStates: { [supplierAId]: "DISABLED" },
        }),
      ),
    ).resolves.toMatchObject({
      selectedCandidate: { supplierId: supplierBId },
    });

    await expect(
      select(
        createRouting({
          supplierA: supplier({
            amountMinor: 500n,
            availability: "OUT_OF_STOCK",
            offerReference: supplierAOfferId,
            productReference: supplierAProductId,
            supplierReference: supplierAId,
          }),
        }),
      ),
    ).resolves.toMatchObject({
      selectedCandidate: { supplierId: supplierBId },
    });

    await expect(
      select(
        createRouting({
          supplierA: supplier({
            amountMinor: 500n,
            health: "OUTAGE",
            offerReference: supplierAOfferId,
            productReference: supplierAProductId,
            supplierReference: supplierAId,
          }),
        }),
      ),
    ).resolves.toMatchObject({
      selectedCandidate: { supplierId: supplierBId },
    });

    await expect(
      select(
        createRouting({
          supplierA: supplier({
            amountMinor: 500n,
            health: "UNKNOWN",
            offerReference: supplierAOfferId,
            productReference: supplierAProductId,
            supplierReference: supplierAId,
          }),
        }),
      ),
    ).resolves.toMatchObject({
      selectedCandidate: { supplierId: supplierBId },
    });

    await expect(
      select(
        createRouting({
          supplierA: supplier({
            amountMinor: 500n,
            capturedAt: new Date("2025-12-01T00:00:00.000Z"),
            offerReference: supplierAOfferId,
            productReference: supplierAProductId,
            supplierReference: supplierAId,
          }),
        }),
      ),
    ).resolves.toMatchObject({
      selectedCandidate: { supplierId: supplierBId },
    });
  });

  it("uses degraded suppliers only when policy allows and still prefers healthy", async () => {
    const degradedOnly = await select(
      createRouting({
        supplierB: supplier({
          amountMinor: 1_500n,
          health: "OUTAGE",
          offerReference: supplierBOfferId,
          productReference: supplierBProductId,
          supplierReference: supplierBId,
        }),
        supplierA: supplier({
          amountMinor: 500n,
          health: "DEGRADED",
          offerReference: supplierAOfferId,
          productReference: supplierAProductId,
          supplierReference: supplierAId,
        }),
      }),
      basePolicy({ allowDegradedSuppliers: true }),
    );
    const healthyPreferred = await select(
      createRouting({
        supplierA: supplier({
          amountMinor: 500n,
          health: "DEGRADED",
          offerReference: supplierAOfferId,
          productReference: supplierAProductId,
          supplierReference: supplierAId,
        }),
      }),
      basePolicy({ allowDegradedSuppliers: true }),
    );

    expect(degradedOnly.status).toBe("DEGRADED_ONLY");
    expect(healthyPreferred.selectedCandidate?.supplierId).toBe(supplierBId);
  });

  it("does not compare different currencies without FX and uses conversion when injected", async () => {
    const routing = createRouting({
      supplierB: supplier({
        amountMinor: 900n,
        currencyCode: "USD",
        offerReference: supplierBOfferId,
        productReference: supplierBProductId,
        supplierReference: supplierBId,
      }),
    });

    await expect(
      select(
        routing,
        basePolicyWithoutFx({
          allowedCurrencies: [currency("EUR"), currency("USD")],
        }),
      ),
    ).resolves.toMatchObject({ status: "NON_COMPARABLE" });

    const converted = await select(
      routing,
      basePolicy({
        allowedCurrencies: [currency("EUR"), currency("USD")],
        comparisonCurrency: currency("EUR"),
      }),
      {
        convert: async ({ money: source }) =>
          money(source.amountMinor + 200n, currency("EUR")),
      },
    );

    expect(converted.status).toBe("SELECTED");
    expect(converted.selectedCandidate?.supplierId).toBe(supplierAId);
  });

  it("uses deterministic priority and SupplierId tie-breaks", async () => {
    const equalPrice = await select(
      createRouting({
        supplierB: supplier({
          amountMinor: 1_000n,
          offerReference: supplierBOfferId,
          productReference: supplierBProductId,
          supplierReference: supplierBId,
        }),
      }),
      basePolicy({ supplierPriority: [supplierBId, supplierAId] }),
    );
    const stableId = await select(
      createRouting({
        supplierB: supplier({
          amountMinor: 1_000n,
          offerReference: supplierBOfferId,
          productReference: supplierBProductId,
          supplierReference: supplierBId,
        }),
      }),
      basePolicy({ supplierPriority: [] }),
    );

    expect(equalPrice.selectedCandidate?.supplierId).toBe(supplierBId);
    expect(stableId.selectedCandidate?.supplierId).toBe(supplierAId);
  });

  it("isolates supplier timeout and rate-limit failures", async () => {
    const timeout = await select(
      createRouting({
        supplierA: supplier({
          amountMinor: 500n,
          faultByOperation: { getOffer: "TIMEOUT" },
          offerReference: supplierAOfferId,
          productReference: supplierAProductId,
          supplierReference: supplierAId,
        }),
      }),
    );
    const rateLimited = await select(
      createRouting({
        supplierA: supplier({
          amountMinor: 500n,
          offerReference: supplierAOfferId,
          productReference: supplierAProductId,
          rateLimitRemaining: 0,
          supplierReference: supplierAId,
        }),
      }),
    );

    expect(timeout.failures).toEqual([
      expect.objectContaining({ category: "TIMEOUT", supplierId: supplierAId }),
    ]);
    expect(timeout.selectedCandidate?.supplierId).toBe(supplierBId);
    expect(rateLimited.selectedCandidate?.supplierId).toBe(supplierBId);
    expect(rateLimited.rejectionReasons).toContain("RATE_LIMITED");
  });

  it("returns no eligible and manual-review results explicitly", async () => {
    await expect(
      select(
        createRouting({
          supplierA: supplier({
            amountMinor: 500n,
            health: "OUTAGE",
            offerReference: supplierAOfferId,
            productReference: supplierAProductId,
            supplierReference: supplierAId,
          }),
          supplierB: supplier({
            amountMinor: 500n,
            health: "OUTAGE",
            offerReference: supplierBOfferId,
            productReference: supplierBProductId,
            supplierReference: supplierBId,
          }),
        }),
      ),
    ).resolves.toMatchObject({ status: "NO_ELIGIBLE_SUPPLIER" });

    await expect(
      select(
        createRouting({
          supplierA: supplier({
            amountMinor: 500n,
            evidence: reviewEvidence(),
            offerReference: supplierAOfferId,
            productReference: supplierAProductId,
            supplierReference: supplierAId,
          }),
          supplierB: supplier({
            amountMinor: 500n,
            evidence: vpnEvidence(),
            offerReference: supplierBOfferId,
            productReference: supplierBProductId,
            supplierReference: supplierBId,
          }),
          region: new StaticRegionEligibility({
            [supplierAId]: "REVIEW_REQUIRED",
            [supplierBId]: "REVIEW_REQUIRED",
          }),
        }),
      ),
    ).resolves.toMatchObject({ status: "MANUAL_REVIEW_REQUIRED" });
  });

  it("allows terminal A failure to progress to B", async () => {
    const routing = createRouting();
    const selection = await select(routing);
    const plan = await routing.createFallbackPlan({
      attempts: [
        {
          state: "FAILED_TERMINAL",
          supplierId: supplierAId,
          supplierOfferId: supplierAOfferId,
        },
      ],
      selection,
    });

    expect(plan.action).toBe("SAFE_TO_TRY_NEXT");
    expect(plan.reasonCode).toBe("TERMINAL_FAILURE_ALLOWS_SAFE_FALLBACK");
    expect(
      plan.orderedCandidates.map((candidate) => candidate.supplierId),
    ).toEqual([supplierBId]);
  });

  it("requires reconciliation for ambiguous A and returns no fallback candidates", async () => {
    const routing = createRouting();
    const selection = await select(routing);
    const plan = await routing.createFallbackPlan({
      attempts: [
        {
          state: "AMBIGUOUS",
          supplierId: supplierAId,
          supplierOfferId: supplierAOfferId,
        },
      ],
      selection,
    });

    expect(plan.action).toBe("RECONCILE_CURRENT_SUPPLIER_FIRST");
    expect(plan.reasonCode).toBe("AMBIGUOUS_PURCHASE_REQUIRES_RECONCILIATION");
    expect(plan.orderedCandidates).toEqual([]);
  });

  it("does not automatically switch suppliers for retryable A failure", async () => {
    const routing = createRouting();
    const selection = await select(routing);
    const plan = await routing.createFallbackPlan({
      attempts: [
        {
          state: "FAILED_RETRYABLE",
          supplierId: supplierAId,
          supplierOfferId: supplierAOfferId,
        },
      ],
      selection,
    });

    expect(plan.action).toBe("NO_FALLBACK");
    expect(plan.reasonCode).toBe(
      "RETRYABLE_FAILURE_REQUIRES_CURRENT_SUPPLIER_RETRY",
    );
    expect(plan.orderedCandidates).toEqual([]);
  });

  it("never returns another supplier after succeeded A", async () => {
    const routing = createRouting();
    const selection = await select(routing);
    const plan = await routing.createFallbackPlan({
      attempts: [
        {
          state: "SUCCEEDED",
          supplierId: supplierAId,
          supplierOfferId: supplierAOfferId,
        },
      ],
      selection,
    });

    expect(plan.action).toBe("NO_FALLBACK");
    expect(plan.reasonCode).toBe("PURCHASE_ALREADY_SUCCEEDED");
    expect(plan.orderedCandidates).toEqual([]);
  });

  it("does not treat NOT_STARTED as terminal failure", async () => {
    const routing = createRouting();
    const selection = await select(routing);
    const plan = await routing.createFallbackPlan({
      attempts: [
        {
          state: "NOT_STARTED",
          supplierId: supplierAId,
          supplierOfferId: supplierAOfferId,
        },
      ],
      selection,
    });

    expect(plan.action).toBe("NO_FALLBACK");
    expect(plan.reasonCode).toBe("NO_TERMINAL_FAILURE_FOR_FALLBACK");
    expect(plan.orderedCandidates).toEqual([]);
  });

  it("chooses no further purchase for succeeded plus terminal attempts", async () => {
    const routing = createRouting();
    const selection = await select(routing);
    const plan = await routing.createFallbackPlan({
      attempts: [
        {
          state: "FAILED_TERMINAL",
          supplierId: supplierAId,
          supplierOfferId: supplierAOfferId,
        },
        {
          state: "SUCCEEDED",
          supplierId: supplierAId,
          supplierOfferId: supplierAOfferId,
        },
      ],
      selection,
    });

    expect(plan.action).toBe("NO_FALLBACK");
    expect(plan.reasonCode).toBe("PURCHASE_ALREADY_SUCCEEDED");
    expect(plan.orderedCandidates).toEqual([]);
  });

  it("requires reconciliation for ambiguous plus terminal attempts", async () => {
    const routing = createRouting();
    const selection = await select(routing);
    const plan = await routing.createFallbackPlan({
      attempts: [
        {
          state: "FAILED_TERMINAL",
          supplierId: supplierAId,
          supplierOfferId: supplierAOfferId,
        },
        {
          state: "AMBIGUOUS",
          supplierId: supplierBId,
          supplierOfferId: supplierBOfferId,
        },
      ],
      selection,
    });

    expect(plan.action).toBe("RECONCILE_CURRENT_SUPPLIER_FIRST");
    expect(plan.reasonCode).toBe("AMBIGUOUS_PURCHASE_REQUIRES_RECONCILIATION");
    expect(plan.orderedCandidates).toEqual([]);
  });

  it("skips multiple terminal failures and selects the next untouched eligible supplier", async () => {
    const routing = createRouting({
      mappingPort: new StaticMappingPort(threeSupplierMappings()),
      supplierC: supplier({
        amountMinor: 2_000n,
        offerReference: supplierCOfferId,
        productReference: supplierCProductId,
        supplierReference: supplierCId,
      }),
    });
    const selection = await select(routing);
    const plan = await routing.createFallbackPlan({
      attempts: [
        {
          state: "FAILED_TERMINAL",
          supplierId: supplierAId,
          supplierOfferId: supplierAOfferId,
        },
        {
          state: "FAILED_TERMINAL",
          supplierId: supplierBId,
          supplierOfferId: supplierBOfferId,
        },
      ],
      selection,
    });

    expect(plan.action).toBe("SAFE_TO_TRY_NEXT");
    expect(
      plan.orderedCandidates.map((candidate) => candidate.supplierId),
    ).toEqual([supplierCId]);
  });

  it("returns no fallback when no eligible supplier remains after terminal failures", async () => {
    const routing = createRouting();
    const selection = await select(routing);
    const plan = await routing.createFallbackPlan({
      attempts: [
        {
          state: "FAILED_TERMINAL",
          supplierId: supplierAId,
          supplierOfferId: supplierAOfferId,
        },
        {
          state: "FAILED_TERMINAL",
          supplierId: supplierBId,
          supplierOfferId: supplierBOfferId,
        },
      ],
      selection,
    });

    expect(plan.action).toBe("NO_FALLBACK");
    expect(plan.reasonCode).toBe("NO_ELIGIBLE_FALLBACK");
    expect(plan.orderedCandidates).toEqual([]);
  });

  it("plans fallback deterministically across repeated calls", async () => {
    const routing = createRouting({
      mappingPort: new StaticMappingPort(threeSupplierMappings()),
      supplierC: supplier({
        amountMinor: 2_000n,
        offerReference: supplierCOfferId,
        productReference: supplierCProductId,
        supplierReference: supplierCId,
      }),
    });
    const selection = await select(routing);
    const attempts = [
      {
        state: "FAILED_TERMINAL",
        supplierId: supplierAId,
        supplierOfferId: supplierAOfferId,
      },
    ] as const;
    const first = await routing.createFallbackPlan({ attempts, selection });
    const second = await routing.createFallbackPlan({ attempts, selection });

    expect(first).toEqual(second);
    expect(
      first.orderedCandidates.map((candidate) => candidate.supplierId),
    ).toEqual([supplierBId, supplierCId]);
  });

  it("is deterministic, preserves correlation and policy version, and emits safe observability/audit", async () => {
    const observability = new CapturingObservability();
    const audit = new CapturingAudit();
    const routing = createRouting({ audit, observability });
    const first = await select(routing);
    const second = await select(routing);

    expect(first).toEqual(second);
    expect(first.correlationId).toBe("corr-routing-test");
    expect(first.policyVersion).toBe("test-policy-v1");
    expect(observability.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "SUPPLIER_ROUTING_EVALUATION_STARTED",
        "SUPPLIER_CANDIDATE_OBTAINED",
        "SUPPLIER_CANDIDATE_SELECTED",
      ]),
    );
    expect(audit.events.at(-1)).toEqual(
      expect.objectContaining({
        eventType: "SUPPLIER_SELECTION_COMPLETED",
        metadata: expect.objectContaining({
          policyVersion: "test-policy-v1",
          selectedSupplierId: supplierAId,
        }),
      }),
    );
    expect(
      JSON.stringify(first, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toMatch(
      /(api[_-]?key|bearer|client[_-]?secret|password|credential|token|product[_-]?key|payment[_-]?credential)/iu,
    );
  });

  it("does not match by title or assume cross-supplier SupplierProductId equivalence", async () => {
    const emptyMapping = await select(
      createRouting({
        mappingPort: new StaticMappingPort([]),
        supplierA: supplier({
          amountMinor: 500n,
          offerReference: supplierAOfferId,
          productReference: supplierProductId("shared-external-id"),
          supplierReference: supplierAId,
          title: "Same title",
        }),
        supplierB: supplier({
          amountMinor: 600n,
          offerReference: supplierBOfferId,
          productReference: supplierProductId("shared-external-id"),
          supplierReference: supplierBId,
          title: "Same title",
        }),
      }),
    );

    expect(emptyMapping.status).toBe("NO_ELIGIBLE_SUPPLIER");
    expect(emptyMapping.evaluatedCandidates).toEqual([]);
  });
});

describe("multi-supplier routing static safety", () => {
  it("keeps core routing free of real supplier and network imports", async () => {
    const routingSource = await readFile(
      path.resolve("packages/platform/src/suppliers/routing.ts"),
      "utf8",
    );
    const supplierSourceFiles = await readdir(
      path.resolve("packages/platform/src/suppliers"),
    );

    expect(routingSource).not.toMatch(
      /kinguin|gamivo|axios|fetch|node:http|node:https/iu,
    );
    expect(supplierSourceFiles).toEqual(
      expect.arrayContaining([
        "errors.ts",
        "observability.ts",
        "registry.ts",
        "routing.ts",
      ]),
    );
  });
});
