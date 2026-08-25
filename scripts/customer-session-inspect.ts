import {
  createPostgresPool,
  PostgresTransactionBoundary,
} from "../infra/postgres/client.js";
import { PostgresCustomerAuthSessionRepository } from "../infra/postgres/customer-authentication-repositories.js";
import {
  CustomerAuthenticationService,
  customerAuthenticationConfigFromEnv,
} from "../packages/platform/src/contracts.js";
import { loadLocalEnv } from "./kinguin-live-procurement-shared.js";

const main = async (): Promise<void> => {
  const [sessionId] = process.argv.slice(2);
  if (!sessionId) {
    throw new Error("Usage: npm run customer-session:inspect -- <sessionId>");
  }
  const env = loadLocalEnv();
  const connectionString = env.KEYCORE_DATABASE_URL;
  if (!connectionString) {
    throw new Error("KEYCORE_DATABASE_URL_REQUIRED");
  }
  const pool = createPostgresPool({ connectionString });
  try {
    const repository = new PostgresCustomerAuthSessionRepository(
      new PostgresTransactionBoundary(pool),
    );
    const service = new CustomerAuthenticationService({
      config: customerAuthenticationConfigFromEnv(env),
      repository,
    });
    const inspection = await service.inspectSession({ sessionId });
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
