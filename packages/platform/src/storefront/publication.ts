import { createHash } from "node:crypto";

import type { Availability, Platform, ProductType } from "../domain/catalog.js";
import type { AuditEvent } from "../domain/audit.js";
import type {
  CorrelationId,
  OfferId,
  ProductId,
} from "../domain/identifiers.js";
import type { Money } from "../domain/money.js";
import type { GermanyCompatibilityDecision } from "../domain/region.js";
import type { AuditEventPort } from "../ports/core.js";
import type { SafePayload } from "../queue/job.js";
import type {
  CanonicalGroupingState,
  EditionMarker,
} from "../catalog/canonical-product-grouping.js";

export const storefrontPublicationVersion =
  "storefront-publication-v1" as const;

export const storefrontPublicationStates = [
  "NOT_PUBLISHED",
  "PENDING_CREATE",
  "PUBLISHED",
  "PENDING_UPDATE",
  "UNPUBLISH_PENDING",
  "UNPUBLISHED",
  "BLOCKED",
  "FAILED",
  "REVIEW_REQUIRED",
] as const;

export type StorefrontPublicationState =
  (typeof storefrontPublicationStates)[number];

export const storefrontPublicationOutcomes = [
  "CREATED",
  "UPDATED",
  "UNPUBLISHED",
  "BLOCKED",
  "FAILED",
  "RECONCILIATION_REQUIRED",
  "NO_OP",
] as const;

export type StorefrontPublicationOutcome =
  (typeof storefrontPublicationOutcomes)[number];

export const storefrontReasonCodes = [
  "PUBLISHED_CREATED",
  "PUBLISHED_UPDATED",
  "PUBLISHED_NO_CHANGES",
  "UNPUBLISHED_NO_ALLOWED_GERMANY_OFFER",
  "UNPUBLISHED_CANONICAL_PRODUCT_DISABLED",
  "UNPUBLISHED_IDENTITY_UNSAFE",
  "BLOCKED_CANONICAL_PRODUCT_MISSING",
  "BLOCKED_CANONICAL_PRODUCT_INACTIVE",
  "BLOCKED_MANUALLY_DISABLED",
  "BLOCKED_IDENTITY_REVIEW_REQUIRED",
  "BLOCKED_NO_SUPPLIER_OFFERS",
  "BLOCKED_NO_ACTIVE_OFFERS",
  "BLOCKED_NO_ALLOWED_GERMANY_OFFER",
  "BLOCKED_NO_IN_STOCK_ELIGIBLE_OFFER",
  "BLOCKED_REQUIRED_FIELDS_MISSING",
  "BLOCKED_PRICE_MISSING",
  "FAILED_REMOTE_CREATE",
  "FAILED_REMOTE_UPDATE",
  "FAILED_REMOTE_UNPUBLISH",
  "RECONCILE_AMBIGUOUS_CREATE",
  "RECONCILE_AMBIGUOUS_UPDATE",
  "RECONCILE_AMBIGUOUS_UNPUBLISH",
  "RECONCILE_PENDING_CREATE",
  "RECONCILE_LOCAL_PERSISTENCE_AFTER_REMOTE_CREATE",
  "MAPPING_CONFLICT_PRODUCT_STOREFRONT",
  "MAPPING_CONFLICT_REMOTE_STOREFRONT",
] as const;

export type StorefrontPublicationReasonCode =
  (typeof storefrontReasonCodes)[number];

export type StorefrontChannel = string & {
  readonly __brand: "StorefrontChannel";
};
export type StorefrontProductId = string & {
  readonly __brand: "StorefrontProductId";
};

export const storefrontChannel = (value: string): StorefrontChannel => {
  const trimmed = value.trim();
  if (!/^[A-Z0-9_:-]{2,64}$/u.test(trimmed)) {
    throw new Error("Storefront channel must be a stable uppercase identifier");
  }
  return trimmed as StorefrontChannel;
};

