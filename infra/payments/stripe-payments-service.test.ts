import { describe, expect, it } from "vitest";

import { InMemoryOrderRepository } from "../orders/in-memory-order-repository.js";
import { InMemoryPaymentRepository } from "./in-memory-payment-repository.js";
import {
  InMemoryPriceLockRepository,
  InMemoryPricingRepository,
} from "../pricing/in-memory-pricing-repository.js";
import { currency, money } from "../../packages/platform/src/domain/money.js";
import {
  offerId,
  productId,
  type CorrelationId,
  type OfferId,
  type ProductId,
} from "../../packages/platform/src/domain/identifiers.js";
import {
  OrderOrchestrationService,
  type KeyCoreOrder,
} from "../../packages/platform/src/orders/order-orchestration.js";
import { PriceLockService } from "../../packages/platform/src/pricing/price-locks.js";
import {
  createPricingPolicy,
  PricingService,
  type AcquisitionCostInput,
  type TaxAssessment,
  type TaxPolicyPort,
} from "../../packages/platform/src/pricing/pricing-margin.js";
import {
  StripePaymentService,
  normalizeStripePaymentStatus,
  stripePaymentIntentIdempotencyKey,
  stripePaymentMetadata,
  type NormalizedStripePaymentIntent,
  type PaymentCreationLeaseResult,
  type PaymentProviderCreateResult,
  type PaymentProviderRetrieveResult,
  type PaymentRecord,
  type PaymentRepository,
  type PaymentReservationResult,
  type PaymentStatus,
  type PaymentUpdateResult,
  type StripePaymentIntentCreateInput,
  type StripePaymentIntentStatus,
  type StripePaymentProviderPort,
  type StripeWebhookVerifier,
  type VerifiedStripeEvent,
} from "../../packages/platform/src/payments/stripe-payments.js";

const eur = currency("EUR");
const productA = productId("00000000-0000-4000-8000-000000070201");
const correlationId = "corr-stripe-payment" as CorrelationId;
const now = new Date("2026-08-15T00:00:00.000Z");

