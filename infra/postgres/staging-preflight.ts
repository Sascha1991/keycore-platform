import { Client } from "pg";

import type { StagingMigrationStatus } from "../../packages/platform/src/staging/staging-preflight.js";
import { loadMigrations } from "./migrations.js";

export const inspectStagingMigrationStatus = async (
  databaseUrl: string | undefined,
): Promise<StagingMigrationStatus> => {
  const expectedVersions = (await loadMigrations()).map(
    (migration) => migration.version,
  );
  if (!databaseUrl) {
    return { appliedVersions: [], expectedVersions, reachable: false };
  }
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const result = await client.query<{ readonly version: string }>(
      "SELECT version FROM keycore_migrations ORDER BY version",
    );
    return {
      appliedVersions: result.rows.map((row) => row.version),
      expectedVersions,
      reachable: true,
    };
  } catch {
    return { appliedVersions: [], expectedVersions, reachable: false };
  } finally {
    await client.end().catch(() => undefined);
  }
};
