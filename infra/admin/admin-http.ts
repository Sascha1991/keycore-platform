import type {
  AdminAuthenticationService,
  AdminOrderDetail,
  AdminOrderListResult,
  AdminOrderService,
  AdminPrincipal,
  AdminStaffDetail,
  AdminStaffService,
  AdminStaffSummary,
  AdminAuditEntry,
  AdminRole,
  AdminCapability,
} from "../../packages/platform/src/contracts.js";
import {
  AdminAccessError,
  adminCapabilities,
  adminRoles,
  createAdminCsrf,
  hasAdminCapability,
  newAdminCorrelationId,
  verifyAdminCsrf,
  orderId,
} from "../../packages/platform/src/contracts.js";
import type { StagingDelayedFulfillmentPort } from "../storefront/staging-delayed-fulfillment.js";
import {
  adminAuditCodeLabel,
  adminAuditEventTypeLabel,
  adminAuditOutcomeLabel,
  adminCapabilityLabel,
  adminEntityTypeLabel,
  adminOrderStatuses,
  adminRoleLabel,
  adminStaffStatusLabel,
  adminStatusLabel,
  formatAdminAuditSafeDetails,
} from "./admin-presentation.js";

export interface AdminHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly form: URLSearchParams;
}

export interface AdminHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface AdminHttpConfig {
  readonly allowedOrigin: string;
  readonly csrfSecret: string;
  readonly secureCookies: boolean;
}

const sessionCookieName = "keyrano_admin_session";

export class AdminHttpController {
  public constructor(
    private readonly authentication: AdminAuthenticationService,
    private readonly orders: AdminOrderService,
    private readonly staff: AdminStaffService,
    private readonly config: AdminHttpConfig,
    private readonly delayedFulfillment?: StagingDelayedFulfillmentPort,
  ) {}

  public async handle(request: AdminHttpRequest): Promise<AdminHttpResponse> {
    try {
      if (request.path === "/admin/login")
        return await this.handleLogin(request);
      const rawSession = readCookie(request.headers.cookie, sessionCookieName);
      if (!rawSession)
        return redirect(
          "/admin/login",
          clearSessionCookie(this.config.secureCookies),
        );
      const authenticated = await this.authentication.authenticate(
        rawSession,
        newAdminCorrelationId(),
      );
      if (!authenticated.authenticated || !authenticated.principal) {
        return redirect(
          "/admin/login",
          clearSessionCookie(this.config.secureCookies),
        );
      }
      const principal = authenticated.principal;
      if (request.path === "/admin/logout")
        return await this.handleLogout(request, principal, rawSession);
      if (request.method === "GET" && request.path === "/admin/")
        return await this.dashboard(principal);
      if (request.method === "GET" && request.path === "/admin/orders")
        return await this.orderList(principal, request);
      if (request.method === "GET" && request.path === "/admin/staff")
        return await this.staffList(principal);
      if (request.path === "/admin/staff" && request.method === "POST")
        return await this.createStaff(principal, request);
      if (request.method === "GET" && request.path === "/admin/audit")
        return await this.auditList(principal, request);
      const staffDetailMatch = /^\/admin\/staff\/([0-9a-f-]{36})$/iu.exec(
        request.path,
      );
      if (request.method === "GET" && staffDetailMatch?.[1])
        return await this.staffDetail(principal, staffDetailMatch[1]);
      const staffMutationMatch =
        /^\/admin\/staff\/([0-9a-f-]{36})\/(disable|enable|role|permissions\/(grant|revoke))$/iu.exec(
          request.path,
        );
      if (staffMutationMatch?.[1] && staffMutationMatch[2]) {
        if (request.method !== "POST")
          return this.render(
            405,
            errorContent("Anfrage nicht verfügbar."),
            principal,
            { Allow: "POST" },
          );
        return await this.staffMutation(
          principal,
          staffMutationMatch[1],
          staffMutationMatch[2],
          request,
        );
      }
      const detailMatch = /^\/admin\/orders\/([0-9a-f-]{36})$/iu.exec(
        request.path,
      );
      if (request.method === "GET" && detailMatch?.[1])
        return await this.orderDetail(principal, detailMatch[1]);
      const delayedMatch =
        /^\/admin\/orders\/([0-9a-f-]{36})\/staging-fulfillment$/iu.exec(
          request.path,
        );
      if (delayedMatch?.[1]) {
        if (request.method !== "POST")
          return this.render(
            405,
            errorContent("Anfrage nicht verfügbar."),
            principal,
            { Allow: "POST" },
          );
        return await this.completeStagingFulfillment(
          principal,
          delayedMatch[1],
          request,
        );
      }
      const revealMatch =
        /^\/admin\/orders\/([0-9a-f-]{36})\/product-key\/reveal$/iu.exec(
          request.path,
        );
      if (revealMatch?.[1]) {
        if (request.method !== "POST")
          return this.render(
            405,
            errorContent("Anfrage nicht verfügbar."),
            principal,
            { Allow: "POST" },
          );
        return await this.revealAttempt(principal, revealMatch[1], request);
      }
      return this.render(
        404,
        errorContent("Bereich nicht verfügbar."),
        principal,
      );
    } catch (error) {
      if (error instanceof AdminAccessError) {
        const status =
          error.reasonCode === "ADMIN_ACCESS_DENIED"
            ? 403
            : error.reasonCode === "ADMIN_INPUT_INVALID"
              ? 400
              : 404;
        return this.render(
          status,
          errorContent("Diese Admin-Anfrage ist nicht verfügbar."),
        );
      }
      return this.render(
        503,
        errorContent("Der Admin-Bereich ist vorübergehend nicht verfügbar."),
      );
    }
  }

