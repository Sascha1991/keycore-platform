import { brandString, type Brand } from "./brands.js";

export type RegionCode = Brand<string, "RegionCode">;

export const regionCode = (value: string): RegionCode => {
  if (value.trim().length === 0) {
    throw new Error("RegionCode must not be empty");
  }

  return brandString(value.toUpperCase(), "RegionCode");
};

export const germanyCompatibilityDecisions = [
  "ALLOWED",
  "BLOCKED",
  "REVIEW_REQUIRED",
  "DISABLED",
] as const;

export type GermanyCompatibilityDecision =
  (typeof germanyCompatibilityDecisions)[number];

export const germanyCompatibilityReasonCodes = [
  "REGION_DE_ALLOWED",
  "REGION_DE_EXCLUDED",
  "REGION_EU_ALLOWED",
  "REGION_GLOBAL_ALLOWED",
  "REGION_FREE_ALLOWED",
  "REGION_INCOMPATIBLE",
  "VPN_ACTIVATION_BLOCKED",
  "FOREIGN_ACCOUNT_REQUIRED",
  "REGION_EVIDENCE_MISSING",
  "REGION_EVIDENCE_CONTRADICTORY",
  "REGION_UNKNOWN_VALUE",
  "MANUAL_OR_SUPPLIER_DISABLED",
] as const;

export type GermanyCompatibilityReasonCode =
  (typeof germanyCompatibilityReasonCodes)[number];

export interface SupplierRegionReference {
  readonly supplierRegionId: string;
  readonly documentedSemanticsUrl?: string;
  readonly documentedSemanticsSummary?: string;
}

export interface ActivationRestriction {
  readonly kind:
    | "VPN_REQUIRED"
    | "FOREIGN_ACCOUNT_REQUIRED"
    | "COUNTRY_RESTRICTED"
    | "UNKNOWN";
  readonly description?: string;
}

export interface RegionEvidence {
  readonly allowedCountries: readonly RegionCode[];
  readonly excludedCountries: readonly RegionCode[];
  readonly supplierRegion?: SupplierRegionReference;
  readonly requiresVpn: boolean | "UNKNOWN";
  readonly requiresForeignAccount: boolean | "UNKNOWN";
  readonly activationRestrictions: readonly ActivationRestriction[];
  readonly hasMissingValues: boolean;
  readonly hasUnknownValues: boolean;
  readonly hasContradictoryEvidence: boolean;
}

export interface RegionCompatibilityAssessment {
  readonly decision: GermanyCompatibilityDecision;
  readonly reasonCode: GermanyCompatibilityReasonCode;
  readonly evidence: RegionEvidence;
}

export const emptyRegionEvidence = (): RegionEvidence => ({
  activationRestrictions: [],
  allowedCountries: [],
  excludedCountries: [],
  hasContradictoryEvidence: false,
  hasMissingValues: true,
  hasUnknownValues: true,
  requiresForeignAccount: "UNKNOWN",
  requiresVpn: "UNKNOWN",
});

export const validateRegionEvidence = (
  evidence: RegionEvidence,
): RegionCompatibilityAssessment => {
  if (
    evidence.hasMissingValues ||
    evidence.hasUnknownValues ||
    evidence.hasContradictoryEvidence ||
    evidence.requiresVpn === "UNKNOWN" ||
    evidence.requiresForeignAccount === "UNKNOWN"
  ) {
    return {
      decision: "REVIEW_REQUIRED",
      evidence,
      reasonCode: evidence.hasContradictoryEvidence
        ? "REGION_EVIDENCE_CONTRADICTORY"
        : evidence.hasMissingValues
          ? "REGION_EVIDENCE_MISSING"
          : "REGION_UNKNOWN_VALUE",
    };
  }

  return {
    decision: "REVIEW_REQUIRED",
    evidence,
    reasonCode: "REGION_EVIDENCE_MISSING",
  };
};
