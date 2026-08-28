import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  SupplierClaimService,
  correlationId,
  orderId,
  type OrderId,
  type SupplierClaimAuthorityPort,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";
import { PostgresSupplierClaimRepository } from "./supplier-claim-repositories.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const now = new Date("2026-08-28T13:00:00.000Z");

describe.skipIf(!connectionString)("PostgresSupplierClaimRepository", () => {
  it("creates one atomic logical claim under concurrent idempotent replay", async () => {
    await withDatabase(async (database) => {
      const fixture = await insertFixture(database);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_value, index) =>
          withRepository(database.schemaName, (repository) =>
            service(repository).createClaim(
              createInput(fixture, `race-${index}`),
            ),
          ),
        ),
      );

      expect(
        results.filter((result) => result.status === "CREATED"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "EXISTING"),
      ).toHaveLength(9);
      expect(new Set(results.map(requireClaimId)).size).toBe(1);
      await expect(count(database, "supplier_claims")).resolves.toBe("1");
      await expect(count(database, "supplier_claim_events")).resolves.toBe("1");
      await expect(
        serviceForDatabase(database).createClaim({
          ...createInput(fixture, "duplicate-active-issue"),
          idempotencyKey: "pg-different-idempotency-same-active-issue",
        }),
      ).resolves.toEqual({ code: "CONFLICT", status: "FAILED" });
    });
  });

  it("enforces exact-order references, derived supplier identity, and immutable claim identity", async () => {
    await withDatabase(async (database) => {
      const fixture = await insertFixture(database);
      const other = await insertFixture(database);
      const claimId = requireClaimId(
        await serviceForDatabase(database).createClaim(
          createInput(fixture, "exact"),
        ),
      );

      await expect(
        database.query(
          "UPDATE supplier_claims SET order_id = $2 WHERE id = $1",
          [claimId, other.order],
        ),
      ).rejects.toThrow("Supplier claim identity is immutable");
      await expect(
        database.query(
          "UPDATE supplier_claims SET supplier_id = 'forged' WHERE id = $1",
          [claimId],
        ),
      ).rejects.toThrow("Supplier claim identity is immutable");
      await expect(
        insertRawClaim(database, {
          ...fixture,
          claimId: randomUUID(),
          order: other.order,
          idempotencyKey: "cross-support-order",
        }),
      ).rejects.toThrow("Supplier claim support case order mismatch");
      await expect(
        insertRawClaim(database, {
          ...fixture,
          claimId: randomUUID(),
          supplierId: "forged-supplier",
          idempotencyKey: "forged-supplier",
        }),
      ).rejects.toThrow(
        "Supplier claim supplier identity must derive from procurement",
      );
    });
  });

  it("links finalized exact-order evidence atomically and keeps history append-only", async () => {
    await withDatabase(async (database) => {
      const fixture = await insertFixture(database);
      const other = await insertFixture(database);
      const claimId = requireClaimId(
        await serviceForDatabase(database).createClaim(
          createInput(fixture, "evidence"),
        ),
      );
      const claimService = serviceForDatabase(database);

      await expect(
        claimService.linkEvidence({
          claimId,
          correlationId: correlationId("pg-evidence"),
          evidenceSnapshotId: fixture.evidenceId,
        }),
      ).resolves.toMatchObject({ status: "OK" });
      await expect(
        claimService.linkEvidence({
          claimId,
          correlationId: correlationId("pg-evidence-replay"),
          evidenceSnapshotId: fixture.evidenceId,
        }),
      ).resolves.toMatchObject({ status: "EXISTING" });
      await expect(
        count(database, "supplier_claim_evidence_links"),
      ).resolves.toBe("1");
      await expect(
        eventCount(database, claimId, "EVIDENCE_LINKED"),
      ).resolves.toBe("1");

      await expect(
        database.query(
          "INSERT INTO supplier_claim_evidence_links(id, claim_id, evidence_snapshot_id, order_id, created_at) VALUES ($1,$2,$3,$4,$5)",
          [randomUUID(), claimId, other.evidenceId, fixture.order, now],
        ),
      ).rejects.toThrow("Supplier claim evidence order mismatch");
      await expect(
        database.query(
          "UPDATE supplier_claim_evidence_links SET created_at = $2 WHERE claim_id = $1",
          [claimId, new Date(now.getTime() + 1_000)],
        ),
      ).rejects.toThrow("Supplier claim history is append-only");
      await expect(
        database.query(
          "DELETE FROM supplier_claim_events WHERE claim_id = $1",
          [claimId],
        ),
      ).rejects.toThrow("Supplier claim history is append-only");
    });
  });

  it("uses optimistic concurrency for status and stores transitions atomically", async () => {
    await withDatabase(async (database) => {
      const fixture = await insertFixture(database);
      const claimId = requireClaimId(
        await serviceForDatabase(database).createClaim(
          createInput(fixture, "status"),
        ),
      );
      const results = await Promise.all([
        withRepository(database.schemaName, (repository) =>
          service(repository).transitionClaim({
            claimId,
            correlationId: correlationId("pg-status-a"),
            expectedVersion: 1,
            nextStatus: "UNDER_REVIEW",
          }),
        ),
        withRepository(database.schemaName, (repository) =>
          service(repository).transitionClaim({
            claimId,
            correlationId: correlationId("pg-status-b"),
            expectedVersion: 1,
            nextStatus: "RESOLVED",
            outcome: "CUSTOMER_ISSUE_RESOLVED",
          }),
        ),
      ]);
      expect(results.filter((result) => result.status === "OK")).toHaveLength(
        1,
      );
      expect(
        results.filter(
          (result) =>
            result.status === "FAILED" && result.code === "STALE_VERSION",
        ),
      ).toHaveLength(1);
      await expect(
        eventCount(database, claimId, "CLAIM_STATUS_CHANGED", "CLAIM_RESOLVED"),
      ).resolves.toBe("1");
    });
  });

  it("persists prepared separately from submitted and fails closed without an adapter", async () => {
    await withDatabase(async (database) => {
      const fixture = await insertFixture(database);
      const claimService = serviceForDatabase(database);
      const claimId = requireClaimId(
        await claimService.createClaim(createInput(fixture, "submission")),
      );
      await claimService.transitionClaim({
        claimId,
        correlationId: correlationId("pg-review"),
        expectedVersion: 1,
        nextStatus: "UNDER_REVIEW",
      });
      await claimService.transitionClaim({
        claimId,
        correlationId: correlationId("pg-ready"),
        expectedVersion: 2,
        nextStatus: "READY_FOR_SUBMISSION",
      });
      const prepared = await claimService.prepareSubmission({
        claimId,
        correlationId: correlationId("pg-prepare"),
      });

      expect(prepared).toMatchObject({
        detail: { submission: { status: "PREPARED" } },
        status: "OK",
      });
      await expect(
        claimService.executeSubmission({
          claimId,
          correlationId: correlationId("pg-submit"),
          expectedSubmissionVersion: 1,
        }),
      ).resolves.toEqual({ code: "SUBMISSION_UNAVAILABLE", status: "FAILED" });
      const state = await database.query<{ readonly status: string }>(
        "SELECT status FROM supplier_claim_submission_operations WHERE claim_id = $1",
        [claimId],
      );
      expect(state.rows[0]?.status).toBe("PREPARED");
      await expect(
        database.query(
          "INSERT INTO supplier_claim_evidence_links(id, claim_id, evidence_snapshot_id, order_id, created_at) VALUES ($1,$2,$3,$4,$5)",
          [randomUUID(), claimId, fixture.evidenceId, fixture.order, now],
        ),
      ).rejects.toThrow(
        "Supplier claim evidence is frozen after submission preparation",
      );
      await expect(
        database.query(
          `UPDATE supplier_claim_submission_operations
           SET status = 'CONFIRMED', dispatched_at = $2, confirmed_at = $2,
             supplier_claim_reference = 'synthetic-direct-reference',
             response_type = 'ACCEPTED', record_version = record_version + 1,
             updated_at = $2
           WHERE claim_id = $1`,
          [claimId, now],
        ),
      ).rejects.toThrow("Invalid supplier claim submission transition");
    });
  });
});

