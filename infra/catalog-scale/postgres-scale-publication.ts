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
  type StorefrontChannel,
  type StorefrontCanonicalProduct,
  type StorefrontOfferSummary,
  type StorefrontPort,
  type StorefrontPriceProvider,
  type StorefrontProductRepresentation,
  type StorefrontPublicationRecord,
  type StorefrontPublicationRepository,
  type StorefrontPublicationSnapshot,
  type StorefrontRemoteProductSnapshot,
} from "../../packages/platform/src/contracts.js";
import type { Queryable, TransactionalQueryable } from "../postgres/client.js";
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
  readonly db: TransactionalQueryable;
  readonly remote: DeterministicScaleStorefront;
  readonly supplierCode: string;
  readonly pageSize: number;
  readonly now: Date;
}): Promise<ScalePublicationPassResult> => {
  const durableRepository = new PostgresStorefrontPublicationRepository(
    input.db,
    async () => ({ mappings: [], offers: [], product: null }),
  );
  const repository = new ScalePublicationPageRepository(
    input.db,
    durableRepository,
  );
  const priceProvider = new PostgresScalePriceProvider(input.db);
  await repository.initialize(scaleStorefront);
  const service = new StorefrontPublicationService({
    environment: "CI",
    now: () => input.now,
    priceProvider,
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
    await input.db.transaction(async () => {
      const productIds = page.rows.map((row) => productId(row.product_id));
      await repository.loadPage(productIds, scaleStorefront);
      await priceProvider.loadPage(productIds);
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
    });
    cursor = page.rows.at(-1)?.supplier_product_id ?? null;
    if (page.rows.length < input.pageSize) break;
  } while (cursor);
  return result;
};

class ScalePublicationPageRepository implements StorefrontPublicationRepository {
  private readonly publications = new Map<
    string,
    StorefrontPublicationRecord
  >();
  private readonly remoteOwners = new Map<
    string,
    StorefrontPublicationRecord
  >();
  private readonly slugOwners = new Map<string, ProductId>();
  private readonly snapshots = new Map<string, StorefrontPublicationSnapshot>();

  public constructor(
    private readonly db: Queryable,
    private readonly durable: PostgresStorefrontPublicationRepository,
  ) {}

  public async initialize(storefront: StorefrontChannel): Promise<void> {
    const result = await this.db.query<PublicationSnapshotRow>(
      `${publicationSelect}
       WHERE storefront = $1
         AND (remote_product_id IS NOT NULL OR slug IS NOT NULL)`,
      [storefront],
    );
    for (const row of result.rows)
      this.indexPublication(publicationFromRow(row));
  }

  public async loadPage(
    productIds: readonly ProductId[],
    storefront: StorefrontChannel,
  ): Promise<void> {
    this.publications.clear();
    this.snapshots.clear();
    if (productIds.length === 0) return;
    const productResult = await this.db.query<ProductSnapshotRow>(
      `
      SELECT products.id::text, products.title, products.product_type,
        products.platform, products.lifecycle,
        bool_or(supplier_products.active) AS active
      FROM products
      JOIN supplier_products ON supplier_products.product_id = products.id
      WHERE products.id = ANY($1::uuid[])
      GROUP BY products.id, products.title, products.product_type,
        products.platform, products.lifecycle
      `,
      [productIds],
    );
    const offers = await this.db.query<OfferSnapshotRow>(
      `
      SELECT offers.id::text, supplier_offers.active, offers.availability,
        latest_decision.decision, offers.product_id::text
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
      WHERE offers.product_id = ANY($1::uuid[])
      ORDER BY offers.id
      `,
      [productIds],
    );
    const offersByProduct = new Map<string, StorefrontOfferSummary[]>();
    for (const row of offers.rows) {
      const current = offersByProduct.get(row.product_id) ?? [];
      current.push(offerFromRow(row));
      offersByProduct.set(row.product_id, current);
    }
    for (const row of productResult.rows) {
      this.snapshots.set(row.id, {
        mappings: [{ state: "UNMATCHED" }],
        offers: offersByProduct.get(row.id) ?? [],
        product: productFromRow(row),
      });
    }
    const publications = await this.db.query<PublicationSnapshotRow>(
      `${publicationSelect}
       WHERE product_id = ANY($1::uuid[]) AND storefront = $2`,
      [productIds, storefront],
    );
    for (const row of publications.rows) {
      const publication = publicationFromRow(row);
      this.publications.set(publication.productId, publication);
      this.indexPublication(publication);
    }
  }

  public async loadSnapshot(
    requestedProductId: ProductId,
  ): Promise<StorefrontPublicationSnapshot> {
    return (
      this.snapshots.get(requestedProductId) ?? {
        mappings: [],
        offers: [],
        product: null,
      }
    );
  }

  public async findPublication(input: {
    readonly productId: ProductId;
  }): Promise<StorefrontPublicationRecord | null> {
    return this.publications.get(input.productId) ?? null;
  }

  public async findPublicationByRemoteId(input: {
    readonly remoteProductId: ReturnType<typeof storefrontProductId>;
  }): Promise<StorefrontPublicationRecord | null> {
    return this.remoteOwners.get(input.remoteProductId) ?? null;
  }

  public async isSlugReserved(input: {
    readonly slug: string;
    readonly productId: ProductId;
  }): Promise<boolean> {
    const owner = this.slugOwners.get(input.slug);
    return owner !== undefined && owner !== input.productId;
  }

  public async savePublication(
    record: StorefrontPublicationRecord,
  ): Promise<StorefrontPublicationRecord> {
    const previous = this.publications.get(record.productId);
    const saved = await this.durable.savePublication(record);
    if (previous?.slug && previous.slug !== saved.slug) {
      this.slugOwners.delete(previous.slug);
    }
    this.publications.set(saved.productId, saved);
    this.indexPublication(saved);
    return saved;
  }

  private indexPublication(record: StorefrontPublicationRecord): void {
    if (record.remoteProductId) {
      this.remoteOwners.set(record.remoteProductId, record);
    }
    if (record.slug) this.slugOwners.set(record.slug, record.productId);
  }
}

class PostgresScalePriceProvider implements StorefrontPriceProvider {
  private readonly prices = new Map<string, ReturnType<typeof money>>();

  public constructor(private readonly db: Queryable) {}

  public async loadPage(productIds: readonly ProductId[]): Promise<void> {
    this.prices.clear();
    if (productIds.length === 0) return;
    const result = await this.db.query<{
      readonly amount_minor: string;
      readonly currency: string;
      readonly offer_id: string;
    }>(
      `
        SELECT DISTINCT ON (price_snapshots.offer_id)
          price_snapshots.offer_id::text, price_snapshots.amount_minor::text,
          price_snapshots.currency
        FROM price_snapshots
        JOIN offers ON offers.id = price_snapshots.offer_id
        WHERE offers.product_id = ANY($1::uuid[])
        ORDER BY price_snapshots.offer_id,
          price_snapshots.captured_at DESC, price_snapshots.id DESC
      `,
      [productIds],
    );
    for (const row of result.rows) {
      this.prices.set(
        row.offer_id,
        money(BigInt(row.amount_minor), currency(row.currency)),
      );
    }
  }

  public async quoteSellPrice(input: {
    readonly eligibleOffers: readonly StorefrontOfferSummary[];
  }) {
    if (input.eligibleOffers.length === 0) return null;
    const candidates = input.eligibleOffers.flatMap((offer) => {
      const price = this.prices.get(offer.offerId);
      return price ? [price] : [];
    });
    return candidates.reduce(
      (lowest, candidate) =>
        lowest === null || candidate.amountMinor < lowest.amountMinor
          ? candidate
          : lowest,
      null as ReturnType<typeof money> | null,
    );
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
  readonly product_id: string;
  readonly active: boolean;
  readonly availability: StorefrontOfferSummary["availability"];
  readonly decision: StorefrontOfferSummary["germanyCompatibility"] | null;
}

interface PublicationSnapshotRow extends QueryResultRow {
  readonly created_at: Date;
  readonly fingerprint: string | null;
  readonly last_attempt_at: Date | null;
  readonly last_error_classification: string | null;
  readonly last_success_at: Date | null;
  readonly product_id: string;
  readonly publication_version: StorefrontPublicationRecord["publicationVersion"];
  readonly reconciliation_required: boolean;
  readonly remote_product_id: string | null;
  readonly slug: string | null;
  readonly state: StorefrontPublicationRecord["state"];
  readonly storefront: string;
  readonly updated_at: Date;
}

const publicationSelect = `
  SELECT product_id::text, storefront, remote_product_id, state,
    publication_version, fingerprint, slug, last_attempt_at,
    last_success_at, last_error_classification, reconciliation_required,
    created_at, updated_at
  FROM storefront_publications
`;

const publicationFromRow = (
  row: PublicationSnapshotRow,
): StorefrontPublicationRecord => ({
  createdAt: row.created_at,
  productId: productId(row.product_id),
  publicationVersion: row.publication_version,
  reconciliationRequired: row.reconciliation_required,
  state: row.state,
  storefront: row.storefront as StorefrontChannel,
  updatedAt: row.updated_at,
  ...(row.fingerprint ? { fingerprint: row.fingerprint } : {}),
  ...(row.last_attempt_at ? { lastAttemptAt: row.last_attempt_at } : {}),
  ...(row.last_error_classification
    ? { lastErrorClassification: row.last_error_classification }
    : {}),
  ...(row.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
  ...(row.remote_product_id
    ? { remoteProductId: storefrontProductId(row.remote_product_id) }
    : {}),
  ...(row.slug ? { slug: row.slug } : {}),
});

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
