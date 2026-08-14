import type { Availability, Platform, ProductType } from "../domain/catalog.js";
import type {
  ProductId,
  SupplierId,
  SupplierProductId,
} from "../domain/identifiers.js";

export const canonicalGroupingPolicyVersion = "canonical-grouping-v1" as const;

export const canonicalGroupingStates = [
  "UNMATCHED",
  "AUTO_MATCHED",
  "MANUAL_MATCHED",
  "REVIEW_REQUIRED",
  "REJECTED",
  "DETACHED",
] as const;

export type CanonicalGroupingState = (typeof canonicalGroupingStates)[number];

export const canonicalGroupingOutcomes = [
  "AUTO_MATCHED",
  "NEW_CANONICAL_PRODUCT",
  "REVIEW_REQUIRED",
  "REJECTED",
  "CONFLICT",
] as const;

export type CanonicalGroupingOutcome =
  (typeof canonicalGroupingOutcomes)[number];

export const canonicalGroupingReasonCodes = [
  "NEW_CANONICAL_PRODUCT_CREATED",
  "EXISTING_MAPPING_RETURNED",
  "STRONG_IDENTIFIER_MATCH",
  "STRONG_IDENTIFIER_CONFLICT",
  "MULTIPLE_STRONG_IDENTIFIER_CANDIDATES",
  "TITLE_ONLY_REVIEW_REQUIRED",
  "SUPPORTING_EVIDENCE_REVIEW_REQUIRED",
  "PRODUCT_TYPE_INCOMPATIBLE",
  "PLATFORM_INCOMPATIBLE",
  "EDITION_INCOMPATIBLE",
  "MAPPED_PRODUCT_REASSIGNMENT_REVIEW_REQUIRED",
  "MANUAL_MATCH",
  "MANUAL_DETACH",
  "MANUAL_REJECT",
] as const;

export type CanonicalGroupingReasonCode =
  (typeof canonicalGroupingReasonCodes)[number];

export const editionMarkers = [
  "STANDARD",
  "DELUXE",
  "ULTIMATE",
  "GOTY",
  "COMPLETE",
  "BUNDLE",
  "DLC",
  "SEASON_PASS",
  "UNKNOWN",
] as const;

export type EditionMarker = (typeof editionMarkers)[number];

export type CanonicalIdentifierType =
  | "STEAM_APP_ID"
  | "PUBLISHER_PRODUCT_ID"
  | "PLATFORM_STORE_ID"
  | "GTIN"
  | "UPC"
  | "EAN"
  | "OFFICIAL_PRODUCT_ID";

export interface CanonicalProductIdentifierEvidence {
  readonly type: CanonicalIdentifierType;
  readonly value: string;
  readonly verified: boolean;
  readonly trustedSource: string;
}

export interface CanonicalProductEvidence {
  readonly supplierId: SupplierId;
  readonly supplierProductId: SupplierProductId;
  readonly title: string;
  readonly productType: ProductType;
  readonly platforms: readonly Platform[];
  readonly lifecycle: Availability;
  readonly identifiers: readonly CanonicalProductIdentifierEvidence[];
  readonly publisher?: string;
  readonly developer?: string;
  readonly releaseDate?: string;
  readonly edition?: EditionMarker;
  readonly germanyEligibility?:
    "ALLOWED" | "BLOCKED" | "REVIEW_REQUIRED" | "DISABLED";
}