  private async handleLogin(
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    if (request.method === "GET") return loginPage();
    if (request.method !== "POST")
      return this.render(
        405,
        errorContent("Anfrage nicht verfügbar."),
        undefined,
        { Allow: "GET, POST" },
      );
    if (
      !this.validOrigin(request) ||
      !hasExactFields(request.form, ["session_code"])
    )
      return this.render(400, errorContent("Anmeldung nicht möglich."));
    const rawSession = request.form.get("session_code") ?? "";
    const result = await this.authentication.authenticate(
      rawSession,
      newAdminCorrelationId(),
    );
    if (!result.authenticated)
      return this.render(401, errorContent("Anmeldung nicht möglich."));
    return redirect(
      "/admin/",
      sessionCookie(rawSession, this.config.secureCookies),
    );
  }

  private async handleLogout(
    request: AdminHttpRequest,
    principal: AdminPrincipal,
    rawSession: string,
  ): Promise<AdminHttpResponse> {
    if (request.method !== "POST")
      return this.render(
        405,
        errorContent("Anfrage nicht verfügbar."),
        principal,
        { Allow: "POST" },
      );
    const path = "/admin/logout";
    if (!this.validSensitivePost(request, principal, path))
      return this.render(
        403,
        errorContent("Anfrage nicht verfügbar."),
        principal,
      );
    await this.authentication.logout(rawSession);
    return redirect(
      "/admin/login",
      clearSessionCookie(this.config.secureCookies),
    );
  }

  private async dashboard(
    principal: AdminPrincipal,
  ): Promise<AdminHttpResponse> {
    const result = await this.orders.dashboard(
      principal,
      newAdminCorrelationId(),
    );
    const revenue =
      result.revenueByCurrency.length > 0
        ? result.revenueByCurrency
            .map(
              (item) =>
                `<li><strong>${escapeHtml(formatMinor(item.amountMinor, item.currency))}</strong><span>${escapeHtml(item.currency)}</span></li>`,
            )
            .join("")
        : "<li><strong>0</strong><span>Keine erfassten Umsätze</span></li>";
    return this.render(
      200,
      `
      <header class="page-heading"><p>Admin-Bereich</p><h1>Übersicht</h1></header>
      <section class="metric-grid" aria-label="Bestellkennzahlen">
        ${metric("Bestellungen", result.totalOrders)}${metric("Aufmerksamkeit", result.attentionOrders)}${metric("In Bearbeitung", result.processingOrders)}${metric("Fehlgeschlagen", result.failedOrders)}
      </section>
      <section class="content-section"><div class="section-heading"><h2>Erfasster Umsatz</h2></div><ul class="revenue-list">${revenue}</ul></section>
      <section class="content-section orders-section"><div class="section-heading"><h2>Letzte Bestellungen</h2><a href="/admin/orders">Alle anzeigen</a></div>${ordersTable(result.recentOrders)}</section>
    `,
      principal,
    );
  }

  private async orderList(
    principal: AdminPrincipal,
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    rejectDuplicateParameters(request.query, [
      "search",
      "status",
      "from",
      "to",
      "cursor",
    ]);
    const result = await this.orders.list(
      principal,
      compactQuery(request.query),
      newAdminCorrelationId(),
    );
    return this.render(
      200,
      `
      <header class="page-heading"><p>Bestellverwaltung</p><h1>Bestellungen</h1></header>
      ${searchForm(request.query)}
      <section class="content-section orders-section"><div class="section-heading"><h2>Ergebnisse</h2><span>${result.orders.length} Einträge</span></div>${ordersTable(result.orders)}${pagination(result, request.query)}</section>
    `,
      principal,
    );
  }

  private async orderDetail(
    principal: AdminPrincipal,
    targetOrderId: string,
  ): Promise<AdminHttpResponse> {
    const detail = await this.orders.detail(
      principal,
      targetOrderId,
      newAdminCorrelationId(),
    );
    const revealPath = `/admin/orders/${detail.orderId}/product-key/reveal`;
    const csrf = createAdminCsrf(
      principal,
      "POST",
      revealPath,
      this.config.csrfSecret,
    );
    const delayedPath = `/admin/orders/${detail.orderId}/staging-fulfillment`;
    const delayedCsrf = createAdminCsrf(
      principal,
      "POST",
      delayedPath,
      this.config.csrfSecret,
    );
    return this.render(
      200,
      orderDetailContent(
        detail,
        revealPath,
        csrf,
        delayedPath,
        delayedCsrf,
        Boolean(this.delayedFulfillment) &&
          hasAdminCapability(principal, "SENSITIVE_OPERATION") &&
          detail.status === "PAYMENT_CAPTURED" &&
          detail.paymentStatus === "CAPTURED" &&
          detail.riskStatus === "APPROVED" &&
          detail.procurementStatus === "NOT_STARTED" &&
          detail.fulfillmentStatus === "NOT_STARTED",
      ),
      principal,
    );
  }

