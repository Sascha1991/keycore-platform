import type { SupplierId } from "../domain/identifiers.js";
import type {
  GermanyCompatibilityReasonCode,
  RegionCompatibilityAssessment,
  RegionEvidence,
} from "../domain/region.js";

export const germanyEligibilityPolicyVersion = "de-eligibility-v1" as const;

export type RegionSemantic =
  | "DE"
  | "EU_INCLUDING_DE"
  | "GLOBAL"
  | "REGION_FREE"
  | "INCOMPATIBLE"
  | "UNKNOWN";

export interface RegionSemanticLookup {
  resolve(input: {
    readonly supplierId: SupplierId;
    readonly supplierRegionId?: string;
  }): RegionSemantic;
}

export class StaticRegionSemanticRegistry implements RegionSemanticLookup {
  private readonly semanticsByKey = new Map<string, RegionSemantic>();

  public constructor(
    entries: readonly {
      readonly supplierId: SupplierId;
      readonly supplierRegionId: string;
      readonly semantic: RegionSemantic;
    }[] = [],
  ) {
    for (const entry of entries) {
      this.set(entry);
    }
  }

  public set(entry: {
    readonly supplierId: SupplierId;
    readonly supplierRegionId: string;
    readonly semantic: RegionSemantic;
  }): void {
    this.semanticsByKey.set(
      this.key(entry.supplierId, entry.supplierRegionId),
      entry.semantic,
    );
  }

  public resolve(input: {
    readonly supplierId: SupplierId;
    readonly supplierRegionId?: string;
  }): RegionSemantic {
    if (!input.supplierRegionId) {
      return "UNKNOWN";
    }

    return (
      this.semanticsByKey.get(
        this.key(input.supplierId, input.supplierRegionId),
      ) ?? "UNKNOWN"
    );
  }

  private key(supplierId: SupplierId, supplierRegionId: string): string {
    return `${supplierId}:${supplierRegionId}`;
  }
}

export interface GermanyEligibilityAssessment extends RegionCompatibilityAssessment {
  readonly policyVersion: typeof germanyEligibilityPolicyVersion;
}

export interface GermanyEligibilityEngineOptions {
  readonly regionSemantics?: RegionSemanticLookup;
  readonly supplierDisabled?: boolean;
}

export class GermanyEligibilityEngine {
  public constructor(
    private readonly options: GermanyEligibilityEngineOptions = {},
  ) {}

  public evaluate(input: {
    readonly supplierId: SupplierId;
    readonly evidence: RegionEvidence;
  }): GermanyEligibilityAssessment {
    const assessment = this.evaluateEvidence(input);
    return {
      ...assessment,
      policyVersion: germanyEligibilityPolicyVersion,
    };
  }

  private evaluateEvidence(input: {
    readonly supplierId: SupplierId;
    readonly evidence: RegionEvidence;
  }): RegionCompatibilityAssessment {
    const { evidence } = input;

    if (this.options.supplierDisabled) {
      return blocked("DISABLED", "MANUAL_OR_SUPPLIER_DISABLED", evidence);
    }

    if (hasCountry(evidence.excludedCountries, "DE")) {
      return blocked("BLOCKED", "REGION_DE_EXCLUDED", evidence);
    }

    if (
      evidence.requiresVpn === true ||
      evidence.activationRestrictions.some(
        (restriction) => restriction.kind === "VPN_REQUIRED",
      )
    ) {
      return blocked("BLOCKED", "VPN_ACTIVATION_BLOCKED", evidence);
    }

    if (
      evidence.requiresForeignAccount === true ||
      evidence.activationRestrictions.some(
        (restriction) => restriction.kind === "FOREIGN_ACCOUNT_REQUIRED",
      )
    ) {
      return blocked("BLOCKED", "FOREIGN_ACCOUNT_REQUIRED", evidence);
    }

    if (evidence.hasContradictoryEvidence) {
      return review("REGION_EVIDENCE_CONTRADICTORY", evidence);
    }

    if (
      evidence.hasMissingValues ||
      evidence.requiresVpn === "UNKNOWN" ||
      evidence.requiresForeignAccount === "UNKNOWN"
    ) {
      return review("REGION_EVIDENCE_MISSING", evidence);
    }

    if (
      evidence.hasUnknownValues ||
      evidence.activationRestrictions.some(
        (restriction) => restriction.kind === "UNKNOWN",
      )
    ) {
      return review("REGION_UNKNOWN_VALUE", evidence);
    }

    if (hasCountry(evidence.allowedCountries, "DE")) {
      return allowed("REGION_DE_ALLOWED", evidence);
    }

    const semantic = this.options.regionSemantics?.resolve({
      supplierId: input.supplierId,
      ...(evidence.supplierRegion?.supplierRegionId
        ? { supplierRegionId: evidence.supplierRegion.supplierRegionId }
        : {}),
    });

    if (semantic === "EU_INCLUDING_DE") {
      return allowed("REGION_EU_ALLOWED", evidence);
    }

    if (semantic === "GLOBAL") {
      return allowed("REGION_GLOBAL_ALLOWED", evidence);
    }

    if (semantic === "REGION_FREE") {
      return allowed("REGION_FREE_ALLOWED", evidence);
    }

    if (semantic === "INCOMPATIBLE") {
      return blocked("BLOCKED", "REGION_INCOMPATIBLE", evidence);
    }

    return review("REGION_UNKNOWN_VALUE", evidence);
  }
}

const hasCountry = (countries: readonly string[], country: string): boolean =>
  countries.some((candidate) => candidate.toUpperCase() === country);

const allowed = (
  reasonCode: GermanyCompatibilityReasonCode,
  evidence: RegionEvidence,
): RegionCompatibilityAssessment => ({
  decision: "ALLOWED",
  evidence,
  reasonCode,
});

const review = (
  reasonCode: GermanyCompatibilityReasonCode,
  evidence: RegionEvidence,
): RegionCompatibilityAssessment => ({
  decision: "REVIEW_REQUIRED",
  evidence,
  reasonCode,
});

const blocked = (
  decision: "BLOCKED" | "DISABLED",
  reasonCode: GermanyCompatibilityReasonCode,
  evidence: RegionEvidence,
): RegionCompatibilityAssessment => ({
  decision,
  evidence,
  reasonCode,
});
