import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

import type { AuditEvent } from "../domain/audit.js";
import type {
  CorrelationId,
  OrderId,
  SupplierId,
} from "../domain/identifiers.js";
import type { AuditEventPort } from "../ports/core.js";
import {
  evaluateHighRiskOperation,
  type OperationsControlGate,
} from "../operations/operations-controls.js";
import { SupplierError } from "../suppliers/errors.js";
import type { KeyManagementProvider } from "../vault/crypto.js";

export const fulfillmentEncryptionAlgorithm = "AES-256-GCM-v1";
export const fulfillmentEncryptionVersion = 1;

export type FulfillmentStatus =
  | "PENDING"
  | "READY"
  | "RETRIEVAL_IN_FLIGHT"
  | "RETRIEVED"
  | "DELIVERY_PENDING"
  | "DELIVERED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL"
  | "AMBIGUOUS"
  | "MANUAL_REVIEW_REQUIRED";

export type FulfillmentRetrievalState =
  | "NOT_STARTED"
  | "IN_FLIGHT"
  | "RETRIEVED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL"
  | "AMBIGUOUS"
  | "MANUAL_REVIEW_REQUIRED";

export type FulfillmentDeliveryState =
  | "NOT_READY"
  | "PENDING"
  | "DELIVERED"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL";

export type FulfillmentReasonCode =
  | "FULFILLMENT_CREATED"
  | "FULFILLMENT_ALREADY_EXISTS"
  | "FULFILLMENT_KEY_RETRIEVED"
  | "FULFILLMENT_NOT_FOUND"
  | "PROCUREMENT_NOT_CONFIRMED"
  | "SUPPLIER_ORDER_REFERENCE_MISSING"
  | "SUPPLIER_UNSUPPORTED"
  | "FULFILLMENT_ALREADY_RETRIEVED"
  | "FULFILLMENT_RETRIEVAL_IN_FLIGHT"
  | "FULFILLMENT_APPROVAL_EXPIRED"
  | "FULFILLMENT_TOKEN_INVALID"
  | "FULFILLMENT_CONFIGURATION_INVALID"
  | "FULFILLMENT_RETRIEVAL_DISABLED"
  | "FULFILLMENT_KEY_NOT_AVAILABLE_YET"
  | "FULFILLMENT_KEY_COUNT_MISMATCH"
  | "FULFILLMENT_SUPPLIER_RESPONSE_INVALID"
  | "FULFILLMENT_SUPPLIER_REJECTED"
  | "FULFILLMENT_SUPPLIER_RETRYABLE"
  | "FULFILLMENT_SUPPLIER_AMBIGUOUS"
  | "FULFILLMENT_KEY_MANAGEMENT_FAILED"
  | "FULFILLMENT_LOCAL_PERSISTENCE_FAILED"
  | "FULFILLMENT_LOCAL_UNKNOWN"
  | "OPERATIONS_CONTROL_PAUSED"
  | "OPERATIONS_CONTROL_UNAVAILABLE"
  | "OPTIMISTIC_CONCURRENCY_CONFLICT";

export interface FulfillmentOperation {
  readonly id: string;
  readonly orderId?: OrderId | null;
  readonly procurementOperationId?: string | null;
  readonly controlledProcurementApprovalId?: string | null;
  readonly supplierId: SupplierId;
  readonly externalSupplierOrderId: string;
  readonly supplierItemReference?: string | null;
  readonly expectedQuantity: number;
  readonly status: FulfillmentStatus;
  readonly retrievalState: FulfillmentRetrievalState;
  readonly deliveryState: FulfillmentDeliveryState;
  readonly tokenHash?: string | null;
  readonly approvalExpiresAt?: Date | null;
  readonly retrievalExecutionToken?: string | null;
  readonly retrievalStartedAt?: Date | null;
  readonly encryptedSecretId?: string | null;
  readonly failureReasonCode?: FulfillmentReasonCode | null;
  readonly recordVersion: number;
  readonly correlationId: CorrelationId;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly retrievedAt?: Date | null;
  readonly deliveredAt?: Date | null;
}

