ALTER TABLE supplier_products
  ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS lifecycle TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_sync_run_id UUID;

ALTER TABLE supplier_offers
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_sync_run_id UUID;

CREATE TABLE catalog_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  CONSTRAINT catalog_sync_runs_mode_check CHECK (mode IN ('FULL', 'INCREMENTAL', 'WEBHOOK')),
  CONSTRAINT catalog_sync_runs_status_check CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED'))
);

ALTER TABLE supplier_products
  ADD CONSTRAINT supplier_products_last_sync_run_fk
  FOREIGN KEY (last_sync_run_id) REFERENCES catalog_sync_runs(id) ON DELETE SET NULL;

ALTER TABLE supplier_offers
  ADD CONSTRAINT supplier_offers_last_sync_run_fk
  FOREIGN KEY (last_sync_run_id) REFERENCES catalog_sync_runs(id) ON DELETE SET NULL;

CREATE TABLE catalog_sync_checkpoints (
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL,
  cursor TEXT,
  high_watermark TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (supplier_id, mode),
  CONSTRAINT catalog_sync_checkpoints_mode_check CHECK (mode IN ('FULL', 'INCREMENTAL'))
);

CREATE INDEX catalog_sync_runs_supplier_started_idx
  ON catalog_sync_runs(supplier_id, started_at DESC);

CREATE INDEX supplier_products_active_idx
  ON supplier_products(supplier_id, active);

CREATE INDEX supplier_offers_active_idx
  ON supplier_offers(supplier_id, active);

CREATE UNIQUE INDEX supplier_products_supplier_product_internal_unique
  ON supplier_products(product_id)
  WHERE product_id IS NOT NULL;
