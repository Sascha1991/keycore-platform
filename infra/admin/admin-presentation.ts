import {
  adminCapabilities,
  adminRoles,
  type AdminAuditEntry,
  type AdminCapability,
  type AdminOrderDetail,
  type AdminRole,
  type AdminStaffSummary,
  type AuditOutcome,
  type FulfillmentDeliveryState,
  type FulfillmentRetrievalState,
  type FulfillmentStatus,
  type OrderFulfillmentStatus,
  type OrderPaymentStatus,
  type OrderProcurementStatus,
  type OrderReasonCode,
  type OrderRiskStatus,
  type OrderStatus,
} from "../../packages/platform/src/contracts.js";
import type { auditEventTypes } from "../../packages/platform/src/contracts.js";

export const adminRoleLabels = {
  FINANCE: "Finanzen",
  OPERATIONS: "Betrieb",
  PROJECT_OWNER: "Projektinhaber",
  SECURITY_AUDITOR: "Sicherheitsprüfer",
  SUPPORT: "Support",
} as const satisfies Readonly<Record<AdminRole, string>>;

export const adminCapabilityLabels = {
  ADMIN_ACCESS: "Admin-Bereich aufrufen",
  AUDIT_VIEW: "Audit-Protokoll anzeigen",
  CATALOG_VIEW: "Katalog anzeigen",
  CUSTOMER_VIEW: "Kunden anzeigen",
  FINANCE_VIEW: "Finanzübersicht anzeigen",
  FRAUD_REVIEW_MANAGE: "Betrugsprüfungen bearbeiten",
  FRAUD_REVIEW_VIEW: "Betrugsprüfungen anzeigen",
  OPERATIONS_CONTROL_MANAGE: "Betriebssteuerungen verwalten",
  OPERATIONS_CONTROL_VIEW: "Betriebssteuerungen anzeigen",
  ORDER_VIEW: "Bestellungen anzeigen",
  PERMISSION_OVERRIDE_MANAGE: "Individuelle Berechtigungen verwalten",
  PRODUCT_KEY_REVEAL: "Produktschlüssel anzeigen",
  REFUND_MANAGE: "Erstattungen verwalten",
  REPORT_VIEW: "Berichte anzeigen",
  ROLE_ASSIGN: "Rollen zuweisen",
  SENSITIVE_OPERATION: "Sensible Vorgänge ausführen",
  STAFF_MANAGE: "Mitarbeiter verwalten",
  STAFF_VIEW: "Mitarbeiter anzeigen",
  SUPPLIER_VIEW: "Lieferanten anzeigen",
  SUPPORT_MANAGE: "Supportfälle bearbeiten",
  SUPPORT_VIEW: "Supportfälle anzeigen",
} as const satisfies Readonly<Record<AdminCapability, string>>;

type AdminStaffStatus = AdminStaffSummary["status"];

export const adminStaffStatusLabels = {
  ACTIVE: "Aktiv",
  DISABLED: "Deaktiviert",
} as const satisfies Readonly<Record<AdminStaffStatus, string>>;

export const adminAuditOutcomeLabels = {
  DENIED: "Abgelehnt",
  FAILED: "Fehlgeschlagen",
  SUCCEEDED: "Erfolgreich",
} as const satisfies Readonly<Record<AuditOutcome, string>>;

export const adminOrderStatuses = [
  "CREATED",
  "AWAITING_PAYMENT",
  "PAYMENT_AUTHORIZED",
  "PAYMENT_CAPTURED",
  "PROCUREMENT_PENDING",
  "PROCUREMENT_IN_PROGRESS",
  "FULFILLMENT_PENDING",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "REFUND_PENDING",
  "REFUNDED",
  "MANUAL_REVIEW",
] as const satisfies readonly OrderStatus[];

type AdminPresentationStatus =
  | OrderStatus
  | OrderPaymentStatus
  | OrderProcurementStatus
  | OrderFulfillmentStatus
  | OrderRiskStatus
  | AdminOrderDetail["guestClaimStatus"]
  | AdminOrderDetail["invoiceStatus"]
  | FulfillmentStatus
  | FulfillmentRetrievalState
  | FulfillmentDeliveryState
  | AdminStaffStatus
  | "ALLOW"
  | "CURRENT"
  | "CUSTOM"
  | "DEFAULT"
  | "DENY"
  | "GRANTED"
  | "NONE"
  | "UNKNOWN";

