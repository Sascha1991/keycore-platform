import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  CustomerOrderIdentityService,
  OperationsControlService,
  OrderOrchestrationService,
  PriceLockService,
  correlationId,
  currency,
  money,
  offerId,
  productId,
  type CorrelationId,
  type CustomerId,
  type CustomerOrderIdentityRepository,
  type KeyCoreOrder,
  type OrderId,
  type OrderOwnershipBindingAuthorityPort,
  type PricingService,
  type ProductId,
  type ProductPriceSelection,
  type SellPriceQuote,
} from "../../packages/platform/src/contracts.js";
import {
  StripePaymentService,
  stripePaymentMetadata,
  type NormalizedStripePaymentIntent,
  type PaymentProviderCreateResult,
  type PaymentProviderRetrieveResult,
  type StripePaymentIntentCreateInput,
  type StripePaymentProviderPort,
  type StripeWebhookVerifier,
  type VerifiedStripeEvent,
} from "../../packages/platform/src/payments/stripe-payments.js";
import { PostgresCustomerOrderIdentityRepository } from "../postgres/customer-order-identity-repositories.js";
import type { TransactionalQueryable } from "../postgres/client.js";
import { PostgresOperationsControlRepository } from "../postgres/operations-control-repositories.js";
import { PostgresOrderRepository } from "../postgres/order-repositories.js";
import { PostgresPaymentRepository } from "../postgres/payment-repositories.js";
import { PostgresPriceLockRepository } from "../postgres/price-lock-repositories.js";
import { PostgresAuditEventRepository } from "../postgres/repositories.js";
import { stagingCheckoutCustomers } from "../postgres/staging-checkout-seed.js";
import {
  publishableStagingCatalog,
  type StagingCatalogProduct,
} from "./staging-catalog.js";

export type StagingPaymentOutcome = "SUCCESS" | "FAILURE" | "CANCEL";

export interface StagingCheckoutCommand {
  readonly checkoutCreatedAt: string;
  readonly checkoutToken: string;
  readonly customerId: CustomerId;
  readonly expectedTotalMinor: string;
  readonly currency: string;
  readonly outcome: StagingPaymentOutcome;
  readonly productReference: string;
  readonly quantity: number;
}

export type StagingCheckoutResult =
  | {
      readonly status: "CAPTURED" | "FAILED" | "CANCELLED" | "IDEMPOTENT";
      readonly orderId: string;
      readonly reasonCode: string;
    }
  | {
      readonly status: "DENIED" | "RECONCILIATION_REQUIRED";
      readonly reasonCode: string;
    };

export interface StagingCheckoutPort {
  checkout(command: StagingCheckoutCommand): Promise<StagingCheckoutResult>;
}

export const createPostgresStagingCheckout = (
  database: TransactionalQueryable,
  options: { readonly now?: () => Date } = {},
): StagingCheckoutPort => {
  const now = options.now ?? (() => new Date());
  const audit = new PostgresAuditEventRepository(database);
  const pricing = new StagingCatalogPricingService(now);
  const priceLockRepository = new PostgresPriceLockRepository(database);
  const priceLocks = new PriceLockService({
    audit,
    environment: "STAGING",
    now,
    pricing: pricing as unknown as PricingService,
    repository: priceLockRepository,
  });
  const orders = new OrderOrchestrationService({
    audit,
    environment: "STAGING",
    now,
    operationsControlGate: new OperationsControlService(
      new PostgresOperationsControlRepository(database),
      { environment: "STAGING", now },
    ),
    priceLocks,
    repository: new PostgresOrderRepository(database),
  });
  const identityRepository = new PostgresCustomerOrderIdentityRepository(
    database,
  );
  const identity = new CustomerOrderIdentityService({
    audit,
    environment: "STAGING",
    now,
    orderOwnershipAuthority: new StagingCheckoutOwnershipAuthority(
      identityRepository,
    ),
    repository: identityRepository,
  });
  const syntheticProvider = new SyntheticStripeProvider(now);
  const verifierSecret = randomBytes(32);
  const verifier = new SyntheticStripeWebhookVerifier(
    syntheticProvider,
    verifierSecret,
    now,
  );
  const payments = new StripePaymentService({
    audit,
    createLeaseStaleAfterMs: 60_000,
    environment: "STAGING",
    now,
    orders,
    repository: new PostgresPaymentRepository(database),
    stripe: syntheticProvider,
    webhookSecret: verifierSecret.toString("base64url"),
    webhookVerifier: verifier,
  });

  return new PostgresStagingCheckout({
    identity,
    now,
    orders,
    payments,
    priceLockRepository,
    priceLocks,
    verifier,
  });
};

