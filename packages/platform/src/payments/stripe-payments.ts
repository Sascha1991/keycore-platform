import { createHash, randomUUID } from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type { Money } from "../domain/money.js";
import type { CorrelationId, OrderId } from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import type {
  KeyCoreOrder,
  OrderOrchestrationService,
} from "../orders/order-orchestration.js";
import type { SafePayload } from "../queue/job.js";

export const stripeApiVersion = "2026-07-29.dahlia" as const;

export type PaymentProvider = "STRIPE";

export type PaymentStatus =
  | "NOT_CREATED"
  | "CREATION_PENDING"
  | "CREATE_OUTCOME_UNKNOWN"
  | "REQUIRES_PAYMENT_METHOD"
  | "REQUIRES_CUSTOMER_ACTION"
  | "PROCESSING"
  | "AUTHORIZED"
  | "CAPTURED"
  | "FAILED"
  | "CANCELLED"
  | "RECONCILIATION_REQUIRED";

export const paymentReasonCodes = [
  "PAYMENT_INITIALIZATION_REQUESTED",
  "PAYMENT_INTENT_CREATED",
  "PAYMENT_IDEMPOTENT_REPLAY",
  "PAYMENT_RECONCILIATION_REQUIRED",
  "PAYMENT_CREATE_IN_FLIGHT",
  "PAYMENT_CREATE_LEASE_STALE",
  "PAYMENT_PROVIDER_REJECTED",
  "PAYMENT_PROVIDER_CONFLICT",
  "PAYMENT_WEBHOOK_VERIFIED",
  "PAYMENT_WEBHOOK_SIGNATURE_INVALID",
  "PAYMENT_CAPTURE_CONFIRMED",
  "PAYMENT_FAILED",
  "PAYMENT_CANCELLED",
  "PAYMENT_PROCESSING",
  "PAYMENT_AMOUNT_MISMATCH",
  "PAYMENT_CURRENCY_MISMATCH",
  "PAYMENT_ORDER_MISMATCH",
  "PAYMENT_NOT_FOUND",
  "PAYMENT_ORDER_STATE_BLOCKED",
  "PAYMENT_OPTIMISTIC_CONFLICT",
] as const;

export type PaymentReasonCode = (typeof paymentReasonCodes)[number];

export interface PaymentRecord {
  readonly id: string;
  readonly orderId: OrderId;
  readonly provider: PaymentProvider;
  readonly externalPaymentId?: string | null;
  readonly amount: Money;
  readonly currency: Money["currency"];
  readonly status: PaymentStatus;
  readonly recordVersion: number;
  readonly operationVersion: number;
  readonly stripeIdempotencyKey: string;
  readonly providerFingerprint?: string | null;
  readonly reconciliationRequired: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastProviderEventAt?: Date | null;
  readonly createAttemptToken?: string | null;
  readonly createAttemptStartedAt?: Date | null;
}

export interface PaymentInitializationResponse {
  readonly status:
    "INITIALIZED" | "IDEMPOTENT" | "BLOCKED" | "RECONCILIATION_REQUIRED";
  readonly payment?: PaymentRecord;
  readonly clientSecret?: string;
  readonly reasonCode: PaymentReasonCode;
}

export interface StripePaymentIntentCreateInput {
  readonly order: KeyCoreOrder;
  readonly payment: PaymentRecord;
  readonly idempotencyKey: string;
}

export interface NormalizedStripePaymentIntent {
  readonly id: string;
  readonly amount: Money;
  readonly currency: Money["currency"];
  readonly status: StripePaymentIntentStatus;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: Date;
  readonly clientSecret?: string;
}

export type StripePaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "canceled"
  | "succeeded";

export type PaymentProviderCreateResult =
  | {
      readonly status: "CREATED";
      readonly paymentIntent: NormalizedStripePaymentIntent;
    }
  | { readonly status: "AMBIGUOUS"; readonly reasonCode: PaymentReasonCode }
  | { readonly status: "REJECTED"; readonly reasonCode: PaymentReasonCode };