export interface FulfillmentEncryptedSecretMaterial {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authenticationTag: Uint8Array;
  readonly wrappedDataEncryptionKey: Uint8Array;
  readonly algorithm: typeof fulfillmentEncryptionAlgorithm;
  readonly encryptionKeyId: string;
  readonly encryptionVersion: typeof fulfillmentEncryptionVersion;
}

export interface FulfillmentSecretRecord extends FulfillmentEncryptedSecretMaterial {
  readonly id: string;
  readonly fulfillmentId: string;
  readonly createdAt: Date;
}

export interface FulfillmentEncryptionContext {
  readonly fulfillmentId: string;
  readonly supplierId: SupplierId;
  readonly externalSupplierOrderId: string;
}

export interface FulfillmentRepository {
  createIdempotent(input: {
    readonly operation: FulfillmentOperation;
    readonly now: Date;
  }): Promise<
    | { readonly status: "CREATED"; readonly operation: FulfillmentOperation }
    | { readonly status: "EXISTING"; readonly operation: FulfillmentOperation }
  >;
  findById(fulfillmentId: string): Promise<FulfillmentOperation | null>;
  findByControlledProcurementApprovalId(
    approvalId: string,
  ): Promise<FulfillmentOperation | null>;
  acquireRetrievalLease(input: {
    readonly fulfillmentId: string;
    readonly tokenHash: string;
    readonly executionToken: string;
    readonly staleStartedBefore: Date;
    readonly now: Date;
  }): Promise<
    | { readonly status: "ACQUIRED"; readonly operation: FulfillmentOperation }
    | { readonly status: "IN_FLIGHT"; readonly operation: FulfillmentOperation }
    | {
        readonly status: "ALREADY_RETRIEVED";
        readonly operation: FulfillmentOperation;
      }
    | { readonly status: "EXPIRED"; readonly operation: FulfillmentOperation }
    | {
        readonly status: "TOKEN_INVALID";
        readonly operation: FulfillmentOperation;
      }
    | {
        readonly status: "NOT_ELIGIBLE";
        readonly operation?: FulfillmentOperation;
      }
  >;
  markRetrieved(input: {
    readonly fulfillmentId: string;
    readonly executionToken: string;
    readonly material: FulfillmentEncryptedSecretMaterial;
    readonly now: Date;
  }): Promise<FulfillmentOperation | null>;
  markFailed(input: {
    readonly fulfillmentId: string;
    readonly executionToken: string;
    readonly status: Extract<
      FulfillmentStatus,
      | "FAILED_RETRYABLE"
      | "FAILED_TERMINAL"
      | "AMBIGUOUS"
      | "MANUAL_REVIEW_REQUIRED"
    >;
    readonly reasonCode: FulfillmentReasonCode;
    readonly now: Date;
  }): Promise<FulfillmentOperation | null>;
  markDelivered(input: {
    readonly fulfillmentId: string;
    readonly now: Date;
  }): Promise<FulfillmentOperation | null>;
  findSecretByFulfillmentId(
    fulfillmentId: string,
  ): Promise<FulfillmentSecretRecord | null>;
}

export interface FulfillmentProcurementEvidence {
  readonly status: "CONFIRMED" | "UNCONFIRMED" | "NOT_FOUND";
  readonly controlledProcurementApprovalId?: string;
  readonly orderId?: OrderId | null;
  readonly procurementOperationId?: string | null;
  readonly supplierId?: SupplierId;
  readonly externalSupplierOrderId?: string | null;
  readonly supplierItemReference?: string | null;
  readonly expectedQuantity?: number;
}

export interface FulfillmentProcurementEvidencePort {
  getControlledProcurementEvidence(
    approvalId: string,
  ): Promise<FulfillmentProcurementEvidence>;
}

export interface RetrievedSupplierKey {
  readonly supplierKeyId: string;
  readonly contentType: "text/plain" | "image/jpeg" | "image/png" | "image/gif";
  readonly material: Uint8Array;
}

export interface SupplierKeyRetrievalPort {
  retrievePurchasedKeys(input: {
    readonly supplierId: SupplierId;
    readonly externalSupplierOrderId: string;
    readonly expectedQuantity: number;
    readonly correlationId: CorrelationId;
  }): Promise<
    | {
        readonly status: "RETRIEVED";
        readonly keys: readonly RetrievedSupplierKey[];
      }
    | { readonly status: "PENDING"; readonly reasonCode: FulfillmentReasonCode }
  >;
}

