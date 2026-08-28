import { spawnSync } from "node:child_process";
import process from "node:process";

import {
  loadStagingPreflightConfiguration,
  verifyStagingConfiguration,
} from "../packages/platform/src/staging/staging-preflight.js";

const configuration = loadStagingPreflightConfiguration(process.env);
const report = verifyStagingConfiguration(configuration);

if (report.status !== "READY") {
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = 1;
} else {
  const migration = spawnSync(
    process.execPath,
    ["--import", "tsx", "infra/postgres/migrate.ts", "up"],
    { env: process.env, stdio: "inherit" },
  );
  if (migration.error) {
    process.stderr.write("Staging migration command failed to start.\n");
    process.exitCode = 1;
  } else {
    process.exitCode = migration.status ?? 1;
  }
}
