import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AdminAuthenticationService,
  AdminOperationsService,
  AdminOrderService,
  AdminStaffService,
  hashAdminSession,
  orderId,
  type AdminOrderReadRepository,
  type AdminOperationsRepository,
  type AdminOperationsControlMutationPort,
  type AdminSupportOperationsPort,
  type AdminSessionRepository,
  type AdminStaffRepository,
  type AuditEvent,
  type AuditEventPort,
} from "../../packages/platform/src/contracts.js";
import { AdminHttpController, type AdminHttpRequest } from "./admin-http.js";
import type { StagingDelayedFulfillmentPort } from "../storefront/staging-delayed-fulfillment.js";

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
    expect(response.body).toContain('class="metric-grid orders-metrics"');
    expect(response.body).toContain('id="order-filter"');
    expect(response.body).toContain('name="payment"');
    expect(response.body).toContain('name="reference"');
    expect(response.body).toContain('name="customer"');
    expect(response.body).toContain('name="risk"');
    expect(response.body).toContain('name="procurement"');
    expect(response.body).toContain('name="fulfillment"');
    expect(response.body).toContain('name="sort"');
    expect(response.body).toContain('name="limit"');
    expect(response.body).toContain('href="#icon-filter"');
    expect(response.body).toContain('href="#icon-search"');
    expect(response.body).toContain(
      "Bestellreferenz, Bestell-ID oder Kunden-E-Mail",
    );
    expect(response.body).toContain(
      'href="/admin/orders?panel=filters#order-filter"',
    );
    expect(response.body).toContain('aria-expanded="false"');
    expect(response.body).toContain(">KR0000001</a>");
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
    expect(response.body).toContain("Windows · Menge 1");
    expect(response.body).toContain("Auslieferung ausstehend");
    expect(response.body).toContain("Legende der Bestellzustände");
    expect(response.body).toContain("Kein Abrufnachweis");
    expect(response.body).toContain('value="PAYMENT_AUTHORIZED"');
    expect(response.body).toContain("Zahlung autorisiert");
    expect(visibleText(response.body)).not.toMatch(
      /CREATED|AWAITING_PAYMENT|PAYMENT_AUTHORIZED|PAYMENT_CAPTURED|PROCUREMENT_PENDING|PROCUREMENT_IN_PROGRESS|FULFILLMENT_PENDING|COMPLETED|CANCELLED|REFUND_PENDING|REFUNDED|MANUAL_REVIEW/u,
    );
    expect(response.body).toContain("21,99 EUR");
    expect(response.body).not.toMatch(
      /ciphertext|wrapped_data|TEST-[A-Z0-9-]+/u,
    );

    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toMatch(/\.orders-table tbody[^{}]*\{[^}]*display:\s*grid/gu);
    expect(css).toContain("content: attr(data-label)");
    expect(css).toMatch(/\.table-wrap\s*\{[^}]*overflow:\s*visible/gu);
    expect(css).toMatch(
      /\.detail-grid dl\s*\{[^}]*grid-template-columns:\s*1fr/gu,
    );
    expect(css).toMatch(
      /\.metric-grid,\s*\.filter-bar,\s*\.staff-form\s*\{[^}]*grid-template-columns:\s*1fr/gu,
    );
    expect(css).toMatch(
      /\.workspace-grid\s*>\s*aside\s*\{[^}]*position:\s*static/gu,
    );
    expect(css).toMatch(/\.metric-card\s*\{[^}]*border:\s*1px solid/gu);
    expect(css).toMatch(
      /\.metric-icon\s*\{[^}]*display:\s*inline-flex[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*width:\s*58px[^}]*height:\s*58px[^}]*padding:\s*15px/gu,
    );
    expect(css).toMatch(
      /\.metric-icon \.icon\s*\{[^}]*display:\s*block[^}]*width:\s*28px[^}]*height:\s*28px/gu,
    );
    expect(css).toContain(
      "Human browser review correction 02: orders workspace and detail",
    );
    expect(css).toMatch(/\.orders-table\s*\{[^}]*table-layout:\s*fixed/gu);
    expect(css).toMatch(/\.orders-table-wrap\s*\{[^}]*border-right:\s*0/gu);
  });

  it("preserves operational order filters and validates detail return navigation", async () => {
    const controller = fixture();
    const opened = authenticated("GET", "/admin/orders");
    opened.query.set("panel", "filters");
    const openedResponse = await controller.handle(opened);
    expect(openedResponse.body).toContain('id="order-filter" open><summary>');
    expect(openedResponse.body).toContain('aria-expanded="true"');
    expect(openedResponse.body).toContain("panel=closed#order-filter");

    const filtered = authenticated("GET", "/admin/orders");
    filtered.query.set("reference", "KR0000001");
    filtered.query.set("customer", "customer@example.test");
    filtered.query.set("status", "");
    filtered.query.set("view", "PROCESSING");
    filtered.query.set("payment", "CAPTURED");
    filtered.query.set("risk", "APPROVED");
    filtered.query.set("procurement", "SUCCEEDED");
    filtered.query.set("fulfillment", "PENDING");
    filtered.query.set("from", "");
    filtered.query.set("to", "");
    filtered.query.set("sort", "OLDEST");
    filtered.query.set("limit", "10");
    const response = await controller.handle(filtered);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      'class="metric-card" href="/admin/orders?reference=KR0000001&amp;customer=customer%40example.test&amp;view=PROCESSING',
    );
    expect(response.body).toContain('aria-current="true"');
    expect(response.body).toContain('aria-current="true"');
    expect(response.body).toContain(
      '<option value="CAPTURED" selected>Erfasst</option>',
    );
    expect(response.body).toContain(
      'name="reference" maxlength="9" pattern="KR[0-9A-Fa-f]{7}" placeholder="KR0000001" value="KR0000001"',
    );
    expect(response.body).toContain(
      'name="customer" maxlength="254" autocomplete="off" value="customer@example.test"',
    );
    expect(response.body).toContain(
      '<option value="OLDEST" selected>Älteste zuerst</option>',
    );
    expect(response.body).toContain("<strong>Zahlung:</strong> Erfasst");
    expect(response.body).toContain("1 Ergebnis");
    expect(response.body).toContain("panel=closed#order-filter");
    expect(response.body).toContain(
      "<strong>Bestellreferenz:</strong> KR0000001",
    );
    expect(response.body).toContain(
      "<strong>Kunden-E-Mail:</strong> customer@example.test",
    );
    expect(response.body).toContain("Filter <span>6</span>");
    expect(response.body).not.toContain("<strong>Status:</strong>");
    expect(response.body).not.toContain("<strong>Von:</strong>");
    expect(response.body).not.toContain("<strong>Bis:</strong>");
    expect(response.body).not.toContain("status=&amp;");
    expect(response.body).not.toContain("from=&amp;");
    expect(response.body).not.toContain("to=&amp;");
    expect(response.body).toContain(
      'href="/admin/orders?view=PROCESSING&amp;sort=OLDEST&amp;limit=10"',
    );

    const closed = authenticated("GET", "/admin/orders");
    closed.query.set("reference", "KR0000001");
    closed.query.set("customer", "customer@example.test");
    closed.query.set("payment", "CAPTURED");
    closed.query.set("panel", "closed");
    const closedResponse = await controller.handle(closed);
    expect(closedResponse.body).toContain('aria-expanded="false"');
    expect(closedResponse.body).toContain('id="order-filter"><summary>');
    expect(closedResponse.body).toContain('value="KR0000001"');
    expect(closedResponse.body).toContain('value="customer@example.test"');
    expect(closedResponse.body).toContain("panel=filters#order-filter");

    const invalidPanel = authenticated("GET", "/admin/orders");
    invalidPanel.query.set("panel", "unexpected");
    const invalidPanelResponse = await controller.handle(invalidPanel);
    expect(invalidPanelResponse.statusCode).toBe(400);

    const safeDetail = authenticated("GET", `/admin/orders/${targetOrderId}`);
    safeDetail.query.set(
      "return",
      "/admin/orders?view=PROCESSING&payment=CAPTURED",
    );
    const safe = await controller.handle(safeDetail);
    expect(safe.body).toContain("Bestellung KR0000001");
    expect(safe.body).toContain("Technische Bestell-ID");
    expect(safe.body).toContain(
      'href="/admin/orders?view=PROCESSING&amp;payment=CAPTURED"',
    );

    const unsafeDetail = authenticated("GET", `/admin/orders/${targetOrderId}`);
    unsafeDetail.query.set("return", "https://attacker.invalid/admin/orders");
    const unsafe = await controller.handle(unsafeDetail);
    expect(unsafe.body).toContain('href="/admin/orders"');
    expect(unsafe.body).not.toContain("attacker.invalid");
  });

  it("renders customer retrieval only from authoritative delivered evidence", async () => {
    const response = await fixture({ customerAccessConfirmed: true }).handle(
      authenticated("GET", "/admin/orders"),
    );

    expect(response.body).toContain("Kundenabruf bestätigt");
    expect(response.body).not.toContain("Kein Abrufnachweis");
  });

  it("renders the shared operational shell without fake active controls", async () => {
    const response = await fixture().handle(authenticated("GET", "/admin/"));

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("/admin/assets/admin.css?v=1.1.5");
    expect(response.body).toContain('class="admin-shell"');
    expect(response.body).toContain('class="admin-toolbar"');
    expect(response.body).toContain('id="icon-home"');
    expect(response.body).toContain('id="icon-brand"');
    expect(response.body).toContain(
      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#icon-cart"></use></svg>',
    );
    expect(response.body).toContain('href="/admin/" aria-current="page"');
    expect(response.body).toContain('href="#icon-cart"');
    expect(response.body).toContain('href="/admin/orders"');
    expect(response.body).toContain('href="/admin/staff"');
    expect(response.body).toContain('href="/admin/audit"');
    expect(response.body).toContain('href="/admin/discounts"');
    expect(response.body).toContain('class="environment-badge">STAGING');
    expect(response.body).not.toMatch(/>\s*(BE|AU|IB|FG)\s*</u);
    expect(response.body).not.toMatch(/onclick=|alert\(/u);
  });

  it("renders real operational read models and keeps finance role-scoped", async () => {
    const controller = fixture();
    const expectations = [
      ["/admin/customers", "customer-a@example.test"],
      ["/admin/catalog", "Neonpfad: Berlin"],
      ["/admin/suppliers", "Synthetic Supplier"],
      ["/admin/discounts", "Noch keine Rabattverwaltung verfügbar"],
      ["/admin/support", "Bestellstatus"],
      ["/admin/fraud", "Manuelle Prüfungen"],
      ["/admin/finance", "Erfasstes Zahlungsvolumen (EUR)"],
      ["/admin/reports", "Berichte &amp; Statistiken"],
      ["/admin/settings", "Beschaffung anlegen"],
    ] as const;
    for (const [path, visible] of expectations) {
      const response = await controller.handle(authenticated("GET", path));
      expect(response.statusCode, path).toBe(200);
      expect(response.body, path).toContain(visible);
      expect(response.body, path).not.toMatch(
        /TEST-[A-Z0-9-]+|session_hash|claim_code|ciphertext/iu,
      );
    }

    const finance = await controller.handle(
      authenticated("GET", "/admin/finance"),
    );
    expect(finance.body).toContain("9.007.199.254.740.993,12 EUR");
    expect(finance.body).toContain("Teilweise erstattete Bestellungen (EUR)");
    expect(finance.body).toContain("Gesamtsicht ohne Datumsfilter");
    expect(finance.body).toContain(
      "Autoritative Teil-Erstattungsbeträge liegen im Bestellmodell derzeit nicht vor",
    );
    const report = await controller.handle(
      authenticated("GET", "/admin/reports"),
    );
    expect(report.body).toContain("Erfasstes Zahlungsvolumen (EUR)");
    expect(report.body).toContain("Teilweise erstattete Bestellungen (EUR)");
    expect(report.body).toContain("Gesamtsicht ohne Datumsfilter");
    const dashboard = await controller.handle(authenticated("GET", "/admin/"));
    expect(dashboard.body).toContain("Erfasstes Zahlungsvolumen");
    expect(dashboard.body).toContain("Serverstatus");
    expect(dashboard.body).toContain("PostgreSQL");
    expect(dashboard.body).toContain("Top-Produkte");
    expect(dashboard.body).toContain("Neonpfad: Berlin");
    expect(dashboard.body).toContain("Operative Bestellzustände");
    expect(dashboard.body).toContain("Gleiche Definition wie Schnellfilter");
    expect(dashboard.body).toContain('class="recent-orders-table"');
    expect(dashboard.body).toContain(
      'class="metric-card" href="/admin/orders"',
    );
    expect(dashboard.body).toContain("/admin/orders?view=PROCESSING");
    expect(dashboard.body).not.toContain("Erfasster Umsatz");
    expect(dashboard.body).not.toContain("Kinguin API: Online");
    expect(dashboard.body).not.toContain("Kleinunternehmerstatus");

    const processingRequest = authenticated("GET", "/admin/orders");
    processingRequest.query.set("view", "PROCESSING");
    const processing = await controller.handle(processingRequest);
    expect(processing.statusCode).toBe(200);
    expect(processing.body).toContain("Aktive Schnellansicht: In Bearbeitung");
    expect(processing.body).toContain('name="view" value="PROCESSING"');

    const discounts = await controller.handle(
      authenticated("GET", "/admin/discounts"),
    );
    expect(discounts.body).toContain('aria-disabled="true"');
    expect(discounts.body).toContain(
      "keine autoritative Rabatt- oder Kampagnen-Domain",
    );
    expect(discounts.body).not.toContain('<button type="submit">Rabatt');

    const customerDetail = await controller.handle(
      authenticated("GET", `/admin/customers/${targetOrderId}`),
    );
    expect(customerDetail.statusCode).toBe(200);
    expect(customerDetail.body).toContain("Kundendetail");
    expect(customerDetail.body).toContain("customer-a@example.test");
    expect(customerDetail.body).toContain("Bestellverlauf");
    expect(customerDetail.body).toContain("Arena Eleven");
    expect(customerDetail.body).not.toMatch(
      /password|session_hash|verification_token|claim_code/iu,
    );

    const support = fixture({ role: "SUPPORT" });
    await expect(
      support.handle(authenticated("GET", "/admin/support")),
    ).resolves.toMatchObject({ statusCode: 200 });
    await expect(
      support.handle(authenticated("GET", "/admin/finance")),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      support.handle(authenticated("GET", "/admin/catalog")),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      support.handle(authenticated("GET", "/admin/discounts")),
    ).resolves.toMatchObject({ statusCode: 403 });
  });

  it("renders the authoritative customer workspace and privacy-bounded detail", async () => {
    const controller = fixture();
    const request = authenticated("GET", "/admin/customers");
    request.query.set("status", "VERIFIED");
    request.query.set("orders", "WITH_ORDERS");
    request.query.set("registered_from", "2026-08-01");
    request.query.set("registered_to", "2026-09-30");
    request.query.set("sort", "EMAIL_ASC");
    const list = await controller.handle(request);

    expect(list.statusCode).toBe(200);
    expect(list.body).toContain('class="metric-grid customer-metrics"');
    expect(list.body).toContain('id="customer-search"');
    expect(list.body).toContain('class="filter-panel customer-filter-panel"');
    expect(list.body).toContain('name="orders"');
    expect(list.body).toContain('name="registered_from"');
    expect(list.body).toContain('value="EMAIL_ASC" selected');
    expect(list.body).toContain('type="hidden" name="sort" value="EMAIL_ASC"');
    expect(list.body).toContain('type="hidden" name="status" value="VERIFIED"');
    expect(list.body).toContain("customer-a@example.test");
    expect(list.body).toContain("KR-100001");
    expect(list.body).toContain(
      "/admin/orders?customer=customer-a%40example.test",
    );
    expect(list.body).toContain(`/admin/customers/${targetOrderId}`);
    expect(list.body).not.toContain("Max Mustermann");
    expect(list.body).not.toMatch(
      /password|session_hash|verification_token|claim_code/iu,
    );

    const detail = await controller.handle(
      authenticated("GET", `/admin/customers/${targetOrderId}`),
    );
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain("Kundendetail");
    expect(detail.body).toContain(`Kunden-ID ${targetOrderId}`);
    expect(detail.body).toContain("Maximal 10 aktuelle Einträge");
    expect(detail.body).toContain(
      "/admin/orders?customer=customer-a%40example.test",
    );
    expect(detail.body).not.toMatch(
      /password|session_hash|verification_token|claim_code|provider_subject/iu,
    );
  });

  it("builds the notification center from live states and filters it by capability", async () => {
    const ownerResponse = await fixture().handle(
      authenticated("GET", "/admin/notifications"),
    );
    expect(ownerResponse.statusCode).toBe(200);
    expect(ownerResponse.body).toContain("Offener Supportfall");
    expect(ownerResponse.body).toContain(
      "Manuelle Betrugsprüfung erforderlich",
    );
    expect(ownerResponse.body).not.toMatch(
      /class="[^"]*(badge-count|unread-count)/iu,
    );
    expect(ownerResponse.body).toContain(
      "Das Panel zeigt keine erfundene Ungelesen-Zahl.",
    );

    const supportResponse = await fixture({ role: "SUPPORT" }).handle(
      authenticated("GET", "/admin/notifications"),
    );
    expect(supportResponse.statusCode).toBe(200);
    expect(supportResponse.body).toContain("Offener Supportfall");
    expect(supportResponse.body).not.toContain(
      "Manuelle Betrugsprüfung erforderlich",
    );
    expect(supportResponse.body).not.toContain("Betriebsfunktion pausiert");
  });

  it("protects operations controls with manage permission, exact origin, CSRF and version", async () => {
    const mutation = new CapturingControlMutation();
    const controller = fixture({ controlMutation: mutation });
    const settings = await controller.handle(
      authenticated("GET", "/admin/settings"),
    );
    const path = "/admin/settings/controls/PROCUREMENT_CREATE";
    const csrf = new RegExp(
      `action="${path.replaceAll("/", "\\/")}"[^>]*><input type="hidden" name="csrf" value="([a-f0-9]{64})"`,
      "u",
    ).exec(settings.body)?.[1];
    expect(settings.statusCode).toBe(200);
    expect(settings.body).toContain("Versionsgeschützte Notfallsteuerung");
    expect(settings.body).toContain("Pausieren");
    expect(csrf).toBeTruthy();

    const validForm = {
      capability: "PROCUREMENT_CREATE",
      confirm: "CHANGE_OPERATIONS_CONTROL",
      csrf: required(csrf),
      desired_state: "PAUSED",
      expected_version: "1",
      operation_id: "browser-control-operation",
      reason_code: "MAINTENANCE",
    };
    await expect(
      controller.handle(authenticated("GET", path)),
    ).resolves.toMatchObject({
      statusCode: 405,
    });
    await expect(
      controller.handle(
        authenticated(
          "POST",
          path,
          { origin: "https://attacker.invalid" },
          validForm,
        ),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      controller.handle(
        authenticated(
          "POST",
          path,
          { origin },
          { ...validForm, csrf: "0".repeat(64) },
        ),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
    expect(mutation.inputs).toHaveLength(0);

    const changed = await controller.handle(
      authenticated("POST", path, { origin }, validForm),
    );
    expect(changed.statusCode).toBe(200);
    expect(changed.body).toContain("Funktion pausiert");
    expect(mutation.inputs).toHaveLength(1);
    expect(mutation.inputs[0]).toMatchObject({
      capability: "PROCUREMENT_CREATE",
      desiredState: "PAUSED",
      expectedVersion: 1,
      operationId: "browser-control-operation",
      reasonCode: "MAINTENANCE",
    });

    const supportSettings = await fixture({ role: "SUPPORT" }).handle(
      authenticated("GET", "/admin/settings"),
    );
    expect(supportSettings.statusCode).toBe(403);
  });

  it("renders support detail and protects customer-visible replies with exact-origin CSRF", async () => {
    const supportOperations = new CapturingSupportOperations();
    const controller = fixture({ supportOperations });
    const detailPath = `/admin/support/${targetOrderId}`;
    const detail = await controller.handle(authenticated("GET", detailPath));
    const action = `${detailPath}/note`;
    const csrf = new RegExp(
      `action="${action.replaceAll("/", "\\/")}"[^>]*><input type="hidden" name="csrf" value="([a-f0-9]{64})"`,
      "u",
    ).exec(detail.body)?.[1];

    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain("Supportfall ");
    expect(detail.body).toContain("Für Kunden sichtbar");
    expect(detail.body).toContain("Interne Notiz");
    expect(detail.body).toContain("Status ändern");
    expect(detail.body).not.toContain("<script>alert(1)</script>");
    expect(csrf).toBeTruthy();

    const form = {
      csrf: required(csrf),
      message: "Sichere Antwort an den Kunden",
      visibility: "CUSTOMER_VISIBLE",
    };
    await expect(
      controller.handle(authenticated("POST", action, {}, form)),
    ).resolves.toMatchObject({ statusCode: 403 });
    await expect(
      controller.handle(
        authenticated(
          "POST",
          action,
          { origin },
          { ...form, visibility: "OWNER_ONLY" },
        ),
      ),
    ).resolves.toMatchObject({ statusCode: 400 });
    expect(supportOperations.notes).toHaveLength(1);

    await expect(
      controller.handle(authenticated("POST", action, { origin }, form)),
    ).resolves.toMatchObject({
      headers: { Location: detailPath },
      statusCode: 303,
    });
    expect(supportOperations.notes).toHaveLength(2);
    expect(supportOperations.notes.at(-1)).toMatchObject({
      caseId: targetOrderId,
      message: "Sichere Antwort an den Kunden",
      visibility: "CUSTOMER_VISIBLE",
    });
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
    expect(response.body).toContain(
      "Es wurde kein Produktschlüssel offengelegt",
    );
    expect(response.body).not.toMatch(/TEST-[A-Z0-9-]+/u);
  });

  it("protects the staging fulfillment action with capability, exact origin, CSRF and confirmation", async () => {
    const delayed = new CapturingDelayedFulfillment();
    const controller = fixture({ delayed, delayedEligible: true });
    const path = `/admin/orders/${targetOrderId}/staging-fulfillment`;
    const detail = await controller.handle(
      authenticated("GET", `/admin/orders/${targetOrderId}`),
    );
    const csrf = new RegExp(
      `action="${path.replaceAll("/", "\\/")}"[^>]*><input type="hidden" name="csrf" value="([a-f0-9]{64})"`,
      "u",
    ).exec(detail.body)?.[1];
    expect(detail.body).toContain("Synthetische Auslieferung bestätigen");
    expect(csrf).toBeTruthy();

    await expect(
      controller.handle(authenticated("GET", path)),
    ).resolves.toMatchObject({ statusCode: 405 });
    for (const candidate of [
      authenticated(
        "POST",
        path,
        { origin: "https://attacker.invalid" },
        {
          confirm: "SYNTHETIC_DELAYED_FULFILLMENT",
          csrf: required(csrf),
        },
      ),
      authenticated(
        "POST",
        path,
        { origin },
        { confirm: "WRONG", csrf: required(csrf) },
      ),
      authenticated(
        "POST",
        path,
        { origin },
        {
          confirm: "SYNTHETIC_DELAYED_FULFILLMENT",
          csrf: "0".repeat(64),
        },
      ),
    ]) {
      await expect(controller.handle(candidate)).resolves.toMatchObject({
        statusCode: 403,
      });
    }
    expect(delayed.calls).toHaveLength(0);

    const completed = await controller.handle(
      authenticated(
        "POST",
        path,
        { origin },
        {
          confirm: "SYNTHETIC_DELAYED_FULFILLMENT",
          csrf: required(csrf),
        },
      ),
    );
    expect(completed.statusCode).toBe(200);
    expect(completed.body).toContain("Auslieferung abgeschlossen");
    expect(delayed.calls).toHaveLength(1);
    expect(completed.body).not.toMatch(/SYNTHETIC_[A-Z0-9_-]{10,}/u);

    const support = fixture({
      delayed: new CapturingDelayedFulfillment(),
      delayedEligible: true,
      role: "SUPPORT",
    });
    const supportDetail = await support.handle(
      authenticated("GET", `/admin/orders/${targetOrderId}`),
    );
    expect(supportDetail.body).not.toContain(
      "Synthetische Auslieferung bestätigen",
    );
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
    expect(staff.body).toContain('data-label="Anmeldekennung"');
    expect(staff.body).toContain("Support");
    expect(staff.body).toContain("Aktiv");
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
    expect(audit.body).toContain("Mitarbeiter angelegt");
    expect(audit.body).toContain("Admin-Vorgang");
    expect(audit.body).toContain("Erfolgreich");
    expect(audit.body).toContain("Neue Rolle: Finanzen");
    expect(audit.body).toContain("Vorherige Rolle: Support");
    expect(audit.body).toContain("Berechtigung: Audit-Protokoll anzeigen");
    const auditTable =
      audit.body
        .split('<table class="audit-table">')[1]
        ?.split("</table>")[0] ?? "";
    expect(auditTable).not.toMatch(
      /cookie|authorization|csrf|session.?hash|product.?key/iu,
    );
    expect(visibleText(auditTable)).not.toMatch(
      /ADMIN_STAFF_CREATED|ADMIN_ROLE_CHANGED|FINANCE|SUPPORT|AUDIT_VIEW|SUCCEEDED/u,
    );

    const detail = await fixture().handle(
      authenticated("GET", `/admin/staff/${targetOrderId}`),
    );
    expect(detail.body).toContain("Standardberechtigungen");
    expect(detail.body).toContain("Bestellungen anzeigen");
    expect(detail.body).toContain("Rollen- und Berechtigungsverlauf");
    expect(visibleText(detail.body)).not.toMatch(
      /ADMIN_ACCESS|ORDER_VIEW|PROJECT_OWNER|SECURITY_AUDITOR/u,
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
    readonly controlMutation?: AdminOperationsControlMutationPort;
    readonly customerAccessConfirmed?: boolean;
    readonly supportOperations?: AdminSupportOperationsPort;
    readonly delayed?: StagingDelayedFulfillmentPort;
    readonly delayedEligible?: boolean;
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
        recentOrders: [
          {
            ...summary(),
            customerAccessConfirmed:
              options.customerAccessConfirmed ??
              summary().customerAccessConfirmed,
          },
        ],
        revenueByCurrency: [],
        topProducts: [
          {
            productId: "10000000-0000-4000-8000-000000000001",
            productTitle: "Neonpfad: Berlin",
            purchasedQuantity: 1,
          },
        ],
        totalOrders: 1,
      };
    },
    findDetail: async () => ({
      ...(options.delayedEligible ? eligibleSummary() : summary()),
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
    list: async () => ({
      metrics: {
        attentionOrders: 0,
        failedOrders: 0,
        processingOrders: 1,
        totalOrders: 1,
      },
      orders: [
        {
          ...summary(),
          customerAccessConfirmed:
            options.customerAccessConfirmed ??
            summary().customerAccessConfirmed,
        },
      ],
      totalCount: 1,
    }),
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
          safeDetails: {
            action: "ADMIN_ROLE_CHANGED",
            capability: "AUDIT_VIEW",
            newRole: "FINANCE",
            previousRole: "SUPPORT",
            sessionCode: "must-not-render",
          },
          timestampUtc: new Date("2026-09-01T09:00:00.000Z"),
        },
      ],
    }),
    revokePermission: async () => "UPDATED",
    setStatus: async () => "UPDATED",
  };
  const operations: AdminOperationsRepository = {
    financeSummary: async () => [
      {
        capturedAmountMinor: "900719925474099312",
        capturedOrders: 1,
        currency: "EUR",
        partiallyRefundedOrders: 1,
        refundedAmountMinor: "0",
        refundedOrders: 0,
      },
    ],
    listCustomers: async () => ({
      items: [
        {
          createdAt: new Date("2026-09-01T09:00:00.000Z"),
          customerId: targetOrderId,
          email: "customer-a@example.test",
          lastOrderAt: new Date("2026-09-02T09:00:00.000Z"),
          lastOrderReference: "KR-100001",
          lastOrderStatus: "COMPLETED",
          orderCount: 1,
          verificationState: "VERIFIED",
        },
      ],
      metrics: {
        customersWithOrders: 1,
        totalCustomers: 1,
        totalOrders: 1,
        verifiedCustomers: 1,
      },
      totalCount: 1,
    }),
    findCustomer: async () => ({
      createdAt: new Date("2026-09-01T09:00:00.000Z"),
      customerId: targetOrderId,
      email: "customer-a@example.test",
      lastOrderAt: new Date("2026-09-02T09:00:00.000Z"),
      lastOrderReference: "KR-100001",
      lastOrderStatus: "COMPLETED",
      orderCount: 1,
      verificationState: "VERIFIED",
    }),
    listFraudReviews: async () => ({
      items: [
        {
          openedAt: new Date("2026-09-02T09:00:00.000Z"),
          orderId: targetOrderId,
          reasonCodes: ["MANUAL_REVIEW_REQUIRED"],
          resolvedAt: null,
          reviewId: targetOrderId,
          status: "OPEN",
        },
      ],
    }),
    listOperationsControls: async () => [
      {
        capability: "PROCUREMENT_CREATE",
        reasonCode: null,
        recordVersion: 1,
        state: "ENABLED",
        updatedAt: new Date("2026-09-02T09:00:00.000Z"),
      },
    ],
    listProducts: async () => ({
      items: [
        {
          active: true,
          availableOfferCount: 1,
          lifecycle: "ACTIVE_CANDIDATE",
          offerCount: 2,
          platform: "WINDOWS",
          productId: targetOrderId,
          productType: "GAME",
          title: "Neonpfad: Berlin",
        },
      ],
    }),
    listSuppliers: async () => ({
      items: [
        {
          activeOfferCount: 1,
          displayName: "Synthetic Supplier",
          lastSyncAt: null,
          lastSyncStatus: null,
          productCount: 1,
          supplierCode: "synthetic",
          supplierId: targetOrderId,
        },
      ],
    }),
    listSupportCases: async () => ({
      items: [
        {
          caseId: targetOrderId,
          category: "ORDER_STATUS",
          customerEmail: "customer-a@example.test",
          orderId: targetOrderId,
          priority: "NORMAL",
          status: "OPEN",
          updatedAt: new Date("2026-09-02T09:00:00.000Z"),
        },
      ],
    }),
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
    options.delayed,
    new AdminOperationsService(
      operations,
      audit,
      hmacMaterial,
      "STAGING",
      undefined,
      options.controlMutation,
      options.supportOperations ?? new CapturingSupportOperations(),
    ),
  );
};