export interface FulfillmentServiceOptions {
  readonly repository: FulfillmentRepository;
  readonly procurementEvidence: FulfillmentProcurementEvidencePort;
  readonly keyRetrieval: SupplierKeyRetrievalPort;
  readonly keyManagementProvider: KeyManagementProvider;
  readonly controlledKeyRetrievalEnabled: boolean;
  readonly controlledKeyRetrievalMode:
    "DISABLED" | "CONTROLLED_VERIFICATION_ONE_TIME";
  readonly retrievalLeaseStaleAfterMs: number;
  readonly approvalTtlMs: number;
  readonly operationsControlGate?: OperationsControlGate;
  readonly audit?: AuditEventPort;
  readonly environment?: AuditEvent["environment"];
  readonly now?: () => Date;
}

export interface FulfillmentPrepareResult {
  readonly status: "APPROVED" | "BLOCKED";
  readonly reasonCode: FulfillmentReasonCode;
  readonly fulfillmentApprovalId?: string;
  readonly controlledProcurementApprovalId?: string;
  readonly externalSupplierOrderId?: string;
  readonly supplier?: string;
  readonly expiresAt?: string;
  readonly oneTimeExecutionToken?: string;
  readonly message?: string;
}

export interface FulfillmentExecuteResult {
  readonly status:
    | "RETRIEVED"
    | "DELIVERY_PENDING"
    | "FAILED_RETRYABLE"
    | "FAILED_TERMINAL"
    | "AMBIGUOUS"
    | "MANUAL_REVIEW_REQUIRED"
    | "BLOCKED"
    | "IN_PROGRESS";
  readonly reasonCode: FulfillmentReasonCode;
  readonly fulfillmentId?: string;
  readonly supplier?: string;
  readonly externalSupplierOrderId?: string;
  readonly deliveryState?: FulfillmentDeliveryState;
  readonly hasEncryptedSecret?: boolean;
}

const dataKeyBytes = 32;
const nonceBytes = 12;

const toBuffer = (value: Uint8Array): Buffer =>
  Buffer.from(value.buffer, value.byteOffset, value.byteLength);

export const canonicalFulfillmentAad = (
  context: FulfillmentEncryptionContext,
): Uint8Array =>
  Buffer.from(
    JSON.stringify({
      algorithm: fulfillmentEncryptionAlgorithm,
      externalSupplierOrderId: context.externalSupplierOrderId,
      fulfillmentId: context.fulfillmentId,
      purpose: "keycore-fulfillment-secret",
      supplierId: context.supplierId,
      version: fulfillmentEncryptionVersion,
    }),
    "utf8",
  );

export const encryptFulfillmentSecret = async (
  plaintext: Uint8Array,
  context: FulfillmentEncryptionContext,
  keyManagementProvider: KeyManagementProvider,
): Promise<FulfillmentEncryptedSecretMaterial> => {
  const dataKey = randomBytes(dataKeyBytes);
  const nonce = randomBytes(nonceBytes);
  try {
    const cipher = createCipheriv("aes-256-gcm", dataKey, nonce);
    cipher.setAAD(canonicalFulfillmentAad(context));
    const ciphertext = Buffer.concat([
      cipher.update(toBuffer(plaintext)),
      cipher.final(),
    ]);
    const authenticationTag = cipher.getAuthTag();
    const wrapped = await keyManagementProvider.wrapDataKey({ dataKey });
    return {
      algorithm: fulfillmentEncryptionAlgorithm,
      authenticationTag,
      ciphertext,
      encryptionKeyId: wrapped.keyVersion,
      encryptionVersion: fulfillmentEncryptionVersion,
      nonce,
      wrappedDataEncryptionKey: wrapped.wrappedDataKey,
    };
  } finally {
    dataKey.fill(0);
  }
};

