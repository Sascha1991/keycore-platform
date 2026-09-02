import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  hashAdminSession,
  orderId,
} from "../../packages/platform/src/contracts.js";
import {
  PostgresAdminOrderReadRepository,
  PostgresAdminSessionRepository,
} from "./admin-repositories.js";
import { PostgresTestDatabase } from "./test-database.js";

const connectionString = process.env.KEYCORE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const now = new Date("2026-09-02T10:00:00.000Z");
const hmacMaterial = [
  "postgres-admin",
  "material-longer-than-thirty-two-bytes",
].join("-");

describePostgres("secure admin PostgreSQL persistence", () => {
  it("persists only a hashed admin session and returns active roles", async () => {
    const database = await initDatabase();
    try {
      const rawSession = "postgres-admin-session-1234567890abcdef";
      const adminId = await insertAdmin(
        database,
        hashAdminSession(rawSession, hmacMaterial),
      );
      const repository = new PostgresAdminSessionRepository(database);

      await expect(
        repository.findByHash(hashAdminSession(rawSession, hmacMaterial)),
      ).resolves.toMatchObject({
        adminId,
        identityStatus: "ACTIVE",
        roles: ["PROJECT_OWNER"],
      });
      const stored = await database.query<{ readonly session_hash: string }>(
        "SELECT session_hash FROM admin_sessions WHERE admin_id = $1",
        [adminId],
      );
      expect(stored.rows[0]?.session_hash).toMatch(/^[a-f0-9]{64}$/u);
      expect(stored.rows[0]?.session_hash).not.toBe(rawSession);
    } finally {
      await database.cleanup();
    }
  }, 30_000);

  it("searches and hydrates orders without selecting fulfillment secret material", async () => {
    const database = await initDatabase();
    try {
      const customerId = randomUUID();
      const productId = await insertProduct(database);
      await database.query(
        `INSERT INTO keycore_customers(id, email_normalized, email_verification_state, record_version, created_at, updated_at) VALUES ($1, 'admin-customer@example.test', 'VERIFIED', 1, $2, $2)`,
        [customerId, now],
      );
      const createdOrderId = await insertOrder(database, productId, customerId);
      await database.query(
        `INSERT INTO order_transition_history(order_id, from_status, to_status, reason_code, correlation_id, actor_type, occurred_at) VALUES ($1, NULL, 'FULFILLMENT_PENDING', 'ADMIN_TEST_FIXTURE', 'corr-admin-pg', 'SYSTEM', $2)`,
        [createdOrderId, now],
      );
      const repository = new PostgresAdminOrderReadRepository(database);

      const page = await repository.list({
        filters: { exactCustomerEmail: "admin-customer@example.test" },
        limit: 25,
      });
      expect(page.orders).toHaveLength(1);
      expect(page.orders[0]).toMatchObject({
        orderId: orderId(createdOrderId),
        productTitle: "Admin Persistence Product",
      });
      const detail = await repository.findDetail(orderId(createdOrderId));
      expect(detail).toMatchObject({
        encryptedSecretAvailable: false,
        history: [{ reasonCode: "ADMIN_TEST_FIXTURE" }],
        invoiceStatus: "NOT_AVAILABLE",
      });
      expect(JSON.stringify(detail)).not.toMatch(
        /ciphertext|encryption_nonce|wrapped_data_encryption_key/iu,
      );
    } finally {
      await database.cleanup();
    }
  }, 30_000);
});

const initDatabase = async (): Promise<PostgresTestDatabase> =>
  PostgresTestDatabase.initialize({
    connectionString,
    schemaName: `admin_${randomUUID().replaceAll("-", "_")}`,
  });

const insertAdmin = async (
  database: PostgresTestDatabase,
  sessionHash: string,
): Promise<string> => {
  const adminId = randomUUID();
  await database.query(
    `INSERT INTO admin_identities(id, provider, provider_subject, display_name, status, created_at, updated_at) VALUES ($1, 'STAGING_SYNTHETIC', 'admin-persistence-test', 'Admin Test', 'ACTIVE', $2, $2)`,
    [adminId, now],
  );
  await database.query(
    `INSERT INTO admin_role_assignments(admin_id, role, granted_by, granted_at) VALUES ($1, 'PROJECT_OWNER', 'test-fixture', $2)`,
    [adminId, now],
  );
  await database.query(
    `INSERT INTO admin_sessions(id, admin_id, session_hash, assurance, issued_at, expires_at) VALUES ($1, $2, $3, 'STAGING_SYNTHETIC', $4, $5)`,
    [randomUUID(), adminId, sessionHash, now, new Date(now.getTime() + 60_000)],
  );
  return adminId;
};

const insertProduct = async (
  database: PostgresTestDatabase,
): Promise<string> => {
  const result = await database.query<{ readonly id: string }>(
    `INSERT INTO products(product_type, title, platform, lifecycle, active, canonical_metadata_confidence) VALUES ('GAME', 'Admin Persistence Product', 'WINDOWS', 'IN_STOCK', true, 'HIGH') RETURNING id::text`,
  );
  return required(result.rows[0]).id;
};

const insertOrder = async (
  database: PostgresTestDatabase,
  productId: string,
  customerId: string,
): Promise<string> => {
  const priceLockId = randomUUID();
  await database.query(
    `INSERT INTO price_locks(id, product_id, currency, locked_sell_price_minor, pricing_quote_fingerprint, source_fingerprint, pricing_policy_version, pricing_policy_record_version, tax_policy_version, fee_policy_version, status, record_version, idempotency_key, idempotency_fingerprint, correlation_id, created_at, expires_at) VALUES ($1, $2, 'EUR', 2199, $3, $4, 'policy-v1', 1, 'tax-v1', 'fee-v1', 'CONSUMED', 1, $5, $6, 'corr-admin-pg', $7, $8)`,
    [
      priceLockId,
      productId,
      `quote-${priceLockId}`,
      `source-${priceLockId}`,
      `lock-${priceLockId}`,
      `lock-fingerprint-${priceLockId}`,
      now,
      new Date(now.getTime() + 60_000),
    ],
  );
  const id = randomUUID();
  await database.query(
    `INSERT INTO keycore_orders(id, product_id, price_lock_id, customer_id, customer_amount_minor, currency, quantity, status, payment_status, procurement_status, fulfillment_status, risk_status, refund_status, record_version, idempotency_key, idempotency_fingerprint, correlation_id, created_at, updated_at) VALUES ($1, $2, $3, $4, 2199, 'EUR', 1, 'FULFILLMENT_PENDING', 'CAPTURED', 'SUCCEEDED', 'PENDING', 'APPROVED', 'NOT_REQUESTED', 1, $5, $6, 'corr-admin-pg', $7, $7)`,
    [
      id,
      productId,
      priceLockId,
      customerId,
      `order-${id}`,
      `order-fingerprint-${id}`,
      now,
    ],
  );
  return id;
};

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Expected fixture row");
  return value;
};
