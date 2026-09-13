import type {
  AdminAuthenticationService,
  AdminPasswordLoginPort,
  AdminPasswordResetPort,
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
  AdminOperationsService,
  AdminCustomerSummary,
  AdminSupplierSummary,
  AdminSupportCaseSummary,
  AdminFraudReviewSummary,
  AdminOperationsControlSummary,
  AdminFinanceCurrencySummary,
  AdminOperationsListResult,
  AdminCustomerListResult,
  AdminProductDetail,
  AdminProductListResult,
  AdminNotificationItem,
  OperationsControlReasonCode,
  OperatorSupportCaseDetail,
  SupportCasePriority,
  SupportCaseResolutionCode,
  SupportCaseStatus,
  SupportMessageVisibility,
} from "../../packages/platform/src/contracts.js";
import {
  AdminAccessError,
  adminCapabilities,
  adminProductLifecycleValues,
  adminProductPlatformValues,
  adminRoles,
  createAdminCsrf,
  hasAdminCapability,
  newAdminCorrelationId,
  verifyAdminCsrf,
  orderId,
  operationsCapabilities,
  productTypes,
} from "../../packages/platform/src/contracts.js";
import type { StagingDelayedFulfillmentPort } from "../storefront/staging-delayed-fulfillment.js";
import {
  adminAuditCodeLabel,
  adminAuditEventTypeLabel,
  adminAuditOutcomeLabel,
  adminCapabilityLabel,
  adminEntityTypeLabel,
  adminOrderStatuses,
  adminProductLifecycleLabel,
  adminProductPlatformLabel,
  adminProductTypeLabel,
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
    private readonly passwordAuthentication: AdminPasswordLoginPort,
    private readonly passwordReset: AdminPasswordResetPort,
    private readonly orders: AdminOrderService,
    private readonly staff: AdminStaffService,
    private readonly config: AdminHttpConfig,
    private readonly delayedFulfillment?: StagingDelayedFulfillmentPort,
    private readonly operations?: AdminOperationsService,
  ) {}

  public async handle(request: AdminHttpRequest): Promise<AdminHttpResponse> {
    try {
      if (request.path === "/admin/login")
        return await this.handleLogin(request);
      if (request.path === "/admin/password-reset")
        return await this.handlePasswordResetRequest(request);
      const passwordResetMatch =
        /^\/admin\/password-reset\/([A-Za-z0-9_-]{1,128})$/u.exec(request.path);
      if (passwordResetMatch?.[1])
        return await this.handlePasswordReset(request, passwordResetMatch[1]);
      if (request.path === "/admin/recovery")
        return await this.handleRecovery(request);
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
      if (request.method === "GET" && request.path === "/admin/customers")
        return await this.customerList(principal, request);
      if (request.method === "GET" && request.path === "/admin/catalog")
        return await this.productList(principal, request);
      if (request.method === "GET" && request.path === "/admin/suppliers")
        return await this.supplierList(principal, request);
      if (request.method === "GET" && request.path === "/admin/discounts")
        return this.discounts(principal);
      if (request.method === "GET" && request.path === "/admin/support")
        return await this.supportList(principal, request);
      if (request.method === "GET" && request.path === "/admin/fraud")
        return await this.fraudList(principal, request);
      if (request.method === "GET" && request.path === "/admin/finance")
        return await this.finance(principal);
      if (request.method === "GET" && request.path === "/admin/reports")
        return await this.reports(principal);
      if (request.method === "GET" && request.path === "/admin/settings")
        return await this.settings(principal);
      if (request.method === "GET" && request.path === "/admin/notifications")
        return await this.notifications(principal);
      const customerDetailMatch =
        /^\/admin\/customers\/([0-9a-f-]{36})$/iu.exec(request.path);
      if (request.method === "GET" && customerDetailMatch?.[1])
        return await this.customerDetail(principal, customerDetailMatch[1]);
      const productDetailMatch = /^\/admin\/catalog\/([0-9a-f-]{36})$/iu.exec(
        request.path,
      );
      if (request.method === "GET" && productDetailMatch?.[1])
        return await this.productDetail(
          principal,
          productDetailMatch[1],
          request.query,
        );
      const controlMatch = /^\/admin\/settings\/controls\/([A-Z_]+)$/u.exec(
        request.path,
      );
      if (controlMatch?.[1]) {
        if (request.method !== "POST")
          return this.render(
            405,
            errorContent("Anfrage nicht verfügbar."),
            principal,
            { Allow: "POST" },
          );
        return await this.changeOperationsControl(
          principal,
          controlMatch[1],
          request,
        );
      }
      if (request.method === "GET" && request.path === "/admin/staff")
        return await this.staffList(principal);
      if (request.path === "/admin/staff" && request.method === "POST")
        return await this.createStaff(principal, request);
      if (request.method === "GET" && request.path === "/admin/audit")
        return await this.auditList(principal, request);
      const supportDetailMatch = /^\/admin\/support\/([0-9a-f-]{36})$/iu.exec(
        request.path,
      );
      if (request.method === "GET" && supportDetailMatch?.[1])
        return await this.supportDetail(principal, supportDetailMatch[1]);
      const supportMutationMatch =
        /^\/admin\/support\/([0-9a-f-]{36})\/(note|priority|status)$/iu.exec(
          request.path,
        );
      if (supportMutationMatch?.[1] && supportMutationMatch[2]) {
        if (request.method !== "POST")
          return this.render(
            405,
            errorContent("Anfrage nicht verfügbar."),
            principal,
            { Allow: "POST" },
          );
        return await this.supportMutation(
          principal,
          supportMutationMatch[1],
          supportMutationMatch[2],
          request,
        );
      }
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
        return await this.orderDetail(principal, detailMatch[1], request.query);
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
      !hasExactFields(request.form, ["email", "password"])
    )
      return this.render(400, errorContent("Anmeldung nicht möglich."));
    const result = await this.passwordAuthentication.login(
      request.form.get("email") ?? "",
      request.form.get("password") ?? "",
      newAdminCorrelationId(),
    );
    if (!result.authenticated || !result.rawSession)
      return this.render(401, errorContent("Anmeldung nicht möglich."));
    return redirect(
      "/admin/",
      sessionCookie(result.rawSession, this.config.secureCookies),
    );
  }

  private async handleRecovery(
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    if (request.method === "GET") return recoveryPage();
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

  private async handlePasswordResetRequest(
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    if (request.method === "GET") return passwordResetRequestPage();
    if (request.method !== "POST")
      return this.render(
        405,
        errorContent("Anfrage nicht verfügbar."),
        undefined,
        {
          Allow: "GET, POST",
        },
      );
    if (!this.validOrigin(request) || !hasExactFields(request.form, ["email"]))
      return this.render(400, errorContent("Anfrage nicht möglich."));
    await this.passwordReset.request(
      request.form.get("email") ?? "",
      newAdminCorrelationId(),
    );
    return passwordResetRequestedPage();
  }

  private async handlePasswordReset(
    request: AdminHttpRequest,
    rawToken: string,
  ): Promise<AdminHttpResponse> {
    if (request.method === "GET") return passwordResetFormPage(rawToken);
    if (request.method !== "POST")
      return this.render(
        405,
        errorContent("Anfrage nicht verfügbar."),
        undefined,
        {
          Allow: "GET, POST",
        },
      );
    if (
      !this.validOrigin(request) ||
      !hasExactFields(request.form, ["password", "password_confirmation"])
    )
      return this.render(400, errorContent("Anfrage nicht möglich."));
    const result = await this.passwordReset.reset(
      rawToken,
      request.form.get("password") ?? "",
      request.form.get("password_confirmation") ?? "",
      newAdminCorrelationId(),
    );
    if (result.status === "PASSWORD_MISMATCH")
      return passwordResetFormPage(
        rawToken,
        "Die Passwörter stimmen nicht überein.",
        400,
      );
    if (result.status === "PASSWORD_INVALID")
      return passwordResetFormPage(
        rawToken,
        "Das Passwort muss zwischen 12 und 256 Zeichen lang sein.",
        400,
      );
    if (result.status === "INVALID_OR_EXPIRED")
      return passwordResetInvalidPage();
    return passwordResetCompletedPage();
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
        : "<li><strong>0</strong><span>Kein erfasstes Zahlungsvolumen</span></li>";
    const topProducts =
      result.topProducts.length === 0
        ? emptyState(
            "Noch keine bezahlten Produkte",
            "In den letzten 30 Tagen liegen keine qualifizierenden Bestellungen vor.",
          )
        : `<ol class="top-products">${result.topProducts
            .map(
              (product) =>
                `<li>${icon("package")}<span><strong>${escapeHtml(product.productTitle)}</strong><small>Verkaufte Einheiten, letzte 30 Tage</small></span><b>${product.purchasedQuantity}</b></li>`,
            )
            .join("")}</ol>`;
    const attention = result.attentionOrders + result.failedOrders;
    return this.render(
      200,
      `
      ${pageActionBar("Übersicht", "Dein operativer Überblick über Bestellungen, Zahlungen und Handlungsbedarf.", `<span class="period-control">${icon("calendar")} Aktueller Datenstand</span><a class="button-quiet icon-button-text" href="/admin/">${icon("refresh")} Aktualisieren</a>`)}
      <section class="metric-grid dashboard-metrics" aria-label="Bestellkennzahlen">
        ${metric("Bestellungen", result.totalOrders, { href: "/admin/orders", iconName: "cart", detail: "Alle Bestellungen" })}${metric("Aufmerksamkeit", result.attentionOrders, { href: "/admin/orders?view=ATTENTION", iconName: "alert", detail: "Manuelle Prüfung" })}${metric("In Bearbeitung", result.processingOrders, { href: "/admin/orders?view=PROCESSING", iconName: "clock", detail: "Aktive Abwicklung" })}${metric("Fehlgeschlagen", result.failedOrders, { href: "/admin/orders?view=FAILED", iconName: "failure", detail: "Fehlgeschlagene Vorgänge" })}
      </section>
      <div class="dashboard-overview-grid">
        <section class="content-section service-panel"><div class="section-heading"><h2>Serverstatus</h2><span>Aktueller Request</span></div><ul class="service-list"><li>${icon("server")}<span>Admin-Anwendung</span><strong>Online</strong></li><li>${icon("database")}<span>PostgreSQL</span><strong>Online</strong></li></ul><p class="module-note">Weitere Dienste werden hier nicht ohne aktuellen Health-Check bewertet.</p></section>
        <section class="content-section chart-panel"><div class="section-heading"><h2>Erfasstes Zahlungsvolumen</h2><span>Autoritative Gesamtsicht</span></div><ul class="revenue-list">${revenue}</ul>${honestChartState("Ein eindeutiger historischer Capture-Zeitpunkt ist noch nicht für alle Zahlungszustände verfügbar.")}</section>
        <section class="content-section top-products-panel"><div class="section-heading"><h2>Top-Produkte</h2><span>30 Tage</span></div>${topProducts}</section>
      </div>
      <section class="content-section order-status-panel"><div class="section-heading"><h2>Operative Bestellzustände</h2><span>Gleiche Definition wie Schnellfilter</span></div><div class="status-overview"><a href="/admin/orders"><strong>${result.totalOrders}</strong><span>Bestellungen gesamt</span></a><a href="/admin/orders?view=PROCESSING"><strong>${result.processingOrders}</strong><span>${icon("clock")} In Bearbeitung</span></a><a href="/admin/orders?view=ATTENTION"><strong>${result.attentionOrders}</strong><span>${icon("alert")} Aufmerksamkeit</span></a><a href="/admin/orders?view=FAILED"><strong>${result.failedOrders}</strong><span>${icon("failure")} Fehlgeschlagen</span></a></div></section>
      <div class="dashboard-lower-grid">
        <section class="content-section dashboard-action-panel"><div class="section-heading"><h2>Handlungsbedarf</h2><a href="/admin/notifications">Alle anzeigen</a></div>${attention === 0 ? emptyState("Kein aktueller Handlungsbedarf", "Es liegen keine risikobedingten oder fehlgeschlagenen Bestellungen vor.") : `<ul class="action-list">${result.attentionOrders > 0 ? `<li>${icon("alert")}<span><strong>Manuelle Prüfung</strong><small>${result.attentionOrders} Bestellung(en) benötigen Aufmerksamkeit.</small></span><a href="/admin/orders?view=ATTENTION">Öffnen ${icon("arrow")}</a></li>` : ""}${result.failedOrders > 0 ? `<li>${icon("failure")}<span><strong>Fehlgeschlagene Bestellungen</strong><small>${result.failedOrders} Vorgang/Vorgänge sind terminal fehlgeschlagen.</small></span><a href="/admin/orders?view=FAILED">Öffnen ${icon("arrow")}</a></li>` : ""}</ul>`}</section>
        <section class="content-section quick-access-panel"><div class="section-heading"><h2>Schnellzugriff</h2></div>${dashboardQuickLinks(principal)}</section>
      </div>
      <section class="content-section orders-section recent-orders"><div class="section-heading"><h2>Letzte Bestellungen</h2><a href="/admin/orders">Alle anzeigen</a></div>${recentOrdersTable(result.recentOrders)}</section>
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
      "reference",
      "customer_id",
      "customer",
      "status",
      "payment",
      "risk",
      "procurement",
      "fulfillment",
      "from",
      "to",
      "cursor",
      "direction",
      "limit",
      "sort",
      "view",
      "panel",
    ]);
    const panel = optional(request.query, "panel");
    if (panel && panel !== "filters" && panel !== "closed") {
      throw new AdminAccessError("ADMIN_INPUT_INVALID");
    }
    const result = await this.orders.list(
      principal,
      compactQuery(request.query),
      newAdminCorrelationId(),
    );
    return this.render(
      200,
      `
      ${pageActionBar("Bestellungen", "Alle Bestellungen und ihre operativen Zustände im Überblick.", orderActionBar(request.query))}
      ${orderMetrics(result, request.query)}
      ${orderViewNotice(request.query.get("view"))}
      ${activeOrderFilters(request.query)}
      ${orderFilterPanel(request.query)}
      <section class="content-section orders-section flush"><div class="section-heading"><div><h2>Bestellungen</h2><span>${result.totalCount} Ergebnis${result.totalCount === 1 ? "" : "se"}</span></div>${orderResultControls(request.query, result)}</div>${orderStatusLegend()}${ordersTable(result.orders, request.query)}${pagination(result, request.query)}</section>
    `,
      principal,
    );
  }

  private async orderDetail(
    principal: AdminPrincipal,
    targetOrderId: string,
    query: URLSearchParams,
  ): Promise<AdminHttpResponse> {
    rejectDuplicateParameters(query, ["return"]);
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
        hasAdminCapability(principal, "SUPPLIER_VIEW"),
        safeOrderReturnPath(query.get("return")),
      ),
      principal,
    );
  }

  private async customerList(
    principal: AdminPrincipal,
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    const operations = this.requireOperations();
    const result = await operations.listCustomers(
      principal,
      customerListQuery(request.query),
      newAdminCorrelationId(),
    );
    return this.render(
      200,
      customerListContent(result, request.query),
      principal,
    );
  }

  private async productList(
    principal: AdminPrincipal,
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    const operations = this.requireOperations();
    const result = await operations.listProducts(
      principal,
      productListQuery(request.query),
      newAdminCorrelationId(),
    );
    return this.render(
      200,
      productListContent(result, request.query),
      principal,
    );
  }

  private async productDetail(
    principal: AdminPrincipal,
    productId: string,
    query: URLSearchParams,
  ): Promise<AdminHttpResponse> {
    rejectDuplicateParameters(query, ["return"]);
    const product = await this.requireOperations().productDetail(
      principal,
      productId,
      newAdminCorrelationId(),
    );
    if (!product) throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    return this.render(
      200,
      productDetailContent(product, safeProductReturnPath(query.get("return"))),
      principal,
    );
  }

  private async customerDetail(
    principal: AdminPrincipal,
    customerId: string,
  ): Promise<AdminHttpResponse> {
    const customer = await this.requireOperations().customerDetail(
      principal,
      customerId,
      newAdminCorrelationId(),
    );
    if (!customer) throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    const orders = await this.orders.list(
      principal,
      { customerId: customer.customerId, limit: 10 },
      newAdminCorrelationId(),
    );
    return this.render(200, customerDetailContent(customer, orders), principal);
  }

  private async supplierList(
    principal: AdminPrincipal,
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    const operations = this.requireOperations();
    const result = await operations.listSuppliers(
      principal,
      listQuery(request.query),
      newAdminCorrelationId(),
    );
    return this.render(
      200,
      supplierListContent(result, request.query),
      principal,
    );
  }

  private discounts(principal: AdminPrincipal): AdminHttpResponse {
    if (!hasAdminCapability(principal, "CATALOG_VIEW"))
      throw new AdminAccessError("ADMIN_ACCESS_DENIED");
    return this.render(200, discountsContent(), principal);
  }

  private async supportList(
    principal: AdminPrincipal,
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    const operations = this.requireOperations();
    const result = await operations.listSupportCases(
      principal,
      listQuery(request.query),
      newAdminCorrelationId(),
    );
    return this.render(
      200,
      supportListContent(result, request.query),
      principal,
    );
  }

  private async supportDetail(
    principal: AdminPrincipal,
    caseId: string,
  ): Promise<AdminHttpResponse> {
    const detail = await this.requireOperations().supportDetail(
      principal,
      caseId,
    );
    return this.render(
      200,
      supportDetailContent(detail, principal, (action) => {
        const path = `/admin/support/${caseId}/${action}`;
        return {
          csrf: createAdminCsrf(
            principal,
            "POST",
            path,
            this.config.csrfSecret,
          ),
          path,
        };
      }),
      principal,
    );
  }

  private async supportMutation(
    principal: AdminPrincipal,
    caseId: string,
    action: string,
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    const path = `/admin/support/${caseId}/${action}`;
    const common = ["csrf", "expected_version"];
    const expectedFields =
      action === "note"
        ? ["csrf", "message", "visibility"]
        : action === "priority"
          ? [...common, "priority"]
          : [...common, "next_status", "resolution_code"];
    if (!this.validSensitivePost(request, principal, path, expectedFields))
      return this.render(
        403,
        errorContent("Anfrage nicht verfügbar."),
        principal,
      );
    const operations = this.requireOperations();
    const correlationId = newAdminCorrelationId();
    const expectedVersion = Number(request.form.get("expected_version"));
    const result =
      action === "note"
        ? await operations.addSupportNote(principal, {
            caseId,
            correlationId,
            message: request.form.get("message") ?? "",
            visibility: (request.form.get("visibility") ??
              "") as SupportMessageVisibility,
          })
        : action === "priority"
          ? await operations.changeSupportPriority(principal, {
              caseId,
              correlationId,
              expectedVersion,
              priority: (request.form.get("priority") ??
                "") as SupportCasePriority,
            })
          : await operations.transitionSupportCase(principal, {
              caseId,
              correlationId,
              expectedVersion,
              nextStatus: (request.form.get("next_status") ??
                "") as SupportCaseStatus,
              resolutionCode:
                request.form.get("resolution_code") === ""
                  ? null
                  : (request.form.get(
                      "resolution_code",
                    ) as SupportCaseResolutionCode),
            });
    if (result.status === "FAILED")
      return this.render(
        result.code === "STALE_VERSION" ? 409 : 400,
        `<header class="page-heading"><p>Supportfall</p><h1>Änderung nicht möglich</h1></header><div class="notice notice-warning"><strong>Sicherer Zustand beibehalten</strong><p>Der Supportfall wurde nicht geändert. Lade den Fall neu und prüfe seinen aktuellen Zustand.</p></div><p><a href="/admin/support/${encodeURIComponent(caseId)}">Zurück zum Supportfall</a></p>`,
        principal,
      );
    return locationRedirect(`/admin/support/${caseId}`);
  }

  private async fraudList(
    principal: AdminPrincipal,
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    const operations = this.requireOperations();
    const result = await operations.listFraudReviews(
      principal,
      listQuery(request.query),
      newAdminCorrelationId(),
    );
    return this.render(200, fraudListContent(result, request.query), principal);
  }

  private async finance(principal: AdminPrincipal): Promise<AdminHttpResponse> {
    const result = await this.requireOperations().finance(
      principal,
      newAdminCorrelationId(),
    );
    return this.render(200, financeContent(result, false), principal);
  }

  private async reports(principal: AdminPrincipal): Promise<AdminHttpResponse> {
    const result = await this.requireOperations().reports(
      principal,
      newAdminCorrelationId(),
    );
    return this.render(200, financeContent(result, true), principal);
  }

  private async settings(
    principal: AdminPrincipal,
  ): Promise<AdminHttpResponse> {
    const result = await this.requireOperations().controls(
      principal,
      newAdminCorrelationId(),
    );
    return this.render(
      200,
      settingsContent(result, principal, (capability) => {
        const path = `/admin/settings/controls/${capability}`;
        return {
          csrf: createAdminCsrf(
            principal,
            "POST",
            path,
            this.config.csrfSecret,
          ),
          path,
        };
      }),
      principal,
    );
  }

  private async notifications(
    principal: AdminPrincipal,
  ): Promise<AdminHttpResponse> {
    const result = await this.requireOperations().notifications(
      principal,
      newAdminCorrelationId(),
    );
    return this.render(200, notificationsContent(result), principal);
  }

  private async changeOperationsControl(
    principal: AdminPrincipal,
    rawCapability: string,
    request: AdminHttpRequest,
  ): Promise<AdminHttpResponse> {
    const capability = operationsCapabilities.find(
      (candidate) => candidate === rawCapability,
    );
    const path = `/admin/settings/controls/${rawCapability}`;
    const fields = [
      "capability",
      "confirm",
      "csrf",
      "desired_state",
      "expected_version",
      "operation_id",
      "reason_code",
    ];
    if (
      !capability ||
      request.form.get("capability") !== capability ||
      request.form.get("confirm") !== "CHANGE_OPERATIONS_CONTROL" ||
      !this.validSensitivePost(request, principal, path, fields)
    )
      return this.render(
        403,
        errorContent("Anfrage nicht verfügbar."),
        principal,
      );
    const desiredState = request.form.get("desired_state");
    const expectedVersion = Number(request.form.get("expected_version"));
    if (
      (desiredState !== "PAUSED" && desiredState !== "ENABLED") ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion <= 0
    )
      return this.render(
        400,
        errorContent("Änderung nicht möglich."),
        principal,
      );
    const result = await this.requireOperations().changeControl(
      principal,
      {
        capability,
        desiredState,
        expectedVersion,
        operationId: request.form.get("operation_id") ?? "",
        reasonCode:
          desiredState === "PAUSED"
            ? (request.form.get("reason_code") as OperationsControlReasonCode)
            : null,
      },
      newAdminCorrelationId(),
    );
    if (result.status === "FAILED")
      return this.render(
        result.code === "STALE_VERSION" ? 409 : 400,
        `<header class="page-heading"><p>Betriebssteuerung</p><h1>Änderung nicht möglich</h1></header><div class="notice notice-warning"><strong>Sicherer Zustand beibehalten</strong><p>Die Betriebssteuerung wurde nicht geändert. Lade die Einstellungen neu und prüfe den aktuellen Zustand.</p></div><p><a href="/admin/settings">Zurück zu Einstellungen</a></p>`,
        principal,
      );
    return this.render(
      200,
      `<header class="page-heading"><p>Betriebssteuerung</p><h1>${result.control.state === "PAUSED" ? "Funktion pausiert" : "Funktion fortgesetzt"}</h1></header><div class="notice notice-success"><strong>${escapeHtml(operationalLabel(result.control.capability))}</strong><p>Der neue Zustand wurde versionsgeschützt gespeichert und revisionssicher protokolliert.</p></div><p><a href="/admin/settings">Zurück zu Einstellungen</a></p>`,
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

  private requireOperations(): AdminOperationsService {
    if (!this.operations)
      throw new AdminAccessError("ADMIN_RESOURCE_UNAVAILABLE");
    return this.operations;
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
  body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KeyRaNo Admin</title><link rel="stylesheet" href="/admin/assets/admin.css?v=1.1.9"></head><body>${principal ? shell(content, principal, requiredSecret(csrfSecret)) : `<main class="standalone">${content}</main>`}</body></html>`,
  headers: securityHeaders(additionalHeaders),
  statusCode,
});

const loginPage = (): AdminHttpResponse =>
  page(
    200,
    `
  ${iconSprite()}<section class="login-panel"><div class="brand">${brandContent()}</div><h1>Interne Anmeldung</h1><p>Nur für autorisierte Mitarbeitende.</p><form method="post" action="/admin/login"><label for="email">E-Mail-Adresse</label><input id="email" name="email" type="email" autocomplete="username" required maxlength="254"><label for="password">Passwort</label><input id="password" name="password" type="password" autocomplete="current-password" required minlength="12" maxlength="256"><button type="submit">Anmelden</button></form><a class="login-back-link" href="/admin/password-reset">Passwort zurücksetzen</a></section>
`,
  );

const passwordResetRequestPage = (): AdminHttpResponse =>
  page(
    200,
    `${iconSprite()}<section class="login-panel"><div class="brand">${brandContent()}</div><h1>Passwort zurücksetzen</h1><p>Fordern Sie einen einmaligen Link für Ihr Admin-Konto an.</p><form method="post" action="/admin/password-reset"><label for="email">E-Mail-Adresse</label><input id="email" name="email" type="email" autocomplete="username" required maxlength="254"><button type="submit">Link zum Zurücksetzen senden</button></form><a class="login-back-link" href="/admin/login">Zur Anmeldung</a></section>`,
  );

const passwordResetRequestedPage = (): AdminHttpResponse =>
  page(
    200,
    `${iconSprite()}<section class="login-panel"><div class="brand">${brandContent()}</div><h1>Anfrage erhalten</h1><p>Falls für diese E-Mail-Adresse ein aktives Admin-Konto existiert, wurde eine E-Mail zum Zurücksetzen des Passworts versendet.</p><a class="login-back-link" href="/admin/login">Zur Anmeldung</a></section>`,
  );

const passwordResetFormPage = (
  rawToken: string,
  error?: string,
  statusCode = 200,
): AdminHttpResponse =>
  page(
    statusCode,
    `${iconSprite()}<section class="login-panel"><div class="brand">${brandContent()}</div><h1>Neues Passwort</h1><p>Das neue Passwort muss mindestens 12 Zeichen lang sein.</p>${error ? `<div class="form-error" role="alert">${escapeHtml(error)}</div>` : ""}<form method="post" action="/admin/password-reset/${encodeURIComponent(rawToken)}"><label for="password">Neues Passwort</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="256"><label for="password_confirmation">Passwort bestätigen</label><input id="password_confirmation" name="password_confirmation" type="password" autocomplete="new-password" required minlength="12" maxlength="256"><button type="submit">Passwort ändern</button></form></section>`,
  );

const passwordResetInvalidPage = (): AdminHttpResponse =>
  page(
    400,
    `${iconSprite()}<section class="login-panel"><div class="brand">${brandContent()}</div><h1>Link nicht gültig</h1><p>Dieser Link ist nicht mehr gültig. Bitte fordern Sie einen neuen Link zum Zurücksetzen an.</p><a class="login-back-link" href="/admin/password-reset">Neuen Link anfordern</a></section>`,
  );

const passwordResetCompletedPage = (): AdminHttpResponse =>
  page(
    200,
    `${iconSprite()}<section class="login-panel"><div class="brand">${brandContent()}</div><h1>Passwort erfolgreich geändert</h1><p>Sie können sich jetzt mit Ihrem neuen Passwort anmelden.</p><a class="login-back-link" href="/admin/login">Zur Anmeldung</a></section>`,
  );

const recoveryPage = (): AdminHttpResponse =>
  page(
    200,
    `
  ${iconSprite()}<section class="login-panel"><div class="brand">${brandContent()}</div><h1>Wiederherstellungszugang</h1><p>Nur für kontrollierte Initialisierung und Wiederherstellung.</p><form method="post" action="/admin/recovery"><label for="session_code">Sicherer Zugangscode</label><input id="session_code" name="session_code" type="password" autocomplete="off" required minlength="32" maxlength="512"><button type="submit">Wiederherstellen</button></form><a class="login-back-link" href="/admin/login">Zur normalen Anmeldung</a></section>
`,
  );

const shell = (
  content: string,
  principal: AdminPrincipal,
  csrfSecret: string,
): string => {
  const csrf = createAdminCsrf(principal, "POST", "/admin/logout", csrfSecret);
  const currentSection = currentAdminSection(content);
  const link = (
    capability: AdminCapability,
    path: string,
    label: string,
    iconName: AdminIconName,
  ): string =>
    hasAdminCapability(principal, capability)
      ? navigationLink(path, label, iconName, currentSection === path)
      : "";
  return `${iconSprite()}<div class="admin-shell"><aside class="admin-sidebar"><a class="brand" href="/admin/" aria-label="KeyRaNo Admin Übersicht">${brandContent()}</a><nav aria-label="Admin-Navigation">${navigationLink("/admin/", "Übersicht", "home", currentSection === "/admin/")}${link("ORDER_VIEW", "/admin/orders", "Bestellungen", "cart")}${link("CUSTOMER_VIEW", "/admin/customers", "Kunden", "users")}${link("CATALOG_VIEW", "/admin/catalog", "Produkte / Katalog", "package")}${link("SUPPLIER_VIEW", "/admin/suppliers", "Lieferanten", "truck")}${link("CATALOG_VIEW", "/admin/discounts", "Rabatte &amp; Kampagnen", "tag")}${link("SUPPORT_VIEW", "/admin/support", "Support", "headset")}${link("FRAUD_REVIEW_VIEW", "/admin/fraud", "Betrugsprüfung", "shield")}${link("FINANCE_VIEW", "/admin/finance", "Finanzen", "euro")}${link("REPORT_VIEW", "/admin/reports", "Berichte &amp; Statistiken", "chart")}${hasAdminCapability(principal, "STAFF_VIEW") ? navigationLink("/admin/staff", "Mitarbeiter &amp; Rollen", "users", currentSection === "/admin/staff") : ""}${hasAdminCapability(principal, "AUDIT_VIEW") ? navigationLink("/admin/audit", "Audit-Protokoll", "file", currentSection === "/admin/audit") : ""}${link("OPERATIONS_CONTROL_VIEW", "/admin/settings", "Einstellungen", "settings")}</nav><div class="identity"><div class="identity-summary"><span class="avatar-icon">${icon("user")}</span><span><strong>${escapeHtml(principal.displayName)}</strong><small>${escapeHtml(principal.roles.map(adminRoleLabel).join(", "))}</small></span></div><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">${icon("logout")} Abmelden</button></form></div></aside><main><header class="admin-toolbar"><span class="environment-badge">STAGING</span><a class="notification-link" href="/admin/notifications"${currentSection === "/admin/notifications" ? ' aria-current="page"' : ""}>${icon("bell")}<span>Benachrichtigungen</span></a><div class="toolbar-identity"><span class="avatar-icon">${icon("user")}</span><span><strong>${escapeHtml(principal.displayName)}</strong><small>${escapeHtml(principal.roles.map(adminRoleLabel).join(", "))}</small></span></div></header>${content}</main></div>`;
};

type AdminIconName =
  | "alert"
  | "arrow"
  | "bell"
  | "brand"
  | "calendar"
  | "cart"
  | "chart"
  | "clock"
  | "database"
  | "euro"
  | "failure"
  | "filter"
  | "file"
  | "headset"
  | "home"
  | "logout"
  | "package"
  | "refresh"
  | "search"
  | "server"
  | "settings"
  | "shield"
  | "tag"
  | "truck"
  | "user"
  | "user-plus"
  | "users";

const icon = (name: AdminIconName): string =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#icon-${name}"></use></svg>`;

const iconSprite = (): string => `<svg class="icon-sprite" aria-hidden="true">
  <symbol id="icon-brand" viewBox="0 0 24 24"><path d="M12 2 20 6.5v11L12 22l-8-4.5v-11L12 2Z"/><circle cx="12" cy="10" r="2.4"/><path d="M12 12.5V17"/></symbol>
  <symbol id="icon-home" viewBox="0 0 24 24"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></symbol>
  <symbol id="icon-cart" viewBox="0 0 24 24"><path d="M3 4h2l2.2 10h10.9l2-7H6"/><circle cx="9" cy="19" r="1.5"/><circle cx="18" cy="19" r="1.5"/></symbol>
  <symbol id="icon-users" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2M16 5a3 3 0 0 1 0 6M17 13a5 5 0 0 1 4 5v2"/></symbol>
  <symbol id="icon-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></symbol>
  <symbol id="icon-user-plus" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2M17 8v6M14 11h6"/></symbol>
  <symbol id="icon-package" viewBox="0 0 24 24"><path d="m4 7 8-4 8 4-8 4-8-4Z"/><path d="M4 7v10l8 4 8-4V7M12 11v10"/></symbol>
  <symbol id="icon-truck" viewBox="0 0 24 24"><path d="M3 6h11v11H3zM14 10h4l3 3v4h-7z"/><circle cx="7" cy="19" r="2"/><circle cx="18" cy="19" r="2"/></symbol>
  <symbol id="icon-tag" viewBox="0 0 24 24"><path d="M3 12V4h8l10 10-7 7L3 12Z"/><circle cx="8" cy="8" r="1.5"/></symbol>
  <symbol id="icon-headset" viewBox="0 0 24 24"><path d="M4 14v-2a8 8 0 0 1 16 0v2M4 14h4v6H6a2 2 0 0 1-2-2v-4ZM20 14h-4v6h2a2 2 0 0 0 2-2v-4ZM16 20c0 1-1 2-3 2"/></symbol>
  <symbol id="icon-shield" viewBox="0 0 24 24"><path d="M12 3 20 6v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-3Z"/><path d="M12 8v5M12 17h.01"/></symbol>
  <symbol id="icon-euro" viewBox="0 0 24 24"><path d="M18 6a7 7 0 1 0 0 12M4 10h10M4 14h10"/></symbol>
  <symbol id="icon-chart" viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></symbol>
  <symbol id="icon-file" viewBox="0 0 24 24"><path d="M6 2h8l4 4v16H6zM14 2v5h5M9 12h6M9 16h6"/></symbol>
  <symbol id="icon-settings" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.5 1A7 7 0 0 0 14.7 6L14.4 3h-4.8l-.4 3A7 7 0 0 0 7.6 7L5 6.1 3 9.5 5.1 11a7 7 0 0 0 0 2L3 14.5 5 18l2.6-1a7 7 0 0 0 1.6 1l.4 3h4.8l.3-3a7 7 0 0 0 1.7-1l2.5 1 2-3.5-2-1.5c.1-.3.1-.7.1-1Z"/></symbol>
  <symbol id="icon-logout" viewBox="0 0 24 24"><path d="M10 4H4v16h6M14 8l4 4-4 4M8 12h10"/></symbol>
  <symbol id="icon-bell" viewBox="0 0 24 24"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/></symbol>
  <symbol id="icon-refresh" viewBox="0 0 24 24"><path d="M20 7V3l-2 2a9 9 0 1 0 2 10M20 3h-4"/></symbol>
  <symbol id="icon-calendar" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></symbol>
  <symbol id="icon-alert" viewBox="0 0 24 24"><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 18h.01"/></symbol>
  <symbol id="icon-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/></symbol>
  <symbol id="icon-failure" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></symbol>
  <symbol id="icon-filter" viewBox="0 0 24 24"><path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z"/></symbol>
  <symbol id="icon-search" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></symbol>
  <symbol id="icon-server" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></symbol>
  <symbol id="icon-database" viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></symbol>
  <symbol id="icon-arrow" viewBox="0 0 24 24"><path d="M5 12h14M14 7l5 5-5 5"/></symbol>
</svg>`;

const brandContent = (): string =>
  `<span class="brand-mark">${icon("brand")}</span><span class="brand-copy"><strong>KeyRaNo</strong><small>Admin</small></span>`;

const navigationLink = (
  path: string,
  label: string,
  iconName: AdminIconName,
  current: boolean,
): string =>
  `<a href="${path}"${current ? ' aria-current="page"' : ""}>${icon(iconName)}<span>${label}</span></a>`;

const currentAdminSection = (content: string): string => {
  const title = /<h1>([^<]+)<\/h1>/u.exec(content)?.[1] ?? "";
  if (title === "Übersicht") return "/admin/";
  if (title.includes("Bestell")) return "/admin/orders";
  if (title.includes("Kunde")) return "/admin/customers";
  if (title.includes("Produkt") || title.includes("Katalog"))
    return "/admin/catalog";
  if (title.includes("Lieferant")) return "/admin/suppliers";
  if (title.includes("Rabatte")) return "/admin/discounts";
  if (title.includes("Support")) return "/admin/support";
  if (title.includes("Betrug")) return "/admin/fraud";
  if (title === "Finanzen") return "/admin/finance";
  if (title.includes("Berichte")) return "/admin/reports";
  if (title.includes("Mitarbeiter")) return "/admin/staff";
  if (title.includes("Audit")) return "/admin/audit";
  if (title.includes("Einstellungen")) return "/admin/settings";
  if (title.includes("Benachrichtigungen")) return "/admin/notifications";
  return "";
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

const safeOrderReturnPath = (value: string | null): string => {
  if (!value || value.length > 2048) return "/admin/orders";
  try {
    const parsed = new URL(value, "https://admin.invalid");
    if (
      parsed.origin !== "https://admin.invalid" ||
      parsed.pathname !== "/admin/orders"
    )
      return "/admin/orders";
    const allowed = new Set([...orderQueryKeys, "cursor", "direction"]);
    if ([...parsed.searchParams.keys()].some((key) => !allowed.has(key)))
      return "/admin/orders";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/admin/orders";
  }
};

const productQueryKeys = [
  "search",
  "status",
  "platform",
  "type",
  "offers",
  "availability",
  "publication",
  "view",
  "sort",
  "limit",
  "panel",
] as const;

const safeProductReturnPath = (value: string | null): string => {
  if (!value || value.length > 2048) return "/admin/catalog";
  try {
    const parsed = new URL(value, "https://admin.invalid");
    if (
      parsed.origin !== "https://admin.invalid" ||
      parsed.pathname !== "/admin/catalog"
    )
      return "/admin/catalog";
    const allowed = new Set([...productQueryKeys, "cursor"]);
    if ([...parsed.searchParams.keys()].some((key) => !allowed.has(key)))
      return "/admin/catalog";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/admin/catalog";
  }
};

const compactQuery = (query: URLSearchParams) => {
  const cursor = optional(query, "cursor");
  const cursorDirection = optional(query, "direction");
  const customerEmail = optional(query, "customer");
  const customerId = optional(query, "customer_id");
  const fromDate = optional(query, "from");
  const fulfillmentStatus = optional(query, "fulfillment");
  const limitValue = optional(query, "limit");
  const paymentStatus = optional(query, "payment");
  const procurementStatus = optional(query, "procurement");
  const riskStatus = optional(query, "risk");
  const search = optional(query, "search");
  const sort = optional(query, "sort");
  const status = optional(query, "status");
  const toDate = optional(query, "to");
  const operationalView = optional(query, "view");
  const operatorReference = optional(query, "reference");
  return {
    ...(cursor ? { cursor } : {}),
    ...(cursorDirection ? { cursorDirection } : {}),
    ...(customerEmail ? { customerEmail } : {}),
    ...(customerId ? { customerId } : {}),
    ...(fromDate ? { fromDate } : {}),
    ...(fulfillmentStatus ? { fulfillmentStatus } : {}),
    ...(limitValue ? { limit: Number(limitValue) } : {}),
    ...(paymentStatus ? { paymentStatus } : {}),
    ...(procurementStatus ? { procurementStatus } : {}),
    ...(riskStatus ? { riskStatus } : {}),
    ...(search ? { search } : {}),
    ...(sort ? { sort } : {}),
    ...(status ? { status } : {}),
    ...(toDate ? { toDate } : {}),
    ...(operationalView ? { operationalView } : {}),
    ...(operatorReference ? { operatorReference } : {}),
  };
};

const listQuery = (query: URLSearchParams) => {
  rejectDuplicateParameters(query, ["search", "status", "cursor"]);
  const cursor = optional(query, "cursor");
  const search = optional(query, "search");
  const status = optional(query, "status");
  return {
    ...(cursor ? { cursor } : {}),
    ...(search ? { search } : {}),
    ...(status ? { status } : {}),
  };
};

const customerListQuery = (query: URLSearchParams) => {
  rejectDuplicateParameters(query, [
    "search",
    "status",
    "orders",
    "registered",
    "registered_from",
    "registered_to",
    "sort",
    "limit",
    "cursor",
  ]);
  const cursor = optional(query, "cursor");
  const limit = optional(query, "limit");
  const orderPresence = optional(query, "orders");
  const registrationWindow = optional(query, "registered");
  const registeredFrom = optional(query, "registered_from");
  const registeredTo = optional(query, "registered_to");
  const search = optional(query, "search");
  const sort = optional(query, "sort");
  const status = optional(query, "status");
  return {
    ...(cursor ? { cursor } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
    ...(orderPresence ? { orderPresence } : {}),
    ...(registrationWindow ? { registrationWindow } : {}),
    ...(registeredFrom ? { registeredFrom } : {}),
    ...(registeredTo ? { registeredTo } : {}),
    ...(search ? { search } : {}),
    ...(sort ? { sort } : {}),
    ...(status ? { status } : {}),
  };
};

const productListQuery = (query: URLSearchParams) => {
  rejectDuplicateParameters(query, [...productQueryKeys, "cursor"]);
  const availability = optional(query, "availability");
  const cursor = optional(query, "cursor");
  const limit = optional(query, "limit");
  const offerState = optional(query, "offers");
  const platform = optional(query, "platform");
  const publication = optional(query, "publication");
  const productType = optional(query, "type");
  const quickView = optional(query, "view");
  const search = optional(query, "search");
  const sort = optional(query, "sort");
  const status = optional(query, "status");
  return {
    ...(availability ? { availability } : {}),
    ...(cursor ? { cursor } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
    ...(offerState ? { offerState } : {}),
    ...(platform ? { platform } : {}),
    ...(publication ? { publication } : {}),
    ...(productType ? { productType } : {}),
    ...(quickView ? { quickView } : {}),
    ...(search ? { search } : {}),
    ...(sort ? { sort } : {}),
    ...(status ? { status } : {}),
  };
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
const formatMinor = (amountMinor: string, currency: string): string => {
  const amount = BigInt(amountMinor);
  const sign = amount < 0n ? "-" : "";
  const absolute = amount < 0n ? -amount : amount;
  const major = absolute / 100n;
  const minor = (absolute % 100n).toString().padStart(2, "0");
  return `${sign}${major.toLocaleString("de-DE")},${minor} ${currency}`;
};
const formatDate = (date: Date): string =>
  new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(date);
const formatDateOnly = (date: Date): string =>
  new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeZone: "Europe/Berlin",
  }).format(date);
const shortIdentifier = (value: string): string =>
  value.length > 13 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
const metric = (
  label: string,
  value: string | number,
  options: {
    readonly detail?: string;
    readonly href?: string;
    readonly icon?: string;
    readonly iconName?: AdminIconName;
    readonly selected?: boolean;
  } = {},
): string => {
  const content = `<span class="metric-icon" aria-hidden="true">${options.iconName ? icon(options.iconName) : escapeHtml(options.icon ?? label.slice(0, 2).toUpperCase())}</span><span class="metric-copy"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong>${options.detail ? `<small>${escapeHtml(options.detail)}</small>` : ""}</span>`;
  return options.href
    ? `<a class="metric-card" href="${escapeHtml(options.href)}"${options.selected ? ' aria-current="true"' : ""}>${content}</a>`
    : `<article class="metric-card">${content}</article>`;
};

const pageActionBar = (
  title: string,
  description: string,
  actions = "",
): string =>
  `<header class="page-action-bar"><div class="page-heading"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${actions ? `<div class="page-actions">${actions}</div>` : ""}</header>`;

const honestChartState = (message: string): string =>
  `<div class="availability-panel"><h3>Auswertung begrenzt</h3><p>${escapeHtml(message)}</p></div>`;

const dashboardQuickLinks = (principal: AdminPrincipal): string => {
  const links: string[] = [];
  if (hasAdminCapability(principal, "ORDER_VIEW"))
    links.push(navigationLink("/admin/orders", "Bestellungen", "cart", false));
  if (hasAdminCapability(principal, "SUPPORT_VIEW"))
    links.push(navigationLink("/admin/support", "Support", "headset", false));
  if (hasAdminCapability(principal, "FRAUD_REVIEW_VIEW"))
    links.push(
      navigationLink("/admin/fraud", "Betrugsprüfung", "shield", false),
    );
  links.push(
    navigationLink("/admin/notifications", "Benachrichtigungen", "bell", false),
  );
  return `<nav class="quick-links" aria-label="Dashboard-Schnellzugriff">${links.join("")}</nav>`;
};

const recentOrdersTable = (
  orders: readonly AdminOrderListResult["orders"][number][],
): string =>
  orders.length === 0
    ? emptyState(
        "Keine Bestellungen gefunden",
        "Es liegen noch keine Bestellungen für den Überblick vor.",
      )
    : `<div class="table-wrap"><table class="recent-orders-table"><thead><tr><th scope="col">Bestellung</th><th scope="col">Kunde</th><th scope="col">Produkt</th><th scope="col">Zahlung</th><th scope="col">Risiko</th><th scope="col">Abwicklung</th><th scope="col">Datum</th><th scope="col"><span class="sr-only">Aktion</span></th></tr></thead><tbody>${orders.map((order) => `<tr><td data-label="Bestellung" class="order-reference"><a href="/admin/orders/${order.orderId}" title="Technische Bestell-ID: ${escapeHtml(order.orderId)}">${escapeHtml(order.operatorReference)}</a></td><td data-label="Kunde" class="customer-reference" title="${escapeHtml(order.customerEmail ?? "Nicht verfügbar")}">${escapeHtml(order.customerEmail ?? "Nicht verfügbar")}</td><td data-label="Produkt"><span class="product-cell">${icon("package")}<span>${escapeHtml(order.productTitle)} × ${order.quantity}</span></span></td><td data-label="Zahlung"><span class="status status-${escapeHtml(order.paymentStatus.toLowerCase())}">${escapeHtml(adminStatusLabel(order.paymentStatus))}</span></td><td data-label="Risiko"><span class="status status-${escapeHtml(order.riskStatus.toLowerCase())}">${escapeHtml(adminStatusLabel(order.riskStatus))}</span></td><td data-label="Abwicklung"><span class="cell-stack"><span>${escapeHtml(adminStatusLabel(order.procurementStatus))}</span><small>${escapeHtml(adminStatusLabel(order.fulfillmentStatus))}</small></span></td><td data-label="Datum">${escapeHtml(formatDate(order.createdAt))}</td><td data-label="Aktion"><a class="row-action" href="/admin/orders/${order.orderId}" aria-label="Bestellung ${escapeHtml(order.operatorReference)} öffnen">Öffnen ${icon("arrow")}</a></td></tr>`).join("")}</tbody></table></div>`;

const orderStateIndicator = (
  tone: "blue" | "green" | "amber" | "red" | "neutral",
  label: string,
): string =>
  `<span class="order-state-indicator state-${tone}"><span class="state-dot" aria-hidden="true"></span><span>${escapeHtml(label)}</span></span>`;

const orderStatusLegend = (): string =>
  `<div class="order-status-legend" aria-label="Legende der Bestellzustände">${orderStateIndicator("blue", "Auslieferung abgeschlossen")}${orderStateIndicator("green", "Kundenabruf bestätigt")}${orderStateIndicator("amber", "Auslieferung ausstehend")}${orderStateIndicator("red", "Auslieferung fehlgeschlagen")}</div>`;

const orderDeliveryIndicators = (
  order: AdminOrderListResult["orders"][number],
): string => {
  const fulfillment =
    order.fulfillmentStatus === "SUCCEEDED"
      ? orderStateIndicator("blue", "Ausgeliefert")
      : order.fulfillmentStatus === "FAILED"
        ? orderStateIndicator("red", "Fehlgeschlagen")
        : order.fulfillmentStatus === "PENDING"
          ? orderStateIndicator("amber", "Ausstehend")
          : order.fulfillmentStatus === "MANUAL_REVIEW"
            ? orderStateIndicator("amber", "Manuelle Prüfung")
            : orderStateIndicator("neutral", "Nicht gestartet");
  const customerAccess = order.customerAccessConfirmed
    ? orderStateIndicator("green", "Kundenabruf bestätigt")
    : orderStateIndicator("neutral", "Kein Abrufnachweis");
  return `<span class="order-state-stack">${fulfillment}${customerAccess}</span>`;
};

const ordersTable = (
  orders: readonly AdminOrderListResult["orders"][number][],
  query: URLSearchParams,
): string =>
  orders.length === 0
    ? `<div class="empty-state order-empty-state">${icon("cart")}<div><strong>Keine Bestellungen gefunden</strong><p>Die aktuelle Suche oder Filterauswahl liefert keine Ergebnisse.</p><a href="/admin/orders">Alle Bestellungen anzeigen</a></div></div>`
    : `<div class="table-wrap orders-table-wrap"><table class="orders-table"><thead><tr><th scope="col">Bestellung</th><th scope="col">Kunde</th><th scope="col">Produkt</th><th scope="col">Betrag</th><th scope="col">Zahlung</th><th scope="col">Risiko</th><th scope="col">Beschaffung</th><th scope="col">Auslieferung</th><th scope="col">Status</th><th scope="col">Datum</th><th scope="col"><span class="sr-only">Aktion</span></th></tr></thead><tbody>${orders
        .map((order) => {
          const returnTo = orderHrefWithout(query, []);
          const detail = `/admin/orders/${order.orderId}?return=${encodeURIComponent(returnTo)}`;
          return `<tr><td data-label="Bestellung" class="order-reference"><a href="${escapeHtml(detail)}" title="Technische Bestell-ID: ${escapeHtml(order.orderId)}">${escapeHtml(order.operatorReference)}</a></td><td data-label="Kunde" class="customer-reference" title="${escapeHtml(order.customerEmail ?? "Nicht verfügbar")}">${escapeHtml(order.customerEmail ?? "Nicht verfügbar")}</td><td data-label="Produkt"><span class="product-cell"><span class="product-media">${icon("package")}</span><span class="cell-stack"><strong>${escapeHtml(order.productTitle)}</strong><small>${escapeHtml(adminStatusLabel(order.productPlatform))} · Menge ${order.quantity}</small></span></span></td><td data-label="Betrag" class="amount-cell">${escapeHtml(formatMinor(order.amountMinor, order.currency))}</td><td data-label="Zahlung"><span class="status status-${escapeHtml(order.paymentStatus.toLowerCase())}">${escapeHtml(adminStatusLabel(order.paymentStatus))}</span></td><td data-label="Risiko"><span class="status status-${escapeHtml(order.riskStatus.toLowerCase())}">${escapeHtml(adminStatusLabel(order.riskStatus))}</span></td><td data-label="Beschaffung"><span class="status status-${escapeHtml(order.procurementStatus.toLowerCase())}">${escapeHtml(adminStatusLabel(order.procurementStatus))}</span></td><td data-label="Auslieferung">${orderDeliveryIndicators(order)}</td><td data-label="Status"><span class="status status-${escapeHtml(order.status.toLowerCase())}">${escapeHtml(adminStatusLabel(order.status))}</span></td><td data-label="Datum" class="date-cell">${escapeHtml(formatDate(order.createdAt))}</td><td data-label="Aktion"><a class="row-action" href="${escapeHtml(detail)}" aria-label="Bestellung ${escapeHtml(order.operatorReference)} öffnen">Öffnen ${icon("arrow")}</a></td></tr>`;
        })
        .join("")}</tbody></table></div>`;

const orderQueryKeys = [
  "search",
  "reference",
  "customer_id",
  "customer",
  "status",
  "payment",
  "risk",
  "procurement",
  "fulfillment",
  "from",
  "to",
  "view",
  "limit",
  "sort",
  "panel",
] as const;

const structuredOrderFilterKeys = [
  "reference",
  "customer_id",
  "customer",
  "status",
  "payment",
  "risk",
  "procurement",
  "fulfillment",
  "from",
  "to",
] as const;

const orderQueryHasValue = (query: URLSearchParams, name: string): boolean =>
  optional(query, name) !== undefined;

const normalizedOrderQuery = (query: URLSearchParams): URLSearchParams => {
  const normalized = new URLSearchParams(query);
  const emptyNames = [...normalized.entries()]
    .filter(([, value]) => value === "")
    .map(([name]) => name);
  for (const name of emptyNames) normalized.delete(name);
  return normalized;
};

const orderFiltersActive = (query: URLSearchParams): boolean =>
  structuredOrderFilterKeys.some((name) => orderQueryHasValue(query, name));

const orderFilterExpanded = (query: URLSearchParams): boolean => {
  if (query.get("panel") === "filters") return true;
  if (query.get("panel") === "closed") return false;
  return orderFiltersActive(query);
};

const hiddenOrderQuery = (
  query: URLSearchParams,
  excluded: readonly string[],
): string =>
  orderQueryKeys
    .filter(
      (name) => !excluded.includes(name) && orderQueryHasValue(query, name),
    )
    .map(
      (name) =>
        `<input type="hidden" name="${name}" value="${escapeHtml(query.get(name) ?? "")}">`,
    )
    .join("");

const orderHrefWithout = (
  query: URLSearchParams,
  removed: readonly string[],
): string => {
  const next = normalizedOrderQuery(query);
  for (const name of [...removed, "cursor", "direction"]) next.delete(name);
  return `/admin/orders${next.toString() ? `?${next.toString()}` : ""}`;
};

const orderActionBar = (query: URLSearchParams): string => {
  const activeFilterCount = structuredOrderFilterKeys.filter((name) =>
    orderQueryHasValue(query, name),
  ).length;
  const expanded = orderFilterExpanded(query);
  const searchValue = query.get("search") ?? "";
  const filterQuery = normalizedOrderQuery(query);
  filterQuery.delete("cursor");
  filterQuery.delete("direction");
  filterQuery.set("panel", expanded ? "closed" : "filters");
  const filterHref = `/admin/orders?${filterQuery.toString()}#order-filter`;
  return `<form class="page-search order-search" method="get" action="/admin/orders">${hiddenOrderQuery(query, ["search"])}<label for="order-search">Bestellungen durchsuchen</label><span class="search-field">${icon("search")}<input id="order-search" type="search" name="search" maxlength="254" placeholder="Bestellreferenz, Bestell-ID oder Kunden-E-Mail" value="${escapeHtml(searchValue)}"></span><button class="button" type="submit">Suchen</button>${searchValue ? `<a class="search-clear" href="${escapeHtml(orderHrefWithout(query, ["search"]))}" aria-label="Suche zurücksetzen">Zurücksetzen</a>` : ""}</form><a class="button-quiet filter-trigger${activeFilterCount > 0 ? " is-active" : ""}" href="${escapeHtml(filterHref)}" role="button" aria-controls="order-filter" aria-expanded="${expanded ? "true" : "false"}">${icon("filter")} Filter${activeFilterCount > 0 ? ` <span>${activeFilterCount}</span>` : ""}</a><span class="button-disabled" aria-disabled="true" title="Ein sicherer vollständiger gefilterter Export ist noch nicht angebunden">${icon("file")} Export</span>`;
};

const orderFilterPanel = (query: URLSearchParams): string => {
  const filtersActive = orderFiltersActive(query);
  const expanded = orderFilterExpanded(query);
  const options = (name: string, values: readonly string[]): string =>
    `<option value="">Alle</option>${values.map((value) => `<option value="${value}"${query.get(name) === value ? " selected" : ""}>${escapeHtml(adminStatusLabel(value))}</option>`).join("")}`;
  const resetHref = orderHrefWithout(query, [
    "reference",
    "customer_id",
    "customer",
    "status",
    "payment",
    "risk",
    "procurement",
    "fulfillment",
    "from",
    "to",
  ]);
  return `<details class="filter-panel order-filter-panel" id="order-filter"${expanded ? " open" : ""}><summary>${icon("filter")} Filter${filtersActive ? " · aktiv" : ""}</summary><form class="order-filter-grid" method="get" action="/admin/orders">${hiddenOrderQuery(query, ["reference", "customer", "status", "payment", "risk", "procurement", "fulfillment", "from", "to"])}<label>Bestellreferenz<input type="text" name="reference" maxlength="9" pattern="KR[0-9A-Fa-f]{7}" placeholder="KR0000001" value="${escapeHtml(query.get("reference") ?? "")}"></label><label>Kunden-E-Mail<input type="email" name="customer" maxlength="254" autocomplete="off" value="${escapeHtml(query.get("customer") ?? "")}"></label><label>Bestellstatus<select name="status">${options("status", adminOrderStatuses)}</select></label><label>Zahlung<select name="payment">${options("payment", ["NOT_STARTED", "PENDING", "AUTHORIZED", "CAPTURED", "FAILED", "CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED"])}</select></label><label>Risiko<select name="risk">${options("risk", ["NOT_EVALUATED", "APPROVED", "REVIEW_REQUIRED", "REJECTED"])}</select></label><label>Beschaffung<select name="procurement">${options("procurement", ["NOT_STARTED", "PENDING", "IN_PROGRESS", "SUCCEEDED", "FAILED_RETRYABLE", "FAILED_TERMINAL", "AMBIGUOUS"])}</select></label><label>Auslieferung<select name="fulfillment">${options("fulfillment", ["NOT_STARTED", "PENDING", "SUCCEEDED", "FAILED", "MANUAL_REVIEW"])}</select></label><label>Von<input type="date" name="from" value="${escapeHtml(query.get("from") ?? "")}"></label><label>Bis<input type="date" name="to" value="${escapeHtml(query.get("to") ?? "")}"></label><div class="filter-actions"><button type="submit">Anwenden</button><a class="reset-link" href="${escapeHtml(resetHref)}">Zurücksetzen</a></div></form></details>`;
};

const orderMetrics = (
  result: AdminOrderListResult,
  query: URLSearchParams,
): string => {
  const href = (view?: string): string => {
    const next = normalizedOrderQuery(query);
    next.delete("cursor");
    next.delete("direction");
    if (view) next.set("view", view);
    else next.delete("view");
    return `/admin/orders${next.toString() ? `?${next.toString()}` : ""}`;
  };
  const selected = query.get("view");
  return `<section class="metric-grid orders-metrics" aria-label="Bestellkennzahlen">${metric("Bestellungen", result.metrics.totalOrders, { href: href(), iconName: "cart", detail: "Aktueller Filterumfang", selected: !selected })}${metric("Aufmerksamkeit", result.metrics.attentionOrders, { href: href("ATTENTION"), iconName: "alert", detail: "Manuelle Prüfung", selected: selected === "ATTENTION" })}${metric("In Bearbeitung", result.metrics.processingOrders, { href: href("PROCESSING"), iconName: "clock", detail: "Aktive Abwicklung", selected: selected === "PROCESSING" })}${metric("Fehlgeschlagen", result.metrics.failedOrders, { href: href("FAILED"), iconName: "failure", detail: "Terminale Vorgänge", selected: selected === "FAILED" })}</section>`;
};

const activeOrderFilters = (query: URLSearchParams): string => {
  const labels: Readonly<Record<string, string>> = {
    customer_id: "Kundenkonto",
    customer: "Kunden-E-Mail",
    from: "Von",
    fulfillment: "Auslieferung",
    payment: "Zahlung",
    procurement: "Beschaffung",
    risk: "Risiko",
    reference: "Bestellreferenz",
    status: "Status",
    to: "Bis",
  };
  const entries = Object.entries(labels).filter(([name]) =>
    orderQueryHasValue(query, name),
  );
  const search = optional(query, "search");
  if (entries.length === 0 && !search) return "";
  const values = [
    ...(search
      ? [`<span><strong>Suche:</strong> ${escapeHtml(search)}</span>`]
      : []),
    ...entries.map(([name, label]) => {
      const value = query.get(name) ?? "";
      const shown =
        name === "from" ||
        name === "to" ||
        name === "reference" ||
        name === "customer" ||
        name === "customer_id"
          ? value
          : adminStatusLabel(value);
      return `<span><strong>${label}:</strong> ${escapeHtml(shown)}</span>`;
    }),
  ];
  return `<div class="active-filters" aria-label="Aktive Filter">${values.join("")}<a href="/admin/orders">Alle zurücksetzen</a></div>`;
};

const orderViewNotice = (view: string | null): string => {
  const labels: Readonly<Record<string, string>> = {
    ATTENTION: "Aufmerksamkeit",
    FAILED: "Fehlgeschlagen",
    PROCESSING: "In Bearbeitung",
  };
  return view && labels[view]
    ? `<div class="notice"><strong>Aktive Schnellansicht: ${labels[view]}</strong><p>Die Bestellliste verwendet dieselbe operative Zustandsdefinition wie die Dashboard-Kennzahl. <a href="/admin/orders">Schnellansicht entfernen</a></p></div>`
    : "";
};

const pagination = (
  result: AdminOrderListResult,
  query: URLSearchParams,
): string => {
  if (!result.nextCursorValue && !result.previousCursorValue) return "";
  const link = (
    label: string,
    cursor: string | undefined,
    direction: "NEXT" | "PREVIOUS",
  ): string => {
    if (!cursor)
      return `<span class="pagination-disabled" aria-disabled="true">${label}</span>`;
    const next = new URLSearchParams(query);
    next.set("cursor", cursor);
    next.set("direction", direction);
    return `<a class="pagination" href="/admin/orders?${escapeHtml(next.toString())}">${label}</a>`;
  };
  return `<nav class="order-pagination" aria-label="Bestellseiten">${link("Zurück", result.previousCursorValue, "PREVIOUS")}<span>${result.orders.length} von ${result.totalCount} in dieser Ansicht</span>${link("Weiter", result.nextCursorValue, "NEXT")}</nav>`;
};

const orderResultControls = (
  query: URLSearchParams,
  result: AdminOrderListResult,
): string =>
  `<form class="result-controls" method="get" action="/admin/orders">${hiddenOrderQuery(query, ["limit", "sort"])}<label>Sortierung<select name="sort"><option value="NEWEST"${result.sort === "NEWEST" ? " selected" : ""}>Neueste zuerst</option><option value="OLDEST"${result.sort === "OLDEST" ? " selected" : ""}>Älteste zuerst</option></select></label><label>Pro Seite<select name="limit">${[10, 25, 50].map((value) => `<option value="${value}"${result.limit === value ? " selected" : ""}>${value}</option>`).join("")}</select></label><button class="button-quiet" type="submit">Übernehmen</button></form>`;

const operationalFilter = (
  action: string,
  query: URLSearchParams,
  placeholder: string,
  statuses: readonly string[],
): string =>
  `<form class="filter-bar compact-filter" method="get" action="${action}"><label>Suche<input type="search" name="search" maxlength="254" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(query.get("search") ?? "")}"></label><label>Status<select name="status"><option value="">Alle</option>${statuses.map((status) => `<option value="${status}"${query.get("status") === status ? " selected" : ""}>${escapeHtml(operationalLabel(status))}</option>`).join("")}</select></label><button type="submit">Filtern</button><a class="reset-link" href="${action}">Zurücksetzen</a></form>`;

const operationalPagination = <T>(
  result: AdminOperationsListResult<T>,
  query: URLSearchParams,
  path: string,
): string => {
  if (!result.nextCursorValue) return "";
  const next = new URLSearchParams(query);
  next.set("cursor", result.nextCursorValue);
  return `<a class="pagination" href="${path}?${escapeHtml(next.toString())}">Weitere Einträge</a>`;
};

const listActionBar = (
  title: string,
  description: string,
  action: string,
  query: URLSearchParams,
  placeholder: string,
  disabledAction: string,
): string =>
  pageActionBar(
    title,
    description,
    `<form class="page-search" method="get" action="${action}"><label for="${title.toLowerCase().replace(/[^a-z]+/g, "-")}-search">${escapeHtml(title)} durchsuchen</label><input id="${title.toLowerCase().replace(/[^a-z]+/g, "-")}-search" type="search" name="search" maxlength="254" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(query.get("search") ?? "")}"><button class="button" type="submit">Suchen</button></form><a class="button-quiet" href="#list-filter">Filter</a><span class="button-disabled" aria-disabled="true" title="Für diese Aktion besteht noch kein freigegebener sicherer Schreibpfad">${escapeHtml(disabledAction)}</span>`,
  );

const customerListContent = (
  result: AdminCustomerListResult,
  query: URLSearchParams,
): string => {
  const hasFilters = [
    "status",
    "orders",
    "registered",
    "registered_from",
    "registered_to",
  ].some((name) => query.has(name));
  const search = escapeHtml(query.get("search") ?? "");
  const actions = `<form class="page-search customer-search" method="get" action="/admin/customers">${customerHiddenQuery(query, ["search", "cursor"])}<label for="customer-search">Kunden durchsuchen</label><span class="search-field">${icon("search")}<input id="customer-search" type="search" name="search" maxlength="254" placeholder="E-Mail oder Kunden-ID" value="${search}"></span><button class="button" type="submit">Suchen</button>${query.has("search") ? '<a class="button-quiet search-clear" href="/admin/customers">Löschen</a>' : ""}</form>`;
  const paymentVolume = formatCustomerPaymentVolumes(
    result.metrics.capturedPaymentVolumes,
  );
  return `${pageActionBar("Kunden", "Kundenkonten, Verifizierung und Bestellbeziehungen auf einen Blick.", actions)}<section class="metric-grid customer-metrics" aria-label="Globale Kundenkennzahlen">${metric("Gesamtkunden", result.metrics.totalCustomers, { detail: "Alle registrierten Konten", href: "/admin/customers", iconName: "users", selected: !hasFilters && !query.has("search") })}${metric("Kunden mit Bestellungen", result.metrics.customersWithOrders, { detail: "Direkt zugeordnete Bestellungen", href: "/admin/customers?orders=WITH_ORDERS", iconName: "cart", selected: query.get("orders") === "WITH_ORDERS" })}${metric("Zahlungsvolumen (Kunden)", paymentVolume.value, { detail: "Beitragende Kunden anzeigen", href: "/admin/customers?orders=WITH_CAPTURED_PAYMENT", iconName: "euro", selected: query.get("orders") === "WITH_CAPTURED_PAYMENT" })}${metric("Neukunden (30 Tage)", result.metrics.newCustomersLast30Days, { detail: "Nach Registrierungszeitpunkt", href: "/admin/customers?registered=LAST_30_DAYS", iconName: "user-plus", selected: query.get("registered") === "LAST_30_DAYS" })}</section><div class="customer-verification-summary">${icon("shield")}<span><strong>${result.metrics.verifiedCustomers} E-Mail bestätigt</strong><small>Globaler Kontostand · in der Tabelle und im Filter weiterhin sichtbar</small></span><a href="/admin/customers?status=VERIFIED"${query.get("status") === "VERIFIED" ? ' aria-current="true"' : ""}>Verifizierte Kunden anzeigen</a></div>${customerFilterPanel(query, hasFilters)}${customerActiveFilters(query)}<section class="content-section operations-section customers-section flush"><div class="section-heading"><div><h2>Kundenkonten</h2><span>${result.items.length} von ${result.totalCount} in dieser Ansicht</span></div>${customerResultControls(query, result)}</div>${result.items.length === 0 ? `<div class="empty-state customer-empty-state">${icon("users")}<div><strong>Keine Kunden gefunden</strong><p>Die aktuelle Suche oder Filterauswahl liefert keine Ergebnisse.</p><a href="/admin/customers">Alle Kunden anzeigen</a></div></div>` : customerTable(result.items)}${customerPagination(result, query)}</section>`;
};

const formatCustomerPaymentVolumes = (
  volumes: AdminCustomerListResult["metrics"]["capturedPaymentVolumes"],
): { readonly value: string; readonly detail: string } => {
  if (volumes.length === 0)
    return { detail: "Direkt zugeordnet · erfasste Zahlungen", value: "0" };
  if (volumes.length === 1) {
    const volume = volumes[0];
    if (!volume)
      return { detail: "Direkt zugeordnet · erfasste Zahlungen", value: "0" };
    return {
      detail: "Direkt zugeordnet · erfasste Zahlungen",
      value: formatMinor(volume.amountMinor, volume.currency),
    };
  }
  return {
    detail: volumes
      .map((volume) => formatMinor(volume.amountMinor, volume.currency))
      .join(" · "),
    value: `${volumes.length} Währungen`,
  };
};

const customerFilterPanel = (query: URLSearchParams, open: boolean): string =>
  `<details class="filter-panel customer-filter-panel" id="list-filter"${open ? " open" : ""}><summary>${icon("filter")} Filter${open ? '<span class="filter-count">Aktiv</span>' : ""}</summary><form class="customer-filter-grid" method="get" action="/admin/customers">${customerHiddenQuery(query, ["status", "orders", "registered_from", "registered_to", "cursor"])}<label>Verifizierung<select name="status"><option value="">Alle</option><option value="VERIFIED"${query.get("status") === "VERIFIED" ? " selected" : ""}>Verifiziert</option><option value="UNVERIFIED"${query.get("status") === "UNVERIFIED" ? " selected" : ""}>Nicht verifiziert</option></select></label><label>Bestellungen<select name="orders"><option value="">Alle</option><option value="WITH_ORDERS"${query.get("orders") === "WITH_ORDERS" ? " selected" : ""}>Mit Bestellungen</option><option value="WITHOUT_ORDERS"${query.get("orders") === "WITHOUT_ORDERS" ? " selected" : ""}>Ohne Bestellungen</option><option value="WITH_CAPTURED_PAYMENT"${query.get("orders") === "WITH_CAPTURED_PAYMENT" ? " selected" : ""}>Mit erfasstem Zahlungsvolumen</option></select></label><label>Registriert von<input type="date" name="registered_from" value="${escapeHtml(query.get("registered_from") ?? "")}"></label><label>Registriert bis<input type="date" name="registered_to" value="${escapeHtml(query.get("registered_to") ?? "")}"></label><div class="filter-actions"><button type="submit">Anwenden</button><a class="reset-link" href="/admin/customers">Zurücksetzen</a></div></form></details>`;

const customerActiveFilters = (query: URLSearchParams): string => {
  const labels: Readonly<Record<string, string>> = {
    orders: "Bestellungen",
    registered: "Registrierung",
    registered_from: "Registriert von",
    registered_to: "Registriert bis",
    status: "Verifizierung",
  };
  const values = Object.entries(labels)
    .filter(([name]) => optional(query, name))
    .map(([name, label]) => {
      const raw = query.get(name) ?? "";
      const shown =
        raw === "WITH_ORDERS"
          ? "Mit Bestellungen"
          : raw === "WITHOUT_ORDERS"
            ? "Ohne Bestellungen"
            : raw === "WITH_CAPTURED_PAYMENT"
              ? "Mit erfasstem Zahlungsvolumen"
              : raw === "LAST_30_DAYS"
                ? "Letzte 30 Tage"
                : operationalLabel(raw);
      return `<span><strong>${label}:</strong> ${escapeHtml(shown)}</span>`;
    });
  if (values.length === 0) return "";
  return `<div class="active-filters" aria-label="Aktive Kundenfilter">${values.join("")}<a href="/admin/customers">Alle zurücksetzen</a></div>`;
};

const customerResultControls = (
  query: URLSearchParams,
  result: AdminCustomerListResult,
): string =>
  `<form class="result-controls" method="get" action="/admin/customers">${customerHiddenQuery(query, ["sort", "limit", "cursor"])}<label>Sortierung<select name="sort"><option value="NEWEST"${result.sort === "NEWEST" ? " selected" : ""}>Neueste zuerst</option><option value="OLDEST"${result.sort === "OLDEST" ? " selected" : ""}>Älteste zuerst</option><option value="EMAIL_ASC"${result.sort === "EMAIL_ASC" ? " selected" : ""}>E-Mail A–Z</option><option value="EMAIL_DESC"${result.sort === "EMAIL_DESC" ? " selected" : ""}>E-Mail Z–A</option></select></label><label>Pro Seite<select name="limit">${[10, 25, 50].map((value) => `<option value="${value}"${result.limit === value ? " selected" : ""}>${value}</option>`).join("")}</select></label><button class="button-quiet" type="submit">Übernehmen</button></form>`;

const customerHiddenQuery = (
  query: URLSearchParams,
  excluded: readonly string[],
): string =>
  [
    "search",
    "status",
    "orders",
    "registered",
    "registered_from",
    "registered_to",
    "sort",
    "limit",
    "cursor",
  ]
    .filter((name) => !excluded.includes(name) && optional(query, name))
    .map(
      (name) =>
        `<input type="hidden" name="${name}" value="${escapeHtml(query.get(name) ?? "")}">`,
    )
    .join("");

const customerTable = (items: readonly AdminCustomerSummary[]): string =>
  `<div class="table-wrap customers-table-wrap"><table class="operations-table customers-table"><thead><tr><th scope="col">Kunde</th><th scope="col">Verifizierung</th><th scope="col">Bestellungen</th><th scope="col">Letzte Bestellung</th><th scope="col">Registriert</th><th scope="col"><span class="sr-only">Aktion</span></th></tr></thead><tbody>${items.map((item) => `<tr><td data-label="Kunde"><span class="customer-identity"><span class="avatar">${icon("user")}</span><span class="cell-stack"><strong>${escapeHtml(item.email)}</strong><small title="Kunden-ID: ${escapeHtml(item.customerId)}">ID ${escapeHtml(shortIdentifier(item.customerId))}</small></span></span></td><td data-label="Verifizierung"><span class="status status-${item.verificationState.toLowerCase()}">${escapeHtml(operationalLabel(item.verificationState))}</span></td><td data-label="Bestellungen"><a class="customer-order-count" href="/admin/orders?customer_id=${encodeURIComponent(item.customerId)}">${item.orderCount}</a></td><td data-label="Letzte Bestellung">${item.lastOrderReference && item.lastOrderAt ? `<span class="cell-stack"><a class="order-reference" href="/admin/orders?reference=${encodeURIComponent(item.lastOrderReference)}">${escapeHtml(item.lastOrderReference)}</a><small>${escapeHtml(formatDate(item.lastOrderAt))}${item.lastOrderStatus ? ` · ${escapeHtml(adminStatusLabel(item.lastOrderStatus))}` : ""}</small></span>` : '<span class="muted-value">Keine Bestellung</span>'}</td><td data-label="Registriert" class="date-cell">${escapeHtml(formatDateOnly(item.createdAt))}</td><td data-label="Aktion"><a class="row-action" href="/admin/customers/${encodeURIComponent(item.customerId)}" aria-label="Kunde ${escapeHtml(item.email)} öffnen">Öffnen ${icon("arrow")}</a></td></tr>`).join("")}</tbody></table></div>`;

const customerPagination = (
  result: AdminCustomerListResult,
  query: URLSearchParams,
): string => {
  if (!result.nextCursorValue) return "";
  const next = new URLSearchParams(query);
  next.set("cursor", result.nextCursorValue);
  return `<nav class="customer-pagination" aria-label="Kundenseiten"><span>${result.items.length} von ${result.totalCount} geladen</span><a class="pagination" href="/admin/customers?${escapeHtml(next.toString())}">Weitere Kunden</a></nav>`;
};

const customerDetailContent = (
  customer: AdminCustomerSummary,
  orders: AdminOrderListResult,
): string =>
  `${pageActionBar("Kundendetail", "Kundenkonto und zugeordnete Bestellhistorie.", `<a class="button-quiet" href="/admin/customers">Zurück zu Kunden</a><a class="button" href="/admin/orders?customer_id=${encodeURIComponent(customer.customerId)}">Alle Bestellungen</a>`)}<section class="customer-detail-identity"><span class="customer-detail-avatar">${icon("user")}</span><div><span class="eyebrow">Kundenkonto</span><h2>${escapeHtml(customer.email)}</h2><p title="Technische Kunden-ID: ${escapeHtml(customer.customerId)}">Kunden-ID ${escapeHtml(customer.customerId)}</p></div><span class="status status-${customer.verificationState.toLowerCase()}">${escapeHtml(operationalLabel(customer.verificationState))}</span></section><section class="state-strip customer-state-strip" aria-label="Kundenstatus"><div><span>Verifizierung</span><strong>${escapeHtml(operationalLabel(customer.verificationState))}</strong></div><div><span>Bestellungen</span><strong>${customer.orderCount}</strong></div><div><span>Registriert</span><strong>${escapeHtml(formatDateOnly(customer.createdAt))}</strong></div><div><span>Letzte Bestellung</span><strong>${customer.lastOrderReference ? escapeHtml(customer.lastOrderReference) : "Keine"}</strong>${customer.lastOrderAt ? `<small>${escapeHtml(formatDate(customer.lastOrderAt))}</small>` : ""}</div></section><section class="content-section customer-orders-section"><div class="section-heading"><div><h2>Letzte Bestellungen</h2><span>Maximal 10 aktuelle Einträge</span></div>${customer.orderCount > 0 ? `<a href="/admin/orders?customer_id=${encodeURIComponent(customer.customerId)}">Vollständigen Bestellverlauf öffnen</a>` : ""}</div>${recentOrdersTable(orders.orders)}</section><p class="page-note">Authentifizierungsdaten, Sitzungen und Verifizierungsnachweise werden in dieser Ansicht nicht ausgegeben.</p>`;

const productListContent = (
  result: AdminProductListResult,
  query: URLSearchParams,
): string => {
  const hasFilters = [
    "status",
    "platform",
    "type",
    "offers",
    "availability",
    "publication",
  ].some((name) => optional(query, name));
  const normalized = new URLSearchParams(query);
  normalized.delete("cursor");
  const hidden = (excluded: readonly string[]) =>
    productQueryKeys
      .filter((name) => !excluded.includes(name) && optional(query, name))
      .map(
        (name) =>
          `<input type="hidden" name="${name}" value="${escapeHtml(query.get(name) ?? "")}">`,
      )
      .join("");
  const viewHref = (view?: string) => {
    return view
      ? `/admin/catalog?view=${encodeURIComponent(view)}`
      : "/admin/catalog";
  };
  const returnPath = `/admin/catalog${normalized.toString() ? `?${normalized.toString()}` : ""}`;
  const actions = `<form class="page-search product-search" method="get" action="/admin/catalog">${hidden(["search"])}<label for="product-search">Produkte durchsuchen</label><span class="search-field">${icon("search")}<input id="product-search" type="search" name="search" maxlength="254" placeholder="Produktname, Produkt-ID oder Kennung" value="${escapeHtml(query.get("search") ?? "")}"></span><button class="button" type="submit">Suchen</button>${query.has("search") ? '<a class="button-quiet search-clear" href="/admin/catalog">Löschen</a>' : ""}</form><a class="button-quiet filter-trigger${hasFilters ? " is-active" : ""}" href="/admin/catalog?${escapeHtml(new URLSearchParams([...normalized.entries()].filter(([name]) => name !== "panel").concat([["panel", query.get("panel") === "filters" ? "closed" : "filters"]])).toString())}#product-filter">${icon("filter")} Filter${hasFilters ? " <span>aktiv</span>" : ""}</a>`;
  const rows =
    result.items.length === 0
      ? `<div class="empty-state product-empty-state">${icon("package")}<div><strong>${hasFilters || query.has("search") ? "Keine Produkte gefunden" : "Noch keine Produkte im Katalog"}</strong><p>${hasFilters || query.has("search") ? "Die aktuelle Suche oder Filterauswahl liefert keine Ergebnisse." : "Es liegen noch keine autoritativen Produktdatensätze vor."}</p>${hasFilters || query.has("search") ? '<a href="/admin/catalog">Alle Produkte anzeigen</a>' : ""}</div></div>`
      : `<div class="table-wrap products-table-wrap"><table class="operations-table products-table"><thead><tr><th>Produkt</th><th>Plattform / Typ</th><th>Lebenszyklus</th><th>Angebote</th><th>Veröffentlichung</th><th>Verfügbarkeit</th><th>Aktualisiert</th><th><span class="sr-only">Aktion</span></th></tr></thead><tbody>${result.items
          .map((item) => {
            const detail = `/admin/catalog/${encodeURIComponent(item.productId)}?return=${encodeURIComponent(returnPath)}`;
            return `<tr><td data-label="Produkt"><span class="product-cell"><span class="product-media">${icon("package")}</span><span class="cell-stack"><strong>${escapeHtml(item.title)}</strong><small title="Produkt-ID: ${escapeHtml(item.productId)}">ID ${escapeHtml(shortIdentifier(item.productId))}</small></span></span></td><td data-label="Plattform / Typ"><span class="cell-stack"><strong>${escapeHtml(adminProductPlatformLabel(item.platform))}</strong><small>${escapeHtml(adminProductTypeLabel(item.productType))}</small></span></td><td data-label="Lebenszyklus"><span class="status status-${escapeHtml(item.lifecycle.toLowerCase())}">${escapeHtml(adminProductLifecycleLabel(item.lifecycle))}</span><small>${item.active ? "Aktiv" : "Inaktiv"}</small></td><td data-label="Angebote"><span class="cell-stack"><strong>${item.offerCount}</strong><small>${item.supplierCount} Lieferant${item.supplierCount === 1 ? "" : "en"}</small></span></td><td data-label="Veröffentlichung"><span class="status status-${item.publicationState.toLowerCase()}">${item.publicationState === "PUBLISHED" ? "Veröffentlicht" : "Nicht veröffentlicht"}</span></td><td data-label="Verfügbarkeit"><span class="status status-${item.availableOfferCount > 0 ? "active" : "disabled"}">${item.availableOfferCount > 0 ? `${item.availableOfferCount} lieferbar` : "Nicht lieferbar"}</span></td><td data-label="Aktualisiert">${escapeHtml(formatDate(item.updatedAt))}</td><td data-label="Aktion"><a class="row-action" href="${escapeHtml(detail)}">Öffnen ${icon("arrow")}</a></td></tr>`;
          })
          .join("")}</tbody></table></div>`;
  return `${pageActionBar("Produkte / Katalog", "Digitale Produkte und ihre operativen Katalogzustände verwalten.", actions)}<section class="metric-grid product-metrics" aria-label="Globale Produktkennzahlen">${metric("Gesamtprodukte", result.metrics.totalProducts, { href: viewHref(), iconName: "package", detail: "Alle Katalogprodukte", selected: !query.get("view") })}${metric("Aktive Produkte", result.metrics.activeProducts, { href: viewHref("ACTIVE"), iconName: "tag", detail: "Aktive Datensätze", selected: query.get("view") === "ACTIVE" })}${metric("Mit Lieferantenangebot", result.metrics.productsWithOffers, { href: viewHref("WITH_OFFERS"), iconName: "truck", detail: "Aktive Angebote", selected: query.get("view") === "WITH_OFFERS" })}${metric("Lieferbar", result.metrics.availableProducts, { href: viewHref("AVAILABLE"), iconName: "package", detail: "Verfügbares Lieferantenangebot", selected: query.get("view") === "AVAILABLE" })}</section>${productFilterPanel(query, hidden)}<section class="content-section operations-section products-section flush"><div class="section-heading"><div><h2>Katalogprodukte</h2><span>${result.items.length} von ${result.totalCount} in dieser Ansicht</span></div>${productResultControls(result, hidden)}</div>${rows}${operationalPagination(result, query, "/admin/catalog")}</section>`;
};

const productFilterPanel = (
  query: URLSearchParams,
  hidden: (excluded: readonly string[]) => string,
): string => {
  const selected = (name: string, value: string) =>
    query.get(name) === value ? " selected" : "";
  const options = (
    name: string,
    values: readonly string[],
    label: (value: string) => string,
  ) => {
    const seenValues = new Set<string>();
    const seenLabels = new Set<string>();
    return `<option value="">Alle</option>${values
      .filter((value) => {
        const display = label(value);
        if (seenValues.has(value) || seenLabels.has(display)) return false;
        seenValues.add(value);
        seenLabels.add(display);
        return true;
      })
      .map(
        (value) =>
          `<option value="${value}"${selected(name, value)}>${escapeHtml(label(value))}</option>`,
      )
      .join("")}`;
  };
  const expanded =
    query.get("panel") === "filters" ||
    [
      "status",
      "platform",
      "type",
      "offers",
      "availability",
      "publication",
    ].some((name) => optional(query, name));
  return `<details class="filter-panel product-filter-panel" id="product-filter"${expanded ? " open" : ""}><summary>${icon("filter")} Produktfilter</summary><form class="product-filter-grid" method="get" action="/admin/catalog">${hidden(["status", "platform", "type", "offers", "availability", "publication", "panel"])}<label>Lebenszyklus<select name="status">${options("status", adminProductLifecycleValues, adminProductLifecycleLabel)}</select></label><label>Plattform<select name="platform">${options("platform", adminProductPlatformValues, adminProductPlatformLabel)}</select></label><label>Produkttyp<select name="type">${options("type", productTypes, adminProductTypeLabel)}</select></label><label>Angebote<select name="offers"><option value="">Alle</option><option value="WITH_OFFERS"${selected("offers", "WITH_OFFERS")}>Mit Angebot</option><option value="WITHOUT_OFFERS"${selected("offers", "WITHOUT_OFFERS")}>Ohne Angebot</option></select></label><label>Verfügbarkeit<select name="availability"><option value="">Alle</option><option value="AVAILABLE"${selected("availability", "AVAILABLE")}>Lieferbar</option><option value="UNAVAILABLE"${selected("availability", "UNAVAILABLE")}>Nicht lieferbar</option></select></label><label>Veröffentlichung<select name="publication"><option value="">Alle</option><option value="PUBLISHED"${selected("publication", "PUBLISHED")}>Veröffentlicht</option><option value="UNPUBLISHED"${selected("publication", "UNPUBLISHED")}>Nicht veröffentlicht</option></select></label><div class="filter-actions"><button type="submit">Anwenden</button><a class="reset-link" href="/admin/catalog">Zurücksetzen</a></div></form></details>`;
};

const productResultControls = (
  result: AdminProductListResult,
  hidden: (excluded: readonly string[]) => string,
): string =>
  `<form class="result-controls" method="get" action="/admin/catalog">${hidden(["sort", "limit", "cursor"])}<label>Sortierung<select name="sort"><option value="TITLE_ASC"${result.sort === "TITLE_ASC" ? " selected" : ""}>Name A–Z</option><option value="TITLE_DESC"${result.sort === "TITLE_DESC" ? " selected" : ""}>Name Z–A</option><option value="UPDATED_DESC"${result.sort === "UPDATED_DESC" ? " selected" : ""}>Zuletzt aktualisiert</option><option value="UPDATED_ASC"${result.sort === "UPDATED_ASC" ? " selected" : ""}>Älteste Aktualisierung</option></select></label><label>Pro Seite<select name="limit">${[10, 25, 50].map((value) => `<option value="${value}"${result.limit === value ? " selected" : ""}>${value}</option>`).join("")}</select></label><button class="button-quiet" type="submit">Übernehmen</button></form>`;

const productDetailContent = (
  product: AdminProductDetail,
  returnPath: string,
): string => {
  const identifiers =
    product.identifiers.length === 0
      ? emptyState(
          "Keine Kennungen",
          "Für dieses Produkt sind keine kanonischen Kennungen hinterlegt.",
        )
      : `<div class="table-wrap"><table class="operations-table product-identifiers-table"><thead><tr><th>Typ</th><th>Kennung</th><th>Verifiziert</th></tr></thead><tbody>${product.identifiers.map((item) => `<tr><td data-label="Typ">${escapeHtml(item.type)}</td><td data-label="Kennung">${escapeHtml(item.value)}</td><td data-label="Verifiziert"><span class="status status-${item.verified ? "active" : "disabled"}">${item.verified ? "Ja" : "Nein"}</span></td></tr>`).join("")}</tbody></table></div>`;
  const offers =
    product.offers.length === 0
      ? emptyState(
          "Keine Angebote",
          "Für dieses Produkt sind keine Lieferantenangebote hinterlegt.",
        )
      : `<div class="table-wrap"><table class="operations-table product-offers-table"><thead><tr><th>Lieferant</th><th>Angebotsreferenz</th><th>Verfügbarkeit</th><th>Status</th><th>Aktualisiert</th></tr></thead><tbody>${product.offers.map((offer) => `<tr><td data-label="Lieferant">${escapeHtml(offer.supplierName)}</td><td data-label="Angebotsreferenz">${escapeHtml(offer.supplierOfferReference)}</td><td data-label="Verfügbarkeit"><span class="status status-${offer.availability.toLowerCase()}">${escapeHtml(adminProductLifecycleLabel(offer.availability))}</span></td><td data-label="Status">${offer.active ? "Aktiv" : "Inaktiv"}</td><td data-label="Aktualisiert">${escapeHtml(formatDate(offer.updatedAt))}</td></tr>`).join("")}</tbody></table></div>`;
  return `${pageActionBar("Produktdetail", "Katalogzustand, Kennungen und Lieferantenbeziehungen.", `<a class="button-quiet" href="${escapeHtml(returnPath)}">Zurück zu Produkten</a>`)}<section class="product-detail-identity"><span class="product-detail-media">${icon("package")}</span><div><span class="eyebrow">Katalogprodukt</span><h2>${escapeHtml(product.title)}</h2><p>Produkt-ID ${escapeHtml(product.productId)}</p></div><span class="status status-${product.active ? "active" : "disabled"}">${product.active ? "Aktiv" : "Inaktiv"}</span></section><section class="state-strip product-state-strip"><div><span>Lebenszyklus</span><strong>${escapeHtml(adminProductLifecycleLabel(product.lifecycle))}</strong></div><div><span>Verfügbarkeit</span><strong>${product.availableOfferCount > 0 ? `${product.availableOfferCount} lieferbar` : "Nicht lieferbar"}</strong></div><div><span>Veröffentlichung</span><strong>${product.publicationState === "PUBLISHED" ? "Veröffentlicht" : "Nicht veröffentlicht"}</strong></div><div><span>Lieferanten</span><strong>${product.supplierCount}</strong></div></section><section class="detail-grid"><article><h2>Produkt</h2>${detailRow("Plattform", adminProductPlatformLabel(product.platform))}${detailRow("Produkttyp", adminProductTypeLabel(product.productType))}${detailRow("Angelegt", formatDate(product.createdAt))}${detailRow("Aktualisiert", formatDate(product.updatedAt))}</article><article><h2>Storefront</h2>${detailRow("Status", product.publicationState === "PUBLISHED" ? "Veröffentlicht" : "Nicht veröffentlicht")}${detailRow("Veröffentlichte Ziele", product.publicationStorefronts.length > 0 ? product.publicationStorefronts.join(", ") : "Keine")}${detailRow("Aktive Angebote", String(product.offerCount))}${detailRow("Lieferbare Angebote", String(product.availableOfferCount))}</article></section><section class="content-section product-detail-section"><div class="section-heading"><h2>Kanonische Kennungen</h2><span>Maximal 25 Einträge</span></div>${identifiers}</section><section class="content-section product-detail-section"><div class="section-heading"><h2>Lieferantenangebote</h2><span>Maximal 25 Einträge</span></div>${offers}</section><p class="page-note">Provider-Geheimnisse, Rohmetadaten und Produktschlüssel werden in dieser Ansicht nicht ausgegeben.</p>`;
};

const supplierListContent = (
  result: AdminOperationsListResult<AdminSupplierSummary>,
  query: URLSearchParams,
): string =>
  `${listActionBar("Lieferanten", "Konfigurierte Beschaffungsquellen und deren sichere Betriebsmetadaten.", "/admin/suppliers", query, "Name, Code oder Lieferanten-ID", "Lieferant hinzufügen")}<section class="metric-grid" aria-label="Lieferantenkennzahlen">${metric("Lieferanten", result.items.length, { icon: "LI", detail: "Aktuelle Ergebnisse" })}${metric("Mit Produkten", result.items.filter((item) => item.productCount > 0).length, { icon: "PR", detail: "Zugeordnete Produkte" })}${metric(
    "Produkte",
    result.items.reduce((sum, item) => sum + item.productCount, 0),
    { icon: "GP", detail: "In dieser Auswahl" },
  )}${metric(
    "Aktive Angebote",
    result.items.reduce((sum, item) => sum + item.activeOfferCount, 0),
    { icon: "AA", detail: "Autoritativ verfügbar" },
  )}</section><details class="filter-panel" id="list-filter"><summary>Detailfilter</summary>${operationalFilter("/admin/suppliers", query, "Name, Code oder Lieferanten-ID", [])}</details><section class="content-section operations-section flush"><div class="section-heading"><h2>Konfigurierte Integrationen</h2><span>${result.items.length} Einträge</span></div>${result.items.length === 0 ? emptyState("Keine Lieferanten vorhanden", "Es sind keine Lieferantenintegrationen konfiguriert.") : `<div class="table-wrap"><table class="operations-table"><thead><tr><th>Lieferant</th><th>Interner Code</th><th>Produkte</th><th>Aktive Angebote</th><th>Letzte Synchronisierung</th><th>Status</th></tr></thead><tbody>${result.items.map((item) => `<tr><td data-label="Lieferant"><span class="product-cell"><span class="product-media" aria-hidden="true">${escapeHtml(item.supplierCode.slice(0, 2).toUpperCase())}</span><span class="cell-stack"><strong>${escapeHtml(item.displayName)}</strong><small>${escapeHtml(item.supplierId)}</small></span></span></td><td data-label="Interner Code">${escapeHtml(item.supplierCode)}</td><td data-label="Produkte">${item.productCount}</td><td data-label="Aktive Angebote">${item.activeOfferCount}</td><td data-label="Letzte Synchronisierung">${item.lastSyncAt ? escapeHtml(formatDate(item.lastSyncAt)) : "Nicht ausgeführt"}</td><td data-label="Status"><span class="status status-${escapeHtml((item.lastSyncStatus ?? "unknown").toLowerCase())}">${escapeHtml(operationalLabel(item.lastSyncStatus ?? "UNKNOWN"))}</span></td></tr>`).join("")}</tbody></table></div>`}${operationalPagination(result, query, "/admin/suppliers")}</section><p class="page-note">Zugangsdaten und Provider-Geheimnisse werden in diesem Bereich grundsätzlich nicht ausgegeben.</p>`;

const discountsContent = (): string =>
  `${pageActionBar("Rabatte & Kampagnen", "Rabatte, Gutscheine und Kampagnen innerhalb der freigegebenen Plattformgrenzen.", '<form class="page-search"><label for="discount-search">Rabatte durchsuchen</label><input id="discount-search" type="search" placeholder="Code, Name oder Beschreibung" disabled><span class="button-disabled" aria-disabled="true" title="Es besteht noch keine autoritative Rabatt-Domain">Rabatt erstellen</span></form>')}<section class="metric-grid" aria-label="Rabattkennzahlen">${metric("Aktive Rabatte", 0, { icon: "RA", detail: "Keine Domain angebunden" })}${metric("Geplante Kampagnen", 0, { icon: "KA", detail: "Keine Domain angebunden" })}${metric("Einlösungen", 0, { icon: "EI", detail: "Nicht verfügbar" })}</section><nav class="section-tabs" aria-label="Rabattansichten"><a href="/admin/discounts" aria-current="page">Alle</a><span aria-disabled="true">Aktiv</span><span aria-disabled="true">Geplant</span><span aria-disabled="true">Abgelaufen</span></nav><section class="content-section">${emptyState("Noch keine Rabattverwaltung verfügbar", "Das aktuelle Plattformmodell enthält keine autoritative Rabatt- oder Kampagnen-Domain. Anlage und Bearbeitung bleiben deshalb sicher deaktiviert.")}</section><p class="page-note">Es werden keine WooCommerce-Gutscheine oder erfundenen Kampagnendaten als KeyCore-Autorität dargestellt.</p>`;

const supportListContent = (
  result: AdminOperationsListResult<AdminSupportCaseSummary>,
  query: URLSearchParams,
): string =>
  `${listActionBar("Support", "Supportanfragen, Prioritäten und Kundenkommunikation sicher bearbeiten.", "/admin/support", query, "Fall-, Bestell-ID oder Kunden-E-Mail", "Ticket erstellen")}<section class="metric-grid" aria-label="Supportkennzahlen">${metric("Supportfälle", result.items.length, { icon: "SU", detail: "Aktuelle Ergebnisse" })}${metric("Offen", result.items.filter((item) => item.status === "OPEN").length, { icon: "OF", detail: "In dieser Auswahl" })}${metric("In Bearbeitung", result.items.filter((item) => item.status === "IN_PROGRESS").length, { icon: "IB", detail: "In dieser Auswahl" })}${metric("Hohe Priorität", result.items.filter((item) => item.priority === "HIGH" || item.priority === "URGENT").length, { icon: "HP", detail: "Hoch oder dringend" })}</section><details class="filter-panel" id="list-filter"${query.has("status") ? " open" : ""}><summary>Detailfilter</summary>${operationalFilter("/admin/support", query, "Fall-, Bestell-ID oder Kunden-E-Mail", ["OPEN", "IN_PROGRESS", "WAITING_FOR_CUSTOMER", "WAITING_FOR_INTERNAL", "RESOLVED", "CLOSED"])}</details><section class="content-section operations-section flush"><div class="section-heading"><h2>Supportfälle</h2><span>${result.items.length} Einträge</span></div>${result.items.length === 0 ? emptyState("Keine Supportfälle gefunden", "Es liegen für diese Auswahl keine Supportfälle vor.") : `<div class="table-wrap"><table class="operations-table"><thead><tr><th>Fall</th><th>Kunde</th><th>Bestellung</th><th>Kategorie</th><th>Priorität</th><th>Status</th><th>Aktualisiert</th></tr></thead><tbody>${result.items.map((item) => `<tr><td data-label="Fall" class="table-reference"><a href="/admin/support/${encodeURIComponent(item.caseId)}">${escapeHtml(item.caseId)}</a></td><td data-label="Kunde">${escapeHtml(item.customerEmail ?? "Nicht verfügbar")}</td><td data-label="Bestellung">${escapeHtml(item.orderId ?? "Nicht zugeordnet")}</td><td data-label="Kategorie">${escapeHtml(operationalLabel(item.category))}</td><td data-label="Priorität"><span class="status status-${item.priority.toLowerCase()}">${escapeHtml(operationalLabel(item.priority))}</span></td><td data-label="Status"><span class="status status-${item.status.toLowerCase()}">${escapeHtml(operationalLabel(item.status))}</span></td><td data-label="Aktualisiert">${escapeHtml(formatDate(item.updatedAt))}</td></tr>`).join("")}</tbody></table></div>`}${operationalPagination(result, query, "/admin/support")}</section>`;

const supportDetailContent = (
  detail: OperatorSupportCaseDetail,
  principal: AdminPrincipal,
  form: (action: "note" | "priority" | "status") => {
    readonly path: string;
    readonly csrf: string;
  },
): string => {
  const canManage = hasAdminCapability(principal, "SUPPORT_MANAGE");
  const current = detail.case;
  const transitions = supportTransitions[current.status] ?? [];
  return `${pageActionBar(`Supportfall ${current.id}`, "Kundenkommunikation, Zustand und interner Verlauf.", '<a class="button-quiet" href="/admin/support">Zurück zu Support</a>')}<section class="state-strip" aria-label="Supportfallzustand">${stateItem("Status", current.status)}${stateItem("Priorität", current.priority)}<div><span>Kategorie</span><strong>${escapeHtml(operationalLabel(current.category))}</strong></div><div><span>Quelle</span><strong>${escapeHtml(operationalLabel(current.source))}</strong></div></section><section class="detail-grid"><article><h2>Zuordnung</h2>${detailRow("Kunde", current.customerId ?? "Nicht zugeordnet")}${detailRow("Bestellung", current.orderId ?? "Nicht zugeordnet")}${detailRow("Erstellt", formatDate(current.createdAt))}${detailRow("Aktualisiert", formatDate(current.updatedAt))}${detailRow("Version", String(current.recordVersion))}</article><article><h2>Abschluss</h2>${detailRow("Ergebnis", current.resolutionCode ? operationalLabel(current.resolutionCode) : "Nicht abgeschlossen")}${detailRow("Gelöst", current.resolvedAt ? formatDate(current.resolvedAt) : "Nein")}${detailRow("Geschlossen", current.closedAt ? formatDate(current.closedAt) : "Nein")}</article></section><section class="content-section"><div class="section-heading"><h2>Nachrichtenverlauf</h2><span>${detail.messages.length} Nachrichten</span></div>${detail.messages.length === 0 ? emptyState("Keine Nachrichten", "Dieser Supportfall enthält noch keine Nachrichten.") : `<ol class="message-list">${detail.messages.map((message) => `<li class="message-${message.visibility.toLowerCase()}"><header><strong>${escapeHtml(operationalLabel(message.authorType))}</strong><span>${message.visibility === "INTERNAL" ? "Interne Notiz" : "Für Kunden sichtbar"} · ${escapeHtml(formatDate(message.createdAt))}</span></header><p>${escapeHtml(message.body)}</p></li>`).join("")}</ol>`}</section>${canManage ? supportManagementContent(current, transitions, form) : ""}<section class="content-section"><div class="section-heading"><h2>Aktivitätsverlauf</h2><span>${detail.events.length} Ereignisse</span></div>${detail.events.length === 0 ? emptyState("Keine Ereignisse", "Für diesen Fall liegt noch kein Verlauf vor.") : `<ol class="timeline">${detail.events.map((event) => `<li><strong>${escapeHtml(operationalLabel(event.eventType))}</strong><span>${escapeHtml(formatDate(event.occurredAt))}</span></li>`).join("")}</ol>`}</section>`;
};

const supportManagementContent = (
  current: OperatorSupportCaseDetail["case"],
  transitions: readonly SupportCaseStatus[],
  form: (action: "note" | "priority" | "status") => {
    readonly path: string;
    readonly csrf: string;
  },
): string => {
  const note = form("note");
  const priority = form("priority");
  const status = form("status");
  return `<section class="content-section"><div class="section-heading"><h2>Fall bearbeiten</h2><span>Jede Änderung wird protokolliert</span></div><div class="support-actions"><form method="post" action="${escapeHtml(note.path)}"><input type="hidden" name="csrf" value="${escapeHtml(note.csrf)}"><label>Nachricht<textarea name="message" maxlength="5000" required></textarea></label><label>Sichtbarkeit<select name="visibility"><option value="CUSTOMER_VISIBLE">Für Kunden sichtbar</option><option value="INTERNAL">Interne Notiz</option></select></label><button type="submit">Nachricht hinzufügen</button></form><form method="post" action="${escapeHtml(priority.path)}"><input type="hidden" name="csrf" value="${escapeHtml(priority.csrf)}"><input type="hidden" name="expected_version" value="${current.recordVersion}"><label>Priorität<select name="priority">${["LOW", "NORMAL", "HIGH", "URGENT"].map((value) => `<option value="${value}"${current.priority === value ? " selected" : ""}>${escapeHtml(operationalLabel(value))}</option>`).join("")}</select></label><button class="button-secondary" type="submit">Priorität speichern</button></form>${transitions.length === 0 ? '<p class="muted">Der geschlossene Fall kann nicht weiter verändert werden.</p>' : `<form method="post" action="${escapeHtml(status.path)}"><input type="hidden" name="csrf" value="${escapeHtml(status.csrf)}"><input type="hidden" name="expected_version" value="${current.recordVersion}"><label>Nächster Status<select name="next_status">${transitions.map((value) => `<option value="${value}">${escapeHtml(operationalLabel(value))}</option>`).join("")}</select></label><label>Abschlussgrund<select name="resolution_code"><option value="">Nicht erforderlich</option>${supportResolutionCodes.map((value) => `<option value="${value}">${escapeHtml(operationalLabel(value))}</option>`).join("")}</select></label><button class="button-secondary" type="submit">Status ändern</button></form>`}</div></section>`;
};

const supportTransitions: Readonly<
  Record<SupportCaseStatus, readonly SupportCaseStatus[]>
> = {
  CLOSED: [],
  IN_PROGRESS: [
    "WAITING_FOR_CUSTOMER",
    "WAITING_FOR_INTERNAL",
    "RESOLVED",
    "CLOSED",
  ],
  OPEN: [
    "IN_PROGRESS",
    "WAITING_FOR_CUSTOMER",
    "WAITING_FOR_INTERNAL",
    "RESOLVED",
    "CLOSED",
  ],
  RESOLVED: ["CLOSED"],
  WAITING_FOR_CUSTOMER: ["IN_PROGRESS", "RESOLVED", "CLOSED"],
  WAITING_FOR_INTERNAL: [
    "IN_PROGRESS",
    "WAITING_FOR_CUSTOMER",
    "RESOLVED",
    "CLOSED",
  ],
};

const supportResolutionCodes: readonly SupportCaseResolutionCode[] = [
  "CUSTOMER_ACTION_REQUIRED",
  "DUPLICATE_REQUEST",
  "INFORMATION_PROVIDED",
  "NO_PLATFORM_ERROR_FOUND",
  "ORDER_COMPLETED",
  "REFUND_REFERRED",
  "SUPPLIER_REVIEW_REQUIRED",
];

const fraudListContent = (
  result: AdminOperationsListResult<AdminFraudReviewSummary>,
  query: URLSearchParams,
): string =>
  `${listActionBar("Betrugsprüfung", "Manuelle Risikoprüfungen mit strikt getrennten operativen Zuständen.", "/admin/fraud", query, "Prüfungs- oder Bestell-ID", "Prüfregeln")}<section class="metric-grid" aria-label="Risikokennzahlen">${metric("Prüfungen", result.items.length, { icon: "RP", detail: "Aktuelle Ergebnisse" })}${metric("Offen", result.items.filter((item) => item.status === "OPEN").length, { icon: "OF", detail: "Blockiert Folgeschritte" })}${metric("Freigegeben", result.items.filter((item) => item.status === "APPROVED").length, { icon: "FR", detail: "In dieser Auswahl" })}${metric("Abgelehnt", result.items.filter((item) => item.status === "REJECTED").length, { icon: "AB", detail: "In dieser Auswahl" })}</section><details class="filter-panel" id="list-filter"${query.has("status") ? " open" : ""}><summary>Detailfilter</summary>${operationalFilter("/admin/fraud", query, "Prüfungs- oder Bestell-ID", ["OPEN", "APPROVED", "REJECTED", "CANCELLED"])}</details><div class="notice notice-warning"><strong>Fail-closed</strong><p>Offene Prüfungen blockieren Beschaffung und Produktschlüsselzugriff. Diese Ansicht legt keine internen Signale gegenüber Kunden offen.</p></div><section class="content-section operations-section flush"><div class="section-heading"><h2>Manuelle Prüfungen</h2><span>${result.items.length} Einträge</span></div>${result.items.length === 0 ? emptyState("Keine Prüfungen gefunden", "Es liegen für diese Auswahl keine manuellen Prüfungen vor.") : `<div class="table-wrap"><table class="operations-table"><thead><tr><th>Prüfung</th><th>Bestellung</th><th>Status</th><th>Gründe</th><th>Geöffnet</th><th>Abgeschlossen</th></tr></thead><tbody>${result.items.map((item) => `<tr><td data-label="Prüfung" class="table-reference">${escapeHtml(item.reviewId)}</td><td data-label="Bestellung"><a href="/admin/orders/${encodeURIComponent(item.orderId)}">${escapeHtml(item.orderId)}</a></td><td data-label="Status"><span class="status status-${item.status.toLowerCase()}">${escapeHtml(operationalLabel(item.status))}</span></td><td data-label="Gründe">${escapeHtml(item.reasonCodes.map(adminAuditCodeLabel).join(", "))}</td><td data-label="Geöffnet">${escapeHtml(formatDate(item.openedAt))}</td><td data-label="Abgeschlossen">${item.resolvedAt ? escapeHtml(formatDate(item.resolvedAt)) : "Offen"}</td></tr>`).join("")}</tbody></table></div>`}${operationalPagination(result, query, "/admin/fraud")}</section>`;

const financeContent = (
  rows: readonly AdminFinanceCurrencySummary[],
  report: boolean,
): string => {
  const cards = rows
    .flatMap((row) => [
      metric(
        `Erfasstes Zahlungsvolumen (${row.currency})`,
        formatMinor(row.capturedAmountMinor, row.currency),
      ),
      metric(`Erfasste Zahlungen (${row.currency})`, row.capturedOrders),
      metric(
        `Vollständig erstattetes Volumen (${row.currency})`,
        formatMinor(row.refundedAmountMinor, row.currency),
      ),
      metric(
        `Vollständig erstattete Bestellungen (${row.currency})`,
        row.refundedOrders,
      ),
      metric(
        `Teilweise erstattete Bestellungen (${row.currency})`,
        row.partiallyRefundedOrders,
      ),
    ])
    .join("");
  return `${pageActionBar(report ? "Berichte & Statistiken" : "Finanzen", report ? "Autoritative Kennzahlen mit klar ausgewiesener Datengrundlage." : "Erfasste Zahlungs- und Erstattungszustände ohne buchhalterische Überdehnung.", '<span class="button-disabled" aria-disabled="true" title="Ein sicherer zeitgebundener Export ist noch nicht angebunden">Export</span>')}${rows.length === 0 ? emptyState("Keine Finanzdaten verfügbar", "Es wurden noch keine auswertbaren Bestellungen erfasst.") : `<section class="metric-grid">${cards}</section>`}<div class="workspace-grid"><section class="content-section chart-panel"><div class="section-heading"><h2>${report ? "Entwicklung" : "Zahlungsverlauf"}</h2><span>Gesamtsicht</span></div>${honestChartState("Historische Tages- und Vergleichsreihen sind im aktuellen autoritativen Modell nicht verfügbar.")}</section><aside class="workspace-stack"><section class="content-section"><div class="section-heading"><h2>${report ? "Datengrundlage" : "Einordnung"}</h2></div><p>Gesamtsicht ohne Datumsfilter. Das erfasste Zahlungsvolumen umfasst jede Bestellung, deren Zahlung erfasst wurde, einschließlich später vollständig oder teilweise erstatteter Zahlungen. Vollständig erstattete Bestellwerte werden separat ausgewiesen.</p></section><section class="content-section"><div class="section-heading"><h2>Nicht dargestellt</h2></div><p>Autoritative Teil-Erstattungsbeträge liegen im Bestellmodell derzeit nicht vor und werden deshalb nicht abgezogen. Marge, Steuern und Buchhaltungsfreigaben liegen ebenfalls nicht vor und werden nicht berechnet oder geschätzt.</p></section></aside></div>`;
};

const notificationsContent = (
  notifications: readonly AdminNotificationItem[],
): string =>
  `<header class="page-heading"><p>Operative Hinweise</p><h1>Benachrichtigungen</h1></header><section class="content-section"><div class="section-heading"><h2>Aktueller Handlungsbedarf</h2><span>Aus echten offenen Zuständen</span></div>${notifications.length === 0 ? emptyState("Keine offenen Hinweise", "Für deine Berechtigungen liegen aktuell keine offenen Support-, Risiko- oder Betriebszustände vor.") : `<ol class="notification-list">${notifications.map((item) => `<li class="notification-${item.tone.toLowerCase()}"><div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(notificationDetail(item))}</span><small>${escapeHtml(formatDate(item.occurredAt))}</small></div><a href="${escapeHtml(item.href)}">Öffnen</a></li>`).join("")}</ol>`}</section><p class="page-note">Das Panel zeigt keine erfundene Ungelesen-Zahl. Hinweise verschwinden, sobald der zugrunde liegende operative Zustand abgeschlossen ist.</p>`;

const notificationDetail = (item: AdminNotificationItem): string =>
  item.category === "FRAUD"
    ? item.detail
    : item.detail.split(" · ").map(operationalLabel).join(" · ");

const settingsContent = (
  controls: readonly AdminOperationsControlSummary[],
  principal: AdminPrincipal,
  form: (capability: string) => {
    readonly path: string;
    readonly csrf: string;
  },
): string => {
  const canManage = hasAdminCapability(principal, "OPERATIONS_CONTROL_MANAGE");
  return `${pageActionBar("Einstellungen", "Systemzustände und freigegebene betriebliche Steuerungen verwalten.")}<nav class="section-tabs" aria-label="Einstellungsbereiche"><a href="/admin/settings" aria-current="page">Betrieb</a><span aria-disabled="true">Shop</span><span aria-disabled="true">Benachrichtigungen</span><span aria-disabled="true">Sicherheit</span><span aria-disabled="true">Zahlungen</span><span aria-disabled="true">Integrationen</span></nav><div class="workspace-grid"><section class="content-section"><div class="section-heading"><h2>Betriebssteuerungen</h2><span>${canManage ? "Versionsgeschützte Notfallsteuerung" : "Nur lesend"}</span></div>${controls.length === 0 ? emptyState("Keine Betriebssteuerungen verfügbar", "Der sichere Konfigurationszustand konnte nicht dargestellt werden.") : `<div class="table-wrap"><table class="operations-table"><thead><tr><th>Funktion</th><th>Status</th><th>Grund</th><th>Version</th><th>Aktualisiert</th>${canManage ? "<th>Aktion</th>" : ""}</tr></thead><tbody>${controls.map((item) => `<tr><td data-label="Funktion">${escapeHtml(operationalLabel(item.capability))}</td><td data-label="Status"><span class="status status-${item.state.toLowerCase()}">${escapeHtml(operationalLabel(item.state))}</span></td><td data-label="Grund">${escapeHtml(item.reasonCode ? operationalLabel(item.reasonCode) : "Keiner")}</td><td data-label="Version">${item.recordVersion}</td><td data-label="Aktualisiert">${escapeHtml(formatDate(item.updatedAt))}</td>${canManage ? `<td data-label="Aktion">${controlForm(item, form(item.capability))}</td>` : ""}</tr>`).join("")}</tbody></table></div>`}</section><aside class="workspace-stack"><section class="content-section"><div class="section-heading"><h2>Sichere Konfigurationsgrenze</h2></div><p>Deployment-, Provider- und Secret-Konfiguration wird nicht im Browser bearbeitet. Dieser Bereich zeigt ausschließlich freigegebene betriebliche Zustände.</p></section><section class="content-section"><div class="section-heading"><h2>Weitere Bereiche</h2></div><nav class="quick-links"><span>Shop-Einstellungen <small>Nicht angebunden</small></span><span>Zahlungsmethoden <small>Deployment-gesteuert</small></span><span>Systemstatus <small>Kein Browser-Schreibzugriff</small></span></nav></section></aside></div>`;
};

const controlForm = (
  control: AdminOperationsControlSummary,
  target: { readonly path: string; readonly csrf: string },
): string => {
  const pause = control.state === "ENABLED";
  return `<form class="control-form" method="post" action="${escapeHtml(target.path)}"><input type="hidden" name="csrf" value="${escapeHtml(target.csrf)}"><input type="hidden" name="capability" value="${escapeHtml(control.capability)}"><input type="hidden" name="desired_state" value="${pause ? "PAUSED" : "ENABLED"}"><input type="hidden" name="expected_version" value="${control.recordVersion}"><input type="hidden" name="operation_id" value="${escapeHtml(newAdminCorrelationId())}"><input type="hidden" name="confirm" value="CHANGE_OPERATIONS_CONTROL"><label>${pause ? "Grund" : "Bestätigung"}${pause ? `<select name="reason_code" required><option value="MAINTENANCE">Wartung</option><option value="INCIDENT_RESPONSE">Störungsbehebung</option><option value="SUPPLIER_INCIDENT">Lieferantenstörung</option><option value="SECURITY_INCIDENT">Sicherheitsvorfall</option><option value="MANUAL_OPERATIONS_PAUSE">Manuelle Pause</option></select>` : '<input type="hidden" name="reason_code" value=""><span>Aktivierung nach Prüfung</span>'}</label><button class="${pause ? "button-warning" : "button-secondary"}" type="submit">${pause ? "Pausieren" : "Fortsetzen"}</button></form>`;
};

const emptyState = (title: string, body: string): string =>
  `<div class="empty-state"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p></div>`;

const operationalLabel = (value: string): string => {
  const labels: Readonly<Record<string, string>> = {
    ACCOUNT_PROBLEM: "Kontoproblem",
    ACTIVATION_PROBLEM: "Aktivierungsproblem",
    ACTIVE_CANDIDATE: "Aktiver Kandidat",
    CLOSED: "Geschlossen",
    CUSTOMER: "Kunde",
    CUSTOMER_ACTION_REQUIRED: "Kundenaktion erforderlich",
    CUSTOMER_KEY_DELIVERY: "Kundenzustellung",
    DUPLICATE_REQUEST: "Doppelte Anfrage",
    DLC: "Zusatzinhalt",
    ENABLED: "Aktiviert",
    GAME: "Spiel",
    GIFT_CARD: "Geschenkkarte",
    HIGH: "Hoch",
    INFORMATION_PROVIDED: "Information bereitgestellt",
    IN_PROGRESS: "In Bearbeitung",
    INTERNAL: "Intern",
    INACTIVE: "Inaktiv",
    IN_STOCK: "Auf Lager",
    INVOICE_PROBLEM: "Rechnungsproblem",
    KEY_NOT_AVAILABLE: "Produktschlüssel nicht verfügbar",
    KEY_REVEAL_PROBLEM: "Problem beim Schlüsselzugriff",
    LOW: "Niedrig",
    MAINTENANCE: "Wartung",
    NORMAL: "Normal",
    LIMITED: "Begrenzt verfügbar",
    NO_PLATFORM_ERROR_FOUND: "Kein Plattformfehler festgestellt",
    OPEN: "Offen",
    ORDER_COMPLETED: "Bestellung abgeschlossen",
    ORDER_STATUS: "Bestellstatus",
    OTHER: "Sonstiges",
    OUT_OF_STOCK: "Nicht auf Lager",
    PAUSED: "Pausiert",
    PAYMENT_PROBLEM: "Zahlungsproblem",
    PREORDER: "Vorbestellung",
    PROCUREMENT_CREATE: "Beschaffung anlegen",
    REFUND_REQUEST: "Erstattungsanfrage",
    REFUND_REFERRED: "Erstattung weitergeleitet",
    RESOLVED: "Gelöst",
    SOFTWARE: "Software",
    SUBSCRIPTION: "Abonnement",
    SUPPLIER_CLAIM_SUBMISSION: "Lieferantenreklamation senden",
    SUPPLIER_KEY_RETRIEVAL: "Lieferantenschlüssel abrufen",
    SUPPLIER_PROBLEM: "Lieferantenproblem",
    SUPPLIER_REVIEW_REQUIRED: "Lieferantenprüfung erforderlich",
    SUSPECTED_DUPLICATE_ORDER: "Mögliche Doppelbestellung",
    SYSTEM: "System",
    UNKNOWN: "Unbekannt",
    UNVERIFIED: "Nicht verifiziert",
    URGENT: "Dringend",
    VERIFIED: "Verifiziert",
    WAITING_FOR_CUSTOMER: "Wartet auf Kunde",
    WAITING_FOR_INTERNAL: "Wartet intern",
  };
  return labels[value] ?? adminStatusLabel(value);
};

const orderDetailContent = (
  order: AdminOrderDetail,
  revealPath: string,
  csrf: string,
  delayedPath: string,
  delayedCsrf: string,
  delayedEligible: boolean,
  canViewSupplier: boolean,
  returnPath: string,
): string =>
  `${pageActionBar(`Bestellung ${order.operatorReference}`, `Technische Bestell-ID ${order.orderId}`, `<a class="button-quiet" href="${escapeHtml(returnPath)}">← Zurück zu Bestellungen</a>`)}<section class="order-detail-identity"><span class="product-media">${icon("package")}</span><div><h2>${escapeHtml(order.productTitle)}</h2><p>${escapeHtml(adminStatusLabel(order.productPlatform))} · Menge ${order.quantity}</p></div><span class="status status-${escapeHtml(order.status.toLowerCase())}">${escapeHtml(adminStatusLabel(order.status))}</span></section><section class="state-strip" aria-label="Bestellzustände">${stateItem("Zahlung", order.paymentStatus)}${stateItem("Risiko", order.riskStatus)}${stateItem("Beschaffung", order.procurementStatus)}${stateItem("Auslieferung", order.fulfillmentStatus)}</section><section class="detail-grid"><article><h2>Bestellung</h2>${detailRow("Bestellreferenz", order.operatorReference)}${detailRow("Technische Bestell-ID", order.orderId)}${detailRow("Kunde", order.customerEmail ?? "Nicht verfügbar")}${detailRow("Betrag", formatMinor(order.amountMinor, order.currency))}${detailRow("Angelegt", formatDate(order.createdAt))}${detailRow("Aktualisiert", formatDate(order.updatedAt))}</article><article><h2>Operativer Kontext</h2>${detailRow("Gastbestellungs-Zuordnung", adminStatusLabel(order.guestClaimStatus))}${detailRow("Rechnung", adminStatusLabel(order.invoiceStatus))}${canViewSupplier ? `${detailRow("Lieferant", order.supplierId ?? "Nicht verfügbar")}${detailRow("Lieferantenbestellung", order.externalSupplierOrderId ?? "Nicht verfügbar")}` : ""}${detailRow("Abrufstatus", order.retrievalState ? adminStatusLabel(order.retrievalState) : "Nicht verfügbar")}${detailRow("Zustellstatus", order.deliveryState ? adminStatusLabel(order.deliveryState) : "Nicht verfügbar")}</article></section>${delayedEligible ? `<section class="content-section sensitive"><div class="section-heading"><div><p>Synthetischer Staging-Vorgang</p><h2>Verzögerte Auslieferung abschließen</h2></div></div><p>Dieser Vorgang nutzt keine Lieferantenverbindung und erzeugt ausschließlich verschlüsseltes synthetisches Testmaterial.</p><form method="post" action="${escapeHtml(delayedPath)}"><input type="hidden" name="csrf" value="${escapeHtml(delayedCsrf)}"><input type="hidden" name="confirm" value="SYNTHETIC_DELAYED_FULFILLMENT"><button type="submit">Synthetische Auslieferung bestätigen</button></form></section>` : ""}<section class="content-section sensitive"><div class="section-heading"><div><p>Sensibler Vorgang</p><h2>Produktschlüssel</h2></div></div><p>${order.encryptedSecretAvailable ? "Verschlüsseltes Material ist vorhanden. Eine Offenlegung ist nur über den kontrollierten separaten Vorgang möglich." : "Für diese Bestellung ist kein verschlüsseltes Material verfügbar."}</p><form method="post" action="${escapeHtml(revealPath)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit"${order.encryptedSecretAvailable ? "" : " disabled"}>Kontrollierten Zugriff anfordern</button></form></section><section class="content-section"><div class="section-heading"><h2>Statushistorie</h2></div>${order.history.length === 0 ? '<div class="empty-state"><strong>Keine Statushistorie verfügbar</strong></div>' : `<ol class="timeline">${order.history.map((entry) => `<li><strong>${escapeHtml(adminStatusLabel(entry.toStatus))}</strong><span>${escapeHtml(adminAuditCodeLabel(entry.reasonCode))} · ${escapeHtml(formatDate(entry.occurredAt))}</span></li>`).join("")}</ol>`}</section>`;
const stateItem = (label: string, status: string): string =>
  `<div><span>${escapeHtml(label)}</span><strong class="status status-${escapeHtml(status.toLowerCase())}">${escapeHtml(operationalLabel(status))}</strong></div>`;
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
  return `${pageActionBar("Mitarbeiter & Rollen", "Mitarbeiterkonten, Rollen und wirksame Berechtigungen sicher verwalten.", hasAdminCapability(principal, "STAFF_MANAGE") ? '<a class="button" href="#staff-create">Mitarbeiter hinzufügen</a>' : "")}<section class="metric-grid" aria-label="Mitarbeiterkennzahlen">${metric("Mitarbeitende", staff.length, { icon: "MA", detail: "Gesamt" })}${metric("Aktiv", staff.filter((item) => item.status === "ACTIVE").length, { icon: "AK", detail: "Aktive Konten" })}${metric("Inaktiv", staff.filter((item) => item.status !== "ACTIVE").length, { icon: "IN", detail: "Nicht aktive Konten" })}${metric("Mit Zusatzrechten", staff.filter((item) => item.hasAdditionalPermissions).length, { icon: "ZR", detail: "Individuelle Berechtigungen" })}</section><section class="content-section staff-section flush"><div class="section-heading"><h2>Mitarbeitende</h2><span>${staff.length} Einträge</span></div>${rows}</section>${create.replace('<section class="content-section">', '<section class="content-section" id="staff-create">')}`;
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