export const storefrontProductId = (value: string): StorefrontProductId => {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new Error("Storefront product ID must be present");
  }
  return trimmed as StorefrontProductId;
};

export interface StorefrontCanonicalProduct {
  readonly productId: ProductId;
  readonly canonicalTitle: string;
  readonly productType: ProductType;
  readonly platforms: readonly Platform[];
  readonly lifecycle: Availability;
  readonly active: boolean;
  readonly edition?: EditionMarker;
  readonly safeDescription?: string;
  readonly safeIdentifiers?: readonly StorefrontSafeIdentifier[];
  readonly manuallyDisabled?: boolean;
}

export interface StorefrontSafeIdentifier {
  readonly type:
    | "STEAM_APP_ID"
    | "PUBLISHER_PRODUCT_ID"
    | "PLATFORM_STORE_ID"
    | "GTIN"
    | "UPC"
    | "EAN"
    | "OFFICIAL_PRODUCT_ID";
  readonly value: string;
}

export interface StorefrontCanonicalMappingSummary {
  readonly state: CanonicalGroupingState;
}

export interface StorefrontOfferSummary {
  readonly offerId: OfferId;
  readonly active: boolean;
  readonly availability: Availability;
  readonly germanyCompatibility: GermanyCompatibilityDecision;
}

export interface StorefrontPublicationSnapshot {
  readonly product: StorefrontCanonicalProduct | null;
  readonly mappings: readonly StorefrontCanonicalMappingSummary[];
  readonly offers: readonly StorefrontOfferSummary[];
}

export interface StorefrontPublicationRecord {
  readonly productId: ProductId;
  readonly storefront: StorefrontChannel;
  readonly remoteProductId?: StorefrontProductId;
  readonly state: StorefrontPublicationState;
  readonly publicationVersion: typeof storefrontPublicationVersion;
  readonly fingerprint?: string;
  readonly slug?: string;
  readonly lastAttemptAt?: Date;
  readonly lastSuccessAt?: Date;
  readonly lastErrorClassification?: string;
  readonly reconciliationRequired: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StorefrontPublicationRepository {
  loadSnapshot(productId: ProductId): Promise<StorefrontPublicationSnapshot>;
  findPublication(input: {
    readonly productId: ProductId;
    readonly storefront: StorefrontChannel;
  }): Promise<StorefrontPublicationRecord | null>;
  findPublicationByRemoteId(input: {
    readonly remoteProductId: StorefrontProductId;
    readonly storefront: StorefrontChannel;
  }): Promise<StorefrontPublicationRecord | null>;
  isSlugReserved(input: {
    readonly slug: string;
    readonly productId: ProductId;
    readonly storefront: StorefrontChannel;
  }): Promise<boolean>;
  savePublication(
    record: StorefrontPublicationRecord,
  ): Promise<StorefrontPublicationRecord>;
}

export interface StorefrontPriceProvider {
  quoteSellPrice(input: {
    readonly product: StorefrontCanonicalProduct;
    readonly eligibleOffers: readonly StorefrontOfferSummary[];
    readonly correlationId: CorrelationId;
  }): Promise<Money | null>;
}

export interface StorefrontProductRepresentation {
  readonly productId: ProductId;
  readonly title: string;
  readonly slug: string;
  readonly productType: ProductType;
  readonly platforms: readonly Platform[];
  readonly edition?: EditionMarker;
  readonly lifecycle: Availability;
  readonly storefrontStatus: "PUBLISH" | "DRAFT" | "PRIVATE";
  readonly price: Money;
  readonly stockStatus: "IN_STOCK" | "OUT_OF_STOCK";
  readonly purchasable: boolean;
  readonly safeDescription?: string;
  readonly safeIdentifiers: readonly StorefrontSafeIdentifier[];
  readonly metadata: {
    readonly keycoreProductId: ProductId;
    readonly publicationVersion: typeof storefrontPublicationVersion;
    readonly fingerprint: string;
  };
}

export interface StorefrontRemoteProductSnapshot {
  readonly remoteProductId: StorefrontProductId;
  readonly status?: string;
  readonly catalogVisibility?: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface StorefrontPort {
  createProduct(
    product: StorefrontProductRepresentation,
  ): Promise<StorefrontProductId>;
  updateProduct(input: {
    readonly remoteProductId: StorefrontProductId;
    readonly product: StorefrontProductRepresentation;
  }): Promise<void>;
  unpublishProduct(input: {
    readonly remoteProductId: StorefrontProductId;
    readonly productId: ProductId;
    readonly storefront: StorefrontChannel;
    readonly correlationId: CorrelationId;
  }): Promise<void>;
  readProduct(
    remoteProductId: StorefrontProductId,
  ): Promise<StorefrontRemoteProductSnapshot | null>;
  validateConfiguration(): Promise<"HEALTHY" | "DEGRADED" | "OUTAGE">;
}

export interface StorefrontPublicationResult {
  readonly outcome: StorefrontPublicationOutcome;
  readonly reasonCode: StorefrontPublicationReasonCode;
  readonly state: StorefrontPublicationState;
  readonly record: StorefrontPublicationRecord;
  readonly representation?: StorefrontProductRepresentation;
}

export class StorefrontAmbiguousError extends Error {
  public constructor(message = "Storefront operation outcome is ambiguous") {
    super(message);
    this.name = "StorefrontAmbiguousError";
  }
}

export class StorefrontMappingConflictError extends Error {
  public constructor(
    public readonly reasonCode: Extract<
      StorefrontPublicationReasonCode,
      | "MAPPING_CONFLICT_PRODUCT_STOREFRONT"
      | "MAPPING_CONFLICT_REMOTE_STOREFRONT"
    >,
  ) {
    super(reasonCode);
    this.name = "StorefrontMappingConflictError";
  }
}

export interface StorefrontPublicationServiceOptions {
  readonly repository: StorefrontPublicationRepository;
  readonly priceProvider: StorefrontPriceProvider;
  readonly storefront: StorefrontPort;
  readonly environment: AuditEvent["environment"];
  readonly audit?: AuditEventPort;
  readonly now?: () => Date;
  readonly hideOutOfStockProducts?: boolean;
}

export class StorefrontPublicationService {
  private readonly now: () => Date;
  private readonly hideOutOfStockProducts: boolean;

