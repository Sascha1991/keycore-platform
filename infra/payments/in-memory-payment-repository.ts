import { randomUUID } from "node:crypto";

import {
  money,
  type KeyCoreOrder,
  type OrderId,
} from "../../packages/platform/src/contracts.js";
import type {
  PaymentProvider,
  PaymentCreationLeaseResult,
  PaymentRecord,
  PaymentRepository,
  PaymentReservationResult,
  PaymentStatus,
  PaymentUpdateResult,
} from "../../packages/platform/src/payments/stripe-payments.js";

export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly payments = new Map<string, PaymentRecord>();
  private readonly byOrderProvider = new Map<string, string>();
  private readonly byExternal = new Map<string, string>();

  public async reserveForOrder(input: {
    readonly order: KeyCoreOrder;
    readonly stripeIdempotencyKey: string;
    readonly now: Date;
  }): Promise<PaymentReservationResult> {
    const existingId = this.byOrderProvider.get(
      orderProviderKey(input.order.id, "STRIPE"),
    );
    if (existingId) {
      const existing = this.payments.get(existingId);
      if (!existing) {
        throw new Error("Payment order/provider index is corrupt");
      }
      return { payment: existing, status: "EXISTING" };
    }
    const payment: PaymentRecord = {
      amount: money(
        input.order.customerAmount.amountMinor,
        input.order.currency,
      ),
      createdAt: input.now,
      currency: input.order.currency,
      id: randomUUID(),
      operationVersion: 1,
      orderId: input.order.id,
      provider: "STRIPE",
      reconciliationRequired: false,
      recordVersion: 1,
      status: "CREATION_PENDING",
      stripeIdempotencyKey: input.stripeIdempotencyKey,
      updatedAt: input.now,
    };
    this.payments.set(payment.id, payment);
    this.byOrderProvider.set(
      orderProviderKey(payment.orderId, payment.provider),
      payment.id,
    );
    return { payment, status: "CREATED" };
  }

  public async findByOrder(input: {
    readonly orderId: OrderId;
    readonly provider: PaymentProvider;
  }): Promise<PaymentRecord | null> {
    const id = this.byOrderProvider.get(
      orderProviderKey(input.orderId, input.provider),
    );
    return id ? (this.payments.get(id) ?? null) : null;
  }

  public async findByExternalPaymentId(input: {
    readonly provider: PaymentProvider;
    readonly externalPaymentId: string;
  }): Promise<PaymentRecord | null> {
    const id = this.byExternal.get(
      externalKey(input.provider, input.externalPaymentId),
    );
    return id ? (this.payments.get(id) ?? null) : null;
  }

  public async acquireCreateLease(input: {
    readonly paymentId: string;
    readonly leaseToken: string;
    readonly staleAfter: Date;
    readonly now: Date;
  }): Promise<PaymentCreationLeaseResult> {
    const current = this.payments.get(input.paymentId);
    if (!current) {
      throw new Error("Payment not found");
    }
    if (!isCreateLeaseEligible(current)) {
      return { payment: current, status: "NOT_ELIGIBLE" };
    }
    if (
      current.createAttemptToken &&
      current.createAttemptStartedAt &&
      current.createAttemptStartedAt > input.staleAfter
    ) {
      return { payment: current, status: "IN_FLIGHT" };
    }
    const updated: PaymentRecord = {
      ...current,
      createAttemptStartedAt: input.now,
      createAttemptToken: input.leaseToken,
      recordVersion: current.recordVersion + 1,
      updatedAt: input.now,
    };
    this.payments.set(updated.id, updated);
    return {
      leaseToken: input.leaseToken,
      payment: updated,
      status: "ACQUIRED",
    };
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
    const current = this.payments.get(input.paymentId);
    if (!current || current.createAttemptToken !== input.leaseToken) {
      return { payment: current ?? null, status: "CONFLICT" };
    }
    const externalPaymentOwner = this.byExternal.get(
      externalKey(current.provider, input.externalPaymentId),
    );
    if (externalPaymentOwner && externalPaymentOwner !== current.id) {
      return { payment: current, status: "CONFLICT" };
    }
    const updated = updatePayment(current, {
      clearCreateAttempt: true,
      externalPaymentId: input.externalPaymentId,
      lastProviderEventAt: input.lastProviderEventAt,
      now: input.now,
      providerFingerprint: input.providerFingerprint,
      reconciliationRequired: false,
      status: input.status,
    });
    this.payments.set(updated.id, updated);
    this.byExternal.set(
      externalKey(updated.provider, input.externalPaymentId),
      updated.id,
    );
    return { payment: updated, status: "UPDATED" };
  }

  public async updateFromProvider(input: {
    readonly paymentId: string;
    readonly expectedVersion: number;
    readonly providerFingerprint: string;
    readonly status: PaymentStatus;
    readonly lastProviderEventAt: Date;
    readonly reconciliationRequired: boolean;
    readonly now: Date;
  }): Promise<PaymentUpdateResult> {
    const current = this.payments.get(input.paymentId);
    if (!current || current.recordVersion !== input.expectedVersion) {
      return { payment: current ?? null, status: "CONFLICT" };
    }
    if (isNonRegressingNoop(current, input.status, input.lastProviderEventAt)) {
      return { payment: current, status: "NOOP" };
    }
    const updated = updatePayment(current, {
      lastProviderEventAt: input.lastProviderEventAt,
      now: input.now,
      providerFingerprint: input.providerFingerprint,
      reconciliationRequired: input.reconciliationRequired,
      status: input.status,
    });
    this.payments.set(updated.id, updated);
    return { payment: updated, status: "UPDATED" };
  }

  public async markCreateOutcomeUnknown(input: {
    readonly paymentId: string;
    readonly leaseToken: string;
    readonly now: Date;
  }): Promise<PaymentUpdateResult> {
    const current = this.payments.get(input.paymentId);
    if (!current || current.createAttemptToken !== input.leaseToken) {
      return { payment: current ?? null, status: "CONFLICT" };
    }
    const updated = updatePayment(current, {
      clearCreateAttempt: true,
      now: input.now,
      providerFingerprint: current.providerFingerprint ?? null,
      reconciliationRequired: true,
      status: "CREATE_OUTCOME_UNKNOWN",
    });
    this.payments.set(updated.id, updated);
    return { payment: updated, status: "UPDATED" };
  }

  public async markCreateRejected(input: {
    readonly paymentId: string;
    readonly leaseToken: string;
    readonly providerFingerprint: string;
    readonly now: Date;
  }): Promise<PaymentUpdateResult> {
    const current = this.payments.get(input.paymentId);
    if (!current || current.createAttemptToken !== input.leaseToken) {
      return { payment: current ?? null, status: "CONFLICT" };
    }
    const updated = updatePayment(current, {
      clearCreateAttempt: true,
      now: input.now,
      providerFingerprint: input.providerFingerprint,
      reconciliationRequired: false,
      status: "FAILED",
    });
    this.payments.set(updated.id, updated);
    return { payment: updated, status: "UPDATED" };
  }

  public async markReconciliationRequired(input: {
    readonly paymentId: string;
    readonly expectedVersion: number;
    readonly providerFingerprint?: string;
    readonly now: Date;
  }): Promise<PaymentUpdateResult> {
    const current = this.payments.get(input.paymentId);
    if (!current || current.recordVersion !== input.expectedVersion) {
      return { payment: current ?? null, status: "CONFLICT" };
    }
    const updated = updatePayment(current, {
      clearCreateAttempt: true,
      now: input.now,
      providerFingerprint:
        input.providerFingerprint ?? current.providerFingerprint ?? null,
      reconciliationRequired: true,
      status: "RECONCILIATION_REQUIRED",
    });
    this.payments.set(updated.id, updated);
    return { payment: updated, status: "UPDATED" };
  }
}