export type PaymentProviderRetrieveResult =
  | {
      readonly status: "FOUND";
      readonly paymentIntent: NormalizedStripePaymentIntent;
    }
  | { readonly status: "NOT_FOUND"; readonly reasonCode: PaymentReasonCode }
  | { readonly status: "AMBIGUOUS"; readonly reasonCode: PaymentReasonCode };

export interface StripePaymentProviderPort {
  createPaymentIntent(
    input: StripePaymentIntentCreateInput,
  ): Promise<PaymentProviderCreateResult>;
  retrievePaymentIntent(
    externalPaymentId: string,
  ): Promise<PaymentProviderRetrieveResult>;
}

export interface VerifiedStripeEvent {
  readonly id: string;
  readonly type:
    | "payment_intent.succeeded"
    | "payment_intent.payment_failed"
    | "payment_intent.processing"
    | "payment_intent.canceled";
  readonly createdAt: Date;
  readonly paymentIntent: NormalizedStripePaymentIntent;
}

export interface StripeWebhookVerifier {
  verify(input: {
    readonly rawBody: string | Buffer;
    readonly signatureHeader?: string;
    readonly webhookSecret: string;
  }): Promise<VerifiedStripeEvent>;
}

export type PaymentReservationResult =
  | { readonly status: "CREATED"; readonly payment: PaymentRecord }
  | { readonly status: "EXISTING"; readonly payment: PaymentRecord };

export type PaymentCreationLeaseResult =
  | {
      readonly status: "ACQUIRED";
      readonly payment: PaymentRecord;
      readonly leaseToken: string;
    }
  | {
      readonly status: "IN_FLIGHT" | "NOT_ELIGIBLE";
      readonly payment: PaymentRecord;
    };

export type PaymentUpdateResult =
  | { readonly status: "UPDATED"; readonly payment: PaymentRecord }
  | { readonly status: "NOOP"; readonly payment: PaymentRecord }
  | { readonly status: "CONFLICT"; readonly payment: PaymentRecord | null };

export interface PaymentRepository {
  reserveForOrder(input: {
    readonly order: KeyCoreOrder;
    readonly stripeIdempotencyKey: string;
    readonly now: Date;
  }): Promise<PaymentReservationResult>;
  findByOrder(input: {
    readonly orderId: OrderId;
    readonly provider: PaymentProvider;
  }): Promise<PaymentRecord | null>;
  findByExternalPaymentId(input: {
    readonly provider: PaymentProvider;
    readonly externalPaymentId: string;
  }): Promise<PaymentRecord | null>;
  acquireCreateLease(input: {
    readonly paymentId: string;
    readonly leaseToken: string;
    readonly staleAfter: Date;
    readonly now: Date;
  }): Promise<PaymentCreationLeaseResult>;
  markProviderCreated(input: {
    readonly paymentId: string;
    readonly leaseToken: string;
    readonly externalPaymentId: string;
    readonly providerFingerprint: string;
    readonly status: PaymentStatus;
    readonly lastProviderEventAt: Date;
    readonly now: Date;
  }): Promise<PaymentUpdateResult>;
  updateFromProvider(input: {
    readonly paymentId: string;
    readonly expectedVersion: number;
    readonly providerFingerprint: string;
    readonly status: PaymentStatus;
    readonly lastProviderEventAt: Date;
    readonly reconciliationRequired: boolean;
    readonly now: Date;
  }): Promise<PaymentUpdateResult>;
  markCreateOutcomeUnknown(input: {
    readonly paymentId: string;
    readonly leaseToken: string;
    readonly now: Date;
  }): Promise<PaymentUpdateResult>;
  markCreateRejected(input: {
    readonly paymentId: string;
    readonly leaseToken: string;
    readonly providerFingerprint: string;
    readonly now: Date;
  }): Promise<PaymentUpdateResult>;
  markReconciliationRequired(input: {
    readonly paymentId: string;
    readonly expectedVersion: number;
    readonly providerFingerprint?: string;
    readonly now: Date;
  }): Promise<PaymentUpdateResult>;
}

