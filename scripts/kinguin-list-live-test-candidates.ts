import { SupplierError } from "../packages/platform/src/contracts.js";
import {
  loadLocalEnv,
  serviceFromEnv,
} from "./kinguin-live-procurement-shared.js";

const main = async (): Promise<void> => {
  const env = loadLocalEnv();
  const { pool, service } = await serviceFromEnv(env, "READ_ONLY");
  try {
    const result = await service.listCandidates({ limit: 10 });
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