export const adminStatusLabels = {
  ACTIVE: "Aktiv",
  ALLOW: "Erlaubt",
  AMBIGUOUS: "Unklar",
  APPROVED: "Freigegeben",
  AUTHORIZED: "Autorisiert",
  AWAITING_PAYMENT: "Zahlung ausstehend",
  CANCELLED: "Storniert",
  CAPTURED: "Erfasst",
  CLAIMED: "Zugeordnet",
  COMPLETED: "Abgeschlossen",
  CREATED: "Angelegt",
  CURRENT: "Aktuell",
  CUSTOM: "Individuell",
  DEFAULT: "Standard",
  DELIVERED: "Zugestellt",
  DELIVERY_PENDING: "Zustellung ausstehend",
  DISABLED: "Deaktiviert",
  DENY: "Verweigert",
  EXPIRED: "Abgelaufen",
  FAILED: "Fehlgeschlagen",
  FAILED_RETRYABLE: "Wiederholbarer Fehler",
  FAILED_TERMINAL: "Endgültig fehlgeschlagen",
  FULFILLMENT_PENDING: "Auslieferung ausstehend",
  GRANTED: "Erteilt",
  IN_FLIGHT: "In Bearbeitung",
  IN_PROGRESS: "In Bearbeitung",
  MANUAL_REVIEW: "Manuelle Prüfung",
  MANUAL_REVIEW_REQUIRED: "Manuelle Prüfung erforderlich",
  NOT_AVAILABLE: "Nicht verfügbar",
  NOT_EVALUATED: "Nicht bewertet",
  NOT_READY: "Nicht bereit",
  NOT_STARTED: "Nicht begonnen",
  NONE: "Keine",
  PARTIALLY_REFUNDED: "Teilweise erstattet",
  PAYMENT_AUTHORIZED: "Zahlung autorisiert",
  PAYMENT_CAPTURED: "Zahlung erfasst",
  PENDING: "Ausstehend",
  PROCUREMENT_IN_PROGRESS: "Beschaffung läuft",
  PROCUREMENT_PENDING: "Beschaffung ausstehend",
  READY: "Bereit",
  REFUND_PENDING: "Erstattung ausstehend",
  REFUNDED: "Erstattet",
  REJECTED: "Abgelehnt",
  RETRIEVAL_IN_FLIGHT: "Abruf läuft",
  RETRIEVED: "Abgerufen",
  REVIEW_REQUIRED: "Prüfung erforderlich",
  REVOKED: "Widerrufen",
  SUCCEEDED: "Erfolgreich",
  UNKNOWN: "Unbekannt",
} as const satisfies Readonly<Record<AdminPresentationStatus, string>>;

type FixedAuditEventType = (typeof auditEventTypes)[number];

export const adminAuditEventTypeLabels = {
  ADMIN_ACTION: "Admin-Vorgang",
  APPROVAL_RECORDED: "Freigabe dokumentiert",
  AUDIT_QUERY_DENIED: "Audit-Abfrage abgelehnt",
  AUDIT_QUERY_EXECUTED: "Audit-Abfrage ausgeführt",
  AUTH_SECURITY_EVENT: "Anmelde- und Sicherheitsereignis",
  HEALTH: "Systemzustand",
  KEY_ACCESS_DENIED: "Produktschlüsselzugriff abgelehnt",
  KEY_RETIRED: "Produktschlüssel stillgelegt",
  KEY_REVEALED: "Produktschlüssel angezeigt",
  KEY_REWRAPPED: "Produktschlüssel neu verschlüsselt",
  KEY_STORED: "Produktschlüssel gespeichert",
  PRICE_GATE_CHANGED: "Preisfreigabe geändert",
  REGION_DECISION_CHANGED: "Regionsentscheidung geändert",
  SUPPLIER_FALLBACK_BLOCKED: "Lieferantenwechsel blockiert",
  SUPPLIER_SELECTION_COMPLETED: "Lieferantenauswahl abgeschlossen",
  SUPPLIER_SELECTION_FAILED: "Lieferantenauswahl fehlgeschlagen",
  SYSTEM_DEGRADATION: "Systembeeinträchtigung",
} as const satisfies Readonly<Record<FixedAuditEventType, string>>;

