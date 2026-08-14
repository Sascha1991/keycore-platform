# Canonical Product Grouping

KS-05-02 adds the supplier-neutral foundation for mapping supplier-specific products to canonical KeyCore products. It does not publish products to WooCommerce, create WordPress products, implement GAMIVO, call Steam, perform search indexing, or start procurement.

## Canonical vs Supplier Product

`SupplierProductId` identifies a product inside one supplier adapter. It is not globally meaningful and the same external string from two suppliers is treated as unrelated until evidence proves otherwise.

`ProductId` identifies a KeyCore canonical product. Multiple supplier products can map to one canonical product only when policy-approved evidence is strong enough.

## Policy

Policy version: `canonical-grouping-v1`.

The policy is fail-closed:

- verified trusted identifiers may auto-match when product type, platform and edition evidence are compatible;
- title-only evidence never auto-matches;
- title plus publisher, developer or release date remains `REVIEW_REQUIRED`;
- different Steam App IDs do not auto-match;
- game/DLC/software mismatches become conflict/review;
- edition markers such as Deluxe, Ultimate, GOTY, Complete, Bundle, DLC and Season Pass are identity-relevant;
- platform mismatch defaults to review unless future policy defines a trusted universal abstraction.

## Evidence Model

Strong evidence:

- verified Steam App ID;
- verified trusted platform store identifier;
- verified official product identifier;
- verified GTIN, UPC or EAN;
- explicit curated/manual mapping.

Supporting evidence:

- normalized title;
- publisher;
- developer;
- release date;
- product type;
- platform.

Supporting evidence is useful for review but not sufficient for automatic grouping.

## Title Normalization

Title normalization is deterministic and conservative:

- Unicode NFKC normalization;
- trim whitespace;
- lowercase comparison;
- normalize common punctuation and spacing.

The normalizer does not strip edition words such as Deluxe, Ultimate, GOTY, Complete, DLC, Season Pass, Bundle or Edition, because those terms may change product identity.

## Mapping State

Supplier-product mappings store:

- supplier ID;
- supplier product ID;
- optional canonical product ID;
- decision state;
- decision source;
- confidence;
- reason code;
- policy version;
- safe evidence snapshot;
- manual actor and reason where applicable;
- timestamps.

States:

- `UNMATCHED`: mapped to a newly created canonical product without cross-supplier grouping.
- `AUTO_MATCHED`: automatically grouped by strong compatible evidence.
- `MANUAL_MATCHED`: human-curated grouping.
- `REVIEW_REQUIRED`: unsafe or conflicting evidence requires review.
- `REJECTED`: proposed match rejected.
- `DETACHED`: prior mapping detached by manual action.

## Manual Overrides

The foundation supports manual commands for:

- `MANUAL_MATCH`;
- `DETACH`;
- `REJECT_MATCH`.

Manual decisions record actor references and reasons. No admin UI is included in this task.

## Re-Evaluation

Mappings can be re-evaluated under the policy version. Automatic re-evaluation must not silently move an already mapped supplier product to another canonical product. If evidence later points elsewhere, the mapping moves to review/conflict instead.

## PostgreSQL Model

Migration `004_canonical_product_grouping` adds:

- canonical metadata fields to `products`;
- `canonical_product_identifiers`;
- `supplier_product_canonical_mappings`;
- indexes for verified identifier lookup, canonical product mappings and mapping state.

It also drops the KS-05-01 unique index on `supplier_products(product_id)`, because canonical grouping requires multiple supplier products to map to one canonical product.

Raw supplier payloads, credentials, product keys and production customer/order data are not persisted by the grouping layer.

## Audit

Grouping emits audit-safe event names for:

- canonical product creation;
- automatic match;
- manual match;
- review required;
- detach;
- conflict.

Metadata contains only safe references, policy version, reason code, state and evidence type names.

## Germany Eligibility

Germany eligibility belongs to supplier offers and does not determine canonical identity. An `ALLOWED` offer and a `BLOCKED` offer can belong to the same canonical product when the underlying product identity matches.

## Routing

The grouping output prepares future routing by making this structure durable:

```text
ProductId
  +-- Supplier A product/offer
  +-- Supplier B product/offer
```

Routing and procurement are not implemented in KS-05-02.

## Scale

Strong identifier lookup is repository-indexed by identifier type and value. The grouping service does not perform all-pairs fuzzy matching across the catalog. The test suite includes a 50,000-product synthetic lookup scenario.

## Future Suppliers

Future suppliers such as GAMIVO can provide normalized evidence through the same supplier-neutral model. No GAMIVO adapter or supplier-specific grouping logic is implemented here.