  public constructor(
    private readonly options: StorefrontPublicationServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.hideOutOfStockProducts = options.hideOutOfStockProducts ?? true;
  }

  public async publish(input: {
    readonly productId: ProductId;
    readonly storefront: StorefrontChannel;
    readonly correlationId: CorrelationId;
  }): Promise<StorefrontPublicationResult> {
    const existing = await this.options.repository.findPublication(input);
    if (existing?.state === "PENDING_CREATE" && !existing.remoteProductId) {
      return this.markReconciliation({
        correlationId: input.correlationId,
        existing,
        reasonCode: "RECONCILE_PENDING_CREATE",
        storefront: input.storefront,
      });
    }
    if (existing?.reconciliationRequired) {
      return this.markReconciliation({
        correlationId: input.correlationId,
        existing,
        reasonCode: "RECONCILE_PENDING_CREATE",
        storefront: input.storefront,
      });
    }

    const snapshot = await this.options.repository.loadSnapshot(
      input.productId,
    );
    const eligibility = await this.evaluate(snapshot, input.correlationId);
    if (!eligibility.publishable) {
      return this.blockOrUnpublish({
        correlationId: input.correlationId,
        existing,
        productId: input.productId,
        reasonCode: eligibility.reasonCode,
        storefront: input.storefront,
      });
    }

    const product = requiredProduct(snapshot.product);
    const representation = buildStorefrontRepresentation({
      eligibleOffers: eligibility.eligibleOffers,
      price: eligibility.price,
      product,
      slug: await this.generateSlug({
        product,
        storefront: input.storefront,
      }),
      stockStatus: eligibility.stockStatus,
    });

    if (
      existing?.remoteProductId &&
      existing.fingerprint === representation.metadata.fingerprint &&
      existing.state === "PUBLISHED"
    ) {
      return {
        outcome: "NO_OP",
        reasonCode: "PUBLISHED_NO_CHANGES",
        record: existing,
        representation,
        state: existing.state,
      };
    }

    const existingRemoteProductId = existing?.remoteProductId;
    if (existingRemoteProductId) {
      return this.updateExisting({
        correlationId: input.correlationId,
        existing: { ...existing, remoteProductId: existingRemoteProductId },
        representation,
      });
    }

    return this.createNew({
      correlationId: input.correlationId,
      productId: input.productId,
      representation,
      storefront: input.storefront,
    });
  }