class PostgresStagingCheckout implements StagingCheckoutPort {
  public constructor(
    private readonly dependencies: {
      readonly identity: CustomerOrderIdentityService;
      readonly now: () => Date;
      readonly orders: OrderOrchestrationService;
      readonly payments: StripePaymentService;
      readonly priceLockRepository: PostgresPriceLockRepository;
      readonly priceLocks: PriceLockService;
      readonly verifier: SyntheticStripeWebhookVerifier;
    },
  ) {}

  public async checkout(
    command: StagingCheckoutCommand,
  ): Promise<StagingCheckoutResult> {
    const product = this.validate(command);
    if (!product) {
      return { reasonCode: "CHECKOUT_REQUEST_INVALID", status: "DENIED" };
    }
    const customer = stagingCheckoutCustomers.find(
      (candidate) => candidate.customerId === command.customerId,
    );
    if (!customer) {
      return { reasonCode: "CHECKOUT_CUSTOMER_INVALID", status: "DENIED" };
    }

    const requestCorrelationId = correlationId(
      `staging-checkout-${command.checkoutToken}`,
    );
    const priceLockKey = `staging:checkout:price-lock:${command.checkoutToken}`;
    let lock =
      await this.dependencies.priceLockRepository.findByIdempotencyKey(
        priceLockKey,
      );
    if (!lock) {
      const created = await this.dependencies.priceLocks.createPriceLock({
        correlationId: requestCorrelationId,
        expiresAt: new Date(
          Date.parse(command.checkoutCreatedAt) + checkoutLifetimeMs,
        ),
        idempotencyKey: priceLockKey,
        quote: quoteFor(product, this.dependencies.now()),
      });
      if (!created.lock) {
        return {
          reasonCode: created.reasonCode ?? "CHECKOUT_PRICE_LOCK_BLOCKED",
          status:
            created.status === "CONFLICT"
              ? "RECONCILIATION_REQUIRED"
              : "DENIED",
        };
      }
      lock = created.lock;
    }
    if (
      lock.productId !== product.productId ||
      lock.currency !== "EUR" ||
      lock.lockedSellPrice.amountMinor !== BigInt(product.priceMinor)
    ) {
      return { reasonCode: "CHECKOUT_PRICE_LOCK_CONFLICT", status: "DENIED" };
    }

    const creation = await this.dependencies.orders.createOrder({
      checkoutEmailNormalized: customer.emailNormalized,
      correlationId: requestCorrelationId,
      expectedCurrency: currency("EUR"),
      expectedCustomerAmount: money(
        BigInt(product.priceMinor),
        currency("EUR"),
      ),
      idempotencyKey: `staging:checkout:order:${command.checkoutToken}`,
      priceLockId: lock.id,
      productId: productId(product.productId),
      quantity: 1,
    });
    if (!creation.order || creation.status === "CONFLICT") {
      return {
        reasonCode: creation.reasonCode,
        status:
          creation.status === "CONFLICT" ? "RECONCILIATION_REQUIRED" : "DENIED",
      };
    }
    if (
      creation.order.checkoutEmailNormalized !== customer.emailNormalized ||
      (creation.order.customerId &&
        creation.order.customerId !== command.customerId)
    ) {
      return { reasonCode: "CHECKOUT_OWNERSHIP_CONFLICT", status: "DENIED" };
    }

    const ownership = await this.dependencies.identity.bindOrderOwnership({
      correlationId: requestCorrelationId,
      customerId: command.customerId,
      expectedOrderVersion: creation.order.recordVersion,
      orderId: creation.order.id,
    });
    if (ownership.status !== "BOUND" && ownership.status !== "ALREADY_BOUND") {
      return {
        reasonCode: "CHECKOUT_OWNERSHIP_UNAVAILABLE",
        status: "RECONCILIATION_REQUIRED",
      };
    }

    const current = await this.dependencies.orders.getOrder(creation.order.id);
    if (!current || current.customerId !== command.customerId) {
      return {
        reasonCode: "CHECKOUT_ORDER_UNAVAILABLE",
        status: "RECONCILIATION_REQUIRED",
      };
    }
    const terminal = terminalResult(current, command.outcome);
    if (terminal) return terminal;

    const initialized = await this.dependencies.payments.initializePayment({
      correlationId: requestCorrelationId,
      orderId: current.id,
    });
    if (
      initialized.status === "BLOCKED" ||
      initialized.status === "RECONCILIATION_REQUIRED"
    ) {
      return {
        reasonCode: initialized.reasonCode,
        status:
          initialized.status === "RECONCILIATION_REQUIRED"
            ? "RECONCILIATION_REQUIRED"
            : "DENIED",
      };
    }

    const event = this.dependencies.verifier.createEvent(
      current.id,
      command.outcome,
    );
    const payment = await this.dependencies.payments.processWebhook({
      correlationId: requestCorrelationId,
      rawBody: event.body,
      signatureHeader: event.signature,
    });
    if (payment.status === "RECONCILIATION_REQUIRED") {
      return {
        reasonCode: payment.reasonCode,
        status: "RECONCILIATION_REQUIRED",
      };
    }
    if (payment.status === "BLOCKED") {
      return { reasonCode: payment.reasonCode, status: "DENIED" };
    }

    const latest = await this.dependencies.orders.getOrder(current.id);
    if (!latest) {
      return {
        reasonCode: "CHECKOUT_ORDER_UNAVAILABLE",
        status: "RECONCILIATION_REQUIRED",
      };
    }
    return resultFor(latest, creation.status === "IDEMPOTENT");
  }

