DROP INDEX IF EXISTS product_price_snapshots_product_calculated_idx;
DROP INDEX IF EXISTS product_price_snapshots_fingerprint_idx;

DROP TABLE IF EXISTS product_price_snapshots;
DROP TABLE IF EXISTS product_pricing_overrides;

DROP INDEX IF EXISTS pricing_policies_single_active_idx;
DROP TABLE IF EXISTS pricing_policies;
