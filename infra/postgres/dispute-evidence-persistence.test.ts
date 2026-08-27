import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  DisputeEvidenceService,
  correlationId,
  type DisputeEvidenceExportAuthorityPort,
  type DisputeEvidenceFinalizationAuthorityPort,
  type OrderId,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";
import { PostgresDisputeEvidenceRepository } from "./dispute-evidence-repositories.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const now = new Date("2026-08-27T13:00:00.000Z");

describePostgres("PostgresDisputeEvidenceRepository", () => {
  it("persists idempotent dispute evidence snapshots from valid order and payment facts", async () => {
    const database = await initDatabase();
    try {
      const order = await insertDisputeFixture(database);
      const service = serviceFor(
        new PostgresDisputeEvidenceRepository(
          new TestTransactionBoundary(database),
        ),
      );

      const first = await service.buildDraft({
        correlationId: correlationId("pg-dispute-first"),
        orderId: order,
      });
      const repeated = await service.buildDraft({
        correlationId: correlationId("pg-dispute-repeat"),
        orderId: order,
      });

      expect(first).toMatchObject({ status: "CREATED" });
      expect(repeated).toMatchObject({ status: "EXISTING" });
      const firstSnapshot = requiredSnapshot(first);
      const repeatedSnapshot = requiredSnapshot(repeated);
      expect(repeatedSnapshot.evidenceSnapshotId).toBe(
        firstSnapshot.evidenceSnapshotId,
      );
      await expect(snapshotCount(database, order)).resolves.toBe("1");
      expect(JSON.stringify(firstSnapshot.sections)).not.toContain(
        "pi_pg_dispute_",
      );
      expect(JSON.stringify(firstSnapshot.sections)).not.toContain("token");
      expect(JSON.stringify(firstSnapshot.sections)).not.toContain("secret");
    } finally {
      await database.cleanup();
    }
  });

  it("enforces exact order binding and finalized snapshot immutability", async () => {
    const database = await initDatabase();
    try {
      const order = await insertDisputeFixture(database);
      const otherOrder = await insertDisputeFixture(database);
      const trusted = serviceFor(
        new PostgresDisputeEvidenceRepository(
          new TestTransactionBoundary(database),
        ),
        {
          exportAuthority: new TrustedExportAuthority(),
          finalizationAuthority: new TrustedFinalizationAuthority(),
        },
      );
      const draft = requiredSnapshot(
        await trusted.buildDraft({
          correlationId: correlationId("pg-dispute-final-create"),
          orderId: order,
        }),
      );

      await expect(
        trusted.finalizeSnapshot({
          correlationId: correlationId("pg-dispute-finalize"),
          orderId: order,
          snapshotId: draft.evidenceSnapshotId,
        }),
      ).resolves.toMatchObject({
        snapshot: { state: "FINALIZED" },
        status: "FINALIZED",
      });
      await expect(
        trusted.exportSnapshot({
          correlationId: correlationId("pg-dispute-export-wrong-order"),
          orderId: otherOrder,
          snapshotId: draft.evidenceSnapshotId,
        }),
      ).resolves.toEqual({
        reasonCode: "DISPUTE_EVIDENCE_ORDER_MISMATCH",
        status: "ORDER_MISMATCH",
      });
      await expect(
        database.query(
          "UPDATE dispute_evidence_snapshots SET sections = '[]'::jsonb WHERE id = $1",
          [draft.evidenceSnapshotId],
        ),
      ).rejects.toThrow("Finalized dispute evidence snapshots are immutable");
    } finally {
      await database.cleanup();
    }
  });

  it("uses per-order serialization for concurrent draft persistence", async () => {
    const database = await initDatabase();
    try {
      const order = await insertDisputeFixture(database);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_value, index) =>
          withRepository(database.schemaName, (repository) =>
            serviceFor(repository).buildDraft({
              correlationId: correlationId(`pg-dispute-race-${index}`),
              orderId: order,
            }),
          ),
        ),
      );

      expect(
        results.filter((result) => result.status === "CREATED"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "EXISTING"),
      ).toHaveLength(5);
      expect(
        new Set(
          results.map((result) => requiredSnapshot(result).evidenceSnapshotId),
        ).size,
      ).toBe(1);
      await expect(snapshotCount(database, order)).resolves.toBe("1");
    } finally {
      await database.cleanup();
    }
  });

  it("fails closed instead of persisting when mandatory payment facts are absent", async () => {
    const database = await initDatabase();
    try {
      const order = await insertDisputeFixture(database, {
        includePayment: false,
      });
      const result = await serviceFor(
        new PostgresDisputeEvidenceRepository(
          new TestTransactionBoundary(database),
        ),
      ).buildDraft({
        correlationId: correlationId("pg-dispute-no-payment"),
        orderId: order,
      });

      expect(result).toEqual({
        reasonCode: "DISPUTE_EVIDENCE_MANDATORY_FACT_UNAVAILABLE",
        status: "UNAVAILABLE",
      });
      await expect(snapshotCount(database, order)).resolves.toBe("0");
    } finally {
      await database.cleanup();
    }
  });
});

