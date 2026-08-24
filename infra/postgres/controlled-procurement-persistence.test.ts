import { randomUUID } from "node:crypto";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  currency,
  money,
  supplierOfferId,
  supplierProductId,
} from "../../packages/platform/src/contracts.js";
import {
  hashExecutionToken,
  type ControlledProcurementApproval,
} from "../suppliers/kinguin/kinguin-controlled-live-procurement.js";
import type { Queryable, TransactionalQueryable } from "./client.js";
import { PostgresControlledProcurementApprovalRepository } from "./controlled-procurement-repositories.js";
import { PostgresTestDatabase, quoteIdentifier } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const now = new Date("2026-08-24T12:00:00.000Z");

describe.skipIf(!connectionString)(
  "PostgresControlledProcurementApprovalRepository",
  () => {
    it("persists approval, token hash, dispatch evidence, success and ambiguity across repository restarts", async () => {
      await withDatabase(async (database) => {
        const proofPhrase = "one-time-proof-fixture";
        const approval = approvalFixture({
          tokenHash: hashExecutionToken(proofPhrase),
        });
        await withRepository(database.schemaName, (repository) =>
          repository.create(approval),
        );

        const reloaded = await withRepository(
          database.schemaName,
          (repository) => repository.findById(approval.approvalId),
        );
        expect(reloaded?.tokenHash).toBe(hashExecutionToken(proofPhrase));
        expect(safeStringify(reloaded)).not.toContain(proofPhrase);

        const claim = await withRepository(database.schemaName, (repository) =>
          repository.claim({
            approvalId: approval.approvalId,
            now,
            tokenHash: hashExecutionToken(proofPhrase),
          }),
        );
        expect(claim.status).toBe("CLAIMED");

        await withRepository(database.schemaName, (repository) =>
          repository.markDispatchStarted({
            approvalId: approval.approvalId,
            now,
          }),
        );
        await expect(
          approvalStatus(database, approval.approvalId),
        ).resolves.toBe("CONSUMED:DISPATCH_STARTED");

        await withRepository(database.schemaName, (repository) =>
          repository.markConfirmed({
            approvalId: approval.approvalId,
            externalSupplierOrderId: "KNG-ORDER-1",
            now,
            responseFingerprint: "a".repeat(64),
            supplierStatus: "processing",
          }),
        );
        await expect(
          approvalStatus(database, approval.approvalId),
        ).resolves.toBe("PROCUREMENT_CONFIRMED:DISPATCH_CONFIRMED");

        const ambiguous = approvalFixture({
          approvalId: randomUUID(),
          orderExternalId: `keycore-liveverify-${randomUUID()}`,
        });
        await withRepository(database.schemaName, (repository) =>
          repository.create(ambiguous),
        );
        const ambiguousClaim = await withRepository(
          database.schemaName,
          (repository) =>
            repository.claim({
              approvalId: ambiguous.approvalId,
              now,
              tokenHash: ambiguous.tokenHash,
            }),
        );
        expect(ambiguousClaim.status).toBe("CLAIMED");
        await withRepository(database.schemaName, (repository) =>
          repository.markDispatchStarted({
            approvalId: ambiguous.approvalId,
            now,
          }),
        );
        await withRepository(database.schemaName, (repository) =>
          repository.markAmbiguous({
            approvalId: ambiguous.approvalId,
            now,
            reasonCode: "SUPPLIER_MUTATION_OUTCOME_AMBIGUOUS",
          }),
        );
        await expect(
          approvalStatus(database, ambiguous.approvalId),
        ).resolves.toBe("AMBIGUOUS:DISPATCH_AMBIGUOUS");

        const reconciled = await withRepository(
          database.schemaName,
          (repository) =>
            repository.markConfirmed({
              approvalId: ambiguous.approvalId,
              externalSupplierOrderId: "KNG-RECONCILED",
              now,
              responseFingerprint: "1".repeat(64),
              source: "RECONCILIATION",
              supplierStatus: "completed",
            }),
        );
        expect(reconciled?.status).toBe("PROCUREMENT_CONFIRMED");
      });
    });

    it("allows exactly one of ten concurrent claims and returns controlled losers", async () => {
      await withDatabase(async (database) => {
        const proofPhrase = "concurrent-proof-fixture";
        const approval = approvalFixture({
          tokenHash: hashExecutionToken(proofPhrase),
        });
        await withRepository(database.schemaName, (repository) =>
          repository.create(approval),
        );
        const claims = await Promise.all(
          Array.from({ length: 10 }, () =>
            withRepository(database.schemaName, (repository) =>
              repository.claim({
                approvalId: approval.approvalId,
                now,
                tokenHash: hashExecutionToken(proofPhrase),
              }),
            ),
          ),
        );
        expect(
          claims.filter((claim) => claim.status === "CLAIMED"),
        ).toHaveLength(1);
        expect(
          claims.filter(
            (claim) => claim.status === "APPROVAL_ALREADY_CONSUMED",
          ),
        ).toHaveLength(9);
      });
    });

    it("persists safe rejection diagnostics and keeps historical rejections nullable", async () => {
      await withDatabase(async (database) => {
        const rejected = await createClaimedAndDispatched(database);
        await withRepository(database.schemaName, (repository) =>
          repository.markRejected({
            approvalId: rejected.approvalId,
            diagnostic: {
              safeReasonCode: "KINGUIN_INSUFFICIENT_BALANCE",
              supplier: "Kinguin",
              supplierErrorCategory: "INSUFFICIENT_BALANCE",
              supplierErrorCode: "InsufficientBalance",
              supplierHttpStatus: 400,
            },
            now,
            reasonCode: "KINGUIN_INSUFFICIENT_BALANCE",
            responseFingerprint: "9".repeat(64),
          }),
        );

        const reloaded = await withRepository(
          database.schemaName,
          (repository) => repository.findById(rejected.approvalId),
        );
        expect(reloaded?.rejectionDiagnostic).toEqual({
          safeReasonCode: "KINGUIN_INSUFFICIENT_BALANCE",
          supplier: "Kinguin",
          supplierErrorCategory: "INSUFFICIENT_BALANCE",
          supplierErrorCode: "InsufficientBalance",
          supplierHttpStatus: 400,
        });
        expect(safeStringify(reloaded)).not.toContain("debug");

        const historical = await createClaimedAndDispatched(database);
        await withRepository(database.schemaName, (repository) =>
          repository.markRejected({
            approvalId: historical.approvalId,
            now,
            reasonCode: "controlledPlaceOrder",
          }),
        );
        await expect(
          withRepository(database.schemaName, (repository) =>
            repository.findById(historical.approvalId),
          ),
        ).resolves.toMatchObject({ rejectionDiagnostic: null });

        const columns = await database.query<{ readonly column_name: string }>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'controlled_procurement_approvals'
          `,
        );
        expect(columns.rows.map((row) => row.column_name)).not.toEqual(
          expect.arrayContaining([
            "raw_response",
            "response_body",
            "supplier_message",
            "headers",
          ]),
        );
      });
    });

    it("rejects unsafe rejection diagnostic values at the PostgreSQL boundary", async () => {
      await withDatabase(async (database) => {
        const unsafeCode = ["api", "key"].join("-");
        const unsafeReason = ["API", "KEY"].join("_");
        for (const [assignment, value] of [
          ["supplier_http_status = $2", 99],
          ["supplier_error_code = $2", unsafeCode],
          ["supplier_error_category = $2", "RAW_RESPONSE"],
          ["safe_rejection_reason_code = $2", unsafeReason],
        ] as const) {
          const approval = approvalFixture({
            approvalId: randomUUID(),
            orderExternalId: `keycore-liveverify-${randomUUID()}`,
          });
          await withRepository(database.schemaName, (repository) =>
            repository.create(approval),
          );
          await expect(
            database.query(
              `UPDATE controlled_procurement_approvals SET ${assignment} WHERE id = $1`,
              [approval.approvalId, value],
            ),
          ).rejects.toThrow();
        }
      });
    });

    it("rejects expired and consumed approvals without raw unique errors", async () => {
      await withDatabase(async (database) => {
        const expired = approvalFixture({
          expiresAt: new Date(now.getTime() + 1_000),
        });
        await withRepository(database.schemaName, (repository) =>
          repository.create(expired),
        );
        await expect(
          withRepository(database.schemaName, (repository) =>
            repository.claim({
              approvalId: expired.approvalId,
              now: new Date(now.getTime() + 2_000),
              tokenHash: expired.tokenHash,
            }),
          ),
        ).resolves.toMatchObject({ status: "APPROVAL_EXPIRED" });

        const consumed = approvalFixture({
          approvalId: randomUUID(),
          orderExternalId: `keycore-liveverify-${randomUUID()}`,
        });
        await withRepository(database.schemaName, (repository) =>
          repository.create(consumed),
        );
        await withRepository(database.schemaName, (repository) =>
          repository.claim({
            approvalId: consumed.approvalId,
            now,
            tokenHash: consumed.tokenHash,
          }),
        );
        await expect(
          withRepository(database.schemaName, (repository) =>
            repository.claim({
              approvalId: consumed.approvalId,
              now,
              tokenHash: consumed.tokenHash,
            }),
          ),
        ).resolves.toMatchObject({ status: "APPROVAL_ALREADY_CONSUMED" });
      });
    });

    it("enforces conditional lifecycle transitions without raw database errors", async () => {
      await withDatabase(async (database) => {
        const unclaimed = approvalFixture();
        await withRepository(database.schemaName, (repository) =>
          repository.create(unclaimed),
        );
        await expect(
          withRepository(database.schemaName, (repository) =>
            repository.markDispatchStarted({
              approvalId: unclaimed.approvalId,
              now,
            }),
          ),
        ).resolves.toBeNull();

        await withRepository(database.schemaName, (repository) =>
          repository.cancel({ approvalId: unclaimed.approvalId, now }),
        );
        await expect(
          withRepository(database.schemaName, (repository) =>
            repository.markDispatchStarted({
              approvalId: unclaimed.approvalId,
              now,
            }),
          ),
        ).resolves.toBeNull();

        const confirmed = await createClaimedAndDispatched(database);
        const firstConfirm = await withRepository(
          database.schemaName,
          (repository) =>
            repository.markConfirmed({
              approvalId: confirmed.approvalId,
              externalSupplierOrderId: "KNG-CONFIRMED",
              now,
              responseFingerprint: "d".repeat(64),
              supplierStatus: "processing",
            }),
        );
        expect(firstConfirm?.status).toBe("PROCUREMENT_CONFIRMED");
        await expect(
          withRepository(database.schemaName, (repository) =>
            repository.cancel({ approvalId: confirmed.approvalId, now }),
          ),
        ).resolves.toBeNull();
        await expect(
          withRepository(database.schemaName, (repository) =>
            repository.markAmbiguous({
              approvalId: confirmed.approvalId,
              now,
              reasonCode: "STALE_AMBIGUOUS",
            }),
          ),
        ).resolves.toBeNull();
        await expect(
          approvalStatus(database, confirmed.approvalId),
        ).resolves.toBe("PROCUREMENT_CONFIRMED:DISPATCH_CONFIRMED");

        const ambiguous = await createClaimedAndDispatched(database);
        await withRepository(database.schemaName, (repository) =>
          repository.markAmbiguous({
            approvalId: ambiguous.approvalId,
            now,
            reasonCode: "SUPPLIER_MUTATION_OUTCOME_AMBIGUOUS",
          }),
        );
        await expect(
          withRepository(database.schemaName, (repository) =>
            repository.markConfirmed({
              approvalId: ambiguous.approvalId,
              externalSupplierOrderId: "KNG-LATE",
              now,
              responseFingerprint: "e".repeat(64),
              supplierStatus: "completed",
            }),
          ),
        ).resolves.toBeNull();
        await expect(
          approvalStatus(database, ambiguous.approvalId),
        ).resolves.toBe("AMBIGUOUS:DISPATCH_AMBIGUOUS");
      });
    });

    it("allows dispatch exactly once and prevents stale competing result writers", async () => {
      await withDatabase(async (database) => {
        const approval = approvalFixture({
          tokenHash: hashExecutionToken("race-proof"),
        });
        await withRepository(database.schemaName, (repository) =>
          repository.create(approval),
        );
        await withRepository(database.schemaName, (repository) =>
          repository.claim({
            approvalId: approval.approvalId,
            now,
            tokenHash: hashExecutionToken("race-proof"),
          }),
        );

        const dispatches = await Promise.all(
          Array.from({ length: 2 }, () =>
            withRepository(database.schemaName, (repository) =>
              repository.markDispatchStarted({
                approvalId: approval.approvalId,
                now,
              }),
            ),
          ),
        );
        expect(dispatches.filter(Boolean)).toHaveLength(1);
        await expect(
          approvalStatus(database, approval.approvalId),
        ).resolves.toBe("CONSUMED:DISPATCH_STARTED");

        const results = await Promise.all([
          withRepository(database.schemaName, (repository) =>
            repository.markConfirmed({
              approvalId: approval.approvalId,
              externalSupplierOrderId: "KNG-RACE",
              now,
              responseFingerprint: "f".repeat(64),
              supplierStatus: "processing",
            }),
          ),
          withRepository(database.schemaName, (repository) =>
            repository.markRejected({
              approvalId: approval.approvalId,
              now,
              reasonCode: "STALE_REJECTION",
              responseFingerprint: "0".repeat(64),
            }),
          ),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect([
          "PROCUREMENT_CONFIRMED:DISPATCH_CONFIRMED",
          "PROCUREMENT_REJECTED:DISPATCH_REJECTED",
        ]).toContain(await approvalStatus(database, approval.approvalId));
      });
    });
  },
);

const approvalFixture = (
  overrides: Partial<ControlledProcurementApproval> = {},
): ControlledProcurementApproval => ({
  approvalId: randomUUID(),
  claimedAt: null,
  completedAt: null,
  consumedAt: null,
  createdAt: now,
  currentAcquisitionAmount: money(579n, currency("EUR")),
  dispatchStartedAt: null,
  dispatchState: "NOT_DISPATCHED",
  expiresAt: new Date(now.getTime() + 300_000),
  maximumAcquisitionAmount: money(579n, currency("EUR")),
  mode: "CONTROLLED_VERIFICATION",
  orderExternalId: `keycore-liveverify-${randomUUID()}`,
  productTitle: "Synthetic Product",
  purchaseRequestFingerprint: "b".repeat(64),
  quantity: 1,
  recordVersion: 1,
  status: "APPROVED",
  supplierId: "kinguin",
  supplierOfferId: supplierOfferId("offer-alpha"),
  supplierProductId: supplierProductId("product-alpha"),
  tokenHash: "c".repeat(64),
  updatedAt: now,
  ...overrides,
});

const approvalStatus = async (
  database: Queryable,
  approvalId: string,
): Promise<string> => {
  const result = await database.query<{
    readonly status: string;
    readonly dispatch_state: string;
  }>(
    "SELECT status, dispatch_state FROM controlled_procurement_approvals WHERE id = $1",
    [approvalId],
  );
  const row = result.rows[0];
  return row ? `${row.status}:${row.dispatch_state}` : "";
};

const withRepository = async <TResult>(
  schemaName: string,
  action: (
    repository: PostgresControlledProcurementApprovalRepository,
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
      new PostgresControlledProcurementApprovalRepository(
        new ClientBoundary(client),
      ),
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
    schemaName: `controlled_procurement_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await action(database);
  } finally {
    await database.cleanup();
  }
};

const createClaimedAndDispatched = async (
  database: PostgresTestDatabase,
): Promise<ControlledProcurementApproval> => {
  const approval = approvalFixture({
    approvalId: randomUUID(),
    orderExternalId: `keycore-liveverify-${randomUUID()}`,
  });
  await withRepository(database.schemaName, (repository) =>
    repository.create(approval),
  );
  const claim = await withRepository(database.schemaName, (repository) =>
    repository.claim({
      approvalId: approval.approvalId,
      now,
      tokenHash: approval.tokenHash,
    }),
  );
  expect(claim.status).toBe("CLAIMED");
  const dispatch = await withRepository(database.schemaName, (repository) =>
    repository.markDispatchStarted({
      approvalId: approval.approvalId,
      now,
    }),
  );
  expect(dispatch?.dispatchState).toBe("DISPATCH_STARTED");
  return approval;
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

const safeStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, current) =>
    typeof current === "bigint" ? current.toString() : current,
  );
