import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  correlationId,
  customerDeliveryAuthorization,
  customerDeliveryAuthorizationFingerprint,
  customerId,
  encryptFulfillmentSecret,
  fulfillmentEncryptionContext,
  generateCustomerDeliveryCapability,
  hashCustomerDeliveryCapability,
  orderId,
  supplierId,
  type CustomerKeyDeliveryApproval,
  type CustomerKeyDeliveryOutboxEvent,
  type FulfillmentOperation,
  type KeyManagementProvider,
  type OrderId,
} from "../../packages/platform/src/contracts.js";
import { PostgresCustomerKeyDeliveryRepository } from "./customer-key-delivery-repositories.js";
import { PostgresFulfillmentRepository } from "./fulfillment-repositories.js";
import type { Queryable, TransactionalQueryable } from "./client.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const now = new Date("2026-08-25T10:00:00.000Z");
const markerSecret = "KEYCORE_TEST_CUSTOMER_DELIVERY_PG_DO_NOT_LEAK_24680";

describe.skipIf(!connectionString)(
  "PostgresCustomerKeyDeliveryRepository",
  () => {
    it("stores one-time delivery capabilities only as hashes", async () => {
      await withDatabase(async (database) => {
        const fulfillment = await createRetrievedFulfillment(database);
        const { approval, capability } = approvalFixture(fulfillment);

        await withDeliveryRepository(database.schemaName, (repository) =>
          repository.createApproval({ approval, now }),
        );

        const serialized = await database.query<{ readonly row_json: string }>(
          `
            SELECT row_to_json(customer_key_delivery_approvals)::text AS row_json
            FROM customer_key_delivery_approvals
            WHERE id = $1
          `,
          [approval.id],
        );
        expect(serialized.rows[0]?.row_json).not.toContain(capability);
        expect(serialized.rows[0]?.row_json).toContain(
          hashCustomerDeliveryCapability(capability),
        );

        await expect(
          withDeliveryRepository(database.schemaName, (repository) =>
            repository.claimDelivery({
              approvalId: approval.id,
              channel: "FAKE",
              contextFingerprint: "b".repeat(64),
              executionToken: randomUUID(),
              now,
              staleStartedBefore: new Date(now.getTime() - 60_000),
              tokenHash: hashCustomerDeliveryCapability(capability),
            }),
          ),
        ).resolves.toMatchObject({ status: "CONTEXT_MISMATCH" });
      });
    });

    it("allows exactly one concurrent delivery claim", async () => {
      await withDatabase(async (database) => {
        const fulfillment = await createRetrievedFulfillment(database);
        const { approval, capability } = approvalFixture(fulfillment);
        await withDeliveryRepository(database.schemaName, (repository) =>
          repository.createApproval({ approval, now }),
        );

        const results = await Promise.all(
          Array.from({ length: 10 }, () =>
            withDeliveryRepository(database.schemaName, (repository) =>
              repository.claimDelivery({
                approvalId: approval.id,
                channel: "FAKE",
                contextFingerprint: approval.contextFingerprint,
                executionToken: randomUUID(),
                now,
                staleStartedBefore: new Date(now.getTime() - 60_000),
                tokenHash: hashCustomerDeliveryCapability(capability),
              }),
            ),
          ),
        );

        expect(
          results.filter((result) => result.status === "CLAIMED"),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result.status === "IN_FLIGHT"),
        ).toHaveLength(9);
      });
    });

    it("marks fulfillment delivered and emits one outbox event atomically", async () => {
      await withDatabase(async (database) => {
        const fulfillment = await createRetrievedFulfillment(database);
        const { approval, capability } = approvalFixture(fulfillment);
        await withDeliveryRepository(database.schemaName, (repository) =>
          repository.createApproval({ approval, now }),
        );
        const claim = await withDeliveryRepository(
          database.schemaName,
          (repository) =>
            repository.claimDelivery({
              approvalId: approval.id,
              channel: "FAKE",
              contextFingerprint: approval.contextFingerprint,
              executionToken: randomUUID(),
              now,
              staleStartedBefore: new Date(now.getTime() - 60_000),
              tokenHash: hashCustomerDeliveryCapability(capability),
            }),
        );
        if (claim.status !== "CLAIMED") {
          throw new Error("Expected delivery claim");
        }
        const outbox = outboxEvent(claim.attempt.fulfillmentId);

        const results = await Promise.all(
          Array.from({ length: 2 }, () =>
            withDeliveryRepository(database.schemaName, (repository) =>
              repository.markDelivered({
                attemptId: claim.attempt.id,
                deliveredAt: now,
                deliveryReference: "fake-delivery-pg-1",
                executionToken: claim.attempt.executionToken ?? "",
                outbox,
              }),
            ),
          ),
        );

        expect(results.filter(Boolean)).toHaveLength(1);
        const fulfillmentRow = await database.query<{
          readonly delivery_state: string;
          readonly status: string;
        }>(
          "SELECT status, delivery_state FROM fulfillment_operations WHERE id = $1",
          [fulfillment.id],
        );
        expect(fulfillmentRow.rows[0]).toMatchObject({
          delivery_state: "DELIVERED",
          status: "DELIVERED",
        });
        const outboxCount = await database.query<{ readonly count: string }>(
          "SELECT count(*)::text FROM outbox_events WHERE event_deduplication_key = $1",
          [outbox.eventDeduplicationKey],
        );
        expect(outboxCount.rows[0]?.count).toBe("1");
        expect(await tableText(database)).not.toContain(markerSecret);
      });
    });

    it("moves stale in-flight delivery attempts to manual review", async () => {
      await withDatabase(async (database) => {
        const fulfillment = await createRetrievedFulfillment(database);
        const { approval, capability } = approvalFixture(fulfillment);
        await withDeliveryRepository(database.schemaName, (repository) =>
          repository.createApproval({ approval, now }),
        );
        const claimed = await withDeliveryRepository(
          database.schemaName,
          (repository) =>
            repository.claimDelivery({
              approvalId: approval.id,
              channel: "FAKE",
              contextFingerprint: approval.contextFingerprint,
              executionToken: randomUUID(),
              now,
              staleStartedBefore: new Date(now.getTime() - 60_000),
              tokenHash: hashCustomerDeliveryCapability(capability),
            }),
        );
        expect(claimed.status).toBe("CLAIMED");

        await expect(
          withDeliveryRepository(database.schemaName, (repository) =>
            repository.claimDelivery({
              approvalId: approval.id,
              channel: "FAKE",
              contextFingerprint: approval.contextFingerprint,
              executionToken: randomUUID(),
              now: new Date(now.getTime() + 120_000),
              staleStartedBefore: new Date(now.getTime() + 60_000),
              tokenHash: hashCustomerDeliveryCapability(capability),
            }),
          ),
        ).resolves.toMatchObject({
          attempt: {
            failureReasonCode: "FULFILLMENT_DELIVERY_OUTCOME_UNKNOWN",
            status: "MANUAL_REVIEW_REQUIRED",
          },
          status: "MANUAL_REVIEW_REQUIRED",
        });
      });
    });
  },
);

