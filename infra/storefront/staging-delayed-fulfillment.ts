import { createHash, randomUUID } from "node:crypto";

import {
  supplierId,
  type AdminPrincipal,
  type CorrelationId,
  type FulfillmentOperation,
  type KeyCoreOrder,
  type OrderId,
} from "../../packages/platform/src/contracts.js";
import { encryptFulfillmentSecret } from "../../packages/platform/src/fulfillment/secure-key-fulfillment.js";
import { DevelopmentKeyManagementProvider } from "../key-management/development-provider.js";
import type { Queryable, TransactionalQueryable } from "../postgres/client.js";
import { PostgresFulfillmentRepository } from "../postgres/fulfillment-repositories.js";
import { PostgresAuditEventRepository } from "../postgres/repositories.js";
import { createStagingOrderOrchestration } from "./staging-checkout.js";
import type { StagingReadinessNotificationPort } from "./staging-mailpit.js";

export type StagingDelayedFulfillmentResult =
  | { readonly status: "COMPLETED" | "ALREADY_COMPLETED" }
  | { readonly status: "DENIED"; readonly reasonCode: string };

export interface StagingDelayedFulfillmentPort {
  complete(input: {
    readonly orderId: OrderId;
    readonly principal: AdminPrincipal;
    readonly correlationId: CorrelationId;
  }): Promise<StagingDelayedFulfillmentResult>;
}

export class PostgresStagingDelayedFulfillment implements StagingDelayedFulfillmentPort {
  private readonly keyManagement: DevelopmentKeyManagementProvider;

  public constructor(
    private readonly options: {
      readonly database: TransactionalQueryable;
      readonly masterKeyMaterialBase64: string;
      readonly masterKeyVersion: string;
      readonly notification: StagingReadinessNotificationPort;
      readonly syntheticKey: string;
      readonly now?: () => Date;
    },
  ) {
    if (
      !options.syntheticKey.startsWith("SYNTHETIC_") ||
      options.syntheticKey.length > 128
    ) {
      throw new Error("Bounded synthetic staging material is required");
    }
    this.keyManagement = new DevelopmentKeyManagementProvider({
      environmentName: "staging",
      masterKeyMaterialBase64: options.masterKeyMaterialBase64,
      masterKeyVersion: options.masterKeyVersion,
    });
  }

