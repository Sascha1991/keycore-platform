import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

const allowOperations = {
  evaluate: async () => ({ status: "ALLOWED" as const }),
};

import type { OperationsControlGate } from "../operations/operations-controls.js";

import {
  correlationId,
  customerId,
  orderId,
  supplierId,
  validateSafePayload,
  type AuditEvent,
  type AuditEventPort,
  type CorrelationId,
  type CustomerDeliveryAuthorization,
  type CustomerKeyDeliveryAttempt,
  type CustomerKeyDeliveryPort,
  type CustomerKeyDeliveryPortResult,
  type CustomerKeyDeliveryReasonCode,
  type CustomerKeyDeliveryRepository,
  type CustomerKeyDeliveryStatus,
  type CustomerOrderAuthorizationPort,
  type FulfillmentOperation,
  type KeyManagementProvider,
} from "../contracts.js";
import { InMemoryCustomerKeyDeliveryRepository } from "../../../../infra/fulfillment/in-memory-customer-key-delivery-repository.js";
import { InMemoryFulfillmentRepository } from "../../../../infra/fulfillment/in-memory-fulfillment-repository.js";
import {
  encryptFulfillmentSecret,
  fulfillmentEncryptionContext,
} from "./secure-key-fulfillment.js";
import {
  CustomerKeyDeliveryError,
  CustomerKeyDeliveryService,
  customerDeliverySafeInspect,
} from "./customer-key-delivery.js";

const now = new Date("2026-08-25T10:00:00.000Z");
const markerSecret = [
  "KEYCORE_TEST",
  "CUSTOMER_DELIVERY_SECRET",
  "DO_NOT_LEAK_98765",
].join("_");
const protectedRealFulfillmentId = "fd61be5e-44ea-4914-98ae-c4404dc31779";

