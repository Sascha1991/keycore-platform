import { describe, expect, it } from "vitest";

import {
  GermanyEligibilityEngine,
  StaticRegionSemanticRegistry,
  germanyEligibilityPolicyVersion,
} from "./germany-eligibility.js";
import {
  emptyRegionEvidence,
  regionCode,
  supplierId,
  type RegionEvidence,
} from "../contracts.js";

const supplier = supplierId("mock-supplier");

const evidence = (override: Partial<RegionEvidence> = {}): RegionEvidence => ({
  activationRestrictions: [],
  allowedCountries: [],
  excludedCountries: [],
  hasContradictoryEvidence: false,
  hasMissingValues: false,
  hasUnknownValues: false,
  requiresForeignAccount: false,
  requiresVpn: false,
  ...override,
});

describe("Germany eligibility policy de-eligibility-v1", () => {
  it.each([
    [
      "explicit Germany allow",
      evidence({ allowedCountries: [regionCode("DE")] }),
      "ALLOWED",
      "REGION_DE_ALLOWED",
    ],
    [
      "explicit Germany exclusion",
      evidence({
        allowedCountries: [regionCode("DE")],
        excludedCountries: [regionCode("DE")],
      }),
      "BLOCKED",
      "REGION_DE_EXCLUDED",
    ],
    [
      "VPN required flag",
      evidence({ allowedCountries: [regionCode("DE")], requiresVpn: true }),
      "BLOCKED",
      "VPN_ACTIVATION_BLOCKED",
    ],
    [
      "VPN activation restriction",
      evidence({
        activationRestrictions: [{ kind: "VPN_REQUIRED" }],
        allowedCountries: [regionCode("DE")],
      }),
      "BLOCKED",
      "VPN_ACTIVATION_BLOCKED",
    ],
    [
      "foreign account flag",
      evidence({
        allowedCountries: [regionCode("DE")],
        requiresForeignAccount: true,
      }),
      "BLOCKED",
      "FOREIGN_ACCOUNT_REQUIRED",
    ],
    [
      "foreign account restriction",
      evidence({
        activationRestrictions: [{ kind: "FOREIGN_ACCOUNT_REQUIRED" }],
        allowedCountries: [regionCode("DE")],
      }),
      "BLOCKED",
      "FOREIGN_ACCOUNT_REQUIRED",
    ],
    [
      "contradictory evidence",
      evidence({
        allowedCountries: [regionCode("DE")],
        hasContradictoryEvidence: true,
      }),
      "REVIEW_REQUIRED",
      "REGION_EVIDENCE_CONTRADICTORY",
    ],
    [
      "missing evidence",
      evidence({ hasMissingValues: true }),
      "REVIEW_REQUIRED",
      "REGION_EVIDENCE_MISSING",
    ],
    [
      "unknown VPN value",
      evidence({ requiresVpn: "UNKNOWN" }),
      "REVIEW_REQUIRED",
      "REGION_EVIDENCE_MISSING",
    ],
    [
      "unknown foreign account value",
      evidence({ requiresForeignAccount: "UNKNOWN" }),
      "REVIEW_REQUIRED",
      "REGION_EVIDENCE_MISSING",
    ],
    [
      "unknown values",
      evidence({ hasUnknownValues: true }),
      "REVIEW_REQUIRED",
      "REGION_UNKNOWN_VALUE",
    ],
    [
      "unknown activation restriction",
      evidence({ activationRestrictions: [{ kind: "UNKNOWN" }] }),
      "REVIEW_REQUIRED",
      "REGION_UNKNOWN_VALUE",
    ],
    [
      "empty evidence",
      emptyRegionEvidence(),
      "REVIEW_REQUIRED",
      "REGION_EVIDENCE_MISSING",
    ],
  ])("evaluates %s", (_name, input, decision, reasonCode) => {
    const result = new GermanyEligibilityEngine().evaluate({
      evidence: input,
      supplierId: supplier,
    });

    expect(result).toMatchObject({
      decision,
      policyVersion: germanyEligibilityPolicyVersion,
      reasonCode,
    });
  });

  it.each([
    ["EU region", "eu", "EU_INCLUDING_DE", "REGION_EU_ALLOWED"],
    ["global region", "global", "GLOBAL", "REGION_GLOBAL_ALLOWED"],
    ["region free", "free", "REGION_FREE", "REGION_FREE_ALLOWED"],
    ["US-only region", "us", "INCOMPATIBLE", "REGION_INCOMPATIBLE"],
  ] as const)(
    "uses documented supplier-region semantics for %s",
    (_name, supplierRegionId, semantic, reasonCode) => {
      const engine = new GermanyEligibilityEngine({
        regionSemantics: new StaticRegionSemanticRegistry([
          { semantic, supplierId: supplier, supplierRegionId },
        ]),
      });

      const result = engine.evaluate({
        evidence: evidence({
          supplierRegion: {
            documentedSemanticsUrl: "https://example.test/regions",
            supplierRegionId,
          },
        }),
        supplierId: supplier,
      });

      expect(result.reasonCode).toBe(reasonCode);
      expect(result.policyVersion).toBe(germanyEligibilityPolicyVersion);
    },
  );

  it("fails closed when a supplier region has no registered semantics", () => {
    const result = new GermanyEligibilityEngine({
      regionSemantics: new StaticRegionSemanticRegistry(),
    }).evaluate({
      evidence: evidence({
        supplierRegion: { supplierRegionId: "unmapped" },
      }),
      supplierId: supplier,
    });

    expect(result).toMatchObject({
      decision: "REVIEW_REQUIRED",
      reasonCode: "REGION_UNKNOWN_VALUE",
    });
  });

  it("supplier disable overrides permissive evidence", () => {
    const result = new GermanyEligibilityEngine({
      supplierDisabled: true,
    }).evaluate({
      evidence: evidence({ allowedCountries: [regionCode("DE")] }),
      supplierId: supplier,
    });

    expect(result).toMatchObject({
      decision: "DISABLED",
      reasonCode: "MANUAL_OR_SUPPLIER_DISABLED",
    });
  });

  it("does not infer arbitrary display strings as allow evidence", () => {
    const result = new GermanyEligibilityEngine().evaluate({
      evidence: evidence({
        supplierRegion: {
          documentedSemanticsSummary: "Germany and EU allowed",
          supplierRegionId: "marketing-copy-only",
        },
      }),
      supplierId: supplier,
    });

    expect(result.decision).toBe("REVIEW_REQUIRED");
  });

  it.each([
    ["DE excluded beats EU allow", "eu", "EU_INCLUDING_DE", ["DE"], "BLOCKED"],
    ["DE excluded beats global allow", "global", "GLOBAL", ["DE"], "BLOCKED"],
    ["DE excluded beats region free", "free", "REGION_FREE", ["DE"], "BLOCKED"],
    [
      "AT excluded does not block DE semantic",
      "eu",
      "EU_INCLUDING_DE",
      ["AT"],
      "ALLOWED",
    ],
    [
      "FR excluded does not block global semantic",
      "global",
      "GLOBAL",
      ["FR"],
      "ALLOWED",
    ],
    [
      "US excluded does not block region free",
      "free",
      "REGION_FREE",
      ["US"],
      "ALLOWED",
    ],
    ["US-only remains blocked", "us", "INCOMPATIBLE", [], "BLOCKED"],
    [
      "unknown semantic remains review",
      "unknown",
      "UNKNOWN",
      [],
      "REVIEW_REQUIRED",
    ],
    ["CIS custom blocked", "cis", "INCOMPATIBLE", [], "BLOCKED"],
    ["LATAM custom blocked", "latam", "INCOMPATIBLE", [], "BLOCKED"],
    ["Asia custom blocked", "asia", "INCOMPATIBLE", [], "BLOCKED"],
    ["EU blocked by VPN", "eu", "EU_INCLUDING_DE", [], "BLOCKED", true],
    ["global blocked by VPN", "global", "GLOBAL", [], "BLOCKED", true],
    ["free blocked by VPN", "free", "REGION_FREE", [], "BLOCKED", true],
    ["US-only blocked by VPN", "us", "INCOMPATIBLE", [], "BLOCKED", true],
    [
      "EU review on missing",
      "eu",
      "EU_INCLUDING_DE",
      [],
      "REVIEW_REQUIRED",
      false,
      true,
    ],
    [
      "global review on missing",
      "global",
      "GLOBAL",
      [],
      "REVIEW_REQUIRED",
      false,
      true,
    ],
    [
      "free review on missing",
      "free",
      "REGION_FREE",
      [],
      "REVIEW_REQUIRED",
      false,
      true,
    ],
    [
      "US-only review on missing",
      "us",
      "INCOMPATIBLE",
      [],
      "REVIEW_REQUIRED",
      false,
      true,
    ],
    [
      "EU review on unknown",
      "eu",
      "EU_INCLUDING_DE",
      [],
      "REVIEW_REQUIRED",
      false,
      false,
      true,
    ],
    [
      "global review on unknown",
      "global",
      "GLOBAL",
      [],
      "REVIEW_REQUIRED",
      false,
      false,
      true,
    ],
    [
      "free review on unknown",
      "free",
      "REGION_FREE",
      [],
      "REVIEW_REQUIRED",
      false,
      false,
      true,
    ],
    [
      "US-only review on unknown",
      "us",
      "INCOMPATIBLE",
      [],
      "REVIEW_REQUIRED",
      false,
      false,
      true,
    ],
    [
      "EU review on contradiction",
      "eu",
      "EU_INCLUDING_DE",
      [],
      "REVIEW_REQUIRED",
      false,
      false,
      false,
      true,
    ],
    [
      "global review on contradiction",
      "global",
      "GLOBAL",
      [],
      "REVIEW_REQUIRED",
      false,
      false,
      false,
      true,
    ],
    [
      "free review on contradiction",
      "free",
      "REGION_FREE",
      [],
      "REVIEW_REQUIRED",
      false,
      false,
      false,
      true,
    ],
    [
      "US-only review on contradiction",
      "us",
      "INCOMPATIBLE",
      [],
      "REVIEW_REQUIRED",
      false,
      false,
      false,
      true,
    ],
    [
      "DE country allow beats unknown semantic",
      "unknown",
      "UNKNOWN",
      [],
      "ALLOWED",
      false,
      false,
      false,
      false,
      ["DE"],
    ],
    [
      "DE country allow beats incompatible semantic",
      "us",
      "INCOMPATIBLE",
      [],
      "ALLOWED",
      false,
      false,
      false,
      false,
      ["DE"],
    ],
    [
      "DE explicit exclusion beats country allow",
      "eu",
      "EU_INCLUDING_DE",
      ["DE"],
      "BLOCKED",
      false,
      false,
      false,
      false,
      ["DE"],
    ],
  ] as const)(
    "applies fail-closed precedence for %s",
    (
      _name,
      supplierRegionId,
      semantic,
      excluded,
      decision,
      requiresVpn = false,
      hasMissingValues = false,
      hasUnknownValues = false,
      hasContradictoryEvidence = false,
      allowed: readonly string[] = [],
    ) => {
      const engine = new GermanyEligibilityEngine({
        regionSemantics: new StaticRegionSemanticRegistry([
          { semantic, supplierId: supplier, supplierRegionId },
        ]),
      });

      const result = engine.evaluate({
        evidence: evidence({
          allowedCountries: allowed.map(regionCode),
          excludedCountries: excluded.map(regionCode),
          hasContradictoryEvidence,
          hasMissingValues,
          hasUnknownValues,
          requiresVpn,
          supplierRegion: { supplierRegionId },
        }),
        supplierId: supplier,
      });

      expect(result.decision).toBe(decision);
    },
  );
});