  private async completeStagingFulfillment(
    principal: AdminPrincipal,
    targetOrderId: string,
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    const path = `/admin/orders/${targetOrderId}/staging-fulfillment`;
    if (
      !this.delayedFulfillment ||
      !hasAdminCapability(principal, "SENSITIVE_OPERATION") ||
      !this.validSensitivePost(request, principal, path, ["confirm", "csrf"]) ||
      request.form.get("confirm") !== "SYNTHETIC_DELAYED_FULFILLMENT"
    ) {
      return this.render(
        403,
        errorContent("Anfrage nicht verfügbar."),
        principal,
      );
    }
    const result = await this.delayedFulfillment.complete({
      correlationId: newAdminCorrelationId(),
      orderId: orderId(targetOrderId),
      principal,
    });
    const completed =
      result.status === "COMPLETED" || result.status === "ALREADY_COMPLETED";
    return this.render(
      completed ? 200 : 409,
      `<header class="page-heading"><p>Synthetischer Staging-Vorgang</p><h1>Verzögerte Auslieferung</h1></header><div class="notice ${completed ? "notice-success" : "notice-warning"}"><strong>${completed ? "Auslieferung abgeschlossen" : "Vorgang nicht verfügbar"}</strong><p>${completed ? "Die synthetische Bestellung wurde über die bestehenden Statusgrenzen in den bereiten Zustand überführt." : "Die Bestellung erfüllt die sicheren Voraussetzungen für diesen Vorgang nicht."}</p></div><p><a class="text-link" href="/admin/orders/${encodeURIComponent(targetOrderId)}">Zurück zur Bestellung</a></p>`,
      principal,
    );
  }

  private async revealAttempt(
    principal: AdminPrincipal,
    targetOrderId: string,
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    const path = `/admin/orders/${targetOrderId}/product-key/reveal`;
    if (!this.validSensitivePost(request, principal, path))
      return this.render(
        403,
        errorContent("Anfrage nicht verfügbar."),
        principal,
      );
    const result = await this.orders.requestProductKeyReveal(
      principal,
      targetOrderId,
      newAdminCorrelationId(),
    );
    return this.render(
      409,
      `
      <header class="page-heading"><p>Sicherer Vorgang</p><h1>Produktschlüsselzugriff</h1></header>
      <div class="notice notice-warning"><strong>Nicht verfügbar</strong><p>Die kontrollierte Admin-Entschlüsselung ist noch nicht freigeschaltet. Es wurde kein Produktschlüssel offengelegt.</p><small>Vorgang: ${escapeHtml(adminAuditCodeLabel(result.reasonCode))}</small></div>
      <p><a class="text-link" href="/admin/orders/${encodeURIComponent(targetOrderId)}">Zurück zur Bestellung</a></p>
    `,
      principal,
    );
  }

  private async staffList(
    principal: AdminPrincipal,
  ): Promise<AdminHttpResponse> {
    const rows = await this.staff.list(principal, newAdminCorrelationId());
    const createPath = "/admin/staff";
    const csrf = createAdminCsrf(
      principal,
      "POST",
      createPath,
      this.config.csrfSecret,
    );
    return this.render(200, staffListContent(rows, principal, csrf), principal);
  }

  private async createStaff(
    principal: AdminPrincipal,
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    const path = "/admin/staff";
    const fields = [
      "csrf",
      "first_name",
      "last_name",
      "employee_number",
      "email",
      "role",
    ];
    if (!this.validSensitivePost(request, principal, path, fields))
      return this.render(
        403,
        errorContent("Anfrage nicht verfügbar."),
        principal,
      );
    const adminId = await this.staff.create(
      principal,
      {
        email: request.form.get("email") ?? "",
        employeeNumber: request.form.get("employee_number") ?? "",
        firstName: request.form.get("first_name") ?? "",
        lastName: request.form.get("last_name") ?? "",
        role: request.form.get("role") ?? "",
      },
      newAdminCorrelationId(),
    );
    return locationRedirect(`/admin/staff/${adminId}`);
  }

  private async staffDetail(
    principal: AdminPrincipal,
    adminId: string,
  ): Promise<AdminHttpResponse> {
    const detail = await this.staff.detail(
      principal,
      adminId,
      newAdminCorrelationId(),
    );
    return this.render(
      200,
      staffDetailContent(detail, principal, this.config.csrfSecret),
      principal,
    );
  }

  private async staffMutation(
    principal: AdminPrincipal,
    adminId: string,
    action: string,
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    const path = `/admin/staff/${adminId}/${action}`;
    const fields =
      action === "role"
        ? ["csrf", "role"]
        : action.startsWith("permissions/")
          ? [
              "csrf",
              "capability",
              ...(action.endsWith("grant") ? ["reason"] : []),
            ]
          : ["csrf"];
    if (!this.validSensitivePost(request, principal, path, fields))
      return this.render(
        403,
        errorContent("Anfrage nicht verfügbar."),
        principal,
      );
    const correlationId = newAdminCorrelationId();
    if (action === "disable" || action === "enable")
      await this.staff.setStatus(
        principal,
        adminId,
        action === "disable" ? "DISABLED" : "ACTIVE",
        correlationId,
      );
    else if (action === "role")
      await this.staff.changeRole(
        principal,
        adminId,
        request.form.get("role") ?? "",
        correlationId,
      );
    else if (action === "permissions/grant")
      await this.staff.grantPermission(
        principal,
        adminId,
        request.form.get("capability") ?? "",
        request.form.get("reason") ?? "",
        correlationId,
      );
    else
      await this.staff.revokePermission(
        principal,
        adminId,
        request.form.get("capability") ?? "",
        correlationId,
      );
    return locationRedirect(`/admin/staff/${adminId}`);
  }

