import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadMigrations, migrationsDirectory } from "./migrations.js";

const databaseUrl = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const schemaName = `ks_${randomUUID().replaceAll("-", "_")}`;

let client: Client | undefined;

const query = async <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  values?: readonly unknown[],
): Promise<QueryResult<T>> => {
  if (!client) {
    throw new Error("PostgreSQL client is not initialized");
  }

  return client.query<T>(sql, values ? [...values] : undefined);
};

const applyAllMigrations = async (): Promise<void> => {
  const migrations = await loadMigrations();
  for (const migration of migrations) {
    await query(migration.upSql);
    await query(
      "INSERT INTO keycore_migrations(version, name) VALUES ($1, $2)",
      [migration.version, migration.name],
    );
  }
};

const rollbackAllMigrations = async (): Promise<void> => {
  const migrations = [...(await loadMigrations())].reverse();
  for (const migration of migrations) {
    await query(migration.downSql);
  }
};

const insertFixtureGraph = async (): Promise<{
  readonly orderLineId: string;
  readonly offerId: string;
  readonly supplierId: string;
}> => {
  const suffix = randomUUID();
  const supplier = await query<{ id: string }>(
    "INSERT INTO suppliers(supplier_code, display_name) VALUES ($1, 'Mock Supplier') RETURNING id",
    [`mock-${suffix}`],
  );
  const supplierId = supplier.rows[0]?.id;
  if (!supplierId) {
    throw new Error("Supplier fixture insert failed");
  }

  const supplierProduct = await query<{ id: string }>(
    "INSERT INTO supplier_products(supplier_id, supplier_product_id, title) VALUES ($1, $2, 'Synthetic Product') RETURNING id",
    [supplierId, `sp-${suffix}`],
  );
  const supplierProductId = supplierProduct.rows[0]?.id;
  if (!supplierProductId) {
    throw new Error("Supplier product fixture insert failed");
  }

  const product = await query<{ id: string }>(
    "INSERT INTO products(product_type, title, platform) VALUES ('GAME', 'Synthetic Product', 'WINDOWS') RETURNING id",
  );
  const productId = product.rows[0]?.id;
  if (!productId) {
    throw new Error("Product fixture insert failed");
  }

  const supplierOffer = await query<{ id: string }>(
    "INSERT INTO supplier_offers(supplier_id, supplier_product_id, supplier_offer_id) VALUES ($1, $2, $3) RETURNING id",
    [supplierId, supplierProductId, `so-${suffix}`],
  );
  const supplierOfferId = supplierOffer.rows[0]?.id;
  if (!supplierOfferId) {
    throw new Error("Supplier offer fixture insert failed");
  }

  const offer = await query<{ id: string }>(
    "INSERT INTO offers(product_id, supplier_offer_id, availability) VALUES ($1, $2, 'IN_STOCK') RETURNING id",
    [productId, supplierOfferId],
  );
  const offerId = offer.rows[0]?.id;
  if (!offerId) {
    throw new Error("Offer fixture insert failed");
  }

  const customer = await query<{ id: string }>(
    "INSERT INTO customers(external_customer_reference) VALUES ($1) RETURNING id",
    [`customer-${suffix}`],
  );
  const customerId = customer.rows[0]?.id;
  if (!customerId) {
    throw new Error("Customer fixture insert failed");
  }

  const order = await query<{ id: string }>(
    "INSERT INTO commerce_orders(customer_id, external_order_reference, status) VALUES ($1, $2, 'CREATED') RETURNING id",
    [customerId, `order-${suffix}`],
  );
  const orderId = order.rows[0]?.id;
  if (!orderId) {
    throw new Error("Order fixture insert failed");
  }

  const orderLine = await query<{ id: string }>(
    "INSERT INTO commerce_order_lines(order_id, offer_id, external_order_line_reference) VALUES ($1, $2, $3) RETURNING id",
    [orderId, offerId, `line-${suffix}`],
  );
  const orderLineId = orderLine.rows[0]?.id;
  if (!orderLineId) {
    throw new Error("Order line fixture insert failed");
  }

  return {
    offerId,
    orderLineId,
    supplierId,
  };
};