export const decryptFulfillmentSecret = async (
  material: FulfillmentEncryptedSecretMaterial,
  context: FulfillmentEncryptionContext,
  keyManagementProvider: KeyManagementProvider,
): Promise<Uint8Array> => {
  if (
    material.algorithm !== fulfillmentEncryptionAlgorithm ||
    material.encryptionVersion !== fulfillmentEncryptionVersion
  ) {
    throw new Error("Unsupported fulfillment secret material");
  }
  const dataKey = await keyManagementProvider.unwrapDataKey({
    keyVersion: material.encryptionKeyId,
    wrappedDataKey: material.wrappedDataEncryptionKey,
  });
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      toBuffer(dataKey),
      toBuffer(material.nonce),
    );
    decipher.setAAD(canonicalFulfillmentAad(context));
    decipher.setAuthTag(toBuffer(material.authenticationTag));
    return Buffer.concat([
      decipher.update(toBuffer(material.ciphertext)),
      decipher.final(),
    ]);
  } catch {
    throw new Error("Fulfillment secret verification failed");
  } finally {
    toBuffer(dataKey).fill(0);
  }
};

export class SecureKeyFulfillmentService {
  private readonly now: () => Date;
  private readonly environment: AuditEvent["environment"];

  public constructor(private readonly options: FulfillmentServiceOptions) {
    if (
      !Number.isInteger(options.retrievalLeaseStaleAfterMs) ||
      options.retrievalLeaseStaleAfterMs <= 0 ||
      !Number.isInteger(options.approvalTtlMs) ||
      options.approvalTtlMs <= 0
    ) {
      throw new Error("Fulfillment timing configuration is invalid");
    }
    this.now = options.now ?? (() => new Date());
    this.environment = options.environment ?? "LOCAL";
  }

  public async prepareControlledRetrieval(input: {
    readonly controlledProcurementApprovalId: string;
    readonly correlationId: CorrelationId;
  }): Promise<FulfillmentPrepareResult> {
    const evidence =
      await this.options.procurementEvidence.getControlledProcurementEvidence(
        input.controlledProcurementApprovalId,
      );
    const blocked = await this.preparationBlocker(evidence);
    if (blocked) {
      return { reasonCode: blocked, status: "BLOCKED" };
    }
    const now = this.now();
    const token = generateFulfillmentExecutionToken();
    const operation: FulfillmentOperation = {
      approvalExpiresAt: new Date(now.getTime() + this.options.approvalTtlMs),
      controlledProcurementApprovalId: input.controlledProcurementApprovalId,
      correlationId: input.correlationId,
      createdAt: now,
      deliveryState: "NOT_READY",
      expectedQuantity: evidence.expectedQuantity ?? 1,
      externalSupplierOrderId: requireString(evidence.externalSupplierOrderId),
      id: randomUUID(),
      orderId: evidence.orderId ?? null,
      procurementOperationId: evidence.procurementOperationId ?? null,
      recordVersion: 1,
      retrievalState: "NOT_STARTED",
      status: "READY",
      supplierId: requireSupplier(evidence.supplierId),
      supplierItemReference: evidence.supplierItemReference ?? null,
      tokenHash: hashFulfillmentExecutionToken(token),
      updatedAt: now,
    };
    const created = await this.options.repository.createIdempotent({
      now,
      operation,
    });
    await this.audit(
      created.operation,
      "FULFILLMENT_CREATED",
      "SUCCEEDED",
      created.status === "CREATED"
        ? "FULFILLMENT_CREATED"
        : "FULFILLMENT_ALREADY_EXISTS",
    );
    if (created.status === "EXISTING") {
      if (created.operation.encryptedSecretId) {
        return {
          reasonCode: "FULFILLMENT_ALREADY_RETRIEVED",
          status: "BLOCKED",
        };
      }
      return {
        controlledProcurementApprovalId: input.controlledProcurementApprovalId,
        expiresAt: requireDate(
          created.operation.approvalExpiresAt,
        ).toISOString(),
        externalSupplierOrderId: created.operation.externalSupplierOrderId,
        fulfillmentApprovalId: created.operation.id,
        message: "NO PRODUCT KEY HAS BEEN RETRIEVED.",
        reasonCode: "FULFILLMENT_ALREADY_EXISTS",
        status: "BLOCKED",
        supplier: created.operation.supplierId,
      };
    }
    return {
      controlledProcurementApprovalId: input.controlledProcurementApprovalId,
      expiresAt: requireDate(created.operation.approvalExpiresAt).toISOString(),
      externalSupplierOrderId: created.operation.externalSupplierOrderId,
      fulfillmentApprovalId: created.operation.id,
      message: "NO PRODUCT KEY HAS BEEN RETRIEVED.",
      oneTimeExecutionToken: token,
      reasonCode: "FULFILLMENT_CREATED",
      status: "APPROVED",
      supplier: created.operation.supplierId,
    };
  }