const createRetrievedFulfillment = async (
  database: PostgresTestDatabase,
): Promise<FulfillmentOperation> => {
  const fixtureOrderId = await insertOrderFixture(database);
  const provider = new MemoryKeyProvider("delivery-pg-mk-v1");
  const operation = operationFixture(fixtureOrderId);
  const created = await withFulfillmentRepository(
    database.schemaName,
    (repository) => repository.createIdempotent({ now, operation }),
  );
  const lease = await withFulfillmentRepository(
    database.schemaName,
    (repository) =>
      repository.acquireRetrievalLease({
        executionToken: randomUUID(),
        fulfillmentId: created.operation.id,
        now,
        staleStartedBefore: new Date(now.getTime() - 60_000),
        tokenHash: created.operation.tokenHash ?? "",
      }),
  );
  if (lease.status !== "ACQUIRED") {
    throw new Error("Expected fulfillment retrieval lease");
  }
  const retrieved = await withFulfillmentRepository(
    database.schemaName,
    async (repository) =>
      repository.markRetrieved({
        executionToken: lease.operation.retrievalExecutionToken ?? "",
        fulfillmentId: created.operation.id,
        material: await encryptFulfillmentSecret(
          Buffer.from(markerSecret, "utf8"),
          fulfillmentEncryptionContext(lease.operation),
          provider,
        ),
        now,
      }),
  );
  if (!retrieved) {
    throw new Error("Expected retrieved fulfillment");
  }
  return retrieved;
};

const approvalFixture = (
  fulfillment: FulfillmentOperation,
): {
  readonly approval: CustomerKeyDeliveryApproval;
  readonly capability: string;
} => {
  const authorization = customerDeliveryAuthorization({
    customerId: customerId("customer-pg-a"),
    expiresAt: new Date(now.getTime() + 300_000),
    fulfillmentId: fulfillment.id,
    issuedAt: now,
    orderId: fulfillment.orderId ?? orderId(randomUUID()),
  });
  const capability = generateCustomerDeliveryCapability();
  return {
    approval: {
      ...authorization,
      contextFingerprint:
        customerDeliveryAuthorizationFingerprint(authorization),
      correlationId: correlationId("delivery-pg"),
      createdAt: now,
      id: randomUUID(),
      recordVersion: 1,
      status: "AUTHORIZED",
      tokenHash: hashCustomerDeliveryCapability(capability),
      updatedAt: now,
    },
    capability,
  };
};

