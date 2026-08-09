import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly upSql: string;
  readonly downSql: string;
}

const migrationFilePattern = /^(\d+)_(.+)\.(up|down)\.sql$/;

export const migrationsDirectory = path.join(
  process.cwd(),
  "infra",
  "postgres",
  "migrations",
);

export const loadMigrations = async (
  directory = migrationsDirectory,
): Promise<readonly Migration[]> => {
  const files = await readdir(directory);
  const grouped = new Map<
    string,
    { name: string; upSql?: string; downSql?: string }
  >();

  for (const file of files) {
    const match = migrationFilePattern.exec(file);
    if (!match) {
      continue;
    }

    const [, version, name, direction] = match;
    if (!version || !name || !direction) {
      continue;
    }

    const existing = grouped.get(version) ?? { name };
    const sql = await readFile(path.join(directory, file), "utf8");

    if (direction === "up") {
      existing.upSql = sql;
    } else {
      existing.downSql = sql;
    }

    grouped.set(version, existing);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([version, migration]) => {
      if (!migration.upSql || !migration.downSql) {
        throw new Error(`Migration ${version}_${migration.name} is incomplete`);
      }

      return {
        downSql: migration.downSql,
        name: migration.name,
        upSql: migration.upSql,
        version,
      };
    });
};
