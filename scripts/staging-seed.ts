import process from "node:process";

import {
  PostgresTransactionBoundary,
  createPostgresPool,
} from "../infra/postgres/client.js";
import { inspectStagingMigrationStatus } from "../infra/postgres/staging-preflight.js";
import { seedSyntheticStagingData } from "../infra/postgres/staging-seed.js";
import {
  StagingPreflightService,
  loadStagingPreflightConfiguration,
  verifyStagingConfiguration,
} from "../packages/platform/src/staging/staging-preflight.js";

const configuration = loadStagingPreflightConfiguration(process.env);
const configurationReport = verifyStagingConfiguration(configuration);
if (
  configurationReport.status !== "READY" ||
  !process.env.KEYCORE_DATABASE_URL
) {
  process.stdout.write(`${JSON.stringify(configurationReport)}\n`);
  process.exitCode = 1;
} else {
  const migrations = await inspectStagingMigrationStatus(
    process.env.KEYCORE_DATABASE_URL,
  );
  const preflight = new StagingPreflightService().verify(
    configuration,
    migrations,
  );
  if (preflight.status !== "READY") {
    process.stdout.write(`${JSON.stringify(preflight)}\n`);
    process.exitCode = 1;
  } else {
    const pool = createPostgresPool({
      connectionString: process.env.KEYCORE_DATABASE_URL,
    });
    try {
      const result = await seedSyntheticStagingData(
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
  }
}