  public async executeControlledRetrieval(input: {
    readonly fulfillmentApprovalId: string;
    readonly executionToken: string;
    readonly correlationId: CorrelationId;
  }): Promise<FulfillmentExecuteResult> {
    if (
      !this.options.controlledKeyRetrievalEnabled ||
      this.options.controlledKeyRetrievalMode !==
        "CONTROLLED_VERIFICATION_ONE_TIME"
    ) {
      return {
        reasonCode: "FULFILLMENT_RETRIEVAL_DISABLED",
        status: "BLOCKED",
      };
    }
    const operations = await evaluateHighRiskOperation(
      this.options.operationsControlGate,
      "SUPPLIER_KEY_RETRIEVAL",
    );
    if (operations.status === "DENIED") {
      return { reasonCode: operations.reasonCode, status: "BLOCKED" };
    }
    await this.options.keyManagementProvider.activeMasterKeyVersion();
    const now = this.now();
    const lease = await this.options.repository.acquireRetrievalLease({
      executionToken: randomUUID(),
      fulfillmentId: input.fulfillmentApprovalId,
      now,
      staleStartedBefore: new Date(
        now.getTime() - this.options.retrievalLeaseStaleAfterMs,
      ),
      tokenHash: hashFulfillmentExecutionToken(input.executionToken),
    });
    if (lease.status === "IN_FLIGHT") {
      return resultFor(
        lease.operation,
        "FULFILLMENT_RETRIEVAL_IN_FLIGHT",
        "IN_PROGRESS",
      );
    }
    if (lease.status === "ALREADY_RETRIEVED") {
      return resultFor(
        lease.operation,
        "FULFILLMENT_ALREADY_RETRIEVED",
        "DELIVERY_PENDING",
        true,
      );
    }
    if (lease.status === "EXPIRED") {
      return resultFor(
        lease.operation,
        "FULFILLMENT_APPROVAL_EXPIRED",
        "BLOCKED",
      );
    }
    if (lease.status === "TOKEN_INVALID") {
      return resultFor(lease.operation, "FULFILLMENT_TOKEN_INVALID", "BLOCKED");
    }
    if (lease.status !== "ACQUIRED") {
      return {
        reasonCode: "FULFILLMENT_NOT_FOUND",
        status: "BLOCKED",
      };
    }
    const operation = lease.operation;
    const executionToken = requireString(operation.retrievalExecutionToken);
    const supplierResult = await this.retrieveFromSupplier(operation, input);
    if (supplierResult.status === "FAILED") {
      return this.failOwned(
        operation,
        executionToken,
        supplierResult.failureStatus,
        supplierResult.reasonCode,
      );
    }
    let keyMaterial: Uint8Array | null = null;
    try {
      if (supplierResult.status === "PENDING") {
        return this.failOwned(
          operation,
          executionToken,
          "FAILED_RETRYABLE",
          supplierResult.reasonCode,
        );
      }
      if (supplierResult.keys.length !== operation.expectedQuantity) {
        return this.failOwned(
          operation,
          executionToken,
          supplierResult.keys.length > operation.expectedQuantity
            ? "MANUAL_REVIEW_REQUIRED"
            : "FAILED_RETRYABLE",
          "FULFILLMENT_KEY_COUNT_MISMATCH",
        );
      }
      const [key] = supplierResult.keys;
      if (!key || key.material.byteLength === 0) {
        return this.failOwned(
          operation,
          executionToken,
          "FAILED_TERMINAL",
          "FULFILLMENT_SUPPLIER_RESPONSE_INVALID",
        );
      }
      keyMaterial = key.material;
      const material = await encryptFulfillmentSecret(
        keyMaterial,
        fulfillmentEncryptionContext(operation),
        this.options.keyManagementProvider,
      );
      const retrieved = await this.options.repository.markRetrieved({
        executionToken,
        fulfillmentId: operation.id,
        material,
        now: this.now(),
      });
      if (!retrieved) {
        return this.failOwned(
          operation,
          executionToken,
          "FAILED_RETRYABLE",
          "FULFILLMENT_LOCAL_PERSISTENCE_FAILED",
        );
      }
      await this.audit(
        retrieved,
        "FULFILLMENT_KEY_RETRIEVAL_SUCCEEDED",
        "SUCCEEDED",
        "FULFILLMENT_KEY_RETRIEVED",
      );
      return resultFor(
        retrieved,
        "FULFILLMENT_KEY_RETRIEVED",
        "DELIVERY_PENDING",
        true,
      );
    } catch (error) {
      const mapped = mapLocalPostRetrievalError(error);
      return this.failOwned(
        operation,
        executionToken,
        mapped.status,
        mapped.reasonCode,
      );
    } finally {
      keyMaterial?.fill(0);
    }
  }