describePostgres("PostgreSQL persistence foundation", () => {
  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await query(`CREATE SCHEMA ${schemaName}`);
    await query(`SET search_path TO ${schemaName}, public`);
    await applyAllMigrations();
  });

  afterAll(async () => {
    if (client) {
      await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await client.end();
    }
  });

  it("applies migrations and creates required tables", async () => {
    const expectedTables = [
      "suppliers",
      "supplier_products",
      "supplier_offers",
      "products",
      "offers",
      "region_evidence",
      "region_decisions",
      "price_snapshots",
      "customers",
      "commerce_orders",
      "commerce_order_lines",
      "payment_records",
      "procurement_records",
      "fulfillment_records",
      "refund_records",
      "encrypted_key_records",
      "audit_events",
      "idempotency_records",
      "outbox_events",
      "reconciliation_records",
    ];

    const result = await query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1
        ORDER BY table_name
      `,
      [schemaName],
    );

    expect(result.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining(expectedTables),
    );
  });

  it("enforces foreign keys and critical uniqueness constraints", async () => {
    const fixture = await insertFixtureGraph();

    await expect(
      query(
        "INSERT INTO supplier_products(supplier_id, supplier_product_id, title) VALUES ($1, 'sp-1', 'Duplicate')",
        [fixture.supplierId],
      ),
    ).rejects.toThrow();

    await expect(
      query(
        "INSERT INTO offers(product_id, supplier_offer_id, availability) VALUES (gen_random_uuid(), gen_random_uuid(), 'UNKNOWN')",
      ),
    ).rejects.toThrow();
  });

  it("rejects duplicate payment provider event IDs", async () => {
    const fixture = await insertFixtureGraph();

    await query(
      "INSERT INTO payment_records(order_line_id, provider_name, provider_event_id, state, amount_minor, currency, idempotency_key) VALUES ($1, 'provider', 'evt-1', 'CAPTURED', 1000, 'EUR', 'pay-1')",
      [fixture.orderLineId],
    );

    await expect(
      query(
        "INSERT INTO payment_records(order_line_id, provider_name, provider_event_id, state, amount_minor, currency, idempotency_key) VALUES ($1, 'provider', 'evt-1', 'CAPTURED', 1000, 'EUR', 'pay-2')",
        [fixture.orderLineId],
      ),
    ).rejects.toThrow();
  });

  it("rejects duplicate supplier purchase and client idempotency references", async () => {
    const fixture = await insertFixtureGraph();

    await query(
      "INSERT INTO procurement_records(order_line_id, supplier_id, state, supplier_client_reference, supplier_purchase_reference) VALUES ($1, $2, 'PURCHASE_REQUESTED', 'client-ref-1', 'purchase-ref-1')",
      [fixture.orderLineId, fixture.supplierId],
    );

    const secondFixture = await insertFixtureGraph();
    await expect(
      query(
        "INSERT INTO procurement_records(order_line_id, supplier_id, state, supplier_client_reference, supplier_purchase_reference) VALUES ($1, $2, 'PURCHASE_REQUESTED', 'client-ref-1', 'purchase-ref-2')",
        [secondFixture.orderLineId, fixture.supplierId],
      ),
    ).rejects.toThrow();

    await expect(
      query(
        "INSERT INTO procurement_records(order_line_id, supplier_id, state, supplier_client_reference, supplier_purchase_reference) VALUES ($1, $2, 'PURCHASE_REQUESTED', 'client-ref-2', 'purchase-ref-1')",
        [secondFixture.orderLineId, fixture.supplierId],
      ),
    ).rejects.toThrow();
  });

  it("rejects invalid Germany compatibility decisions", async () => {
    const fixture = await insertFixtureGraph();
    const evidence = await query<{ id: string }>(
      "INSERT INTO region_evidence(offer_id) VALUES ($1) RETURNING id",
      [fixture.offerId],
    );

    await expect(
      query(
        "INSERT INTO region_decisions(offer_id, region_evidence_id, decision, reason_code, policy_version) VALUES ($1, $2, 'MAYBE', 'REGION_UNKNOWN_VALUE', 'v1')",
        [fixture.offerId, evidence.rows[0]?.id],
      ),
    ).rejects.toThrow();
  });

  it("stores money as integer minor units plus currency", async () => {
    const fixture = await insertFixtureGraph();

    await query(
      "INSERT INTO price_snapshots(offer_id, amount_minor, currency, availability) VALUES ($1, 1299, 'EUR', 'IN_STOCK')",
      [fixture.offerId],
    );

    await expect(
      query(
        "INSERT INTO price_snapshots(offer_id, amount_minor, currency, availability) VALUES ($1, -1, 'EUR', 'IN_STOCK')",
        [fixture.offerId],
      ),
    ).rejects.toThrow();
  });

  it("has no plaintext-key columns in encrypted key records", async () => {
    const result = await query<{ column_name: string }>(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'encrypted_key_records'
      `,
      [schemaName],
    );

    expect(result.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining([
        "plaintext_key",
        "raw_key",
        "decrypted_key",
        "unencrypted_product_key",
      ]),
    );
  });

  it("rejects audit metadata containing product-key fields", async () => {
    await expect(
      query(
        `
          INSERT INTO audit_events(
            event_type,
            timestamp_utc,
            actor,
            correlation_id,
            entity,
            environment,
            outcome,
            reason_code,
            metadata
          )
          VALUES (
            'SECURITY',
            now(),
            '{"type":"SYSTEM","id":"test"}',
            'corr-1',
            '{"type":"test","id":"1"}',
            'CI',
            'DENIED',
            'TEST',
            '{"productKey":"forbidden"}'
          )
        `,
      ),
    ).rejects.toThrow();
  });

  it("creates immutable UUID order-line identifiers", async () => {
    const fixture = await insertFixtureGraph();
    expect(fixture.orderLineId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
  });

  it("rolls back migrations in an isolated test schema", async () => {
    await rollbackAllMigrations();

    const result = await query<{ to_regclass: string | null }>(
      "SELECT to_regclass($1)",
      [`${schemaName}.suppliers`],
    );

    expect(result.rows[0]?.to_regclass).toBeNull();
    await applyAllMigrations();
  });
});