  private async createNew(input: {
    readonly productId: ProductId;
    readonly storefront: StorefrontChannel;
    readonly correlationId: CorrelationId;
    readonly representation: StorefrontProductRepresentation;
  }): Promise<StorefrontPublicationResult> {
    const pending = await this.options.repository.savePublication(
      publicationRecord({
        fingerprint: input.representation.metadata.fingerprint,
        productId: input.productId,
        slug: input.representation.slug,
        state: "PENDING_CREATE",
        storefront: input.storefront,
        now: this.now(),
      }),
    );

    let remoteCreated = false;
    let remoteProductId: StorefrontProductId | undefined;
    try {
      remoteProductId = await this.options.storefront.createProduct(
        input.representation,
      );
      remoteCreated = true;
      const remoteConflict =
        await this.options.repository.findPublicationByRemoteId({
          remoteProductId,
          storefront: input.storefront,
        });
      if (remoteConflict && remoteConflict.productId !== input.productId) {
        throw new StorefrontMappingConflictError(
          "MAPPING_CONFLICT_REMOTE_STOREFRONT",
        );
      }
      const record = await this.options.repository.savePublication({
        ...pending,
        lastSuccessAt: this.now(),
        reconciliationRequired: false,
        remoteProductId,
        state: "PUBLISHED",
        updatedAt: this.now(),
      });
      await this.audit({
        correlationId: input.correlationId,
        eventType: "STOREFRONT_PUBLICATION_CREATED",
        record,
        reasonCode: "PUBLISHED_CREATED",
      });
      return {
        outcome: "CREATED",
        reasonCode: "PUBLISHED_CREATED",
        record,
        representation: input.representation,
        state: "PUBLISHED",
      };
    } catch (error) {
      if (error instanceof StorefrontMappingConflictError) {
        return this.fail({
          correlationId: input.correlationId,
          existing: pending,
          error,
          reasonCode: error.reasonCode,
        });
      }
      if (remoteCreated) {
        return this.markReconciliation({
          correlationId: input.correlationId,
          existing: {
            ...pending,
            ...(remoteProductId ? { remoteProductId } : {}),
          },
          reasonCode: "RECONCILE_LOCAL_PERSISTENCE_AFTER_REMOTE_CREATE",
          storefront: input.storefront,
        });
      }
      if (error instanceof StorefrontAmbiguousError) {
        return this.markReconciliation({
          correlationId: input.correlationId,
          existing: pending,
          reasonCode: "RECONCILE_AMBIGUOUS_CREATE",
          storefront: input.storefront,
        });
      }
      return this.fail({
        correlationId: input.correlationId,
        existing: pending,
        error,
        reasonCode: "FAILED_REMOTE_CREATE",
      });
    }
  }