const insertOrderFixture = async (database: Queryable): Promise<OrderId> => {
  const product = randomUUID();
  const lock = randomUUID();
  const order = randomUUID();
  await database.query(
    "INSERT INTO products(id, product_type, title, platform) VALUES ($1, 'GAME', 'Synthetic Product', 'WINDOWS')",
    [product],
  );
  await database.query(
    `
      INSERT INTO price_locks(
        id, product_id, currency, locked_sell_price_minor,
        pricing_quote_fingerprint, source_fingerprint, pricing_policy_version,
        pricing_policy_record_version, tax_policy_version, fee_policy_version,
        status, record_version, correlation_id, created_at, expires_at,
        consumed_at, reason_code
      )
      VALUES (
        $1, $2, 'EUR', 2000, 'quote', 'source', 'pricing-policy-v1',
        1, 'tax', 'fee', 'CONSUMED', 1, 'corr', $3, $4, $3,
        'PRICE_LOCK_CONSUMED'
      )
    `,
    [lock, product, now, new Date(now.getTime() + 300_000)],
  );
  await database.query(
    `
      INSERT INTO keycore_orders(
        id, product_id, price_lock_id, customer_amount_minor, currency,
        quantity, status, payment_status, procurement_status,
        fulfillment_status, risk_status, refund_status, record_version,
        idempotency_key, idempotency_fingerprint, correlation_id,
        created_at, updated_at
      )
      VALUES (
        $1, $2, $3, 2000, 'EUR', 1, 'FULFILLMENT_PENDING', 'CAPTURED',
        'SUCCEEDED', 'PENDING', 'APPROVED', 'NOT_REQUESTED',
        1, $4, 'fingerprint', 'corr', $5, $5
      )
    `,
    [order, product, lock, `idem-${order}`, now],
  );
  return orderId(order);
};

const operationFixture = (fixtureOrderId: OrderId): FulfillmentOperation => ({
  approvalExpiresAt: new Date(now.getTime() + 300_000),
  controlledProcurementApprovalId: null,
  correlationId: correlationId("delivery-pg-fulfillment"),
  createdAt: now,
  deliveryState: "NOT_READY",
  expectedQuantity: 1,
  externalSupplierOrderId: "delivery-pg-order",
  id: randomUUID(),
  orderId: fixtureOrderId,
  procurementOperationId: null,
  recordVersion: 1,
  retrievalState: "NOT_STARTED",
  status: "READY",
  supplierId: supplierId("mock-supplier"),
  supplierItemReference: "delivery-pg-offer",
  tokenHash: "a".repeat(64),
  updatedAt: now,
});

const outboxEvent = (
  fulfillmentId: string,
): CustomerKeyDeliveryOutboxEvent => ({
  aggregateId: fulfillmentId,
  aggregateType: "FULFILLMENT",
  correlationId: correlationId("delivery-pg"),
  eventDeduplicationKey: `fulfillment.delivered:${fulfillmentId}`,
  eventType: "fulfillment.delivered",
  payload: {
    deliveryReference: "fake-delivery-pg-1",
    fulfillmentId,
    status: "DELIVERED",
  },
});

const tableText = async (database: Queryable): Promise<string> => {
  const result = await database.query<{ readonly value: string }>(
    `
      SELECT jsonb_agg(row_to_json(row_data))::text AS value
      FROM (
        SELECT * FROM customer_key_delivery_approvals
        UNION ALL
        SELECT
          id, fulfillment_id, order_id, customer_id, channel AS purpose, 1 AS version,
          COALESCE(delivery_reference, '') AS token_hash,
          COALESCE(failure_reason_code, '') AS context_fingerprint,
          status, created_at AS issued_at, updated_at AS expires_at,
          delivered_at AS consumed_at, correlation_id, record_version,
          created_at, updated_at
        FROM customer_key_delivery_attempts
      ) AS row_data
    `,
  );
  return result.rows[0]?.value ?? "";
};

const withDeliveryRepository = async <TResult>(
  schemaName: string,
  action: (
    repository: PostgresCustomerKeyDeliveryRepository,
  ) => Promise<TResult>,
): Promise<TResult> => {
  if (!connectionString) {
    throw new Error("KEYCORE_TEST_DATABASE_URL is required");
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `SET search_path TO ${quoteIdentifier(schemaName)}, public`,
    );
    return await action(
      new PostgresCustomerKeyDeliveryRepository(new ClientBoundary(client)),
    );
  } finally {
    await client.end();
  }
};

const withFulfillmentRepository = async <TResult>(
  schemaName: string,
  action: (repository: PostgresFulfillmentRepository) => Promise<TResult>,
): Promise<TResult> => {
  if (!connectionString) {
    throw new Error("KEYCORE_TEST_DATABASE_URL is required");
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `SET search_path TO ${quoteIdentifier(schemaName)}, public`,
    );
    return await action(
      new PostgresFulfillmentRepository(new ClientBoundary(client)),
    );
  } finally {
    await client.end();
  }
};

const withDatabase = async (
  action: (database: PostgresTestDatabase) => Promise<void>,
): Promise<void> => {
  const database = await PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `customer_delivery_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await action(database);
  } finally {
    await database.cleanup();
  }
};

class ClientBoundary implements TransactionalQueryable {
  public constructor(private readonly client: Client) {}

  public async query<TResult extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<TResult>> {
    return this.client.query<TResult>(sql, values ? [...values] : undefined);
  }

  public async transaction<TResult>(
    callback: (client: Queryable) => Promise<TResult>,
  ): Promise<TResult> {
    await this.client.query("BEGIN");
    try {
      const result = await callback(this);
      await this.client.query("COMMIT");
      return result;
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
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