interface Fixture {
  readonly order: OrderId;
  readonly supportCaseId: string;
  readonly procurementId: string;
  readonly fulfillmentId: string;
  readonly evidenceId: string;
}

const withDatabase = async (
  callback: (database: PostgresTestDatabase) => Promise<void>,
): Promise<void> => {
  const database = await PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `supplier_claims_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await callback(database);
  } finally {
    await database.cleanup();
  }
};

const insertFixture = async (
  database: PostgresTestDatabase,
): Promise<Fixture> => {
  const productId = randomUUID();
  const priceLockId = randomUUID();
  const customerId = randomUUID();
  const createdOrderId = orderId(randomUUID());
  const supportCaseId = randomUUID();
  const procurementId = randomUUID();
  const fulfillmentId = randomUUID();
  const evidenceId = randomUUID();
  const email = `supplier-claim-${createdOrderId}@example.test`;
  await database.query(
    "INSERT INTO products(id, product_type, title, platform) VALUES ($1, 'DIGITAL_KEY', 'Supplier Claim Fixture', 'PC')",
    [productId],
  );
  await database.query(
    `INSERT INTO price_locks(id, product_id, currency, locked_sell_price_minor, pricing_quote_fingerprint, source_fingerprint, pricing_policy_version, pricing_policy_record_version, tax_policy_version, fee_policy_version, status, record_version, idempotency_key, idempotency_fingerprint, correlation_id, created_at, expires_at)
     VALUES ($1,$2,'EUR',2999,$3,$4,'pricing-v1',1,'tax-v1','fee-v1','CONSUMED',1,$5,$6,'pg-claim-lock',$7,$8)`,
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
    "INSERT INTO keycore_customers(id, email_normalized, email_verification_state, record_version, created_at, updated_at) VALUES ($1,$2,'VERIFIED',1,$3,$3)",
    [customerId, email, now],
  );
  await database.query(
    `INSERT INTO keycore_orders(id, product_id, price_lock_id, customer_id, checkout_email_normalized, customer_amount_minor, currency, quantity, status, payment_status, procurement_status, fulfillment_status, risk_status, refund_status, record_version, idempotency_key, idempotency_fingerprint, correlation_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,2999,'EUR',1,'PAYMENT_CAPTURED','CAPTURED','NOT_STARTED','NOT_STARTED','APPROVED','NOT_REQUESTED',1,$6,$7,'pg-claim-order',$8,$8)`,
    [
      createdOrderId,
      productId,
      priceLockId,
      customerId,
      email,
      `order-${createdOrderId}`,
      `fingerprint-${createdOrderId}`,
      now,
    ],
  );
  await database.query(
    `INSERT INTO support_cases(id, customer_id, order_id, category, status, priority, source, resolution_code, record_version, correlation_id, created_at, updated_at, resolved_at, closed_at)
     VALUES ($1,$2,$3,'ACTIVATION_PROBLEM','OPEN','NORMAL','CUSTOMER',NULL,1,'pg-claim-support',$4,$4,NULL,NULL)`,
    [supportCaseId, customerId, createdOrderId, now],
  );
  await database.query(
    `INSERT INTO procurement_operations(id, order_id, supplier_id, supplier_product_id, supplier_offer_id, quantity, status, dispatch_state, acquisition_amount_minor, acquisition_currency, external_supplier_order_id, normalized_supplier_status, response_fingerprint, execution_token, execution_started_at, attempt_generation, record_version, correlation_id, last_reconciled_at, reconciliation_reason_code, created_at, updated_at)
     VALUES ($1,$2,'mock-supplier','product-synthetic','offer-synthetic',1,'SUCCEEDED','DISPATCH_CONFIRMED',1000,'EUR',$3,'COMPLETED',$4,NULL,NULL,1,1,'pg-claim-procurement',NULL,NULL,$5,$5)`,
    [
      procurementId,
      createdOrderId,
      `supplier-order-${procurementId}`,
      "a".repeat(64),
      now,
    ],
  );
  await database.query(
    `INSERT INTO fulfillment_operations(id, order_id, procurement_operation_id, controlled_procurement_approval_id, supplier_id, external_supplier_order_id, supplier_item_reference, expected_quantity, status, retrieval_state, delivery_state, token_hash, approval_expires_at, retrieval_execution_token, retrieval_started_at, encrypted_secret_id, failure_reason_code, record_version, correlation_id, created_at, updated_at, retrieved_at, delivered_at)
     VALUES ($1,$2,$3,NULL,'mock-supplier',$4,NULL,1,'DELIVERY_PENDING','RETRIEVED','PENDING',NULL,NULL,NULL,NULL,NULL,NULL,1,'pg-claim-fulfillment',$5,$5,$5,NULL)`,
    [
      fulfillmentId,
      createdOrderId,
      procurementId,
      `supplier-order-${procurementId}`,
      now,
    ],
  );
  await database.query(
    `INSERT INTO dispute_evidence_snapshots(id, order_id, version, state, schema_version, policy_version, fact_fingerprint, sections, created_at, finalized_at)
     VALUES ($1,$2,1,'FINALIZED','KS_DISPUTE_EVIDENCE_V1','KS_DISPUTE_EVIDENCE_V1',$3,'[{"type":"ORDER","status":"AVAILABLE","facts":[]}]'::jsonb,$4,$4)`,
    [evidenceId, createdOrderId, "b".repeat(64), now],
  );
  return {
    evidenceId,
    fulfillmentId,
    order: createdOrderId,
    procurementId,
    supportCaseId,
  };
};

const createInput = (fixture: Fixture, correlation: string) => ({
  category: "KEY_NOT_WORKING" as const,
  correlationId: correlationId(`pg-${correlation}`),
  fulfillmentId: fixture.fulfillmentId,
  idempotencyKey: "pg-supplier-claim-idempotency",
  orderId: fixture.order,
  procurementOperationId: fixture.procurementId,
  source: "SUPPORT" as const,
  supportCaseId: fixture.supportCaseId,
});

const serviceForDatabase = (
  database: PostgresTestDatabase,
): SupplierClaimService =>
  service(
    new PostgresSupplierClaimRepository(new TestTransactionBoundary(database)),
  );
const service = (
  repository: PostgresSupplierClaimRepository,
): SupplierClaimService =>
  new SupplierClaimService({
    authority: new TrustedAuthority(),
    environment: "CI",
    now: () => now,
    operationsControlGate: {
      evaluate: async () => ({ status: "ALLOWED" as const }),
    },
    repository,
  });

const requireClaimId = (
  result: Awaited<ReturnType<SupplierClaimService["createClaim"]>>,
): string => {
  if (result.status === "FAILED")
    throw new Error(`Expected claim, got ${result.code}`);
  return result.detail.claim.id;
};

const count = async (
  database: PostgresTestDatabase,
  table: string,
): Promise<string> => {
  if (!/^[a-z_]+$/u.test(table)) throw new Error("Unsafe table");
  const result = await database.query<{ readonly count: string }>(
    `SELECT count(*)::text AS count FROM ${table}`,
  );
  return result.rows[0]?.count ?? "0";
};

const eventCount = async (
  database: PostgresTestDatabase,
  claimId: string,
  ...eventTypes: string[]
): Promise<string> => {
  const result = await database.query<{ readonly count: string }>(
    "SELECT count(*)::text AS count FROM supplier_claim_events WHERE claim_id = $1 AND event_type = ANY($2::text[])",
    [claimId, eventTypes],
  );
  return result.rows[0]?.count ?? "0";
};

const insertRawClaim = async (
  database: PostgresTestDatabase,
  input: Fixture & {
    readonly claimId: string;
    readonly idempotencyKey: string;
    readonly supplierId?: string;
  },
): Promise<unknown> =>
  database.query(
    `INSERT INTO supplier_claims(id, order_id, support_case_id, procurement_operation_id, fulfillment_id, supplier_id, supplier_order_reference, category, source, status, priority, outcome, idempotency_key, idempotency_fingerprint, record_version, correlation_id, created_at, updated_at, resolved_at, closed_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,'KEY_NOT_WORKING','SUPPORT','OPEN','NORMAL',NULL,$8,$9,1,'pg-raw-claim',$10,$10,NULL,NULL)`,
    [
      input.claimId,
      input.order,
      input.supportCaseId,
      input.procurementId,
      input.fulfillmentId,
      input.supplierId ?? "mock-supplier",
      `supplier-order-${input.procurementId}`,
      input.idempotencyKey,
      "c".repeat(64),
      now,
    ],
  );

const withRepository = async <T>(
  schemaName: string,
  action: (repository: PostgresSupplierClaimRepository) => Promise<T>,
): Promise<T> => {
  if (!connectionString)
    throw new Error("KEYCORE_TEST_DATABASE_URL is required");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `SET search_path TO ${quoteIdentifier(schemaName)}, public`,
    );
    return await action(
      new PostgresSupplierClaimRepository(new ClientBoundary(client)),
    );
  } finally {
    await client.end();
  }
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
      const result = await callback(this);
      await this.client.query("COMMIT");
      return result;
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }
}

class TrustedAuthority implements SupplierClaimAuthorityPort {
  public async authorize(): Promise<{
    readonly status: "AUTHORIZED";
    readonly actorReference: string;
  }> {
    return { actorReference: "operator:pg-ks0905", status: "AUTHORIZED" };
  }
}