const orderProviderKey = (
  orderId: OrderId,
  provider: PaymentProvider,
): string => `${provider}:${orderId}`;

const externalKey = (
  provider: PaymentProvider,
  externalPaymentId: string,
): string => `${provider}:${externalPaymentId}`;

const updatePayment = (
  current: PaymentRecord,
  input: {
    readonly now: Date;
    readonly status: PaymentStatus;
    readonly providerFingerprint?: string | null;
    readonly reconciliationRequired: boolean;
    readonly externalPaymentId?: string;
    readonly lastProviderEventAt?: Date;
    readonly clearCreateAttempt?: boolean;
  },
): PaymentRecord => ({
  ...current,
  createAttemptStartedAt: input.clearCreateAttempt
    ? null
    : (current.createAttemptStartedAt ?? null),
  createAttemptToken: input.clearCreateAttempt
    ? null
    : (current.createAttemptToken ?? null),
  ...(input.externalPaymentId
    ? { externalPaymentId: input.externalPaymentId }
    : {}),
  lastProviderEventAt:
    input.lastProviderEventAt ?? current.lastProviderEventAt ?? null,
  providerFingerprint:
    input.providerFingerprint ?? current.providerFingerprint ?? null,
  reconciliationRequired: input.reconciliationRequired,
  recordVersion: current.recordVersion + 1,
  status: input.status,
  updatedAt: input.now,
});

const isCreateLeaseEligible = (payment: PaymentRecord): boolean =>
  !payment.externalPaymentId &&
  (payment.status === "CREATION_PENDING" ||
    payment.status === "CREATE_OUTCOME_UNKNOWN");

const isNonRegressingNoop = (
  current: PaymentRecord,
  nextStatus: PaymentStatus,
  providerEventAt: Date,
): boolean =>
  current.status === "CAPTURED" && nextStatus !== "CAPTURED"
    ? true
    : Boolean(
        current.lastProviderEventAt &&
        current.lastProviderEventAt.getTime() > providerEventAt.getTime(),
      );
