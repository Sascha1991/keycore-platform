import { SupplierError } from "../packages/platform/src/contracts.js";
import {
  loadLocalEnv,
  serviceFromEnv,
} from "./kinguin-live-procurement-shared.js";

const main = async (): Promise<void> => {
  const [approvalId] = process.argv.slice(2);
  if (!approvalId) {
    throw new Error(
      "Usage: npm run kinguin:reconcile-live-procurement -- <approvalId>",
    );
  }
  const env = loadLocalEnv();
  const { pool, service } = await serviceFromEnv(env);
  try {
    const result = await service.reconcile({ approvalId });
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
