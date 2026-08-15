import Stripe from "stripe";

import { currency, money } from "../../packages/platform/src/contracts.js";
import {
  normalizeStripePaymentStatus,
  stripeApiVersion,
  stripePaymentMetadata,
  validateStripeTestModeConfig,
  type NormalizedStripePaymentIntent,
  type PaymentProviderCreateResult,
  type PaymentProviderRetrieveResult,
  type StripePaymentIntentCreateInput,
  type StripePaymentIntentStatus,
  type StripePaymentProviderPort,
  type StripeWebhookVerifier,
  type VerifiedStripeEvent,
} from "../../packages/platform/src/payments/stripe-payments.js";

export interface StripeClientConfig {
  readonly secretKey: string;
  readonly environment: "TEST" | "LIVE";
}

export const createStripeClient = (config: StripeClientConfig): Stripe => {
  validateStripeTestModeConfig({
    environment: config.environment,
    secretKey: config.secretKey,
  });
  return new Stripe(config.secretKey, { apiVersion: stripeApiVersion });
};

export class StripePaymentIntentClient implements StripePaymentProviderPort {
  public constructor(private readonly stripe: Stripe) {}

  public async createPaymentIntent(
    input: StripePaymentIntentCreateInput,
  ): Promise<PaymentProviderCreateResult> {
    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: Number(input.order.customerAmount.amountMinor),
          automatic_payment_methods: { enabled: true },
          capture_method: "automatic",
          currency: input.order.currency.toLowerCase(),
          metadata: stripePaymentMetadata({
            orderId: input.order.id,
            paymentVersion: input.payment.operationVersion,
          }),
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return {
        paymentIntent: normalizePaymentIntent(intent),
        status: "CREATED",
      };
    } catch (error) {
      return classifyStripeError(error);
    }
  }

  public async retrievePaymentIntent(
    externalPaymentId: string,
  ): Promise<PaymentProviderRetrieveResult> {
    try {
      const intent =
        await this.stripe.paymentIntents.retrieve(externalPaymentId);
      return { paymentIntent: normalizePaymentIntent(intent), status: "FOUND" };
    } catch (error) {
      if (isStripeNotFound(error)) {
        return { reasonCode: "PAYMENT_NOT_FOUND", status: "NOT_FOUND" };
      }
      return {
        reasonCode: "PAYMENT_RECONCILIATION_REQUIRED",
        status: "AMBIGUOUS",
      };
    }
  }
}

export class StripeSdkWebhookVerifier implements StripeWebhookVerifier {
  public constructor(private readonly stripe: Stripe) {}

  public async verify(input: {
    readonly rawBody: string | Buffer;
    readonly signatureHeader?: string;
    readonly webhookSecret: string;
  }): Promise<VerifiedStripeEvent> {
    if (!input.signatureHeader) {
      throw new Error("Stripe signature header is required");
    }
    const event = this.stripe.webhooks.constructEvent(
      input.rawBody,
      input.signatureHeader,
      input.webhookSecret,
    );
    if (!isSupportedPaymentIntentEvent(event)) {
      throw new Error("Unsupported Stripe event type");
    }
    return {
      createdAt: new Date(event.created * 1000),
      id: event.id,
      paymentIntent: normalizePaymentIntent(event.data.object),
      type: event.type,
    };
  }
}

export const normalizePaymentIntent = (
  intent: Stripe.PaymentIntent,
): NormalizedStripePaymentIntent => {
  const normalizedCurrency = currency(intent.currency.toUpperCase());
  return {
    amount: money(BigInt(intent.amount), normalizedCurrency),
    createdAt: new Date(intent.created * 1000),
    currency: normalizedCurrency,
    id: intent.id,
    metadata: { ...intent.metadata },
    status: normalizeSupportedStatus(intent.status),
    ...(intent.client_secret ? { clientSecret: intent.client_secret } : {}),
  };
};

const normalizeSupportedStatus = (
  status: Stripe.PaymentIntent.Status,
): StripePaymentIntentStatus => {
  if (
    status === "requires_payment_method" ||
    status === "requires_confirmation" ||
    status === "requires_action" ||
    status === "processing" ||
    status === "requires_capture" ||
    status === "canceled" ||
    status === "succeeded"
  ) {
    return status;
  }
  return "requires_payment_method";
};

const classifyStripeError = (error: unknown): PaymentProviderCreateResult => {
  if (isAmbiguousStripeError(error)) {
    return {
      reasonCode: "PAYMENT_RECONCILIATION_REQUIRED",
      status: "AMBIGUOUS",
    };
  }
  return { reasonCode: "PAYMENT_PROVIDER_REJECTED", status: "REJECTED" };
};

const isAmbiguousStripeError = (error: unknown): boolean =>
  isStripeError(error) &&
  (error.type === "StripeAPIError" ||
    error.type === "StripeConnectionError" ||
    error.type === "StripeRateLimitError");

const isStripeNotFound = (error: unknown): boolean =>
  isStripeError(error) && error.type === "StripeInvalidRequestError";

const isStripeError = (error: unknown): error is { readonly type: string } =>
  typeof error === "object" &&
  error !== null &&
  "type" in error &&
  typeof (error as { readonly type?: unknown }).type === "string";

const isSupportedPaymentIntentEvent = (
  event: Stripe.Event,
): event is Stripe.Event & {
  readonly data: { readonly object: Stripe.PaymentIntent };
  readonly type: VerifiedStripeEvent["type"];
} =>
  event.type === "payment_intent.succeeded" ||
  event.type === "payment_intent.payment_failed" ||
  event.type === "payment_intent.processing" ||
  event.type === "payment_intent.canceled";

export const stripeIntentCaptured = (
  intent: NormalizedStripePaymentIntent,
): boolean => normalizeStripePaymentStatus(intent.status) === "CAPTURED";
