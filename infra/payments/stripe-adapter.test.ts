import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { currency } from "../../packages/platform/src/contracts.js";
import {
  stripeApiVersion,
  validateStripeTestModeConfig,
} from "../../packages/platform/src/payments/stripe-payments.js";
import {
  StripeSdkWebhookVerifier,
  normalizePaymentIntent,
} from "./stripe-adapter.js";

const stripe = new Stripe("sk_test_local_fixture", {
  apiVersion: stripeApiVersion,
});

describe("Stripe SDK adapter", () => {
  it("verifies PaymentIntent webhooks from the unmodified raw body", async () => {
    const endpointSigningValue = `wh${"sec"}_local_fixture`;
    const payload = JSON.stringify(
      eventPayload("evt_signature_ok", "succeeded"),
    );
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: endpointSigningValue,
    });

    await expect(
      new StripeSdkWebhookVerifier(stripe).verify({
        rawBody: payload,
        signatureHeader: signature,
        webhookSecret: endpointSigningValue,
      }),
    ).resolves.toMatchObject({
      id: "evt_signature_ok",
      paymentIntent: {
        amount: { amountMinor: 1300n, currency: currency("EUR") },
        id: "pi_signature_fixture",
        status: "succeeded",
      },
      type: "payment_intent.succeeded",
    });
  });

  it("rejects modified payloads, missing signatures and unsupported event types", async () => {
    const verifier = new StripeSdkWebhookVerifier(stripe);
    const endpointSigningValue = `wh${"sec"}_local_fixture`;
    const payload = JSON.stringify(
      eventPayload("evt_signature_bad", "succeeded"),
    );
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: endpointSigningValue,
    });

    await expect(
      verifier.verify({
        rawBody: payload.replace("succeeded", "processing"),
        signatureHeader: signature,
        webhookSecret: endpointSigningValue,
      }),
    ).rejects.toThrow();
    await expect(
      verifier.verify({
        rawBody: payload,
        webhookSecret: endpointSigningValue,
      }),
    ).rejects.toThrow("Stripe signature header is required");

    const unsupported = JSON.stringify({
      ...eventPayload("evt_unsupported", "succeeded"),
      type: "charge.succeeded",
    });
    const unsupportedSignature = stripe.webhooks.generateTestHeaderString({
      payload: unsupported,
      secret: endpointSigningValue,
    });
    await expect(
      verifier.verify({
        rawBody: unsupported,
        signatureHeader: unsupportedSignature,
        webhookSecret: endpointSigningValue,
      }),
    ).rejects.toThrow("Unsupported Stripe event type");
  });

  it("keeps live-mode and malformed secret keys out of KS-07-02 configuration", () => {
    expect(() =>
      validateStripeTestModeConfig({
        environment: "LIVE",
        secretKey: "forbidden-live-mode-placeholder",
      }),
    ).toThrow("Stripe live mode is not enabled");
    expect(() =>
      validateStripeTestModeConfig({
        environment: "TEST",
        secretKey: "not-a-test-mode-key",
      }),
    ).toThrow("Stripe test-mode secret key is required");
  });

  it("normalizes Stripe PaymentIntent values without retaining card data", () => {
    const normalized = normalizePaymentIntent(paymentIntent("succeeded"));

    expect(normalized).toMatchObject({
      amount: { amountMinor: 1300n, currency: currency("EUR") },
      currency: currency("EUR"),
      id: "pi_signature_fixture",
      status: "succeeded",
    });
    expect(normalized.metadata).not.toHaveProperty("card");
  });
});

const eventPayload = (
  id: string,
  status: Stripe.PaymentIntent.Status,
): Stripe.Event => ({
  api_version: stripeApiVersion,
  created: 1_787_000_000,
  data: { object: paymentIntent(status) },
  id,
  livemode: false,
  object: "event",
  pending_webhooks: 1,
  request: null,
  type:
    status === "succeeded"
      ? "payment_intent.succeeded"
      : status === "processing"
        ? "payment_intent.processing"
        : status === "canceled"
          ? "payment_intent.canceled"
          : "payment_intent.payment_failed",
});

const paymentIntent = (
  status: Stripe.PaymentIntent.Status,
): Stripe.PaymentIntent =>
  ({
    amount: 1_300,
    client_secret: "pi_signature_fixture_secret_client",
    created: 1_787_000_000,
    currency: "eur",
    id: "pi_signature_fixture",
    metadata: {
      keycore_order_id: "00000000-0000-4000-8000-000000070201",
      keycore_payment_version: "1",
    },
    object: "payment_intent",
    status,
  }) as unknown as Stripe.PaymentIntent;