class CapturingControlMutation implements AdminOperationsControlMutationPort {
  public readonly inputs: Parameters<
    AdminOperationsControlMutationPort["change"]
  >[0][] = [];
  public async change(
    input: Parameters<AdminOperationsControlMutationPort["change"]>[0],
  ) {
    this.inputs.push(input);
    return {
      control: {
        capability: input.capability,
        createdAt: new Date("2026-09-01T08:00:00.000Z"),
        reasonCode: input.reasonCode,
        recordVersion: input.expectedVersion + 1,
        state: input.desiredState,
        updatedAt: new Date("2026-09-02T10:00:00.000Z"),
      },
      status: "UPDATED" as const,
    };
  }
}

class CapturingSupportOperations implements AdminSupportOperationsPort {
  public readonly notes: Parameters<
    AdminSupportOperationsPort["addNote"]
  >[0][] = [];

  public async detail() {
    return supportDetailFixture();
  }

  public async addNote(
    input: Parameters<AdminSupportOperationsPort["addNote"]>[0],
  ) {
    this.notes.push(input);
    if (
      input.visibility !== "CUSTOMER_VISIBLE" &&
      input.visibility !== "INTERNAL"
    )
      return { code: "BAD_REQUEST" as const, status: "FAILED" as const };
    return { detail: supportDetailFixture(), status: "OK" as const };
  }

