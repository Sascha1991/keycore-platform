import process from "node:process";

import { Client } from "pg";

import { loadMigrations } from "./migrations.js";

type MigrationCommand = "up" | "down" | "status";

const command = (process.argv[2] ?? "status") as MigrationCommand;

const databaseUrl =
  process.env.KEYCORE_DATABASE_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    "Missing KEYCORE_DATABASE_URL or DATABASE_URL for migration command.",
  );
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });

const ensureMigrationTable = async (): Promise<void> => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS keycore_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
};

const appliedVersions = async (): Promise<Set<string>> => {
  await ensureMigrationTable();
  const result = await client.query<{ version: string }>(
    "SELECT version FROM keycore_migrations ORDER BY version",
  );
  return new Set(result.rows.map((row) => row.version));
};

const migrateUp = async (): Promise<void> => {
  const migrations = await loadMigrations();
  const applied = await appliedVersions();

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }

    await client.query("BEGIN");
    try {
      await client.query(migration.upSql);
      await client.query(
        "INSERT INTO keycore_migrations(version, name) VALUES ($1, $2)",
        [migration.version, migration.name],
      );
      await client.query("COMMIT");
      console.log(`Applied ${migration.version}_${migration.name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
};

const migrateDown = async (): Promise<void> => {
  const migrations = await loadMigrations();
  const applied = await appliedVersions();
  const latest = [...migrations]
    .reverse()
    .find((migration) => applied.has(migration.version));

  if (!latest) {
    console.log("No applied migrations to roll back.");
    return;
  }

  await client.query("BEGIN");
  try {
    await client.query(latest.downSql);
    await client.query("DELETE FROM keycore_migrations WHERE version = $1", [
      latest.version,
    ]);
    await client.query("COMMIT");
    console.log(`Rolled back ${latest.version}_${latest.name}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
};

const printStatus = async (): Promise<void> => {
  const migrations = await loadMigrations();
  const applied = await appliedVersions();

  for (const migration of migrations) {
    const state = applied.has(migration.version) ? "applied" : "pending";
    console.log(`${migration.version}_${migration.name}: ${state}`);
  }
};

await client.connect();

try {
  if (command === "up") {
    await migrateUp();
  } else if (command === "down") {
    await migrateDown();
  } else if (command === "status") {
    await printStatus();
  } else {
    throw new Error(`Unknown migration command: ${command}`);
  }
} finally {
  await client.end();
}
