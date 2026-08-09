CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS keycore_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  supplier_product_id TEXT NOT NULL,
  title TEXT NOT NULL,
  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_products_supplier_external_unique UNIQUE (supplier_id, supplier_product_id)
);

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_type TEXT NOT NULL,
  title TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'UNKNOWN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE supplier_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  supplier_product_id UUID NOT NULL REFERENCES supplier_products(id) ON DELETE RESTRICT,
  supplier_offer_id TEXT NOT NULL,
  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_offers_supplier_external_unique UNIQUE (supplier_id, supplier_offer_id)
);

CREATE TABLE offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  supplier_offer_id UUID NOT NULL REFERENCES supplier_offers(id) ON DELETE RESTRICT,
  availability TEXT NOT NULL DEFAULT 'UNKNOWN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT offers_supplier_offer_unique UNIQUE (supplier_offer_id)
);

CREATE TABLE region_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  allowed_countries TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  excluded_countries TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  supplier_region_identifier TEXT,
  documented_semantics_reference TEXT,
  requires_vpn BOOLEAN,
  requires_foreign_account BOOLEAN,
  activation_restrictions JSONB NOT NULL DEFAULT '[]'::jsonb,
  has_missing_values BOOLEAN NOT NULL DEFAULT true,
  has_unknown_values BOOLEAN NOT NULL DEFAULT true,
  has_contradictory_evidence BOOLEAN NOT NULL DEFAULT false,
  source_evidence_version TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE region_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  region_evidence_id UUID NOT NULL REFERENCES region_evidence(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  source_evidence_version TEXT,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT region_decisions_decision_check CHECK (decision IN ('ALLOWED', 'BLOCKED', 'REVIEW_REQUIRED', 'DISABLED'))
);

CREATE TABLE price_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  availability TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT price_snapshots_amount_non_negative CHECK (amount_minor >= 0),
  CONSTRAINT price_snapshots_currency_check CHECK (currency ~ '^[A-Z]{3}$')
);

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_customer_reference TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE commerce_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  external_order_reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE commerce_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES commerce_orders(id) ON DELETE RESTRICT,
  offer_id UUID REFERENCES offers(id) ON DELETE RESTRICT,
  external_order_line_reference TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commerce_order_lines_quantity_positive CHECK (quantity > 0),
  CONSTRAINT commerce_order_lines_external_unique UNIQUE (order_id, external_order_line_reference)
);

CREATE TABLE payment_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id UUID NOT NULL REFERENCES commerce_order_lines(id) ON DELETE RESTRICT,
  provider_name TEXT NOT NULL,
  provider_event_id TEXT,
  state TEXT NOT NULL,
  amount_minor BIGINT,
  currency CHAR(3),
  idempotency_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_records_provider_event_unique UNIQUE (provider_name, provider_event_id),
  CONSTRAINT payment_records_line_idempotency_unique UNIQUE (order_line_id, idempotency_key),
  CONSTRAINT payment_records_amount_non_negative CHECK (amount_minor IS NULL OR amount_minor >= 0),
  CONSTRAINT payment_records_currency_check CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$')
);

CREATE TABLE procurement_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id UUID NOT NULL REFERENCES commerce_order_lines(id) ON DELETE RESTRICT,
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  supplier_client_reference TEXT,
  supplier_purchase_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT procurement_records_line_supplier_unique UNIQUE (order_line_id, supplier_id),
  CONSTRAINT procurement_records_client_ref_unique UNIQUE (supplier_id, supplier_client_reference),
  CONSTRAINT procurement_records_purchase_ref_unique UNIQUE (supplier_id, supplier_purchase_reference)
);

