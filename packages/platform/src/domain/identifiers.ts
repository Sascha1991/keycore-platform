import { brandString, type Brand } from "./brands.js";

export type SupplierId = Brand<string, "SupplierId">;
export type SupplierProductId = Brand<string, "SupplierProductId">;
export type SupplierOfferId = Brand<string, "SupplierOfferId">;
export type ProductId = Brand<string, "ProductId">;
export type OfferId = Brand<string, "OfferId">;
export type OrderId = Brand<string, "OrderId">;
export type OrderLineId = Brand<string, "OrderLineId">;
export type CustomerId = Brand<string, "CustomerId">;
export type CorrelationId = Brand<string, "CorrelationId">;
export type IdempotencyKey = Brand<string, "IdempotencyKey">;
export type ProviderEventId = Brand<string, "ProviderEventId">;
export type KeyRecordId = Brand<string, "KeyRecordId">;
export type JobId = Brand<string, "JobId">;

export const supplierId = (value: string): SupplierId =>
  brandString(value, "SupplierId");

export const supplierProductId = (value: string): SupplierProductId =>
  brandString(value, "SupplierProductId");

export const supplierOfferId = (value: string): SupplierOfferId =>
  brandString(value, "SupplierOfferId");

export const productId = (value: string): ProductId =>
  brandString(value, "ProductId");

export const offerId = (value: string): OfferId =>
  brandString(value, "OfferId");

export const orderId = (value: string): OrderId =>
  brandString(value, "OrderId");

export const orderLineId = (value: string): OrderLineId =>
  brandString(value, "OrderLineId");

export const customerId = (value: string): CustomerId =>
  brandString(value, "CustomerId");

export const correlationId = (value: string): CorrelationId =>
  brandString(value, "CorrelationId");

export const idempotencyKey = (value: string): IdempotencyKey =>
  brandString(value, "IdempotencyKey");

export const providerEventId = (value: string): ProviderEventId =>
  brandString(value, "ProviderEventId");

export const keyRecordId = (value: string): KeyRecordId =>
  brandString(value, "KeyRecordId");

export const jobId = (value: string): JobId => brandString(value, "JobId");