describe("StripePaymentService", () => {
  it("initializes one PaymentIntent per order with deterministic idempotency and no persisted client secret", async () => {
    const harness = await createHarness();
    const order = await createOrder(harness, "pay-order-1");
    const result = await harness.payments.initializePayment({
      correlationId,
      orderId: order.id,
    });
    const persisted = await harness.paymentRepository.findByOrder({
      orderId: order.id,
      provider: "STRIPE",
    });

    expect(result).toMatchObject({
      clientSecret: "pi_fixture_secret_client",
      payment: {
        amount: money(1_300n, eur),
        currency: eur,
        externalPaymentId: "pi_fixture_1",
        status: "REQUIRES_PAYMENT_METHOD",
      },
      reasonCode: "PAYMENT_INTENT_CREATED",
      status: "INITIALIZED",
    });
    expect(persisted).not.toHaveProperty("clientSecret");
    expect(harness.stripe.createInputs).toHaveLength(1);
    expect(harness.stripe.createInputs[0]?.idempotencyKey).toBe(
      stripePaymentIntentIdempotencyKey(order.id, 1),
    );
    await expect(harness.orders.getOrder(order.id)).resolves.toMatchObject({
      paymentStatus: "PENDING",
      status: "AWAITING_PAYMENT",
    });
  });

  it("converges repeated initializePayment calls on the same local payment", async () => {
    const harness = await createHarness();
    const order = await createOrder(harness, "pay-order-2");

    const first = await harness.payments.initializePayment({
      correlationId,
      orderId: order.id,
    });
    const second = await harness.payments.initializePayment({
      correlationId,
      orderId: order.id,
    });

    expect(first.payment?.id).toBe(second.payment?.id);
    expect(second).toMatchObject({
      reasonCode: "PAYMENT_IDEMPOTENT_REPLAY",
      status: "IDEMPOTENT",
    });
    expect(harness.stripe.createInputs).toHaveLength(1);
  });

  it("marks ambiguous provider creation for reconciliation without retrying under a new key", async () => {
    const harness = await createHarness({
      createResults: ["AMBIGUOUS", "CREATED"],
    });
    const order = await createOrder(harness, "pay-order-3");

    await expect(
      harness.payments.initializePayment({ correlationId, orderId: order.id }),
    ).resolves.toMatchObject({
      reasonCode: "PAYMENT_RECONCILIATION_REQUIRED",
      status: "RECONCILIATION_REQUIRED",
    });
    await expect(
      harness.payments.initializePayment({ correlationId, orderId: order.id }),
    ).resolves.toMatchObject({
      reasonCode: "PAYMENT_INTENT_CREATED",
      status: "INITIALIZED",
    });
    expect(harness.stripe.createInputs).toHaveLength(2);
    expect(
      new Set(harness.stripe.createInputs.map((item) => item.idempotencyKey))
        .size,
    ).toBe(1);
  });

  it("recovers crash after local reservation before Stripe call with the same idempotency key", async () => {
    const harness = await createHarness();
    const order = await createOrder(harness, "pay-order-reserved-crash");
    const idempotencyKey = stripePaymentIntentIdempotencyKey(order.id, 1);
    await harness.paymentRepository.reserveForOrder({
      now,
      order,
      stripeIdempotencyKey: idempotencyKey,
    });

    await expect(
      harness.payments.initializePayment({ correlationId, orderId: order.id }),
    ).resolves.toMatchObject({
      reasonCode: "PAYMENT_INTENT_CREATED",
      status: "INITIALIZED",
    });
    expect(harness.stripe.createInputs).toHaveLength(1);
    expect(harness.stripe.createInputs[0]?.idempotencyKey).toBe(idempotencyKey);
  });

  it("recovers remote success plus local persistence failure after lease staleness", async () => {
    const harness = await createHarness({
      createResults: ["CREATED", "CREATED"],
      repository: new FailsOnceMarkCreatedRepository(
        new InMemoryPaymentRepository(),
      ),
    });
    const order = await createOrder(harness, "pay-order-local-failure");

    await expect(
      harness.payments.initializePayment({ correlationId, orderId: order.id }),
    ).rejects.toThrow("Simulated local persistence failure");
    harness.setNow(new Date("2026-08-15T00:02:01.000Z"));
    await expect(
      harness.payments.initializePayment({ correlationId, orderId: order.id }),
    ).resolves.toMatchObject({
      payment: { externalPaymentId: "pi_fixture_1" },
      status: "INITIALIZED",
    });
    expect(harness.stripe.createInputs).toHaveLength(2);
    expect(
      new Set(harness.stripe.createInputs.map((item) => item.idempotencyKey))
        .size,
    ).toBe(1);
  });

  it("bounds concurrent recovery with one creation lease and supports stale lease recovery", async () => {
    const harness = await createHarness({ createDelayMs: 20 });
    const order = await createOrder(harness, "pay-order-concurrent");
    await harness.paymentRepository.reserveForOrder({
      now,
      order,
      stripeIdempotencyKey: stripePaymentIntentIdempotencyKey(order.id, 1),
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        harness.payments.initializePayment({
          correlationId,
          orderId: order.id,
        }),
      ),
    );

    expect(
      results.filter((result) => result.status === "INITIALIZED"),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) => result.reasonCode === "PAYMENT_CREATE_IN_FLIGHT",
      ),
    ).toHaveLength(9);
    expect(harness.stripe.createInputs).toHaveLength(1);

    const staleHarness = await createHarness();
    const staleOrder = await createOrder(staleHarness, "pay-order-stale");
    const reserved = await staleHarness.paymentRepository.reserveForOrder({
      now,
      order: staleOrder,
      stripeIdempotencyKey: stripePaymentIntentIdempotencyKey(staleOrder.id, 1),
    });
    const lease = await staleHarness.paymentRepository.acquireCreateLease({
      leaseToken: "fresh-token",
      now,
      paymentId: reserved.payment.id,
      staleAfter: new Date("2026-08-14T23:59:00.000Z"),
    });
    expect(lease.status).toBe("ACQUIRED");
    await expect(
      staleHarness.payments.initializePayment({
        correlationId,
        orderId: staleOrder.id,
      }),
    ).resolves.toMatchObject({ reasonCode: "PAYMENT_CREATE_IN_FLIGHT" });
    expect(staleHarness.stripe.createInputs).toHaveLength(0);

    staleHarness.setNow(new Date("2026-08-15T00:02:01.000Z"));
    await expect(
      staleHarness.payments.initializePayment({
        correlationId,
        orderId: staleOrder.id,
      }),
    ).resolves.toMatchObject({ status: "INITIALIZED" });
    expect(staleHarness.stripe.createInputs).toHaveLength(1);
  });

  it("does not retry definite provider rejections automatically", async () => {
    const harness = await createHarness({ createResults: ["REJECTED"] });
    const order = await createOrder(harness, "pay-order-rejected");

    await expect(
      harness.payments.initializePayment({ correlationId, orderId: order.id }),
    ).resolves.toMatchObject({
      payment: { status: "FAILED" },
      reasonCode: "PAYMENT_PROVIDER_REJECTED",
      status: "BLOCKED",
    });
    await expect(
      harness.payments.initializePayment({ correlationId, orderId: order.id }),
    ).resolves.toMatchObject({
      payment: { status: "FAILED" },
      reasonCode: "PAYMENT_IDEMPOTENT_REPLAY",
      status: "IDEMPOTENT",
    });
    expect(harness.stripe.createInputs).toHaveLength(1);
  });

  it("fails closed for recovered PaymentIntent identity mismatches", async () => {
    for (const [name, override, reasonCode] of [
      ["amount", { amountMinor: 1_301n }, "PAYMENT_AMOUNT_MISMATCH"],
      ["currency", { currency: currency("USD") }, "PAYMENT_CURRENCY_MISMATCH"],
      [
        "order",
        {
          metadata: {
            keycore_order_id: "00000000-0000-4000-8000-00000007eeee",
            keycore_payment_version: "1",
          },
        },
        "PAYMENT_ORDER_MISMATCH",
      ],
      [
        "version",
        {
          metadata: {
            keycore_order_id: "USE_ORDER_ID",
            keycore_payment_version: "2",
          },
        },
        "PAYMENT_ORDER_MISMATCH",
      ],
    ] as const) {
      const harness = await createHarness({ intentOverride: override });
      const order = await createOrder(harness, `pay-order-wrong-${name}`);
      await expect(
        harness.payments.initializePayment({
          correlationId,
          orderId: order.id,
        }),
      ).resolves.toMatchObject({
        reasonCode,
        status: "RECONCILIATION_REQUIRED",
      });
      await expect(harness.orders.getOrder(order.id)).resolves.toMatchObject({
        paymentStatus: "PENDING",
        status: "MANUAL_REVIEW",
      });
    }
  });

  it("keeps webhook-before-create-response durable without blind capture", async () => {
    const harness = await createHarness({ paymentIntentStatus: "succeeded" });
    const order = await createOrder(
      harness,
      "pay-order-webhook-before-response",
    );
    await harness.paymentRepository.reserveForOrder({
      now,
      order,
      stripeIdempotencyKey: stripePaymentIntentIdempotencyKey(order.id, 1),
    });

    await expect(
      harness.payments.processWebhook({
        correlationId,
        rawBody: safeJson(eventFor(order, "succeeded")),
        signatureHeader: "valid",
      }),
    ).resolves.toMatchObject({
      reasonCode: "PAYMENT_RECONCILIATION_REQUIRED",
      status: "RECONCILIATION_REQUIRED",
    });
    await expect(harness.orders.getOrder(order.id)).resolves.toMatchObject({
      paymentStatus: "NOT_STARTED",
      status: "CREATED",
    });

    await expect(
      harness.payments.initializePayment({ correlationId, orderId: order.id }),
    ).resolves.toMatchObject({
      payment: { externalPaymentId: "pi_fixture_1", status: "CAPTURED" },
      status: "INITIALIZED",
    });
    await expect(harness.orders.getOrder(order.id)).resolves.toMatchObject({
      paymentStatus: "CAPTURED",
      status: "PAYMENT_CAPTURED",
    });
  });

  it("rejects invalid webhook signatures before receipt or order mutation", async () => {
    const harness = await createHarness();
    const order = await createOrder(harness, "pay-order-4");
    await harness.payments.initializePayment({
      correlationId,
      orderId: order.id,
    });

    await expect(
      harness.payments.processWebhook({
        correlationId,
        rawBody: safeJson(eventFor(order, "succeeded")),
        signatureHeader: "invalid",
      }),
    ).resolves.toMatchObject({
      reasonCode: "PAYMENT_WEBHOOK_SIGNATURE_INVALID",
      status: "BLOCKED",
    });
    await expect(harness.orders.getOrder(order.id)).resolves.toMatchObject({
      paymentStatus: "PENDING",
      status: "AWAITING_PAYMENT",
    });
  });

  it("captures an order only after a signed matching payment_intent.succeeded webhook", async () => {
    const harness = await createHarness();
    const order = await createOrder(harness, "pay-order-5");
    await harness.payments.initializePayment({
      correlationId,
      orderId: order.id,
    });

    await expect(
      harness.payments.processWebhook({
        correlationId,
        rawBody: safeJson(eventFor(order, "succeeded")),
        signatureHeader: "valid",
      }),
    ).resolves.toMatchObject({
      reasonCode: "PAYMENT_CAPTURE_CONFIRMED",
      status: "INITIALIZED",
    });
    await expect(harness.orders.getOrder(order.id)).resolves.toMatchObject({
      paymentStatus: "CAPTURED",
      procurementStatus: "NOT_STARTED",
      riskStatus: "NOT_EVALUATED",
      status: "PAYMENT_CAPTURED",
    });
    const latest = required(await harness.orders.getOrder(order.id));
    await expect(
      harness.orders.beginProcurement({
        correlationId,
        expectedVersion: latest.recordVersion,
        orderId: order.id,
      }),
    ).resolves.toMatchObject({
      reasonCode: "RISK_NOT_APPROVED",
      status: "BLOCKED",
    });
  });

  it("does not capture processing, failed, canceled or mismatched webhooks", async () => {
    for (const [status, expectedPaymentStatus] of [
      ["processing", "PENDING"],
      ["payment_failed", "FAILED"],
      ["canceled", "CANCELLED"],
    ] as const) {
      const harness = await createHarness();
      const order = await createOrder(harness, `pay-order-${status}`);
      await harness.payments.initializePayment({
        correlationId,
        orderId: order.id,
      });
      await harness.payments.processWebhook({
        correlationId,
        rawBody: safeJson(eventFor(order, status)),
        signatureHeader: "valid",
      });
      await expect(harness.orders.getOrder(order.id)).resolves.toMatchObject({
        paymentStatus: expectedPaymentStatus,
      });
    }

    const mismatchHarness = await createHarness();
    const mismatchOrder = await createOrder(
      mismatchHarness,
      "pay-order-mismatch",
    );
    await mismatchHarness.payments.initializePayment({
      correlationId,
      orderId: mismatchOrder.id,
    });
    await expect(
      mismatchHarness.payments.processWebhook({
        correlationId,
        rawBody: safeJson(
          eventFor(mismatchOrder, "succeeded", { amountMinor: 1_301n }),
        ),
        signatureHeader: "valid",
      }),
    ).resolves.toMatchObject({
      reasonCode: "PAYMENT_AMOUNT_MISMATCH",
      status: "RECONCILIATION_REQUIRED",
    });
    await expect(
      mismatchHarness.orders.getOrder(mismatchOrder.id),
    ).resolves.toMatchObject({
      paymentStatus: "PENDING",
      status: "MANUAL_REVIEW",
    });
  });

  it("deduplicates webhook replays and prevents captured payment regression", async () => {
    const harness = await createHarness();
    const order = await createOrder(harness, "pay-order-6");
    await harness.payments.initializePayment({
      correlationId,
      orderId: order.id,
    });
    const succeeded = eventFor(order, "succeeded");

    await harness.payments.processWebhook({
      correlationId,
      rawBody: safeJson(succeeded),
      signatureHeader: "valid",
    });
    await expect(
      harness.payments.processWebhook({
        correlationId,
        rawBody: safeJson(succeeded),
        signatureHeader: "valid",
      }),
    ).resolves.toMatchObject({ status: "IDEMPOTENT" });
    await harness.payments.processWebhook({
      correlationId,
      rawBody: safeJson(
        eventFor(order, "processing", {
          eventId: "evt_older_processing",
          secondsOffset: -5,
        }),
      ),
      signatureHeader: "valid",
    });

    await expect(harness.orders.getOrder(order.id)).resolves.toMatchObject({
      paymentStatus: "CAPTURED",
      status: "PAYMENT_CAPTURED",
    });
    await expect(
      harness.paymentRepository.findByExternalPaymentId({
        externalPaymentId: "pi_fixture_1",
        provider: "STRIPE",
      }),
    ).resolves.toMatchObject({ status: "CAPTURED" });
  });

  it("normalizes large batches without leaking client secrets into safe payloads", () => {
    const started = performance.now();
    for (let index = 0; index < 50_000; index += 1) {
      expect(
        normalizeStripePaymentStatus(
          index % 2 === 0 ? "succeeded" : "processing",
        ),
      ).toBe(index % 2 === 0 ? "CAPTURED" : "PROCESSING");
    }
    expect(
      JSON.stringify(
        stripePaymentMetadata({
          orderId: "00000000-0000-4000-8000-00000007ffff" as KeyCoreOrder["id"],
          paymentVersion: 1,
        }),
      ),
    ).not.toContain("secret");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

const createHarness = async (
  options: {
    readonly createResults?: readonly ("CREATED" | "AMBIGUOUS" | "REJECTED")[];
    readonly createDelayMs?: number;
    readonly intentOverride?: IntentOverride;
    readonly paymentIntentStatus?: StripePaymentIntentStatus;
    readonly repository?: PaymentRepository;
  } = {},
) => {
  let currentNow = now;
  const policy = createPricingPolicy({
    currency: eur,
    fixedMarkup: money(0n, eur),
    markupBasisPoints: 0n,
    minimumProfit: money(50n, eur),
    minimumSellPrice: money(0n, eur),
    now: currentNow,
    policyId: "00000000-0000-4000-8000-000000070299",
    quoteTtlMs: 120_000,
  });
  const pricingRepository = new InMemoryPricingRepository(policy);
  const pricing = new PricingService({
    maxInputAgeMs: 300_000,
    now: () => currentNow,
    offerSource: new FixtureOfferSource(),
    overrideRepository: pricingRepository,
    policyRepository: pricingRepository,
    snapshots: pricingRepository,
    taxPolicy: new FixtureTaxPolicy(),
  });
  const priceLocks = new PriceLockService({
    now: () => currentNow,
    pricing,
    repository: new InMemoryPriceLockRepository(),
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
  const orders = new OrderOrchestrationService({
    now: () => currentNow,
    priceLocks,
    repository: orderRepository,
  });
  const paymentRepository =
    options.repository ?? new InMemoryPaymentRepository();
  const stripe = new FakeStripeProvider({
    createDelayMs: options.createDelayMs ?? 0,
    createResults: options.createResults ?? ["CREATED"],
    paymentIntentStatus:
      options.paymentIntentStatus ?? "requires_payment_method",
    ...(options.intentOverride
      ? { intentOverride: options.intentOverride }
      : {}),
  });
  return {
    lock: required(lockResult.lock),
    orders,
    paymentRepository,
    payments: new StripePaymentService({
      now: () => currentNow,
      createLeaseStaleAfterMs: 60_000,
      orders,
      repository: paymentRepository,
      stripe,
      webhookSecret: "whsec_test_fixture",
      webhookVerifier: new FakeWebhookVerifier(),
    }),
    setNow: (next: Date): void => {
      currentNow = next;
    },
    stripe,
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

const eventFor = (
  order: KeyCoreOrder,
  status: "succeeded" | "processing" | "payment_failed" | "canceled",
  overrides: {
    readonly amountMinor?: bigint;
    readonly eventId?: string;
    readonly secondsOffset?: number;
  } = {},
): VerifiedStripeEvent => ({
  createdAt: new Date(now.getTime() + (overrides.secondsOffset ?? 0) * 1_000),
  id: overrides.eventId ?? `evt_${status}_${order.id}`,
  paymentIntent: intentFor(
    order,
    status === "payment_failed" ? "requires_payment_method" : status,
    overrides.amountMinor,
  ),
  type:
    status === "succeeded"
      ? "payment_intent.succeeded"
      : status === "processing"
        ? "payment_intent.processing"
        : status === "canceled"
          ? "payment_intent.canceled"
          : "payment_intent.payment_failed",
});

const intentFor = (
  order: KeyCoreOrder,
  status: StripePaymentIntentStatus,
  amountMinor = order.customerAmount.amountMinor,
  override: IntentOverride = {},
): NormalizedStripePaymentIntent => {
  const overrideMetadata =
    override.metadata?.keycore_order_id === "USE_ORDER_ID"
      ? { ...override.metadata, keycore_order_id: order.id }
      : override.metadata;
  const intentCurrency = override.currency ?? order.currency;
  return {
    amount: money(override.amountMinor ?? amountMinor, intentCurrency),
    createdAt: now,
    currency: intentCurrency,
    id: "pi_fixture_1",
    metadata:
      overrideMetadata ??
      stripePaymentMetadata({ orderId: order.id, paymentVersion: 1 }),
    status,
    ...(status === "requires_payment_method"
      ? { clientSecret: "pi_fixture_secret_client" }
      : {}),
  };
};

class FakeStripeProvider implements StripePaymentProviderPort {
  public readonly createInputs: StripePaymentIntentCreateInput[] = [];
  private readonly createResults: ("CREATED" | "AMBIGUOUS" | "REJECTED")[];

  public constructor(private readonly options: FakeStripeProviderOptions) {
    this.createResults = [...options.createResults];
  }

  public async createPaymentIntent(
    input: StripePaymentIntentCreateInput,
  ): Promise<PaymentProviderCreateResult> {
    this.createInputs.push(input);
    if (this.options.createDelayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.createDelayMs),
      );
    }
    const createStatus = this.createResults.shift() ?? "CREATED";
    if (createStatus === "AMBIGUOUS") {
      return {
        reasonCode: "PAYMENT_RECONCILIATION_REQUIRED",
        status: "AMBIGUOUS",
      };
    }
    if (createStatus === "REJECTED") {
      return { reasonCode: "PAYMENT_PROVIDER_REJECTED", status: "REJECTED" };
    }
    return {
      paymentIntent: intentFor(
        input.order,
        this.options.paymentIntentStatus,
        input.order.customerAmount.amountMinor,
        this.options.intentOverride,
      ),
      status: "CREATED",
    };
  }

  public async retrievePaymentIntent(
    externalPaymentId: string,
  ): Promise<PaymentProviderRetrieveResult> {
    const input = this.createInputs[0];
    if (!input || externalPaymentId !== "pi_fixture_1") {
      return { reasonCode: "PAYMENT_NOT_FOUND", status: "NOT_FOUND" };
    }
    return {
      paymentIntent: intentFor(input.order, "succeeded"),
      status: "FOUND",
    };
  }
}

interface FakeStripeProviderOptions {
  readonly createResults: readonly ("CREATED" | "AMBIGUOUS" | "REJECTED")[];
  readonly createDelayMs: number;
  readonly intentOverride?: IntentOverride;
  readonly paymentIntentStatus: StripePaymentIntentStatus;
}

interface IntentOverride {
  readonly amountMinor?: bigint;
  readonly currency?: ReturnType<typeof currency>;
  readonly metadata?: Readonly<Record<string, string>>;
}

class FailsOnceMarkCreatedRepository implements PaymentRepository {
  private failNext = true;

  public constructor(private readonly inner: PaymentRepository) {}

  public reserveForOrder(input: {
    readonly order: KeyCoreOrder;
    readonly stripeIdempotencyKey: string;
    readonly now: Date;
  }): Promise<PaymentReservationResult> {
    return this.inner.reserveForOrder(input);
  }

  public findByOrder(input: {
    readonly orderId: KeyCoreOrder["id"];
    readonly provider: "STRIPE";
  }): Promise<PaymentRecord | null> {
    return this.inner.findByOrder(input);
  }

  public findByExternalPaymentId(input: {
    readonly provider: "STRIPE";
    readonly externalPaymentId: string;
  }): Promise<PaymentRecord | null> {
    return this.inner.findByExternalPaymentId(input);
  }

  public acquireCreateLease(input: {
    readonly paymentId: string;
    readonly leaseToken: string;
    readonly staleAfter: Date;
    readonly now: Date;
  }): Promise<PaymentCreationLeaseResult> {
    return this.inner.acquireCreateLease(input);
  }

  public async markProviderCreated(input: {
    readonly paymentId: string;
    readonly leaseToken: string;
    readonly externalPaymentId: string;
    readonly providerFingerprint: string;
    readonly status: PaymentStatus;
    readonly lastProviderEventAt: Date;
    readonly now: Date;
  }): Promise<PaymentUpdateResult> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Simulated local persistence failure");
    }
    return this.inner.markProviderCreated(input);
  }

  public updateFromProvider(input: {
    readonly paymentId: string;
    readonly expectedVersion: number;
    readonly providerFingerprint: string;
    readonly status: PaymentStatus;
    readonly lastProviderEventAt: Date;
    readonly reconciliationRequired: boolean;
    readonly now: Date;
  }): Promise<PaymentUpdateResult> {
    return this.inner.updateFromProvider(input);
  }

  public markCreateOutcomeUnknown(input: {
    readonly paymentId: string;
    readonly leaseToken: string;
    readonly now: Date;
  }): Promise<PaymentUpdateResult> {
    return this.inner.markCreateOutcomeUnknown(input);
  }

  public markCreateRejected(input: {
    readonly paymentId: string;
    readonly leaseToken: string;
    readonly providerFingerprint: string;
    readonly now: Date;
  }): Promise<PaymentUpdateResult> {
    return this.inner.markCreateRejected(input);
  }

  public markReconciliationRequired(input: {
    readonly paymentId: string;
    readonly expectedVersion: number;
    readonly providerFingerprint?: string;
    readonly now: Date;
  }): Promise<PaymentUpdateResult> {
    return this.inner.markReconciliationRequired(input);
  }
}

class FakeWebhookVerifier implements StripeWebhookVerifier {
  public async verify(input: {
    readonly rawBody: string | Buffer;
    readonly signatureHeader?: string;
  }): Promise<VerifiedStripeEvent> {
    if (input.signatureHeader !== "valid") {
      throw new Error("Invalid signature");
    }
    return JSON.parse(
      input.rawBody.toString(),
      reviveWebhookJson,
    ) as VerifiedStripeEvent;
  }
}

class FixtureOfferSource {
  public async loadPriceableOffers(): Promise<readonly AcquisitionCostInput[]> {
    return [
      {
        baseSupplierPrice: money(1_000n, eur),
        capturedAt: now,
        costVersion: "cost-v1",
        fixedFee: money(250n, eur),
        offerId: offerId("payment-offer-a") as OfferId,
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
      policyVersion: "tax-v1",
      taxAmount: money(0n, eur),
      treatment: "CONFIGURED_FIXTURE",
    };
  }
}

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

const reviveWebhookJson = (key: string, value: unknown): unknown => {
  if (key === "amountMinor" && typeof value === "string") {
    return BigInt(value);
  }
  if (
    (key === "createdAt" || key === "updatedAt") &&
    typeof value === "string"
  ) {
    return new Date(value);
  }
  return value;
};
