import { randomUUID } from "node:crypto";

import type { QueryParameters, TransactionalQueryable } from "./client.js";
import type {
  CatalogSyncCheckpoint,
  CatalogSyncMetrics,
  CatalogSyncMode,
  CatalogSyncRepository,
  CatalogSyncRun,
} from "../../packages/platform/src/catalog/synchronization.js";
import {
  CatalogSyncError,
  catalogOfferProductMappingChangedMessage,
} from "../../packages/platform/src/catalog/synchronization.js";
import type {
  SupplierId,
  SupplierOfferId,
  SupplierProductId,
} from "../../packages/platform/src/contracts.js";
import { supplierProductId } from "../../packages/platform/src/contracts.js";

interface IdRow {
  readonly id: string;
}

interface SyncRunRow {
  readonly id: string;
  readonly supplier_code: string;
  readonly mode: CatalogSyncMode;
  readonly status: CatalogSyncRun["status"];
  readonly metrics: CatalogSyncMetrics;
  readonly error_message: string | null;
  readonly started_at: Date;
  readonly completed_at: Date | null;
  readonly failed_at: Date | null;
}

interface CheckpointRow {
  readonly supplier_code: string;
  readonly mode: "FULL" | "INCREMENTAL";
  readonly cursor: string | null;
  readonly high_watermark: Date | null;
  readonly completed_at: Date | null;
}

export class PostgresCatalogSyncRepository implements CatalogSyncRepository {
  private readonly supplierUuids = new Map<SupplierId, string>();

  public constructor(
    private readonly db: TransactionalQueryable,
    private readonly observer?: {
      readonly pagePersisted?: (observation: {
        readonly durationMs: number;
        readonly offerCount: number;
        readonly productCount: number;
      }) => void;
      readonly staleRecordsDeactivated?: (observation: {
        readonly durationMs: number;
        readonly offers: number;
        readonly products: number;
      }) => void;
      readonly operationCompleted?: (observation: {
        readonly durationMs: number;
        readonly operation: string;
      }) => void;
    },
  ) {}

  public async beginRun(input: {
    readonly supplierId: SupplierId;
    readonly mode: CatalogSyncMode;
    readonly startedAt: Date;
  }): Promise<CatalogSyncRun> {
    const supplierId = await this.ensureSupplier(input.supplierId);
    const result = await this.observeOperation("run_begin", () =>
      this.queryOne<SyncRunRow>(
        `
        INSERT INTO catalog_sync_runs(supplier_id, mode, status, metrics, started_at)
        VALUES ($1, $2, 'RUNNING', $3::jsonb, $4)
        RETURNING id, $5::text AS supplier_code, mode, status, metrics, error_message,
          started_at, completed_at, failed_at
      `,
        [
          supplierId,
          input.mode,
          JSON.stringify(zeroMetrics()),
          input.startedAt,
          input.supplierId,
        ],
      ),
    );
    return runFromRow(result);
  }

  public async completeRun(input: {
    readonly runId: string;
    readonly completedAt: Date;
    readonly metrics: CatalogSyncMetrics;
  }): Promise<CatalogSyncRun> {
    const row = await this.observeOperation("run_complete", () =>
      this.queryOne<SyncRunRow>(
        `
        UPDATE catalog_sync_runs
        SET status = 'SUCCEEDED', completed_at = $2, metrics = $3::jsonb
        WHERE id = $1
        RETURNING id,
          (SELECT supplier_code FROM suppliers WHERE suppliers.id = catalog_sync_runs.supplier_id) AS supplier_code,
          mode, status, metrics, error_message, started_at, completed_at, failed_at
      `,
        [input.runId, input.completedAt, JSON.stringify(input.metrics)],
      ),
    );
    return runFromRow(row);
  }

  public async failRun(input: {
    readonly runId: string;
    readonly failedAt: Date;
    readonly errorMessage: string;
    readonly metrics: CatalogSyncMetrics;
  }): Promise<CatalogSyncRun> {
    const row = await this.observeOperation("run_fail", () =>
      this.queryOne<SyncRunRow>(
        `
        UPDATE catalog_sync_runs
        SET status = 'FAILED', failed_at = $2, error_message = $3, metrics = $4::jsonb
        WHERE id = $1
        RETURNING id,
          (SELECT supplier_code FROM suppliers WHERE suppliers.id = catalog_sync_runs.supplier_id) AS supplier_code,
          mode, status, metrics, error_message, started_at, completed_at, failed_at
      `,
        [
          input.runId,
          input.failedAt,
          input.errorMessage,
          JSON.stringify(input.metrics),
        ],
      ),
    );
    return runFromRow(row);
  }

