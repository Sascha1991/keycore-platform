import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Client, type QueryResult, type QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  correlationId,
  decryptProductKeyMaterial,
  encryptProductKeyMaterial,
  orderLineId,
  type AuditEvent,
} from "../../packages/platform/src/contracts.js";
import { DevelopmentKeyManagementProvider } from "../key-management/development-provider.js";
import { loadMigrations, migrationsDirectory } from "./migrations.js";
import {
  PostgresAuditEventRepository,
  PostgresAuditQueryRepository,
  PostgresEncryptedKeyRepository,
} from "./repositories.js";

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
  readonly supplierProductExternalId: string;
}> => {
  const suffix = randomUUID();
  const supplierProductExternalId = `sp-${suffix}`;
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
    [supplierId, supplierProductExternalId],
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
    supplierProductExternalId,
  };
};

const auditEvent = (override: Partial<AuditEvent> = {}): AuditEvent => ({
  actor: { id: "system", type: "SYSTEM" },
  correlationId: correlationId(`corr-${randomUUID()}`),
  entity: { id: randomUUID(), type: "ORDER_LINE" },
  environment: "CI",
  eventType: "KEY_REVEALED",
  metadata: { keyVersion: "local-v1", retryCount: 0 },
  outcome: "SUCCEEDED",
  reasonCode: "AUTHORIZED_TEST_REVEAL",
  timestampUtc: new Date("2026-01-01T00:00:00.000Z"),
  uuid: randomUUID(),
  ...override,
});

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
        "INSERT INTO supplier_products(supplier_id, supplier_product_id, title) VALUES ($1, $2, 'Duplicate Title')",
        [fixture.supplierId, fixture.supplierProductExternalId],
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

  it("stores only encrypted key material and persists key version metadata", async () => {
    if (!client) {
      throw new Error("PostgreSQL client is not initialized");
    }

    const fixture = await insertFixtureGraph();
    const repository = new PostgresEncryptedKeyRepository(client);
    const provider = new DevelopmentKeyManagementProvider({
      environmentName: "test",
      masterKeyMaterialBase64: randomBytes(32).toString("base64"),
      masterKeyVersion: "local-v1",
    });
    const canary = Buffer.from(`synthetic-canary-${randomUUID()}`, "utf8");
    const material = await encryptProductKeyMaterial(
      canary,
      { orderLineId: orderLineId(fixture.orderLineId) },
      provider,
    );

    const stored = await repository.store({
      material,
      orderLineId: orderLineId(fixture.orderLineId),
    });
    const raw = await query<{
      authentication_tag: Buffer;
      ciphertext: Buffer;
      key_version: string;
      nonce: Buffer;
      wrapped_data_encryption_key: Buffer;
    }>(
      `
        SELECT ciphertext, nonce, authentication_tag, wrapped_data_encryption_key, key_version
        FROM encrypted_key_records
        WHERE id = $1
      `,
      [stored.id],
    );
    const serializedRaw = JSON.stringify(raw.rows[0]);

    expect(stored.keyVersion).toBe("local-v1");
    expect(serializedRaw).not.toContain(canary.toString("utf8"));
    expect(raw.rows[0]?.key_version).toBe("local-v1");
  });

  it("rejects duplicate encrypted key records for the same order line", async () => {
    if (!client) {
      throw new Error("PostgreSQL client is not initialized");
    }

    const fixture = await insertFixtureGraph();
    const repository = new PostgresEncryptedKeyRepository(client);
    const provider = new DevelopmentKeyManagementProvider({
      environmentName: "test",
      masterKeyMaterialBase64: randomBytes(32).toString("base64"),
      masterKeyVersion: "local-v1",
    });
    const material = await encryptProductKeyMaterial(
      Buffer.from(`synthetic-${randomUUID()}`, "utf8"),
      { orderLineId: orderLineId(fixture.orderLineId) },
      provider,
    );

    await repository.store({
      material,
      orderLineId: orderLineId(fixture.orderLineId),
    });

    await expect(
      repository.store({
        material: await encryptProductKeyMaterial(
          Buffer.from(`synthetic-${randomUUID()}`, "utf8"),
          { orderLineId: orderLineId(fixture.orderLineId) },
          provider,
        ),
        orderLineId: orderLineId(fixture.orderLineId),
      }),
    ).rejects.toThrow();
  });

  it("fails authenticated reveal when encrypted material is swapped between order lines", async () => {
    if (!client) {
      throw new Error("PostgreSQL client is not initialized");
    }

    const firstFixture = await insertFixtureGraph();
    const secondFixture = await insertFixtureGraph();
    const firstOrderLineId = orderLineId(firstFixture.orderLineId);
    const secondOrderLineId = orderLineId(secondFixture.orderLineId);
    const repository = new PostgresEncryptedKeyRepository(client);
    const provider = new DevelopmentKeyManagementProvider({
      environmentName: "test",
      masterKeyMaterialBase64: randomBytes(32).toString("base64"),
      masterKeyVersion: "local-v1",
    });
    const first = await repository.store({
      material: await encryptProductKeyMaterial(
        Buffer.from(`synthetic-${randomUUID()}`, "utf8"),
        { orderLineId: firstOrderLineId },
        provider,
      ),
      orderLineId: firstOrderLineId,
    });
    const second = await repository.store({
      material: await encryptProductKeyMaterial(
        Buffer.from(`synthetic-${randomUUID()}`, "utf8"),
        { orderLineId: secondOrderLineId },
        provider,
      ),
      orderLineId: secondOrderLineId,
    });

    await query(
      `
        UPDATE encrypted_key_records target
        SET ciphertext = source.ciphertext,
            nonce = source.nonce,
            authentication_tag = source.authentication_tag,
            wrapped_data_encryption_key = source.wrapped_data_encryption_key,
            algorithm = source.algorithm,
            key_version = source.key_version
        FROM encrypted_key_records source
        WHERE target.id = $1 AND source.id = $2
      `,
      [first.id, second.id],
    );
    const swapped = await repository.findById(first.id);
    if (!swapped) {
      throw new Error("Expected swapped encrypted key record");
    }

    await expect(
      decryptProductKeyMaterial(
        swapped,
        { orderLineId: firstOrderLineId },
        provider,
      ),
    ).rejects.toThrow("verification failed");
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

  it("persists audit events through the append-only repository", async () => {
    if (!client) {
      throw new Error("PostgreSQL client is not initialized");
    }

    const repository = new PostgresAuditEventRepository(client);
    const event = auditEvent({
      correlationId: correlationId("corr-audit-persist"),
      metadata: {
        keyVersion: "local-v1",
        orderLineId: randomUUID(),
        retryCount: 1,
      },
    });

    await repository.append(event);

    const persisted = await query<{
      correlation_id: string;
      event_type: string;
      metadata: { keyVersion: string; retryCount: number };
      outcome: string;
      reason_code: string;
    }>(
      `
        SELECT event_type, correlation_id, outcome, reason_code, metadata
        FROM audit_events
        WHERE id = $1
      `,
      [event.uuid],
    );

    expect(persisted.rows[0]).toEqual({
      correlation_id: "corr-audit-persist",
      event_type: "KEY_REVEALED",
      metadata: {
        keyVersion: "local-v1",
        orderLineId: expect.any(String),
        retryCount: 1,
      },
      outcome: "SUCCEEDED",
      reason_code: "AUTHORIZED_TEST_REVEAL",
    });
  });

  it("rejects unsafe audit metadata before persistence", async () => {
    if (!client) {
      throw new Error("PostgreSQL client is not initialized");
    }

    const repository = new PostgresAuditEventRepository(client);
    const event = auditEvent({
      metadata: {
        nested: {
          plaintextKey: "runtime-canary",
        },
      },
    });

    await expect(repository.append(event)).rejects.toThrow("forbidden field");

    const persisted = await query<{ count: string }>(
      "SELECT count(*) FROM audit_events WHERE id = $1",
      [event.uuid],
    );
    expect(persisted.rows[0]?.count).toBe("0");
  });

  it("queries audit events with bounded keyset pagination", async () => {
    if (!client) {
      throw new Error("PostgreSQL client is not initialized");
    }

    const appendRepository = new PostgresAuditEventRepository(client);
    const queryRepository = new PostgresAuditQueryRepository(client);
    const sharedCorrelationId = correlationId(`corr-query-${randomUUID()}`);
    const entity = { id: randomUUID(), type: "ORDER_LINE" };
    const actor = { id: "auditor-system", type: "SYSTEM" } as const;
    const first = auditEvent({
      actor,
      correlationId: sharedCorrelationId,
      entity,
      timestampUtc: new Date("2026-01-01T00:00:00.000Z"),
      uuid: "00000000-0000-4000-8000-000000000001",
    });
    const second = auditEvent({
      actor,
      correlationId: sharedCorrelationId,
      entity,
      timestampUtc: new Date("2026-01-01T00:00:00.000Z"),
      uuid: "00000000-0000-4000-8000-000000000002",
    });
    const third = auditEvent({
      actor,
      correlationId: sharedCorrelationId,
      entity,
      eventType: "KEY_ACCESS_DENIED",
      outcome: "DENIED",
      reasonCode: "NOT_AUTHORIZED",
      timestampUtc: new Date("2026-01-01T00:00:01.000Z"),
      uuid: "00000000-0000-4000-8000-000000000003",
    });

    await appendRepository.append(first);
    await appendRepository.append(second);
    await appendRepository.append(third);

    const firstPage = await queryRepository.query({
      filters: {
        actor,
        correlationId: sharedCorrelationId,
        entity,
        fromTimestampUtc: new Date("2026-01-01T00:00:00.000Z"),
        toTimestampUtc: new Date("2026-01-01T00:00:02.000Z"),
      },
      pageSize: 2,
    });

    expect(firstPage.events.map((event) => event.uuid)).toEqual([
      first.uuid,
      second.uuid,
    ]);
    expect(firstPage.nextCursor).toEqual({
      timestampUtc: second.timestampUtc,
      uuid: second.uuid,
    });
    if (!firstPage.nextCursor) {
      throw new Error("Expected audit query next cursor");
    }

    const secondPage = await queryRepository.query({
      cursor: firstPage.nextCursor,
      filters: {
        actor,
        correlationId: sharedCorrelationId,
        entity,
      },
      pageSize: 2,
    });

    expect(secondPage.events.map((event) => event.uuid)).toEqual([third.uuid]);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it("supports concurrent audit appends without UUID overwrite", async () => {
    if (!client) {
      throw new Error("PostgreSQL client is not initialized");
    }

    const repository = new PostgresAuditEventRepository(client);
    const sharedCorrelationId = correlationId(
      `corr-concurrent-${randomUUID()}`,
    );
    const events = Array.from({ length: 8 }, (_, index) =>
      auditEvent({
        correlationId: sharedCorrelationId,
        metadata: { index },
      }),
    );

    await Promise.all(events.map((event) => repository.append(event)));

    const persisted = await query<{ count: string; distinct_count: string }>(
      `
        SELECT count(*)::text, count(DISTINCT id)::text AS distinct_count
        FROM audit_events
        WHERE correlation_id = $1
      `,
      [sharedCorrelationId],
    );

    expect(persisted.rows[0]).toEqual({
      count: "8",
      distinct_count: "8",
    });
  });

  it("creates audit query support indexes", async () => {
    const indexes = await query<{ indexname: string }>(
      `
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'audit_events'
      `,
      [schemaName],
    );

    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        "idx_audit_events_correlation_keyset",
        "idx_audit_events_entity_keyset",
        "idx_audit_events_event_type_keyset",
        "idx_audit_events_actor_keyset",
        "idx_audit_events_timestamp_keyset",
        "idx_audit_events_outcome_keyset",
        "idx_audit_events_reason_code_keyset",
      ]),
    );
  });

  it("exposes no update or delete API for normal audit appends", () => {
    if (!client) {
      throw new Error("PostgreSQL client is not initialized");
    }

    const repository = new PostgresAuditEventRepository(client);

    expect("append" in repository).toBe(true);
    expect("update" in repository).toBe(false);
    expect("delete" in repository).toBe(false);
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

  it("creates durable outbox records and claims due work once", async () => {
    const dedupeKey = `dedupe-${randomUUID()}`;
    await query(
      `
        INSERT INTO outbox_events(
          event_type,
          aggregate_type,
          aggregate_id,
          payload,
          correlation_id,
          event_deduplication_key,
          next_attempt_at
        )
        VALUES ('synthetic.event', 'synthetic', gen_random_uuid(), '{"referenceId":"entity-1"}', 'corr-outbox', $1, now())
      `,
      [dedupeKey],
    );

    const firstClaim = await query<{ id: string }>(
      `
        WITH due AS (
          SELECT id
          FROM outbox_events
          WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= now()
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox_events
        SET status = 'CLAIMED'
        WHERE id IN (SELECT id FROM due)
        RETURNING id
      `,
    );
    const secondClaim = await query<{ id: string }>(
      `
        WITH due AS (
          SELECT id
          FROM outbox_events
          WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= now()
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE outbox_events
        SET status = 'CLAIMED'
        WHERE id IN (SELECT id FROM due)
        RETURNING id
      `,
    );

    expect(firstClaim.rowCount).toBe(1);
    expect(secondClaim.rowCount).toBe(0);
  });

  it("transitions outbox publication status and retry scheduling", async () => {
    const created = await query<{ id: string }>(
      `
        INSERT INTO outbox_events(
          event_type,
          aggregate_type,
          aggregate_id,
          payload,
          correlation_id,
          event_deduplication_key,
          status
        )
        VALUES ('synthetic.event', 'synthetic', gen_random_uuid(), '{"referenceId":"entity-2"}', 'corr-outbox-2', $1, 'CLAIMED')
        RETURNING id
      `,
      [`dedupe-${randomUUID()}`],
    );
    const id = created.rows[0]?.id;
    expect(id).toBeDefined();

    await query(
      "UPDATE outbox_events SET status = 'PUBLISHED', dispatched_at = now() WHERE id = $1",
      [id],
    );
    const published = await query<{ status: string }>(
      "SELECT status FROM outbox_events WHERE id = $1",
      [id],
    );
    expect(published.rows[0]?.status).toBe("PUBLISHED");

    const retry = await query<{ id: string }>(
      `
        INSERT INTO outbox_events(
          event_type,
          aggregate_type,
          aggregate_id,
          payload,
          correlation_id,
          event_deduplication_key,
          status,
          retry_count,
          next_attempt_at,
          last_error_classification
        )
        VALUES ('synthetic.event', 'synthetic', gen_random_uuid(), '{"referenceId":"entity-3"}', 'corr-outbox-3', $1, 'FAILED', 1, now() + interval '1 minute', 'RETRYABLE')
        RETURNING id
      `,
      [`dedupe-${randomUUID()}`],
    );
    expect(retry.rows[0]?.id).toBeDefined();
  });

  it("keeps PostgreSQL outbox intent when Redis publication is unavailable", async () => {
    const dedupeKey = `dedupe-${randomUUID()}`;
    await query(
      `
        INSERT INTO outbox_events(
          event_type,
          aggregate_type,
          aggregate_id,
          payload,
          correlation_id,
          event_deduplication_key,
          status,
          last_error_classification
        )
        VALUES ('synthetic.event', 'synthetic', gen_random_uuid(), '{"referenceId":"entity-4"}', 'corr-redis-down', $1, 'FAILED', 'RETRYABLE_PUBLICATION_FAILURE')
      `,
      [dedupeKey],
    );

    const durableIntent = await query<{ status: string }>(
      "SELECT status FROM outbox_events WHERE event_deduplication_key = $1",
      [dedupeKey],
    );

    expect(durableIntent.rows[0]?.status).toBe("FAILED");
  });

  it("creates due reconciliation work and escalates manual review", async () => {
    const fixture = await insertFixtureGraph();
    const created = await query<{ id: string }>(
      `
        INSERT INTO reconciliation_records(
          order_line_id,
          reconciliation_type,
          state,
          correlation_id,
          next_attempt_at
        )
        VALUES ($1, 'PAYMENT_AMBIGUITY', 'PENDING', 'corr-recon', now())
        RETURNING id
      `,
      [fixture.orderLineId],
    );

    const claimed = await query<{ id: string }>(
      `
        WITH due AS (
          SELECT id
          FROM reconciliation_records
          WHERE state IN ('PENDING', 'FAILED') AND next_attempt_at <= now()
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE reconciliation_records
        SET state = 'CLAIMED'
        WHERE id IN (SELECT id FROM due)
        RETURNING id
      `,
    );

    expect(claimed.rows[0]?.id).toBe(created.rows[0]?.id);

    await query(
      `
        UPDATE reconciliation_records
        SET state = 'MANUAL_REVIEW',
            manual_review_required = true,
            last_error_classification = 'EXHAUSTED'
        WHERE id = $1
      `,
      [created.rows[0]?.id],
    );
    const escalated = await query<{
      manual_review_required: boolean;
      state: string;
    }>(
      "SELECT state, manual_review_required FROM reconciliation_records WHERE id = $1",
      [created.rows[0]?.id],
    );

    expect(escalated.rows[0]).toEqual({
      manual_review_required: true,
      state: "MANUAL_REVIEW",
    });
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
