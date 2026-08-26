import {
  createPostgresPool,
  PostgresTransactionBoundary,
} from "../infra/postgres/client.js";
import { PostgresCustomerRegistrationChallengeRepository } from "../infra/postgres/customer-registration-repositories.js";
import { customerId } from "../packages/platform/src/contracts.js";
import { loadLocalEnv } from "./kinguin-live-procurement-shared.js";

const main = async (): Promise<void> => {
  const [rawCustomerId] = process.argv.slice(2);
  if (!rawCustomerId) {
    throw new Error(
      "Usage: npm run customer-registration:inspect -- <customerId>",
    );
  }
  const env = loadLocalEnv();
  const connectionString = env.KEYCORE_DATABASE_URL;
  if (!connectionString) {
    throw new Error("KEYCORE_DATABASE_URL_REQUIRED");
  }
  const pool = createPostgresPool({ connectionString });
  try {
    const repository = new PostgresCustomerRegistrationChallengeRepository(
      new PostgresTransactionBoundary(pool),
    );
    const inspection = await repository.inspectCustomerRegistration({
      customerId: customerId(rawCustomerId),
      now: new Date(),
    });
    process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
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
