CREATE TABLE storefront_publications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  storefront TEXT NOT NULL,
  remote_product_id TEXT,
  state TEXT NOT NULL,
  publication_version TEXT NOT NULL,
  fingerprint TEXT,
  slug TEXT,
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error_classification TEXT,
  reconciliation_required BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT storefront_publications_state_check CHECK (
    state IN (
      'NOT_PUBLISHED',
      'PENDING_CREATE',
      'PUBLISHED',
      'PENDING_UPDATE',
      'UNPUBLISH_PENDING',
      'UNPUBLISHED',
      'BLOCKED',
      'FAILED',
      'REVIEW_REQUIRED'
    )
  ),
  CONSTRAINT storefront_publications_product_storefront_unique UNIQUE (product_id, storefront)
);

CREATE UNIQUE INDEX storefront_publications_remote_storefront_unique
  ON storefront_publications(storefront, remote_product_id)
  WHERE remote_product_id IS NOT NULL;

CREATE INDEX storefront_publications_state_idx
  ON storefront_publications(storefront, state, updated_at);
