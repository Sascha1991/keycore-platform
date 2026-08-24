import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  GermanyEligibilityEngine,
  StaticRegionSemanticRegistry,
  germanyEligibilityPolicyVersion,
  type GermanyEligibilityAssessment,
  type RegionSemantic,
} from "../../../packages/platform/src/catalog/germany-eligibility.js";
import {
  SupplierError,
  correlationId,
  currency,
  supplierId,
  type AuditEvent,
  type AuditEventPort,
  type CorrelationId,
  type Money,
  type NormalizedSupplierOffer,
  type SupplierOfferId,
  type SupplierProductId,
} from "../../../packages/platform/src/contracts.js";
import { EnvSecretProvider } from "./kinguin-live-readonly.js";
import { KinguinLiveReadonlyGuardedTransport } from "./kinguin-live-readonly.js";
import {
  FetchKinguinHttpTransport,
  InMemoryKinguinOfferProductIndex,
  KinguinHttpClient,
  KinguinSupplier,
  createKinguinConfigFromEnv,
  type KinguinConfig,
  type KinguinHttpRequest,
  type KinguinHttpResponse,
  type KinguinHttpTransport,
} from "./kinguin-supplier.js";

type JsonValue =
  | boolean
  | number
  | string
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ControlledProcurementStatus =
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "CONSUMED"
  | "EXPIRED"
  | "CANCELLED"
  | "PROCUREMENT_CONFIRMED"
  | "PROCUREMENT_REJECTED"
  | "AMBIGUOUS"
  | "MANUAL_REVIEW_REQUIRED";

export type ControlledProcurementDispatchState =
  | "NOT_DISPATCHED"
  | "CLAIMED"
  | "DISPATCH_STARTED"
  | "DISPATCH_CONFIRMED"
  | "DISPATCH_REJECTED"
  | "DISPATCH_AMBIGUOUS";

export type ControlledProcurementAuditEvent =
  | "CONTROLLED_PROCUREMENT_PREPARED"
  | "CONTROLLED_PROCUREMENT_APPROVED"
  | "CONTROLLED_PROCUREMENT_CLAIMED"
  | "CONTROLLED_PROCUREMENT_DISPATCH_STARTED"
  | "CONTROLLED_PROCUREMENT_CONFIRMED"
  | "CONTROLLED_PROCUREMENT_REJECTED"
  | "CONTROLLED_PROCUREMENT_AMBIGUOUS"
  | "CONTROLLED_PROCUREMENT_RECONCILIATION_REQUESTED"
  | "CONTROLLED_PROCUREMENT_MANUAL_REVIEW_REQUIRED";

export type ControlledProcurementSupplierErrorCategory =
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "VALIDATION"
  | "INSUFFICIENT_BALANCE"
  | "PRODUCT_UNAVAILABLE"
  | "OFFER_UNAVAILABLE"
  | "PRICE_MISMATCH"
  | "DUPLICATE_REFERENCE"
  | "RATE_LIMIT"
  | "SUPPLIER_REJECTION"
  | "UNKNOWN";

export interface ControlledProcurementRejectionDiagnostic {
  readonly supplier: "Kinguin";
  readonly supplierHttpStatus: number | null;
  readonly supplierErrorCode: string | null;
  readonly supplierErrorCategory: ControlledProcurementSupplierErrorCategory;
  readonly safeReasonCode: string;
}