  public async upsertProduct(
    input: Parameters<CatalogSyncRepository["upsertProduct"]>[0],
  ): Promise<void> {
    const supplierUuid = await this.ensureSupplier(
      input.product.supplier.supplierId,
    );
    const productUuid = await this.ensureProduct(supplierUuid, input);
    await this.db.query(
      `
        INSERT INTO supplier_products(
          supplier_id, supplier_product_id, product_id, title, raw_metadata,
          lifecycle, active, first_seen_at, last_seen_at, last_sync_run_id
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, true, $7, $7, $8)
        ON CONFLICT (supplier_id, supplier_product_id)
        DO UPDATE SET
          product_id = EXCLUDED.product_id,
          title = EXCLUDED.title,
          raw_metadata = EXCLUDED.raw_metadata,
          lifecycle = EXCLUDED.lifecycle,
          active = true,
          last_seen_at = EXCLUDED.last_seen_at,
          last_sync_run_id = EXCLUDED.last_sync_run_id,
          updated_at = now()
      `,
      [
        supplierUuid,
        input.product.supplierProductId,
        productUuid,
        input.product.product.title,
        JSON.stringify({
          platforms: input.product.product.platforms,
          productId: input.product.product.productId,
        }),
        input.product.lifecycle,
        input.observedAt,
        input.runId,
      ],
    );
  }