export const knownAdminAuditCodes = [
  "ADMIN_ACCESS_DENIED",
  "ADMIN_AUDIT_VIEWED",
  "ADMIN_AUTHENTICATED",
  "ADMIN_DASHBOARD_VIEWED",
  "ADMIN_CUSTOMERS_VIEWED",
  "ADMIN_FINANCE_VIEWED",
  "ADMIN_FRAUD_VIEWED",
  "ADMIN_INPUT_INVALID",
  "ADMIN_KEY_NOT_AVAILABLE",
  "ADMIN_KEY_REVEAL_DENIED",
  "ADMIN_KEY_REVEAL_NOT_ENABLED",
  "ADMIN_LAST_OWNER_PROTECTED",
  "ADMIN_ORDER_DETAIL_VIEWED",
  "ADMIN_ORDER_LIST_VIEWED",
  "ADMIN_ORDER_VIEW_DENIED",
  "ADMIN_OPERATIONS_CONTROLS_VIEWED",
  "ADMIN_NOTIFICATIONS_VIEWED",
  "ADMIN_PERMISSION_GRANTED",
  "ADMIN_PERMISSION_REVOKED",
  "ADMIN_RESOURCE_UNAVAILABLE",
  "ADMIN_ROLE_CHANGED",
  "ADMIN_PRODUCTS_VIEWED",
  "ADMIN_REPORTS_VIEWED",
  "ADMIN_SELF_DISABLE_DENIED",
  "ADMIN_SELF_ESCALATION_DENIED",
  "ADMIN_SESSION_INVALID",
  "ADMIN_SESSION_UNAVAILABLE",
  "ADMIN_STAFF_CREATED",
  "ADMIN_STAFF_DETAIL_VIEWED",
  "ADMIN_STAFF_DISABLED",
  "ADMIN_STAFF_ENABLED",
  "ADMIN_STAFF_LIST_VIEWED",
  "ADMIN_STAFF_REACTIVATED",
  "ADMIN_SUPPLIERS_VIEWED",
  "ADMIN_SUPPORT_VIEWED",
] as const;

type KnownAdminAuditCode = (typeof knownAdminAuditCodes)[number];