  private validate(
    command: StagingCheckoutCommand,
  ): StagingCatalogProduct | null {
    if (
      !/^[a-f0-9]{64}$/u.test(command.checkoutToken) ||
      command.currency !== "EUR" ||
      command.quantity !== 1 ||
      !/^[1-9][0-9]{0,9}$/u.test(command.expectedTotalMinor)
    ) {
      return null;
    }
    const createdAt = Date.parse(command.checkoutCreatedAt);
    const now = this.dependencies.now().getTime();
    if (
      !Number.isFinite(createdAt) ||
      createdAt > now + maxFutureClockSkewMs ||
      createdAt + checkoutLifetimeMs <= now
    ) {
      return null;
    }
    const product = publishableStagingCatalog().find(
      (candidate) => candidate.publicReference === command.productReference,
    );
    return product &&
      command.expectedTotalMinor === product.priceMinor.toString()
      ? product
      : null;
  }
}

class StagingCheckoutOwnershipAuthority implements OrderOwnershipBindingAuthorityPort {
  public constructor(
    private readonly repository: CustomerOrderIdentityRepository,
  ) {}

  public async verifiedOrderOwnership(input: {
    readonly orderId: OrderId;
    readonly customerId: CustomerId;
    readonly correlationId: CorrelationId;
  }) {
    const order = await this.repository.inspectOrderOwnership(input.orderId);
    const customer = await this.repository.findCustomerById(input.customerId);
    if (
      !order ||
      !customer ||
      customer.emailVerificationState !== "VERIFIED" ||
      order.checkoutEmailNormalized !== customer.emailNormalized ||
      (order.ownerCustomerId && order.ownerCustomerId !== input.customerId)
    ) {
      return { status: "DENIED" as const };
    }
    return {
      actorId: "staging-customer-checkout",
      actorType: "SERVICE" as const,
      providerEvidenceId: `staging-checkout:${input.orderId}`,
      status: "AUTHORIZED" as const,
    };
  }
}

