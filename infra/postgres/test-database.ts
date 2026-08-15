import { Client, type QueryResult, type QueryResultRow } from "pg";

import { loadMigrations, type Migration } from "./migrations.js";

const pgcryptoAdvisoryLockKey = [0x4b435052, 0x0503] as const;

export interface PostgresTestDatabaseOptions {
  readonly connectionString: string | undefined;
  readonly schemaName: string;
}

export class PostgresTestDatabase {
  private readonly client: Client;
  private readonly appliedMigrations: Migration[] = [];
  private connected = false;

  public constructor(private readonly options: PostgresTestDatabaseOptions) {
    this.client = new Client({ connectionString: options.connectionString });
  }

  public static async initialize(
    options: PostgresTestDatabaseOptions,
  ): Promise<PostgresTestDatabase> {
    const database = new PostgresTestDatabase(options);
    try {
      await database.connect();
      await database.ensureGlobalExtensions();
      await database.createIsolatedSchema();
      await database.applyAllMigrations();
      return database;
    } catch (error) {
      await database.cleanup(error);
      throw error;
    }
  }

  public get schemaName(): string {
    return this.options.schemaName;
  }

  public async query<TResult extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<TResult>> {
    return this.client.query<TResult>(sql, values ? [...values] : undefined);
  }

  public async applyAllMigrations(): Promise<void> {
    await this.setSearchPath();
    const migrations = await loadMigrations();
    for (const migration of migrations) {
      await this.query(migration.upSql);
      await this.query(
        "INSERT INTO keycore_migrations(version, name) VALUES ($1, $2)",
        [migration.version, migration.name],
      );
      this.appliedMigrations.push(migration);
    }
  }

  public async rollbackAppliedMigrations(): Promise<void> {
    await this.setSearchPath();
    const migrations = [...this.appliedMigrations].reverse();
    for (const migration of migrations) {
      await this.query(migration.downSql);
    }
    this.appliedMigrations.length = 0;
  }

  public async cleanup(primaryError?: unknown): Promise<void> {
    let cleanupError: unknown;
    if (this.connected) {
      try {
        await this.setSearchPath();
        await this.rollbackAppliedMigrations();
      } catch (error) {
        cleanupError = error;
      }

      try {
        await this.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(this.schemaName)} CASCADE`,
        );
      } catch (error) {
        cleanupError ??= error;
      }

      try {
        await this.client.end();
      } catch (error) {
        cleanupError ??= error;
      } finally {
        this.connected = false;
      }
    }

    if (!primaryError && cleanupError) {
      throw cleanupError;
    }
  }

  private async connect(): Promise<void> {
    if (!this.options.connectionString) {
      throw new Error("KEYCORE_TEST_DATABASE_URL is required");
    }
    await this.client.connect();
    this.connected = true;
  }

  private async ensureGlobalExtensions(): Promise<void> {
    await this.query("SELECT pg_advisory_lock($1, $2)", [
      pgcryptoAdvisoryLockKey[0],
      pgcryptoAdvisoryLockKey[1],
    ]);
    try {
      await this.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    } finally {
      await this.query("SELECT pg_advisory_unlock($1, $2)", [
        pgcryptoAdvisoryLockKey[0],
        pgcryptoAdvisoryLockKey[1],
      ]);
    }
  }

  private async createIsolatedSchema(): Promise<void> {
    await this.query(`CREATE SCHEMA ${quoteIdentifier(this.schemaName)}`);
    await this.setSearchPath();
  }

  private async setSearchPath(): Promise<void> {
    await this.query(
      `SET search_path TO ${quoteIdentifier(this.schemaName)}, public`,
    );
  }
}

export const quoteIdentifier = (identifier: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
};