export interface CanonicalProductRecord {
  readonly productId: ProductId;
  readonly canonicalTitle: string;
  readonly productType: ProductType;
  readonly platforms: readonly Platform[];
  readonly lifecycle: Availability;
  readonly active: boolean;
  readonly confidenceState: "LOW" | "MEDIUM" | "HIGH" | "REVIEW";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CanonicalProductMappingRecord {
  readonly supplierId: SupplierId;
  readonly supplierProductId: SupplierProductId;
  readonly productId?: ProductId;
  readonly state: CanonicalGroupingState;
  readonly decisionSource: "AUTO" | "MANUAL" | "SYSTEM";
  readonly confidence: "NONE" | "WEAK" | "MEDIUM" | "STRONG";
  readonly reasonCode: CanonicalGroupingReasonCode;
  readonly policyVersion: typeof canonicalGroupingPolicyVersion;
  readonly evidence: CanonicalProductSafeEvidenceSnapshot;
  readonly actorRef?: string;
  readonly reason?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CanonicalProductSafeEvidenceSnapshot {
  readonly normalizedTitle: string;
  readonly productType: ProductType;
  readonly platforms: readonly Platform[];
  readonly edition: EditionMarker;
  readonly identifierTypes: readonly CanonicalIdentifierType[];
}

export interface CanonicalProductCandidate {
  readonly product: CanonicalProductRecord;
  readonly identifier: CanonicalProductIdentifierEvidence;
}

export interface CanonicalProductGroupingResult {
  readonly outcome: CanonicalGroupingOutcome;
  readonly state: CanonicalGroupingState;
  readonly reasonCode: CanonicalGroupingReasonCode;
  readonly productId?: ProductId;
  readonly mapping: CanonicalProductMappingRecord;
}

export interface CanonicalProductAuditEvent {
  readonly eventType:
    | "CANONICAL_PRODUCT_CREATED"
    | "SUPPLIER_PRODUCT_AUTO_MATCHED"
    | "SUPPLIER_PRODUCT_MANUAL_MATCHED"
    | "SUPPLIER_PRODUCT_MATCH_REVIEW_REQUIRED"
    | "SUPPLIER_PRODUCT_MAPPING_DETACHED"
    | "SUPPLIER_PRODUCT_MAPPING_CONFLICT";
  readonly occurredAt: Date;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface CanonicalProductAuditPort {
  record(event: CanonicalProductAuditEvent): Promise<void>;
}

export interface CanonicalProductGroupingRepository {
  findMapping(input: {
    readonly supplierId: SupplierId;
    readonly supplierProductId: SupplierProductId;
  }): Promise<CanonicalProductMappingRecord | null>;
  createCanonicalProduct(input: {
    readonly evidence: CanonicalProductEvidence;
    readonly normalizedTitle: string;
    readonly edition: EditionMarker;
    readonly now: Date;
  }): Promise<CanonicalProductRecord>;
  findCandidatesByStrongIdentifier(input: {
    readonly identifiers: readonly CanonicalProductIdentifierEvidence[];
  }): Promise<readonly CanonicalProductCandidate[]>;
  createOrUpdateMapping(input: {
    readonly mapping: CanonicalProductMappingRecord;
  }): Promise<CanonicalProductMappingRecord>;
  saveIdentifiers(input: {
    readonly productId: ProductId;
    readonly identifiers: readonly CanonicalProductIdentifierEvidence[];
    readonly now: Date;
  }): Promise<void>;
  listSupplierProductsForCanonicalProduct(
    productId: ProductId,
  ): Promise<readonly CanonicalProductMappingRecord[]>;
}

export interface ManualGroupingCommand {
  readonly supplierId: SupplierId;
  readonly supplierProductId: SupplierProductId;
  readonly actorRef: string;
  readonly reason: string;
  readonly productId?: ProductId;
}

export interface CanonicalProductGroupingServiceOptions {
  readonly repository: CanonicalProductGroupingRepository;
  readonly audit?: CanonicalProductAuditPort;
  readonly now?: () => Date;
}

export class CanonicalProductGroupingService {
  private readonly now: () => Date;

  public constructor(
    private readonly options: CanonicalProductGroupingServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public async evaluateSupplierProduct(
    evidence: CanonicalProductEvidence,
  ): Promise<CanonicalProductGroupingResult> {
    const existing = await this.options.repository.findMapping(evidence);
    if (existing) {
      return {
        mapping: existing,
        outcome:
          existing.state === "REJECTED" || existing.state === "REVIEW_REQUIRED"
            ? "REVIEW_REQUIRED"
            : "AUTO_MATCHED",
        reasonCode: "EXISTING_MAPPING_RETURNED",
        state: existing.state,
        ...(existing.productId ? { productId: existing.productId } : {}),
      };
    }

    const normalizedTitle = normalizeProductTitle(evidence.title);
    const edition =
      evidence.edition ?? detectEdition(evidence.title, evidence.productType);
    const strongIdentifiers = strongVerifiedIdentifiers(evidence.identifiers);
    const candidates =
      await this.options.repository.findCandidatesByStrongIdentifier({
        identifiers: strongIdentifiers,
      });
    const uniqueCandidates = uniqueCandidatesByProduct(candidates);

    const rejection = evaluateFailClosedEvidence(
      evidence,
      edition,
      uniqueCandidates,
    );
    if (rejection) {
      const mapping = await this.options.repository.createOrUpdateMapping({
        mapping: this.mapping({
          confidence: strongIdentifiers.length > 0 ? "STRONG" : "WEAK",
          decisionSource: "AUTO",
          evidence,
          normalizedTitle,
          reasonCode: rejection.reasonCode,
          state: rejection.state,
          ...(rejection.productId ? { productId: rejection.productId } : {}),
        }),
      });
      await this.audit("SUPPLIER_PRODUCT_MAPPING_CONFLICT", mapping);
      return {
        mapping,
        outcome: rejection.outcome,
        reasonCode: rejection.reasonCode,
        state: mapping.state,
        ...(mapping.productId ? { productId: mapping.productId } : {}),
      };
    }

    if (uniqueCandidates.length === 1 && strongIdentifiers.length > 0) {
      const candidate = requiredCandidate(uniqueCandidates[0]);
      const mapping = await this.options.repository.createOrUpdateMapping({
        mapping: this.mapping({
          confidence: "STRONG",
          decisionSource: "AUTO",
          evidence,
          normalizedTitle,
          productId: candidate.product.productId,
          reasonCode: "STRONG_IDENTIFIER_MATCH",
          state: "AUTO_MATCHED",
        }),
      });
      await this.options.repository.saveIdentifiers({
        identifiers: strongIdentifiers,
        now: this.now(),
        productId: candidate.product.productId,
      });
      await this.audit("SUPPLIER_PRODUCT_AUTO_MATCHED", mapping);
      return {
        mapping,
        outcome: "AUTO_MATCHED",
        productId: candidate.product.productId,
        reasonCode: "STRONG_IDENTIFIER_MATCH",
        state: "AUTO_MATCHED",
      };
    }

    if (
      strongIdentifiers.length === 0 &&
      hasSupportingTitleEvidence(evidence)
    ) {
      const mapping = await this.options.repository.createOrUpdateMapping({
        mapping: this.mapping({
          confidence: "WEAK",
          decisionSource: "AUTO",
          evidence,
          normalizedTitle,
          reasonCode: hasSupportingTitleEvidence(evidence)
            ? "SUPPORTING_EVIDENCE_REVIEW_REQUIRED"
            : "TITLE_ONLY_REVIEW_REQUIRED",
          state: "REVIEW_REQUIRED",
        }),
      });
      await this.audit("SUPPLIER_PRODUCT_MATCH_REVIEW_REQUIRED", mapping);
      return {
        mapping,
        outcome: "REVIEW_REQUIRED",
        reasonCode: mapping.reasonCode,
        state: "REVIEW_REQUIRED",
      };
    }

    const product = await this.options.repository.createCanonicalProduct({
      edition,
      evidence,
      normalizedTitle,
      now: this.now(),
    });
    await this.options.repository.saveIdentifiers({
      identifiers: strongIdentifiers,
      now: this.now(),
      productId: product.productId,
    });
    const mapping = await this.options.repository.createOrUpdateMapping({
      mapping: this.mapping({
        confidence: strongIdentifiers.length > 0 ? "STRONG" : "NONE",
        decisionSource: "SYSTEM",
        evidence,
        normalizedTitle,
        productId: product.productId,
        reasonCode: "NEW_CANONICAL_PRODUCT_CREATED",
        state: "UNMATCHED",
      }),
    });
    await this.audit("CANONICAL_PRODUCT_CREATED", mapping);
    return {
      mapping,
      outcome: "NEW_CANONICAL_PRODUCT",
      productId: product.productId,
      reasonCode: "NEW_CANONICAL_PRODUCT_CREATED",
      state: "UNMATCHED",
    };
  }

  public async manualMatch(
    command: ManualGroupingCommand & { readonly productId: ProductId },
    evidence: CanonicalProductEvidence,
  ): Promise<CanonicalProductMappingRecord> {
    const mapping = await this.options.repository.createOrUpdateMapping({
      mapping: this.mapping({
        actorRef: command.actorRef,
        confidence: "STRONG",
        decisionSource: "MANUAL",
        evidence,
        normalizedTitle: normalizeProductTitle(evidence.title),
        productId: command.productId,
        reason: command.reason,
        reasonCode: "MANUAL_MATCH",
        state: "MANUAL_MATCHED",
      }),
    });
    await this.audit("SUPPLIER_PRODUCT_MANUAL_MATCHED", mapping);
    return mapping;
  }

  public async detach(
    command: ManualGroupingCommand,
    evidence: CanonicalProductEvidence,
  ): Promise<CanonicalProductMappingRecord> {
    const mapping = await this.options.repository.createOrUpdateMapping({
      mapping: this.mapping({
        actorRef: command.actorRef,
        confidence: "NONE",
        decisionSource: "MANUAL",
        evidence,
        normalizedTitle: normalizeProductTitle(evidence.title),
        reason: command.reason,
        reasonCode: "MANUAL_DETACH",
        state: "DETACHED",
      }),
    });
    await this.audit("SUPPLIER_PRODUCT_MAPPING_DETACHED", mapping);
    return mapping;
  }

  public async reject(
    command: ManualGroupingCommand,
    evidence: CanonicalProductEvidence,
  ): Promise<CanonicalProductMappingRecord> {
    const mapping = await this.options.repository.createOrUpdateMapping({
      mapping: this.mapping({
        actorRef: command.actorRef,
        confidence: "NONE",
        decisionSource: "MANUAL",
        evidence,
        normalizedTitle: normalizeProductTitle(evidence.title),
        reason: command.reason,
        reasonCode: "MANUAL_REJECT",
        state: "REJECTED",
      }),
    });
    await this.audit("SUPPLIER_PRODUCT_MAPPING_CONFLICT", mapping);
    return mapping;
  }

  public async reEvaluate(
    evidence: CanonicalProductEvidence,
  ): Promise<CanonicalProductGroupingResult> {
    const existing = await this.options.repository.findMapping(evidence);
    const evaluated = await this.evaluateSupplierProduct(evidence);
    if (
      existing?.productId &&
      evaluated.productId &&
      existing.productId !== evaluated.productId
    ) {
      const mapping = await this.options.repository.createOrUpdateMapping({
        mapping: {
          ...evaluated.mapping,
          productId: existing.productId,
          reasonCode: "MAPPED_PRODUCT_REASSIGNMENT_REVIEW_REQUIRED",
          state: "REVIEW_REQUIRED",
          updatedAt: this.now(),
        },
      });
      await this.audit("SUPPLIER_PRODUCT_MATCH_REVIEW_REQUIRED", mapping);
      return {
        mapping,
        outcome: "REVIEW_REQUIRED",
        productId: existing.productId,
        reasonCode: "MAPPED_PRODUCT_REASSIGNMENT_REVIEW_REQUIRED",
        state: "REVIEW_REQUIRED",
      };
    }

    return evaluated;
  }

  private mapping(input: {
    readonly evidence: CanonicalProductEvidence;
    readonly normalizedTitle: string;
    readonly state: CanonicalGroupingState;
    readonly decisionSource: "AUTO" | "MANUAL" | "SYSTEM";
    readonly confidence: "NONE" | "WEAK" | "MEDIUM" | "STRONG";
    readonly reasonCode: CanonicalGroupingReasonCode;
    readonly productId?: ProductId;
    readonly actorRef?: string;
    readonly reason?: string;
  }): CanonicalProductMappingRecord {
    const now = this.now();
    return {
      confidence: input.confidence,
      createdAt: now,
      decisionSource: input.decisionSource,
      evidence: safeEvidenceSnapshot(input.evidence, input.normalizedTitle),
      policyVersion: canonicalGroupingPolicyVersion,
      reasonCode: input.reasonCode,
      state: input.state,
      supplierId: input.evidence.supplierId,
      supplierProductId: input.evidence.supplierProductId,
      updatedAt: now,
      ...(input.productId ? { productId: input.productId } : {}),
      ...(input.actorRef ? { actorRef: input.actorRef } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    };
  }

  private async audit(
    eventType: CanonicalProductAuditEvent["eventType"],
    mapping: CanonicalProductMappingRecord,
  ): Promise<void> {
    await this.options.audit?.record({
      eventType,
      metadata: {
        evidenceTypes: mapping.evidence.identifierTypes.join(","),
        policyVersion: mapping.policyVersion,
        reasonCode: mapping.reasonCode,
        state: mapping.state,
        supplierId: mapping.supplierId,
        supplierProductId: mapping.supplierProductId,
        ...(mapping.productId ? { productId: mapping.productId } : {}),
      },
      occurredAt: this.now(),
    });
  }
}

export const normalizeProductTitle = (title: string): string =>
  title
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[._:|()[\]{}]+/gu, " ")
    .replace(/\s*[-/]\s*/gu, " ")
    .replace(/\s+/gu, " ");

export const detectEdition = (
  title: string,
  productType: ProductType,
): EditionMarker => {
  const normalized = ` ${normalizeProductTitle(title)} `;
  if (productType === "DLC" || /\bdlc\b/u.test(normalized)) {
    return "DLC";
  }
  if (/\bseason pass\b/u.test(normalized)) {
    return "SEASON_PASS";
  }
  if (/\bbundle\b/u.test(normalized)) {
    return "BUNDLE";
  }
  if (/\bultimate\b/u.test(normalized)) {
    return "ULTIMATE";
  }
  if (/\bdeluxe\b/u.test(normalized)) {
    return "DELUXE";
  }
  if (/\b(goty|game of the year)\b/u.test(normalized)) {
    return "GOTY";
  }
  if (/\bcomplete\b/u.test(normalized)) {
    return "COMPLETE";
  }
  if (/\bstandard\b/u.test(normalized)) {
    return "STANDARD";
  }
  return "UNKNOWN";
};

export const strongVerifiedIdentifiers = (
  identifiers: readonly CanonicalProductIdentifierEvidence[],
): readonly CanonicalProductIdentifierEvidence[] =>
  identifiers
    .filter(
      (identifier) =>
        identifier.verified &&
        identifier.value.trim().length > 0 &&
        identifier.trustedSource.trim().length > 0,
    )
    .map((identifier) => ({
      ...identifier,
      value: normalizeIdentifierValue(identifier),
    }))
    .filter((identifier) => identifier.value.length > 0)
    .sort((left, right) =>
      `${left.type}:${left.value}`.localeCompare(
        `${right.type}:${right.value}`,
      ),
    );

export const safeEvidenceSnapshot = (
  evidence: CanonicalProductEvidence,
  normalizedTitle = normalizeProductTitle(evidence.title),
): CanonicalProductSafeEvidenceSnapshot => ({
  edition:
    evidence.edition ?? detectEdition(evidence.title, evidence.productType),
  identifierTypes: [
    ...new Set(
      evidence.identifiers.map((identifier) => identifier.type).sort(),
    ),
  ],
  normalizedTitle,
  platforms: [...evidence.platforms].sort(),
  productType: evidence.productType,
});

const normalizeIdentifierValue = (
  identifier: CanonicalProductIdentifierEvidence,
): string => {
  const value = identifier.value.trim();
  if (identifier.type === "STEAM_APP_ID") {
    if (!/^\d+$/u.test(value)) {
      return "";
    }
    return String(Number.parseInt(value, 10));
  }
  return value.toUpperCase();
};

const evaluateFailClosedEvidence = (
  evidence: CanonicalProductEvidence,
  edition: EditionMarker,
  candidates: readonly CanonicalProductCandidate[],
): {
  readonly outcome: "CONFLICT" | "REVIEW_REQUIRED" | "REJECTED";
  readonly state: "REVIEW_REQUIRED" | "REJECTED";
  readonly reasonCode: CanonicalGroupingReasonCode;
  readonly productId?: ProductId;
} | null => {
  if (candidates.length > 1) {
    return {
      outcome: "REVIEW_REQUIRED",
      reasonCode: "MULTIPLE_STRONG_IDENTIFIER_CANDIDATES",
      state: "REVIEW_REQUIRED",
    };
  }

  const candidate = candidates[0];
  if (!candidate) {
    return null;
  }

  if (candidate.product.productType !== evidence.productType) {
    return {
      outcome: "CONFLICT",
      productId: candidate.product.productId,
      reasonCode: "PRODUCT_TYPE_INCOMPATIBLE",
      state: "REVIEW_REQUIRED",
    };
  }

  const candidateEdition = detectEdition(
    candidate.product.canonicalTitle,
    candidate.product.productType,
  );
  if (
    (candidateEdition !== "UNKNOWN" || edition !== "UNKNOWN") &&
    candidateEdition !== edition
  ) {
    return {
      outcome: "REVIEW_REQUIRED",
      productId: candidate.product.productId,
      reasonCode: "EDITION_INCOMPATIBLE",
      state: "REVIEW_REQUIRED",
    };
  }

  if (!hasCompatiblePlatform(candidate.product.platforms, evidence.platforms)) {
    return {
      outcome: "REVIEW_REQUIRED",
      productId: candidate.product.productId,
      reasonCode: "PLATFORM_INCOMPATIBLE",
      state: "REVIEW_REQUIRED",
    };
  }

  return null;
};

const hasSupportingTitleEvidence = (
  evidence: CanonicalProductEvidence,
): boolean =>
  normalizeProductTitle(evidence.title).length > 0 &&
  (evidence.publisher !== undefined ||
    evidence.developer !== undefined ||
    evidence.releaseDate !== undefined);

const hasCompatiblePlatform = (
  left: readonly Platform[],
  right: readonly Platform[],
): boolean => {
  const leftSet = new Set(left);
  return right.some((platform) => leftSet.has(platform));
};

const uniqueCandidatesByProduct = (
  candidates: readonly CanonicalProductCandidate[],
): readonly CanonicalProductCandidate[] => {
  const seen = new Set<string>();
  const unique: CanonicalProductCandidate[] = [];
  for (const candidate of candidates) {
    if (!seen.has(candidate.product.productId)) {
      seen.add(candidate.product.productId);
      unique.push(candidate);
    }
  }
  return unique.sort((left, right) =>
    left.product.productId.localeCompare(right.product.productId),
  );
};

const requiredCandidate = (
  candidate: CanonicalProductCandidate | undefined,
): CanonicalProductCandidate => {
  if (!candidate) {
    throw new Error("Expected canonical product candidate");
  }
  return candidate;
};
