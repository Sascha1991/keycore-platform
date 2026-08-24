import { correlationId } from "../packages/platform/src/contracts.js";
import {
  fulfillmentServiceFromEnv,
  loadLocalEnv,
} from "./kinguin-key-fulfillment-shared.js";

const main = async (): Promise<void> => {
  const [approvalId] = process.argv.slice(2);
  if (!approvalId) {
    throw new Error(
      "Usage: npm run kinguin:prepare-live-key-retrieval -- <controlledProcurementApprovalId>",
    );
  }
  const { pool, service } = await fulfillmentServiceFromEnv(
    loadLocalEnv(),
    "PREPARE",
  );
  try {
    const result = await service.prepareControlledRetrieval({
      controlledProcurementApprovalId: approvalId,
      correlationId: correlationId("controlled-key-retrieval-prepare"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
