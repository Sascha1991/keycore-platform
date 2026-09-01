import { spawnSync } from "node:child_process";
import process from "node:process";

import {
  PostgresTransactionBoundary,
  createPostgresPool,
} from "../infra/postgres/client.js";
import { seedSyntheticStagingCheckoutData } from "../infra/postgres/staging-checkout-seed.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};

if (process.env.KEYCORE_ENV !== "STAGING") {
  throw new Error("STAGING_CHECKOUT_ENVIRONMENT_REQUIRED");
}

const databaseUrl = internalDatabaseUrl(
  required("KEYCORE_STAGING_POSTGRES_PASSWORD"),
);
const migration = spawnSync(
  process.execPath,
  ["--import", "tsx", "infra/postgres/migrate.ts", "up"],
  {
    env: { ...process.env, KEYCORE_DATABASE_URL: databaseUrl },
    stdio: "inherit",
  },
);
if (migration.error || migration.status !== 0) {
  throw new Error("STAGING_CHECKOUT_MIGRATION_FAILED");
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

function internalDatabaseUrl(password: string): string {
  const url = new URL(
    "postgresql://keycore_staging@postgres:5432/keycore_staging",
  );
  url.password = password;
  return url.toString();
}
