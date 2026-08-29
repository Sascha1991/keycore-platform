import type { QueryResult, QueryResultRow } from "pg";

import {
  StorefrontPublicationService,
  correlationId,
  currency,
  money,
  offerId,
  productId,
  storefrontChannel,
  storefrontProductId,
  type ProductId,
  type StorefrontCanonicalProduct,
  type StorefrontOfferSummary,
  type StorefrontPort,
  type StorefrontPriceProvider,
  type StorefrontProductRepresentation,
  type StorefrontPublicationSnapshot,
  type StorefrontRemoteProductSnapshot,
} from "../../packages/platform/src/contracts.js";
import type { Queryable } from "../postgres/client.js";
import { PostgresStorefrontPublicationRepository } from "../postgres/storefront-publication-repositories.js";

export const scaleStorefront = storefrontChannel("KEYRANO_SCALE_CI");

export interface ScalePublicationPassResult {
  readonly blocked: number;
  readonly created: number;
  readonly noOp: number;
  readonly processed: number;
  readonly unpublished: number;
  readonly updated: number;
}

export class DeterministicScaleStorefront implements StorefrontPort {
  public createCalls = 0;
  public updateCalls = 0;
  public unpublishCalls = 0;
  private readonly products = new Map<string, boolean>();

  public async createProduct(
    product: StorefrontProductRepresentation,
  ): Promise<ReturnType<typeof storefrontProductId>> {
    const remoteId = `scale-${product.productId}`;
    if (this.products.has(remoteId)) {
      throw new Error("Synthetic storefront duplicate create");
    }
    this.products.set(remoteId, true);
    this.createCalls += 1;
    return storefrontProductId(remoteId);
  }

  public async updateProduct(input: {
    readonly remoteProductId: ReturnType<typeof storefrontProductId>;
  }): Promise<void> {
    if (!this.products.has(input.remoteProductId)) {
      throw new Error("Synthetic storefront update target missing");
    }
    this.products.set(input.remoteProductId, true);
    this.updateCalls += 1;
  }

  public async unpublishProduct(input: {
    readonly remoteProductId: ReturnType<typeof storefrontProductId>;
  }): Promise<void> {
    if (!this.products.has(input.remoteProductId)) {
      throw new Error("Synthetic storefront unpublish target missing");
    }
    this.products.set(input.remoteProductId, false);
    this.unpublishCalls += 1;
  }

  public async readProduct(
    remoteProductId: ReturnType<typeof storefrontProductId>,
  ): Promise<StorefrontRemoteProductSnapshot | null> {
    const active = this.products.get(remoteProductId);
    return active === undefined
      ? null
      : {
          catalogVisibility: active ? "visible" : "hidden",
          metadata: {},
          remoteProductId,
          status: active ? "publish" : "draft",
        };
  }

  public async validateConfiguration(): Promise<"HEALTHY"> {
    return "HEALTHY";
  }
}

export const publishScaleCatalog = async (input: {
  readonly db: Queryable;
  readonly remote: DeterministicScaleStorefront;
  readonly supplierCode: string;
  readonly pageSize: number;
  readonly now: Date;
}): Promise<ScalePublicationPassResult> => {
  const repository = new PostgresStorefrontPublicationRepository(
    input.db,
    (requestedProductId) => loadSnapshot(input.db, requestedProductId),
  );
  const service = new StorefrontPublicationService({
    environment: "CI",
    now: () => input.now,
    priceProvider: new PostgresScalePriceProvider(input.db),
    repository,
    storefront: input.remote,
  });
  const result = {
    blocked: 0,
    created: 0,
    noOp: 0,
    processed: 0,
    unpublished: 0,
    updated: 0,
  };
  let cursor: string | null = null;
  do {
    const page: QueryResult<PublicationPageRow> =
      await input.db.query<PublicationPageRow>(
        `
        SELECT supplier_products.product_id::text,
          supplier_products.supplier_product_id
        FROM supplier_products
        JOIN suppliers ON suppliers.id = supplier_products.supplier_id
        WHERE suppliers.supplier_code = $1
          AND supplier_products.product_id IS NOT NULL
          AND ($2::text IS NULL OR supplier_products.supplier_product_id > $2)
        ORDER BY supplier_products.supplier_product_id
        LIMIT $3
      `,
        [input.supplierCode, cursor, input.pageSize],
      );
    for (const row of page.rows) {
      const publication = await service.publish({
        correlationId: correlationId(
          `scale-publication-${row.supplier_product_id}`,
        ),
        productId: productId(row.product_id),
        storefront: scaleStorefront,
      });
      result.processed += 1;
      if (publication.outcome === "CREATED") result.created += 1;
      if (publication.outcome === "UPDATED") result.updated += 1;
      if (publication.outcome === "UNPUBLISHED") result.unpublished += 1;
      if (publication.outcome === "BLOCKED") result.blocked += 1;
      if (publication.outcome === "NO_OP") result.noOp += 1;
    }
    cursor = page.rows.at(-1)?.supplier_product_id ?? null;
    if (page.rows.length < input.pageSize) break;
  } while (cursor);
  return result;
};

