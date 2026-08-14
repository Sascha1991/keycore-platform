DROP INDEX IF EXISTS supplier_product_canonical_mappings_state_idx;
DROP INDEX IF EXISTS supplier_product_canonical_mappings_product_idx;
DROP INDEX IF EXISTS canonical_product_identifiers_lookup_idx;
DROP TABLE IF EXISTS supplier_product_canonical_mappings;
DROP TABLE IF EXISTS canonical_product_identifiers;
ALTER TABLE products
  DROP COLUMN IF EXISTS canonical_metadata,
  DROP COLUMN IF EXISTS canonical_metadata_confidence,
  DROP COLUMN IF EXISTS active,
  DROP COLUMN IF EXISTS lifecycle;
CREATE UNIQUE INDEX supplier_products_supplier_product_internal_unique
  ON supplier_products(product_id)
  WHERE product_id IS NOT NULL;
