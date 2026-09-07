import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AdminAuthenticationService,
  AdminOrderService,
  AdminStaffService,
  hashAdminSession,
  orderId,
  type AdminOrderReadRepository,
  type AdminSessionRepository,
  type AdminStaffRepository,
  type AuditEvent,
  type AuditEventPort,
} from "../../packages/platform/src/contracts.js";
import { AdminHttpController, type AdminHttpRequest } from "./admin-http.js";

const hmacMaterial = [
  "http-admin-test",
  "material-longer-than-thirty-two-bytes",
].join("-");
const rawSession = "http-admin-opaque-session-1234567890abcdef";
const staffRawSession = "http-staff-opaque-session-1234567890abcdef";
const origin = "https://admin.staging.keyrano.de";
const adminId = "a1000000-0000-4000-8000-000000000001";
const staffAdminId = "a1000000-0000-4000-8000-000000000002";
const targetOrderId = orderId("20000000-0000-4000-8000-000000000001");

describe("AdminHttpController", () => {
  it("does not accept a customer or missing admin session", async () => {
    const controller = fixture();
    await expect(
      controller.handle(request("GET", "/admin/")),
    ).resolves.toMatchObject({
      statusCode: 303,
      headers: { Location: "/admin/login" },
    });
    await expect(
      controller.handle(
        request("GET", "/admin/", {
          cookie: "wordpress_logged_in_customer=value",
        }),
      ),
    ).resolves.toMatchObject({
      statusCode: 303,
      headers: { Location: "/admin/login" },
    });
  });

  it("logs in only by exact-origin POST and returns hardened cookies and headers", async () => {
    const controller = fixture();
    const response = await controller.handle(
      request("POST", "/admin/login", { origin }, { session_code: rawSession }),
    );
    expect(response).toMatchObject({
      statusCode: 303,
      headers: { Location: "/admin/" },
    });
    expect(response.headers["Set-Cookie"]).toContain("HttpOnly");
    expect(response.headers["Set-Cookie"]).toContain("SameSite=Strict");
    expect(response.headers["Set-Cookie"]).toContain("Secure");
    expect(response.headers["Content-Security-Policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("keeps owner and synthetic staff sessions independent across separate cookie jars", async () => {
    const controller = fixture({
      additionalSession: {
        adminId: staffAdminId,
        rawSession: staffRawSession,
        role: "SUPPORT",
      },
    });
    const ownerLogin = await controller.handle(
      request("POST", "/admin/login", { origin }, { session_code: rawSession }),
    );
    const staffLogin = await controller.handle(
      request(
        "POST",
        "/admin/login",
        { origin },
        { session_code: staffRawSession },
      ),
    );
    const ownerCookie = required(ownerLogin.headers["Set-Cookie"]);
    const staffCookie = required(staffLogin.headers["Set-Cookie"]);

    expect(ownerLogin.statusCode).toBe(303);
    expect(staffLogin.statusCode).toBe(303);
    expect(ownerCookie).not.toBe(staffCookie);
    await expect(
      controller.handle(
        request("GET", "/admin/staff", {
          cookie: cookiePair(ownerCookie),
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      controller.handle(
        request("GET", "/admin/orders", {
          cookie: cookiePair(staffCookie),
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      controller.handle(
        request("GET", "/admin/staff", {
          cookie: cookiePair(staffCookie),
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      controller.handle(
        request("GET", "/admin/", { cookie: cookiePair(ownerCookie) }),
      ),
    ).resolves.toMatchObject({ statusCode: 200 });
  });

  it("keeps browser form POSTs compatible with strict exact-origin validation", async () => {
    const controller = fixture();
    const login = await controller.handle(request("GET", "/admin/login"));
    const dashboard = await controller.handle(authenticated("GET", "/admin/"));

    expect(login.headers["Referrer-Policy"]).toBe("same-origin");
    expect(dashboard.headers["Referrer-Policy"]).toBe("same-origin");
    expect(login.headers["Cache-Control"]).toBe("no-store, max-age=0");
    expect(login.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(login.headers["X-Frame-Options"]).toBe("DENY");
    expect(login.headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(login.body.match(/name="session_code"/gu)).toHaveLength(1);
    expect(login.body).not.toMatch(/name="csrf"|name="origin"/u);

    await expect(
      controller.handle(
        request(
          "POST",
          "/admin/login",
          { origin },
          { session_code: "invalid-session-code-longer-than-32-bytes" },
        ),
      ),
    ).resolves.toMatchObject({ statusCode: 401 });

    for (const headers of [
      {},
      { origin: "null" },
      { origin: "https://attacker.invalid" },
    ]) {
      await expect(
        controller.handle(
          request("POST", "/admin/login", headers, {
            session_code: rawSession,
          }),
        ),
      ).resolves.toMatchObject({ statusCode: 400 });
    }
  });

  it("renders safe order data and never includes key material", async () => {
    const response = await fixture().handle(
      authenticated("GET", `/admin/orders/${targetOrderId}`),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Arena Eleven");
    expect(response.body).toContain("Kontrollierten Zugriff anfordern");
    expect(response.body).not.toMatch(
      /ciphertext|wrapped_data|TEST-[A-Z0-9-]+/u,
    );
  });

  it("renders the order list with a responsive card presentation contract", async () => {
    const response = await fixture().handle(
      authenticated("GET", "/admin/orders"),
    );
    const css = readFileSync(
      new URL("../../apps/admin/assets/admin.css", import.meta.url),
      "utf8",
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('class="orders-table"');
    expect(response.body).toContain('<th scope="col">Bestellung</th>');
    for (const label of [
      "Bestellung",
      "Kunde",
      "Produkt",
      "Status",
      "Betrag",
      "Datum",
    ]) {
      expect(response.body).toContain(`data-label="${label}"`);
    }
    expect(response.body).toContain(targetOrderId);
    expect(response.body).toContain("customer@example.test");
    expect(response.body).toContain("Arena Eleven");
    expect(response.body).toContain("FULFILLMENT_PENDING");
    expect(response.body).toContain("21,99 EUR");
    expect(response.body).not.toMatch(
      /ciphertext|wrapped_data|TEST-[A-Z0-9-]+/u,
    );

    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain(".orders-table tbody { display: grid");
    expect(css).toContain("content: attr(data-label)");
    expect(css).toContain(".table-wrap { overflow: visible; }");
    expect(css).toContain(".detail-grid dl { grid-template-columns: 1fr");
    expect(css).toContain(
      ".metric-grid, .filter-bar { grid-template-columns: 1fr",
    );
  });

  it("makes reveal POST-only, rejects invalid CSRF and returns no key after a valid attempt", async () => {
    const controller = fixture();
    const path = `/admin/orders/${targetOrderId}/product-key/reveal`;
    await expect(
      controller.handle(authenticated("GET", path)),
    ).resolves.toMatchObject({ statusCode: 405, headers: { Allow: "POST" } });
    await expect(
      controller.handle(
        authenticated("POST", path, { origin }, { csrf: "0".repeat(64) }),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
    const detail = await controller.handle(
      authenticated("GET", `/admin/orders/${targetOrderId}`),
    );
    const csrf = new RegExp(
      `action="${path.replaceAll("/", "\\/")}"[^>]*><input type="hidden" name="csrf" value="([a-f0-9]{64})"`,
      "u",
    ).exec(detail.body)?.[1];
    expect(csrf).toBeTruthy();
    const response = await controller.handle(
      authenticated("POST", path, { origin }, { csrf: required(csrf) }),
    );
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("Es wurde kein Product Key offengelegt");
    expect(response.body).not.toMatch(/TEST-[A-Z0-9-]+/u);
  });

  it("rejects duplicate query fields and returns generic backend failures", async () => {
    const malformed = authenticated("GET", "/admin/orders");
    malformed.query.append("search", targetOrderId);
    malformed.query.append("search", targetOrderId);
    await expect(fixture().handle(malformed)).resolves.toMatchObject({
      statusCode: 400,
    });

    const controller = fixture({ backendUnavailable: true });
    const response = await controller.handle(authenticated("GET", "/admin/"));
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("vorübergehend nicht verfügbar");
    expect(response.body).not.toContain("synthetic backend detail");
  });

  it("protects staff and audit routes server-side and renders responsive safe views", async () => {
    await expect(
      fixture({ role: "SUPPORT" }).handle(authenticated("GET", "/admin/staff")),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      fixture({ role: "SUPPORT" }).handle(authenticated("GET", "/admin/audit")),
    ).resolves.toMatchObject({ statusCode: 403 });

    const staff = await fixture().handle(authenticated("GET", "/admin/staff"));
    expect(staff.statusCode).toBe(200);
    expect(staff.body).toContain("Mitarbeiter &amp; Rollen");
    expect(staff.body).toContain('class="staff-table"');
    expect(staff.body).toContain('data-label="Mitarbeiter-ID"');
    expect(staff.body).toContain(
      "Synthetic &lt;script&gt;alert(1)&lt;/script&gt; Staff",
    );
    expect(staff.body).not.toContain("<script>alert(1)</script>");
    expect(staff.body).not.toMatch(
      /TEST-[A-Z0-9-]+|session_code|session_hash/iu,
    );

    const audit = await fixture().handle(authenticated("GET", "/admin/audit"));
    expect(audit.statusCode).toBe(200);
    expect(audit.body).toContain('class="audit-table"');
    expect(audit.body).toContain("ADMIN_STAFF_CREATED");
    const auditTable =
      audit.body
        .split('<table class="audit-table">')[1]
        ?.split("</table>")[0] ?? "";
    expect(auditTable).not.toMatch(
      /cookie|authorization|csrf|session.?hash|product.?key/iu,
    );
  });

  it("keeps staff mutations POST-only and exact-origin CSRF-bound", async () => {
    const controller = fixture();
    const detailPath = `/admin/staff/${targetOrderId}`;
    const detail = await controller.handle(authenticated("GET", detailPath));
    expect(detail.statusCode).toBe(200);
    const action = `${detailPath}/role`;
    const csrf = new RegExp(
      `action="${action.replaceAll("/", "\\/")}"[^>]*><input type="hidden" name="csrf" value="([a-f0-9]{64})"`,
      "u",
    ).exec(detail.body)?.[1];
    expect(csrf).toBeTruthy();
    await expect(
      controller.handle(authenticated("GET", action)),
    ).resolves.toMatchObject({ statusCode: 405 });
    await expect(
      controller.handle(
        authenticated(
          "POST",
          action,
          {},
          { csrf: required(csrf), role: "FINANCE" },
        ),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      controller.handle(
        authenticated(
          "POST",
          action,
          { origin: "https://attacker.invalid" },
          { csrf: required(csrf), role: "FINANCE" },
        ),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      controller.handle(
        authenticated(
          "POST",
          action,
          { origin },
          { csrf: required(csrf), role: "FINANCE" },
        ),
      ),
    ).resolves.toMatchObject({
      statusCode: 303,
      headers: { Location: detailPath },
    });
  });
});

const fixture = (
  options: {
    readonly additionalSession?: {
      readonly adminId: string;
      readonly rawSession: string;
      readonly role: "FINANCE" | "SUPPORT";
    };
    readonly backendUnavailable?: boolean;
    readonly role?: "PROJECT_OWNER" | "SUPPORT";
  } = {},
): AdminHttpController => {
  const audit = new MemoryAudit();
  const sessions: AdminSessionRepository = {
    findByHash: async (hash) => {
      if (hash === hashAdminSession(rawSession, hmacMaterial)) {
        return {
          adminId,
          assurance: "MFA",
          displayName: "Project Owner",
          expiresAt: new Date("2026-09-03T00:00:00.000Z"),
          identityStatus: "ACTIVE",
          revokedAt: null,
          roles: [options.role ?? "PROJECT_OWNER"],
        };
      }
      const additional = options.additionalSession;
      return additional &&
        hash === hashAdminSession(additional.rawSession, hmacMaterial)
        ? {
            adminId: additional.adminId,
            assurance: "STAGING_SYNTHETIC",
            displayName: "Synthetic Staff",
            expiresAt: new Date("2026-09-03T00:00:00.000Z"),
            identityStatus: "ACTIVE",
            revokedAt: null,
            roles: [additional.role],
          }
        : null;
    },
    revoke: async () => undefined,
    touch: async () => undefined,
  };
  const orders: AdminOrderReadRepository = {
    dashboard: async () => {
      if (options.backendUnavailable)
        throw new Error("synthetic backend detail");
      return {
        attentionOrders: 0,
        failedOrders: 0,
        processingOrders: 1,
        recentOrders: [summary()],
        revenueByCurrency: [],
        totalOrders: 1,
      };
    },
    findDetail: async () => ({
      ...summary(),
      correlationId: "corr-admin",
      customerId: null,
      deliveryState: "PENDING",
      encryptedSecretAvailable: true,
      externalSupplierOrderId: "safe-external-reference",
      fulfillmentOperationStatus: "DELIVERY_PENDING",
      guestClaimStatus: "NOT_AVAILABLE",
      history: [],
      invoiceStatus: "NOT_AVAILABLE",
      retrievalState: "RETRIEVED",
      supplierId: "supplier-reference",
    }),
    list: async () => ({ orders: [summary()] }),
  };
  const staff: AdminStaffRepository = {
    changeRole: async () => "UPDATED",
    create: async () => "UPDATED",
    findDetail: async () => ({
      activeIndividualCapabilities: [],
      adminId: targetOrderId,
      createdAt: new Date("2026-09-01T09:00:00.000Z"),
      displayName: "Synthetic <script>alert(1)</script> Staff",
      effectiveCapabilities: ["ADMIN_ACCESS", "ORDER_VIEW"],
      emailNormalized: "synthetic.staff@example.test",
      employeeNumber: "STAFF-001",
      firstName: "Synthetic",
      hasAdditionalPermissions: false,
      lastAuditAt: null,
      lastLoginAt: null,
      lastName: "Staff",
      permissionHistory: [],
      role: "SUPPORT",
      roleCapabilities: ["ADMIN_ACCESS", "ORDER_VIEW"],
      roleHistory: [
        {
          grantedAt: new Date("2026-09-01T09:00:00.000Z"),
          revokedAt: null,
          role: "SUPPORT",
        },
      ],
      status: "ACTIVE",
      updatedAt: new Date("2026-09-01T09:00:00.000Z"),
    }),
    grantPermission: async () => "UPDATED",
    list: async () => [
      {
        adminId: targetOrderId,
        createdAt: new Date("2026-09-01T09:00:00.000Z"),
        displayName: "Synthetic <script>alert(1)</script> Staff",
        emailNormalized: "synthetic.staff@example.test",
        employeeNumber: "STAFF-001",
        firstName: "Synthetic",
        hasAdditionalPermissions: false,
        lastLoginAt: null,
        lastName: "Staff",
        role: "SUPPORT",
        status: "ACTIVE",
        updatedAt: new Date("2026-09-01T09:00:00.000Z"),
      },
    ],
    listAudit: async () => ({
      entries: [
        {
          actorId: adminId,
          entityId: targetOrderId,
          entityType: "ADMIN_IDENTITY",
          eventType: "ADMIN_ACTION",
          id: targetOrderId,
          outcome: "SUCCEEDED",
          reasonCode: "ADMIN_STAFF_CREATED",
          safeDetails: { action: "ADMIN_STAFF_CREATED" },
          timestampUtc: new Date("2026-09-01T09:00:00.000Z"),
        },
      ],
    }),
    revokePermission: async () => "UPDATED",
    setStatus: async () => "UPDATED",
  };
  return new AdminHttpController(
    new AdminAuthenticationService(
      sessions,
      audit,
      hmacMaterial,
      "STAGING",
      () => new Date("2026-09-02T10:00:00.000Z"),
    ),
    new AdminOrderService(orders, audit, hmacMaterial, "STAGING"),
    new AdminStaffService(staff, audit, hmacMaterial, "STAGING"),
    { allowedOrigin: origin, csrfSecret: hmacMaterial, secureCookies: true },
  );
};

class MemoryAudit implements AuditEventPort {
  public readonly events: AuditEvent[] = [];
  public async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}
const summary = () => ({
  amountMinor: "2199",
  createdAt: new Date("2026-09-02T09:00:00.000Z"),
  currency: "EUR",
  customerEmail: "customer@example.test",
  fulfillmentStatus: "PENDING",
  orderId: targetOrderId,
  paymentStatus: "CAPTURED",
  procurementStatus: "SUCCEEDED",
  productTitle: "Arena Eleven",
  quantity: 1,
  riskStatus: "APPROVED",
  status: "FULFILLMENT_PENDING",
  updatedAt: new Date("2026-09-02T09:01:00.000Z"),
});
const request = (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  form: Record<string, string> = {},
): AdminHttpRequest => ({
  form: new URLSearchParams(form),
  headers,
  method,
  path,
  query: new URLSearchParams(),
});
const authenticated = (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  form: Record<string, string> = {},
): AdminHttpRequest =>
  request(
    method,
    path,
    { cookie: `keyrano_admin_session=${rawSession}`, ...headers },
    form,
  );
const cookiePair = (setCookie: string): string =>
  required(setCookie.split(";", 1)[0]);
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Expected value");
  return value;
};