export interface StripePaymentServiceOptions {
  readonly repository: PaymentRepository;
  readonly orders: OrderOrchestrationService;
  readonly stripe: StripePaymentProviderPort;
  readonly webhookVerifier: StripeWebhookVerifier;
  readonly webhookSecret: string;
  readonly audit?: AuditEventPort;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
  readonly createLeaseStaleAfterMs: number;
}

export class StripePaymentService {
  private readonly now: () => Date;
  private readonly environment: AuditEvent["environment"];

  public constructor(private readonly options: StripePaymentServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.environment = options.environment ?? "LOCAL";
    if (options.createLeaseStaleAfterMs <= 0) {
      throw new Error("Stripe create lease stale policy must be positive");
    }
  }

  public async initializePayment(input: {
    readonly orderId: OrderId;
    readonly correlationId: CorrelationId;
  }): Promise<PaymentInitializationResponse> {
    const order = await this.options.orders.getOrder(input.orderId);
    if (!order || !paymentInitializableOrderStates.has(order.status)) {
      return {
        reasonCode: "PAYMENT_ORDER_STATE_BLOCKED",
        status: "BLOCKED",
      };
    }
    const stripeIdempotencyKey = stripePaymentIntentIdempotencyKey(order.id, 1);
    const reserved = await this.options.repository.reserveForOrder({
      now: this.now(),
      order,
      stripeIdempotencyKey,
    });
    if (
      reserved.status === "EXISTING" &&
      !createRetryablePaymentStatuses.has(reserved.payment.status)
    ) {
      return {
        payment: reserved.payment,
        reasonCode: "PAYMENT_IDEMPOTENT_REPLAY",
        status:
          reserved.payment.status === "RECONCILIATION_REQUIRED"
            ? "RECONCILIATION_REQUIRED"
            : "IDEMPOTENT",
      };
    }

    if (order.status === "CREATED") {
      await this.options.orders.markAwaitingPayment({
        correlationId: input.correlationId,
        expectedVersion: order.recordVersion,
        orderId: order.id,
      });
    }

    const lease = await this.options.repository.acquireCreateLease({
      leaseToken: randomUUID(),
      now: this.now(),
      paymentId: reserved.payment.id,
      staleAfter: new Date(
        this.now().getTime() - this.options.createLeaseStaleAfterMs,
      ),
    });
    if (lease.status !== "ACQUIRED") {
      return {
        payment: lease.payment,
        reasonCode:
          lease.status === "IN_FLIGHT"
            ? "PAYMENT_CREATE_IN_FLIGHT"
            : "PAYMENT_IDEMPOTENT_REPLAY",
        status: "IDEMPOTENT",
      };
    }

    await this.audit(
      lease.payment,
      "PAYMENT_INITIALIZATION_REQUESTED",
      "SUCCEEDED",
      "PAYMENT_INITIALIZATION_REQUESTED",
      input.correlationId,
    );
    const providerResult = await this.options.stripe.createPaymentIntent({
      idempotencyKey: stripeIdempotencyKey,
      order,
      payment: lease.payment,
    });
    if (providerResult.status === "AMBIGUOUS") {
      const marked = await this.options.repository.markCreateOutcomeUnknown({
        leaseToken: lease.leaseToken,
        now: this.now(),
        paymentId: lease.payment.id,
      });
      return {
        payment: marked.payment ?? lease.payment,
        reasonCode: "PAYMENT_RECONCILIATION_REQUIRED",
        status: "RECONCILIATION_REQUIRED",
      };
    }
    if (providerResult.status === "REJECTED") {
      const updated = await this.options.repository.markCreateRejected({
        now: this.now(),
        paymentId: lease.payment.id,
        providerFingerprint: "provider-rejected",
        leaseToken: lease.leaseToken,
      });
      return {
        payment: updated.payment ?? lease.payment,
        reasonCode: providerResult.reasonCode,
        status: "BLOCKED",
      };
    }

    const normalizedStatus = normalizeStripePaymentStatus(
      providerResult.paymentIntent.status,
    );
    const mismatch = validateProviderEvidence(
      order,
      lease.payment,
      providerResult.paymentIntent,
    );
    if (mismatch) {
      const marked = await this.options.repository.markReconciliationRequired({
        expectedVersion: lease.payment.recordVersion,
        now: this.now(),
        paymentId: lease.payment.id,
        providerFingerprint: stripePaymentIntentFingerprint(
          providerResult.paymentIntent,
        ),
      });
      await this.options.orders.markManualReview({
        correlationId: input.correlationId,
        expectedVersion:
          (await this.options.orders.getOrder(order.id))?.recordVersion ??
          order.recordVersion,
        orderId: order.id,
      });
      return {
        payment: marked.payment ?? lease.payment,
        reasonCode: mismatch,
        status: "RECONCILIATION_REQUIRED",
      };
    }
    const persisted = await this.options.repository.markProviderCreated({
      externalPaymentId: providerResult.paymentIntent.id,
      lastProviderEventAt: providerResult.paymentIntent.createdAt,
      leaseToken: lease.leaseToken,
      now: this.now(),
      paymentId: lease.payment.id,
      providerFingerprint: stripePaymentIntentFingerprint(
        providerResult.paymentIntent,
      ),
      status: normalizedStatus,
    });
    if (persisted.status === "CONFLICT" || !persisted.payment) {
      const marked = await this.options.repository.markReconciliationRequired({
        expectedVersion: lease.payment.recordVersion,
        now: this.now(),
        paymentId: lease.payment.id,
      });
      return {
        payment: marked.payment ?? lease.payment,
        reasonCode: "PAYMENT_RECONCILIATION_REQUIRED",
        status: "RECONCILIATION_REQUIRED",
      };
    }
    await this.audit(
      persisted.payment,
      "PAYMENT_INTENT_CREATED",
      "SUCCEEDED",
      "PAYMENT_INTENT_CREATED",
      input.correlationId,
    );
    await this.transitionOrderFromPaymentStatus({
      correlationId: input.correlationId,
      normalizedStatus,
      orderId: order.id,
    });
    return {
      payment: persisted.payment,
      reasonCode: "PAYMENT_INTENT_CREATED",
      status: "INITIALIZED",
      ...(providerResult.paymentIntent.clientSecret
        ? { clientSecret: providerResult.paymentIntent.clientSecret }
        : {}),
    };
  }

