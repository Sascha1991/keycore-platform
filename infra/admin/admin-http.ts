import type {
  AdminAuthenticationService,
  AdminOrderDetail,
  AdminOrderListResult,
  AdminOrderService,
  AdminPrincipal,
} from "../../packages/platform/src/contracts.js";
import {
  AdminAccessError,
  createAdminCsrf,
  newAdminCorrelationId,
  verifyAdminCsrf,
} from "../../packages/platform/src/contracts.js";

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
    private readonly config: AdminHttpConfig,
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
      const detailMatch = /^\/admin\/orders\/([0-9a-f-]{36})$/iu.exec(
        request.path,
      );
      if (request.method === "GET" && detailMatch?.[1])
        return await this.orderDetail(principal, detailMatch[1]);
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
      <header class="page-heading"><p>Übersicht</p><h1>Dashboard</h1></header>
      <section class="metric-grid" aria-label="Bestellkennzahlen">
        ${metric("Bestellungen", result.totalOrders)}${metric("Aufmerksamkeit", result.attentionOrders)}${metric("In Bearbeitung", result.processingOrders)}${metric("Fehlgeschlagen", result.failedOrders)}
      </section>
      <section class="content-section"><div class="section-heading"><h2>Erfasster Umsatz</h2></div><ul class="revenue-list">${revenue}</ul></section>
      <section class="content-section"><div class="section-heading"><h2>Letzte Bestellungen</h2><a href="/admin/orders">Alle anzeigen</a></div>${ordersTable(result.recentOrders)}</section>
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
      <section class="content-section"><div class="section-heading"><h2>Ergebnisse</h2><span>${result.orders.length} Einträge</span></div>${ordersTable(result.orders)}${pagination(result, request.query)}</section>
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
    return this.render(
      200,
      orderDetailContent(detail, revealPath, csrf),
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
      <header class="page-heading"><p>Sicherer Vorgang</p><h1>Product-Key-Zugriff</h1></header>
      <div class="notice notice-warning"><strong>Nicht verfügbar</strong><p>Die kontrollierte Admin-Entschlüsselung ist noch nicht freigeschaltet. Es wurde kein Product Key offengelegt.</p><small>Referenz: ${escapeHtml(result.reasonCode)}</small></div>
      <p><a class="text-link" href="/admin/orders/${encodeURIComponent(targetOrderId)}">Zurück zur Bestellung</a></p>
    `,
      principal,
    );
  }

  private validSensitivePost(
    request: AdminHttpRequest,
    principal: AdminPrincipal,
    path: string,
  ): boolean {
    if (!this.validOrigin(request) || !hasExactFields(request.form, ["csrf"]))
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
  return `<div class="admin-shell"><aside><div class="brand">KeyRaNo <span>Admin</span></div><nav aria-label="Admin-Navigation"><a href="/admin/">Dashboard</a><a href="/admin/orders">Bestellungen</a><span aria-disabled="true">Kunden</span><span aria-disabled="true">Support</span><span aria-disabled="true">Rabatte / Kampagnen</span><span aria-disabled="true">Produkte / Katalog</span><span aria-disabled="true">Lieferanten</span><span aria-disabled="true">Finanzen</span><span aria-disabled="true">Sicherheit</span><span aria-disabled="true">System</span></nav><div class="identity"><strong>${escapeHtml(principal.displayName)}</strong><small>${escapeHtml(principal.roles.join(", "))}</small><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Abmelden</button></form></div></aside><main>${content}</main></div>`;
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
    : `<div class="table-wrap"><table><thead><tr><th>Bestellung</th><th>Kunde</th><th>Produkt</th><th>Status</th><th>Betrag</th><th>Datum</th></tr></thead><tbody>${orders.map((order) => `<tr><td><a href="/admin/orders/${order.orderId}">${escapeHtml(order.orderId)}</a></td><td>${escapeHtml(order.customerEmail ?? "Nicht verfügbar")}</td><td>${escapeHtml(order.productTitle)}</td><td><span class="status status-${escapeHtml(order.status.toLowerCase())}">${escapeHtml(order.status)}</span></td><td>${escapeHtml(formatMinor(order.amountMinor, order.currency))}</td><td>${escapeHtml(formatDate(order.createdAt))}</td></tr>`).join("")}</tbody></table></div>`;

const searchForm = (query: URLSearchParams): string =>
  `<form class="filter-bar" method="get" action="/admin/orders"><label>Bestell-ID oder E-Mail<input type="search" name="search" maxlength="254" value="${escapeHtml(query.get("search") ?? "")}"></label><label>Status<select name="status"><option value="">Alle</option>${["CREATED", "AWAITING_PAYMENT", "PAYMENT_CAPTURED", "PROCUREMENT_PENDING", "PROCUREMENT_IN_PROGRESS", "FULFILLMENT_PENDING", "COMPLETED", "CANCELLED", "FAILED", "REFUND_PENDING", "REFUNDED", "MANUAL_REVIEW"].map((status) => `<option${query.get("status") === status ? " selected" : ""}>${status}</option>`).join("")}</select></label><label>Von<input type="date" name="from" value="${escapeHtml(query.get("from") ?? "")}"></label><label>Bis<input type="date" name="to" value="${escapeHtml(query.get("to") ?? "")}"></label><button type="submit">Filtern</button></form>`;

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
): string =>
  `<header class="page-heading"><p>Bestelldetails</p><h1>${escapeHtml(order.orderId)}</h1></header><section class="detail-grid"><article><h2>Bestellung</h2>${detailRow("Produkt", order.productTitle)}${detailRow("Menge", String(order.quantity))}${detailRow("Kunde", order.customerEmail ?? "Nicht verfügbar")}${detailRow("Betrag", formatMinor(order.amountMinor, order.currency))}${detailRow("Status", order.status)}${detailRow("Zahlung", order.paymentStatus)}${detailRow("Beschaffung", order.procurementStatus)}${detailRow("Fulfillment", order.fulfillmentStatus)}${detailRow("Risiko", order.riskStatus)}</article><article><h2>Operativer Kontext</h2>${detailRow("Gast-Claim", order.guestClaimStatus)}${detailRow("Rechnung", order.invoiceStatus)}${detailRow("Lieferant", order.supplierId ?? "Nicht verfügbar")}${detailRow("Supplier Order", order.externalSupplierOrderId ?? "Nicht verfügbar")}${detailRow("Retrieval", order.retrievalState ?? "Nicht verfügbar")}${detailRow("Delivery", order.deliveryState ?? "Nicht verfügbar")}</article></section><section class="content-section sensitive"><div class="section-heading"><div><p>Sensibler Vorgang</p><h2>Product Key</h2></div></div><p>${order.encryptedSecretAvailable ? "Verschlüsseltes Material ist vorhanden. Eine Offenlegung ist nur über den kontrollierten separaten Vorgang möglich." : "Für diese Bestellung ist kein verschlüsseltes Material verfügbar."}</p><form method="post" action="${escapeHtml(revealPath)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit"${order.encryptedSecretAvailable ? "" : " disabled"}>Kontrollierten Zugriff anfordern</button></form></section><section class="content-section"><div class="section-heading"><h2>Statushistorie</h2></div>${order.history.length === 0 ? '<div class="empty-state"><strong>Keine Statushistorie verfügbar</strong></div>' : `<ol class="timeline">${order.history.map((entry) => `<li><strong>${escapeHtml(entry.toStatus)}</strong><span>${escapeHtml(entry.reasonCode)} · ${escapeHtml(formatDate(entry.occurredAt))}</span></li>`).join("")}</ol>`}</section>`;
const detailRow = (label: string, value: string): string =>
  `<dl><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></dl>`;
const errorContent = (message: string): string =>
  `<div class="notice notice-error"><strong>KeyRaNo Admin</strong><p>${escapeHtml(message)}</p></div>`;
const requiredSecret = (value: string | undefined): string => {
  if (!value) throw new Error("Admin CSRF secret unavailable");
  return value;
};
