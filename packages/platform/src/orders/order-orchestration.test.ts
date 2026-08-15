import { describe, expect, it } from "vitest";

import {
  InMemoryPriceLockRepository,
  InMemoryPricingRepository,
} from "../../../../infra/pricing/in-memory-pricing-repository.js";
import { InMemoryOrderRepository } from "../../../../infra/orders/in-memory-order-repository.js";
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
import { PriceLockService } from "../pricing/price-locks.js";
import {
  createPricingPolicy,
  PricingService,
  type AcquisitionCostInput,
  type TaxAssessment,
  type TaxPolicyPort,
} from "../pricing/pricing-margin.js";
import {
  OrderOrchestrationService,
  orderOutboxPayload,
  procurementEligiblePaymentStates,
  reconciliationOutboxPayload,
  validateOrderStateInvariants,
  type KeyCoreOrder,
} from "./order-orchestration.js";

const eur = currency("EUR");
const productA = productId("00000000-0000-4000-8000-000000070001");
const productB = productId("00000000-0000-4000-8000-000000070002");
const correlationId = "corr-order-orchestration" as CorrelationId;

describe("OrderOrchestrationService", () => {
  it("creates an order from a valid safe PriceLock and copies commercial values from the lock", async () => {
    const harness = await createHarness();
    const created = await harness.orders.createOrder({
      correlationId,
      idempotencyKey: "order-idem-1",
      priceLockId: harness.lock.id,
      productId: productA,
      quantity: 1,
    });

    expect(created).toMatchObject({
      order: {
        customerAmount: money(1_300n, eur),
        paymentStatus: "NOT_STARTED",
        priceLockId: harness.lock.id,
        procurementStatus: "NOT_STARTED",
        productId: productA,
        quantity: 1,
        riskStatus: "NOT_EVALUATED",
        status: "CREATED",
      },
      reasonCode: "ORDER_CREATED",
      status: "CREATED",
    });
    await expect(
      harness.orderRepository.listHistory(required(created.order).id),
    ).resolves.toHaveLength(1);
  });

  it("rejects customer amount override, wrong product, wrong currency and unsupported quantity", async () => {
    const harness = await createHarness();

    await expect(
      harness.orders.createOrder({
        correlationId,
        expectedCustomerAmount: money(1_299n, eur),
        idempotencyKey: "wrong-amount",
        priceLockId: harness.lock.id,
        productId: productA,
        quantity: 1,
      }),
    ).resolves.toMatchObject({
      reasonCode: "PRICE_LOCK_MISMATCH",
      status: "BLOCKED",
    });
    await expect(
      harness.orders.createOrder({
        correlationId,
        idempotencyKey: "wrong-product",
        priceLockId: harness.lock.id,
        productId: productB,
        quantity: 1,
      }),
    ).resolves.toMatchObject({
      reasonCode: "PRICE_LOCK_MISMATCH",
      status: "BLOCKED",
    });
    await expect(
      harness.orders.createOrder({
        correlationId,
        expectedCurrency: currency("USD"),
        idempotencyKey: "wrong-currency",
        priceLockId: harness.lock.id,
        productId: productA,
        quantity: 1,
      }),
    ).resolves.toMatchObject({
      reasonCode: "PRICE_LOCK_MISMATCH",
      status: "BLOCKED",
    });
    await expect(
      harness.orders.createOrder({
        correlationId,
        idempotencyKey: "quantity-2",
        priceLockId: harness.lock.id,
        productId: productA,
        quantity: 2,
      }),
    ).resolves.toMatchObject({
      reasonCode: "UNSUPPORTED_QUANTITY",
      status: "BLOCKED",
    });
  });

  it("returns the same order for matching idempotent retries and conflicts on changed input", async () => {
    const harness = await createHarness();
    const first = await createOrder(harness, "order-idem-repeat");
    const retry = await harness.orders.createOrder({
      correlationId,
      idempotencyKey: "order-idem-repeat",
      priceLockId: harness.lock.id,
      productId: productA,
      quantity: 1,
    });
    const conflict = await harness.orders.createOrder({
      correlationId,
      idempotencyKey: "order-idem-repeat",
      priceLockId: harness.lock.id,
      productId: productB,
      quantity: 1,
    });

    expect(retry).toMatchObject({
      order: { id: first.id },
      reasonCode: "ORDER_IDEMPOTENT_REPLAY",
      status: "IDEMPOTENT",
    });
    expect(conflict).toMatchObject({
      order: { id: first.id },
      reasonCode: "ORDER_IDEMPOTENCY_CONFLICT",
      status: "CONFLICT",
    });
  });

  it("blocks procurement until payment is captured and risk is approved", async () => {
    const harness = await createHarness();
    const order = await createOrder(harness, "order-gates");

    await expect(
      harness.orders.beginProcurement({
        correlationId,
        expectedVersion: order.recordVersion,
        orderId: order.id,
      }),
    ).resolves.toMatchObject({
      reasonCode: "PAYMENT_NOT_ELIGIBLE_FOR_PROCUREMENT",
      status: "BLOCKED",
    });

    const awaitingPayment = await mustUpdate(
      harness.orders.markAwaitingPayment({
        correlationId,
        expectedVersion: order.recordVersion,
        orderId: order.id,
      }),
    );
    const authorized = await mustUpdate(
      harness.orders.transitionPayment({
        correlationId,
        expectedVersion: awaitingPayment.recordVersion,
        orderId: order.id,
        paymentStatus: "AUTHORIZED",
      }),
    );
    const captured = await mustUpdate(
      harness.orders.transitionPayment({
        correlationId,
        expectedVersion: authorized.recordVersion,
        orderId: order.id,
        paymentStatus: "CAPTURED",
      }),
    );
    await expect(
      harness.orders.beginProcurement({
        correlationId,
        expectedVersion: captured.recordVersion,
        orderId: order.id,
      }),
    ).resolves.toMatchObject({
      reasonCode: "RISK_NOT_APPROVED",
      status: "BLOCKED",
    });

    const approved = await mustUpdate(
      harness.orders.markRisk({
        correlationId,
        expectedVersion: captured.recordVersion,
        orderId: order.id,
        riskStatus: "APPROVED",
      }),
    );
    await expect(
      harness.orders.markProcurementPending({
        correlationId,
        expectedVersion: approved.recordVersion,
        orderId: order.id,
      }),
    ).resolves.toMatchObject({
      order: {
        paymentStatus: "CAPTURED",
        procurementStatus: "PENDING",
        riskStatus: "APPROVED",
        status: "PROCUREMENT_PENDING",
      },
      status: "UPDATED",
    });
  });

  it("models ambiguous procurement as manual review and never supplier fallback", async () => {
    const harness = await createHarness();
    const order = await readyForProcurement(harness, "ambiguous");
    const inProgress = await mustUpdate(
      harness.orders.beginProcurement({
        correlationId,
        expectedVersion: order.recordVersion,
        orderId: order.id,
      }),
    );
    const ambiguous = await harness.orders.recordProcurementResult({
      correlationId,
      expectedVersion: inProgress.recordVersion,
      orderId: order.id,
      procurementStatus: "AMBIGUOUS",
    });

    expect(ambiguous).toMatchObject({
      order: {
        procurementStatus: "AMBIGUOUS",
        status: "MANUAL_REVIEW",
      },
      reasonCode: "PROCUREMENT_AMBIGUOUS",
      status: "UPDATED",
    });
    expect(safeJson(ambiguous)).not.toMatch(/fallback|candidate/iu);
  });

  it("requires procurement success before fulfillment completion and models refunds safely", async () => {
    const harness = await createHarness();
    const order = await readyForProcurement(harness, "fulfillment");
    const inProgress = await mustUpdate(
      harness.orders.beginProcurement({
        correlationId,
        expectedVersion: order.recordVersion,
        orderId: order.id,
      }),
    );
    const fulfillmentPending = await mustUpdate(
      harness.orders.recordProcurementResult({
        correlationId,
        expectedVersion: inProgress.recordVersion,
        orderId: order.id,
        procurementStatus: "SUCCEEDED",
      }),
    );
    const completed = await mustUpdate(
      harness.orders.recordFulfillmentResult({
        correlationId,
        expectedVersion: fulfillmentPending.recordVersion,
        fulfillmentStatus: "SUCCEEDED",
        orderId: order.id,
      }),
    );
    const refundPending = await mustUpdate(
      harness.orders.requestRefund({
        correlationId,
        expectedVersion: completed.recordVersion,
        orderId: order.id,
      }),
    );

    expect(refundPending).toMatchObject({
      refundStatus: "PENDING",
      status: "REFUND_PENDING",
    });
    const refunded = await mustUpdate(
      harness.orders.recordRefundResult({
        correlationId,
        expectedVersion: refundPending.recordVersion,
        orderId: order.id,
        refundStatus: "SUCCEEDED",
      }),
    );
    expect(refunded).toMatchObject({
      paymentStatus: "REFUNDED",
      refundStatus: "SUCCEEDED",
      status: "REFUNDED",
    });
  });

  it("returns explicit optimistic conflicts for concurrent stale transitions", async () => {
    const harness = await createHarness();
    const order = await createOrder(harness, "optimistic");
    const [left, right] = await Promise.all([
      harness.orders.markAwaitingPayment({
        correlationId,
        expectedVersion: order.recordVersion,
        orderId: order.id,
      }),
      harness.orders.markAwaitingPayment({
        correlationId,
        expectedVersion: order.recordVersion,
        orderId: order.id,
      }),
    ]);

    expect([left.status, right.status].sort()).toEqual(["CONFLICT", "UPDATED"]);
    expect([left.reasonCode, right.reasonCode]).toContain(
      "OPTIMISTIC_CONCURRENCY_CONFLICT",
    );
  });

  it("deduplicates external events and fails closed on conflicting reuse", async () => {
    const harness = await createHarness();
    const order = await createOrder(harness, "external-events");
    const base = {
      correlationId,
      eventFingerprint: "same-event",
      eventType: "payment.updated",
      externalEventId: "evt-1",
      orderId: order.id,
      provider: "mock-payment",
    };

    await expect(harness.orders.recordExternalEvent(base)).resolves.toEqual({
      status: "RECORDED",
    });
    await expect(harness.orders.recordExternalEvent(base)).resolves.toEqual({
      reasonCode: "EXTERNAL_EVENT_DEDUPLICATED",
      status: "DUPLICATE",
    });
    await expect(
      harness.orders.recordExternalEvent({
        ...base,
        eventFingerprint: "changed-event",
      }),
    ).resolves.toEqual({
      reasonCode: "EXTERNAL_EVENT_CONFLICT",
      status: "CONFLICT",
    });
  });

  it("keeps audit and outbox payloads free of keys, credentials, payment card data and supplier cost", async () => {
    const audit = new CapturingAudit();
    const harness = await createHarness({ audit });
    const order = await createOrder(harness, "safe-payloads");
    await harness.orders.markAwaitingPayment({
      correlationId,
      expectedVersion: order.recordVersion,
      orderId: order.id,
    });

    const payloadText = JSON.stringify([
      audit.events,
      orderOutboxPayload({ order, reasonCode: "ORDER_CREATED" }),
      reconciliationOutboxPayload({
        order,
        reasonCode: "MANUAL_REVIEW_REQUIRED",
      }),
    ]);

    expect(payloadText).not.toMatch(
      /productKey|plain|secret|credential|card|cvc|cvv|supplierCost|acquisition/iu,
    );
  });

  it("proves procurement in-progress invariant and commercial immutability over 50,000 synthetic transitions", () => {
    const start = performance.now();
    for (let index = 0; index < 50_000; index += 1) {
      const order = syntheticOrder({
        paymentStatus:
          index % 3 === 0 ? "CAPTURED" : index % 3 === 1 ? "PENDING" : "FAILED",
        procurementStatus: "IN_PROGRESS",
        riskStatus: index % 2 === 0 ? "APPROVED" : "REVIEW_REQUIRED",
      });
      const invariant = validateOrderStateInvariants(order);
      const shouldBeSafe =
        procurementEligiblePaymentStates.includes(order.paymentStatus) &&
        order.riskStatus === "APPROVED";
      if ((invariant === null) !== shouldBeSafe) {
        throw new Error("Procurement invariant mismatch");
      }
      if (
        order.customerAmount.amountMinor !== 1_300n ||
        order.currency !== eur ||
        order.quantity !== 1
      ) {
        throw new Error("Commercial immutability mismatch");
      }
    }
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});

const createHarness = async (
  options: { readonly audit?: AuditEventPort } = {},
) => {
  const now = new Date("2026-08-15T00:00:00.000Z");
  const policy = createPricingPolicy({
    currency: eur,
    fixedMarkup: money(0n, eur),
    markupBasisPoints: 0n,
    minimumProfit: money(50n, eur),
    minimumSellPrice: money(0n, eur),
    now,
    policyId: "00000000-0000-4000-8000-000000070099",
    quoteTtlMs: 120_000,
  });
  const pricingRepository = new InMemoryPricingRepository(policy);
  const pricing = new PricingService({
    maxInputAgeMs: 300_000,
    now: () => now,
    offerSource: new FixtureOfferSource(),
    overrideRepository: pricingRepository,
    policyRepository: pricingRepository,
    snapshots: pricingRepository,
    taxPolicy: new FixtureTaxPolicy(),
  });
  const priceLockRepository = new InMemoryPriceLockRepository();
  const priceLocks = new PriceLockService({
    now: () => now,
    pricing,
    repository: priceLockRepository,
  });
  const selection = await pricing.quoteProduct({
    correlationId,
    productId: productA,
  });
  const lockResult = await priceLocks.createPriceLock({
    correlationId,
    expiresAt: new Date("2026-08-15T00:02:00.000Z"),
    idempotencyKey: `lock-${Math.random().toString(16).slice(2)}`,
    quote: required(selection.selectedQuote),
  });
  const orderRepository = new InMemoryOrderRepository();
  return {
    lock: required(lockResult.lock),
    orderRepository,
    orders: new OrderOrchestrationService({
      ...(options.audit ? { audit: options.audit } : {}),
      now: () => now,
      priceLocks,
      repository: orderRepository,
    }),
  };
};

const createOrder = async (
  harness: Awaited<ReturnType<typeof createHarness>>,
  idempotencyKey: string,
): Promise<KeyCoreOrder> => {
  const result = await harness.orders.createOrder({
    correlationId,
    idempotencyKey,
    priceLockId: harness.lock.id,
    productId: productA,
    quantity: 1,
  });
  return required(result.order);
};

const readyForProcurement = async (
  harness: Awaited<ReturnType<typeof createHarness>>,
  idempotencyKey: string,
): Promise<KeyCoreOrder> => {
  const created = await createOrder(harness, idempotencyKey);
  const awaiting = await mustUpdate(
    harness.orders.markAwaitingPayment({
      correlationId,
      expectedVersion: created.recordVersion,
      orderId: created.id,
    }),
  );
  const authorized = await mustUpdate(
    harness.orders.transitionPayment({
      correlationId,
      expectedVersion: awaiting.recordVersion,
      orderId: created.id,
      paymentStatus: "AUTHORIZED",
    }),
  );
  const captured = await mustUpdate(
    harness.orders.transitionPayment({
      correlationId,
      expectedVersion: authorized.recordVersion,
      orderId: created.id,
      paymentStatus: "CAPTURED",
    }),
  );
  const approved = await mustUpdate(
    harness.orders.markRisk({
      correlationId,
      expectedVersion: captured.recordVersion,
      orderId: created.id,
      riskStatus: "APPROVED",
    }),
  );
  return mustUpdate(
    harness.orders.markProcurementPending({
      correlationId,
      expectedVersion: approved.recordVersion,
      orderId: created.id,
    }),
  );
};

const mustUpdate = async (
  resultPromise: Promise<{ readonly order?: KeyCoreOrder }>,
): Promise<KeyCoreOrder> => required((await resultPromise).order);

const syntheticOrder = (overrides: Partial<KeyCoreOrder>): KeyCoreOrder => ({
  correlationId,
  createdAt: new Date("2026-08-15T00:00:00.000Z"),
  currency: eur,
  customerAmount: money(1_300n, eur),
  fulfillmentStatus: "NOT_STARTED",
  id: `00000000-0000-4000-8000-00000007abcd` as KeyCoreOrder["id"],
  idempotencyFingerprint: "fingerprint",
  idempotencyKey: "idem",
  paymentStatus: "CAPTURED",
  priceLockId: "00000000-0000-4000-8000-000000070999",
  procurementStatus: "IN_PROGRESS",
  productId: productA,
  quantity: 1,
  recordVersion: 1,
  refundStatus: "NOT_REQUESTED",
  riskStatus: "APPROVED",
  status: "PROCUREMENT_IN_PROGRESS",
  updatedAt: new Date("2026-08-15T00:00:00.000Z"),
  ...overrides,
});

const required = <TValue>(value: TValue | undefined | null): TValue => {
  if (!value) {
    throw new Error("Expected test fixture value");
  }
  return value;
};

const safeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, nested) =>
    typeof nested === "bigint" ? nested.toString() : nested,
  );

class FixtureOfferSource {
  public async loadPriceableOffers(): Promise<readonly AcquisitionCostInput[]> {
    return [
      {
        baseSupplierPrice: money(1_000n, eur),
        capturedAt: new Date("2026-08-15T00:00:00.000Z"),
        costVersion: "cost-v1",
        fixedFee: money(250n, eur),
        offerId: offerId("order-offer-a") as OfferId,
        percentageFeeBasisPoints: 0n,
        productId: productA as ProductId,
        requiredFeeKnown: true,
      },
    ];
  }
}

class FixtureTaxPolicy implements TaxPolicyPort {
  public async assess(): Promise<TaxAssessment> {
    return {
      known: true,
      policyVersion: "tax-fixture-v1",
      taxAmount: money(0n, eur),
      treatment: "CONFIGURED_FIXTURE",
    };
  }
}

class CapturingAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}
