import type {
  ProductId,
  StorefrontChannel,
  StorefrontProductId,
  StorefrontPublicationRecord,
  StorefrontPublicationRepository,
  StorefrontPublicationSnapshot,
} from "../../packages/platform/src/contracts.js";
import { StorefrontMappingConflictError } from "../../packages/platform/src/contracts.js";

export class InMemoryStorefrontPublicationRepository implements StorefrontPublicationRepository {
  private readonly publications = new Map<
    string,
    StorefrontPublicationRecord
  >();
  private readonly snapshots = new Map<string, StorefrontPublicationSnapshot>();
  private failNextSave = false;
  private failOnSaveCallNumber: number | null = null;
  private saveCallCount = 0;

  public constructor(seed?: {
    readonly snapshots?: readonly StorefrontPublicationSnapshot[];
    readonly publications?: readonly StorefrontPublicationRecord[];
  }) {
    for (const snapshot of seed?.snapshots ?? []) {
      if (snapshot.product) {
        this.snapshots.set(snapshot.product.productId, snapshot);
      }
    }
    for (const publication of seed?.publications ?? []) {
      this.publications.set(publicationKey(publication), publication);
    }
  }

  public putSnapshot(snapshot: StorefrontPublicationSnapshot): void {
    if (!snapshot.product) {
      throw new Error("In-memory snapshots require a product");
    }
    this.snapshots.set(snapshot.product.productId, snapshot);
  }

  public failOnceOnSave(): void {
    this.failNextSave = true;
  }

  public failOnSaveCall(callNumber: number): void {
    this.failOnSaveCallNumber = callNumber;
  }

  public async loadSnapshot(
    productId: ProductId,
  ): Promise<StorefrontPublicationSnapshot> {
    return (
      this.snapshots.get(productId) ?? {
        mappings: [],
        offers: [],
        product: null,
      }
    );
  }

  public async findPublication(input: {
    readonly productId: ProductId;
    readonly storefront: StorefrontChannel;
  }): Promise<StorefrontPublicationRecord | null> {
    return this.publications.get(publicationKey(input)) ?? null;
  }

  public async findPublicationByRemoteId(input: {
    readonly remoteProductId: StorefrontProductId;
    readonly storefront: StorefrontChannel;
  }): Promise<StorefrontPublicationRecord | null> {
    return (
      [...this.publications.values()].find(
        (publication) =>
          publication.storefront === input.storefront &&
          publication.remoteProductId === input.remoteProductId,
      ) ?? null
    );
  }

  public async isSlugReserved(input: {
    readonly slug: string;
    readonly productId: ProductId;
    readonly storefront: StorefrontChannel;
  }): Promise<boolean> {
    return [...this.publications.values()].some(
      (publication) =>
        publication.storefront === input.storefront &&
        publication.productId !== input.productId &&
        publication.slug === input.slug,
    );
  }

  public async savePublication(
    record: StorefrontPublicationRecord,
  ): Promise<StorefrontPublicationRecord> {
    this.saveCallCount += 1;
    if (this.failOnSaveCallNumber === this.saveCallCount) {
      this.failOnSaveCallNumber = null;
      throw new Error("Injected storefront publication persistence failure");
    }

    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("Injected storefront publication persistence failure");
    }

    const key = publicationKey(record);
    const existing = this.publications.get(key);
    if (
      existing?.remoteProductId &&
      record.remoteProductId &&
      existing.remoteProductId !== record.remoteProductId
    ) {
      throw new StorefrontMappingConflictError(
        "MAPPING_CONFLICT_PRODUCT_STOREFRONT",
      );
    }

    if (record.remoteProductId) {
      const remoteConflict = await this.findPublicationByRemoteId({
        remoteProductId: record.remoteProductId,
        storefront: record.storefront,
      });
      if (remoteConflict && remoteConflict.productId !== record.productId) {
        throw new StorefrontMappingConflictError(
          "MAPPING_CONFLICT_REMOTE_STOREFRONT",
        );
      }
    }

    const saved = {
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt,
    };
    this.publications.set(key, saved);
    return saved;
  }

  public listPublications(): readonly StorefrontPublicationRecord[] {
    return [...this.publications.values()].sort((left, right) =>
      publicationKey(left).localeCompare(publicationKey(right)),
    );
  }
}

const publicationKey = (input: {
  readonly productId: ProductId;
  readonly storefront: StorefrontChannel;
}): string => `${input.storefront}:${input.productId}`;