export const adminAuditCodeLabels = {
  ADMIN_ACCESS_DENIED: "Admin-Zugriff abgelehnt",
  ADMIN_AUDIT_VIEWED: "Audit-Protokoll aufgerufen",
  ADMIN_AUTHENTICATED: "Admin-Anmeldung erfolgreich",
  ADMIN_DASHBOARD_VIEWED: "Übersicht aufgerufen",
  ADMIN_CUSTOMERS_VIEWED: "Kundenliste aufgerufen",
  ADMIN_FINANCE_VIEWED: "Finanzübersicht aufgerufen",
  ADMIN_FRAUD_VIEWED: "Betrugsprüfungen aufgerufen",
  ADMIN_INPUT_INVALID: "Ungültige Admin-Eingabe",
  ADMIN_KEY_NOT_AVAILABLE: "Produktschlüssel nicht verfügbar",
  ADMIN_KEY_REVEAL_DENIED: "Produktschlüsselzugriff abgelehnt",
  ADMIN_KEY_REVEAL_NOT_ENABLED: "Produktschlüsselzugriff nicht freigeschaltet",
  ADMIN_LAST_OWNER_PROTECTED: "Letzten Projektinhaber geschützt",
  ADMIN_ORDER_DETAIL_VIEWED: "Bestelldetails aufgerufen",
  ADMIN_ORDER_LIST_VIEWED: "Bestellliste aufgerufen",
  ADMIN_ORDER_VIEW_DENIED: "Bestellzugriff abgelehnt",
  ADMIN_OPERATIONS_CONTROLS_VIEWED: "Betriebssteuerungen aufgerufen",
  ADMIN_NOTIFICATIONS_VIEWED: "Benachrichtigungen aufgerufen",
  ADMIN_PERMISSION_GRANTED: "Berechtigung erteilt",
  ADMIN_PERMISSION_REVOKED: "Berechtigung widerrufen",
  ADMIN_RESOURCE_UNAVAILABLE: "Admin-Ressource nicht verfügbar",
  ADMIN_ROLE_CHANGED: "Mitarbeiterrolle geändert",
  ADMIN_PRODUCTS_VIEWED: "Produktkatalog aufgerufen",
  ADMIN_REPORTS_VIEWED: "Berichte aufgerufen",
  ADMIN_SELF_DISABLE_DENIED: "Eigene Deaktivierung abgelehnt",
  ADMIN_SELF_ESCALATION_DENIED: "Eigene Rechteausweitung abgelehnt",
  ADMIN_SESSION_INVALID: "Admin-Sitzung ungültig",
  ADMIN_SESSION_UNAVAILABLE: "Admin-Sitzung nicht verfügbar",
  ADMIN_STAFF_CREATED: "Mitarbeiter angelegt",
  ADMIN_STAFF_DETAIL_VIEWED: "Mitarbeiterdetails aufgerufen",
  ADMIN_STAFF_DISABLED: "Mitarbeiter deaktiviert",
  ADMIN_STAFF_ENABLED: "Mitarbeiter reaktiviert",
  ADMIN_STAFF_LIST_VIEWED: "Mitarbeiterliste aufgerufen",
  ADMIN_STAFF_REACTIVATED: "Mitarbeiter reaktiviert",
  ADMIN_SUPPLIERS_VIEWED: "Lieferantenliste aufgerufen",
  ADMIN_SUPPORT_VIEWED: "Supportfälle aufgerufen",
} as const satisfies Readonly<Record<KnownAdminAuditCode, string>>;

const orderReasonLabels = {
  EXTERNAL_EVENT_CONFLICT: "Konflikt mit externem Ereignis",
  EXTERNAL_EVENT_DEDUPLICATED: "Externes Ereignis dedupliziert",
  FULFILLMENT_FAILED: "Auslieferung fehlgeschlagen",
  INVALID_ORDER_TRANSITION: "Ungültiger Bestellstatuswechsel",
  MANUAL_REVIEW_REQUIRED: "Manuelle Prüfung erforderlich",
  OPERATIONS_CONTROL_BLOCKED: "Durch Betriebssteuerung blockiert",
  OPTIMISTIC_CONCURRENCY_CONFLICT: "Gleichzeitige Änderung erkannt",
  ORDER_CREATED: "Bestellung angelegt",
  ORDER_IDEMPOTENCY_CONFLICT: "Idempotenzkonflikt bei Bestellung",
  ORDER_IDEMPOTENT_REPLAY: "Bestellung sicher wiederholt",
  PAYMENT_NOT_ELIGIBLE_FOR_PROCUREMENT: "Zahlung nicht beschaffungsberechtigt",
  PRICE_LOCK_CONSUMED: "Preisbindung bereits verwendet",
  PRICE_LOCK_EXPIRED: "Preisbindung abgelaufen",
  PRICE_LOCK_MISMATCH: "Preisbindung stimmt nicht überein",
  PRICE_LOCK_NOT_FOUND: "Preisbindung nicht gefunden",
  PRICE_LOCK_UNSAFE: "Preisbindung nicht sicher verwendbar",
  PROCUREMENT_AMBIGUOUS: "Beschaffungsergebnis unklar",
  PROCUREMENT_FAILED_RETRYABLE: "Beschaffung wiederholbar fehlgeschlagen",
  PROCUREMENT_FAILED_TERMINAL: "Beschaffung endgültig fehlgeschlagen",
  REFUND_FAILED: "Erstattung fehlgeschlagen",
  RISK_NOT_APPROVED: "Risikoprüfung nicht freigegeben",
  UNSUPPORTED_QUANTITY: "Menge nicht unterstützt",
} as const satisfies Readonly<Record<OrderReasonCode, string>>;