  private async updateExisting(input: {
    readonly existing: StorefrontPublicationRecord & {
      readonly remoteProductId: StorefrontProductId;
    };
    readonly representation: StorefrontProductRepresentation;
    readonly correlationId: CorrelationId;
  }): Promise<StorefrontPublicationResult> {
    const pending = await this.options.repository.savePublication({
      ...input.existing,
      fingerprint: input.representation.metadata.fingerprint,
      lastAttemptAt: this.now(),
      slug: input.representation.slug,
      state: "PENDING_UPDATE",
      updatedAt: this.now(),
    });
    try {
      await this.options.storefront.updateProduct({
        product: input.representation,
        remoteProductId: input.existing.remoteProductId,
      });
      const record = await this.options.repository.savePublication({
        ...pending,
        lastSuccessAt: this.now(),
        reconciliationRequired: false,
        state: "PUBLISHED",
        updatedAt: this.now(),
      });
      await this.audit({
        correlationId: input.correlationId,
        eventType: "STOREFRONT_PUBLICATION_UPDATED",
        record,
        reasonCode: "PUBLISHED_UPDATED",
      });
      return {
        outcome: "UPDATED",
        reasonCode: "PUBLISHED_UPDATED",
        record,
        representation: input.representation,
        state: "PUBLISHED",
      };
    } catch (error) {
      if (error instanceof StorefrontAmbiguousError) {
        return this.markReconciliation({
          correlationId: input.correlationId,
          existing: pending,
          reasonCode: "RECONCILE_AMBIGUOUS_UPDATE",
          storefront: input.existing.storefront,
        });
      }
      return this.fail({
        correlationId: input.correlationId,
        existing: pending,
        error,
        reasonCode: "FAILED_REMOTE_UPDATE",
      });
    }
  }

  private async blockOrUnpublish(input: {
    readonly productId: ProductId;
    readonly storefront: StorefrontChannel;
    readonly correlationId: CorrelationId;
    readonly existing: StorefrontPublicationRecord | null;
    readonly reasonCode: StorefrontPublicationReasonCode;
  }): Promise<StorefrontPublicationResult> {
    if (input.existing?.remoteProductId) {
      const pending = await this.options.repository.savePublication({
        ...input.existing,
        lastAttemptAt: this.now(),
        state: "UNPUBLISH_PENDING",
        updatedAt: this.now(),
      });
      try {
        await this.options.storefront.unpublishProduct({
          correlationId: input.correlationId,
          productId: input.productId,
          remoteProductId: input.existing.remoteProductId,
          storefront: input.storefront,
        });
        const record = await this.options.repository.savePublication({
          ...pending,
          lastSuccessAt: this.now(),
          reconciliationRequired: false,
          state: "UNPUBLISHED",
          updatedAt: this.now(),
        });
        await this.audit({
          correlationId: input.correlationId,
          eventType: "STOREFRONT_PUBLICATION_UNPUBLISHED",
          record,
          reasonCode: input.reasonCode,
        });
        return {
          outcome: "UNPUBLISHED",
          reasonCode: input.reasonCode,
          record,
          state: "UNPUBLISHED",
        };
      } catch (error) {
        if (error instanceof StorefrontAmbiguousError) {
          return this.markReconciliation({
            correlationId: input.correlationId,
            existing: pending,
            reasonCode: "RECONCILE_AMBIGUOUS_UNPUBLISH",
            storefront: input.storefront,
          });
        }
        return this.fail({
          correlationId: input.correlationId,
          existing: pending,
          error,
          reasonCode: "FAILED_REMOTE_UNPUBLISH",
        });
      }
    }

    const record = await this.options.repository.savePublication(
      publicationRecord({
        productId: input.productId,
        state:
          input.reasonCode === "BLOCKED_IDENTITY_REVIEW_REQUIRED"
            ? "REVIEW_REQUIRED"
            : "BLOCKED",
        storefront: input.storefront,
        now: this.now(),
      }),
    );
    await this.audit({
      correlationId: input.correlationId,
      eventType: "STOREFRONT_PUBLICATION_BLOCKED",
      record,
      reasonCode: input.reasonCode,
    });
    return {
      outcome: "BLOCKED",
      reasonCode: input.reasonCode,
      record,
      state: record.state,
    };
  }