  public async changePriority() {
    return { detail: supportDetailFixture(), status: "OK" as const };
  }

  public async transition() {
    return { detail: supportDetailFixture(), status: "OK" as const };
  }
}

const supportDetailFixture = () => ({
  case: {
    category: "ORDER_STATUS" as const,
    closedAt: null,
    correlationId: "support-case-fixture" as never,
    createdAt: new Date("2026-09-02T08:00:00.000Z"),
    customerId: "10000000-0000-4000-8000-000000000001" as never,
    id: targetOrderId,
    orderId: targetOrderId,
    priority: "NORMAL" as const,
    recordVersion: 1,
    resolutionCode: null,
    resolvedAt: null,
    source: "CUSTOMER" as const,
    status: "OPEN" as const,
    updatedAt: new Date("2026-09-02T09:00:00.000Z"),
  },
  events: [
    {
      actorReference: "10000000-0000-4000-8000-000000000001",
      actorType: "CUSTOMER" as const,
      caseId: targetOrderId,
      eventType: "CASE_CREATED" as const,
      fromPriority: null,
      fromStatus: null,
      id: "50000000-0000-4000-8000-000000000001",
      linkTargetId: null,
      linkType: null,
      occurredAt: new Date("2026-09-02T08:00:00.000Z"),
      toPriority: null,
      toStatus: null,
    },
  ],
  links: [],
  messages: [
    {
      authorType: "CUSTOMER" as const,
      body: "Problem & <script>alert(1)</script>",
      caseId: targetOrderId,
      createdAt: new Date("2026-09-02T08:00:00.000Z"),
      id: "60000000-0000-4000-8000-000000000001",
      visibility: "CUSTOMER_VISIBLE" as const,
    },
    {
      authorType: "OPERATOR" as const,
      body: "Interne Untersuchung",
      caseId: targetOrderId,
      createdAt: new Date("2026-09-02T08:30:00.000Z"),
      id: "60000000-0000-4000-8000-000000000002",
      visibility: "INTERNAL" as const,
    },
  ],
});