const initDatabase = async (): Promise<PostgresTestDatabase> =>
  PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `dispute_evidence_${randomUUID().replaceAll("-", "_")}`,
  });

const insertDisputeFixture = async (
  database: PostgresTestDatabase,
  input: { readonly includePayment?: boolean } = {},
): Promise<OrderId> => {
  const productId = randomUUID();
  const priceLockId = randomUUID();
  const customerId = randomUUID();
  const orderIdValue = randomUUID() as OrderId;
  const paymentId = randomUUID();
  await database.query(
    "INSERT INTO products(id, product_type, title, platform) VALUES ($1, 'DIGITAL_KEY', 'Dispute Fixture', 'PC')",
    [productId],
  );
  await database.query(
    `
      INSERT INTO price_locks(
        id, product_id, currency, locked_sell_price_minor, pricing_quote_fingerprint,
        source_fingerprint, pricing_policy_version, pricing_policy_record_version,
        tax_policy_version, fee_policy_version, status, record_version,
        idempotency_key, idempotency_fingerprint, correlation_id, created_at, expires_at
      )
      VALUES ($1, $2, 'EUR', 2999, $3, $4, 'pricing-v1', 1, 'tax-v1', 'fee-v1',
        'CONSUMED', 1, $5, $6, 'pg-dispute-correlation', $7, $8)
    `,
    [
      priceLockId,
      productId,
      `quote-${priceLockId}`,
      `source-${priceLockId}`,
      `lock-${priceLockId}`,
      `fingerprint-${priceLockId}`,
      now,
      new Date(now.getTime() + 60_000),
    ],
  );
  await database.query(
    `
      INSERT INTO keycore_customers(
        id, email_normalized, email_verification_state, record_version,
        created_at, updated_at
      )
      VALUES ($1, 'dispute-customer@example.test', 'VERIFIED', 1, $2, $2)
    `,
    [customerId, now],
  );
  await database.query(
    `
      INSERT INTO keycore_orders(
        id, product_id, price_lock_id, customer_id, checkout_email_normalized,
        customer_amount_minor, currency, quantity, status, payment_status,
        procurement_status, fulfillment_status, risk_status, refund_status,
        record_version, idempotency_key, idempotency_fingerprint, correlation_id,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, 'dispute-customer@example.test', 2999, 'EUR', 1,
        'COMPLETED', 'CAPTURED', 'SUCCEEDED', 'SUCCEEDED', 'APPROVED',
        'NOT_REQUESTED', 1, $5, $6, 'pg-dispute-order', $7, $7)
    `,
    [
      orderIdValue,
      productId,
      priceLockId,
      customerId,
      `order-${orderIdValue}`,
      `fingerprint-${orderIdValue}`,
      now,
    ],
  );
  if (input.includePayment ?? true) {
    await database.query(
      `
        INSERT INTO order_payments(
          id, order_id, provider, external_payment_id, amount_minor, currency,
          status, record_version, operation_version, stripe_idempotency_key,
          provider_fingerprint, reconciliation_required, created_at, updated_at,
          last_provider_event_at
        )
        VALUES ($1, $2, 'STRIPE', $3, 2999, 'EUR', 'CAPTURED', 1, 1, $4,
          'provider-fingerprint', false, $5, $5, $5)
      `,
      [
        paymentId,
        orderIdValue,
        `pi_pg_dispute_${paymentId}`,
        `stripe-idempotency-${paymentId}`,
        now,
      ],
    );
  }
  await database.query(
    `
      INSERT INTO audit_events(
        event_type, timestamp_utc, actor, correlation_id, entity, environment,
        outcome, reason_code, metadata
      )
      VALUES (
        'PAYMENT_CAPTURED', $1, '{"type":"SERVICE","id":"stripe"}'::jsonb,
        'pg-dispute-audit', jsonb_build_object('type', 'ORDER', 'id', $2::text),
        'TEST', 'SUCCEEDED', 'PAYMENT_CAPTURED', '{}'::jsonb
      )
    `,
    [now, orderIdValue],
  );
  return orderIdValue;
};

