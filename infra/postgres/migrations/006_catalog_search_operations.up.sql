CREATE TABLE catalog_search_documents (
  product_id UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  canonical_title TEXT NOT NULL,
  normalized_search_title TEXT NOT NULL,
  product_type TEXT NOT NULL,
  platforms TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  edition TEXT NOT NULL,
  active BOOLEAN NOT NULL,
  germany_publishable BOOLEAN NOT NULL,
  storefront_publication_state TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  search_document_version TEXT NOT NULL,
  search_text TSVECTOR GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      canonical_title || ' ' || normalized_search_title || ' ' ||
      product_type || ' ' || edition || ' ' || array_to_string(platforms, ' ')
    )
  ) STORED,
  CONSTRAINT catalog_search_documents_version_check CHECK (search_document_version = 'catalog-search-v1')
);

CREATE TABLE catalog_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type TEXT NOT NULL,
  status TEXT NOT NULL,
  checkpoint TEXT,
  processed_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  policy_version TEXT NOT NULL,
  last_error TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT catalog_operations_status_check CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  CONSTRAINT catalog_operations_counts_check CHECK (
    processed_count >= 0 AND changed_count >= 0 AND failed_count >= 0
  )
);

CREATE INDEX catalog_search_documents_title_prefix_idx
  ON catalog_search_documents(normalized_search_title text_pattern_ops, product_id);

CREATE INDEX catalog_search_documents_exact_filters_idx
  ON catalog_search_documents(active, germany_publishable, product_type, edition, updated_at, product_id);

CREATE INDEX catalog_search_documents_platforms_idx
  ON catalog_search_documents USING GIN(platforms);

CREATE INDEX catalog_search_documents_text_idx
  ON catalog_search_documents USING GIN(search_text);

CREATE INDEX catalog_operations_status_type_idx
  ON catalog_operations(operation_type, status, updated_at);
