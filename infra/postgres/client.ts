import { Pool, type QueryResult, type QueryResultRow } from "pg";

export interface PostgresConfig {
  readonly connectionString: string;
}

export type QueryParameters = readonly unknown[];

export interface Queryable {
  query<TResult extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: QueryParameters,
  ): Promise<QueryResult<TResult>>;
}

export interface TransactionalQueryable extends Queryable {
  transaction<TResult>(
    callback: (client: Queryable) => Promise<TResult>,
  ): Promise<TResult>;
}

export const createPostgresPool = (config: PostgresConfig): Pool =>
  new Pool({
    connectionString: config.connectionString,
  });

export class PostgresTransactionBoundary implements TransactionalQueryable {
  public constructor(private readonly pool: Pool) {}

  public async query<TResult extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: QueryParameters,
  ): Promise<QueryResult<TResult>> {
    return this.pool.query<TResult>(text, values ? [...values] : undefined);
  }

  public async transaction<TResult>(
    callback: (client: Queryable) => Promise<TResult>,
  ): Promise<TResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback({
        query: async <TRow extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: QueryParameters,
        ): Promise<QueryResult<TRow>> =>
          client.query<TRow>(text, values ? [...values] : undefined),
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
