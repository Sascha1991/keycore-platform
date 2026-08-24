import {
  SupplierError,
  correlationId,
} from "../packages/platform/src/contracts.js";
import {
  loadLocalEnv,
  serviceFromEnv,
} from "./kinguin-live-procurement-shared.js";

const main = async (): Promise<void> => {
  const env = loadLocalEnv();
  const [approvalId, executionToken] = process.argv.slice(2);
  if (!approvalId || !executionToken) {
    throw new Error(
      "Usage: npm run kinguin:execute-approved-procurement -- <approvalId> <executionToken>",
    );
  }
  const { pool, service } = await serviceFromEnv(env);
  try {
    const result = await service.execute({
      approvalId,
      correlationId: correlationId("controlled-live-execute"),
      executionToken,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await pool.end();
  }
};

main().catch((error: unknown) => {
  if (error instanceof SupplierError) {
    process.stderr.write(
      `${JSON.stringify(
        {
          category: error.category,
          operation: error.context.operation,
          supplierId: error.context.supplierId,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stderr.write(
      `${error instanceof Error ? error.message : "FAILED"}\n`,
    );
  }
  process.exitCode = 1;
});
