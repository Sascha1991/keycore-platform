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
