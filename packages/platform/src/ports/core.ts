import type {
  OfferSummary,
  PriceSnapshot,
  ProductSummary,
} from "../domain/catalog.js";
import type { AuditEvent } from "../domain/audit.js";
import type {
  CorrelationId,
  CustomerId,
  JobId,
  KeyRecordId,
  OfferId,
  OrderId,
  OrderLineId,
  ProductId,
} from "../domain/identifiers.js";
import type { Money } from "../domain/money.js";
import type {
  GermanyCompatibilityDecision,
  RegionCompatibilityAssessment,
  RegionEvidence,
} from "../domain/region.js";
import type {
  FulfillmentRecord,
  PaymentRecord,
  ProcurementRecord,
  ReconciliationRequest,
  ReconciliationResult,
  RefundRecord,
} from "../domain/workflow.js";

export interface CatalogPort {
  findProduct(productId: ProductId): Promise<ProductSummary | null>;
  findOffer(offerId: OfferId): Promise<OfferSummary | null>;
}

export interface ProductPort {
  describeProduct(productId: ProductId): Promise<ProductSummary | null>;
}

export interface OfferPort {
  describeOffer(offerId: OfferId): Promise<OfferSummary | null>;
}

export interface RegionCompatibilityPort {
  assess(evidence: RegionEvidence): Promise<RegionCompatibilityAssessment>;
  defaultDecisionForUnknownEvidence(): GermanyCompatibilityDecision;
}

export interface PricingPort {
  snapshotPrice(offerId: OfferId): Promise<PriceSnapshot>;
  quotePrice(offerId: OfferId, correlationId: CorrelationId): Promise<Money>;
}

export interface PaymentPort {
  recordProviderEvent(record: PaymentRecord): Promise<void>;
  getPayment(orderLineId: OrderLineId): Promise<PaymentRecord | null>;
}

export interface ProcurementPort {
  recordProcurement(record: ProcurementRecord): Promise<void>;
  requestReconciliation(
    request: ReconciliationRequest,
  ): Promise<ReconciliationResult>;
}

export interface FulfillmentPort {
  recordFulfillment(record: FulfillmentRecord): Promise<void>;
  getFulfillment(orderLineId: OrderLineId): Promise<FulfillmentRecord | null>;
}

export interface RefundPort {
  recordRefund(record: RefundRecord): Promise<void>;
  getRefund(orderLineId: OrderLineId): Promise<RefundRecord | null>;
}

export interface AuthorizedKeyRetrievalContext {
  readonly customerId: CustomerId;
  readonly orderLineId: OrderLineId;
  readonly correlationId: CorrelationId;
}

export interface ProductKeyVaultPort {
  storeReceivedKey(request: {
    readonly orderLineId: OrderLineId;
    readonly correlationId: CorrelationId;
    readonly receivedSecretMaterial: Uint8Array;
  }): Promise<KeyRecordId>;
  retrieveForAuthorizedReveal(
    context: AuthorizedKeyRetrievalContext,
  ): Promise<Uint8Array>;
  rotateKeyEncryptionMetadata(keyRecordId: KeyRecordId): Promise<void>;
  retireKey(
    keyRecordId: KeyRecordId,
    correlationId: CorrelationId,
  ): Promise<void>;
}

export interface AuditEventPort {
  append(event: AuditEvent): Promise<void>;
}

export interface QueueJob<TPayload extends object> {
  readonly jobId: JobId;
  readonly type: string;
  readonly payload: TPayload;
  readonly correlationId: CorrelationId;
}

export interface QueuePort {
  enqueue<TPayload extends object>(job: QueueJob<TPayload>): Promise<void>;
}

export interface PersistencePort<TEntity, TId> {
  findById(id: TId): Promise<TEntity | null>;
  save(entity: TEntity): Promise<void>;
}

export interface StorefrontGatewayPort {
  publishProduct(product: ProductSummary): Promise<void>;
  updateProduct(product: ProductSummary): Promise<void>;
  unpublishOffer(offerId: OfferId, correlationId: CorrelationId): Promise<void>;
  findOrder(orderId: OrderId): Promise<unknown | null>;
  mapCustomerIdentity(customerId: CustomerId): Promise<unknown | null>;
  projectOrderStatus(orderLineId: OrderLineId): Promise<void>;
  projectCustomerKeyAvailability(orderLineId: OrderLineId): Promise<void>;
  projectInvoiceAvailability(orderLineId: OrderLineId): Promise<void>;
}

export interface MailPort {
  sendTransactionalMessage(request: {
    readonly recipientCustomerId: CustomerId;
    readonly template: string;
    readonly correlationId: CorrelationId;
  }): Promise<void>;
}

export interface InvoicePort {
  requestInvoiceForOrderLine(
    orderLineId: OrderLineId,
    correlationId: CorrelationId,
  ): Promise<void>;
}

export interface HealthStatus {
  readonly component: string;
  readonly status: "HEALTHY" | "DEGRADED" | "OUTAGE" | "UNKNOWN";
  readonly checkedAt: Date;
}

export interface MonitoringPort {
  reportHealth(status: HealthStatus): Promise<void>;
}

export interface SecretKeyManagementPort {
  getActiveMasterKeyReference(): Promise<string>;
  getRotationMetadata(keyRecordId: KeyRecordId): Promise<unknown>;
}

export interface ClockPort {
  now(): Date;
}
