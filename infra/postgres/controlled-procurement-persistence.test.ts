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
        expect(JSON.stringify(reloaded)).not.toContain(proofPhrase);

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

    it("rejects expired and consumed approvals without raw unique errors", async () => {
      await withDatabase(async (database) => {
        const expired = approvalFixture({
          expiresAt: new Date(now.getTime() - 1_000),
        });
        await withRepository(database.schemaName, (repository) =>
          repository.create(expired),
        );
        await expect(
          withRepository(database.schemaName, (repository) =>
            repository.claim({
              approvalId: expired.approvalId,
              now,
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