CREATE TABLE fulfillment_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id UUID NOT NULL UNIQUE REFERENCES commerce_order_lines(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  key_record_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refund_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id UUID NOT NULL REFERENCES commerce_order_lines(id) ON DELETE RESTRICT,
  provider_name TEXT,
  provider_event_id TEXT,
  refund_idempotency_reference TEXT,
  state TEXT NOT NULL,
  amount_minor BIGINT,
  currency CHAR(3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT refund_records_provider_event_unique UNIQUE (provider_name, provider_event_id),
  CONSTRAINT refund_records_idempotency_unique UNIQUE (order_line_id, refund_idempotency_reference),
  CONSTRAINT refund_records_amount_non_negative CHECK (amount_minor IS NULL OR amount_minor >= 0),
  CONSTRAINT refund_records_currency_check CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$')
);

CREATE TABLE encrypted_key_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id UUID NOT NULL UNIQUE REFERENCES commerce_order_lines(id) ON DELETE RESTRICT,
  ciphertext BYTEA NOT NULL,
  nonce BYTEA NOT NULL,
  authentication_tag BYTEA NOT NULL,
  wrapped_data_encryption_key BYTEA NOT NULL,
  algorithm TEXT NOT NULL,
  key_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ
);

ALTER TABLE fulfillment_records
  ADD CONSTRAINT fulfillment_records_key_record_fk
  FOREIGN KEY (key_record_id) REFERENCES encrypted_key_records(id) ON DELETE SET NULL;

CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  timestamp_utc TIMESTAMPTZ NOT NULL,
  actor JSONB NOT NULL,
  correlation_id TEXT NOT NULL,
  entity JSONB NOT NULL,
  environment TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_outcome_check CHECK (outcome IN ('SUCCEEDED', 'FAILED', 'DENIED')),
  CONSTRAINT audit_events_metadata_forbidden_keys CHECK (
    NOT (metadata ?| ARRAY[
      'product' || 'Key',
      'product' || '_key',
      'plain' || 'textKey',
      'plain' || 'text_key',
      'raw' || 'Key',
      'raw' || '_key',
      'decrypted' || 'Key',
      'decrypted' || '_key',
      'unencrypted' || 'ProductKey',
      'unencrypted' || '_product_key',
      'api' || 'Secret',
      'api' || '_secret',
      'password',
      'payment' || 'Credential',
      'payment' || '_credential'
    ])
  )
);

CREATE TABLE idempotency_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  order_line_id UUID REFERENCES commerce_order_lines(id) ON DELETE RESTRICT,
  provider_event_id TEXT,
  status TEXT NOT NULL,
  response_fingerprint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_records_scope_key_unique UNIQUE (scope, idempotency_key),
  CONSTRAINT idempotency_records_provider_event_unique UNIQUE (scope, provider_event_id)
);

CREATE TABLE outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id TEXT NOT NULL,
  event_deduplication_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error_classification TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ,
  CONSTRAINT outbox_events_retry_non_negative CHECK (retry_count >= 0)
);

CREATE TABLE reconciliation_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_line_id UUID REFERENCES commerce_order_lines(id) ON DELETE RESTRICT,
  reconciliation_type TEXT NOT NULL,
  state TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error_classification TEXT,
  manual_review_required BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_records_retry_non_negative CHECK (retry_count >= 0)
);

CREATE INDEX idx_supplier_products_supplier ON supplier_products(supplier_id);
CREATE INDEX idx_supplier_offers_supplier ON supplier_offers(supplier_id);
CREATE INDEX idx_offers_product ON offers(product_id);
CREATE INDEX idx_region_decisions_offer ON region_decisions(offer_id);
CREATE INDEX idx_price_snapshots_offer_captured ON price_snapshots(offer_id, captured_at DESC);
CREATE INDEX idx_commerce_order_lines_order ON commerce_order_lines(order_id);
CREATE INDEX idx_audit_events_correlation ON audit_events(correlation_id);
CREATE INDEX idx_outbox_events_status_next_attempt ON outbox_events(status, next_attempt_at);
CREATE INDEX idx_reconciliation_records_state_next_attempt ON reconciliation_records(state, next_attempt_at);
