import { describe, expect, it } from "vitest";

import { adminCapturedPaymentVolumeStates } from "../../packages/platform/src/contracts.js";
import { PostgresAdminOperationsRepository } from "./admin-operations-repository.js";
import type { QueryResultRow } from "pg";
import type { Queryable, QueryParameters } from "./client.js";

describe("PostgresAdminOperationsRepository query contracts", () => {
  it("aggregates supplier products and offers without joining either raw relation", async () => {
    const capturedSql: string[] = [];
    const database: Queryable = {
      query: async <TResult extends QueryResultRow = QueryResultRow>(
        sql: string,
      ) => {
        capturedSql.push(sql);
        const rows = sql.includes("AS total_count")
          ? [{ total_count: "0" }]
          : sql.includes("AS total_suppliers")
            ? [
                {
                  suppliers_requiring_attention: "0",
                  suppliers_with_offers: "0",
                  suppliers_with_products: "0",
                  total_suppliers: "0",
                },
              ]
            : [];
        return {
          command: "SELECT",
          fields: [],
          oid: 0,
          rowCount: rows.length,
          rows: rows as unknown as TResult[],
        };
      },
    };

    await new PostgresAdminOperationsRepository(database).listSuppliers({
      limit: 25,
    });

    const listSql = capturedSql.find((sql) =>
      sql.includes("FROM selected_suppliers supplier"),
    );
    expect(listSql).toBeDefined();
    expect(listSql).toMatch(
      /FROM supplier_products supplier_product\s+WHERE supplier_product\.supplier_id = supplier\.id/u,
    );
    expect(listSql).toMatch(
      /FROM supplier_offers supplier_offer[\s\S]+WHERE supplier_offer\.supplier_id = supplier\.id/u,
    );
    expect(listSql).not.toMatch(/JOIN supplier_products/u);
    expect(listSql).not.toMatch(/JOIN supplier_offers/u);
    expect(listSql).not.toContain("count(DISTINCT");
  });

  it("binds supplier filters and keeps global metrics independent of the filtered page", async () => {
    const calls: { sql: string; values: readonly unknown[] | undefined }[] = [];
    const database: Queryable = {
      query: async <TResult extends QueryResultRow = QueryResultRow>(
        sql: string,
        values?: QueryParameters,
      ) => {
        calls.push({ sql, values });
        const rows = sql.includes("AS total_count")
          ? [{ total_count: "0" }]
          : sql.includes("AS total_suppliers")
            ? [
                {
                  suppliers_requiring_attention: "0",
                  suppliers_with_offers: "0",
                  suppliers_with_products: "0",
                  total_suppliers: "0",
                },
              ]
            : [];
        return {
          command: "SELECT",
          fields: [],
          oid: 0,
          rowCount: rows.length,
          rows: rows as unknown as TResult[],
        };
      },
    };

    await new PostgresAdminOperationsRepository(database).listSuppliers({
      catalog: "OPEN_MAPPINGS",
      limit: 10,
      offers: "AVAILABLE",
      quickView: "ATTENTION",
      search: "Synthetic",
      sort: "UPDATED_DESC",
      sync: "FAILED",
    });

    const list = calls.find(({ sql }) =>
      sql.includes("FROM selected_suppliers supplier"),
    );
    const metrics = calls.find(({ sql }) => sql.includes("AS total_suppliers"));
    expect(list?.sql).toContain("filtered_mapping.state = 'REVIEW_REQUIRED'");
    expect(list?.sql).toContain(
      "filtered_canonical_offer.availability IN ('IN_STOCK', 'LIMITED')",
    );
    expect(list?.values).toEqual([
      "Synthetic",
      "%Synthetic%",
      "%Synthetic%",
      "FAILED",
      11,
    ]);
    expect(metrics?.values).toBeUndefined();
  });

  it("loads bounded supplier detail without credential or provider payload columns", async () => {
    const sql: string[] = [];
    const database: Queryable = {
      query: async <TResult extends QueryResultRow = QueryResultRow>(
        statement: string,
      ) => {
        sql.push(statement);
        const rows = statement.includes("FROM suppliers supplier WHERE")
          ? [
              {
                available_offer_count: "0",
                capabilities: { catalog: true },
                created_at: new Date("2026-09-01T00:00:00.000Z"),
                current_offer_count: "0",
                display_name: "Synthetic Supplier",
                id: "20000000-0000-4000-8000-000000000001",
                last_successful_sync_at: null,
                latest_sync_at: null,
                latest_sync_status: null,
                mapped_product_count: "0",
                product_count: "0",
                review_required_count: "0",
                supplier_code: "synthetic",
                updated_at: new Date("2026-09-01T00:00:00.000Z"),
              },
            ]
          : [];
        return {
          command: "SELECT",
          fields: [],
          oid: 0,
          rowCount: rows.length,
          rows: rows as unknown as TResult[],
        };
      },
    };

    await expect(
      new PostgresAdminOperationsRepository(database).findSupplier(
        "20000000-0000-4000-8000-000000000001",
      ),
    ).resolves.toMatchObject({ capabilities: ["catalog"] });
    expect(sql.join("\n")).toContain("LIMIT 10");
    expect(sql.join("\n")).toContain("LIMIT 25");
    expect(sql.join("\n")).not.toMatch(
      /credential|secret|ciphertext|raw_payload/iu,
    );
  });

  it("binds the shared captured-payment-volume states in finance SQL", async () => {
    let capturedValues: readonly unknown[] | undefined;
    const database: Queryable = {
      query: async (_sql, values) => {
        capturedValues = values;
        return { command: "SELECT", fields: [], oid: 0, rowCount: 0, rows: [] };
      },
    };

    await new PostgresAdminOperationsRepository(database).financeSummary();

    expect(capturedValues).toEqual([adminCapturedPaymentVolumeStates]);
  });
});
