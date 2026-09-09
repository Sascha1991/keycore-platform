import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  correlationId,
  hashAdminSession,
  orderId,
} from "../../packages/platform/src/contracts.js";
import {
  PostgresAdminOrderReadRepository,
  PostgresAdminSessionRepository,
  PostgresAdminStaffRepository,
} from "./admin-repositories.js";
import { PostgresAdminOperationsRepository } from "./admin-operations-repository.js";
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
      const processing = await repository.list({
        filters: { operationalView: "PROCESSING" },
        limit: 25,
      });
      expect(processing.orders.map((item) => item.orderId)).toContain(
        orderId(createdOrderId),
      );
      const failed = await repository.list({
        filters: { operationalView: "FAILED" },
        limit: 25,
      });
      expect(failed.orders).toHaveLength(0);
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

  it("histories roles and grants, revokes sessions and protects the final active owner", async () => {
    const database = await initDatabase();
    try {
      const ownerId = await insertAdmin(database, "a".repeat(64));
      const repository = new PostgresAdminStaffRepository(database);
      const context = {
        actorId: ownerId,
        at: now,
        correlationId: correlationId("corr-admin-staff-pg"),
        environment: "CI" as const,
      };

      await expect(
        repository.setStatus(ownerId, "DISABLED", context),
      ).resolves.toBe("LAST_OWNER_PROTECTED");
      await expect(
        database.query<{ reason_code: string; outcome: string }>(
          `SELECT reason_code, outcome FROM audit_events WHERE entity->>'id' = $1 ORDER BY timestamp_utc DESC, id DESC LIMIT 1`,
          [ownerId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            outcome: "DENIED",
            reason_code: "ADMIN_LAST_OWNER_PROTECTED",
          },
        ],
      });
      const targetId = randomUUID();
      await expect(
        repository.create(
          {
            adminId: targetId,
            displayName: "Ada Lovelace",
            emailNormalized: "ada@example.test",
            employeeNumber: "STAFF-002",
            firstName: "Ada",
            lastName: "Lovelace",
            role: "SUPPORT",
          },
          context,
        ),
      ).resolves.toBe("UPDATED");
      await database.query(
        `INSERT INTO admin_sessions(id, admin_id, session_hash, assurance, issued_at, expires_at) VALUES ($1, $2, $3, 'STAGING_SYNTHETIC', $4, $5)`,
        [
          randomUUID(),
          targetId,
          "b".repeat(64),
          now,
          new Date(now.getTime() + 60_000),
        ],
      );

      await expect(
        repository.grantPermission(
          targetId,
          "AUDIT_VIEW",
          "Synthetic UAT duty",
          context,
        ),
      ).resolves.toBe("UPDATED");
      await expect(
        repository.grantPermission(
          targetId,
          "AUDIT_VIEW",
          "Synthetic UAT duty",
          context,
        ),
      ).resolves.toBe("UNCHANGED");
      let detail = await repository.findDetail(targetId);
      expect(detail?.effectiveCapabilities).toEqual([
        "ADMIN_ACCESS",
        "AUDIT_VIEW",
        "CUSTOMER_VIEW",
        "ORDER_VIEW",
        "SUPPORT_MANAGE",
        "SUPPORT_VIEW",
      ]);
      expect(detail?.permissionHistory).toHaveLength(1);
      expect(
        (
          await database.query<{ revoked_at: Date | null }>(
            `SELECT revoked_at FROM admin_sessions WHERE admin_id = $1`,
            [targetId],
          )
        ).rows[0]?.revoked_at,
      ).toEqual(now);

      await expect(
        repository.revokePermission(targetId, "AUDIT_VIEW", context),
      ).resolves.toBe("UPDATED");
      await expect(
        repository.changeRole(targetId, "FINANCE", context),
      ).resolves.toBe("UPDATED");
      detail = await repository.findDetail(targetId);
      expect(detail?.role).toBe("FINANCE");
      expect(detail?.activeIndividualCapabilities).toEqual([]);
      expect(detail?.roleHistory).toHaveLength(2);
      expect(
        detail?.roleHistory.filter((entry) => entry.revokedAt === null),
      ).toHaveLength(1);
      expect(detail?.permissionHistory[0]?.revokedAt).toEqual(now);
      const audit = await repository.listAudit({
        filters: { entityId: targetId },
        limit: 20,
      });
      expect(audit.entries.map((entry) => entry.reasonCode)).toEqual(
        expect.arrayContaining([
          "ADMIN_STAFF_CREATED",
          "ADMIN_PERMISSION_GRANTED",
          "ADMIN_PERMISSION_REVOKED",
          "ADMIN_ROLE_CHANGED",
        ]),
      );
      expect(JSON.stringify(audit.entries)).not.toMatch(
        /session_hash|cookie|authorization|TEST-[A-Z0-9-]+/iu,
      );
    } finally {
      await database.cleanup();
    }
  }, 30_000);

  it("projects bounded operational admin pages without secret-bearing columns", async () => {
    const database = await initDatabase();
    try {
      const customerId = randomUUID();
      const productId = await insertProduct(database);
      await database.query(
        `INSERT INTO keycore_customers(id, email_normalized, email_verification_state, record_version, created_at, updated_at) VALUES ($1, 'operations-customer@example.test', 'VERIFIED', 1, $2, $2)`,
        [customerId, now],
      );
      const createdOrderId = await insertOrder(database, productId, customerId);
      const supportId = randomUUID();
      await database.query(
        `INSERT INTO support_cases(id, customer_id, order_id, category, status, priority, source, resolution_code, record_version, correlation_id, created_at, updated_at, resolved_at, closed_at) VALUES ($1, $2, $3, 'ORDER_STATUS', 'OPEN', 'NORMAL', 'CUSTOMER', NULL, 1, 'admin-operations-pg', $4, $4, NULL, NULL)`,
        [supportId, customerId, createdOrderId, now],
      );
      const repository = new PostgresAdminOperationsRepository(database);

      await expect(
        repository.listCustomers({ limit: 25, search: "operations-customer" }),
      ).resolves.toMatchObject({
        items: [{ customerId, orderCount: 1, verificationState: "VERIFIED" }],
      });
      await expect(
        repository.listProducts({ limit: 25, search: "Admin Persistence" }),
      ).resolves.toMatchObject({
        items: [
          { active: true, productId, title: "Admin Persistence Product" },
        ],
      });
      await expect(repository.listSuppliers({ limit: 25 })).resolves.toEqual({
        items: [],
      });
      await expect(
        repository.listSupportCases({ limit: 25, status: "OPEN" }),
      ).resolves.toMatchObject({
        items: [
          {
            caseId: supportId,
            customerEmail: "operations-customer@example.test",
            orderId: createdOrderId,
          },
        ],
      });
      await expect(repository.financeSummary()).resolves.toMatchObject([
        { capturedAmountMinor: "2199", capturedOrders: 1, currency: "EUR" },
      ]);
      const controls = await repository.listOperationsControls();
      expect(controls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "PROCUREMENT_CREATE",
            recordVersion: expect.any(Number),
            state: "ENABLED",
          }),
        ]),
      );
      expect(
        JSON.stringify({
          customers: await repository.listCustomers({ limit: 25 }),
          products: await repository.listProducts({ limit: 25 }),
          support: await repository.listSupportCases({ limit: 25 }),
        }),
      ).not.toMatch(/ciphertext|session_hash|claim_code|verification_token/iu);
    } finally {
      await database.cleanup();
    }
  }, 30_000);

  it("aggregates supplier products and offers independently at realistic scale", async () => {
    const database = await initDatabase();
    try {
      const supplierId = randomUUID();
      await database.query(
        `INSERT INTO suppliers(id, supplier_code, display_name) VALUES ($1, 'scale-supplier', 'Scale Supplier')`,
        [supplierId],
      );
      await database.query(
        `INSERT INTO supplier_products(supplier_id, supplier_product_id, title)
         SELECT $1, 'scale-product-' || ordinal, 'Scale Product ' || ordinal
         FROM generate_series(1, 3000) ordinal`,
        [supplierId],
      );
      await database.query(
        `INSERT INTO supplier_offers(supplier_id, supplier_product_id, supplier_offer_id, active)
         SELECT $1, product.id, 'scale-offer-' || row_number() OVER (ORDER BY product.id),
           row_number() OVER (ORDER BY product.id) % 4 <> 0
         FROM supplier_products product
         WHERE product.supplier_id = $1`,
        [supplierId],
      );

      await database.transaction(async (client) => {
        await client.query("SET LOCAL statement_timeout = '1500ms'");
        const repository = new PostgresAdminOperationsRepository(client);
        await expect(repository.listSuppliers({ limit: 25 })).resolves.toEqual({
          items: [
            expect.objectContaining({
              activeOfferCount: 2250,
              productCount: 3000,
              supplierId,
            }),
          ],
        });
      });
    } finally {
      await database.cleanup();
    }
  }, 30_000);

  it("uses one captured-payment-volume contract across dashboard and finance", async () => {
    const database = await initDatabase();
    try {
      const customerId = randomUUID();
      const productId = await insertProduct(database);
      await database.query(
        `INSERT INTO keycore_customers(id, email_normalized, email_verification_state, record_version, created_at, updated_at) VALUES ($1, 'finance-customer@example.test', 'VERIFIED', 1, $2, $2)`,
        [customerId, now],
      );
      await insertOrder(database, productId, customerId, {
        amountMinor: 2199,
        paymentStatus: "CAPTURED",
      });
      await insertOrder(database, productId, customerId, {
        amountMinor: 3000,
        paymentStatus: "REFUNDED",
      });
      await insertOrder(database, productId, customerId, {
        amountMinor: 1500,
        paymentStatus: "PARTIALLY_REFUNDED",
      });

      const dashboard = await new PostgresAdminOrderReadRepository(
        database,
      ).dashboard();
      const finance = await new PostgresAdminOperationsRepository(
        database,
      ).financeSummary();

      expect(dashboard.revenueByCurrency).toEqual([
        { amountMinor: "6699", currency: "EUR" },
      ]);
      expect(finance).toEqual([
        {
          capturedAmountMinor: "6699",
          capturedOrders: 3,
          currency: "EUR",
          partiallyRefundedOrders: 1,
          refundedAmountMinor: "3000",
          refundedOrders: 1,
        },
      ]);
    } finally {
      await database.cleanup();
    }
  }, 30_000);

  it("enforces staff uniqueness, capability allowlists and audit-atomic permission grants", async () => {
    const database = await initDatabase();
    try {
      const ownerId = await insertAdmin(database, "c".repeat(64));
      const repository = new PostgresAdminStaffRepository(database);
      const context = {
        actorId: ownerId,
        at: now,
        correlationId: correlationId("corr-admin-atomic-pg"),
        environment: "CI" as const,
      };
      const targetId = randomUUID();
      await expect(
        repository.create(
          {
            adminId: targetId,
            displayName: "Grace Hopper",
            emailNormalized: "grace@example.test",
            employeeNumber: "STAFF-003",
            firstName: "Grace",
            lastName: "Hopper",
            role: "SUPPORT",
          },
          context,
        ),
      ).resolves.toBe("UPDATED");
      await expect(
        repository.create(
          {
            adminId: randomUUID(),
            displayName: "Duplicate Number",
            emailNormalized: null,
            employeeNumber: "STAFF-003",
            firstName: "Duplicate",
            lastName: "Number",
            role: "SUPPORT",
          },
          context,
        ),
      ).resolves.toBe("DUPLICATE");
      await expect(
        database.query(
          `INSERT INTO admin_permission_grants(admin_id, capability, granted_at, granted_by_admin_id) VALUES ($1, 'ROOT', $2, $3)`,
          [targetId, now, ownerId],
        ),
      ).rejects.toThrow();

      await database.query(
        `CREATE FUNCTION reject_admin_permission_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason_code = 'ADMIN_PERMISSION_GRANTED' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`,
      );
      await database.query(
        `CREATE TRIGGER reject_admin_permission_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_admin_permission_audit()`,
      );
      await expect(
        repository.grantPermission(targetId, "AUDIT_VIEW", null, context),
      ).rejects.toThrow("synthetic audit failure");
      expect(
        (
          await database.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM admin_permission_grants WHERE admin_id = $1`,
            [targetId],
          )
        ).rows[0]?.count,
      ).toBe("0");
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
  options: {
    readonly amountMinor?: number;
    readonly paymentStatus?: "CAPTURED" | "REFUNDED" | "PARTIALLY_REFUNDED";
  } = {},
): Promise<string> => {
  const amountMinor = options.amountMinor ?? 2199;
  const paymentStatus = options.paymentStatus ?? "CAPTURED";
  const refunded = paymentStatus === "REFUNDED";
  const priceLockId = randomUUID();
  await database.query(
    `INSERT INTO price_locks(id, product_id, currency, locked_sell_price_minor, pricing_quote_fingerprint, source_fingerprint, pricing_policy_version, pricing_policy_record_version, tax_policy_version, fee_policy_version, status, record_version, idempotency_key, idempotency_fingerprint, correlation_id, created_at, expires_at) VALUES ($1, $2, 'EUR', $3, $4, $5, 'policy-v1', 1, 'tax-v1', 'fee-v1', 'CONSUMED', 1, $6, $7, 'corr-admin-pg', $8, $9)`,
    [
      priceLockId,
      productId,
      amountMinor,
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
    `INSERT INTO keycore_orders(id, product_id, price_lock_id, customer_id, customer_amount_minor, currency, quantity, status, payment_status, procurement_status, fulfillment_status, risk_status, refund_status, record_version, idempotency_key, idempotency_fingerprint, correlation_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 'EUR', 1, $6, $7, 'SUCCEEDED', 'PENDING', 'APPROVED', $8, 1, $9, $10, 'corr-admin-pg', $11, $11)`,
    [
      id,
      productId,
      priceLockId,
      customerId,
      amountMinor,
      refunded ? "REFUNDED" : "FULFILLMENT_PENDING",
      paymentStatus,
      refunded
        ? "SUCCEEDED"
        : paymentStatus === "PARTIALLY_REFUNDED"
          ? "PENDING"
          : "NOT_REQUESTED",
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
