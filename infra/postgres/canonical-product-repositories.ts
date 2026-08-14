import type { QueryParameters, Queryable } from "./client.js";
import {
  productId,
  supplierProductId,
  type ProductId,
  type SupplierId,
  type SupplierProductId,
} from "../../packages/platform/src/contracts.js";
import type {
  CanonicalProductCandidate,
  CanonicalProductGroupingRepository,
  CanonicalProductIdentifierEvidence,
  CanonicalProductMappingRecord,
  CanonicalProductRecord,
  CanonicalProductSafeEvidenceSnapshot,
} from "../../packages/platform/src/catalog/canonical-product-grouping.js";

interface ProductRow {
  readonly id: string;
  readonly title: string;
  readonly product_type: CanonicalProductRecord["productType"];
  readonly platform: string;
  readonly lifecycle: CanonicalProductRecord["lifecycle"];
  readonly active: boolean;
  readonly canonical_metadata_confidence: CanonicalProductRecord["confidenceState"];
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MappingRow {
  readonly supplier_code: string;
  readonly supplier_product_external_id: string;
  readonly product_id: string | null;
  readonly state: CanonicalProductMappingRecord["state"];
  readonly decision_source: CanonicalProductMappingRecord["decisionSource"];
  readonly confidence: CanonicalProductMappingRecord["confidence"];
  readonly reason_code: CanonicalProductMappingRecord["reasonCode"];
  readonly policy_version: CanonicalProductMappingRecord["policyVersion"];
  readonly evidence: CanonicalProductSafeEvidenceSnapshot;
  readonly actor_ref: string | null;
  readonly reason: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface CandidateRow extends ProductRow {
  readonly identifier_type: CanonicalProductIdentifierEvidence["type"];
  readonly identifier_value: string;
  readonly trusted_source: string;
  readonly verified: boolean;
}

interface IdRow {
  readonly id: string;
}

export class PostgresCanonicalProductGroupingRepository implements CanonicalProductGroupingRepository {
  public constructor(private readonly db: Queryable) {}

  public async findMapping(input: {
    readonly supplierId: SupplierId;
    readonly supplierProductId: SupplierProductId;
  }): Promise<CanonicalProductMappingRecord | null> {
    const result = await this.db.query<MappingRow>(
      `
        SELECT suppliers.supplier_code,
          supplier_products.supplier_product_id AS supplier_product_external_id,
          supplier_product_canonical_mappings.product_id::text,
          state, decision_source, confidence, reason_code, policy_version,
          evidence, actor_ref, reason,
          supplier_product_canonical_mappings.created_at,
          supplier_product_canonical_mappings.updated_at
        FROM supplier_product_canonical_mappings
        JOIN suppliers ON suppliers.id = supplier_product_canonical_mappings.supplier_id
        JOIN supplier_products ON supplier_products.id = supplier_product_canonical_mappings.supplier_product_id
        WHERE suppliers.supplier_code = $1 AND supplier_products.supplier_product_id = $2
      `,
      [input.supplierId, input.supplierProductId],
    );
    const row = result.rows[0];
    return row ? mappingFromRow(row) : null;
  }

  public async createCanonicalProduct(
    input: Parameters<
      CanonicalProductGroupingRepository["createCanonicalProduct"]
    >[0],
  ): Promise<CanonicalProductRecord> {
    const row = await this.queryOne<ProductRow>(
      `
        INSERT INTO products(
          product_type, title, platform, lifecycle, active,
          canonical_metadata_confidence, canonical_metadata, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, true, 'LOW', $5::jsonb, $6, $6)
        RETURNING id::text, title, product_type, platform, lifecycle, active,
          canonical_metadata_confidence, created_at, updated_at
      `,
      [
        input.evidence.productType,
        input.evidence.title,
        input.evidence.platforms[0] ?? "UNKNOWN",
        input.evidence.lifecycle,
        JSON.stringify({
          edition: input.edition,
          normalizedTitle: input.normalizedTitle,
        }),
        input.now,
      ],
    );
    return productFromRow(row);
  }

  public async findCandidatesByStrongIdentifier(input: {
    readonly identifiers: readonly CanonicalProductIdentifierEvidence[];
  }): Promise<readonly CanonicalProductCandidate[]> {
    if (input.identifiers.length === 0) {
      return [];
    }

    const result = await this.db.query<CandidateRow>(
      `
        SELECT products.id::text, products.title, products.product_type,
          products.platform, products.lifecycle, products.active,
          products.canonical_metadata_confidence, products.created_at,
          products.updated_at,
          canonical_product_identifiers.identifier_type,
          canonical_product_identifiers.identifier_value,
          canonical_product_identifiers.trusted_source,
          canonical_product_identifiers.verified
        FROM canonical_product_identifiers
        JOIN products ON products.id = canonical_product_identifiers.product_id
        WHERE canonical_product_identifiers.verified = true
          AND (canonical_product_identifiers.identifier_type, canonical_product_identifiers.identifier_value)
            IN (${input.identifiers.map((_identifier, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(", ")})
        ORDER BY products.id::text
      `,
      input.identifiers.flatMap((identifier) => [
        identifier.type,
        identifier.value,
      ]),
    );
    return result.rows.map((row) => ({
      identifier: {
        trustedSource: row.trusted_source,
        type: row.identifier_type,
        value: row.identifier_value,
        verified: row.verified,
      },
      product: productFromRow(row),
    }));
  }

  public async createOrUpdateMapping(input: {
    readonly mapping: CanonicalProductMappingRecord;
  }): Promise<CanonicalProductMappingRecord> {
    const supplierUuid = await this.ensureSupplier(input.mapping.supplierId);
    const supplierProductUuid = await this.ensureSupplierProduct(
      supplierUuid,
      input.mapping,
    );
    const existing = await this.findMapping(input.mapping);
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
      return this.createOrUpdateMapping({ mapping: conflict });
    }

    const row = await this.queryOne<MappingRow>(
      `
        INSERT INTO supplier_product_canonical_mappings(
          supplier_id, supplier_product_id, product_id, state, decision_source,
          confidence, reason_code, policy_version, evidence, actor_ref, reason,
          created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
        ON CONFLICT (supplier_id, supplier_product_id)
        DO UPDATE SET
          product_id = EXCLUDED.product_id,
          state = EXCLUDED.state,
          decision_source = EXCLUDED.decision_source,
          confidence = EXCLUDED.confidence,
          reason_code = EXCLUDED.reason_code,
          policy_version = EXCLUDED.policy_version,
          evidence = EXCLUDED.evidence,
          actor_ref = EXCLUDED.actor_ref,
          reason = EXCLUDED.reason,
          updated_at = EXCLUDED.updated_at
        RETURNING
          (SELECT supplier_code FROM suppliers WHERE suppliers.id = supplier_product_canonical_mappings.supplier_id) AS supplier_code,
          (SELECT supplier_product_id FROM supplier_products WHERE supplier_products.id = supplier_product_canonical_mappings.supplier_product_id) AS supplier_product_external_id,
          product_id::text, state, decision_source, confidence, reason_code,
          policy_version, evidence, actor_ref, reason, created_at, updated_at
      `,
      [
        supplierUuid,
        supplierProductUuid,
        input.mapping.productId ?? null,
        input.mapping.state,
        input.mapping.decisionSource,
        input.mapping.confidence,
        input.mapping.reasonCode,
        input.mapping.policyVersion,
        JSON.stringify(input.mapping.evidence),
        input.mapping.actorRef ?? null,
        input.mapping.reason ?? null,
        input.mapping.createdAt,
        input.mapping.updatedAt,
      ],
    );
    if (input.mapping.productId) {
      await this.db.query(
        `
          UPDATE supplier_products
          SET product_id = $3, updated_at = now()
          WHERE supplier_id = $1 AND supplier_product_id = $2
        `,
        [
          supplierUuid,
          input.mapping.supplierProductId,
          input.mapping.productId,
        ],
      );
    }
    return mappingFromRow(row);
  }

  public async saveIdentifiers(input: {
    readonly productId: ProductId;
    readonly identifiers: readonly CanonicalProductIdentifierEvidence[];
    readonly now: Date;
  }): Promise<void> {
    for (const identifier of input.identifiers) {
      await this.db.query(
        `
          INSERT INTO canonical_product_identifiers(
            product_id, identifier_type, identifier_value, trusted_source, verified, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (identifier_type, identifier_value, product_id) DO NOTHING
        `,
        [
          input.productId,
          identifier.type,
          identifier.value,
          identifier.trustedSource,
          identifier.verified,
          input.now,
        ],
      );
    }
  }

  public async listSupplierProductsForCanonicalProduct(
    canonicalProductId: ProductId,
  ): Promise<readonly CanonicalProductMappingRecord[]> {
    const result = await this.db.query<MappingRow>(
      `
        SELECT suppliers.supplier_code,
          supplier_products.supplier_product_id AS supplier_product_external_id,
          supplier_product_canonical_mappings.product_id::text,
          state, decision_source, confidence, reason_code, policy_version,
          evidence, actor_ref, reason,
          supplier_product_canonical_mappings.created_at,
          supplier_product_canonical_mappings.updated_at
        FROM supplier_product_canonical_mappings
        JOIN suppliers ON suppliers.id = supplier_product_canonical_mappings.supplier_id
        JOIN supplier_products ON supplier_products.id = supplier_product_canonical_mappings.supplier_product_id
        WHERE supplier_product_canonical_mappings.product_id = $1
        ORDER BY suppliers.supplier_code, supplier_products.supplier_product_id
      `,
      [canonicalProductId],
    );
    return result.rows.map(mappingFromRow);
  }

  private async ensureSupplier(supplierCode: SupplierId): Promise<string> {
    const row = await this.queryOne<IdRow>(
      `
        INSERT INTO suppliers(supplier_code, display_name)
        VALUES ($1, $1)
        ON CONFLICT (supplier_code)
        DO UPDATE SET updated_at = now()
        RETURNING id::text
      `,
      [supplierCode],
    );
    return row.id;
  }

  private async ensureSupplierProduct(
    supplierUuid: string,
    mapping: CanonicalProductMappingRecord,
  ): Promise<string> {
    const row = await this.queryOne<IdRow>(
      `
        INSERT INTO supplier_products(
          supplier_id, supplier_product_id, title, lifecycle, active,
          first_seen_at, last_seen_at
        )
        VALUES ($1, $2, $3, 'UNKNOWN', true, $4, $4)
        ON CONFLICT (supplier_id, supplier_product_id)
        DO UPDATE SET updated_at = now()
        RETURNING id::text
      `,
      [
        supplierUuid,
        mapping.supplierProductId,
        mapping.evidence.normalizedTitle,
        mapping.createdAt,
      ],
    );
    return row.id;
  }

  private async queryOne<TRow>(
    text: string,
    values: QueryParameters,
  ): Promise<TRow> {
    const result = await this.db.query<TRow & Record<string, unknown>>(
      text,
      values,
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Expected PostgreSQL query to return one row");
    }
    return row;
  }
}

const productFromRow = (row: ProductRow): CanonicalProductRecord => ({
  active: row.active,
  canonicalTitle: row.title,
  confidenceState: row.canonical_metadata_confidence,
  createdAt: row.created_at,
  lifecycle: row.lifecycle,
  platforms: row.platform
    .split(",")
    .filter(
      (platform) => platform.length > 0,
    ) as CanonicalProductRecord["platforms"],
  productId: productId(row.id),
  productType: row.product_type,
  updatedAt: row.updated_at,
});

const mappingFromRow = (row: MappingRow): CanonicalProductMappingRecord => ({
  confidence: row.confidence,
  createdAt: row.created_at,
  decisionSource: row.decision_source,
  evidence: row.evidence,
  policyVersion: row.policy_version,
  reasonCode: row.reason_code,
  state: row.state,
  supplierId: row.supplier_code as SupplierId,
  supplierProductId: supplierProductId(row.supplier_product_external_id),
  updatedAt: row.updated_at,
  ...(row.actor_ref ? { actorRef: row.actor_ref } : {}),
  ...(row.product_id ? { productId: productId(row.product_id) } : {}),
  ...(row.reason ? { reason: row.reason } : {}),
});