class CapturingDelayedFulfillment implements StagingDelayedFulfillmentPort {
  public readonly calls: Parameters<
    StagingDelayedFulfillmentPort["complete"]
  >[0][] = [];
  public async complete(
    input: Parameters<StagingDelayedFulfillmentPort["complete"]>[0],
  ) {
    this.calls.push(input);
    return { status: "COMPLETED" as const };
  }
}

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
  customerAccessConfirmed: false,
  customerEmail: "customer@example.test",
  fulfillmentStatus: "PENDING",
  orderId: targetOrderId,
  operatorReference: "KR0000001",
  paymentStatus: "CAPTURED",
  procurementStatus: "SUCCEEDED",
  productPlatform: "WINDOWS",
  productTitle: "Arena Eleven",
  quantity: 1,
  riskStatus: "APPROVED",
  status: "FULFILLMENT_PENDING",
  updatedAt: new Date("2026-09-02T09:01:00.000Z"),
});
const eligibleSummary = () => ({
  ...summary(),
  fulfillmentStatus: "NOT_STARTED",
  procurementStatus: "NOT_STARTED",
  status: "PAYMENT_CAPTURED",
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
const visibleText = (html: string): string =>
  html.replaceAll(/<[^>]+>/gu, " ").replaceAll(/\s+/gu, " ");
