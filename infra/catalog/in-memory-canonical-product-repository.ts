import {
  canonicalGroupingPolicyVersion,
  type CanonicalProductCandidate,
  type CanonicalProductGroupingRepository,
  type CanonicalProductIdentifierEvidence,
  type CanonicalProductMappingRecord,
  type CanonicalProductRecord,
  type CanonicalProductSafeEvidenceSnapshot,
} from "../../packages/platform/src/catalog/canonical-product-grouping.js";
import {
  productId,
  type ProductId,
  type SupplierId,
  type SupplierProductId,
} from "../../packages/platform/src/contracts.js";

export class InMemoryCanonicalProductGroupingRepository implements CanonicalProductGroupingRepository {
  private readonly products = new Map<string, CanonicalProductRecord>();
  private readonly mappings = new Map<string, CanonicalProductMappingRecord>();
  private readonly identifiersByKey = new Map<
    string,
    {
      readonly productId: ProductId;
      readonly identifier: CanonicalProductIdentifierEvidence;
    }[]
  >();
  private nextProductSequence = 1;

  public constructor(seed?: {
    readonly products?: readonly CanonicalProductRecord[];
    readonly mappings?: readonly CanonicalProductMappingRecord[];
    readonly identifiers?: readonly {
      readonly productId: ProductId;
      readonly identifier: CanonicalProductIdentifierEvidence;
    }[];
  }) {
    for (const product of seed?.products ?? []) {
      this.products.set(product.productId, product);
    }
    for (const mapping of seed?.mappings ?? []) {
      this.mappings.set(mappingKey(mapping), mapping);
    }
    for (const identifier of seed?.identifiers ?? []) {
      this.addIdentifier(identifier.productId, identifier.identifier);
    }
  }

  public async findMapping(input: {
    readonly supplierId: SupplierId;
    readonly supplierProductId: SupplierProductId;
  }): Promise<CanonicalProductMappingRecord | null> {
    return this.mappings.get(mappingKey(input)) ?? null;
  }

  public async createCanonicalProduct(
    input: Parameters<
      CanonicalProductGroupingRepository["createCanonicalProduct"]
    >[0],
  ): Promise<CanonicalProductRecord> {
    const record: CanonicalProductRecord = {
      active: true,
      canonicalTitle: input.evidence.title,
      confidenceState: "LOW",
      createdAt: input.now,
      lifecycle: input.evidence.lifecycle,
      platforms: [...input.evidence.platforms].sort(),
      productId: productId(`canonical-product-${this.nextProductSequence}`),
      productType: input.evidence.productType,
      updatedAt: input.now,
    };
    this.nextProductSequence += 1;
    this.products.set(record.productId, record);
    return record;
  }

  public async findCandidatesByStrongIdentifier(input: {
    readonly identifiers: readonly CanonicalProductIdentifierEvidence[];
  }): Promise<readonly CanonicalProductCandidate[]> {
    const candidates: CanonicalProductCandidate[] = [];
    for (const identifier of input.identifiers) {
      for (const entry of this.identifiersByKey.get(
        identifierKey(identifier),
      ) ?? []) {
        const product = this.products.get(entry.productId);
        if (product) {
          candidates.push({ identifier: entry.identifier, product });
        }
      }
    }
    return candidates.sort((left, right) =>
      left.product.productId.localeCompare(right.product.productId),
    );
  }

  public async createOrUpdateMapping(input: {
    readonly mapping: CanonicalProductMappingRecord;
  }): Promise<CanonicalProductMappingRecord> {
    const existing = this.mappings.get(mappingKey(input.mapping));
    if (
      existing?.productId &&
      input.mapping.productId &&
      existing.productId !== input.mapping.productId &&
      input.mapping.decisionSource !== "MANUAL"
    ) {
      const conflict: CanonicalProductMappingRecord = {
        ...existing,
        evidence: input.mapping.evidence,
        reasonCode: "MAPPED_PRODUCT_REASSIGNMENT_REVIEW_REQUIRED",
        state: "REVIEW_REQUIRED",
        updatedAt: input.mapping.updatedAt,
      };
      this.mappings.set(mappingKey(conflict), conflict);
      return conflict;
    }

    const record: CanonicalProductMappingRecord = {
      ...input.mapping,
      createdAt: existing?.createdAt ?? input.mapping.createdAt,
    };
    this.mappings.set(mappingKey(record), record);
    return record;
  }

  public async saveIdentifiers(input: {
    readonly productId: ProductId;
    readonly identifiers: readonly CanonicalProductIdentifierEvidence[];
  }): Promise<void> {
    for (const identifier of input.identifiers) {
      this.addIdentifier(input.productId, identifier);
    }
  }

  public async listSupplierProductsForCanonicalProduct(
    productId: ProductId,
  ): Promise<readonly CanonicalProductMappingRecord[]> {
    return [...this.mappings.values()]
      .filter((mapping) => mapping.productId === productId)
      .sort((left, right) =>
        `${left.supplierId}:${left.supplierProductId}`.localeCompare(
          `${right.supplierId}:${right.supplierProductId}`,
        ),
      );
  }

  public listMappings(): readonly CanonicalProductMappingRecord[] {
    return [...this.mappings.values()].sort((left, right) =>
      `${left.supplierId}:${left.supplierProductId}`.localeCompare(
        `${right.supplierId}:${right.supplierProductId}`,
      ),
    );
  }

  public listProducts(): readonly CanonicalProductRecord[] {
    return [...this.products.values()].sort((left, right) =>
      left.productId.localeCompare(right.productId),
    );
  }

  public putProduct(product: CanonicalProductRecord): void {
    this.products.set(product.productId, product);
  }

  public getMappingEvidence(input: {
    readonly supplierId: SupplierId;
    readonly supplierProductId: SupplierProductId;
  }): CanonicalProductSafeEvidenceSnapshot | null {
    return this.mappings.get(mappingKey(input))?.evidence ?? null;
  }

  public clone(): InMemoryCanonicalProductGroupingRepository {
    return new InMemoryCanonicalProductGroupingRepository({
      identifiers: [...this.identifiersByKey.values()].flat(),
      mappings: [...this.mappings.values()],
      products: [...this.products.values()],
    });
  }

  private addIdentifier(
    productId: ProductId,
    identifier: CanonicalProductIdentifierEvidence,
  ): void {
    const key = identifierKey(identifier);
    const existing = this.identifiersByKey.get(key) ?? [];
    if (!existing.some((entry) => entry.productId === productId)) {
      this.identifiersByKey.set(key, [...existing, { identifier, productId }]);
    }
  }
}

export const createManualMappingRecord = (input: {
  readonly supplierId: SupplierId;
  readonly supplierProductId: SupplierProductId;
  readonly productId: ProductId;
  readonly evidence: CanonicalProductSafeEvidenceSnapshot;
  readonly now: Date;
}): CanonicalProductMappingRecord => ({
  confidence: "STRONG",
  createdAt: input.now,
  decisionSource: "MANUAL",
  evidence: input.evidence,
  policyVersion: canonicalGroupingPolicyVersion,
  productId: input.productId,
  reasonCode: "MANUAL_MATCH",
  state: "MANUAL_MATCHED",
  supplierId: input.supplierId,
  supplierProductId: input.supplierProductId,
  updatedAt: input.now,
});

const mappingKey = (input: {
  readonly supplierId: SupplierId;
  readonly supplierProductId: SupplierProductId;
}): string => `${input.supplierId}:${input.supplierProductId}`;

const identifierKey = (
  identifier: CanonicalProductIdentifierEvidence,
): string => `${identifier.type}:${identifier.value}`;