describe("PostgreSQL persistence static safety checks", () => {
  it("documents reversible migration files", async () => {
    const files = await readdir(migrationsDirectory);
    expect(files).toContain("001_initial_schema.up.sql");
    expect(files).toContain("001_initial_schema.down.sql");
  });

  it("keeps core/domain free of PostgreSQL client imports", async () => {
    const domainRoot = path.resolve("packages/platform/src/domain");
    const files = await readdir(domainRoot);
    const findings: string[] = [];

    for (const file of files) {
      if (!file.endsWith(".ts")) {
        continue;
      }

      const content = await readFile(path.join(domainRoot, file), "utf8");
      if (/from\s+["']pg["']|from\s+["']postgres["']/u.test(content)) {
        findings.push(file);
      }
    }

    expect(findings).toEqual([]);
  });

  it("does not define plaintext-key columns in migrations", async () => {
    const migration = await readFile(
      path.join(migrationsDirectory, "001_initial_schema.up.sql"),
      "utf8",
    );
    const encryptedKeyTable = migration.match(
      /CREATE TABLE encrypted_key_records \([\s\S]*?\n\);/u,
    )?.[0];

    expect(encryptedKeyTable).toBeDefined();
    expect(encryptedKeyTable).not.toMatch(
      /\b(plaintext_key|raw_key|decrypted_key|unencrypted_product_key)\b/iu,
    );
  });
});