export interface ControlledProcurementApproval {
  readonly approvalId: string;
  readonly mode: "CONTROLLED_VERIFICATION";
  readonly supplierId: "kinguin";
  readonly supplierProductId: SupplierProductId;
  readonly supplierOfferId: SupplierOfferId;
  readonly productTitle?: string;
  readonly quantity: 1;
  readonly maximumAcquisitionAmount: Money;
  readonly currentAcquisitionAmount: Money;
  readonly purchaseRequestFingerprint: string;
  readonly orderExternalId: string;
  readonly tokenHash: string;
  readonly status: ControlledProcurementStatus;
  readonly dispatchState: ControlledProcurementDispatchState;
  readonly externalSupplierOrderId?: string | null;
  readonly supplierStatus?: string | null;
  readonly responseFingerprint?: string | null;
  readonly failureReasonCode?: string | null;
  readonly rejectionDiagnostic?: ControlledProcurementRejectionDiagnostic | null;
  readonly expiresAt: Date;
  readonly consumedAt?: Date | null;
  readonly claimedAt?: Date | null;
  readonly dispatchStartedAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly recordVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ControlledClaimResult =
  | {
      readonly status: "CLAIMED";
      readonly approval: ControlledProcurementApproval;
    }
  | {
      readonly status:
        | "APPROVAL_NOT_FOUND"
        | "APPROVAL_EXPIRED"
        | "APPROVAL_CANCELLED"
        | "APPROVAL_ALREADY_CONSUMED"
        | "TOKEN_INVALID";
      readonly approval?: ControlledProcurementApproval;
    };

export interface ControlledProcurementApprovalRepository {
  create(
    input: ControlledProcurementApproval,
  ): Promise<ControlledProcurementApproval>;
  findById(approvalId: string): Promise<ControlledProcurementApproval | null>;
  cancel(input: {
    readonly approvalId: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null>;
  claim(input: {
    readonly approvalId: string;
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<ControlledClaimResult>;
  markDispatchStarted(input: {
    readonly approvalId: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null>;
  markConfirmed(input: {
    readonly approvalId: string;
    readonly externalSupplierOrderId: string;
    readonly source?: "RECONCILIATION";
    readonly supplierStatus: string;
    readonly responseFingerprint: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null>;
  markRejected(input: {
    readonly approvalId: string;
    readonly reasonCode: string;
    readonly diagnostic?: ControlledProcurementRejectionDiagnostic;
    readonly responseFingerprint?: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null>;
  markAmbiguous(input: {
    readonly approvalId: string;
    readonly reasonCode: string;
    readonly externalSupplierOrderId?: string;
    readonly responseFingerprint?: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null>;
  markManualReview(input: {
    readonly approvalId: string;
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null>;
}

export interface ControlledLiveProcurementConfig {
  readonly approvalTtlMs: number;
  readonly orderTimeoutMs: number;
  readonly baseUrl: string;
  readonly environment: KinguinConfig["environment"];
  readonly apiKeyPresent: boolean;
  readonly readonlyOptIn: boolean;
  readonly productionPurchasingEnabled: boolean;
}

export interface ControlledPurchaseRequest {
  readonly orderExternalId: string;
  readonly payload: JsonValue;
  readonly fingerprint: string;
  readonly amount: Money;
}

export interface ControlledPrepareResult {
  readonly status: "PREPARED";
  readonly approvalId: string;
  readonly supplier: "Kinguin";
  readonly supplierProductId: SupplierProductId;
  readonly supplierOfferId: SupplierOfferId;
  readonly productTitle?: string;
  readonly quantity: 1;
  readonly currentAcquisitionAmountMinor: string;
  readonly maximumAcquisitionAmountMinor: string;
  readonly currency: string;
  readonly orderExternalId: string;
  readonly requestFingerprint: string;
  readonly expiresAt: string;
  readonly oneTimeExecutionToken: string;
  readonly purchaseMutation: "NOT_SENT";
  readonly message: "NO PURCHASE HAS BEEN SENT.";
}

export interface ControlledCandidate {
  readonly supplierProductId: SupplierProductId;
  readonly supplierOfferId: SupplierOfferId;
  readonly productTitle: string;
  readonly currentAcquisitionAmountMinor: string;
  readonly currency: string;
  readonly availability: string;
  readonly germanyEligibilityReasonCode: string;
}

export interface ControlledCandidateListResult {
  readonly status: "SUCCEEDED";
  readonly pagesInspected: number;
  readonly productRecordsInspected: number;
  readonly eligibleCandidatesFound: number;
  readonly searchStoppedBecause:
    "MAX_CANDIDATES" | "END_OF_RESULTS" | "MAX_PAGES";
  readonly candidates: readonly ControlledCandidate[];
  readonly endpointsTested: readonly string[];
  readonly mutationRequestCount: 0;
}

export interface ControlledExecuteResult {
  readonly approvalId: string;
  readonly status:
    "PROCUREMENT_CONFIRMED" | "PROCUREMENT_REJECTED" | "AMBIGUOUS" | "BLOCKED";
  readonly reasonCode: string;
  readonly supplier: "Kinguin";
  readonly orderExternalId?: string;
  readonly externalSupplierOrderId?: string;
  readonly dispatchState?: ControlledProcurementDispatchState;
  readonly reconciliationRequired: boolean;
  readonly supplierHttpStatus?: number | null;
  readonly supplierErrorCode?: string | null;
  readonly supplierErrorCategory?: ControlledProcurementSupplierErrorCategory;
  readonly safeReasonCode?: string;
}

export interface ControlledReconcileResult {
  readonly approvalId: string;
  readonly status:
    | "CONFIRMED_SUCCESS"
    | "CONFIRMED_REJECTION"
    | "PENDING"
    | "AMBIGUOUS"
    | "MANUAL_REVIEW_REQUIRED";
  readonly supplier: "Kinguin";
  readonly orderExternalId: string;
  readonly externalSupplierOrderId?: string;
  readonly supplierHttpStatus?: number | null;
  readonly supplierErrorCode?: string | null;
  readonly supplierErrorCategory?: ControlledProcurementSupplierErrorCategory;
  readonly safeReasonCode?: string;
}

const supplier = supplierId("kinguin");
const allowedProductionBaseUrl = "https://gateway.kinguin.net/esa/api";
const allowedProductionProtocol = "https:";
const allowedProductionHost = "gateway.kinguin.net";
const allowedProductionBasePath = "/esa/api";
const operationVersion = "KINGUIN_CONTROLLED_LIVE_ORDER_V1";
const defaultApprovalTtlMs = 5 * 60 * 1_000;
const defaultOrderTimeoutMs = 10_000;
const defaultCandidatePageSize = 20;
const defaultCandidateMaxPages = 10;
const defaultCandidateMaxCandidates = 10;
const candidatePageSizeCap = 20;
const candidateMaxPagesCap = 25;
const candidateMaxCandidatesCap = 20;

export const controlledLiveConfigFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): ControlledLiveProcurementConfig => {
  const config = createKinguinConfigFromEnv(env);
  const ttl = positiveIntegerEnv(env.KINGUIN_CONTROLLED_APPROVAL_TTL_MS);
  const timeout = positiveIntegerEnv(env.KINGUIN_CONTROLLED_ORDER_TIMEOUT_MS);
  return {
    apiKeyPresent: Boolean(env.KINGUIN_API_KEY),
    approvalTtlMs: ttl ?? defaultApprovalTtlMs,
    baseUrl: config.baseUrl,
    environment: config.environment,
    orderTimeoutMs: timeout ?? defaultOrderTimeoutMs,
    productionPurchasingEnabled:
      env.KEYCORE_KINGUIN_CONTROLLED_MUTATION_MODE ===
      "CONTROLLED_VERIFICATION_ONE_TIME",
    readonlyOptIn: env.KEYCORE_ALLOW_KINGUIN_LIVE_READONLY === "true",
  };
};

export const validateControlledReadOnlyConfig = (
  env: Readonly<Record<string, string | undefined>>,
): KinguinConfig => {
  const config = createKinguinConfigFromEnv(env);
  const controlled = controlledLiveConfigFromEnv(env);
  if (!controlled.readonlyOptIn) {
    throw controlledError("READONLY_OPT_IN_REQUIRED");
  }
  if (config.environment !== "PRODUCTION") {
    throw controlledError("PRODUCTION_ENVIRONMENT_REQUIRED");
  }
  if (config.baseUrl !== allowedProductionBaseUrl) {
    throw controlledError("EXACT_KINGUIN_BASE_URL_REQUIRED");
  }
  if (!controlled.apiKeyPresent) {
    throw controlledError("KINGUIN_API_KEY_REQUIRED");
  }
  return config;
};

export const validateControlledMutationConfig = (
  env: Readonly<Record<string, string | undefined>>,
): KinguinConfig => {
  const config = validateControlledReadOnlyConfig(env);
  const controlled = controlledLiveConfigFromEnv(env);
  if (!controlled.productionPurchasingEnabled) {
    throw controlledError("CONTROLLED_MUTATION_MODE_REQUIRED");
  }
  return { ...config, timeoutMs: controlled.orderTimeoutMs };
};

export class KinguinControlledOrderTransport {
  public mutationRequestCount = 0;
  public forbiddenRequestCount = 0;

  public constructor(
    private readonly options: {
      readonly baseUrl: string;
      readonly delegate: KinguinHttpTransport;
    },
  ) {}

  public async createOrder(
    request: KinguinHttpRequest,
  ): Promise<KinguinHttpResponse> {
    this.assertAllowed(request);
    this.mutationRequestCount += 1;
    const response = await this.options.delegate.send(request);
    if (response.status >= 300 && response.status < 400) {
      throw controlledError("POST_REDIRECT_NOT_FOLLOWED");
    }
    if (response.status >= 400 && response.status < 500) {
      throw new ControlledKinguinOrderRejectionError(
        normalizeKinguinOrderRejection(response),
      );
    }
    return response;
  }

  private assertAllowed(request: KinguinHttpRequest): void {
    const url = new URL(request.path);
    const base = new URL(this.options.baseUrl);
    const basePath = base.pathname.replace(/\/$/u, "");
    const apiPath =
      url.pathname === basePath
        ? "/"
        : url.pathname.startsWith(`${basePath}/`)
          ? url.pathname.slice(basePath.length)
          : "";
    if (
      request.method !== "POST" ||
      base.protocol !== allowedProductionProtocol ||
      base.hostname !== allowedProductionHost ||
      basePath !== allowedProductionBasePath ||
      url.protocol !== allowedProductionProtocol ||
      url.hostname !== allowedProductionHost ||
      apiPath !== "/v2/order" ||
      url.search !== ""
    ) {
      this.forbiddenRequestCount += 1;
      throw controlledError("CONTROLLED_ORDER_ENDPOINT_BLOCKED");
    }
  }
}

export class ControlledKinguinOrderRejectionError extends SupplierError {
  public constructor(
    public readonly diagnostic: ControlledProcurementRejectionDiagnostic,
  ) {
    super({
      category: "REJECTED",
      operation: diagnostic.safeReasonCode,
      supplierId: supplier,
    });
  }
}

export class ControlledLiveProcurementService {
  private readonly now: () => Date;

  public constructor(
    private readonly options: {
      readonly repository: ControlledProcurementApprovalRepository;
      readonly readOnlySupplier: KinguinSupplier;
      readonly offerIndex: InMemoryKinguinOfferProductIndex;
      readonly config: ControlledLiveProcurementConfig;
      readonly orderTransport?: KinguinControlledOrderTransport;
      readonly orderClient?: KinguinHttpClient;
      readonly audit?: AuditEventPort;
      readonly environment?: AuditEvent["environment"];
      readonly now?: () => Date;
    },
  ) {
    if (options.config.approvalTtlMs <= 0) {
      throw new Error("Controlled approval TTL must be positive");
    }
    if (options.config.orderTimeoutMs <= 0) {
      throw new Error("Controlled order timeout must be positive");
    }
    this.now = options.now ?? (() => new Date());
  }

  public async listCandidates(input: {
    readonly pageSize?: number;
    readonly maxPages?: number;
    readonly maxCandidates?: number;
    readonly startPage?: number;
  }): Promise<ControlledCandidateListResult> {
    const pageSize = boundedPositiveInteger(
      input.pageSize,
      defaultCandidatePageSize,
      candidatePageSizeCap,
      "INVALID_CANDIDATE_PAGE_SIZE",
    );
    const maxPages = boundedPositiveInteger(
      input.maxPages,
      defaultCandidateMaxPages,
      candidateMaxPagesCap,
      "INVALID_CANDIDATE_MAX_PAGES",
    );
    const maxCandidates = boundedPositiveInteger(
      input.maxCandidates,
      defaultCandidateMaxCandidates,
      candidateMaxCandidatesCap,
      "INVALID_CANDIDATE_MAX_CANDIDATES",
    );
    const startPage = boundedPositiveInteger(
      input.startPage,
      1,
      Number.MAX_SAFE_INTEGER,
      "INVALID_CANDIDATE_START_PAGE",
    );
    const candidates: ControlledCandidate[] = [];
    const seenCandidates = new Set<string>();
    const endpoints = new Set<string>();
    const registry = new StaticRegionSemanticRegistry();
    const engine = new GermanyEligibilityEngine({ regionSemantics: registry });
    let pagesInspected = 0;
    let productRecordsInspected = 0;
    let searchStoppedBecause: ControlledCandidateListResult["searchStoppedBecause"] =
      "MAX_PAGES";
    for (let offset = 0; offset < maxPages; offset += 1) {
      const pageNumber = startPage + offset;
      const page = await this.options.readOnlySupplier.searchProducts({
        limit: pageSize,
        page: pageNumber,
      });
      pagesInspected += 1;
      endpoints.add(`GET /v1/products?page=${pageNumber}&limit=${pageSize}`);
      for (const listedProduct of page.items) {
        productRecordsInspected += 1;
        const detailedProduct =
          await this.options.readOnlySupplier.getProductWithOffers(
            listedProduct.supplierProductId,
          );
        if (!detailedProduct) {
          continue;
        }
        endpoints.add(`GET /v2/products/${listedProduct.supplierProductId}`);
        const product = detailedProduct.product;
        const offers = detailedProduct.offers;
        for (const offer of offers) {
          const mapped = await this.options.offerIndex.resolveProductForOffer(
            offer.supplierOfferId,
          );
          if (mapped && mapped !== offer.supplierProductId) {
            continue;
          }
          if (offer.regionEvidence.supplierRegion) {
            registry.set({
              semantic: semanticForControlledRegionText(
                offer.regionEvidence.supplierRegion.documentedSemanticsSummary,
              ),
              supplierId: supplier,
              supplierRegionId:
                offer.regionEvidence.supplierRegion.supplierRegionId,
            });
          }
          const eligibility = engine.evaluate({
            evidence: offer.regionEvidence,
            supplierId: supplier,
          });
          const candidateKey = [
            supplier,
            offer.supplierProductId,
            offer.supplierOfferId,
          ].join("|");
          if (
            eligibility.decision === "ALLOWED" &&
            offer.offer.availability !== "OUT_OF_STOCK" &&
            offer.offer.availability !== "UNKNOWN" &&
            offer.offer.currentPrice.currency === currency("EUR") &&
            offer.offer.currentPrice.amountMinor > 0n &&
            !seenCandidates.has(candidateKey)
          ) {
            seenCandidates.add(candidateKey);
            candidates.push({
              availability: offer.offer.availability,
              currency: offer.offer.currentPrice.currency,
              currentAcquisitionAmountMinor:
                offer.offer.currentPrice.amountMinor.toString(),
              germanyEligibilityReasonCode: eligibility.reasonCode,
              productTitle: product.product.title,
              supplierOfferId: offer.supplierOfferId,
              supplierProductId: offer.supplierProductId,
            });
            if (candidates.length >= maxCandidates) {
              searchStoppedBecause = "MAX_CANDIDATES";
              break;
            }
          }
        }
        if (candidates.length >= maxCandidates) {
          break;
        }
      }
      if (candidates.length >= maxCandidates) {
        break;
      }
      if (page.items.length === 0 || !page.nextCursor) {
        searchStoppedBecause = "END_OF_RESULTS";
        break;
      }
    }
    return {
      candidates: candidates.sort(compareControlledCandidates),
      eligibleCandidatesFound: candidates.length,
      endpointsTested: [...endpoints],
      mutationRequestCount: 0,
      pagesInspected,
      productRecordsInspected,
      searchStoppedBecause,
      status: "SUCCEEDED",
    };
  }

  public async prepare(input: {
    readonly supplierProductId: SupplierProductId;
    readonly supplierOfferId: SupplierOfferId;
    readonly maximumAcquisitionAmount: Money;
    readonly quantity: 1;
    readonly correlationId: CorrelationId;
  }): Promise<ControlledPrepareResult> {
    if (!input.supplierProductId) {
      throw controlledError("SUPPLIER_PRODUCT_REQUIRED");
    }
    if (!input.supplierOfferId) {
      throw controlledError("SUPPLIER_OFFER_REQUIRED");
    }
    if (input.quantity !== 1) {
      throw controlledError("QUANTITY_MUST_BE_ONE");
    }
    if (
      input.maximumAcquisitionAmount.currency !== currency("EUR") ||
      input.maximumAcquisitionAmount.amountMinor <= 0n
    ) {
      throw controlledError("INVALID_MAXIMUM_PRICE");
    }
    const verified = await this.verifyCurrentOffer(input);
    const token = generateExecutionToken();
    const tokenHash = hashExecutionToken(token);
    const now = this.now();
    const approval: ControlledProcurementApproval = {
      approvalId: randomUUID(),
      claimedAt: null,
      completedAt: null,
      consumedAt: null,
      createdAt: now,
      currentAcquisitionAmount: verified.purchase.amount,
      dispatchStartedAt: null,
      dispatchState: "NOT_DISPATCHED",
      expiresAt: new Date(now.getTime() + this.options.config.approvalTtlMs),
      maximumAcquisitionAmount: input.maximumAcquisitionAmount,
      mode: "CONTROLLED_VERIFICATION",
      orderExternalId: verified.purchase.orderExternalId,
      productTitle: verified.productTitle,
      purchaseRequestFingerprint: verified.purchase.fingerprint,
      quantity: 1,
      recordVersion: 1,
      status: "APPROVED",
      supplierId: "kinguin",
      supplierOfferId: input.supplierOfferId,
      supplierProductId: input.supplierProductId,
      tokenHash,
      updatedAt: now,
    };
    const created = await this.options.repository.create(approval);
    await this.audit(created, "CONTROLLED_PROCUREMENT_PREPARED", "SUCCEEDED");
    await this.audit(created, "CONTROLLED_PROCUREMENT_APPROVED", "SUCCEEDED");
    return {
      approvalId: created.approvalId,
      currency: created.maximumAcquisitionAmount.currency,
      currentAcquisitionAmountMinor:
        created.currentAcquisitionAmount.amountMinor.toString(),
      expiresAt: created.expiresAt.toISOString(),
      maximumAcquisitionAmountMinor:
        created.maximumAcquisitionAmount.amountMinor.toString(),
      message: "NO PURCHASE HAS BEEN SENT.",
      oneTimeExecutionToken: token,
      orderExternalId: created.orderExternalId,
      purchaseMutation: "NOT_SENT",
      quantity: 1,
      requestFingerprint: created.purchaseRequestFingerprint,
      supplier: "Kinguin",
      supplierOfferId: created.supplierOfferId,
      supplierProductId: created.supplierProductId,
      status: "PREPARED",
      ...(created.productTitle ? { productTitle: created.productTitle } : {}),
    };
  }

  public async execute(input: {
    readonly approvalId: string;
    readonly executionToken: string;
    readonly correlationId: CorrelationId;
  }): Promise<ControlledExecuteResult> {
    if (!this.options.config.productionPurchasingEnabled) {
      return blocked(input.approvalId, "CONTROLLED_MUTATION_MODE_REQUIRED");
    }
    const approval = await this.options.repository.findById(input.approvalId);
    if (!approval) {
      return blocked(input.approvalId, "APPROVAL_NOT_FOUND");
    }
    if (!this.verifyToken(input.executionToken, approval.tokenHash)) {
      return blocked(input.approvalId, "TOKEN_INVALID");
    }
    const verified = await this.verifyApprovalPreflight(approval);
    if (verified.status !== "READY") {
      return blocked(approval.approvalId, verified.reasonCode, approval);
    }
    const claim = await this.options.repository.claim({
      approvalId: approval.approvalId,
      now: this.now(),
      tokenHash: hashExecutionToken(input.executionToken),
    });
    if (claim.status !== "CLAIMED") {
      return blocked(
        approval.approvalId,
        claim.status,
        claim.approval ?? approval,
      );
    }
    await this.audit(
      claim.approval,
      "CONTROLLED_PROCUREMENT_CLAIMED",
      "SUCCEEDED",
    );
    const dispatch = await this.options.repository.markDispatchStarted({
      approvalId: approval.approvalId,
      now: this.now(),
    });
    if (!dispatch) {
      const ambiguous = await this.options.repository.markAmbiguous({
        approvalId: approval.approvalId,
        now: this.now(),
        reasonCode: "DISPATCH_EVIDENCE_PERSISTENCE_FAILED",
      });
      return ambiguousResult(ambiguous ?? claim.approval);
    }
    await this.audit(
      dispatch,
      "CONTROLLED_PROCUREMENT_DISPATCH_STARTED",
      "SUCCEEDED",
    );
    try {
      const orderClient = this.options.orderClient;
      if (!orderClient) {
        throw controlledError("CONTROLLED_ORDER_CLIENT_REQUIRED");
      }
      const payload = await orderClient.requestJson({
        body: verified.purchase.payload,
        method: "POST",
        operation: "controlledPlaceOrder",
        path: "/v2/order",
      });
      const parsed = parseOrderResponse(payload);
      if (parsed.kind === "INVALID") {
        const ambiguous = await this.options.repository.markAmbiguous({
          approvalId: approval.approvalId,
          now: this.now(),
          reasonCode: "SUPPLIER_RESPONSE_INVALID",
          responseFingerprint: fingerprintPayload(payload as JsonValue),
        });
        return ambiguousResult(ambiguous ?? dispatch);
      }
      if (parsed.kind === "REJECTED") {
        const rejected = await this.options.repository.markRejected({
          diagnostic: normalizedSupplierRejectedDiagnostic(),
          approvalId: approval.approvalId,
          now: this.now(),
          reasonCode: "SUPPLIER_REJECTED",
          responseFingerprint: fingerprintPayload(payload as JsonValue),
        });
        return {
          approvalId: approval.approvalId,
          dispatchState: rejected?.dispatchState ?? dispatch.dispatchState,
          orderExternalId: approval.orderExternalId,
          reasonCode: "SUPPLIER_REJECTED",
          reconciliationRequired: false,
          status: "PROCUREMENT_REJECTED",
          supplier: "Kinguin",
          ...diagnosticFields(rejected?.rejectionDiagnostic),
        };
      }
      const confirmed = await this.options.repository.markConfirmed({
        approvalId: approval.approvalId,
        externalSupplierOrderId: parsed.orderId,
        now: this.now(),
        responseFingerprint: fingerprintPayload(payload as JsonValue),
        supplierStatus: parsed.status,
      });
      if (!confirmed) {
        return {
          ...ambiguousResult(dispatch),
          reasonCode: "LOCAL_SUCCESS_PERSISTENCE_FAILED",
        };
      }
      await this.audit(
        confirmed,
        "CONTROLLED_PROCUREMENT_CONFIRMED",
        "SUCCEEDED",
      );
      return {
        approvalId: approval.approvalId,
        dispatchState: confirmed.dispatchState,
        orderExternalId: confirmed.orderExternalId,
        reasonCode: "PROCUREMENT_CONFIRMED",
        reconciliationRequired: false,
        status: "PROCUREMENT_CONFIRMED",
        supplier: "Kinguin",
        ...(confirmed.externalSupplierOrderId
          ? { externalSupplierOrderId: confirmed.externalSupplierOrderId }
          : {}),
      };
    } catch (error) {
      const mapped = mapExecutionError(error);
      const updated =
        mapped.status === "PROCUREMENT_REJECTED"
          ? await this.options.repository.markRejected({
              approvalId: approval.approvalId,
              ...(mapped.diagnostic ? { diagnostic: mapped.diagnostic } : {}),
              now: this.now(),
              reasonCode: mapped.reasonCode,
            })
          : await this.options.repository.markAmbiguous({
              approvalId: approval.approvalId,
              now: this.now(),
              reasonCode: mapped.reasonCode,
            });
      if (mapped.status === "AMBIGUOUS") {
        await this.audit(
          updated ?? dispatch,
          "CONTROLLED_PROCUREMENT_AMBIGUOUS",
          "FAILED",
        );
        return ambiguousResult(updated ?? dispatch, mapped.reasonCode);
      }
      await this.audit(
        updated ?? dispatch,
        "CONTROLLED_PROCUREMENT_REJECTED",
        "FAILED",
      );
      return {
        approvalId: approval.approvalId,
        dispatchState: updated?.dispatchState ?? dispatch.dispatchState,
        orderExternalId: approval.orderExternalId,
        reasonCode: mapped.reasonCode,
        reconciliationRequired: false,
        status: "PROCUREMENT_REJECTED",
        supplier: "Kinguin",
        ...diagnosticFields(updated?.rejectionDiagnostic ?? mapped.diagnostic),
      };
    }
  }

  public async reconcile(input: {
    readonly approvalId: string;
  }): Promise<ControlledReconcileResult> {
    const approval = await this.options.repository.findById(input.approvalId);
    if (!approval) {
      throw controlledError("APPROVAL_NOT_FOUND");
    }
    await this.audit(
      approval,
      "CONTROLLED_PROCUREMENT_RECONCILIATION_REQUESTED",
      "SUCCEEDED",
    );
    if (approval.externalSupplierOrderId) {
      const result = await this.options.readOnlySupplier.reconcilePurchase(
        approval.externalSupplierOrderId,
      );
      if (result.outcome === "RESOLVED") {
        await this.options.repository.markConfirmed({
          approvalId: approval.approvalId,
          externalSupplierOrderId: approval.externalSupplierOrderId,
          now: this.now(),
          responseFingerprint: fingerprintPayload({
            outcome: result.outcome,
            reference: approval.externalSupplierOrderId,
            version: operationVersion,
          }),
          source: "RECONCILIATION",
          supplierStatus: "confirmed-by-reconciliation",
        });
        return {
          approvalId: approval.approvalId,
          externalSupplierOrderId: approval.externalSupplierOrderId,
          orderExternalId: approval.orderExternalId,
          status: "CONFIRMED_SUCCESS",
          supplier: "Kinguin",
        };
      }
      if (result.outcome === "STILL_AMBIGUOUS") {
        return {
          approvalId: approval.approvalId,
          externalSupplierOrderId: approval.externalSupplierOrderId,
          orderExternalId: approval.orderExternalId,
          status: "PENDING",
          supplier: "Kinguin",
        };
      }
    }
    return {
      approvalId: approval.approvalId,
      orderExternalId: approval.orderExternalId,
      status:
        approval.status === "PROCUREMENT_REJECTED"
          ? "CONFIRMED_REJECTION"
          : "MANUAL_REVIEW_REQUIRED",
      supplier: "Kinguin",
      ...diagnosticFields(approval.rejectionDiagnostic),
      ...(approval.externalSupplierOrderId
        ? { externalSupplierOrderId: approval.externalSupplierOrderId }
        : {}),
    };
  }

  private async verifyApprovalPreflight(
    approval: ControlledProcurementApproval,
  ): Promise<
    | { readonly status: "READY"; readonly purchase: ControlledPurchaseRequest }
    | { readonly status: "BLOCKED"; readonly reasonCode: string }
  > {
    if (approval.expiresAt.getTime() <= this.now().getTime()) {
      return { reasonCode: "APPROVAL_EXPIRED", status: "BLOCKED" };
    }
    if (approval.status !== "APPROVED") {
      return { reasonCode: "APPROVAL_NOT_APPROVED", status: "BLOCKED" };
    }
    if (approval.dispatchState !== "NOT_DISPATCHED") {
      return {
        reasonCode: "PRIOR_DISPATCH_EVIDENCE_EXISTS",
        status: "BLOCKED",
      };
    }
    let verified: {
      readonly purchase: ControlledPurchaseRequest;
    };
    try {
      verified = await this.verifyCurrentOffer({
        correlationId: correlationId("controlled-live-preflight"),
        maximumAcquisitionAmount: approval.maximumAcquisitionAmount,
        orderExternalId: approval.orderExternalId,
        quantity: 1,
        supplierOfferId: approval.supplierOfferId,
        supplierProductId: approval.supplierProductId,
      });
    } catch (error) {
      if (error instanceof SupplierError) {
        return { reasonCode: error.context.operation, status: "BLOCKED" };
      }
      return { reasonCode: "FINAL_PREFLIGHT_FAILED", status: "BLOCKED" };
    }
    if (verified.purchase.fingerprint !== approval.purchaseRequestFingerprint) {
      return { reasonCode: "REQUEST_FINGERPRINT_CHANGED", status: "BLOCKED" };
    }
    if (verified.purchase.orderExternalId !== approval.orderExternalId) {
      return { reasonCode: "ORDER_EXTERNAL_ID_CHANGED", status: "BLOCKED" };
    }
    return { purchase: verified.purchase, status: "READY" };
  }

  private async verifyCurrentOffer(input: {
    readonly supplierProductId: SupplierProductId;
    readonly supplierOfferId: SupplierOfferId;
    readonly maximumAcquisitionAmount: Money;
    readonly orderExternalId?: string;
    readonly quantity: 1;
    readonly correlationId: CorrelationId;
  }): Promise<{
    readonly offer: NormalizedSupplierOffer;
    readonly productTitle: string;
    readonly purchase: ControlledPurchaseRequest;
    readonly eligibility: GermanyEligibilityAssessment;
  }> {
    const mapped = await this.options.offerIndex.resolveProductForOffer(
      input.supplierOfferId,
    );
    if (mapped && mapped !== input.supplierProductId) {
      throw controlledError("OFFER_MAPPING_CHANGED");
    }
    const product = await this.options.readOnlySupplier.getProduct(
      input.supplierProductId,
    );
    if (!product) {
      throw controlledError("PRODUCT_NOT_FOUND");
    }
    const offer = await this.options.readOnlySupplier.getOffer(
      input.supplierOfferId,
    );
    if (!offer) {
      throw controlledError("OFFER_NOT_FOUND");
    }
    if (
      offer.offer.availability === "OUT_OF_STOCK" ||
      offer.offer.availability === "UNKNOWN"
    ) {
      throw controlledError("OFFER_NOT_AVAILABLE");
    }
    const registry = new StaticRegionSemanticRegistry();
    if (offer.regionEvidence.supplierRegion) {
      registry.set({
        semantic: semanticForControlledRegionText(
          offer.regionEvidence.supplierRegion.documentedSemanticsSummary,
        ),
        supplierId: supplier,
        supplierRegionId: offer.regionEvidence.supplierRegion.supplierRegionId,
      });
    }
    const eligibility = new GermanyEligibilityEngine({
      regionSemantics: registry,
    }).evaluate({ evidence: offer.regionEvidence, supplierId: supplier });
    if (eligibility.decision !== "ALLOWED") {
      throw controlledError(
        eligibility.reasonCode === "REGION_UNKNOWN_VALUE"
          ? "REGION_REVIEW_REQUIRED"
          : "GERMANY_INELIGIBLE",
      );
    }
    if (
      offer.offer.currentPrice.currency !==
      input.maximumAcquisitionAmount.currency
    ) {
      throw controlledError("CURRENCY_CHANGED");
    }
    if (offer.offer.currentPrice.currency !== currency("EUR")) {
      throw controlledError("UNSUPPORTED_CURRENCY");
    }
    if (offer.offer.currentPrice.amountMinor <= 0n) {
      throw controlledError("INVALID_CURRENT_PRICE");
    }
    if (
      offer.offer.currentPrice.amountMinor >
      input.maximumAcquisitionAmount.amountMinor
    ) {
      throw controlledError("CURRENT_PRICE_EXCEEDS_APPROVAL_MAXIMUM");
    }
    const purchase = buildControlledPurchaseRequest({
      amount: offer.offer.currentPrice,
      orderExternalId: input.orderExternalId ?? liveOrderExternalId(),
      supplierOfferId: input.supplierOfferId,
      supplierProductId: input.supplierProductId,
    });
    return {
      eligibility,
      offer,
      productTitle: product.product.title,
      purchase,
    };
  }

  private verifyToken(token: string, tokenHash: string): boolean {
    const actual = Buffer.from(hashExecutionToken(token), "hex");
    const expected = Buffer.from(tokenHash, "hex");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  private async audit(
    approval: ControlledProcurementApproval,
    eventType: ControlledProcurementAuditEvent,
    outcome: AuditEvent["outcome"],
  ): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "controlled-live-procurement", type: "SERVICE" },
      correlationId: correlationId(`controlled:${approval.approvalId}`),
      entity: {
        id: approval.approvalId,
        type: "CONTROLLED_PROCUREMENT_APPROVAL",
      },
      environment: this.options.environment ?? "LOCAL",
      eventType: `PROCUREMENT_${eventType}`,
      metadata: {
        approvalId: approval.approvalId,
        dispatchState: approval.dispatchState,
        mode: approval.mode,
        orderExternalId: approval.orderExternalId,
        reasonCode: approval.failureReasonCode ?? eventType,
        ...diagnosticFields(approval.rejectionDiagnostic),
        status: approval.status,
        supplierId: approval.supplierId,
      },
      outcome,
      reasonCode: approval.failureReasonCode ?? eventType,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }
}

export class InMemoryControlledProcurementApprovalRepository implements ControlledProcurementApprovalRepository {
  private readonly approvals = new Map<string, ControlledProcurementApproval>();

  public async create(
    input: ControlledProcurementApproval,
  ): Promise<ControlledProcurementApproval> {
    if (
      [...this.approvals.values()].some(
        (approval) => approval.orderExternalId === input.orderExternalId,
      )
    ) {
      throw controlledError("DUPLICATE_CONTROLLED_APPROVAL");
    }
    this.approvals.set(input.approvalId, input);
    return input;
  }

  public async findById(
    approvalId: string,
  ): Promise<ControlledProcurementApproval | null> {
    return this.approvals.get(approvalId) ?? null;
  }

  public async cancel(input: {
    readonly approvalId: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null> {
    return this.transition(
      input.approvalId,
      input.now,
      {
        status: "CANCELLED",
      },
      (current) =>
        (current.status === "PENDING_APPROVAL" ||
          current.status === "APPROVED") &&
        current.dispatchState === "NOT_DISPATCHED",
    );
  }

  public async claim(input: {
    readonly approvalId: string;
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<ControlledClaimResult> {
    const current = this.approvals.get(input.approvalId);
    if (!current) {
      return { status: "APPROVAL_NOT_FOUND" };
    }
    if (current.expiresAt.getTime() <= input.now.getTime()) {
      const expired = await this.patch(input.approvalId, input.now, {
        status: "EXPIRED",
      });
      return { approval: expired ?? current, status: "APPROVAL_EXPIRED" };
    }
    if (current.status === "CANCELLED") {
      return { approval: current, status: "APPROVAL_CANCELLED" };
    }
    if (
      current.status !== "APPROVED" ||
      current.dispatchState !== "NOT_DISPATCHED"
    ) {
      return { approval: current, status: "APPROVAL_ALREADY_CONSUMED" };
    }
    if (current.tokenHash !== input.tokenHash) {
      return { approval: current, status: "TOKEN_INVALID" };
    }
    const claimed = await this.patch(input.approvalId, input.now, {
      claimedAt: input.now,
      consumedAt: input.now,
      dispatchState: "CLAIMED",
      status: "CONSUMED",
    });
    return { approval: claimed ?? current, status: "CLAIMED" };
  }

  public async markDispatchStarted(input: {
    readonly approvalId: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null> {
    return this.transition(
      input.approvalId,
      input.now,
      {
        dispatchStartedAt: input.now,
        dispatchState: "DISPATCH_STARTED",
        status: "CONSUMED",
      },
      (current) =>
        current.status === "CONSUMED" && current.dispatchState === "CLAIMED",
    );
  }

  public async markConfirmed(input: {
    readonly approvalId: string;
    readonly externalSupplierOrderId: string;
    readonly source?: "RECONCILIATION";
    readonly supplierStatus: string;
    readonly responseFingerprint: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null> {
    return this.transition(
      input.approvalId,
      input.now,
      {
        completedAt: input.now,
        dispatchState: "DISPATCH_CONFIRMED",
        externalSupplierOrderId: input.externalSupplierOrderId,
        responseFingerprint: input.responseFingerprint,
        status: "PROCUREMENT_CONFIRMED",
        supplierStatus: input.supplierStatus,
      },
      (current) =>
        (current.status === "CONSUMED" &&
          current.dispatchState === "DISPATCH_STARTED") ||
        (input.source === "RECONCILIATION" &&
          current.status === "AMBIGUOUS" &&
          current.dispatchState === "DISPATCH_AMBIGUOUS"),
    );
  }

  public async markRejected(input: {
    readonly approvalId: string;
    readonly reasonCode: string;
    readonly diagnostic?: ControlledProcurementRejectionDiagnostic;
    readonly responseFingerprint?: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null> {
    return this.transition(
      input.approvalId,
      input.now,
      {
        completedAt: input.now,
        dispatchState: "DISPATCH_REJECTED",
        failureReasonCode: input.reasonCode,
        rejectionDiagnostic: input.diagnostic ?? null,
        responseFingerprint: input.responseFingerprint ?? null,
        status: "PROCUREMENT_REJECTED",
      },
      (current) =>
        current.status === "CONSUMED" &&
        current.dispatchState === "DISPATCH_STARTED",
    );
  }

  public async markAmbiguous(input: {
    readonly approvalId: string;
    readonly reasonCode: string;
    readonly externalSupplierOrderId?: string;
    readonly responseFingerprint?: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null> {
    return this.transition(
      input.approvalId,
      input.now,
      {
        dispatchState: "DISPATCH_AMBIGUOUS",
        externalSupplierOrderId: input.externalSupplierOrderId ?? null,
        failureReasonCode: input.reasonCode,
        responseFingerprint: input.responseFingerprint ?? null,
        status: "AMBIGUOUS",
      },
      (current) =>
        current.status === "CONSUMED" &&
        current.dispatchState === "DISPATCH_STARTED",
    );
  }

  public async markManualReview(input: {
    readonly approvalId: string;
    readonly reasonCode: string;
    readonly now: Date;
  }): Promise<ControlledProcurementApproval | null> {
    return this.transition(
      input.approvalId,
      input.now,
      {
        failureReasonCode: input.reasonCode,
        status: "MANUAL_REVIEW_REQUIRED",
      },
      (current) =>
        ![
          "PROCUREMENT_CONFIRMED",
          "PROCUREMENT_REJECTED",
          "AMBIGUOUS",
        ].includes(current.status),
    );
  }

  private async transition(
    approvalId: string,
    now: Date,
    patch: Partial<ControlledProcurementApproval>,
    canTransition: (current: ControlledProcurementApproval) => boolean,
  ): Promise<ControlledProcurementApproval | null> {
    const current = this.approvals.get(approvalId);
    if (!current || !canTransition(current)) {
      return null;
    }
    return this.patch(approvalId, now, patch);
  }

  private async patch(
    approvalId: string,
    now: Date,
    patch: Partial<ControlledProcurementApproval>,
  ): Promise<ControlledProcurementApproval | null> {
    const current = this.approvals.get(approvalId);
    if (!current) {
      return null;
    }
    const next = {
      ...current,
      ...patch,
      recordVersion: current.recordVersion + 1,
      updatedAt: now,
    };
    this.approvals.set(approvalId, next);
    return next;
  }
}

export const buildControlledPurchaseRequest = (input: {
  readonly supplierProductId: SupplierProductId;
  readonly supplierOfferId: SupplierOfferId;
  readonly amount: Money;
  readonly orderExternalId: string;
}): ControlledPurchaseRequest => {
  if (input.amount.currency !== currency("EUR")) {
    throw controlledError("UNSUPPORTED_CURRENCY");
  }
  if (input.amount.amountMinor <= 0n) {
    throw controlledError("INVALID_CURRENT_PRICE");
  }
  const payload = {
    orderExternalId: input.orderExternalId,
    products: [
      {
        keyType: "text",
        offerId: input.supplierOfferId,
        price: decimalAmount(input.amount),
        productId: input.supplierProductId,
        qty: 1,
      },
    ],
  } satisfies JsonValue;
  return {
    amount: input.amount,
    fingerprint: fingerprintPayload({
      currency: input.amount.currency,
      operationVersion,
      orderExternalId: input.orderExternalId,
      priceMinor: input.amount.amountMinor.toString(),
      quantity: 1,
      supplierId: "kinguin",
      supplierOfferId: input.supplierOfferId,
      supplierProductId: input.supplierProductId,
      kinguin: payload,
    }),
    orderExternalId: input.orderExternalId,
    payload,
  };
};

export const createControlledLiveServiceFromEnv = (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly repository: ControlledProcurementApprovalRepository;
  readonly mutationTransport?: KinguinHttpTransport;
  readonly readOnlyTransport?: KinguinHttpTransport;
  readonly mode: "READ_ONLY" | "CONTROLLED_MUTATION";
}): ControlledLiveProcurementService => {
  const config =
    input.mode === "CONTROLLED_MUTATION"
      ? validateControlledMutationConfig(input.env)
      : validateControlledReadOnlyConfig(input.env);
  const controlledFromEnv = controlledLiveConfigFromEnv(input.env);
  const controlled =
    input.mode === "READ_ONLY"
      ? { ...controlledFromEnv, productionPurchasingEnabled: false }
      : controlledFromEnv;
  const offerIndex = new InMemoryKinguinOfferProductIndex();
  const readOnlyGuard = new KinguinLiveReadonlyGuardedTransport({
    allowOrderStatusLookup: true,
    baseUrl: config.baseUrl,
    delegate: input.readOnlyTransport ?? new FetchKinguinHttpTransport(),
    enabled: true,
  });
  const readOnlyClient = new KinguinHttpClient(
    config,
    new EnvSecretProvider(input.env),
    readOnlyGuard,
  );
  const orderGuard =
    input.mode === "CONTROLLED_MUTATION"
      ? new KinguinControlledOrderTransport({
          baseUrl: config.baseUrl,
          delegate: input.mutationTransport ?? new FetchKinguinHttpTransport(),
        })
      : undefined;
  const orderClient = orderGuard
    ? new KinguinHttpClient(
        { ...config, timeoutMs: controlled.orderTimeoutMs },
        new EnvSecretProvider(input.env),
        { send: (request) => orderGuard.createOrder(request) },
      )
    : undefined;
  return new ControlledLiveProcurementService({
    config: controlled,
    offerIndex,
    readOnlySupplier: new KinguinSupplier(readOnlyClient, offerIndex),
    repository: input.repository,
    ...(orderClient ? { orderClient } : {}),
    ...(orderGuard ? { orderTransport: orderGuard } : {}),
  });
};

export const hashExecutionToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export const generateExecutionToken = (): string =>
  randomBytes(32).toString("base64url");

export const fingerprintPayload = (payload: JsonValue): string =>
  createHash("sha256").update(canonicalJson(payload)).digest("hex");

export const liveOrderExternalId = (): string =>
  `keycore-liveverify-${randomUUID()}`;

export const controlledError = (reasonCode: string): SupplierError =>
  new SupplierError({
    category: "REJECTED",
    operation: reasonCode,
    supplierId: supplier,
  });

export const semanticForControlledRegionText = (
  value: string | undefined,
): RegionSemantic => {
  const text = value?.toLowerCase() ?? "";
  if (/\bgermany\b|\bde\b/u.test(text)) {
    return "DE";
  }
  if (text.includes("europe") || text.includes("eu")) {
    return "EU_INCLUDING_DE";
  }
  if (text.includes("global") || text.includes("worldwide")) {
    return "GLOBAL";
  }
  if (text.includes("region free") || text.includes("region-free")) {
    return "REGION_FREE";
  }
  if (text.includes("cis") || text.includes("latam") || text.includes("asia")) {
    return "INCOMPATIBLE";
  }
  return "UNKNOWN";
};

const parseOrderResponse = (
  payload: unknown,
):
  | {
      readonly kind: "SUCCESS";
      readonly orderId: string;
      readonly status: string;
    }
  | { readonly kind: "REJECTED" }
  | { readonly kind: "INVALID" } => {
  if (!isObject(payload)) {
    return { kind: "INVALID" };
  }
  const status = typeof payload.status === "string" ? payload.status : "";
  const orderId = typeof payload.orderId === "string" ? payload.orderId : "";
  if (status === "canceled" || status === "refunded") {
    return { kind: "REJECTED" };
  }
  if (!orderId || !["processing", "completed"].includes(status)) {
    return { kind: "INVALID" };
  }
  return { kind: "SUCCESS", orderId, status };
};

const normalizeKinguinOrderRejection = (
  response: KinguinHttpResponse,
): ControlledProcurementRejectionDiagnostic => {
  const parsed = parseKinguinErrorBody(response.body);
  const code = sanitizeSupplierErrorCode(parsed?.kind);
  const status =
    typeof parsed?.status === "number" &&
    Number.isInteger(parsed.status) &&
    parsed.status >= 100 &&
    parsed.status <= 599
      ? parsed.status
      : response.status;
  const mapped = mapKinguinRejectionDiagnostic(status, code);
  return {
    safeReasonCode: mapped.safeReasonCode,
    supplier: "Kinguin",
    supplierErrorCategory: mapped.supplierErrorCategory,
    supplierErrorCode: code,
    supplierHttpStatus: status,
  };
};

const parseKinguinErrorBody = (
  body: string,
): { readonly kind?: unknown; readonly status?: unknown } | null => {
  try {
    const parsed = JSON.parse(body) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const sanitizeSupplierErrorCode = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 80 ||
    !/^[A-Za-z0-9_.:-]+$/u.test(trimmed) ||
    /(product.?key|serial|plaintext|token|api.?key|secret)/iu.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
};

const mapKinguinRejectionDiagnostic = (
  status: number,
  code: string | null,
): Pick<
  ControlledProcurementRejectionDiagnostic,
  "safeReasonCode" | "supplierErrorCategory"
> => {
  if (status === 401 || (code === "Authorization" && status !== 403)) {
    return {
      safeReasonCode: "KINGUIN_AUTHENTICATION_REJECTED",
      supplierErrorCategory: "AUTHENTICATION",
    };
  }
  if (status === 403) {
    return {
      safeReasonCode: "KINGUIN_AUTHORIZATION_REJECTED",
      supplierErrorCategory: "AUTHORIZATION",
    };
  }
  if (status === 429) {
    return {
      safeReasonCode: "KINGUIN_RATE_LIMITED",
      supplierErrorCategory: "RATE_LIMIT",
    };
  }
  if (code === "InsufficientBalance") {
    return {
      safeReasonCode: "KINGUIN_INSUFFICIENT_BALANCE",
      supplierErrorCategory: "INSUFFICIENT_BALANCE",
    };
  }
  if (code === "ProductUnavailable") {
    return {
      safeReasonCode: "KINGUIN_PRODUCT_UNAVAILABLE",
      supplierErrorCategory: "PRODUCT_UNAVAILABLE",
    };
  }
  if (
    code === "ConstraintViolation" ||
    code === "Preorder" ||
    status === 400 ||
    status === 422
  ) {
    return {
      safeReasonCode: "KINGUIN_ORDER_VALIDATION_REJECTED",
      supplierErrorCategory: "VALIDATION",
    };
  }
  if (code === "OrderFailed" || code === "ResourceLock") {
    return {
      safeReasonCode: "KINGUIN_SUPPLIER_REJECTED",
      supplierErrorCategory: "SUPPLIER_REJECTION",
    };
  }
  return {
    safeReasonCode: "KINGUIN_UNKNOWN_REJECTION",
    supplierErrorCategory: code ? "SUPPLIER_REJECTION" : "UNKNOWN",
  };
};

const normalizedSupplierRejectedDiagnostic =
  (): ControlledProcurementRejectionDiagnostic => ({
    safeReasonCode: "KINGUIN_SUPPLIER_REJECTED",
    supplier: "Kinguin",
    supplierErrorCategory: "SUPPLIER_REJECTION",
    supplierErrorCode: null,
    supplierHttpStatus: null,
  });

const mapExecutionError = (
  error: unknown,
): {
  readonly status: "PROCUREMENT_REJECTED" | "AMBIGUOUS";
  readonly reasonCode: string;
  readonly diagnostic?: ControlledProcurementRejectionDiagnostic;
} => {
  if (error instanceof ControlledKinguinOrderRejectionError) {
    return {
      diagnostic: error.diagnostic,
      reasonCode: error.diagnostic.safeReasonCode,
      status: "PROCUREMENT_REJECTED",
    };
  }
  if (error instanceof SupplierError) {
    if (
      [
        "OUT_OF_STOCK",
        "REJECTED",
        "NOT_FOUND",
        "AUTHENTICATION",
        "AUTHORIZATION",
      ].includes(error.category)
    ) {
      return {
        reasonCode: error.context.operation,
        status: "PROCUREMENT_REJECTED",
      };
    }
  }
  return {
    reasonCode: "SUPPLIER_MUTATION_OUTCOME_AMBIGUOUS",
    status: "AMBIGUOUS",
  };
};

const blocked = (
  approvalId: string,
  reasonCode: string,
  approval?: ControlledProcurementApproval,
): ControlledExecuteResult => ({
  approvalId,
  reasonCode,
  reconciliationRequired: false,
  status: "BLOCKED",
  supplier: "Kinguin",
  ...(approval?.dispatchState ? { dispatchState: approval.dispatchState } : {}),
  ...(approval?.orderExternalId
    ? { orderExternalId: approval.orderExternalId }
    : {}),
});

const diagnosticFields = (
  diagnostic: ControlledProcurementRejectionDiagnostic | null | undefined,
) =>
  diagnostic
    ? {
        safeReasonCode: diagnostic.safeReasonCode,
        supplierErrorCategory: diagnostic.supplierErrorCategory,
        supplierErrorCode: diagnostic.supplierErrorCode,
        supplierHttpStatus: diagnostic.supplierHttpStatus,
      }
    : {};

const ambiguousResult = (
  approval: ControlledProcurementApproval,
  reasonCode = approval.failureReasonCode ??
    "SUPPLIER_MUTATION_OUTCOME_AMBIGUOUS",
): ControlledExecuteResult => ({
  approvalId: approval.approvalId,
  dispatchState: approval.dispatchState,
  orderExternalId: approval.orderExternalId,
  reasonCode,
  reconciliationRequired: true,
  status: "AMBIGUOUS",
  supplier: "Kinguin",
  ...(approval.externalSupplierOrderId
    ? { externalSupplierOrderId: approval.externalSupplierOrderId }
    : {}),
});

const positiveIntegerEnv = (value: string | undefined): number | null => {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const boundedPositiveInteger = (
  value: number | undefined,
  defaultValue: number,
  cap: number,
  reasonCode: string,
): number => {
  if (value === undefined) {
    return defaultValue;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw controlledError(reasonCode);
  }
  return Math.min(value, cap);
};

const compareControlledCandidates = (
  left: ControlledCandidate,
  right: ControlledCandidate,
): number => {
  const leftPrice = BigInt(left.currentAcquisitionAmountMinor);
  const rightPrice = BigInt(right.currentAcquisitionAmountMinor);
  if (leftPrice !== rightPrice) {
    return leftPrice < rightPrice ? -1 : 1;
  }
  const product = left.supplierProductId.localeCompare(right.supplierProductId);
  return product === 0
    ? left.supplierOfferId.localeCompare(right.supplierOfferId)
    : product;
};

const decimalAmount = (value: Money): string => {
  const major = value.amountMinor / 100n;
  const minor = value.amountMinor % 100n;
  return `${major}.${minor.toString().padStart(2, "0")}`;
};

const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const controlledGermanyPolicyVersion = germanyEligibilityPolicyVersion;