  private async retrieveFromSupplier(
    operation: FulfillmentOperation,
    input: {
      readonly correlationId: CorrelationId;
    },
  ): Promise<
    | Awaited<ReturnType<SupplierKeyRetrievalPort["retrievePurchasedKeys"]>>
    | {
        readonly status: "FAILED";
        readonly failureStatus: Extract<
          FulfillmentStatus,
          "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "AMBIGUOUS"
        >;
        readonly reasonCode: FulfillmentReasonCode;
      }
  > {
    try {
      return await this.options.keyRetrieval.retrievePurchasedKeys({
        correlationId: input.correlationId,
        expectedQuantity: operation.expectedQuantity,
        externalSupplierOrderId: operation.externalSupplierOrderId,
        supplierId: operation.supplierId,
      });
    } catch (error) {
      const mapped = mapSupplierRetrievalError(error);
      return {
        failureStatus: mapped.status,
        reasonCode: mapped.reasonCode,
        status: "FAILED",
      };
    }
  }

  private async preparationBlocker(
    evidence: FulfillmentProcurementEvidence,
  ): Promise<FulfillmentReasonCode | null> {
    if (evidence.status !== "CONFIRMED") {
      return "PROCUREMENT_NOT_CONFIRMED";
    }
    if (!evidence.externalSupplierOrderId) {
      return "SUPPLIER_ORDER_REFERENCE_MISSING";
    }
    if (
      !evidence.supplierId ||
      evidence.supplierId !== ("kinguin" as SupplierId)
    ) {
      return "SUPPLIER_UNSUPPORTED";
    }
    if ((evidence.expectedQuantity ?? 1) !== 1) {
      return "FULFILLMENT_KEY_COUNT_MISMATCH";
    }
    await this.options.keyManagementProvider.activeMasterKeyVersion();
    const existing = evidence.controlledProcurementApprovalId
      ? await this.options.repository.findByControlledProcurementApprovalId(
          evidence.controlledProcurementApprovalId,
        )
      : null;
    if (existing?.encryptedSecretId) {
      return "FULFILLMENT_ALREADY_RETRIEVED";
    }
    return null;
  }

  private async failOwned(
    operation: FulfillmentOperation,
    executionToken: string,
    status: Extract<
      FulfillmentStatus,
      | "FAILED_RETRYABLE"
      | "FAILED_TERMINAL"
      | "AMBIGUOUS"
      | "MANUAL_REVIEW_REQUIRED"
    >,
    reasonCode: FulfillmentReasonCode,
  ): Promise<FulfillmentExecuteResult> {
    const updated = await this.options.repository.markFailed({
      executionToken,
      fulfillmentId: operation.id,
      now: this.now(),
      reasonCode,
      status,
    });
    await this.audit(
      updated ?? operation,
      "FULFILLMENT_KEY_RETRIEVAL_FAILED",
      "FAILED",
      reasonCode,
    );
    return resultFor(updated ?? operation, reasonCode, status);
  }

  private async audit(
    operation: FulfillmentOperation,
    eventType: AuditEvent["eventType"],
    outcome: AuditEvent["outcome"],
    reasonCode: string,
  ): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "secure-key-fulfillment", type: "SERVICE" },
      correlationId: operation.correlationId,
      entity: { id: operation.id, type: "FULFILLMENT_OPERATION" },
      environment: this.environment,
      eventType,
      metadata: fulfillmentAuditMetadata(operation, reasonCode),
      outcome,
      reasonCode,
      timestampUtc: this.now(),
      uuid: randomUUID(),
    });
  }
}