  private async auditList(
    principal: AdminPrincipal,
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    const names = [
      "from",
      "to",
      "event_type",
      "outcome",
      "actor_id",
      "entity_id",
      "reason_code",
      "cursor",
    ];
    rejectDuplicateParameters(request.query, names);
    const result = await this.staff.auditList(
      principal,
      {
        actorId: optional(request.query, "actor_id"),
        cursor: optional(request.query, "cursor"),
        entityId: optional(request.query, "entity_id"),
        eventType: optional(request.query, "event_type"),
        from: optional(request.query, "from"),
        outcome: optional(request.query, "outcome"),
        reasonCode: optional(request.query, "reason_code"),
        to: optional(request.query, "to"),
      },
      newAdminCorrelationId(),
    );
    return this.render(
      200,
      auditContent(result.entries, request.query, result.nextCursorValue),
      principal,
    );
  }

  private validSensitivePost(
    request: AdminHttpRequest,
    principal: AdminPrincipal,
    path: string,
    expectedFields: readonly string[] = ["csrf"],
  ): boolean {
    if (
      !this.validOrigin(request) ||
      !hasExactFields(request.form, expectedFields)
    )
      return false;
    const actual = request.form.get("csrf") ?? "";
    return verifyAdminCsrf(
      actual,
      createAdminCsrf(principal, "POST", path, this.config.csrfSecret),
    );
  }

  private validOrigin(request: AdminHttpRequest): boolean {
    return request.headers.origin === this.config.allowedOrigin;
  }

  private render(
    statusCode: number,
    content: string,
    principal?: AdminPrincipal,
    additionalHeaders: Readonly<Record<string, string>> = {},
  ): AdminHttpResponse {
    return page(
      statusCode,
      content,
      principal,
      additionalHeaders,
      this.config.csrfSecret,
    );
  }
}