const auditDetailLabels = {
  action: "Vorgang",
  capability: "Berechtigung",
  filtered: "Filter aktiv",
  found: "Datensatz gefunden",
  newRole: "Neue Rolle",
  previousRole: "Vorherige Rolle",
  resultCount: "Anzahl Ergebnisse",
  targetAdminId: "Mitarbeiter-ID",
} as const;

type AuditDetailKey = keyof typeof auditDetailLabels;

const hasOwn = <T extends object>(value: T, key: PropertyKey): key is keyof T =>
  Object.prototype.hasOwnProperty.call(value, key);

export const adminRoleLabel = (role: AdminRole): string =>
  adminRoleLabels[role];

export const adminCapabilityLabel = (capability: AdminCapability): string =>
  adminCapabilityLabels[capability];

export const adminStaffStatusLabel = (status: AdminStaffStatus): string =>
  adminStaffStatusLabels[status];

export const adminAuditOutcomeLabel = (outcome: AuditOutcome): string =>
  adminAuditOutcomeLabels[outcome];

export const adminStatusLabel = (status: string): string =>
  hasOwn(adminStatusLabels, status)
    ? adminStatusLabels[status]
    : "Unbekannter Status";

export const adminAuditEventTypeLabel = (eventType: string): string => {
  if (hasOwn(adminAuditEventTypeLabels, eventType))
    return adminAuditEventTypeLabels[eventType];
  const prefix = eventType.split("_", 1)[0];
  return prefix && hasOwn(auditPrefixLabels, prefix)
    ? auditPrefixLabels[prefix]
    : "Unbekanntes Ereignis";
};

export const adminAuditCodeLabel = (code: string): string => {
  if (hasOwn(adminAuditCodeLabels, code)) return adminAuditCodeLabels[code];
  if (hasOwn(orderReasonLabels, code)) return orderReasonLabels[code];
  const prefix = code.split("_", 1)[0];
  return prefix && hasOwn(auditPrefixLabels, prefix)
    ? auditPrefixLabels[prefix]
    : "Unbekannter Vorgang";
};

export const adminEntityTypeLabel = (entityType: string): string => {
  if (entityType === "ADMIN_IDENTITY") return "Mitarbeiter";
  if (entityType === "ADMIN_PORTAL") return "Admin-Bereich";
  if (entityType === "ORDER") return "Bestellung";
  return "Objekt";
};

export const formatAdminAuditSafeDetails = (
  details: AdminAuditEntry["safeDetails"],
): string => {
  const rendered: string[] = [];
  for (const key of Object.keys(auditDetailLabels) as AuditDetailKey[]) {
    const value = details[key];
    if (value === undefined) continue;
    rendered.push(`${auditDetailLabels[key]}: ${auditDetailValue(key, value)}`);
  }
  return rendered.join(" · ") || "Keine";
};

const auditDetailValue = (
  key: AuditDetailKey,
  value: string | number | boolean,
): string => {
  if (typeof value === "boolean") return value ? "Ja" : "Nein";
  if (typeof value === "number") return String(value);
  if (key === "action") return adminAuditCodeLabel(value);
  if (key === "newRole" || key === "previousRole")
    return (adminRoles as readonly string[]).includes(value)
      ? adminRoleLabel(value as AdminRole)
      : "Unbekannte Rolle";
  if (key === "capability")
    return (adminCapabilities as readonly string[]).includes(value)
      ? adminCapabilityLabel(value as AdminCapability)
      : "Unbekannte Berechtigung";
  return value;
};

const auditPrefixLabels = {
  ADMIN: "Admin-Vorgang",
  CATALOG: "Katalogvorgang",
  CUSTOMER: "Kundenvorgang",
  DISPUTE: "Konfliktvorgang",
  FRAUD: "Betrugsprüfung",
  FULFILLMENT: "Auslieferungsvorgang",
  OPERATIONS: "Betriebsvorgang",
  ORDER: "Bestellvorgang",
  PAYMENT: "Zahlungsvorgang",
  PRICING: "Preisvorgang",
  PROCUREMENT: "Beschaffungsvorgang",
  REFUND: "Erstattungsvorgang",
  STOREFRONT: "Shop-Vorgang",
  SUPPLIER: "Lieferantenvorgang",
  SUPPORT: "Supportvorgang",
} as const;
