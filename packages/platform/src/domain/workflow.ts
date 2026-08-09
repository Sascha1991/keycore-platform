import type {
  IdempotencyKey,
  OrderId,
  OrderLineId,
  ProviderEventId,
  SupplierId,
} from "./identifiers.js";

export const paymentStates = [
  "CREATED",
  "AWAITING_PROVIDER",
  "AUTHORIZED",
  "CAPTURED",
  "FAILED",
  "CANCELED",
  "REFUND_PENDING",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "DISPUTED",
  "MANUAL_REVIEW",
] as const;

export type PaymentState = (typeof paymentStates)[number];

export const procurementStates = [
  "NOT_STARTED",
  "ELIGIBILITY_CHECKED",
  "PURCHASE_REQUESTED",
  "PURCHASE_CONFIRMED",
  "AMBIGUOUS_TIMEOUT",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "MANUAL_REVIEW",
] as const;

export type ProcurementState = (typeof procurementStates)[number];

export const fulfillmentStates = [
  "NOT_READY",
  "READY_FOR_KEY_RETRIEVAL",
  "KEY_RETRIEVED",
  "KEY_STORED",
  "CUSTOMER_NOTIFIED",
  "CUSTOMER_REVEALED",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "MANUAL_REVIEW",
] as const;

export type FulfillmentState = (typeof fulfillmentStates)[number];

export const refundStates = [
  "NOT_REQUESTED",
  "REQUESTED",
  "SUPPLIER_CLAIM_PENDING",
  "PAYMENT_REFUND_PENDING",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "REJECTED",
  "DISPUTED",
  "MANUAL_REVIEW",
] as const;

export type RefundState = (typeof refundStates)[number];

export interface IdempotencyRoot {
  readonly orderLineId: OrderLineId;
  readonly key: IdempotencyKey;
}

export interface ProviderEventReference {
  readonly providerEventId: ProviderEventId;
  readonly receivedAt: Date;
}

export interface PaymentRecord {
  readonly orderId: OrderId;
  readonly orderLineId: OrderLineId;
  readonly state: PaymentState;
  readonly idempotencyRoot: IdempotencyRoot;
  readonly providerEvent?: ProviderEventReference;
}

export interface ProcurementRecord {
  readonly orderLineId: OrderLineId;
  readonly supplierId: SupplierId;
  readonly state: ProcurementState;
  readonly idempotencyRoot: IdempotencyRoot;
  readonly supplierIdempotencyReference?: string;
}

export interface FulfillmentRecord {
  readonly orderLineId: OrderLineId;
  readonly state: FulfillmentState;
  readonly idempotencyRoot: IdempotencyRoot;
}

export interface RefundRecord {
  readonly orderLineId: OrderLineId;
  readonly state: RefundState;
  readonly idempotencyRoot: IdempotencyRoot;
  readonly providerEvent?: ProviderEventReference;
}

export interface ReconciliationRequest {
  readonly idempotencyRoot: IdempotencyRoot;
  readonly reason: "AMBIGUOUS_EXTERNAL_STATE" | "RETRYABLE_FAILURE";
  readonly requestedAt: Date;
}

export interface ReconciliationResult {
  readonly outcome: "RESOLVED" | "STILL_AMBIGUOUS" | "MANUAL_REVIEW_REQUIRED";
  readonly observedAt: Date;
  readonly reason?: string;
}
