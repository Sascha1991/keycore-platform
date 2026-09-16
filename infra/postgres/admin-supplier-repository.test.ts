import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { correlationId } from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "./client.js";
import { PostgresAdminSupplierMutationRepository } from "./admin-supplier-repository.js";

const context = {
  actorId: "admin-owner",
  at: new Date("2026-09-13T10:00:00.000Z"),
  correlationId: correlationId("supplier-repository-test"),
  environment: "STAGING" as const,
};
const input = {
  displayName: "Zweiter Testlieferant",
  operationId: "30000000-0000-4000-8000-000000000001",
  supplierCode: "admin-supplier-30000000-0000-4000-8000-000000000001",
  supplierId: "40000000-0000-4000-8000-000000000001",
};

describe("PostgresAdminSupplierMutationRepository", () => {
  it("creates an inert supplier and its safe audit event in one transaction", async () => {
    const database = new CapturingTransaction([[], [], []]);
    const repository = new PostgresAdminSupplierMutationRepository(database);

    await expect(repository.create(input, context)).resolves.toEqual({
      status: "CREATED",
      supplierId: input.supplierId,
    });
    expect(database.transactions).toBe(1);
    expect(database.calls[1]?.sql).toContain("'{}'::jsonb");
    expect(database.calls[1]?.sql).not.toMatch(
      /credential|secret|sync|offer|product/iu,
    );
    expect(database.calls[2]?.values).toEqual(
      expect.arrayContaining(["ADMIN_SUPPLIER_CREATED"]),
    );
    expect(JSON.stringify(database.calls)).not.toMatch(/providerType/iu);
  });

  it("configures one credential-less integration and audits it atomically", async () => {
    const integration = {
      adapterType: "SYNTHETIC" as const,
      capabilities: { catalog: true },
      integrationId: "50000000-0000-4000-8000-000000000001",
      operationId: "60000000-0000-4000-8000-000000000001",
      supplierId: input.supplierId,
    };
    const database = new CapturingTransaction([
      [{ id: input.supplierId }],
      [],
      [],
      [],
    ]);
    const repository = new PostgresAdminSupplierMutationRepository(database);

    await expect(
      repository.configureIntegration(integration, context),
    ).resolves.toBe("CREATED");
    expect(database.transactions).toBe(1);
    expect(database.calls[2]?.sql).toContain("supplier_integrations");
    expect(database.calls[2]?.sql).toContain("'{}'::jsonb");
    expect(database.calls[3]?.values).toEqual(
      expect.arrayContaining(["ADMIN_SUPPLIER_INTEGRATION_CONFIGURED"]),
    );
    expect(JSON.stringify(database.calls)).not.toMatch(
      /password|secret|token/iu,
    );
  });

  it("makes a repeated operation id idempotent without another write", async () => {
    const database = new CapturingTransaction([
      [{ display_name: input.displayName, id: input.supplierId }],
    ]);
    const repository = new PostgresAdminSupplierMutationRepository(database);

    await expect(repository.create(input, context)).resolves.toEqual({
      status: "IDEMPOTENT",
      supplierId: input.supplierId,
    });
    expect(database.calls).toHaveLength(1);
  });

  it("uses the version guard for rename and audits only actual changes", async () => {
    const database = new CapturingTransaction([
      [{ display_name: "Alter Name", record_version: 2 }],
      [],
      [],
    ]);
    const repository = new PostgresAdminSupplierMutationRepository(database);

    await expect(
      repository.rename(
        {
          displayName: "Neuer Name",
          expectedVersion: 2,
          supplierId: input.supplierId,
        },
        context,
      ),
    ).resolves.toBe("UPDATED");
    expect(database.calls[1]?.sql).toContain(
      "record_version = record_version + 1",
    );
    expect(database.calls[2]?.values).toEqual(
      expect.arrayContaining([
        "ADMIN_SUPPLIER_RENAMED",
        expect.stringContaining('"previousDisplayName":"Alter Name"'),
      ]),
    );

    const stale = new CapturingTransaction([
      [{ display_name: "Alter Name", record_version: 3 }],
    ]);
    await expect(
      new PostgresAdminSupplierMutationRepository(stale).rename(
        {
          displayName: "Neuer Name",
          expectedVersion: 2,
          supplierId: input.supplierId,
        },
        context,
      ),
    ).resolves.toBe("STALE");
    expect(stale.calls).toHaveLength(1);
  });
});

class CapturingTransaction implements TransactionalQueryable {
  public readonly calls: {
    readonly sql: string;
    readonly values: readonly unknown[] | undefined;
  }[] = [];
  public transactions = 0;

  public constructor(private readonly resultRows: readonly unknown[][]) {}

  public async query<TResult extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ) {
    const index = this.calls.length;
    this.calls.push({ sql, values });
    const rows = (this.resultRows[index] ?? []) as TResult[];
    return {
      command: "SELECT",
      fields: [],
      oid: 0,
      rowCount: rows.length,
      rows,
    };
  }

  public async transaction<TResult>(
    callback: (client: Queryable) => Promise<TResult>,
  ): Promise<TResult> {
    this.transactions += 1;
    return callback(this);
  }
}
