import {
  createPostgresPool,
  PostgresTransactionBoundary,
} from "../infra/postgres/client.js";
import { PostgresControlledProcurementApprovalRepository } from "../infra/postgres/controlled-procurement-repositories.js";
import { loadLocalEnv } from "./kinguin-live-procurement-shared.js";

const main = async (): Promise<void> => {
  const [approvalId] = process.argv.slice(2);
  if (!approvalId) {
    throw new Error(
      "Usage: npm run kinguin:inspect-controlled-procurement -- <approvalId>",
    );
  }
  const env = loadLocalEnv();
  const connectionString = env.KEYCORE_DATABASE_URL;
  if (!connectionString) {
    throw new Error("KEYCORE_DATABASE_URL_REQUIRED");
  }
  const pool = createPostgresPool({ connectionString });
  try {
    const repository = new PostgresControlledProcurementApprovalRepository(
      new PostgresTransactionBoundary(pool),
    );
    const approval = await repository.findById(approvalId);
    if (!approval) {
      throw new Error("APPROVAL_NOT_FOUND");
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          approvalId: approval.approvalId,
          createdAt: approval.createdAt.toISOString(),
          dispatchState: approval.dispatchState,
          externalSupplierOrderId: approval.externalSupplierOrderId,
          orderExternalId: approval.orderExternalId,
          safeReasonCode: approval.rejectionDiagnostic?.safeReasonCode ?? null,
          status: approval.status,
          supplier: "Kinguin",
          supplierErrorCategory:
            approval.rejectionDiagnostic?.supplierErrorCategory ?? null,
          supplierErrorCode:
            approval.rejectionDiagnostic?.supplierErrorCode ?? null,
          supplierHttpStatus:
            approval.rejectionDiagnostic?.supplierHttpStatus ?? null,
          updatedAt: approval.updatedAt.toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await pool.end();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "FAILED"}\n`,
  );
  process.exitCode = 1;
});