class StagingCatalogPricingService {
  public constructor(private readonly now: () => Date) {}

  public async quoteProduct(input: {
    readonly productId: ProductId;
  }): Promise<ProductPriceSelection> {
    const product = publishableStagingCatalog().find(
      (candidate) => candidate.productId === input.productId,
    );
    if (!product) {
      return {
        productId: input.productId,
        quotes: [],
        reasonCode: "NO_ELIGIBLE_OFFER",
        status: "BLOCKED",
      };
    }
    const quote = quoteFor(product, this.now());
    return {
      productId: input.productId,
      quotes: [quote],
      selectedQuote: quote,
      status: "QUOTED",
    };
  }
}

class SyntheticStripeProvider implements StripePaymentProviderPort {
  private readonly intents = new Map<string, NormalizedStripePaymentIntent>();

  public constructor(private readonly now: () => Date) {}

  public async createPaymentIntent(
    input: StripePaymentIntentCreateInput,
  ): Promise<PaymentProviderCreateResult> {
    const id = `pi_staging_${input.order.id}`;
    const existing = this.intents.get(id);
    if (existing) return { paymentIntent: existing, status: "CREATED" };
    const intent: NormalizedStripePaymentIntent = {
      amount: input.order.customerAmount,
      createdAt: this.now(),
      currency: input.order.currency,
      id,
      metadata: stripePaymentMetadata({
        orderId: input.order.id,
        paymentVersion: input.payment.operationVersion,
      }),
      status: "requires_payment_method",
    };
    this.intents.set(id, intent);
    return { paymentIntent: intent, status: "CREATED" };
  }

  public async retrievePaymentIntent(
    externalPaymentId: string,
  ): Promise<PaymentProviderRetrieveResult> {
    const intent = this.intents.get(externalPaymentId);
    return intent
      ? { paymentIntent: intent, status: "FOUND" }
      : { reasonCode: "PAYMENT_NOT_FOUND", status: "NOT_FOUND" };
  }

  public eventIntent(
    requestedOrderId: string,
    outcome: StagingPaymentOutcome,
  ): NormalizedStripePaymentIntent | null {
    const id = `pi_staging_${requestedOrderId}`;
    const current = this.intents.get(id);
    if (!current) return null;
    const status =
      outcome === "SUCCESS"
        ? "succeeded"
        : outcome === "CANCEL"
          ? "canceled"
          : "requires_payment_method";
    const updated = { ...current, createdAt: this.now(), status } as const;
    this.intents.set(id, updated);
    return updated;
  }
}

class SyntheticStripeWebhookVerifier implements StripeWebhookVerifier {
  public constructor(
    private readonly provider: SyntheticStripeProvider,
    private readonly secret: Buffer,
    private readonly now: () => Date,
  ) {}

  public createEvent(
    requestedOrderId: string,
    outcome: StagingPaymentOutcome,
  ): { readonly body: string; readonly signature: string } {
    const body = JSON.stringify({ orderId: requestedOrderId, outcome });
    return {
      body,
      signature: createHmac("sha256", this.secret)
        .update(body)
        .digest("base64url"),
    };
  }

  public async verify(input: {
    readonly rawBody: string | Buffer;
    readonly signatureHeader?: string;
  }): Promise<VerifiedStripeEvent> {
    const body = Buffer.isBuffer(input.rawBody)
      ? input.rawBody.toString("utf8")
      : input.rawBody;
    const expected = createHmac("sha256", this.secret)
      .update(body)
      .digest("base64url");
    if (
      !input.signatureHeader ||
      !constantTimeEqual(expected, input.signatureHeader)
    ) {
      throw new Error("Synthetic payment signature invalid");
    }
    const payload = JSON.parse(body) as {
      readonly orderId?: unknown;
      readonly outcome?: unknown;
    };
    if (
      typeof payload.orderId !== "string" ||
      !isPaymentOutcome(payload.outcome)
    ) {
      throw new Error("Synthetic payment event invalid");
    }
    const intent = this.provider.eventIntent(payload.orderId, payload.outcome);
    if (!intent) throw new Error("Synthetic payment intent unavailable");
    return {
      createdAt: this.now(),
      id: `evt_staging_${payload.outcome.toLowerCase()}_${payload.orderId}`,
      paymentIntent: intent,
      type:
        payload.outcome === "SUCCESS"
          ? "payment_intent.succeeded"
          : payload.outcome === "CANCEL"
            ? "payment_intent.canceled"
            : "payment_intent.payment_failed",
    };
  }
}

