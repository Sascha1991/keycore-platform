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

export const createPostgresPool = (config: PostgresConfig): Pool =>
  new Pool({
    connectionString: config.connectionString,
  });
