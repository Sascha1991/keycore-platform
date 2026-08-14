import type { Queryable, QueryParameters } from "./client.js";
import type {
  CatalogSyncCheckpoint,
  CatalogSyncMetrics,
  CatalogSyncMode,
  CatalogSyncRepository,
  CatalogSyncRun,
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
  public constructor(private readonly db: Queryable) {}

  public async beginRun(input: {
    readonly supplierId: SupplierId;
    readonly mode: CatalogSyncMode;
    readonly startedAt: Date;
  }): Promise<CatalogSyncRun> {
    const supplierId = await this.ensureSupplier(input.supplierId);
    const result = await this.queryOne<SyncRunRow>(
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
    );
    return runFromRow(result);
  }

  public async completeRun(input: {
    readonly runId: string;
    readonly completedAt: Date;
    readonly metrics: CatalogSyncMetrics;
  }): Promise<CatalogSyncRun> {
    const row = await this.queryOne<SyncRunRow>(
      `
        UPDATE catalog_sync_runs
        SET status = 'SUCCEEDED', completed_at = $2, metrics = $3::jsonb
        WHERE id = $1
        RETURNING id,
          (SELECT supplier_code FROM suppliers WHERE suppliers.id = catalog_sync_runs.supplier_id) AS supplier_code,
          mode, status, metrics, error_message, started_at, completed_at, failed_at
      `,
      [input.runId, input.completedAt, JSON.stringify(input.metrics)],
    );
    return runFromRow(row);
  }

  public async failRun(input: {
    readonly runId: string;
    readonly failedAt: Date;
    readonly errorMessage: string;
    readonly metrics: CatalogSyncMetrics;
  }): Promise<CatalogSyncRun> {
    const row = await this.queryOne<SyncRunRow>(
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
    );
    return runFromRow(row);
  }

  public async upsertProduct(
    input: Parameters<CatalogSyncRepository["upsertProduct"]>[0],
  ): Promise<void> {
    const supplierUuid = await this.ensureSupplier(
      input.product.supplier.supplierId,
    );
    const productUuid = await this.ensureProduct(input);
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

  public async deactivateStaleFullSyncRecords(input: {
    readonly supplierId: SupplierId;
    readonly runId: string;
    readonly observedAt: Date;
  }): Promise<{ readonly products: number; readonly offers: number }> {
    const supplierUuid = await this.ensureSupplier(input.supplierId);
    const offers = await this.db.query(
      `
        UPDATE supplier_offers
        SET active = false, last_seen_at = $3
        WHERE supplier_id = $1 AND active = true AND last_sync_run_id IS DISTINCT FROM $2
      `,
      [supplierUuid, input.runId, input.observedAt],
    );
    const products = await this.db.query(
      `
        UPDATE supplier_products
        SET active = false, last_seen_at = $3
        WHERE supplier_id = $1 AND active = true AND last_sync_run_id IS DISTINCT FROM $2
      `,
      [supplierUuid, input.runId, input.observedAt],
    );
    return {
      offers: offers.rowCount ?? 0,
      products: products.rowCount ?? 0,
    };
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
    await this.db.query(
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
    const row = await this.queryOne<IdRow>(
      `
        INSERT INTO suppliers(supplier_code, display_name)
        VALUES ($1, $1)
        ON CONFLICT (supplier_code)
        DO UPDATE SET updated_at = now()
        RETURNING id
      `,
      [supplierCode],
    );
    return row.id;
  }

  private async ensureProduct(
    input: Parameters<CatalogSyncRepository["upsertProduct"]>[0],
  ): Promise<string> {
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