  public async processWebhook(input: {
    readonly rawBody: string | Buffer;
    readonly signatureHeader?: string;
    readonly correlationId: CorrelationId;
  }): Promise<PaymentInitializationResponse> {
    let event: VerifiedStripeEvent;
    try {
      event = await this.options.webhookVerifier.verify({
        rawBody: input.rawBody,
        webhookSecret: this.options.webhookSecret,
        ...(input.signatureHeader
          ? { signatureHeader: input.signatureHeader }
          : {}),
      });
    } catch {
      return {
        reasonCode: "PAYMENT_WEBHOOK_SIGNATURE_INVALID",
        status: "BLOCKED",
      };
    }

    const payment = await this.options.repository.findByExternalPaymentId({
      externalPaymentId: event.paymentIntent.id,
      provider: "STRIPE",
    });
    const orderIdFromMetadata = event.paymentIntent.metadata.keycore_order_id;
    const order = payment
      ? await this.options.orders.getOrder(payment.orderId)
      : orderIdFromMetadata
        ? await this.options.orders.getOrder(orderIdFromMetadata as OrderId)
        : null;
    const receiptResult = await this.options.orders.recordExternalEvent({
      correlationId: input.correlationId,
      eventFingerprint: stripeEventFingerprint(event),
      eventType: event.type,
      externalEventId: event.id,
      ...(order ? { orderId: order.id } : {}),
      provider: "STRIPE",
    });
    if (receiptResult.status === "CONFLICT") {
      return {
        reasonCode: "PAYMENT_PROVIDER_CONFLICT",
        status: "RECONCILIATION_REQUIRED",
        ...(payment ? { payment } : {}),
      };
    }
    if (receiptResult.status === "DUPLICATE") {
      return {
        reasonCode: "PAYMENT_WEBHOOK_VERIFIED",
        status: "IDEMPOTENT",
        ...(payment ? { payment } : {}),
      };
    }
    if (!payment || !order) {
      return {
        reasonCode: "PAYMENT_RECONCILIATION_REQUIRED",
        status: "RECONCILIATION_REQUIRED",
      };
    }

    const mismatch = validateProviderEvidence(
      order,
      payment,
      event.paymentIntent,
    );
    if (mismatch) {
      const marked = await this.options.repository.markReconciliationRequired({
        expectedVersion: payment.recordVersion,
        now: this.now(),
        paymentId: payment.id,
        providerFingerprint: stripePaymentIntentFingerprint(
          event.paymentIntent,
        ),
      });
      await this.options.orders.markManualReview({
        correlationId: input.correlationId,
        expectedVersion: order.recordVersion,
        orderId: order.id,
      });
      return {
        payment: marked.payment ?? payment,
        reasonCode: mismatch,
        status: "RECONCILIATION_REQUIRED",
      };
    }

    const normalizedStatus = normalizeStripeWebhookPaymentStatus(event);
    const updated = await this.options.repository.updateFromProvider({
      expectedVersion: payment.recordVersion,
      lastProviderEventAt: event.createdAt,
      now: this.now(),
      paymentId: payment.id,
      providerFingerprint: stripePaymentIntentFingerprint(event.paymentIntent),
      reconciliationRequired: false,
      status: normalizedStatus,
    });
    const currentPayment = updated.payment ?? payment;
    if (updated.status === "CONFLICT") {
      return {
        payment: currentPayment,
        reasonCode: "PAYMENT_OPTIMISTIC_CONFLICT",
        status: "RECONCILIATION_REQUIRED",
      };
    }

    await this.transitionOrderFromPaymentStatus({
      correlationId: input.correlationId,
      normalizedStatus,
      orderId: order.id,
    });

    return {
      payment: currentPayment,
      reasonCode: reasonForStatus(normalizedStatus),
      status:
        normalizedStatus === "RECONCILIATION_REQUIRED"
          ? "RECONCILIATION_REQUIRED"
          : "INITIALIZED",
    };
  }