  public complete(input: {
    readonly orderId: OrderId;
    readonly principal: AdminPrincipal;
    readonly correlationId: CorrelationId;
  }): Promise<StagingDelayedFulfillmentResult> {
    return this.options.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 12007))",
        [input.orderId],
      );
      const database = nestedBoundary(client);
      const now = this.options.now ?? (() => new Date());
      const { orders } = createStagingOrderOrchestration(database, now);
      let order = await orders.getOrder(input.orderId);
      if (
        !order ||
        !order.idempotencyKey.startsWith("staging:checkout:order:")
      ) {
        return { reasonCode: "STAGING_ORDER_NOT_ELIGIBLE", status: "DENIED" };
      }
      const fulfillmentId = deterministicUuid(
        `staging-fulfillment:${order.id}`,
      );
      const fulfillment = new PostgresFulfillmentRepository(database);
      if (order.status === "COMPLETED") {
        const existing = await fulfillment.findById(fulfillmentId);
        return existing?.encryptedSecretId
          ? { status: "ALREADY_COMPLETED" }
          : {
              reasonCode: "STAGING_FULFILLMENT_STATE_CONFLICT",
              status: "DENIED",
            };
      }
      if (
        !order.customerId ||
        !order.checkoutEmailNormalized ||
        order.paymentStatus !== "CAPTURED" ||
        order.riskStatus !== "APPROVED" ||
        order.procurementStatus !== "NOT_STARTED" ||
        order.fulfillmentStatus !== "NOT_STARTED" ||
        order.status !== "PAYMENT_CAPTURED"
      ) {
        return { reasonCode: "STAGING_ORDER_NOT_ELIGIBLE", status: "DENIED" };
      }
      const notificationEmail = order.checkoutEmailNormalized;

      for (const transition of [
        (current: KeyCoreOrder) =>
          orders.markProcurementPending({
            correlationId: input.correlationId,
            expectedVersion: current.recordVersion,
            orderId: current.id,
          }),
        (current: KeyCoreOrder) =>
          orders.beginProcurement({
            correlationId: input.correlationId,
            expectedVersion: current.recordVersion,
            orderId: current.id,
          }),
        (current: KeyCoreOrder) =>
          orders.recordProcurementResult({
            correlationId: input.correlationId,
            expectedVersion: current.recordVersion,
            orderId: current.id,
            procurementStatus: "SUCCEEDED",
          }),
        (current: KeyCoreOrder) =>
          orders.markFulfillmentPending({
            correlationId: input.correlationId,
            expectedVersion: current.recordVersion,
            orderId: current.id,
          }),
      ]) {
        const result = await transition(order);
        if (result.status !== "UPDATED") {
          throw new Error("STAGING_ORDER_TRANSITION_FAILED");
        }
        order = await orders.getOrder(input.orderId);
        if (!order) throw new Error("STAGING_ORDER_UNAVAILABLE");
      }

      const at = now();
      const token = randomUUID();
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const operation: FulfillmentOperation = {
        approvalExpiresAt: new Date(at.getTime() + 10 * 60_000),
        correlationId: input.correlationId,
        createdAt: at,
        deliveryState: "NOT_READY",
        expectedQuantity: 1,
        externalSupplierOrderId: `staging-${order.id}`,
        id: fulfillmentId,
        orderId: order.id,
        recordVersion: 1,
        retrievalState: "NOT_STARTED",
        status: "READY",
        supplierId: supplierId("staging-synthetic"),
        tokenHash,
        updatedAt: at,
      };
      await fulfillment.createIdempotent({ operation, now: at });
      const lease = await fulfillment.acquireRetrievalLease({
        executionToken: randomUUID(),
        fulfillmentId,
        now: at,
        staleStartedBefore: new Date(at.getTime() - 60_000),
        tokenHash,
      });
      if (
        lease.status !== "ACQUIRED" ||
        !lease.operation.retrievalExecutionToken
      ) {
        throw new Error("STAGING_FULFILLMENT_LEASE_FAILED");
      }
      const plaintext = Buffer.from(this.options.syntheticKey, "utf8");
      try {
        const material = await encryptFulfillmentSecret(
          plaintext,
          {
            externalSupplierOrderId: operation.externalSupplierOrderId,
            fulfillmentId,
            supplierId: operation.supplierId,
          },
          this.keyManagement,
        );
        const retrieved = await fulfillment.markRetrieved({
          executionToken: lease.operation.retrievalExecutionToken,
          fulfillmentId,
          material,
          now: at,
        });
        if (!retrieved?.encryptedSecretId) {
          throw new Error("STAGING_FULFILLMENT_PERSIST_FAILED");
        }
      } finally {
        plaintext.fill(0);
      }

      const completed = await orders.recordFulfillmentResult({
        correlationId: input.correlationId,
        expectedVersion: order.recordVersion,
        fulfillmentStatus: "SUCCEEDED",
        orderId: order.id,
      });
      if (completed.status !== "UPDATED") {
        throw new Error("STAGING_FULFILLMENT_COMPLETION_FAILED");
      }
      const notified = await this.options.notification.sendReady({
        correlationId: input.correlationId,
        emailNormalized: notificationEmail,
        orderId: order.id,
      });
      if (notified.status !== "ACCEPTED") {
        throw new Error("STAGING_READINESS_NOTIFICATION_FAILED");
      }
      await new PostgresAuditEventRepository(database).append({
        actor: { id: input.principal.adminId, type: "ADMIN" },
        correlationId: input.correlationId,
        entity: { id: order.id, type: "ORDER" },
        environment: "STAGING",
        eventType: "FULFILLMENT_STAGING_COMPLETED",
        metadata: { mode: "SYNTHETIC_STAGING" },
        outcome: "SUCCEEDED",
        reasonCode: "STAGING_DELAYED_FULFILLMENT_COMPLETED",
        timestampUtc: at,
        uuid: randomUUID(),
      });
      return { status: "COMPLETED" };
    });
  }
}

const nestedBoundary = (client: Queryable): TransactionalQueryable => ({
  query: (text, values) => client.query(text, values),
  transaction: (callback) => callback(client),
});

const deterministicUuid = (value: string): string => {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