  private async markReconciliation(input: {
    readonly existing: StorefrontPublicationRecord;
    readonly storefront: StorefrontChannel;
    readonly correlationId: CorrelationId;
    readonly reasonCode:
      | "RECONCILE_AMBIGUOUS_CREATE"
      | "RECONCILE_AMBIGUOUS_UPDATE"
      | "RECONCILE_AMBIGUOUS_UNPUBLISH"
      | "RECONCILE_PENDING_CREATE"
      | "RECONCILE_LOCAL_PERSISTENCE_AFTER_REMOTE_CREATE";
  }): Promise<StorefrontPublicationResult> {
    const record = await this.options.repository.savePublication({
      ...input.existing,
      lastAttemptAt: this.now(),
      lastErrorClassification: input.reasonCode,
      reconciliationRequired: true,
      state: "REVIEW_REQUIRED",
      updatedAt: this.now(),
    });
    await this.audit({
      correlationId: input.correlationId,
      eventType: "STOREFRONT_PUBLICATION_RECONCILIATION_REQUIRED",
      record,
      reasonCode: input.reasonCode,
    });
    return {
      outcome: "RECONCILIATION_REQUIRED",
      reasonCode: input.reasonCode,
      record,
      state: "REVIEW_REQUIRED",
    };
  }

  private async fail(input: {
    readonly existing: StorefrontPublicationRecord;
    readonly reasonCode: StorefrontPublicationReasonCode;
    readonly error: unknown;
    readonly correlationId: CorrelationId;
  }): Promise<StorefrontPublicationResult> {
    const record = await this.options.repository.savePublication({
      ...input.existing,
      lastAttemptAt: this.now(),
      lastErrorClassification:
        input.error instanceof Error ? input.error.name : "UNKNOWN_ERROR",
      reconciliationRequired: false,
      state: "FAILED",
      updatedAt: this.now(),
    });
    await this.audit({
      correlationId: input.correlationId,
      eventType: "STOREFRONT_PUBLICATION_FAILED",
      record,
      reasonCode: input.reasonCode,
    });
    return {
      outcome: "FAILED",
      reasonCode: input.reasonCode,
      record,
      state: "FAILED",
    };
  }

  private async evaluate(
    snapshot: StorefrontPublicationSnapshot,
    correlationId: CorrelationId,
  ): Promise<
    | {
        readonly publishable: false;
        readonly reasonCode: StorefrontPublicationReasonCode;
      }
    | {
        readonly publishable: true;
        readonly eligibleOffers: readonly StorefrontOfferSummary[];
        readonly price: Money;
        readonly stockStatus: "IN_STOCK" | "OUT_OF_STOCK";
      }
  > {
    const product = snapshot.product;
    if (!product) {
      return {
        publishable: false,
        reasonCode: "BLOCKED_CANONICAL_PRODUCT_MISSING",
      };
    }
    if (!product.active) {
      return {
        publishable: false,
        reasonCode: "BLOCKED_CANONICAL_PRODUCT_INACTIVE",
      };
    }
    if (product.manuallyDisabled) {
      return { publishable: false, reasonCode: "BLOCKED_MANUALLY_DISABLED" };
    }
    if (requiredFieldMissing(product)) {
      return {
        publishable: false,
        reasonCode: "BLOCKED_REQUIRED_FIELDS_MISSING",
      };
    }
    if (snapshot.mappings.some((mapping) => !safeMappingState(mapping.state))) {
      return {
        publishable: false,
        reasonCode: "BLOCKED_IDENTITY_REVIEW_REQUIRED",
      };
    }
    if (snapshot.offers.length === 0) {
      return { publishable: false, reasonCode: "BLOCKED_NO_SUPPLIER_OFFERS" };
    }
    const activeOffers = snapshot.offers.filter((offer) => offer.active);
    if (activeOffers.length === 0) {
      return { publishable: false, reasonCode: "BLOCKED_NO_ACTIVE_OFFERS" };
    }
    const eligibleOffers = activeOffers.filter(
      (offer) => offer.germanyCompatibility === "ALLOWED",
    );
    if (eligibleOffers.length === 0) {
      return {
        publishable: false,
        reasonCode: "BLOCKED_NO_ALLOWED_GERMANY_OFFER",
      };
    }
    const inStockOffers = eligibleOffers.filter(
      (offer) =>
        offer.availability === "IN_STOCK" || offer.availability === "LIMITED",
    );
    const stockStatus: "IN_STOCK" | "OUT_OF_STOCK" =
      inStockOffers.length > 0 ? "IN_STOCK" : "OUT_OF_STOCK";
    if (this.hideOutOfStockProducts && stockStatus === "OUT_OF_STOCK") {
      return {
        publishable: false,
        reasonCode: "BLOCKED_NO_IN_STOCK_ELIGIBLE_OFFER",
      };
    }
    const price = await this.options.priceProvider.quoteSellPrice({
      correlationId,
      eligibleOffers,
      product,
    });
    if (!price) {
      return { publishable: false, reasonCode: "BLOCKED_PRICE_MISSING" };
    }
    return {
      eligibleOffers,
      price,
      publishable: true,
      stockStatus,
    };
  }

