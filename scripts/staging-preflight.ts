import process from "node:process";

import { inspectStagingMigrationStatus } from "../infra/postgres/staging-preflight.js";
import {
  StagingPreflightService,
  loadStagingPreflightConfiguration,
  verifyStagingConfiguration,
} from "../packages/platform/src/staging/staging-preflight.js";

const configuration = loadStagingPreflightConfiguration(process.env);
const configurationReport = verifyStagingConfiguration(configuration);
const report =
  configurationReport.status === "UNREADY"
    ? configurationReport
    : new StagingPreflightService().verify(
        configuration,
        await inspectStagingMigrationStatus(process.env.KEYCORE_DATABASE_URL),
      );

process.stdout.write(`${JSON.stringify(report)}\n`);
if (report.status !== "READY") process.exitCode = 1;
