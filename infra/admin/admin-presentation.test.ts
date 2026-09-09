import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  adminCapabilities,
  adminRoles,
  auditEventTypes,
  auditOutcomes,
} from "../../packages/platform/src/contracts.js";
import {
  adminAuditCodeLabel,
  adminAuditCodeLabels,
  adminAuditEventTypeLabel,
  adminAuditEventTypeLabels,
  adminAuditOutcomeLabel,
  adminAuditOutcomeLabels,
  adminCapabilityLabel,
  adminCapabilityLabels,
  adminRoleLabel,
  adminRoleLabels,
  adminStaffStatusLabel,
  adminStaffStatusLabels,
  adminStatusLabel,
  formatAdminAuditSafeDetails,
  knownAdminAuditCodes,
} from "./admin-presentation.js";

describe("German Admin presentation labels", () => {
  it("covers every authoritative role and capability without changing identifiers", () => {
    expect(Object.keys(adminRoleLabels).sort()).toEqual([...adminRoles].sort());
    expect(Object.keys(adminCapabilityLabels).sort()).toEqual(
      [...adminCapabilities].sort(),
    );

    for (const role of adminRoles) {
      expect(adminRoleLabel(role)).not.toMatch(/^[A-Z][A-Z0-9_]+$/u);
    }
    for (const capability of adminCapabilities) {
      expect(adminCapabilityLabel(capability)).not.toMatch(
        /^[A-Z][A-Z0-9_]+$/u,
      );
    }

    expect(adminRoles).toContain("PROJECT_OWNER");
    expect(adminCapabilities).toContain("PRODUCT_KEY_REVEAL");
  });

  it("covers all staff statuses, audit outcomes and fixed audit event types", () => {
    expect(Object.keys(adminStaffStatusLabels).sort()).toEqual([
      "ACTIVE",
      "DISABLED",
    ]);
    expect(Object.keys(adminAuditOutcomeLabels).sort()).toEqual(
      [...auditOutcomes].sort(),
    );
    expect(Object.keys(adminAuditEventTypeLabels).sort()).toEqual(
      [...auditEventTypes].sort(),
    );

    expect(adminStaffStatusLabel("ACTIVE")).toBe("Aktiv");
    expect(adminStaffStatusLabel("DISABLED")).toBe("Deaktiviert");
    expect(adminAuditOutcomeLabel("SUCCEEDED")).toBe("Erfolgreich");
    expect(adminAuditOutcomeLabel("DENIED")).toBe("Abgelehnt");
    expect(adminAuditOutcomeLabel("FAILED")).toBe("Fehlgeschlagen");
  });

  it("localizes every known Admin audit code and fails safely for future values", () => {
    expect(Object.keys(adminAuditCodeLabels).sort()).toEqual(
      [...knownAdminAuditCodes].sort(),
    );
    for (const code of knownAdminAuditCodes) {
      expect(adminAuditCodeLabel(code)).not.toBe(code);
      expect(adminAuditCodeLabel(code)).not.toContain("_");
    }

    expect(adminAuditEventTypeLabel("FUTURE_EVENT")).toBe(
      "Unbekanntes Ereignis",
    );
    expect(adminAuditCodeLabel("FUTURE_REASON")).toBe("Unbekannter Vorgang");
    expect(adminStatusLabel("GRANTED")).toBe("Erteilt");
    expect(adminStatusLabel("UNKNOWN")).toBe("Unbekannt");
    expect(adminStatusLabel("FUTURE_STATUS")).toBe("Unbekannter Status");
  });

  it("requires every Admin audit code used by production sources to have a label", () => {
    const productionSources = [
      "../../packages/platform/src/admin/admin-orders.ts",
      "../../packages/platform/src/admin/admin-operations.ts",
      "../../packages/platform/src/admin/admin-staff.ts",
      "../postgres/admin-repositories.ts",
    ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
    const nonDisplayIdentifiers = new Set([
      ...adminCapabilities,
      "ADMIN_ACTION",
      "ADMIN_IDENTITY",
      "ADMIN_PORTAL",
    ]);
    const codes = new Set(
      productionSources.flatMap((source) =>
        [...source.matchAll(/"(ADMIN_[A-Z0-9_]+)"/gu)].map(
          (match) => match[1] ?? "",
        ),
      ),
    );

    for (const code of codes) {
      if (!nonDisplayIdentifiers.has(code)) {
        expect(knownAdminAuditCodes).toContain(code);
      }
    }
  });

  it("renders allowlisted safe details in German without mutating evidence", () => {
    const storedEvidence = {
      action: "ADMIN_ROLE_CHANGED",
      capability: "AUDIT_VIEW",
      filtered: true,
      found: false,
      newRole: "FINANCE",
      previousRole: "SUPPORT",
      resultCount: 3,
      targetAdminId: "1e349231-8581-4205-85f9-369249b2ddd7",
    } as const;

    expect(formatAdminAuditSafeDetails(storedEvidence)).toBe(
      "Vorgang: Mitarbeiterrolle geändert · Berechtigung: Audit-Protokoll anzeigen · Filter aktiv: Ja · Datensatz gefunden: Nein · Neue Rolle: Finanzen · Vorherige Rolle: Support · Anzahl Ergebnisse: 3 · Mitarbeiter-ID: 1e349231-8581-4205-85f9-369249b2ddd7",
    );
    expect(storedEvidence.action).toBe("ADMIN_ROLE_CHANGED");
    expect(storedEvidence.newRole).toBe("FINANCE");
    expect(storedEvidence.previousRole).toBe("SUPPORT");
  });

  it("drops non-allowlisted secret-shaped details from presentation", () => {
    expect(
      formatAdminAuditSafeDetails({
        cookie: true,
        sessionCode: true,
        token: true,
      }),
    ).toBe("Keine");
  });
});
