import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  correlationId,
  supplierId,
  validateSafePayload,
  type AuditEvent,
  type AuditEventPort,
  type CorrelationId,
  type FulfillmentProcurementEvidence,
  type FulfillmentProcurementEvidencePort,
  type KeyManagementProvider,
  type RetrievedSupplierKey,
  type SupplierKeyRetrievalPort,
} from "../contracts.js";
import { SupplierError } from "../suppliers/errors.js";
import { fulfillmentConfigFromEnv } from "../../../../infra/fulfillment/fulfillment-config.js";
import { InMemoryFulfillmentRepository } from "../../../../infra/fulfillment/in-memory-fulfillment-repository.js";
import {
  SecureKeyFulfillmentService,
  canonicalFulfillmentAad,
  decryptFulfillmentSecret,
  encryptFulfillmentSecret,
  fulfillmentEncryptionAlgorithm,
  fulfillmentEncryptionContext,
  fulfillmentOutboxPayload,
} from "./secure-key-fulfillment.js";

const now = new Date("2026-08-25T10:00:00.000Z");
const canaryProductKey = [
  "KEYCORE_TEST",
  "PRODUCT",
  "KEY",
  "DO_NOT_LEAK_12345",
].join("_");
const canaryApiKey = ["SUPER", "SECRET", "API", "KEY"].join("_");
const canaryExecutionToken = ["SUPER", "SECRET", "EXEC", "TOKEN"].join("_");

describe("secure fulfillment cryptography", () => {
  it("round-trips with AES-GCM and persists key version metadata", async () => {
    const provider = new MemoryKeyProvider("fulfillment-mk-v1");
    const context = encryptionContext();
    const material = await encryptFulfillmentSecret(
      Buffer.from(canaryProductKey),
      context,
      provider,
    );

    await expect(
      decryptFulfillmentSecret(material, context, provider),
    ).resolves.toEqual(Buffer.from(canaryProductKey));
    expect(material.algorithm).toBe(fulfillmentEncryptionAlgorithm);
    expect(material.encryptionVersion).toBe(1);
    expect(material.encryptionKeyId).toBe("fulfillment-mk-v1");
  });

  it("uses random nonces and ciphertext for the same plaintext", async () => {
    const provider = new MemoryKeyProvider("fulfillment-mk-v1");
    const context = encryptionContext();
    const first = await encryptFulfillmentSecret(
      Buffer.from(canaryProductKey),
      context,
      provider,
    );
    const second = await encryptFulfillmentSecret(
      Buffer.from(canaryProductKey),
      context,
      provider,
    );

    expect(Buffer.from(first.nonce).equals(Buffer.from(second.nonce))).toBe(
      false,
    );
    expect(
      Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext)),
    ).toBe(false);
  });

  it("fails closed for tampered ciphertext, tag, wrong key and version", async () => {
    const provider = new MemoryKeyProvider("fulfillment-mk-v1");
    const context = encryptionContext();
    const material = await encryptFulfillmentSecret(
      Buffer.from(canaryProductKey),
      context,
      provider,
    );
    const tamper = (value: Uint8Array): Uint8Array => {
      const copy = Buffer.from(value);
      copy[0] = (copy[0] ?? 0) ^ 0xff;
      return copy;
    };

    await expect(
      decryptFulfillmentSecret(
        { ...material, ciphertext: tamper(material.ciphertext) },
        context,
        provider,
      ),
    ).rejects.toThrow("verification failed");
    await expect(
      decryptFulfillmentSecret(
        { ...material, authenticationTag: tamper(material.authenticationTag) },
        context,
        provider,
      ),
    ).rejects.toThrow("verification failed");
    await expect(
      decryptFulfillmentSecret(
        { ...material, encryptionKeyId: "missing-key" },
        context,
        provider,
      ),
    ).rejects.toThrow();
    await expect(
      decryptFulfillmentSecret(
        { ...material, encryptionVersion: 2 as 1 },
        context,
        provider,
      ),
    ).rejects.toThrow("Unsupported");
  });

  it("binds AAD to fulfillment ownership and contains no secret", async () => {
    const context = encryptionContext();
    const aad = Buffer.from(canonicalFulfillmentAad(context)).toString("utf8");
    expect(aad).toBe(
      JSON.stringify({
        algorithm: "AES-256-GCM-v1",
        externalSupplierOrderId: context.externalSupplierOrderId,
        fulfillmentId: context.fulfillmentId,
        purpose: "keycore-fulfillment-secret",
        supplierId: context.supplierId,
        version: 1,
      }),
    );
    expect(aad).not.toContain(canaryProductKey);
  });
});

