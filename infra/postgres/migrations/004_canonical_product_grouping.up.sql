DROP INDEX IF EXISTS supplier_products_supplier_product_internal_unique;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS lifecycle TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS canonical_metadata_confidence TEXT NOT NULL DEFAULT 'LOW',
  ADD COLUMN IF NOT EXISTS canonical_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE canonical_product_identifiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  trusted_source TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT canonical_product_identifiers_unique UNIQUE (identifier_type, identifier_value, product_id)
);

CREATE TABLE supplier_product_canonical_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  supplier_product_id UUID NOT NULL REFERENCES supplier_products(id) ON DELETE RESTRICT,
  product_id UUID REFERENCES products(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  decision_source TEXT NOT NULL,
  confidence TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_ref TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_product_canonical_mapping_unique UNIQUE (supplier_id, supplier_product_id),
  CONSTRAINT supplier_product_canonical_mapping_state_check CHECK (state IN ('UNMATCHED', 'AUTO_MATCHED', 'MANUAL_MATCHED', 'REVIEW_REQUIRED', 'REJECTED', 'DETACHED')),
  CONSTRAINT supplier_product_canonical_mapping_source_check CHECK (decision_source IN ('AUTO', 'MANUAL', 'SYSTEM')),
  CONSTRAINT supplier_product_canonical_mapping_confidence_check CHECK (confidence IN ('NONE', 'WEAK', 'MEDIUM', 'STRONG'))
);

CREATE INDEX canonical_product_identifiers_lookup_idx
  ON canonical_product_identifiers(identifier_type, identifier_value)
  WHERE verified = true;

CREATE INDEX supplier_product_canonical_mappings_product_idx
  ON supplier_product_canonical_mappings(product_id)
  WHERE product_id IS NOT NULL;

CREATE INDEX supplier_product_canonical_mappings_state_idx
  ON supplier_product_canonical_mappings(state);
