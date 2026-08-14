DROP INDEX IF EXISTS supplier_products_supplier_product_internal_unique;
DROP INDEX IF EXISTS supplier_offers_active_idx;
DROP INDEX IF EXISTS supplier_products_active_idx;
DROP INDEX IF EXISTS catalog_sync_runs_supplier_started_idx;
DROP TABLE IF EXISTS catalog_sync_checkpoints;
ALTER TABLE IF EXISTS supplier_offers DROP CONSTRAINT IF EXISTS supplier_offers_last_sync_run_fk;
ALTER TABLE IF EXISTS supplier_products DROP CONSTRAINT IF EXISTS supplier_products_last_sync_run_fk;
DROP TABLE IF EXISTS catalog_sync_runs;
ALTER TABLE IF EXISTS supplier_offers
  DROP COLUMN IF EXISTS last_sync_run_id,
  DROP COLUMN IF EXISTS last_seen_at,
  DROP COLUMN IF EXISTS first_seen_at,
  DROP COLUMN IF EXISTS active;
ALTER TABLE IF EXISTS supplier_products
  DROP COLUMN IF EXISTS last_sync_run_id,
  DROP COLUMN IF EXISTS last_seen_at,
  DROP COLUMN IF EXISTS first_seen_at,
  DROP COLUMN IF EXISTS active,
  DROP COLUMN IF EXISTS lifecycle,
  DROP COLUMN IF EXISTS product_id;
