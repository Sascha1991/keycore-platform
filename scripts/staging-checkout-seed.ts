import process from "node:process";

import {
  PostgresTransactionBoundary,
  createPostgresPool,
} from "../infra/postgres/client.js";
import { seedSyntheticStagingCheckoutData } from "../infra/postgres/staging-checkout-seed.js";

const databaseUrl = process.env.KEYCORE_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("KEYCORE_DATABASE_URL_REQUIRED");
}

const pool = createPostgresPool({ connectionString: databaseUrl });
try {
  const result = await seedSyntheticStagingCheckoutData(
    new PostgresTransactionBoundary(pool),
    {
      deploymentId: process.env.KEYCORE_DEPLOYMENT_ID,
      environment: process.env.KEYCORE_ENV,
    },
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await pool.end();
}