  public async reconcilePayment(input: {
    readonly orderId: OrderId;
    readonly correlationId: CorrelationId;
  }): Promise<PaymentInitializationResponse> {
    const payment = await this.options.repository.findByOrder({
      orderId: input.orderId,
      provider: "STRIPE",
    });
    if (!payment?.externalPaymentId) {
      return {
        reasonCode: "PAYMENT_RECONCILIATION_REQUIRED",
        status: "RECONCILIATION_REQUIRED",
        ...(payment ? { payment } : {}),
      };
    }
    const retrieved = await this.options.stripe.retrievePaymentIntent(
      payment.externalPaymentId,
    );
    if (retrieved.status !== "FOUND") {
      const marked = await this.options.repository.markReconciliationRequired({
        expectedVersion: payment.recordVersion,
        now: this.now(),
        paymentId: payment.id,
      });
      return {
        payment: marked.payment ?? payment,
        reasonCode: "PAYMENT_RECONCILIATION_REQUIRED",
        status: "RECONCILIATION_REQUIRED",
      };
    }
    const order = await this.options.orders.getOrder(input.orderId);
    if (!order) {
      return {
        payment,
        reasonCode: "PAYMENT_ORDER_STATE_BLOCKED",
        status: "BLOCKED",
      };
    }
    const mismatch = validateProviderEvidence(
      order,
      payment,
      retrieved.paymentIntent,
    );
    if (mismatch) {
      const marked = await this.options.repository.markReconciliationRequired({
        expectedVersion: payment.recordVersion,
        now: this.now(),
        paymentId: payment.id,
        providerFingerprint: stripePaymentIntentFingerprint(
          retrieved.paymentIntent,
        ),
      });
      await this.options.orders.markManualReview({
        correlationId: input.correlationId,
        expectedVersion: order.recordVersion,
        orderId: order.id,
      });
      return {
        payment: marked.payment ?? payment,
        reasonCode: mismatch,
        status: "RECONCILIATION_REQUIRED",
      };
    }
    const normalizedStatus = normalizeStripePaymentStatus(
      retrieved.paymentIntent.status,
    );
    const updated = await this.options.repository.updateFromProvider({
      expectedVersion: payment.recordVersion,
      lastProviderEventAt: retrieved.paymentIntent.createdAt,
      now: this.now(),
      paymentId: payment.id,
      providerFingerprint: stripePaymentIntentFingerprint(
        retrieved.paymentIntent,
      ),
      reconciliationRequired: normalizedStatus === "RECONCILIATION_REQUIRED",
      status: normalizedStatus,
    });
    await this.transitionOrderFromPaymentStatus({
      correlationId: input.correlationId,
      normalizedStatus,
      orderId: order.id,
    });
    return {
      payment: updated.payment ?? payment,
      reasonCode: reasonForStatus(normalizedStatus),
      status:
        normalizedStatus === "RECONCILIATION_REQUIRED"
          ? "RECONCILIATION_REQUIRED"
          : "INITIALIZED",
    };
  }

