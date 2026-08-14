DROP INDEX IF EXISTS supplier_product_canonical_mappings_state_idx;
DROP INDEX IF EXISTS supplier_product_canonical_mappings_product_idx;
DROP INDEX IF EXISTS canonical_product_identifiers_lookup_idx;
DROP TABLE IF EXISTS supplier_product_canonical_mappings;
DROP TABLE IF EXISTS canonical_product_identifiers;
ALTER TABLE IF EXISTS products
  DROP COLUMN IF EXISTS canonical_metadata,
  DROP COLUMN IF EXISTS canonical_metadata_confidence,
  DROP COLUMN IF EXISTS active,
  DROP COLUMN IF EXISTS lifecycle;

-- Do not recreate supplier_products_supplier_product_internal_unique.
-- KS-05-02 intentionally allows many supplier_products rows to reference
-- the same canonical products.id. Restoring the old KS-05-01 uniqueness
-- invariant would make rollback data-destructive or fail after legitimate
-- canonical grouping data exists. The supplier_products.product_id projection
-- remains in place across rollback.
