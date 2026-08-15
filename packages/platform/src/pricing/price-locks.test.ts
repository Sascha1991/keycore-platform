import { describe, expect, it } from "vitest";

import {
  InMemoryPriceLockRepository,
  InMemoryPricingRepository,
} from "../../../../infra/pricing/in-memory-pricing-repository.js";
import type { AuditEvent } from "../domain/audit.js";
import { currency, money } from "../domain/money.js";
import {
  offerId,
  productId,
  type CorrelationId,
  type OfferId,
  type ProductId,
} from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import {
  createPricingPolicy,
  PricingService,
  type AcquisitionCostInput,
  type TaxAssessment,
  type TaxPolicyPort,
} from "./pricing-margin.js";
import {
  PriceLockService,
  priceLockRevalidationJobPayload,
} from "./price-locks.js";

const eur = currency("EUR");
const productA = productId("00000000-0000-4000-8000-000000000601");
const correlationId = "corr-price-lock" as CorrelationId;

describe("PriceLockService", () => {
  it("creates ACTIVE locks only from valid quoted prices and keeps customer price immutable", async () => {
    const harness = createHarness();
    const quote = await selectedQuote(harness.service, productA);
    const lockResult = await harness.locks.createPriceLock({
      correlationId,
      expiresAt: new Date("2026-08-15T00:02:00.000Z"),
      idempotencyKey: "idem-lock-1",
      quote,
    });

    expect(lockResult.status).toBe("CREATED");
    expect(lockResult.lock).toMatchObject({
      lockedSellPrice: money(1_300n, eur),
      productId: productA,
      status: "ACTIVE",
    });

    harness.offerSource.replace([
      costInput({ amountMinor: 1_000n, offerIdValue: "offer-a" }),
    ]);
    await expect(
      harness.locks.validatePriceLock(lockResult.lock?.id ?? "", correlationId),
    ).resolves.toMatchObject({ status: "SAFE" });
    expect(
      (await harness.repository.findById(lockResult.lock?.id ?? ""))
        ?.lockedSellPrice,
    ).toEqual(money(1_300n, eur));
  });

  it("blocks lock creation for blocked, review-required, stale, zero, negative and expired inputs", async () => {
    const harness = createHarness({ requiredFeeKnown: false });
    const blocked = await harness.service.quoteProduct({
      correlationId,
      productId: productA,
    });
    const blockedQuote = blocked.quotes[0];
    if (!blockedQuote) {
      throw new Error("Expected blocked quote");
    }
    await expect(
      harness.locks.createPriceLock({
        correlationId,
        expiresAt: new Date("2026-08-15T00:02:00.000Z"),
        idempotencyKey: "blocked",
        quote: blockedQuote,
      }),
    ).resolves.toMatchObject({ status: "BLOCKED" });

    const reviewHarness = createHarness({ taxKnown: false });
    const reviewSelection = await reviewHarness.service.quoteProduct({
      correlationId,
      productId: productA,
    });
    await expect(
      reviewHarness.locks.createPriceLock({
        correlationId,
        expiresAt: new Date("2026-08-15T00:02:00.000Z"),
        idempotencyKey: "review",
        quote: required(reviewSelection.quotes[0]),
      }),
    ).resolves.toMatchObject({ status: "BLOCKED" });

    const staleHarness = createHarness({
      offers: [
        costInput({
          amountMinor: 1_000n,
          capturedAt: new Date("2026-08-14T23:00:00.000Z"),
          offerIdValue: "offer-a",
        }),
      ],
    });
    const staleSelection = await staleHarness.service.quoteProduct({
      correlationId,
      productId: productA,
    });
    await expect(
      staleHarness.locks.createPriceLock({
        correlationId,
        expiresAt: new Date("2026-08-15T00:02:00.000Z"),
        idempotencyKey: "stale",
        quote: required(staleSelection.quotes[0]),
      }),
    ).resolves.toMatchObject({ status: "BLOCKED" });

    const valid = await selectedQuote(createHarness().service, productA);
    await expect(
      createHarness().locks.createPriceLock({
        correlationId,
        expiresAt: new Date("2026-08-15T00:02:00.000Z"),
        idempotencyKey: "zero",
        quote: {
          ...valid,
          expectedProfit: money(0n, eur),
          sellPrice: money(0n, eur),
        },
      }),
    ).resolves.toMatchObject({
      reasonCode: "INVALID_LOCK_REQUEST",
      status: "BLOCKED",
    });
    expect(() => money(-1n, eur)).toThrow("Money amount must not be negative");
    await expect(
      createHarness().locks.createPriceLock({
        correlationId,
        expiresAt: new Date("2026-08-14T23:59:59.000Z"),
        idempotencyKey: "expired",
        quote: valid,
      }),
    ).resolves.toMatchObject({
      reasonCode: "PRICE_LOCK_EXPIRED",
      status: "BLOCKED",
    });
  });

  it("returns the same lock for matching idempotent retries and conflicts on changed inputs", async () => {
    const harness = createHarness();
    const quote = await selectedQuote(harness.service, productA);
    const first = await harness.locks.createPriceLock({
      correlationId,
      expiresAt: new Date("2026-08-15T00:02:00.000Z"),
      idempotencyKey: "idem-repeat",
      quote,
    });
    const retry = await harness.locks.createPriceLock({
      correlationId,
      expiresAt: new Date("2026-08-15T00:02:00.000Z"),
      idempotencyKey: "idem-repeat",
      quote,
    });
    harness.offerSource.replace([
      costInput({
        amountMinor: 950n,
        offerIdValue: "offer-a",
        version: "changed-idempotent-input",
      }),
    ]);
    const changedQuote = await selectedQuote(harness.service, productA);
    const conflict = await harness.locks.createPriceLock({
      correlationId,
      expiresAt: new Date("2026-08-15T00:02:00.000Z"),
      idempotencyKey: "idem-repeat",
      quote: changedQuote,
    });

    expect(retry).toMatchObject({
      lock: { id: first.lock?.id },
      status: "IDEMPOTENT",
    });
    expect(conflict).toMatchObject({
      reasonCode: "IDEMPOTENCY_CONFLICT",
      status: "CONFLICT",
    });
  });

  it("revalidates supplier changes, pricing disables, unknown inputs, expiry and consumed states fail closed", async () => {
    const harness = createHarness();
    const quote = await selectedQuote(harness.service, productA);
    const created = await createLock(harness, quote, "validate");
    await expect(
      harness.locks.validatePriceLock(created.id, correlationId),
    ).resolves.toMatchObject({ status: "SAFE" });

    harness.offerSource.replace([
      costInput({
        amountMinor: 900n,
        offerIdValue: "offer-a",
        version: "cost-down",
      }),
    ]);
    await expect(
      harness.locks.validatePriceLock(created.id, correlationId),
    ).resolves.toMatchObject({ status: "SAFE" });

    harness.offerSource.replace([
      costInput({
        amountMinor: 990n,
        offerIdValue: "offer-a",
        version: "cost-tight",
      }),
    ]);
    await expect(
      harness.locks.validatePriceLock(created.id, correlationId),
    ).resolves.toMatchObject({ status: "SAFE" });

    harness.offerSource.replace([
      costInput({
        amountMinor: 1_001n,
        offerIdValue: "offer-a",
        version: "cost-high",
      }),
    ]);
    await expect(
      harness.locks.validatePriceLock(created.id, correlationId),
    ).resolves.toMatchObject({
      reasonCode: "PROFIT_FLOOR_VIOLATION",
      status: "REPRICE_REQUIRED",
    });

    const disabled = createHarness({ policyEnabled: false });
    const disabledLock = await createLock(
      disabled,
      await selectedQuote(harness.service, productA),
      "disabled",
    );
    await expect(
      disabled.locks.validatePriceLock(disabledLock.id, correlationId),
    ).resolves.toMatchObject({
      reasonCode: "PRICING_DISABLED",
      status: "BLOCKED",
    });

    const expiredHarness = createHarness({
      now: new Date("2026-08-15T00:03:00.000Z"),
    });
    await expiredHarness.repository.create(created);
    await expect(
      expiredHarness.locks.validatePriceLock(created.id, correlationId),
    ).resolves.toMatchObject({
      reasonCode: "PRICE_LOCK_EXPIRED",
      status: "EXPIRED",
    });
  });

  it("allows another safe eligible offer to rescue a lock but rejects ineligible and unsafe alternatives", async () => {
    const harness = createHarness();
    const quote = await selectedQuote(harness.service, productA);
    const created = await createLock(harness, quote, "multi");
    harness.offerSource.replace([
      costInput({
        amountMinor: 1_900n,
        offerIdValue: "offer-a",
        version: "expensive",
      }),
      costInput({
        amountMinor: 950n,
        offerIdValue: "offer-b",
        version: "safe-b",
      }),
    ]);
    await expect(
      harness.locks.validatePriceLock(created.id, correlationId),
    ).resolves.toMatchObject({
      safeOfferFingerprint: expect.any(String),
      status: "SAFE",
    });

    harness.offerSource.replace([
      costInput({
        amountMinor: 1_900n,
        offerIdValue: "offer-a",
        version: "expensive",
      }),
      costInput({
        amountMinor: 950n,
        offerIdValue: "offer-b",
        requiredFeeKnown: false,
        version: "unknown-fee",
      }),
    ]);
    const second = await createLock(createHarness(), quote, "multi-reprice");
    await harness.repository.create(second);
    await expect(
      harness.locks.validatePriceLock(second.id, correlationId),
    ).resolves.toMatchObject({ status: "REPRICE_REQUIRED" });
  });

  it("consumes active locks once and detects expected-version races", async () => {
    const harness = createHarness();
    const lock = await createLock(
      harness,
      await selectedQuote(harness.service, productA),
      "consume",
    );
    const [first, second] = await Promise.all([
      harness.locks.consumePriceLock({
        correlationId,
        expectedVersion: lock.recordVersion,
        lockId: lock.id,
      }),
      harness.locks.consumePriceLock({
        correlationId,
        expectedVersion: lock.recordVersion,
        lockId: lock.id,
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([
      "CONFLICT",
      "CONSUMED",
    ]);
    await expect(
      harness.locks.consumePriceLock({
        correlationId,
        expectedVersion: 99,
        lockId: lock.id,
      }),
    ).resolves.toMatchObject({ status: "CONFLICT" });
  });

  it("keeps audit and queue payloads safe and customer representation supplier-free", async () => {
    const audit = new CapturingAudit();
    const harness = createHarness({ audit });
    const lock = await createLock(
      harness,
      await selectedQuote(harness.service, productA),
      "safe",
    );
    await harness.locks.validatePriceLock(lock.id, correlationId);

    expect(JSON.stringify(audit.events)).not.toMatch(
      /supplier|cost|credential|secret|productKey|rawPayload/iu,
    );
    expect(
      safeJson(harness.locks.customerSafeRepresentation(lock)),
    ).not.toMatch(/supplier|cost|margin|fingerprint|tax|fee/iu);
    expect(
      JSON.stringify(
        priceLockRevalidationJobPayload({
          correlationId,
          productId: productA,
          reason: "catalog-change",
        }),
      ),
    ).not.toMatch(/supplier|cost|credential|secret|productKey/iu);
  });

  it("checks the SAFE invariant over 50,000 deterministic current offers", async () => {
    const offers = Array.from({ length: 50_000 }, (_, index) =>
      costInput({
        amountMinor: BigInt(500 + (index % 500)),
        offerIdValue: `offer-${index.toString().padStart(5, "0")}`,
        version: `v-${index}`,
      }),
    );
    const harness = createHarness({ offers });
    const quote = await selectedQuote(harness.service, productA);
    const lock = await createLock(harness, quote, "scale");
    const startedAt = performance.now();
    const result = await harness.locks.validatePriceLock(
      lock.id,
      correlationId,
    );
    const durationMs = performance.now() - startedAt;

    expect(result).toMatchObject({ status: "SAFE" });
    expect(harness.repository.listLocks()[0]?.lockedSellPrice).toEqual(
      quote.sellPrice,
    );
    expect(durationMs).toBeLessThan(2_000);
  });
});

const createHarness = (
  overrides: {
    readonly now?: Date;
    readonly offers?: readonly AcquisitionCostInput[];
    readonly requiredFeeKnown?: boolean;
    readonly taxKnown?: boolean;
    readonly policyEnabled?: boolean;
    readonly audit?: AuditEventPort;
  } = {},
) => {
  const now = overrides.now ?? new Date("2026-08-15T00:00:00.000Z");
  const policy = createPricingPolicy({
    currency: eur,
    fixedMarkup: money(0n, eur),
    markupBasisPoints: 0n,
    minimumProfit: money(50n, eur),
    minimumSellPrice: money(0n, eur),
    now,
    policyId: "00000000-0000-4000-8000-000000000699",
    quoteTtlMs: 120_000,
  });
  const pricingRepository = new InMemoryPricingRepository({
    ...policy,
    enabled: overrides.policyEnabled ?? true,
  });
  const offerSource = new MutableOfferSource(
    overrides.offers ?? [
      costInput({
        amountMinor: 1_000n,
        offerIdValue: "offer-a",
        ...(overrides.requiredFeeKnown !== undefined
          ? { requiredFeeKnown: overrides.requiredFeeKnown }
          : {}),
      }),
    ],
  );
  const pricingOptions = {
    maxInputAgeMs: 300_000,
    now: () => now,
    offerSource,
    overrideRepository: pricingRepository,
    policyRepository: pricingRepository,
    snapshots: pricingRepository,
    taxPolicy: new FixtureTaxPolicy(overrides.taxKnown ?? true),
    ...(overrides.audit ? { audit: overrides.audit } : {}),
  };
  const service = new PricingService(pricingOptions);
  const repository = new InMemoryPriceLockRepository();
  return {
    locks: new PriceLockService({
      now: () => now,
      pricing: service,
      repository,
      ...(overrides.audit ? { audit: overrides.audit } : {}),
    }),
    offerSource,
    repository,
    service,
  };
};

const costInput = (input: {
  readonly amountMinor: bigint;
  readonly offerIdValue: string;
  readonly version?: string;
  readonly requiredFeeKnown?: boolean;
  readonly capturedAt?: Date;
}): AcquisitionCostInput => ({
  baseSupplierPrice: money(input.amountMinor, eur),
  capturedAt: input.capturedAt ?? new Date("2026-08-15T00:00:00.000Z"),
  costVersion:
    input.version ?? `cost-${input.offerIdValue}-${input.amountMinor}`,
  fixedFee: money(250n, eur),
  offerId: offerId(input.offerIdValue),
  percentageFeeBasisPoints: 0n,
  productId: productA,
  requiredFeeKnown: input.requiredFeeKnown ?? true,
});

const selectedQuote = async (
  service: PricingService,
  targetProductId: ProductId,
) => {
  const selection = await service.quoteProduct({
    correlationId,
    productId: targetProductId,
  });
  return required(selection.selectedQuote);
};

const createLock = async (
  harness: ReturnType<typeof createHarness>,
  quote: Awaited<ReturnType<typeof selectedQuote>>,
  idempotencyKey: string,
) => {
  const created = await harness.locks.createPriceLock({
    correlationId,
    expiresAt: new Date("2026-08-15T00:02:00.000Z"),
    idempotencyKey,
    quote,
  });
  return required(created.lock);
};

const required = <TValue>(value: TValue | undefined | null): TValue => {
  if (!value) {
    throw new Error("Expected test fixture value");
  }
  return value;
};

class MutableOfferSource {
  private current: readonly AcquisitionCostInput[];

  public constructor(offers: readonly AcquisitionCostInput[]) {
    this.current = offers;
  }

  public replace(offers: readonly AcquisitionCostInput[]): void {
    this.current = offers;
  }

  public async loadPriceableOffers(input: {
    readonly eligibleOfferIds?: readonly OfferId[];
  }): Promise<readonly AcquisitionCostInput[]> {
    return input.eligibleOfferIds
      ? this.current.filter((offer) =>
          input.eligibleOfferIds?.includes(offer.offerId),
        )
      : this.current;
  }
}

class FixtureTaxPolicy implements TaxPolicyPort {
  public constructor(private readonly known: boolean) {}

  public async assess(): Promise<TaxAssessment> {
    return {
      known: this.known,
      policyVersion: "tax-fixture-v1",
      taxAmount: money(0n, eur),
      treatment: this.known ? "CONFIGURED_FIXTURE" : "UNKNOWN",
    };
  }
}

class CapturingAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const safeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, nested) =>
    typeof nested === "bigint" ? nested.toString() : nested,
  );