const loadSnapshot = async (
  db: Queryable,
  requestedProductId: ProductId,
): Promise<StorefrontPublicationSnapshot> => {
  const productResult = await db.query<ProductSnapshotRow>(
    `
      SELECT products.id::text, products.title, products.product_type,
        products.platform, products.lifecycle,
        bool_or(supplier_products.active) AS active
      FROM products
      JOIN supplier_products ON supplier_products.product_id = products.id
      WHERE products.id = $1
      GROUP BY products.id, products.title, products.product_type,
        products.platform, products.lifecycle
    `,
    [requestedProductId],
  );
  const productRow = productResult.rows[0];
  if (!productRow) return { mappings: [], offers: [], product: null };
  const offers = await db.query<OfferSnapshotRow>(
    `
      SELECT offers.id::text, supplier_offers.active, offers.availability,
        latest_decision.decision
      FROM offers
      JOIN supplier_offers ON supplier_offers.id = offers.supplier_offer_id
      LEFT JOIN LATERAL (
        SELECT region_decisions.decision
        FROM region_decisions
        JOIN region_evidence ON region_evidence.id = region_decisions.region_evidence_id
        WHERE region_decisions.offer_id = offers.id
        ORDER BY region_evidence.captured_at DESC,
          region_decisions.evaluated_at DESC, region_decisions.id DESC
        LIMIT 1
      ) AS latest_decision ON true
      WHERE offers.product_id = $1
      ORDER BY offers.id
    `,
    [requestedProductId],
  );
  return {
    mappings: [{ state: "UNMATCHED" }],
    offers: offers.rows.map(offerFromRow),
    product: productFromRow(productRow),
  };
};

class PostgresScalePriceProvider implements StorefrontPriceProvider {
  public constructor(private readonly db: Queryable) {}

  public async quoteSellPrice(input: {
    readonly eligibleOffers: readonly StorefrontOfferSummary[];
  }) {
    if (input.eligibleOffers.length === 0) return null;
    const result = await this.db.query<{
      readonly amount_minor: string;
      readonly currency: string;
    }>(
      `
        SELECT latest.amount_minor::text, latest.currency
        FROM (
          SELECT DISTINCT ON (price_snapshots.offer_id)
            price_snapshots.offer_id, price_snapshots.amount_minor,
            price_snapshots.currency
          FROM price_snapshots
          WHERE price_snapshots.offer_id = ANY($1::uuid[])
          ORDER BY price_snapshots.offer_id,
            price_snapshots.captured_at DESC, price_snapshots.id DESC
        ) AS latest
        ORDER BY latest.amount_minor
        LIMIT 1
      `,
      [input.eligibleOffers.map((offer) => offer.offerId)],
    );
    const row = result.rows[0];
    return row ? money(BigInt(row.amount_minor), currency(row.currency)) : null;
  }
}

interface ProductSnapshotRow extends QueryResultRow {
  readonly id: string;
  readonly title: string;
  readonly product_type: StorefrontCanonicalProduct["productType"];
  readonly platform: string;
  readonly lifecycle: StorefrontCanonicalProduct["lifecycle"];
  readonly active: boolean;
}

interface PublicationPageRow extends QueryResultRow {
  readonly product_id: string;
  readonly supplier_product_id: string;
}

interface OfferSnapshotRow extends QueryResultRow {
  readonly id: string;
  readonly active: boolean;
  readonly availability: StorefrontOfferSummary["availability"];
  readonly decision: StorefrontOfferSummary["germanyCompatibility"] | null;
}

const productFromRow = (
  row: ProductSnapshotRow,
): StorefrontCanonicalProduct => ({
  active: row.active,
  canonicalTitle: row.title,
  edition: "STANDARD",
  lifecycle: row.lifecycle,
  platforms: row.platform
    .split(",")
    .filter(
      (platform) => platform.length > 0,
    ) as StorefrontCanonicalProduct["platforms"],
  productId: productId(row.id),
  productType: row.product_type,
});

const offerFromRow = (row: OfferSnapshotRow): StorefrontOfferSummary => ({
  active: row.active,
  availability: row.availability,
  germanyCompatibility: row.decision ?? "REVIEW_REQUIRED",
  offerId: offerId(row.id),
});