  public async upsertOffer(
    input: Parameters<CatalogSyncRepository["upsertOffer"]>[0],
  ): Promise<void> {
    const supplierUuid = await this.ensureSupplier(
      input.offer.supplier.supplierId,
    );
    const supplierProductUuid = await this.getSupplierProductUuid(
      supplierUuid,
      input.offer.supplierProductId,
    );
    const existing = await this.getOfferMapping({
      supplierId: input.offer.supplier.supplierId,
      supplierOfferId: input.offer.supplierOfferId,
    });
    if (existing && existing !== input.offer.supplierProductId) {
      throw new Error(
        "Supplier offer/product mapping changed without reconciliation",
      );
    }

    const supplierOffer = await this.queryOne<IdRow>(
      `
        INSERT INTO supplier_offers(
          supplier_id, supplier_product_id, supplier_offer_id, raw_metadata,
          active, first_seen_at, last_seen_at, last_sync_run_id
        )
        VALUES ($1, $2, $3, $4::jsonb, true, $5, $5, $6)
        ON CONFLICT (supplier_id, supplier_offer_id)
        DO UPDATE SET
          raw_metadata = EXCLUDED.raw_metadata,
          active = true,
          last_seen_at = EXCLUDED.last_seen_at,
          last_sync_run_id = EXCLUDED.last_sync_run_id,
          updated_at = now()
        RETURNING id
      `,
      [
        supplierUuid,
        supplierProductUuid,
        input.offer.supplierOfferId,
        JSON.stringify(input.offer.supplierReferenceMetadata),
        input.observedAt,
        input.runId,
      ],
    );
    const product = await this.queryOne<IdRow>(
      "SELECT product_id AS id FROM supplier_products WHERE id = $1",
      [supplierProductUuid],
    );
    const offer = await this.queryOne<IdRow>(
      `
        INSERT INTO offers(product_id, supplier_offer_id, availability)
        VALUES ($1, $2, $3)
        ON CONFLICT (supplier_offer_id)
        DO UPDATE SET availability = EXCLUDED.availability, updated_at = now()
        RETURNING id
      `,
      [product.id, supplierOffer.id, input.offer.offer.availability],
    );
    const evidence = await this.queryOne<IdRow>(
      `
        INSERT INTO region_evidence(
          offer_id, allowed_countries, excluded_countries, supplier_region_identifier,
          documented_semantics_reference, requires_vpn, requires_foreign_account,
          activation_restrictions, has_missing_values, has_unknown_values,
          has_contradictory_evidence, source_evidence_version, captured_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
        RETURNING id
      `,
      [
        offer.id,
        input.offer.regionEvidence.allowedCountries,
        input.offer.regionEvidence.excludedCountries,
        input.offer.regionEvidence.supplierRegion?.supplierRegionId ?? null,
        input.offer.regionEvidence.supplierRegion?.documentedSemanticsUrl ??
          null,
        boolOrNull(input.offer.regionEvidence.requiresVpn),
        boolOrNull(input.offer.regionEvidence.requiresForeignAccount),
        JSON.stringify(input.offer.regionEvidence.activationRestrictions),
        input.offer.regionEvidence.hasMissingValues,
        input.offer.regionEvidence.hasUnknownValues,
        input.offer.regionEvidence.hasContradictoryEvidence,
        input.assessment.policyVersion,
        input.offer.capturedAt,
      ],
    );
    await this.db.query(
      `
        INSERT INTO region_decisions(
          offer_id, region_evidence_id, decision, reason_code, policy_version,
          source_evidence_version, evaluated_at
        )
        VALUES ($1, $2, $3, $4, $5, $5, $6)
      `,
      [
        offer.id,
        evidence.id,
        input.assessment.decision,
        input.assessment.reasonCode,
        input.assessment.policyVersion,
        input.observedAt,
      ],
    );
    await this.db.query(
      `
        INSERT INTO price_snapshots(offer_id, amount_minor, currency, availability, captured_at)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        offer.id,
        input.offer.offer.currentPrice.amountMinor.toString(),
        input.offer.offer.currentPrice.currency,
        input.offer.offer.availability,
        input.offer.capturedAt,
      ],
    );
  }

  public async upsertPage(
    input: Parameters<NonNullable<CatalogSyncRepository["upsertPage"]>>[0],
  ): Promise<void> {
    if (input.products.length === 0) return;
    const supplierUuid = await this.ensureSupplier(input.supplierId);
    const externalProductIds = input.products.map(
      ({ product }) => product.supplierProductId,
    );
    const existing = await this.observeOperation(
      "existing_identity_preload",
      () =>
        this.db.query<{
          readonly product_id: string;
          readonly supplier_product_id: string;
        }>(
          `
        SELECT supplier_product_id, product_id::text
        FROM supplier_products
        WHERE supplier_id = $1
          AND supplier_product_id = ANY($2::text[])
          AND product_id IS NOT NULL
      `,
          [supplierUuid, externalProductIds],
        ),
    );
    const productIds = new Map(
      existing.rows.map((row) => [row.supplier_product_id, row.product_id]),
    );
    const products = input.products.map(({ product }) => ({
      external_product_id: product.product.productId,
      internal_id: productIds.get(product.supplierProductId) ?? randomUUID(),
      lifecycle: product.lifecycle,
      platform: product.product.platforms[0] ?? "UNKNOWN",
      platforms: product.product.platforms,
      product_type: product.product.type,
      supplier_product_id: product.supplierProductId,
      title: product.product.title,
    }));
    const offers = input.products.flatMap(({ offers: productOffers }) =>
      productOffers.map(({ assessment, offer }) => ({
        activation_restrictions: offer.regionEvidence.activationRestrictions,
        allowed_countries: offer.regionEvidence.allowedCountries,
        amount_minor: offer.offer.currentPrice.amountMinor.toString(),
        availability: offer.offer.availability,
        captured_at: offer.capturedAt.toISOString(),
        currency: offer.offer.currentPrice.currency,
        decision: assessment.decision,
        documented_semantics_reference:
          offer.regionEvidence.supplierRegion?.documentedSemanticsUrl ?? null,
        excluded_countries: offer.regionEvidence.excludedCountries,
        has_contradictory_evidence:
          offer.regionEvidence.hasContradictoryEvidence,
        has_missing_values: offer.regionEvidence.hasMissingValues,
        has_unknown_values: offer.regionEvidence.hasUnknownValues,
        policy_version: assessment.policyVersion,
        raw_metadata: offer.supplierReferenceMetadata,
        reason_code: assessment.reasonCode,
        requires_foreign_account: boolOrNull(
          offer.regionEvidence.requiresForeignAccount,
        ),
        requires_vpn: boolOrNull(offer.regionEvidence.requiresVpn),
        supplier_offer_id: offer.supplierOfferId,
        supplier_product_id: offer.supplierProductId,
        supplier_region_identifier:
          offer.regionEvidence.supplierRegion?.supplierRegionId ?? null,
      })),
    );
    const offerPayload = JSON.stringify(offers);
    const productPayload = JSON.stringify(products);

    const startedAt = performance.now();
    await this.db.transaction(async (db) => {
      const mappingConflict = await this.observeOperation(
        "mapping_conflict",
        () =>
          db.query<{ readonly conflict: boolean }>(
            `
          SELECT true AS conflict
          FROM jsonb_to_recordset($2::jsonb) AS source(
            supplier_offer_id text,
            supplier_product_id text
          )
          JOIN supplier_offers ON supplier_offers.supplier_id = $1
            AND supplier_offers.supplier_offer_id = source.supplier_offer_id
          JOIN supplier_products ON supplier_products.id = supplier_offers.supplier_product_id
          WHERE supplier_products.supplier_product_id <> source.supplier_product_id
          LIMIT 1
        `,
            [supplierUuid, offerPayload],
          ),
      );
      if (mappingConflict.rows[0]?.conflict) {
        throw new CatalogSyncError(
          "CATALOG_OFFER_PRODUCT_MAPPING_CHANGED",
          catalogOfferProductMappingChangedMessage,
        );
      }

      await this.observeOperation("product_upsert", () =>
        db.query(
          `
          INSERT INTO products(
            id, product_type, title, platform, lifecycle, active,
            canonical_metadata_confidence, canonical_metadata
          )
          SELECT internal_id, product_type, title, platform, lifecycle, true,
            'LOW', jsonb_build_object(
              'platforms', platforms,
              'productId', external_product_id
            )
          FROM jsonb_to_recordset($1::jsonb) AS source(
            internal_id uuid,
            supplier_product_id text,
            external_product_id text,
            title text,
            product_type text,
            platform text,
            platforms jsonb,
            lifecycle text
          )
          ON CONFLICT (id)
          DO UPDATE SET
            product_type = EXCLUDED.product_type,
            title = EXCLUDED.title,
            platform = EXCLUDED.platform,
            lifecycle = EXCLUDED.lifecycle,
            active = true,
            canonical_metadata = EXCLUDED.canonical_metadata,
            updated_at = now()
        `,
          [productPayload],
        ),
      );
      await this.observeOperation("supplier_product_upsert", () =>
        db.query(
          `
          INSERT INTO supplier_products(
            supplier_id, supplier_product_id, product_id, title, raw_metadata,
            lifecycle, active, first_seen_at, last_seen_at, last_sync_run_id
          )
          SELECT $1, supplier_product_id, internal_id, title,
            jsonb_build_object(
              'platforms', platforms,
              'productId', external_product_id
            ),
            lifecycle, true, $3, $3, $4
          FROM jsonb_to_recordset($2::jsonb) AS source(
            internal_id uuid,
            supplier_product_id text,
            external_product_id text,
            title text,
            product_type text,
            platform text,
            platforms jsonb,
            lifecycle text
          )
          ON CONFLICT (supplier_id, supplier_product_id)
          DO UPDATE SET
            product_id = EXCLUDED.product_id,
            title = EXCLUDED.title,
            raw_metadata = EXCLUDED.raw_metadata,
            lifecycle = EXCLUDED.lifecycle,
            active = true,
            last_seen_at = EXCLUDED.last_seen_at,
            last_sync_run_id = EXCLUDED.last_sync_run_id,
            updated_at = now()
        `,
          [supplierUuid, productPayload, input.observedAt, input.runId],
        ),
      );

      if (offers.length > 0) {
        await this.observeOperation("supplier_offer_upsert", () =>
          db.query(
            `
            INSERT INTO supplier_offers(
              supplier_id, supplier_product_id, supplier_offer_id,
              raw_metadata, active, first_seen_at, last_seen_at,
              last_sync_run_id
            )
            SELECT $1, supplier_products.id, source.supplier_offer_id,
              source.raw_metadata, true, $3, $3, $4
            FROM jsonb_to_recordset($2::jsonb) AS source(
              supplier_offer_id text,
              supplier_product_id text,
              raw_metadata jsonb
            )
            JOIN supplier_products ON supplier_products.supplier_id = $1
              AND supplier_products.supplier_product_id = source.supplier_product_id
            ON CONFLICT (supplier_id, supplier_offer_id)
            DO UPDATE SET
              raw_metadata = EXCLUDED.raw_metadata,
              active = true,
              last_seen_at = EXCLUDED.last_seen_at,
              last_sync_run_id = EXCLUDED.last_sync_run_id,
              updated_at = now()
          `,
            [supplierUuid, offerPayload, input.observedAt, input.runId],
          ),
        );
        await this.observeOperation("offer_upsert", () =>
          db.query(
            `
            INSERT INTO offers(product_id, supplier_offer_id, availability)
            SELECT supplier_products.product_id, supplier_offers.id,
              source.availability
            FROM jsonb_to_recordset($2::jsonb) AS source(
              supplier_offer_id text,
              availability text
            )
            JOIN supplier_offers ON supplier_offers.supplier_id = $1
              AND supplier_offers.supplier_offer_id = source.supplier_offer_id
            JOIN supplier_products ON supplier_products.id = supplier_offers.supplier_product_id
            ON CONFLICT (supplier_offer_id)
            DO UPDATE SET
              product_id = EXCLUDED.product_id,
              availability = EXCLUDED.availability,
              updated_at = now()
          `,
            [supplierUuid, offerPayload],
          ),
        );
        await this.observeOperation("region_evidence", () =>
          db.query(
            `
            INSERT INTO region_evidence(
              offer_id, allowed_countries, excluded_countries,
              supplier_region_identifier, documented_semantics_reference,
              requires_vpn, requires_foreign_account,
              activation_restrictions, has_missing_values,
              has_unknown_values, has_contradictory_evidence,
              source_evidence_version, captured_at
            )
            SELECT offers.id, source.allowed_countries,
              source.excluded_countries, source.supplier_region_identifier,
              source.documented_semantics_reference, source.requires_vpn,
              source.requires_foreign_account,
              source.activation_restrictions, source.has_missing_values,
              source.has_unknown_values, source.has_contradictory_evidence,
              source.policy_version, source.captured_at
            FROM jsonb_to_recordset($2::jsonb) AS source(
              supplier_offer_id text,
              allowed_countries text[],
              excluded_countries text[],
              supplier_region_identifier text,
              documented_semantics_reference text,
              requires_vpn boolean,
              requires_foreign_account boolean,
              activation_restrictions jsonb,
              has_missing_values boolean,
              has_unknown_values boolean,
              has_contradictory_evidence boolean,
              policy_version text,
              captured_at timestamptz
            )
            JOIN supplier_offers ON supplier_offers.supplier_id = $1
              AND supplier_offers.supplier_offer_id = source.supplier_offer_id
            JOIN offers ON offers.supplier_offer_id = supplier_offers.id
            ON CONFLICT (offer_id, source_evidence_version, captured_at)
            DO NOTHING
          `,
            [supplierUuid, offerPayload],
          ),
        );
        await this.observeOperation("region_decision", () =>
          db.query(
            `
            INSERT INTO region_decisions(
              offer_id, region_evidence_id, decision, reason_code,
              policy_version, source_evidence_version, evaluated_at
            )
            SELECT offers.id, evidence.id, source.decision,
              source.reason_code, source.policy_version,
              source.policy_version, $3
            FROM jsonb_to_recordset($2::jsonb) AS source(
              supplier_offer_id text,
              decision text,
              reason_code text,
              policy_version text,
              captured_at timestamptz
            )
            JOIN supplier_offers ON supplier_offers.supplier_id = $1
              AND supplier_offers.supplier_offer_id = source.supplier_offer_id
            JOIN offers ON offers.supplier_offer_id = supplier_offers.id
            JOIN region_evidence AS evidence ON evidence.offer_id = offers.id
              AND evidence.source_evidence_version = source.policy_version
              AND evidence.captured_at = source.captured_at
            ON CONFLICT (
              offer_id, region_evidence_id, decision, reason_code, policy_version
            )
            DO NOTHING
          `,
            [supplierUuid, offerPayload, input.observedAt],
          ),
        );
        await this.observeOperation("price_snapshot", () =>
          db.query(
            `
            INSERT INTO price_snapshots(
              offer_id, amount_minor, currency, availability, captured_at
            )
            SELECT offers.id, source.amount_minor, source.currency,
              source.availability, source.captured_at
            FROM jsonb_to_recordset($2::jsonb) AS source(
              supplier_offer_id text,
              amount_minor bigint,
              currency text,
              availability text,
              captured_at timestamptz
            )
            JOIN supplier_offers ON supplier_offers.supplier_id = $1
              AND supplier_offers.supplier_offer_id = source.supplier_offer_id
            JOIN offers ON offers.supplier_offer_id = supplier_offers.id
            WHERE NOT EXISTS (
              SELECT 1
              FROM price_snapshots
              WHERE price_snapshots.offer_id = offers.id
                AND price_snapshots.amount_minor = source.amount_minor
                AND price_snapshots.currency = source.currency
                AND price_snapshots.availability = source.availability
                AND price_snapshots.captured_at = source.captured_at
            )
          `,
            [supplierUuid, offerPayload],
          ),
        );
      }
    });
    this.observer?.pagePersisted?.({
      durationMs: Math.round(performance.now() - startedAt),
      offerCount: offers.length,
      productCount: products.length,
    });
  }

  public async deactivateStaleFullSyncRecords(input: {
    readonly supplierId: SupplierId;
    readonly runId: string;
    readonly observedAt: Date;
  }): Promise<{ readonly products: number; readonly offers: number }> {
    const startedAt = performance.now();
    const supplierUuid = await this.ensureSupplier(input.supplierId);
    const offers = await this.observeOperation("stale_offer_update", () =>
      this.db.query(
        `
        UPDATE supplier_offers
        SET active = false, last_seen_at = $3
        WHERE supplier_id = $1 AND active = true AND last_sync_run_id IS DISTINCT FROM $2
      `,
        [supplierUuid, input.runId, input.observedAt],
      ),
    );
    const products = await this.observeOperation("stale_product_update", () =>
      this.db.query(
        `
        UPDATE supplier_products
        SET active = false, last_seen_at = $3
        WHERE supplier_id = $1 AND active = true AND last_sync_run_id IS DISTINCT FROM $2
      `,
        [supplierUuid, input.runId, input.observedAt],
      ),
    );
    const result = {
      offers: offers.rowCount ?? 0,
      products: products.rowCount ?? 0,
    };
    this.observer?.staleRecordsDeactivated?.({
      ...result,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  }

  public async getCheckpoint(input: {
    readonly supplierId: SupplierId;
    readonly mode: "FULL" | "INCREMENTAL";
  }): Promise<CatalogSyncCheckpoint | null> {
    const row = await this.db.query<CheckpointRow>(
      `
        SELECT suppliers.supplier_code, catalog_sync_checkpoints.mode, cursor,
          high_watermark, completed_at
        FROM catalog_sync_checkpoints
        JOIN suppliers ON suppliers.id = catalog_sync_checkpoints.supplier_id
        WHERE suppliers.supplier_code = $1 AND catalog_sync_checkpoints.mode = $2
      `,
      [input.supplierId, input.mode],
    );
    const checkpoint = row.rows[0];
    return checkpoint ? checkpointFromRow(checkpoint) : null;
  }

  public async saveCheckpoint(input: CatalogSyncCheckpoint): Promise<void> {
    const supplierUuid = await this.ensureSupplier(input.supplierId);
    await this.observeOperation("checkpoint_save", () =>
      this.db.query(
        `
        INSERT INTO catalog_sync_checkpoints(
          supplier_id, mode, cursor, high_watermark, completed_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (supplier_id, mode)
        DO UPDATE SET
          cursor = EXCLUDED.cursor,
          high_watermark = EXCLUDED.high_watermark,
          completed_at = EXCLUDED.completed_at,
          updated_at = now()
      `,
        [
          supplierUuid,
          input.mode,
          input.cursor ?? null,
          input.highWatermark ?? null,
          input.completedAt ?? null,
        ],
      ),
    );
  }

  public async getOfferMapping(input: {
    readonly supplierId: SupplierId;
    readonly supplierOfferId: SupplierOfferId;
  }): Promise<SupplierProductId | null> {
    const row = await this.db.query<{ supplier_product_id: string }>(
      `
        SELECT supplier_products.supplier_product_id
        FROM supplier_offers
        JOIN suppliers ON suppliers.id = supplier_offers.supplier_id
        JOIN supplier_products ON supplier_products.id = supplier_offers.supplier_product_id
        WHERE suppliers.supplier_code = $1 AND supplier_offers.supplier_offer_id = $2
      `,
      [input.supplierId, input.supplierOfferId],
    );
    const value = row.rows[0]?.supplier_product_id;
    return value ? supplierProductId(value) : null;
  }

  private async ensureSupplier(supplierCode: SupplierId): Promise<string> {
    const cached = this.supplierUuids.get(supplierCode);
    if (cached) return cached;
    const row = await this.observeOperation("supplier_ensure", () =>
      this.queryOne<IdRow>(
        `
        INSERT INTO suppliers(supplier_code, display_name)
        VALUES ($1, $1)
        ON CONFLICT (supplier_code)
        DO UPDATE SET updated_at = now()
        RETURNING id
      `,
        [supplierCode],
      ),
    );
    this.supplierUuids.set(supplierCode, row.id);
    return row.id;
  }

  private async observeOperation<TResult>(
    operation: string,
    action: () => Promise<TResult>,
  ): Promise<TResult> {
    const startedAt = performance.now();
    try {
      return await action();
    } finally {
      this.observer?.operationCompleted?.({
        durationMs: Math.round(performance.now() - startedAt),
        operation,
      });
    }
  }

  private async ensureProduct(
    supplierUuid: string,
    input: Parameters<CatalogSyncRepository["upsertProduct"]>[0],
  ): Promise<string> {
    const existing = await this.db.query<IdRow>(
      `
        SELECT product_id AS id
        FROM supplier_products
        WHERE supplier_id = $1 AND supplier_product_id = $2
          AND product_id IS NOT NULL
      `,
      [supplierUuid, input.product.supplierProductId],
    );
    const existingProduct = existing.rows[0];
    if (existingProduct) {
      await this.db.query(
        `
          UPDATE products
          SET product_type = $2, title = $3, platform = $4,
            lifecycle = $5, active = true, updated_at = now()
          WHERE id = $1
        `,
        [
          existingProduct.id,
          input.product.product.type,
          input.product.product.title,
          input.product.product.platforms[0] ?? "UNKNOWN",
          input.product.lifecycle,
        ],
      );
      return existingProduct.id;
    }
    const row = await this.queryOne<IdRow>(
      `
        INSERT INTO products(product_type, title, platform)
        VALUES ($1, $2, $3)
        RETURNING id
      `,
      [
        input.product.product.type,
        input.product.product.title,
        input.product.product.platforms[0] ?? "UNKNOWN",
      ],
    );
    return row.id;
  }

  private async getSupplierProductUuid(
    supplierUuid: string,
    externalProductId: SupplierProductId,
  ): Promise<string> {
    const row = await this.queryOne<IdRow>(
      `
        SELECT id
        FROM supplier_products
        WHERE supplier_id = $1 AND supplier_product_id = $2
      `,
      [supplierUuid, externalProductId],
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

const runFromRow = (row: SyncRunRow): CatalogSyncRun => ({
  metrics: row.metrics,
  mode: row.mode,
  runId: row.id,
  startedAt: row.started_at,
  status: row.status,
  supplierId: row.supplier_code as SupplierId,
  ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  ...(row.error_message ? { errorMessage: row.error_message } : {}),
  ...(row.failed_at ? { failedAt: row.failed_at } : {}),
});

const checkpointFromRow = (row: CheckpointRow): CatalogSyncCheckpoint => ({
  mode: row.mode,
  supplierId: row.supplier_code as SupplierId,
  ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  ...(row.cursor ? { cursor: row.cursor } : {}),
  ...(row.high_watermark ? { highWatermark: row.high_watermark } : {}),
});

const boolOrNull = (value: boolean | "UNKNOWN"): boolean | null =>
  typeof value === "boolean" ? value : null;

const zeroMetrics = (): CatalogSyncMetrics => ({
  errors: 0,
  offersAllowedForGermany: 0,
  offersBlockedForGermany: 0,
  offersDisabledForGermany: 0,
  offersReviewRequiredForGermany: 0,
  offersSeen: 0,
  offersUpserted: 0,
  pagesFetched: 0,
  productsSeen: 0,
  productsUpserted: 0,
  staleOffersDeactivated: 0,
  staleProductsDeactivated: 0,
});
