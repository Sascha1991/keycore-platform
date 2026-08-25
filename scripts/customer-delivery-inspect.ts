import {
  createPostgresPool,
  PostgresTransactionBoundary,
} from "../infra/postgres/client.js";
import { PostgresCustomerKeyDeliveryRepository } from "../infra/postgres/customer-key-delivery-repositories.js";
import { PostgresFulfillmentRepository } from "../infra/postgres/fulfillment-repositories.js";
import { customerDeliverySafeInspect } from "../packages/platform/src/contracts.js";
import { loadLocalEnv } from "./kinguin-live-procurement-shared.js";

const main = async (): Promise<void> => {
  const [fulfillmentId] = process.argv.slice(2);
  if (!fulfillmentId) {
    throw new Error(
      "Usage: npm run customer-delivery:inspect -- <fulfillmentId>",
    );
  }
  const env = loadLocalEnv();
  const connectionString = env.KEYCORE_DATABASE_URL;
  if (!connectionString) {
    throw new Error("KEYCORE_DATABASE_URL_REQUIRED");
  }
  const pool = createPostgresPool({ connectionString });
  try {
    const boundary = new PostgresTransactionBoundary(pool);
    const fulfillmentRepository = new PostgresFulfillmentRepository(boundary);
    const deliveryRepository = new PostgresCustomerKeyDeliveryRepository(
      boundary,
    );
    const fulfillment = await fulfillmentRepository.findById(fulfillmentId);
    if (!fulfillment) {
      throw new Error("FULFILLMENT_NOT_FOUND");
    }
    const [secret, latestAttempt] = await Promise.all([
      fulfillmentRepository.findSecretByFulfillmentId(fulfillmentId),
      deliveryRepository.findLatestAttemptByFulfillmentId(fulfillmentId),
    ]);
    process.stdout.write(
      `${JSON.stringify(
        customerDeliverySafeInspect({ fulfillment, latestAttempt, secret }),
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