  private async audit(
    payment: PaymentRecord,
    eventType: AuditEvent["eventType"],
    outcome: AuditEvent["outcome"],
    reasonCode: PaymentReasonCode,
    correlationId: CorrelationId,
  ): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "stripe-payment-service", type: "SERVICE" },
      correlationId,
      entity: { id: payment.orderId, type: "ORDER" },
      environment: this.environment,
      eventType,
      metadata: {
        externalPaymentId: payment.externalPaymentId ?? "",
        normalizedStatus: payment.status,
        orderId: payment.orderId,
        paymentRecordId: payment.id,
        provider: payment.provider,
        reasonCode,
      },
      outcome,
      reasonCode,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }

  private async transitionOrderFromPaymentStatus(input: {
    readonly orderId: OrderId;
    readonly normalizedStatus: PaymentStatus;
    readonly correlationId: CorrelationId;
  }): Promise<void> {
    const latest = await this.options.orders.getOrder(input.orderId);
    if (!latest || latest.paymentStatus === "CAPTURED") {
      return;
    }
    if (input.normalizedStatus === "CAPTURED") {
      await this.options.orders.transitionPayment({
        correlationId: input.correlationId,
        expectedVersion: latest.recordVersion,
        orderId: latest.id,
        paymentStatus: "CAPTURED",
      });
      return;
    }
    if (
      input.normalizedStatus === "FAILED" &&
      latest.status === "AWAITING_PAYMENT"
    ) {
      await this.options.orders.transitionPayment({
        correlationId: input.correlationId,
        expectedVersion: latest.recordVersion,
        orderId: latest.id,
        paymentStatus: "FAILED",
      });
      return;
    }
    if (
      input.normalizedStatus === "CANCELLED" &&
      latest.status === "AWAITING_PAYMENT"
    ) {
      await this.options.orders.transitionPayment({
        correlationId: input.correlationId,
        expectedVersion: latest.recordVersion,
        orderId: latest.id,
        paymentStatus: "CANCELLED",
      });
    }
  }
}

const paymentInitializableOrderStates = new Set<KeyCoreOrder["status"]>([
  "CREATED",
  "AWAITING_PAYMENT",
]);

const createRetryablePaymentStatuses = new Set<PaymentStatus>([
  "CREATION_PENDING",
  "CREATE_OUTCOME_UNKNOWN",
]);

export const stripePaymentIntentIdempotencyKey = (
  orderIdValue: OrderId,
  operationVersion: number,
): string =>
  `keycore:payment-intent:create:${orderIdValue}:v${operationVersion}`;

export const stripePaymentMetadata = (input: {
  readonly orderId: OrderId;
  readonly paymentVersion: number;
}): Readonly<Record<string, string>> => ({
  keycore_order_id: input.orderId,
  keycore_payment_version: input.paymentVersion.toString(),
});