  private async generateSlug(input: {
    readonly product: StorefrontCanonicalProduct;
    readonly storefront: StorefrontChannel;
  }): Promise<string> {
    const base = slugBase(
      `${input.product.canonicalTitle} ${input.product.edition && input.product.edition !== "UNKNOWN" ? input.product.edition.toLowerCase().replaceAll("_", " ") : ""}`,
    );
    if (
      !(await this.options.repository.isSlugReserved({
        productId: input.product.productId,
        slug: base,
        storefront: input.storefront,
      }))
    ) {
      return base;
    }
    return `${base}-${shortHash(input.product.productId)}`;
  }

  private async audit(input: {
    readonly eventType: AuditEvent["eventType"];
    readonly record: StorefrontPublicationRecord;
    readonly reasonCode: StorefrontPublicationReasonCode;
    readonly correlationId: CorrelationId;
  }): Promise<void> {
    await this.options.audit?.append({
      actor: { id: "storefront-publication-service", type: "SERVICE" },
      correlationId: input.correlationId,
      entity: { id: input.record.productId, type: "PRODUCT" },
      environment: this.options.environment,
      eventType: input.eventType,
      metadata: {
        fingerprint: input.record.fingerprint ?? "",
        productId: input.record.productId,
        publicationVersion: input.record.publicationVersion,
        reconciliationRequired: input.record.reconciliationRequired,
        remoteProductId: input.record.remoteProductId ?? "",
        state: input.record.state,
        storefront: input.record.storefront,
      },
      outcome:
        input.eventType === "STOREFRONT_PUBLICATION_FAILED"
          ? "FAILED"
          : "SUCCEEDED",
      reasonCode: input.reasonCode,
      timestampUtc: this.now(),
      uuid: `audit-${input.record.productId}-${input.record.state}-${input.record.updatedAt.getTime()}`,
    });
  }
}

export const buildStorefrontRepresentation = (input: {
  readonly product: StorefrontCanonicalProduct;
  readonly eligibleOffers: readonly StorefrontOfferSummary[];
  readonly price: Money;
  readonly stockStatus: "IN_STOCK" | "OUT_OF_STOCK";
  readonly slug: string;
}): StorefrontProductRepresentation => {
  const safeIdentifiers = [...(input.product.safeIdentifiers ?? [])].sort(
    (left, right) =>
      `${left.type}:${left.value}`.localeCompare(
        `${right.type}:${right.value}`,
      ),
  );
  const fingerprint = publicationFingerprint({
    edition: input.product.edition ?? "UNKNOWN",
    lifecycle: input.product.lifecycle,
    platforms: input.product.platforms,
    price: input.price,
    productId: input.product.productId,
    productType: input.product.productType,
    safeIdentifiers,
    stockStatus: input.stockStatus,
    title: input.product.canonicalTitle,
    visibility: "PUBLISH",
  });
  return {
    lifecycle: input.product.lifecycle,
    metadata: {
      fingerprint,
      keycoreProductId: input.product.productId,
      publicationVersion: storefrontPublicationVersion,
    },
    platforms: [...input.product.platforms].sort(),
    price: input.price,
    productId: input.product.productId,
    productType: input.product.productType,
    purchasable: input.stockStatus === "IN_STOCK",
    safeIdentifiers,
    slug: input.slug,
    stockStatus: input.stockStatus,
    storefrontStatus: "PUBLISH",
    title: input.product.canonicalTitle,
    ...(input.product.edition ? { edition: input.product.edition } : {}),
    ...(input.product.safeDescription
      ? { safeDescription: input.product.safeDescription }
      : {}),
  };
};

export const publicationFingerprint = (input: {
  readonly productId: ProductId;
  readonly title: string;
  readonly productType: ProductType;
  readonly platforms: readonly Platform[];
  readonly edition: EditionMarker;
  readonly lifecycle: Availability;
  readonly price: Money;
  readonly stockStatus: "IN_STOCK" | "OUT_OF_STOCK";
  readonly visibility: "PUBLISH" | "DRAFT" | "PRIVATE";
  readonly safeIdentifiers: readonly StorefrontSafeIdentifier[];
}): string =>
  createHash("sha256")
    .update(
      canonicalJson({
        edition: input.edition,
        lifecycle: input.lifecycle,
        platforms: [...input.platforms].sort(),
        price: `${input.price.currency}:${input.price.amountMinor.toString()}`,
        productId: input.productId,
        productType: input.productType,
        safeIdentifiers: [...input.safeIdentifiers].sort((left, right) =>
          `${left.type}:${left.value}`.localeCompare(
            `${right.type}:${right.value}`,
          ),
        ),
        stockStatus: input.stockStatus,
        title: input.title,
        visibility: input.visibility,
      }),
    )
    .digest("hex");

export const storefrontReevaluationJobPayload = (input: {
  readonly productId: ProductId;
  readonly storefront: StorefrontChannel;
  readonly correlationId: CorrelationId;
}): SafePayload => ({
  correlationId: input.correlationId,
  productId: input.productId,
  storefront: input.storefront,
});

export const publicationRecord = (input: {
  readonly productId: ProductId;
  readonly storefront: StorefrontChannel;
  readonly state: StorefrontPublicationState;
  readonly now: Date;
  readonly remoteProductId?: StorefrontProductId;
  readonly fingerprint?: string;
  readonly slug?: string;
}): StorefrontPublicationRecord => ({
  createdAt: input.now,
  lastAttemptAt: input.now,
  productId: input.productId,
  publicationVersion: storefrontPublicationVersion,
  reconciliationRequired: false,
  state: input.state,
  storefront: input.storefront,
  updatedAt: input.now,
  ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
  ...(input.remoteProductId ? { remoteProductId: input.remoteProductId } : {}),
  ...(input.slug ? { slug: input.slug } : {}),
});

const requiredProduct = (
  product: StorefrontCanonicalProduct | null,
): StorefrontCanonicalProduct => {
  if (!product) {
    throw new Error("Expected canonical product");
  }
  return product;
};

const requiredFieldMissing = (product: StorefrontCanonicalProduct): boolean =>
  product.canonicalTitle.trim().length === 0 ||
  product.productType === "UNKNOWN" ||
  product.platforms.length === 0 ||
  product.platforms.includes("UNKNOWN");

const safeMappingState = (state: CanonicalGroupingState): boolean =>
  state === "UNMATCHED" ||
  state === "AUTO_MATCHED" ||
  state === "MANUAL_MATCHED";

export const slugBase = (value: string): string => {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['"]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  return slug.length > 0 ? slug : "product";
};

const shortHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 8);

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};