const page = (
  statusCode: number,
  content: string,
  principal?: AdminPrincipal,
  additionalHeaders: Readonly<Record<string, string>> = {},
  csrfSecret?: string,
): AdminHttpResponse => ({
  body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KeyRaNo Admin</title><link rel="stylesheet" href="/admin/assets/admin.css"></head><body>${principal ? shell(content, principal, requiredSecret(csrfSecret)) : `<main class="standalone">${content}</main>`}</body></html>`,
  headers: securityHeaders(additionalHeaders),
  statusCode,
});

const loginPage = (): AdminHttpResponse =>
  page(
    200,
    `
  <section class="login-panel"><div class="brand">KeyRaNo <span>Admin</span></div><h1>Interne Anmeldung</h1><p>Nur für autorisierte Mitarbeitende.</p><form method="post" action="/admin/login"><label for="session_code">Sicherer Zugangscode</label><input id="session_code" name="session_code" type="password" autocomplete="off" required minlength="32" maxlength="512"><button type="submit">Anmelden</button></form></section>
`,
  );

const shell = (
  content: string,
  principal: AdminPrincipal,
  csrfSecret: string,
): string => {
  const csrf = createAdminCsrf(principal, "POST", "/admin/logout", csrfSecret);
  return `<div class="admin-shell"><aside><div class="brand">KeyRaNo <span>Admin</span></div><nav aria-label="Admin-Navigation"><a href="/admin/">Übersicht</a><a href="/admin/orders">Bestellungen</a>${hasAdminCapability(principal, "STAFF_VIEW") ? '<a href="/admin/staff">Mitarbeiter &amp; Rollen</a>' : ""}${hasAdminCapability(principal, "AUDIT_VIEW") ? '<a href="/admin/audit">Audit-Protokoll</a>' : ""}<span aria-disabled="true">Kunden</span><span aria-disabled="true">Support</span><span aria-disabled="true">Produkte / Katalog</span><span aria-disabled="true">Finanzen</span><span aria-disabled="true">System</span></nav><div class="identity"><strong>${escapeHtml(principal.displayName)}</strong><small>${escapeHtml(principal.roles.map(adminRoleLabel).join(", "))}</small><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Abmelden</button></form></div></aside><main>${content}</main></div>`;
};

const securityHeaders = (
  additional: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => ({
  "Cache-Control": "no-store, max-age=0",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Content-Type": "text/html; charset=utf-8",
  "Cross-Origin-Opener-Policy": "same-origin",
  // Same-origin form POSTs must retain a concrete Origin for exact validation.
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  ...additional,
});

const redirect = (location: string, cookie: string): AdminHttpResponse => ({
  body: "",
  headers: securityHeaders({ Location: location, "Set-Cookie": cookie }),
  statusCode: 303,
});
const locationRedirect = (location: string): AdminHttpResponse => ({
  body: "",
  headers: securityHeaders({ Location: location }),
  statusCode: 303,
});
const sessionCookie = (value: string, secure: boolean): string =>
  `${sessionCookieName}=${value}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? "; Secure" : ""}`;
const clearSessionCookie = (secure: boolean): string =>
  `${sessionCookieName}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;

const readCookie = (
  header: string | undefined,
  name: string,
): string | null => {
  if (!header || header.length > 4096) return null;
  for (const entry of header.split(";")) {
    const separator = entry.indexOf("=");
    if (separator > 0 && entry.slice(0, separator).trim() === name)
      return entry.slice(separator + 1).trim();
  }
  return null;
};

const hasExactFields = (
  form: URLSearchParams,
  expected: readonly string[],
): boolean => {
  const keys = [...form.keys()];
  return (
    keys.length === expected.length &&
    expected.every((key) => form.getAll(key).length === 1)
  );
};

const rejectDuplicateParameters = (
  query: URLSearchParams,
  names: readonly string[],
): void => {
  if (names.some((name) => query.getAll(name).length > 1))
    throw new AdminAccessError("ADMIN_INPUT_INVALID");
};

const optional = (query: URLSearchParams, name: string): string | undefined => {
  const value = query.get(name);
  return value === null || value === "" ? undefined : value;
};

const compactQuery = (query: URLSearchParams) => {
  const cursor = optional(query, "cursor");
  const fromDate = optional(query, "from");
  const search = optional(query, "search");
  const status = optional(query, "status");
  const toDate = optional(query, "to");
  return {
    ...(cursor ? { cursor } : {}),
    ...(fromDate ? { fromDate } : {}),
    ...(search ? { search } : {}),
    ...(status ? { status } : {}),
    ...(toDate ? { toDate } : {}),
  };
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
const formatMinor = (amountMinor: string, currency: string): string =>
  `${(Number(amountMinor) / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
const formatDate = (date: Date): string =>
  new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(date);
const metric = (label: string, value: number): string =>
  `<article><span>${escapeHtml(label)}</span><strong>${value}</strong></article>`;

const ordersTable = (
  orders: readonly AdminOrderListResult["orders"][number][],
): string =>
  orders.length === 0
    ? '<div class="empty-state"><strong>Keine Bestellungen gefunden</strong><p>Die gewählten Filter liefern keine Ergebnisse.</p></div>'
    : `<div class="table-wrap"><table class="orders-table"><thead><tr><th scope="col">Bestellung</th><th scope="col">Kunde</th><th scope="col">Produkt</th><th scope="col">Status</th><th scope="col">Betrag</th><th scope="col">Datum</th></tr></thead><tbody>${orders.map((order) => `<tr><td data-label="Bestellung" class="order-reference"><a href="/admin/orders/${order.orderId}">${escapeHtml(order.orderId)}</a></td><td data-label="Kunde" class="customer-reference">${escapeHtml(order.customerEmail ?? "Nicht verfügbar")}</td><td data-label="Produkt">${escapeHtml(order.productTitle)}</td><td data-label="Status"><span class="status status-${escapeHtml(order.status.toLowerCase())}">${escapeHtml(adminStatusLabel(order.status))}</span></td><td data-label="Betrag">${escapeHtml(formatMinor(order.amountMinor, order.currency))}</td><td data-label="Datum">${escapeHtml(formatDate(order.createdAt))}</td></tr>`).join("")}</tbody></table></div>`;

const searchForm = (query: URLSearchParams): string =>
  `<form class="filter-bar" method="get" action="/admin/orders"><label>Bestell-ID oder E-Mail<input type="search" name="search" maxlength="254" value="${escapeHtml(query.get("search") ?? "")}"></label><label>Status<select name="status"><option value="">Alle</option>${adminOrderStatuses.map((status) => `<option value="${status}"${query.get("status") === status ? " selected" : ""}>${escapeHtml(adminStatusLabel(status))}</option>`).join("")}</select></label><label>Von<input type="date" name="from" value="${escapeHtml(query.get("from") ?? "")}"></label><label>Bis<input type="date" name="to" value="${escapeHtml(query.get("to") ?? "")}"></label><button type="submit">Filtern</button></form>`;

const pagination = (
  result: AdminOrderListResult,
  query: URLSearchParams,
): string => {
  if (!result.nextCursorValue) return "";
  const next = new URLSearchParams(query);
  next.set("cursor", result.nextCursorValue);
  return `<a class="pagination" href="/admin/orders?${escapeHtml(next.toString())}">Weitere Bestellungen</a>`;
};

const orderDetailContent = (
  order: AdminOrderDetail,
  revealPath: string,
  csrf: string,
  delayedPath: string,
  delayedCsrf: string,
  delayedEligible: boolean,
): string =>
  `<header class="page-heading"><p>Bestelldetails</p><h1>${escapeHtml(order.orderId)}</h1></header><section class="detail-grid"><article><h2>Bestellung</h2>${detailRow("Produkt", order.productTitle)}${detailRow("Menge", String(order.quantity))}${detailRow("Kunde", order.customerEmail ?? "Nicht verfügbar")}${detailRow("Betrag", formatMinor(order.amountMinor, order.currency))}${detailRow("Status", adminStatusLabel(order.status))}${detailRow("Zahlung", adminStatusLabel(order.paymentStatus))}${detailRow("Beschaffung", adminStatusLabel(order.procurementStatus))}${detailRow("Auslieferung", adminStatusLabel(order.fulfillmentStatus))}${detailRow("Risiko", adminStatusLabel(order.riskStatus))}</article><article><h2>Operativer Kontext</h2>${detailRow("Gastbestellungs-Zuordnung", adminStatusLabel(order.guestClaimStatus))}${detailRow("Rechnung", adminStatusLabel(order.invoiceStatus))}${detailRow("Lieferant", order.supplierId ?? "Nicht verfügbar")}${detailRow("Lieferantenbestellung", order.externalSupplierOrderId ?? "Nicht verfügbar")}${detailRow("Abrufstatus", order.retrievalState ? adminStatusLabel(order.retrievalState) : "Nicht verfügbar")}${detailRow("Zustellstatus", order.deliveryState ? adminStatusLabel(order.deliveryState) : "Nicht verfügbar")}</article></section>${delayedEligible ? `<section class="content-section sensitive"><div class="section-heading"><div><p>Synthetischer Staging-Vorgang</p><h2>Verzögerte Auslieferung abschließen</h2></div></div><p>Dieser Vorgang nutzt keine Lieferantenverbindung und erzeugt ausschließlich verschlüsseltes synthetisches Testmaterial.</p><form method="post" action="${escapeHtml(delayedPath)}"><input type="hidden" name="csrf" value="${escapeHtml(delayedCsrf)}"><input type="hidden" name="confirm" value="SYNTHETIC_DELAYED_FULFILLMENT"><button type="submit">Synthetische Auslieferung bestätigen</button></form></section>` : ""}<section class="content-section sensitive"><div class="section-heading"><div><p>Sensibler Vorgang</p><h2>Produktschlüssel</h2></div></div><p>${order.encryptedSecretAvailable ? "Verschlüsseltes Material ist vorhanden. Eine Offenlegung ist nur über den kontrollierten separaten Vorgang möglich." : "Für diese Bestellung ist kein verschlüsseltes Material verfügbar."}</p><form method="post" action="${escapeHtml(revealPath)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit"${order.encryptedSecretAvailable ? "" : " disabled"}>Kontrollierten Zugriff anfordern</button></form></section><section class="content-section"><div class="section-heading"><h2>Statushistorie</h2></div>${order.history.length === 0 ? '<div class="empty-state"><strong>Keine Statushistorie verfügbar</strong></div>' : `<ol class="timeline">${order.history.map((entry) => `<li><strong>${escapeHtml(adminStatusLabel(entry.toStatus))}</strong><span>${escapeHtml(adminAuditCodeLabel(entry.reasonCode))} · ${escapeHtml(formatDate(entry.occurredAt))}</span></li>`).join("")}</ol>`}</section>`;
const detailRow = (label: string, value: string): string =>
  `<dl><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></dl>`;
const staffListContent = (
  staff: readonly AdminStaffSummary[],
  principal: AdminPrincipal,
  csrf: string,
): string => {
  const rows =
    staff.length === 0
      ? '<div class="empty-state"><strong>Keine Mitarbeitenden vorhanden</strong></div>'
      : `<div class="table-wrap"><table class="staff-table"><thead><tr><th scope="col">Name</th><th scope="col">Mitarbeiter-ID</th><th scope="col">Anmeldekennung</th><th scope="col">Rolle</th><th scope="col">Status</th><th scope="col">Zusätzliche Berechtigungen</th><th scope="col">Letzte Anmeldung</th><th scope="col">Erstellt</th><th scope="col">Aktionen</th></tr></thead><tbody>${staff.map((item) => `<tr><td data-label="Name">${escapeHtml(item.displayName)}</td><td data-label="Mitarbeiter-ID" class="order-reference">${escapeHtml(item.employeeNumber ?? item.adminId)}</td><td data-label="Anmeldekennung">${escapeHtml(item.emailNormalized ?? "Nicht eingerichtet")}</td><td data-label="Rolle">${escapeHtml(item.role ? adminRoleLabel(item.role) : "Keine aktive Rolle")}</td><td data-label="Status"><span class="status status-${item.status.toLowerCase()}">${escapeHtml(adminStaffStatusLabel(item.status))}</span></td><td data-label="Zusätzliche Berechtigungen">${item.hasAdditionalPermissions ? "Ja" : "Nein"}</td><td data-label="Letzte Anmeldung">${item.lastLoginAt ? escapeHtml(formatDate(item.lastLoginAt)) : "Nie"}</td><td data-label="Erstellt">${escapeHtml(formatDate(item.createdAt))}</td><td data-label="Aktionen"><a href="/admin/staff/${encodeURIComponent(item.adminId)}">Öffnen</a></td></tr>`).join("")}</tbody></table></div>`;
  const create = hasAdminCapability(principal, "STAFF_MANAGE")
    ? `<section class="content-section"><div class="section-heading"><h2>Mitarbeiter anlegen</h2></div><form class="staff-form" method="post" action="/admin/staff"><input type="hidden" name="csrf" value="${csrf}"><label>Vorname<input name="first_name" maxlength="80" required></label><label>Nachname<input name="last_name" maxlength="80" required></label><label>Mitarbeiter-ID<input name="employee_number" maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" required></label><label>E-Mail / Anmeldekennung (optional)<input name="email" type="email" maxlength="254"></label><label>Rolle<select name="role">${roleOptions()}</select></label><button type="submit">Mitarbeiter anlegen</button></form><p class="muted">Es wird kein Passwort und keine Anmeldemöglichkeit erzeugt.</p></section>`
    : "";
  return `<header class="page-heading"><p>Administration</p><h1>Mitarbeiter &amp; Rollen</h1></header><section class="content-section staff-section"><div class="section-heading"><h2>Mitarbeitende</h2><span>${staff.length} Einträge</span></div>${rows}</section>${create}`;
};

const staffDetailContent = (
  staff: AdminStaffDetail,
  principal: AdminPrincipal,
  secret: string,
): string => {
  const path = (suffix: string) => `/admin/staff/${staff.adminId}/${suffix}`;
  const csrfFor = (suffix: string) =>
    createAdminCsrf(principal, "POST", path(suffix), secret);
  const roleForm = hasAdminCapability(principal, "ROLE_ASSIGN")
    ? `<form class="inline-form" method="post" action="${path("role")}"><input type="hidden" name="csrf" value="${csrfFor("role")}"><label>Neue Rolle<select name="role">${roleOptions(staff.role)}</select></label><button type="submit">Rolle ändern</button></form>`
    : "";
  const statusAction = staff.status === "ACTIVE" ? "disable" : "enable";
  const statusForm = hasAdminCapability(principal, "STAFF_MANAGE")
    ? `<form class="inline-form" method="post" action="${path(statusAction)}"><input type="hidden" name="csrf" value="${csrfFor(statusAction)}"><button class="button-secondary" type="submit">${staff.status === "ACTIVE" ? "Mitarbeiter deaktivieren" : "Mitarbeiter reaktivieren"}</button></form>`
    : "";
  const permissionForm = hasAdminCapability(
    principal,
    "PERMISSION_OVERRIDE_MANAGE",
  )
    ? `<form class="inline-form" method="post" action="${path("permissions/grant")}"><input type="hidden" name="csrf" value="${csrfFor("permissions/grant")}"><label>Zusätzliche Berechtigung<select name="capability">${capabilityOptions(staff.activeIndividualCapabilities)}</select></label><label>Grund (optional)<input name="reason" maxlength="240"></label><button type="submit">Berechtigung erteilen</button></form>`
    : "";
  const grants =
    staff.activeIndividualCapabilities.length === 0
      ? '<div class="empty-state"><strong>Keine individuellen Berechtigungen</strong></div>'
      : `<ul class="capability-list">${staff.activeIndividualCapabilities.map((capability) => `<li><span>${escapeHtml(adminCapabilityLabel(capability))}</span>${hasAdminCapability(principal, "PERMISSION_OVERRIDE_MANAGE") ? `<form method="post" action="${path("permissions/revoke")}"><input type="hidden" name="csrf" value="${csrfFor("permissions/revoke")}"><input type="hidden" name="capability" value="${escapeHtml(capability)}"><button class="button-secondary" type="submit">Widerrufen</button></form>` : ""}</li>`).join("")}</ul>`;
  return `<header class="page-heading"><p>Mitarbeiterdetails</p><h1>${escapeHtml(staff.displayName)}</h1></header><section class="detail-grid"><article><h2>Stammdaten</h2>${detailRow("Vorname", staff.firstName ?? "Nicht hinterlegt")}${detailRow("Nachname", staff.lastName ?? "Nicht hinterlegt")}${detailRow("Mitarbeiter-ID", staff.employeeNumber ?? staff.adminId)}${detailRow("Anmeldekennung", staff.emailNormalized ?? "Nicht eingerichtet")}${detailRow("Status", adminStaffStatusLabel(staff.status))}${detailRow("Erstellt", formatDate(staff.createdAt))}${detailRow("Geändert", formatDate(staff.updatedAt))}</article><article><h2>Rolle</h2>${detailRow("Primäre Rolle", staff.role ? adminRoleLabel(staff.role) : "Keine aktive Rolle")}${roleForm}</article></section><section class="content-section"><div class="section-heading"><h2>Standardberechtigungen</h2></div>${capabilityList(staff.roleCapabilities)}</section><section class="content-section"><div class="section-heading"><h2>Zusätzliche Berechtigungen</h2></div>${grants}${permissionForm}</section><section class="content-section"><div class="section-heading"><h2>Effektive Berechtigungen</h2></div>${capabilityList(staff.effectiveCapabilities)}</section><section class="content-section"><div class="section-heading"><h2>Rollen- und Berechtigungsverlauf</h2></div><ol class="timeline">${staff.roleHistory.map((entry) => `<li><strong>${escapeHtml(adminRoleLabel(entry.role))}</strong><span>${escapeHtml(formatDate(entry.grantedAt))}${entry.revokedAt ? ` · widerrufen ${escapeHtml(formatDate(entry.revokedAt))}` : " · aktiv"}</span></li>`).join("")}${staff.permissionHistory.map((entry) => `<li><strong>${escapeHtml(adminCapabilityLabel(entry.capability))}</strong><span>${escapeHtml(formatDate(entry.grantedAt))}${entry.revokedAt ? ` · widerrufen ${escapeHtml(formatDate(entry.revokedAt))}` : " · aktiv"}</span></li>`).join("")}</ol></section><section class="content-section sensitive"><div class="section-heading"><h2>Sicherheitsaktionen</h2></div>${statusForm}<p class="muted">Rollen- und Berechtigungsänderungen widerrufen aktive Sitzungen.</p></section>`;
};

const auditContent = (
  entries: readonly AdminAuditEntry[],
  query: URLSearchParams,
  nextCursor?: string,
): string => {
  const rows =
    entries.length === 0
      ? '<div class="empty-state"><strong>Keine Protokolleinträge gefunden</strong></div>'
      : `<div class="table-wrap"><table class="audit-table"><thead><tr><th scope="col">Zeitpunkt</th><th scope="col">Ereignis</th><th scope="col">Ausgeführt von</th><th scope="col">Ziel</th><th scope="col">Ergebnis</th><th scope="col">Vorgang</th><th scope="col">Details</th></tr></thead><tbody>${entries
          .map(
            (entry) =>
              `<tr><td data-label="Zeitpunkt">${escapeHtml(formatDate(entry.timestampUtc))}</td><td data-label="Ereignis">${escapeHtml(adminAuditEventTypeLabel(entry.eventType))}</td><td data-label="Ausgeführt von" class="order-reference">${escapeHtml(entry.actorId)}</td><td data-label="Ziel" class="order-reference">${escapeHtml(`${adminEntityTypeLabel(entry.entityType)}: ${entry.entityId}`)}</td><td data-label="Ergebnis"><span class="status status-${entry.outcome.toLowerCase()}">${escapeHtml(adminAuditOutcomeLabel(entry.outcome))}</span></td><td data-label="Vorgang">${escapeHtml(adminAuditCodeLabel(entry.reasonCode))}</td><td data-label="Details">${escapeHtml(formatAdminAuditSafeDetails(entry.safeDetails))}</td></tr>`,
          )
          .join("")}</tbody></table></div>`;
  const next = nextCursor
    ? (() => {
        const value = new URLSearchParams(query);
        value.set("cursor", nextCursor);
        return `<a class="pagination" href="/admin/audit?${escapeHtml(value.toString())}">Weitere Einträge</a>`;
      })()
    : "";
  return `<header class="page-heading"><p>Sicherheitsnachweise</p><h1>Audit-Protokoll</h1></header><form class="filter-bar audit-filter" method="get" action="/admin/audit"><label>Von<input type="date" name="from" value="${escapeHtml(query.get("from") ?? "")}"></label><label>Bis<input type="date" name="to" value="${escapeHtml(query.get("to") ?? "")}"></label><label>Ereignistyp<input name="event_type" maxlength="100" value="${escapeHtml(query.get("event_type") ?? "")}"></label><label>Ergebnis<select name="outcome"><option value="">Alle</option>${(["SUCCEEDED", "FAILED", "DENIED"] as const).map((value) => `<option value="${value}"${query.get("outcome") === value ? " selected" : ""}>${escapeHtml(adminAuditOutcomeLabel(value))}</option>`).join("")}</select></label><label>Ausgeführt-von-ID<input name="actor_id" maxlength="36" value="${escapeHtml(query.get("actor_id") ?? "")}"></label><label>Ziel-ID<input name="entity_id" maxlength="36" value="${escapeHtml(query.get("entity_id") ?? "")}"></label><label>Vorgangscode<input name="reason_code" maxlength="100" value="${escapeHtml(query.get("reason_code") ?? "")}"></label><button type="submit">Filtern</button></form><section class="content-section audit-section"><div class="section-heading"><h2>Einträge</h2><span>${entries.length} Ergebnisse</span></div>${rows}${next}</section>`;
};
const roleOptions = (selected?: AdminRole | null): string =>
  adminRoles
    .map(
      (role) =>
        `<option value="${role}"${selected === role ? " selected" : ""}>${escapeHtml(adminRoleLabel(role))}</option>`,
    )
    .join("");
const capabilityOptions = (excluded: readonly AdminCapability[]): string =>
  adminCapabilities
    .filter((capability) => !excluded.includes(capability))
    .map(
      (capability) =>
        `<option value="${capability}">${escapeHtml(adminCapabilityLabel(capability))}</option>`,
    )
    .join("");
const capabilityList = (capabilities: readonly AdminCapability[]): string =>
  capabilities.length === 0
    ? '<div class="empty-state"><strong>Keine Berechtigungen</strong></div>'
    : `<ul class="capability-list">${capabilities.map((capability) => `<li><span>${escapeHtml(adminCapabilityLabel(capability))}</span></li>`).join("")}</ul>`;
const errorContent = (message: string): string =>
  `<div class="notice notice-error"><strong>KeyRaNo Admin</strong><p>${escapeHtml(message)}</p></div>`;
const requiredSecret = (value: string | undefined): string => {
  if (!value) throw new Error("Admin CSRF secret unavailable");
  return value;
};