export const normalizeStripePaymentStatus = (
  status: StripePaymentIntentStatus,
): PaymentStatus => {
  switch (status) {
    case "succeeded":
      return "CAPTURED";
    case "processing":
      return "PROCESSING";
    case "requires_action":
      return "REQUIRES_CUSTOMER_ACTION";
    case "requires_confirmation":
    case "requires_payment_method":
      return "REQUIRES_PAYMENT_METHOD";
    case "requires_capture":
      return "AUTHORIZED";
    case "canceled":
      return "CANCELLED";
  }
};

export const stripePaymentIntentFingerprint = (
  intent: NormalizedStripePaymentIntent,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        amount: intent.amount.amountMinor.toString(),
        currency: intent.currency,
        id: intent.id,
        metadata: intent.metadata,
        status: intent.status,
      }),
    )
    .digest("hex");

export const stripeEventFingerprint = (event: VerifiedStripeEvent): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        eventId: event.id,
        paymentIntent: stripePaymentIntentFingerprint(event.paymentIntent),
        type: event.type,
      }),
    )
    .digest("hex");

export const paymentOutboxPayload = (input: {
  readonly orderId: OrderId;
  readonly paymentId: string;
  readonly reasonCode: PaymentReasonCode;
  readonly status: PaymentStatus;
  readonly correlationId: CorrelationId;
}): SafePayload => ({
  correlationId: input.correlationId,
  orderId: input.orderId,
  paymentId: input.paymentId,
  reasonCode: input.reasonCode,
  status: input.status,
});

export const validateStripeTestModeConfig = (input: {
  readonly environment: "TEST" | "LIVE";
  readonly secretKey?: string;
  readonly webhookSecret?: string;
}): void => {
  if (input.environment !== "TEST") {
    throw new Error("Stripe live mode is not enabled for KS-07-02");
  }
  if (input.secretKey && !input.secretKey.startsWith("sk_test_")) {
    throw new Error("Stripe test-mode secret key is required");
  }
  if (input.webhookSecret && !input.webhookSecret.startsWith("whsec_")) {
    throw new Error("Stripe webhook secret must use whsec_ format");
  }
};

const validateProviderEvidence = (
  order: KeyCoreOrder,
  payment: PaymentRecord,
  intent: NormalizedStripePaymentIntent,
): PaymentReasonCode | null => {
  if (payment.externalPaymentId && payment.externalPaymentId !== intent.id) {
    return "PAYMENT_ORDER_MISMATCH";
  }
  if (intent.amount.amountMinor !== order.customerAmount.amountMinor) {
    return "PAYMENT_AMOUNT_MISMATCH";
  }
  if (intent.currency !== order.currency) {
    return "PAYMENT_CURRENCY_MISMATCH";
  }
  if (intent.metadata.keycore_order_id !== order.id) {
    return "PAYMENT_ORDER_MISMATCH";
  }
  if (
    intent.metadata.keycore_payment_version !==
    payment.operationVersion.toString()
  ) {
    return "PAYMENT_ORDER_MISMATCH";
  }
  return null;
};

const reasonForStatus = (status: PaymentStatus): PaymentReasonCode => {
  switch (status) {
    case "CAPTURED":
      return "PAYMENT_CAPTURE_CONFIRMED";
    case "FAILED":
      return "PAYMENT_FAILED";
    case "CANCELLED":
      return "PAYMENT_CANCELLED";
    case "PROCESSING":
      return "PAYMENT_PROCESSING";
    case "RECONCILIATION_REQUIRED":
    case "CREATE_OUTCOME_UNKNOWN":
      return "PAYMENT_RECONCILIATION_REQUIRED";
    case "AUTHORIZED":
      return "PAYMENT_WEBHOOK_VERIFIED";
    default:
      return "PAYMENT_WEBHOOK_VERIFIED";
  }
};

const normalizeStripeWebhookPaymentStatus = (
  event: VerifiedStripeEvent,
): PaymentStatus => {
  switch (event.type) {
    case "payment_intent.succeeded":
      return "CAPTURED";
    case "payment_intent.processing":
      return "PROCESSING";
    case "payment_intent.canceled":
      return "CANCELLED";
    case "payment_intent.payment_failed":
      return "FAILED";
  }
};
