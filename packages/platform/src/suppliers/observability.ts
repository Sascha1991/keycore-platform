import type { CorrelationId, SupplierId } from "../domain/identifiers.js";
import type { SupplierHealth } from "../ports/supplier.js";

export const supplierObservabilityEventTypes = [
  "SUPPLIER_REQUEST_STARTED",
  "SUPPLIER_REQUEST_COMPLETED",
  "SUPPLIER_REQUEST_FAILED",
  "SUPPLIER_RATE_LIMITED",
  "SUPPLIER_HEALTH_STATE",
  "SUPPLIER_PURCHASE_SUBMITTED",
  "SUPPLIER_RECONCILIATION_ATTEMPTED",
  "SUPPLIER_ROUTING_EVALUATION_STARTED",
  "SUPPLIER_CANDIDATE_OBTAINED",
  "SUPPLIER_CANDIDATE_REJECTED",
  "SUPPLIER_CANDIDATE_SELECTED",
  "SUPPLIER_NO_CANDIDATE_AVAILABLE",
  "SUPPLIER_FALLBACK_PLAN_CREATED",
  "SUPPLIER_RECONCILIATION_REQUIRED_BEFORE_FALLBACK",
] as const;

export type SupplierObservabilityEventType =
  (typeof supplierObservabilityEventTypes)[number];

export interface SupplierObservabilityEvent {
  readonly type: SupplierObservabilityEventType;
  readonly supplierId: SupplierId;
  readonly operation: string;
  readonly occurredAt: Date;
  readonly correlationId?: CorrelationId;
  readonly status?: SupplierHealth["status"];
  readonly classification?: string;
  readonly safeReference?: string;
}

export interface SupplierObservabilityPort {
  record(event: SupplierObservabilityEvent): void;
}