const serviceFor = (
  repository: PostgresDisputeEvidenceRepository,
  overrides: {
    readonly exportAuthority?: DisputeEvidenceExportAuthorityPort;
    readonly finalizationAuthority?: DisputeEvidenceFinalizationAuthorityPort;
  } = {},
): DisputeEvidenceService =>
  new DisputeEvidenceService({
    ...(overrides.exportAuthority
      ? { exportAuthority: overrides.exportAuthority }
      : {}),
    ...(overrides.finalizationAuthority
      ? { finalizationAuthority: overrides.finalizationAuthority }
      : {}),
    environment: "CI",
    now: () => now,
    repository,
  });

const snapshotCount = async (
  database: PostgresTestDatabase,
  orderIdValue: OrderId,
): Promise<string> => {
  const result = await database.query<{ readonly count: string }>(
    "SELECT count(*)::text FROM dispute_evidence_snapshots WHERE order_id = $1",
    [orderIdValue],
  );
  return result.rows[0]?.count ?? "0";
};

const withRepository = async <TResult>(
  schemaName: string,
  action: (repository: PostgresDisputeEvidenceRepository) => Promise<TResult>,
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
      new PostgresDisputeEvidenceRepository(new ClientBoundary(client)),
    );
  } finally {
    await client.end();
  }
};

const requiredSnapshot = (
  result: Awaited<ReturnType<DisputeEvidenceService["buildDraft"]>>,
) => {
  if (result.status !== "CREATED" && result.status !== "EXISTING") {
    throw new Error(`Expected snapshot result, got ${result.status}`);
  }
  return result.snapshot;
};

class TestTransactionBoundary implements TransactionalQueryable {
  public constructor(private readonly database: PostgresTestDatabase) {}

  public async query<TResult extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<TResult>> {
    return this.database.query<TResult>(text, values);
  }

  public async transaction<TResult>(
    callback: (client: Queryable) => Promise<TResult>,
  ): Promise<TResult> {
    await this.database.query("BEGIN");
    try {
      const result = await callback(this.database);
      await this.database.query("COMMIT");
      return result;
    } catch (error) {
      await this.database.query("ROLLBACK");
      throw error;
    }
  }
}

class ClientBoundary implements TransactionalQueryable {
  public constructor(private readonly client: Client) {}

  public async query<TResult extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<TResult>> {
    return this.client.query<TResult>(text, values ? [...values] : undefined);
  }

  public async transaction<TResult>(
    callback: (client: Queryable) => Promise<TResult>,
  ): Promise<TResult> {
    await this.client.query("BEGIN");
    try {
      const result = await callback({
        query: async <TRow extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ): Promise<QueryResult<TRow>> =>
          this.client.query<TRow>(text, values ? [...values] : undefined),
      });
      await this.client.query("COMMIT");
      return result;
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }
}

class TrustedFinalizationAuthority implements DisputeEvidenceFinalizationAuthorityPort {
  public async authorizeFinalization(): Promise<{
    readonly status: "AUTHORIZED";
  }> {
    return { status: "AUTHORIZED" };
  }
}

class TrustedExportAuthority implements DisputeEvidenceExportAuthorityPort {
  public async authorizeExport(): Promise<{ readonly status: "AUTHORIZED" }> {
    return { status: "AUTHORIZED" };
  }
}