describe("secure key fulfillment service", () => {
  it("prepares without supplier key requests and prints the token once", async () => {
    const harness = serviceHarness();
    const result = await harness.service.prepareControlledRetrieval({
      controlledProcurementApprovalId: "approval-confirmed",
      correlationId: correlationId("prepare"),
    });

    expect(result.status).toBe("APPROVED");
    expect(result.oneTimeExecutionToken).toEqual(expect.any(String));
    expect(result.message).toBe("NO PRODUCT KEY HAS BEEN RETRIEVED.");
    expect(harness.keyRetrieval.calls).toHaveLength(0);
    expect(JSON.stringify(harness.repository)).not.toContain(
      result.oneTimeExecutionToken,
    );
  });

  it("blocks unconfirmed procurement, missing supplier order and unsupported suppliers", async () => {
    const harness = serviceHarness({
      evidence: { status: "UNCONFIRMED" },
    });
    await expect(
      harness.service.prepareControlledRetrieval({
        controlledProcurementApprovalId: "approval-unconfirmed",
        correlationId: correlationId("prepare"),
      }),
    ).resolves.toMatchObject({
      reasonCode: "PROCUREMENT_NOT_CONFIRMED",
      status: "BLOCKED",
    });

    const missingOrder = serviceHarness({
      evidence: { ...confirmedEvidence(), externalSupplierOrderId: null },
    });
    await expect(
      missingOrder.service.prepareControlledRetrieval({
        controlledProcurementApprovalId: "approval-missing-order",
        correlationId: correlationId("prepare"),
      }),
    ).resolves.toMatchObject({
      reasonCode: "SUPPLIER_ORDER_REFERENCE_MISSING",
      status: "BLOCKED",
    });

    const unsupported = serviceHarness({
      evidence: { ...confirmedEvidence(), supplierId: supplierId("gamivo") },
    });
    await expect(
      unsupported.service.prepareControlledRetrieval({
        controlledProcurementApprovalId: "approval-unsupported",
        correlationId: correlationId("prepare"),
      }),
    ).resolves.toMatchObject({
      reasonCode: "SUPPLIER_UNSUPPORTED",
      status: "BLOCKED",
    });
  });

  it("rejects missing crypto configuration before creating approval", async () => {
    const harness = serviceHarness({
      keyManagementProvider: new RejectingKeyProvider(),
    });

    await expect(
      harness.service.prepareControlledRetrieval({
        controlledProcurementApprovalId: "approval-confirmed",
        correlationId: correlationId("prepare"),
      }),
    ).rejects.toThrow("missing");
    expect(harness.repository.operations.size).toBe(0);
  });

  it("requires opt-in, correct token, unexpired approval and single-use execution", async () => {
    const disabled = serviceHarness({ controlledKeyRetrievalEnabled: false });
    const prepared = await disabled.service.prepareControlledRetrieval({
      controlledProcurementApprovalId: "approval-confirmed",
      correlationId: correlationId("prepare"),
    });
    await expect(
      disabled.service.executeControlledRetrieval({
        correlationId: correlationId("execute"),
        executionToken: prepared.oneTimeExecutionToken ?? "",
        fulfillmentApprovalId: prepared.fulfillmentApprovalId ?? "",
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_RETRIEVAL_DISABLED",
      status: "BLOCKED",
    });

    const wrong = serviceHarness();
    const wrongPrepared = await wrong.service.prepareControlledRetrieval({
      controlledProcurementApprovalId: "approval-confirmed",
      correlationId: correlationId("prepare"),
    });
    await expect(
      wrong.service.executeControlledRetrieval({
        correlationId: correlationId("execute"),
        executionToken: "wrong-token",
        fulfillmentApprovalId: wrongPrepared.fulfillmentApprovalId ?? "",
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_TOKEN_INVALID",
      status: "BLOCKED",
    });

    const expired = serviceHarness({
      now: () => new Date(now.getTime() + 1_000_000),
    });
    const repository = new InMemoryFulfillmentRepository();
    const expiring = serviceHarness({ repository });
    const expiringPrepared = await expiring.service.prepareControlledRetrieval({
      controlledProcurementApprovalId: "approval-confirmed",
      correlationId: correlationId("prepare"),
    });
    await expect(
      expired.serviceWith(repository).executeControlledRetrieval({
        correlationId: correlationId("execute"),
        executionToken: expiringPrepared.oneTimeExecutionToken ?? "",
        fulfillmentApprovalId: expiringPrepared.fulfillmentApprovalId ?? "",
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_APPROVAL_EXPIRED",
      status: "BLOCKED",
    });
  });

  it("encrypts successful fake retrieval, leaves delivery pending and uses retrieval reason", async () => {
    const audit = new CapturingAudit();
    const key = retrievedKey();
    const harness = serviceHarness({
      audit,
      keyRetrieval: new StaticKeyRetrieval([key]),
    });
    const prepared = await harness.service.prepareControlledRetrieval({
      controlledProcurementApprovalId: "approval-confirmed",
      correlationId: correlationId("prepare"),
    });

    const result = await harness.service.executeControlledRetrieval({
      correlationId: correlationId("execute"),
      executionToken: prepared.oneTimeExecutionToken ?? "",
      fulfillmentApprovalId: prepared.fulfillmentApprovalId ?? "",
    });
    const operation = await harness.repository.findById(
      prepared.fulfillmentApprovalId ?? "",
    );
    const secret = await harness.repository.findSecretByFulfillmentId(
      prepared.fulfillmentApprovalId ?? "",
    );

    expect(result).toMatchObject({
      deliveryState: "PENDING",
      hasEncryptedSecret: true,
      reasonCode: "FULFILLMENT_KEY_RETRIEVED",
      status: "DELIVERY_PENDING",
    });
    expect(operation?.retrievalState).toBe("RETRIEVED");
    expect(operation?.deliveryState).toBe("PENDING");
    expect(operation?.status).toBe("DELIVERY_PENDING");
    expect(secret?.encryptionKeyId).toBe("fulfillment-mk-v1");
    expect(JSON.stringify(operation)).not.toContain(canaryProductKey);
    expect(JSON.stringify(secret)).not.toContain(canaryProductKey);
    if (!operation || !secret) {
      throw new Error("Expected encrypted fulfillment state");
    }

    const decrypted = await decryptFulfillmentSecret(
      secret,
      fulfillmentEncryptionContext(operation),
      harness.keyManagementProvider,
    );
    expect(Buffer.from(decrypted).toString("utf8")).toBe(canaryProductKey);
    expect(Buffer.from(key.material).every((byte) => byte === 0)).toBe(true);
    expect(audit.events.map((event) => event.reasonCode)).toEqual([
      "FULFILLMENT_CREATED",
      "FULFILLMENT_KEY_RETRIEVED",
    ]);
    expect(audit.events.at(-1)?.metadata).toEqual({
      deliveryState: "PENDING",
      externalSupplierOrderId: "GE1373B866F3",
      fulfillmentId: operation.id,
      reasonCode: "FULFILLMENT_KEY_RETRIEVED",
      retrievalState: "RETRIEVED",
      status: "DELIVERY_PENDING",
      supplierId: "kinguin",
    });
  });

  it("prevents duplicate retrieval after encrypted secret exists", async () => {
    const harness = serviceHarness();
    const prepared = await harness.service.prepareControlledRetrieval({
      controlledProcurementApprovalId: "approval-confirmed",
      correlationId: correlationId("prepare"),
    });
    await harness.service.executeControlledRetrieval({
      correlationId: correlationId("execute"),
      executionToken: prepared.oneTimeExecutionToken ?? "",
      fulfillmentApprovalId: prepared.fulfillmentApprovalId ?? "",
    });

    await expect(
      harness.service.executeControlledRetrieval({
        correlationId: correlationId("execute-again"),
        executionToken: prepared.oneTimeExecutionToken ?? "",
        fulfillmentApprovalId: prepared.fulfillmentApprovalId ?? "",
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_ALREADY_RETRIEVED",
      status: "DELIVERY_PENDING",
    });
    expect(harness.keyRetrieval.calls).toHaveLength(1);
  });

  it("allows only one concurrent retrieval owner", async () => {
    const harness = serviceHarness({
      keyRetrieval: new PendingKeyRetrieval(),
    });
    const prepared = await harness.service.prepareControlledRetrieval({
      controlledProcurementApprovalId: "approval-confirmed",
      correlationId: correlationId("prepare"),
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        harness.service.executeControlledRetrieval({
          correlationId: correlationId(`execute-${index}`),
          executionToken: prepared.oneTimeExecutionToken ?? "",
          fulfillmentApprovalId: prepared.fulfillmentApprovalId ?? "",
        }),
      ),
    );

    expect(
      results.filter((result) => result.status === "IN_PROGRESS"),
    ).toHaveLength(7);
    expect(
      results.filter((result) => result.status === "FAILED_RETRYABLE"),
    ).toHaveLength(1);
  });

  it("performs at most one supplier key request per explicit execution", async () => {
    const keyRetrieval = new ThrowingKeyRetrieval(
      new SupplierError({
        category: "TIMEOUT",
        operation: "downloadKeys",
        supplierId: supplierId("kinguin"),
      }),
    );
    const harness = serviceHarness({ keyRetrieval });
    const prepared = await harness.service.prepareControlledRetrieval({
      controlledProcurementApprovalId: "approval-confirmed",
      correlationId: correlationId("prepare"),
    });

    await expect(
      harness.service.executeControlledRetrieval({
        correlationId: correlationId("execute"),
        executionToken: prepared.oneTimeExecutionToken ?? "",
        fulfillmentApprovalId: prepared.fulfillmentApprovalId ?? "",
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_SUPPLIER_RETRYABLE",
      status: "FAILED_RETRYABLE",
    });
    expect(keyRetrieval.calls).toHaveLength(1);
  });

  it("handles zero keys, multiple keys, malformed and pending supplier responses safely", async () => {
    for (const [keyRetrieval, expected] of [
      [
        new StaticKeyRetrieval([]),
        {
          reasonCode: "FULFILLMENT_KEY_COUNT_MISMATCH",
          status: "FAILED_RETRYABLE",
        },
      ],
      [
        new StaticKeyRetrieval([retrievedKey(), retrievedKey("second")]),
        {
          reasonCode: "FULFILLMENT_KEY_COUNT_MISMATCH",
          status: "MANUAL_REVIEW_REQUIRED",
        },
      ],
      [
        new StaticKeyRetrieval([
          { ...retrievedKey(), material: new Uint8Array() },
        ]),
        {
          reasonCode: "FULFILLMENT_SUPPLIER_RESPONSE_INVALID",
          status: "FAILED_TERMINAL",
        },
      ],
      [
        new PendingKeyRetrieval(),
        {
          reasonCode: "FULFILLMENT_KEY_NOT_AVAILABLE_YET",
          status: "FAILED_RETRYABLE",
        },
      ],
    ] as const) {
      const harness = serviceHarness({ keyRetrieval });
      const prepared = await harness.service.prepareControlledRetrieval({
        controlledProcurementApprovalId: randomUUID(),
        correlationId: correlationId("prepare"),
      });
      await expect(
        harness.service.executeControlledRetrieval({
          correlationId: correlationId("execute"),
          executionToken: prepared.oneTimeExecutionToken ?? "",
          fulfillmentApprovalId: prepared.fulfillmentApprovalId ?? "",
        }),
      ).resolves.toMatchObject(expected);
    }
  });

  it("maps documented safe supplier failures without leaking supplier detail", async () => {
    for (const [error, expected] of [
      [
        new SupplierError({
          category: "TIMEOUT",
          operation: "downloadKeys",
          supplierId: supplierId("kinguin"),
        }),
        {
          reasonCode: "FULFILLMENT_SUPPLIER_RETRYABLE",
          status: "FAILED_RETRYABLE",
        },
      ],
      [
        new SupplierError({
          category: "INVALID_RESPONSE",
          operation: "downloadKeys",
          supplierId: supplierId("kinguin"),
        }),
        {
          reasonCode: "FULFILLMENT_SUPPLIER_RESPONSE_INVALID",
          status: "FAILED_TERMINAL",
        },
      ],
      [
        new SupplierError({
          category: "AUTHENTICATION",
          operation: "downloadKeys",
          supplierId: supplierId("kinguin"),
        }),
        {
          reasonCode: "FULFILLMENT_SUPPLIER_REJECTED",
          status: "FAILED_TERMINAL",
        },
      ],
    ] as const) {
      const harness = serviceHarness({
        keyRetrieval: new ThrowingKeyRetrieval(error),
      });
      const prepared = await harness.service.prepareControlledRetrieval({
        controlledProcurementApprovalId: randomUUID(),
        correlationId: correlationId("prepare"),
      });
      await expect(
        harness.service.executeControlledRetrieval({
          correlationId: correlationId("execute"),
          executionToken: prepared.oneTimeExecutionToken ?? "",
          fulfillmentApprovalId: prepared.fulfillmentApprovalId ?? "",
        }),
      ).resolves.toMatchObject(expected);
    }
  });

  it("classifies KMS failures and local persistence failures separately from supplier failures", async () => {
    const kms = serviceHarness({
      keyManagementProvider: new WrapRejectingKeyProvider(),
    });
    const kmsPrepared = await kms.service.prepareControlledRetrieval({
      controlledProcurementApprovalId: "approval-kms",
      correlationId: correlationId("prepare"),
    });
    await expect(
      kms.service.executeControlledRetrieval({
        correlationId: correlationId("execute"),
        executionToken: kmsPrepared.oneTimeExecutionToken ?? "",
        fulfillmentApprovalId: kmsPrepared.fulfillmentApprovalId ?? "",
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_KEY_MANAGEMENT_FAILED",
      status: "FAILED_RETRYABLE",
    });

    const persistenceRepository = new MarkRetrievedNullRepository();
    const persistence = serviceHarness({ repository: persistenceRepository });
    const persistencePrepared =
      await persistence.service.prepareControlledRetrieval({
        controlledProcurementApprovalId: "approval-persistence",
        correlationId: correlationId("prepare"),
      });
    await expect(
      persistence.service.executeControlledRetrieval({
        correlationId: correlationId("execute"),
        executionToken: persistencePrepared.oneTimeExecutionToken ?? "",
        fulfillmentApprovalId: persistencePrepared.fulfillmentApprovalId ?? "",
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_LOCAL_PERSISTENCE_FAILED",
      status: "FAILED_RETRYABLE",
    });
  });

  it("does not classify unknown local exceptions as supplier retryable", async () => {
    const harness = serviceHarness({
      keyRetrieval: new ThrowingKeyRetrieval(new Error("programming bug")),
    });
    const prepared = await harness.service.prepareControlledRetrieval({
      controlledProcurementApprovalId: "approval-unknown",
      correlationId: correlationId("prepare"),
    });

    await expect(
      harness.service.executeControlledRetrieval({
        correlationId: correlationId("execute"),
        executionToken: prepared.oneTimeExecutionToken ?? "",
        fulfillmentApprovalId: prepared.fulfillmentApprovalId ?? "",
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_LOCAL_UNKNOWN",
      status: "AMBIGUOUS",
    });
  });

  it("allows stale retryable recovery because Kinguin key retrieval is documented repeatable read-only", async () => {
    const repository = new InMemoryFulfillmentRepository();
    const firstKeyRetrieval = new ThrowingKeyRetrieval(
      new SupplierError({
        category: "TIMEOUT",
        operation: "downloadKeys",
        supplierId: supplierId("kinguin"),
      }),
    );
    const first = serviceHarness({
      keyRetrieval: firstKeyRetrieval,
      repository,
    });
    const prepared = await first.service.prepareControlledRetrieval({
      controlledProcurementApprovalId: "approval-stale-recovery",
      correlationId: correlationId("prepare"),
    });
    await first.service.executeControlledRetrieval({
      correlationId: correlationId("execute-timeout"),
      executionToken: prepared.oneTimeExecutionToken ?? "",
      fulfillmentApprovalId: prepared.fulfillmentApprovalId ?? "",
    });

    const retryKeyRetrieval = new StaticKeyRetrieval([retrievedKey()]);
    const retry = serviceHarness({
      keyRetrieval: retryKeyRetrieval,
      repository,
    });
    await expect(
      retry.service.executeControlledRetrieval({
        correlationId: correlationId("execute-retry"),
        executionToken: prepared.oneTimeExecutionToken ?? "",
        fulfillmentApprovalId: prepared.fulfillmentApprovalId ?? "",
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_KEY_RETRIEVED",
      status: "DELIVERY_PENDING",
    });
    expect(firstKeyRetrieval.calls).toHaveLength(1);
    expect(retryKeyRetrieval.calls).toHaveLength(1);
  });

  it("keeps product keys and fake supplier secrets out of audit, queue payloads, CLI-shaped output and errors", async () => {
    const audit = new CapturingAudit();
    const harness = serviceHarness({
      audit,
      keyRetrieval: new StaticKeyRetrieval([
        retrievedKey(
          `prefix ${canaryProductKey} api-key=${canaryApiKey} execution-token=${canaryExecutionToken}`,
        ),
      ]),
    });
    const prepared = await harness.service.prepareControlledRetrieval({
      controlledProcurementApprovalId: "approval-confirmed",
      correlationId: correlationId("prepare"),
    });
    const result = await harness.service.executeControlledRetrieval({
      correlationId: correlationId("execute"),
      executionToken: prepared.oneTimeExecutionToken ?? "",
      fulfillmentApprovalId: prepared.fulfillmentApprovalId ?? "",
    });
    const operation = await harness.repository.findById(
      prepared.fulfillmentApprovalId ?? "",
    );
    const queuePayload = validateSafePayload({
      fulfillmentId: operation?.id ?? null,
      status: operation?.status ?? null,
    });
    const outboxPayload = operation ? fulfillmentOutboxPayload(operation) : {};
    const serialized = JSON.stringify({
      audit: audit.events,
      operation,
      outboxPayload,
      queuePayload,
      result,
    });

    expect(serialized).not.toContain(canaryProductKey);
    expect(serialized).not.toContain(canaryApiKey);
    expect(serialized).not.toContain(canaryExecutionToken);
    expect(serialized).not.toMatch(/ciphertext|nonce|tag|wrapped/i);
  });

  it("uses a documented finite 10s default timeout for controlled key retrieval", () => {
    const config = fulfillmentConfigFromEnv(fulfillmentEnv());
    expect(config.keyRetrievalTimeoutMs).toBe(10_000);
    expect(() =>
      fulfillmentConfigFromEnv({
        ...fulfillmentEnv(),
        KINGUIN_CONTROLLED_KEY_RETRIEVAL_TIMEOUT_MS: "0",
      }),
    ).toThrow("KINGUIN_CONTROLLED_KEY_RETRIEVAL_TIMEOUT_MS_INVALID");
  });
});

const confirmedEvidence = (): FulfillmentProcurementEvidence => ({
  controlledProcurementApprovalId: "approval-confirmed",
  expectedQuantity: 1,
  externalSupplierOrderId: "GE1373B866F3",
  status: "CONFIRMED",
  supplierId: supplierId("kinguin"),
});

const encryptionContext = () => ({
  externalSupplierOrderId: "GE1373B866F3",
  fulfillmentId: randomUUID(),
  supplierId: supplierId("kinguin"),
});

const retrievedKey = (value = canaryProductKey): RetrievedSupplierKey => ({
  contentType: "text/plain",
  material: Buffer.from(value, "utf8"),
  supplierKeyId: `key-${randomUUID()}`,
});

const serviceHarness = (
  options: {
    readonly audit?: AuditEventPort;
    readonly controlledKeyRetrievalEnabled?: boolean;
    readonly evidence?: FulfillmentProcurementEvidence;
    readonly keyManagementProvider?: KeyManagementProvider;
    readonly keyRetrieval?: SupplierKeyRetrievalPort & {
      readonly calls: readonly unknown[];
    };
    readonly now?: () => Date;
    readonly repository?: InMemoryFulfillmentRepository;
  } = {},
) => {
  const repository = options.repository ?? new InMemoryFulfillmentRepository();
  const keyManagementProvider =
    options.keyManagementProvider ?? new MemoryKeyProvider("fulfillment-mk-v1");
  const evidence = options.evidence ?? confirmedEvidence();
  const keyRetrieval =
    options.keyRetrieval ?? new StaticKeyRetrieval([retrievedKey()]);
  const buildService = (repo: InMemoryFulfillmentRepository) =>
    new SecureKeyFulfillmentService({
      approvalTtlMs: 300_000,
      controlledKeyRetrievalEnabled:
        options.controlledKeyRetrievalEnabled ?? true,
      controlledKeyRetrievalMode: "CONTROLLED_VERIFICATION_ONE_TIME",
      environment: "CI",
      keyManagementProvider,
      keyRetrieval,
      now: options.now ?? (() => now),
      procurementEvidence: new StaticEvidence(evidence),
      repository: repo,
      retrievalLeaseStaleAfterMs: 60_000,
      ...(options.audit ? { audit: options.audit } : {}),
    });
  return {
    keyManagementProvider,
    keyRetrieval,
    repository,
    service: buildService(repository),
    serviceWith: buildService,
  };
};

class StaticEvidence implements FulfillmentProcurementEvidencePort {
  public constructor(
    private readonly evidence: FulfillmentProcurementEvidence,
  ) {}

  public async getControlledProcurementEvidence(
    approvalId: string,
  ): Promise<FulfillmentProcurementEvidence> {
    return {
      controlledProcurementApprovalId: approvalId,
      ...this.evidence,
    };
  }
}

class StaticKeyRetrieval implements SupplierKeyRetrievalPort {
  public readonly calls: unknown[] = [];

  public constructor(private readonly keys: readonly RetrievedSupplierKey[]) {}

  public async retrievePurchasedKeys(input: {
    readonly supplierId: ReturnType<typeof supplierId>;
    readonly externalSupplierOrderId: string;
    readonly expectedQuantity: number;
    readonly correlationId: CorrelationId;
  }) {
    this.calls.push(input);
    return { keys: this.keys, status: "RETRIEVED" as const };
  }
}

class PendingKeyRetrieval implements SupplierKeyRetrievalPort {
  public readonly calls: unknown[] = [];

  public async retrievePurchasedKeys(input: {
    readonly supplierId: ReturnType<typeof supplierId>;
    readonly externalSupplierOrderId: string;
    readonly expectedQuantity: number;
    readonly correlationId: CorrelationId;
  }) {
    this.calls.push(input);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      reasonCode: "FULFILLMENT_KEY_NOT_AVAILABLE_YET" as const,
      status: "PENDING" as const,
    };
  }
}

class ThrowingKeyRetrieval implements SupplierKeyRetrievalPort {
  public readonly calls: unknown[] = [];

  public constructor(private readonly error: Error) {}

  public async retrievePurchasedKeys(input: {
    readonly supplierId: ReturnType<typeof supplierId>;
    readonly externalSupplierOrderId: string;
    readonly expectedQuantity: number;
    readonly correlationId: CorrelationId;
  }): Promise<never> {
    this.calls.push(input);
    throw this.error;
  }
}

class MemoryKeyProvider implements KeyManagementProvider {
  public constructor(private readonly keyId: string) {}

  public async activeMasterKeyVersion(): Promise<string> {
    return this.keyId;
  }

  public async wrapDataKey(request: { readonly dataKey: Uint8Array }) {
    return {
      keyVersion: this.keyId,
      wrappedDataKey: Buffer.from(request.dataKey).map((byte) => byte ^ 0xa5),
    };
  }

  public async unwrapDataKey(request: {
    readonly wrappedDataKey: Uint8Array;
    readonly keyVersion: string;
  }) {
    if (request.keyVersion !== this.keyId) {
      throw new Error("wrong key");
    }
    return Buffer.from(request.wrappedDataKey).map((byte) => byte ^ 0xa5);
  }

  public async getKeyVersionMetadata() {
    return { provider: "memory", version: this.keyId };
  }
}

class RejectingKeyProvider extends MemoryKeyProvider {
  public constructor() {
    super("rejecting");
  }

  public override async activeMasterKeyVersion(): Promise<string> {
    throw new Error("missing fulfillment master key");
  }
}

class WrapRejectingKeyProvider extends MemoryKeyProvider {
  public constructor() {
    super("wrapping-failure");
  }

  public override async wrapDataKey(): Promise<never> {
    throw new Error("kms wrap failed");
  }
}

class MarkRetrievedNullRepository extends InMemoryFulfillmentRepository {
  public override async markRetrieved(): Promise<null> {
    return null;
  }
}

class CapturingAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

const fulfillmentEnv = (): Readonly<Record<string, string>> => ({
  KEYCORE_FULFILLMENT_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  KEYCORE_FULFILLMENT_MASTER_KEY_ID: "test-fulfillment-v1",
});