describe("customer key delivery foundation", () => {
  it("authorizes only through trusted order ownership and never raw ids alone", async () => {
    const unknown = await serviceHarness({
      authorization: new StaticOrderAuthorization(false),
    });

    await expect(
      unknown.service.prepareDelivery({
        correlationId: correlationId("delivery-auth"),
        customerId: customerId("customer-a"),
        fulfillmentId: unknown.fulfillment.id,
        orderId: unknown.fulfillment.orderId ?? orderId("missing"),
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_DELIVERY_UNAUTHORIZED",
      status: "BLOCKED",
    });

    const wrongOrder = await serviceHarness();
    await expect(
      wrongOrder.service.prepareDelivery({
        correlationId: correlationId("delivery-auth"),
        customerId: customerId("customer-a"),
        fulfillmentId: wrongOrder.fulfillment.id,
        orderId: orderId(randomUUID()),
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_DELIVERY_NOT_READY",
      status: "BLOCKED",
    });
  });

  it("creates a high-entropy one-time capability and stores only the hash", async () => {
    const harness = await serviceHarness();

    const prepared = await prepare(harness);

    expect(prepared.status).toBe("AUTHORIZED");
    expect(prepared.oneTimeCapability).toEqual(expect.any(String));
    expect(prepared.oneTimeCapability?.length).toBeGreaterThanOrEqual(40);
    expect(JSON.stringify(harness.deliveryRepository.approvals)).not.toContain(
      prepared.oneTimeCapability,
    );
    expect(
      [...harness.deliveryRepository.approvals.values()][0]?.tokenHash,
    ).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects expired, consumed and modified authorization contexts", async () => {
    const expired = await serviceHarness({
      executeNow: () => new Date(now.getTime() + 301_000),
    });
    const expiredPrepared = await prepare(expired);
    await expect(
      expired.executeService.executeDelivery({
        capability: expiredPrepared.oneTimeCapability ?? "",
        channel: "FAKE",
        correlationId: correlationId("delivery-execute"),
        customerId: expired.customerId,
        deliveryApprovalId: expiredPrepared.deliveryApprovalId ?? "",
        fulfillmentId: expired.fulfillment.id,
        orderId: expired.orderId,
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_DELIVERY_AUTHORIZATION_EXPIRED",
      status: "BLOCKED",
    });

    const consumed = await serviceHarness();
    const consumedPrepared = await prepare(consumed);
    await consumed.service.executeDelivery({
      capability: consumedPrepared.oneTimeCapability ?? "",
      channel: "FAKE",
      correlationId: correlationId("delivery-execute"),
      customerId: consumed.customerId,
      deliveryApprovalId: consumedPrepared.deliveryApprovalId ?? "",
      fulfillmentId: consumed.fulfillment.id,
      orderId: consumed.orderId,
    });
    await expect(
      consumed.service.executeDelivery({
        capability: consumedPrepared.oneTimeCapability ?? "",
        channel: "FAKE",
        correlationId: correlationId("delivery-execute-again"),
        customerId: consumed.customerId,
        deliveryApprovalId: consumedPrepared.deliveryApprovalId ?? "",
        fulfillmentId: consumed.fulfillment.id,
        orderId: consumed.orderId,
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_ALREADY_DELIVERED",
      status: "ALREADY_DELIVERED",
    });

    const modified = await serviceHarness();
    const modifiedPrepared = await prepare(modified);
    await expect(
      modified.service.executeDelivery({
        capability: modifiedPrepared.oneTimeCapability ?? "",
        channel: "FAKE",
        correlationId: correlationId("delivery-execute"),
        customerId: customerId("customer-b"),
        deliveryApprovalId: modifiedPrepared.deliveryApprovalId ?? "",
        fulfillmentId: modified.fulfillment.id,
        orderId: modified.orderId,
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_DELIVERY_CONTEXT_MISMATCH",
      status: "BLOCKED",
    });
  });

  it("decrypts only after authorization and delivers through the final boundary", async () => {
    const audit = new CapturingAudit();
    const harness = await serviceHarness({ audit });
    const prepared = await prepare(harness);

    const result = await harness.service.executeDelivery({
      capability: prepared.oneTimeCapability ?? "",
      channel: "FAKE",
      correlationId: correlationId("delivery-execute"),
      customerId: harness.customerId,
      deliveryApprovalId: prepared.deliveryApprovalId ?? "",
      fulfillmentId: harness.fulfillment.id,
      orderId: harness.orderId,
    });

    expect(result).toMatchObject({
      channel: "FAKE",
      deliveryReference: "fake-delivery-1",
      reasonCode: "FULFILLMENT_DELIVERED",
      status: "DELIVERED",
    });
    expect(harness.deliveryPort.calls).toHaveLength(1);
    expect(harness.deliveryPort.lastPlaintextSeen).toBe(markerSecret);
    expect(harness.deliveryPort.returnedResults[0]).not.toHaveProperty("key");
    const delivered = await harness.fulfillmentRepository.findById(
      harness.fulfillment.id,
    );
    expect(delivered).toMatchObject({
      deliveredAt: expect.any(Date),
      deliveryState: "DELIVERED",
      status: "DELIVERED",
    });
    const serialized = JSON.stringify({
      audit: audit.events,
      outbox: harness.deliveryRepository.outbox,
      result,
      safeInspect: customerDeliverySafeInspect({
        fulfillment: delivered ?? harness.fulfillment,
        latestAttempt:
          await harness.deliveryRepository.findLatestAttemptByFulfillmentId(
            harness.fulfillment.id,
          ),
        secret: await harness.fulfillmentRepository.findSecretByFulfillmentId(
          harness.fulfillment.id,
        ),
      }),
    });
    expect(serialized).not.toContain(markerSecret);
    expect(serialized).not.toMatch(/ciphertext|nonce|tag|wrapped|capability/i);
    validateSafePayload(harness.deliveryRepository.outbox[0]?.payload ?? {});
  });

  it("does not consume capability, decrypt or deliver while operations are paused", async () => {
    const harness = await serviceHarness({
      operationsControlGate: {
        evaluate: async () => ({
          reasonCode: "OPERATIONS_CONTROL_PAUSED",
          status: "DENIED",
        }),
      },
    });
    const prepared = await prepare(harness);
    await expect(
      harness.service.executeDelivery({
        capability: prepared.oneTimeCapability ?? "",
        channel: "FAKE",
        correlationId: correlationId("delivery-paused"),
        customerId: harness.customerId,
        deliveryApprovalId: prepared.deliveryApprovalId ?? "",
        fulfillmentId: harness.fulfillment.id,
        orderId: harness.orderId,
      }),
    ).resolves.toMatchObject({
      reasonCode: "OPERATIONS_CONTROL_PAUSED",
      status: "BLOCKED",
    });
    expect(harness.deliveryPort.calls).toHaveLength(0);
    expect(harness.keyManagementProvider.unwraps).toBe(0);
    await expect(
      harness.deliveryRepository.findLatestAttemptByFulfillmentId(
        harness.fulfillment.id,
      ),
    ).resolves.toBeNull();
  });

  it("already delivered status does not decrypt or redeliver", async () => {
    const harness = await serviceHarness();
    const prepared = await prepare(harness);
    await harness.service.executeDelivery({
      capability: prepared.oneTimeCapability ?? "",
      channel: "FAKE",
      correlationId: correlationId("delivery-execute"),
      customerId: harness.customerId,
      deliveryApprovalId: prepared.deliveryApprovalId ?? "",
      fulfillmentId: harness.fulfillment.id,
      orderId: harness.orderId,
    });

    await expect(
      harness.service.executeDelivery({
        capability: prepared.oneTimeCapability ?? "",
        channel: "FAKE",
        correlationId: correlationId("delivery-execute-again"),
        customerId: harness.customerId,
        deliveryApprovalId: prepared.deliveryApprovalId ?? "",
        fulfillmentId: harness.fulfillment.id,
        orderId: harness.orderId,
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_ALREADY_DELIVERED",
      status: "ALREADY_DELIVERED",
    });
    expect(harness.deliveryPort.calls).toHaveLength(1);
    expect(harness.keyManagementProvider.unwraps).toBe(1);
  });

  it("classifies delivery provider and crypto failures without leaking plaintext", async () => {
    for (const [deliveryPort, expected] of [
      [
        new FakeDeliveryPort(new CustomerKeyDeliveryError("RETRYABLE")),
        {
          reasonCode: "FULFILLMENT_DELIVERY_RETRYABLE",
          status: "FAILED_RETRYABLE",
        },
      ],
      [
        new FakeDeliveryPort(new CustomerKeyDeliveryError("REJECTED")),
        {
          reasonCode: "FULFILLMENT_DELIVERY_REJECTED",
          status: "FAILED_TERMINAL",
        },
      ],
      [
        new FakeDeliveryPort(new CustomerKeyDeliveryError("AMBIGUOUS")),
        {
          reasonCode: "FULFILLMENT_DELIVERY_OUTCOME_UNKNOWN",
          status: "MANUAL_REVIEW_REQUIRED",
        },
      ],
    ] as const) {
      const harness = await serviceHarness({ deliveryPort });
      const prepared = await prepare(harness);
      await expect(
        harness.service.executeDelivery({
          capability: prepared.oneTimeCapability ?? "",
          channel: "FAKE",
          correlationId: correlationId("delivery-execute"),
          customerId: harness.customerId,
          deliveryApprovalId: prepared.deliveryApprovalId ?? "",
          fulfillmentId: harness.fulfillment.id,
          orderId: harness.orderId,
        }),
      ).resolves.toMatchObject(expected);
      expect(JSON.stringify(harness.deliveryRepository)).not.toContain(
        markerSecret,
      );
    }

    const crypto = await serviceHarness({
      executeKeyManagementProvider: new CountingKeyProvider("wrong-key"),
    });
    const prepared = await prepare(crypto);
    await expect(
      crypto.executeService.executeDelivery({
        capability: prepared.oneTimeCapability ?? "",
        channel: "FAKE",
        correlationId: correlationId("delivery-execute"),
        customerId: crypto.customerId,
        deliveryApprovalId: prepared.deliveryApprovalId ?? "",
        fulfillmentId: crypto.fulfillment.id,
        orderId: crypto.orderId,
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_KEY_MANAGEMENT_FAILED",
      status: "FAILED_RETRYABLE",
    });
  });

  it("fresh in-flight cannot be stolen and stale in-flight becomes manual review", async () => {
    const blockedPort = new HangingDeliveryPort();
    const harness = await serviceHarness({ deliveryPort: blockedPort });
    const prepared = await prepare(harness);
    void harness.service.executeDelivery({
      capability: prepared.oneTimeCapability ?? "",
      channel: "FAKE",
      correlationId: correlationId("delivery-execute"),
      customerId: harness.customerId,
      deliveryApprovalId: prepared.deliveryApprovalId ?? "",
      fulfillmentId: harness.fulfillment.id,
      orderId: harness.orderId,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(
      harness.service.executeDelivery({
        capability: prepared.oneTimeCapability ?? "",
        channel: "FAKE",
        correlationId: correlationId("delivery-concurrent"),
        customerId: harness.customerId,
        deliveryApprovalId: prepared.deliveryApprovalId ?? "",
        fulfillmentId: harness.fulfillment.id,
        orderId: harness.orderId,
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_DELIVERY_IN_FLIGHT",
      status: "IN_FLIGHT",
    });

    const stale = await serviceHarness({
      deliveryLeaseStaleAfterMs: 1,
      deliveryPort: new HangingDeliveryPort(),
      executeNow: () => new Date(now.getTime() + 5_000),
    });
    const stalePrepared = await prepare(stale);
    void stale.service.executeDelivery({
      capability: stalePrepared.oneTimeCapability ?? "",
      channel: "FAKE",
      correlationId: correlationId("delivery-execute-stale"),
      customerId: stale.customerId,
      deliveryApprovalId: stalePrepared.deliveryApprovalId ?? "",
      fulfillmentId: stale.fulfillment.id,
      orderId: stale.orderId,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(
      stale.executeService.executeDelivery({
        capability: stalePrepared.oneTimeCapability ?? "",
        channel: "FAKE",
        correlationId: correlationId("delivery-stale"),
        customerId: stale.customerId,
        deliveryApprovalId: stalePrepared.deliveryApprovalId ?? "",
        fulfillmentId: stale.fulfillment.id,
        orderId: stale.orderId,
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_DELIVERY_OUTCOME_UNKNOWN",
      status: "MANUAL_REVIEW_REQUIRED",
    });
  });

  it("treats post-dispatch local persistence failure as possible delivery", async () => {
    const audit = new CapturingAudit();
    const deliveryPort = new FakeDeliveryPort();
    const harness = await serviceHarness({
      audit,
      deliveryPort,
      deliveryRepositoryFactory: (repository) =>
        new FailingDeliveryRepository(repository, {
          markDelivered: "throw",
        }),
    });
    const prepared = await prepare(harness);

    const result = await harness.service.executeDelivery({
      capability: prepared.oneTimeCapability ?? "",
      channel: "FAKE",
      correlationId: correlationId("delivery-post-dispatch-failure"),
      customerId: harness.customerId,
      deliveryApprovalId: prepared.deliveryApprovalId ?? "",
      fulfillmentId: harness.fulfillment.id,
      orderId: harness.orderId,
    });

    expect(result).toMatchObject({
      reasonCode: "FULFILLMENT_DELIVERY_OUTCOME_UNKNOWN",
      status: "MANUAL_REVIEW_REQUIRED",
    });
    expect(deliveryPort.calls).toHaveLength(1);
    await expect(
      harness.deliveryRepository.findLatestAttemptByFulfillmentId(
        harness.fulfillment.id,
      ),
    ).resolves.toMatchObject({
      failureReasonCode: "FULFILLMENT_DELIVERY_OUTCOME_UNKNOWN",
      status: "MANUAL_REVIEW_REQUIRED",
    });
    expect(
      safeSerialized({
        audit: audit.events,
        deliveryRepository: harness.deliveryRepository,
        result,
      }),
    ).not.toContain(markerSecret);

    await harness.service.executeDelivery({
      capability: prepared.oneTimeCapability ?? "",
      channel: "FAKE",
      correlationId: correlationId("delivery-post-dispatch-reentry"),
      customerId: harness.customerId,
      deliveryApprovalId: prepared.deliveryApprovalId ?? "",
      fulfillmentId: harness.fulfillment.id,
      orderId: harness.orderId,
    });
    expect(deliveryPort.calls).toHaveLength(1);
  });

  it("does not mask possible delivery when manual-review persistence also fails", async () => {
    const deliveryPort = new InspectingDeliveryPort();
    const harness = await serviceHarness({
      deliveryPort,
      deliveryLeaseStaleAfterMs: 1,
      deliveryRepositoryFactory: (repository) =>
        new FailingDeliveryRepository(repository, {
          markDelivered: "throw",
          markFailed: "throw",
        }),
    });
    const prepared = await prepare(harness);

    const result = await harness.service.executeDelivery({
      capability: prepared.oneTimeCapability ?? "",
      channel: "FAKE",
      correlationId: correlationId("delivery-post-dispatch-double-failure"),
      customerId: harness.customerId,
      deliveryApprovalId: prepared.deliveryApprovalId ?? "",
      fulfillmentId: harness.fulfillment.id,
      orderId: harness.orderId,
    });

    expect(result).toMatchObject({
      reasonCode: "FULFILLMENT_DELIVERY_OUTCOME_UNKNOWN",
      status: "MANUAL_REVIEW_REQUIRED",
    });
    expect(deliveryPort.calls).toHaveLength(1);
    expect(deliveryPort.lastPlaintextBuffer).toBeTruthy();
    expect(deliveryPort.lastPlaintextBuffer?.toString("utf8")).not.toContain(
      markerSecret,
    );
    expect(safeSerialized({ result })).not.toContain(markerSecret);

    await expect(
      harness.service.executeDelivery({
        capability: prepared.oneTimeCapability ?? "",
        channel: "FAKE",
        correlationId: correlationId("delivery-post-dispatch-fresh-reentry"),
        customerId: harness.customerId,
        deliveryApprovalId: prepared.deliveryApprovalId ?? "",
        fulfillmentId: harness.fulfillment.id,
        orderId: harness.orderId,
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_DELIVERY_IN_FLIGHT",
      status: "IN_FLIGHT",
    });

    const staleService = harness.createService({
      deliveryRepository: harness.deliveryRepository,
      now: () => new Date(now.getTime() + 5_000),
    });
    await expect(
      staleService.executeDelivery({
        capability: prepared.oneTimeCapability ?? "",
        channel: "FAKE",
        correlationId: correlationId("delivery-post-dispatch-stale-reentry"),
        customerId: harness.customerId,
        deliveryApprovalId: prepared.deliveryApprovalId ?? "",
        fulfillmentId: harness.fulfillment.id,
        orderId: harness.orderId,
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_DELIVERY_OUTCOME_UNKNOWN",
      status: "MANUAL_REVIEW_REQUIRED",
    });
    expect(deliveryPort.calls).toHaveLength(1);
  });

  it("blocks the protected real fulfillment unless the live gate is explicit", async () => {
    const harness = await serviceHarness({
      fulfillmentId: protectedRealFulfillmentId,
      protectedFulfillmentIds: [protectedRealFulfillmentId],
    });

    await expect(
      harness.service.prepareDelivery({
        correlationId: correlationId("delivery-real-blocked"),
        customerId: harness.customerId,
        fulfillmentId: protectedRealFulfillmentId,
        orderId: harness.orderId,
      }),
    ).resolves.toMatchObject({
      reasonCode: "FULFILLMENT_LIVE_DELIVERY_DISABLED",
      status: "BLOCKED",
    });
    expect(harness.deliveryPort.calls).toHaveLength(0);
    expect(harness.keyManagementProvider.unwraps).toBe(0);
  });
});

const prepare = (harness: Awaited<ReturnType<typeof serviceHarness>>) =>
  harness.service.prepareDelivery({
    correlationId: correlationId("delivery-prepare"),
    customerId: harness.customerId,
    fulfillmentId: harness.fulfillment.id,
    orderId: harness.orderId,
  });

const serviceHarness = async (
  options: {
    readonly authorization?: CustomerOrderAuthorizationPort;
    readonly deliveryLeaseStaleAfterMs?: number;
    readonly deliveryPort?: FakeDeliveryPort;
    readonly deliveryRepositoryFactory?: (
      repository: InMemoryCustomerKeyDeliveryRepository,
    ) => CustomerKeyDeliveryRepository;
    readonly audit?: AuditEventPort;
    readonly executeKeyManagementProvider?: CountingKeyProvider;
    readonly executeNow?: () => Date;
    readonly fulfillmentId?: string;
    readonly protectedFulfillmentIds?: readonly string[];
    readonly operationsControlGate?: OperationsControlGate;
  } = {},
) => {
  const fulfillmentRepository = new InMemoryFulfillmentRepository();
  const deliveryRepository = new InMemoryCustomerKeyDeliveryRepository(
    fulfillmentRepository,
  );
  const serviceDeliveryRepository =
    options.deliveryRepositoryFactory?.(deliveryRepository) ??
    deliveryRepository;
  const keyManagementProvider = new CountingKeyProvider("delivery-mk-v1");
  const executeKeyManagementProvider =
    options.executeKeyManagementProvider ?? keyManagementProvider;
  const customer = customerId("customer-a");
  const order = orderId(randomUUID());
  const fulfillment = fulfillmentFixture(order, options.fulfillmentId);
  const material = await encryptFulfillmentSecret(
    Buffer.from(markerSecret, "utf8"),
    fulfillmentEncryptionContext(fulfillment),
    keyManagementProvider,
  );
  await fulfillmentRepository.createIdempotent({ now, operation: fulfillment });
  await fulfillmentRepository.markRetrieved({
    executionToken: fulfillment.retrievalExecutionToken ?? "",
    fulfillmentId: fulfillment.id,
    material,
    now,
  });
  const retrieved = await fulfillmentRepository.findById(fulfillment.id);
  if (!retrieved) {
    throw new Error("Expected retrieved fulfillment");
  }
  const deliveryPort = options.deliveryPort ?? new FakeDeliveryPort();
  const common = {
    approvalTtlMs: 300_000,
    deliveryLeaseStaleAfterMs: options.deliveryLeaseStaleAfterMs ?? 60_000,
    deliveryPort,
    deliveryRepository: serviceDeliveryRepository,
    environment: "CI" as const,
    fulfillmentRepository,
    orderAuthorization:
      options.authorization ?? new StaticOrderAuthorization(true),
    operationsControlGate: options.operationsControlGate ?? allowOperations,
    protectedFulfillmentIds: options.protectedFulfillmentIds ?? [],
    ...(options.audit ? { audit: options.audit } : {}),
  };
  return {
    customerId: customer,
    deliveryPort,
    deliveryRepository,
    createService: (overrides: {
      readonly deliveryRepository?: CustomerKeyDeliveryRepository;
      readonly now?: () => Date;
    }) =>
      new CustomerKeyDeliveryService({
        ...common,
        deliveryRepository:
          overrides.deliveryRepository ?? serviceDeliveryRepository,
        keyManagementProvider,
        now: overrides.now ?? (() => now),
      }),
    executeService: new CustomerKeyDeliveryService({
      ...common,
      keyManagementProvider: executeKeyManagementProvider,
      now: options.executeNow ?? (() => now),
    }),
    fulfillment: retrieved,
    fulfillmentRepository,
    keyManagementProvider,
    orderId: order,
    service: new CustomerKeyDeliveryService({
      ...common,
      keyManagementProvider,
      now: () => now,
    }),
  };
};

const fulfillmentFixture = (
  fixtureOrderId: ReturnType<typeof orderId>,
  id: string = randomUUID(),
): FulfillmentOperation => ({
  approvalExpiresAt: new Date(now.getTime() + 300_000),
  controlledProcurementApprovalId: null,
  correlationId: correlationId("delivery-fixture"),
  createdAt: now,
  deliveryState: "NOT_READY",
  expectedQuantity: 1,
  externalSupplierOrderId: "supplier-order-delivery-fixture",
  id,
  orderId: fixtureOrderId,
  procurementOperationId: randomUUID(),
  recordVersion: 1,
  retrievalExecutionToken: randomUUID(),
  retrievalStartedAt: now,
  retrievalState: "IN_FLIGHT",
  status: "RETRIEVAL_IN_FLIGHT",
  supplierId: supplierId("mock-supplier"),
  supplierItemReference: "offer-delivery-fixture",
  tokenHash: "a".repeat(64),
  updatedAt: now,
});

class StaticOrderAuthorization implements CustomerOrderAuthorizationPort {
  public constructor(private readonly authorized: boolean) {}

  public async authorizeDelivery() {
    return { status: this.authorized ? "AUTHORIZED" : "DENIED" } as const;
  }
}

class FakeDeliveryPort implements CustomerKeyDeliveryPort {
  public readonly calls: CustomerDeliveryAuthorization[] = [];
  public readonly returnedResults: CustomerKeyDeliveryPortResult[] = [];
  public lastPlaintextSeen: string | null = null;

  public constructor(private readonly failure?: CustomerKeyDeliveryError) {}

  public async deliver(input: {
    readonly authorization: CustomerDeliveryAuthorization;
    readonly plaintext: Buffer;
    readonly correlationId: CorrelationId;
  }): Promise<CustomerKeyDeliveryPortResult> {
    this.calls.push(input.authorization);
    this.lastPlaintextSeen = input.plaintext.toString("utf8");
    if (this.failure) {
      throw this.failure;
    }
    const result = {
      channel: "FAKE",
      deliveredAt: now,
      deliveryReference: `fake-delivery-${this.calls.length}`,
      status: "DELIVERED",
    } as const;
    this.returnedResults.push(result);
    return result;
  }
}

class HangingDeliveryPort extends FakeDeliveryPort {
  public override async deliver(input: {
    readonly authorization: CustomerDeliveryAuthorization;
    readonly plaintext: Buffer;
    readonly correlationId: CorrelationId;
  }): Promise<CustomerKeyDeliveryPortResult> {
    this.calls.push(input.authorization);
    this.lastPlaintextSeen = input.plaintext.toString("utf8");
    return new Promise(() => undefined);
  }
}

class CountingKeyProvider implements KeyManagementProvider {
  public unwraps = 0;

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
    this.unwraps += 1;
    if (request.keyVersion !== this.keyId) {
      throw new Error("wrong delivery key");
    }
    return Buffer.from(request.wrappedDataKey).map((byte) => byte ^ 0xa5);
  }

  public async getKeyVersionMetadata() {
    return { provider: "memory", version: this.keyId };
  }
}

class CapturingAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];

  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class FailingDeliveryRepository implements CustomerKeyDeliveryRepository {
  public constructor(
    private readonly delegate: CustomerKeyDeliveryRepository,
    private readonly failures: {
      readonly markDelivered?: "throw";
      readonly markFailed?: "throw";
    },
  ) {}

  public createApproval(
    input: Parameters<CustomerKeyDeliveryRepository["createApproval"]>[0],
  ) {
    return this.delegate.createApproval(input);
  }

  public claimDelivery(
    input: Parameters<CustomerKeyDeliveryRepository["claimDelivery"]>[0],
  ) {
    return this.delegate.claimDelivery(input);
  }

  public async markDelivered(
    _input: Parameters<CustomerKeyDeliveryRepository["markDelivered"]>[0],
  ): Promise<CustomerKeyDeliveryAttempt | null> {
    if (this.failures.markDelivered === "throw") {
      throw new Error("synthetic post-dispatch persistence failure");
    }
    return this.delegate.markDelivered(_input);
  }

  public async markFailed(input: {
    readonly attemptId: string;
    readonly executionToken: string;
    readonly status: Extract<
      CustomerKeyDeliveryStatus,
      | "FAILED_RETRYABLE"
      | "FAILED_TERMINAL"
      | "AMBIGUOUS"
      | "MANUAL_REVIEW_REQUIRED"
    >;
    readonly reasonCode: CustomerKeyDeliveryReasonCode;
    readonly now: Date;
  }): Promise<CustomerKeyDeliveryAttempt | null> {
    if (this.failures.markFailed === "throw") {
      throw new Error("synthetic manual-review persistence failure");
    }
    return this.delegate.markFailed(input);
  }

  public findLatestAttemptByFulfillmentId(
    fulfillmentId: string,
  ): Promise<CustomerKeyDeliveryAttempt | null> {
    return this.delegate.findLatestAttemptByFulfillmentId(fulfillmentId);
  }
}

class InspectingDeliveryPort extends FakeDeliveryPort {
  public lastPlaintextBuffer: Buffer | null = null;

  public override async deliver(input: {
    readonly authorization: CustomerDeliveryAuthorization;
    readonly plaintext: Buffer;
    readonly correlationId: CorrelationId;
  }): Promise<CustomerKeyDeliveryPortResult> {
    this.lastPlaintextBuffer = input.plaintext;
    return super.deliver(input);
  }
}

const safeSerialized = (value: unknown): string =>
  JSON.stringify(value, (_key, current) =>
    typeof current === "bigint" ? current.toString() : current,
  );
