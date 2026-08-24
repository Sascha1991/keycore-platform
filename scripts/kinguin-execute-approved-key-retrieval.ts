import { correlationId } from "../packages/platform/src/contracts.js";
import {
  fulfillmentServiceFromEnv,
  loadLocalEnv,
} from "./kinguin-key-fulfillment-shared.js";

const main = async (): Promise<void> => {
  const [fulfillmentApprovalId, executionToken] = process.argv.slice(2);
  if (!fulfillmentApprovalId || !executionToken) {
    throw new Error(
      "Usage: npm run kinguin:execute-approved-key-retrieval -- <fulfillmentApprovalId> <executionToken>",
    );
  }
  const { pool, service } = await fulfillmentServiceFromEnv(
    loadLocalEnv(),
    "EXECUTE",
  );
  try {
    const result = await service.executeControlledRetrieval({
      correlationId: correlationId("controlled-key-retrieval-execute"),
      executionToken,
      fulfillmentApprovalId,
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