export const fulfillmentEncryptionContext = (
  operation: FulfillmentOperation,
): FulfillmentEncryptionContext => ({
  externalSupplierOrderId: operation.externalSupplierOrderId,
  fulfillmentId: operation.id,
  supplierId: operation.supplierId,
});

export const fulfillmentAuditMetadata = (
  operation: FulfillmentOperation,
  reasonCode: string,
): AuditEvent["metadata"] => ({
  deliveryState: operation.deliveryState,
  externalSupplierOrderId: operation.externalSupplierOrderId,
  fulfillmentId: operation.id,
  reasonCode,
  retrievalState: operation.retrievalState,
  status: operation.status,
  supplierId: operation.supplierId,
});

export const fulfillmentOutboxPayload = (
  operation: FulfillmentOperation,
): Readonly<Record<string, string | number | boolean | null>> => ({
  deliveryState: operation.deliveryState,
  fulfillmentId: operation.id,
  retrievalState: operation.retrievalState,
  status: operation.status,
  supplierId: operation.supplierId,
});

export const generateFulfillmentExecutionToken = (): string =>
  randomBytes(32).toString("base64url");

export const hashFulfillmentExecutionToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

const resultFor = (
  operation: FulfillmentOperation,
  reasonCode: FulfillmentReasonCode,
  status: FulfillmentExecuteResult["status"],
  hasEncryptedSecret = Boolean(operation.encryptedSecretId),
): FulfillmentExecuteResult => ({
  deliveryState: operation.deliveryState,
  externalSupplierOrderId: operation.externalSupplierOrderId,
  fulfillmentId: operation.id,
  hasEncryptedSecret,
  reasonCode,
  status,
  supplier: operation.supplierId,
});

const requireString = (value: string | null | undefined): string => {
  if (!value) {
    throw new Error("Required fulfillment string is missing");
  }
  return value;
};

const requireSupplier = (value: SupplierId | undefined): SupplierId => {
  if (!value) {
    throw new Error("Required supplier is missing");
  }
  return value;
};

const requireDate = (value: Date | null | undefined): Date => {
  if (!value) {
    throw new Error("Required fulfillment date is missing");
  }
  return value;
};

const mapSupplierRetrievalError = (
  error: unknown,
): {
  readonly status: "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "AMBIGUOUS";
  readonly reasonCode: FulfillmentReasonCode;
} => {
  if (error instanceof SupplierError) {
    if (["RATE_LIMIT", "TIMEOUT", "TRANSIENT"].includes(error.category)) {
      return {
        reasonCode: "FULFILLMENT_SUPPLIER_RETRYABLE",
        status: "FAILED_RETRYABLE",
      };
    }
    if (
      ["AUTHENTICATION", "AUTHORIZATION", "INVALID_RESPONSE"].includes(
        error.category,
      )
    ) {
      return {
        reasonCode:
          error.category === "INVALID_RESPONSE"
            ? "FULFILLMENT_SUPPLIER_RESPONSE_INVALID"
            : "FULFILLMENT_SUPPLIER_REJECTED",
        status: "FAILED_TERMINAL",
      };
    }
    if (["NOT_FOUND", "OUT_OF_STOCK"].includes(error.category)) {
      return {
        reasonCode: "FULFILLMENT_KEY_NOT_AVAILABLE_YET",
        status: "FAILED_RETRYABLE",
      };
    }
  }
  return {
    reasonCode: "FULFILLMENT_LOCAL_UNKNOWN",
    status: "AMBIGUOUS",
  };
};

const mapLocalPostRetrievalError = (
  error: unknown,
): {
  readonly status: "FAILED_RETRYABLE" | "MANUAL_REVIEW_REQUIRED";
  readonly reasonCode: FulfillmentReasonCode;
} => {
  if (
    error instanceof Error &&
    /key|wrap|encrypt|crypto|kms/iu.test(error.message)
  ) {
    return {
      reasonCode: "FULFILLMENT_KEY_MANAGEMENT_FAILED",
      status: "FAILED_RETRYABLE",
    };
  }
  return {
    reasonCode: "FULFILLMENT_LOCAL_PERSISTENCE_FAILED",
    status: "FAILED_RETRYABLE",
  };
};
