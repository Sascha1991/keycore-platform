import { describe, expect, it } from "vitest";

import { adminCapturedPaymentVolumeStates } from "../../packages/platform/src/contracts.js";
import { PostgresAdminOperationsRepository } from "./admin-operations-repository.js";
import type { Queryable } from "./client.js";

describe("PostgresAdminOperationsRepository query contracts", () => {
  it("aggregates supplier products and offers without joining either raw relation", async () => {
    let capturedSql = "";
    const database: Queryable = {
      query: async (sql) => {
        capturedSql = sql;
        return { command: "SELECT", fields: [], oid: 0, rowCount: 0, rows: [] };
      },
    };

    await new PostgresAdminOperationsRepository(database).listSuppliers({
      limit: 25,
    });

    expect(capturedSql).toContain("FROM selected_suppliers supplier");
    expect(capturedSql).toMatch(
      /FROM supplier_products supplier_product\s+WHERE supplier_product\.supplier_id = supplier\.id/u,
    );
    expect(capturedSql).toMatch(
      /FROM supplier_offers supplier_offer\s+WHERE supplier_offer\.supplier_id = supplier\.id/u,
    );
    expect(capturedSql).not.toMatch(/JOIN supplier_products/u);
    expect(capturedSql).not.toMatch(/JOIN supplier_offers/u);
    expect(capturedSql).not.toContain("count(DISTINCT");
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
