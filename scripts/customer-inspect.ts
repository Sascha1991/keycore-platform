import {
  createPostgresPool,
  PostgresTransactionBoundary,
} from "../infra/postgres/client.js";
import { PostgresCustomerOrderIdentityRepository } from "../infra/postgres/customer-order-identity-repositories.js";
import { customerId } from "../packages/platform/src/contracts.js";
import { loadLocalEnv } from "./kinguin-live-procurement-shared.js";

const main = async (): Promise<void> => {
  const [rawCustomerId] = process.argv.slice(2);
  if (!rawCustomerId) {
    throw new Error("Usage: npm run customer:inspect -- <customerId>");
  }
  const env = loadLocalEnv();
  const connectionString = env.KEYCORE_DATABASE_URL;
  if (!connectionString) {
    throw new Error("KEYCORE_DATABASE_URL_REQUIRED");
  }
  const pool = createPostgresPool({ connectionString });
  try {
    const repository = new PostgresCustomerOrderIdentityRepository(
      new PostgresTransactionBoundary(pool),
    );
    const inspection = await repository.inspectCustomer(
      customerId(rawCustomerId),
    );
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