const quoteFor = (
  product: StagingCatalogProduct,
  calculatedAt: Date,
): SellPriceQuote => {
  const sellPrice = BigInt(product.priceMinor);
  const acquisition = sellPrice > 300n ? sellPrice - 300n : 1n;
  const profit = sellPrice - acquisition;
  const eur = currency("EUR");
  return {
    acquisitionCost: money(acquisition, eur),
    calculatedAt,
    currency: eur,
    expectedProfit: money(profit, eur),
    hardMinimumProfit: money(1n, eur),
    hardMinimumSellPrice: money(1n, eur),
    knownFees: money(0n, eur),
    marginBasisPoints: (profit * 10_000n) / sellPrice,
    markupBasisPoints: (profit * 10_000n) / acquisition,
    offerId: offerId(`staging-checkout-${product.publicReference}`),
    preRoundingPrice: money(sellPrice, eur),
    pricingPolicyRecordVersion: 1,
    pricingPolicyVersion: "pricing-policy-v1",
    productId: productId(product.productId),
    sellPrice: money(sellPrice, eur),
    sourceFingerprint: createHash("sha256")
      .update(
        `${product.productId}:${product.publicReference}:${product.priceMinor}:EUR`,
      )
      .digest("hex"),
    status: "QUOTED",
    taxAmount: money(0n, eur),
    taxPolicyVersion: "staging-synthetic-tax-v1",
  };
};

const terminalResult = (
  order: KeyCoreOrder,
  outcome: StagingPaymentOutcome,
): StagingCheckoutResult | null => {
  if (order.paymentStatus === "CAPTURED") {
    return {
      orderId: order.id,
      reasonCode: "CHECKOUT_IDEMPOTENT_REPLAY",
      status: "IDEMPOTENT",
    };
  }
  if (order.paymentStatus === "FAILED" || order.paymentStatus === "CANCELLED") {
    const expected = outcome === "FAILURE" ? "FAILED" : "CANCELLED";
    return order.paymentStatus === expected
      ? resultFor(order, true)
      : { reasonCode: "CHECKOUT_OUTCOME_CONFLICT", status: "DENIED" };
  }
  return null;
};

const resultFor = (
  order: KeyCoreOrder,
  replay: boolean,
): StagingCheckoutResult => {
  if (order.paymentStatus === "CAPTURED") {
    return {
      orderId: order.id,
      reasonCode: replay
        ? "CHECKOUT_IDEMPOTENT_REPLAY"
        : "CHECKOUT_PAYMENT_CAPTURED",
      status: replay ? "IDEMPOTENT" : "CAPTURED",
    };
  }
  if (order.paymentStatus === "FAILED") {
    return {
      orderId: order.id,
      reasonCode: "CHECKOUT_PAYMENT_FAILED",
      status: "FAILED",
    };
  }
  if (order.paymentStatus === "CANCELLED") {
    return {
      orderId: order.id,
      reasonCode: "CHECKOUT_PAYMENT_CANCELLED",
      status: "CANCELLED",
    };
  }
  return {
    reasonCode: "CHECKOUT_PAYMENT_STATE_AMBIGUOUS",
    status: "RECONCILIATION_REQUIRED",
  };
};

const isPaymentOutcome = (value: unknown): value is StagingPaymentOutcome =>
  value === "SUCCESS" || value === "FAILURE" || value === "CANCEL";

const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
};

const checkoutLifetimeMs = 30 * 60 * 1_000;
const maxFutureClockSkewMs = 5 * 60 * 1_000;
