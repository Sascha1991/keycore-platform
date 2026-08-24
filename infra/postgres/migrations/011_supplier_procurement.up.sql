CREATE TABLE procurement_operations (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  supplier_id TEXT NOT NULL,
  supplier_product_id TEXT NOT NULL,
  supplier_offer_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  status TEXT NOT NULL,
  dispatch_state TEXT NOT NULL,
  acquisition_amount_minor BIGINT,
  acquisition_currency CHAR(3),
  external_supplier_order_id TEXT,
  normalized_supplier_status TEXT,
  response_fingerprint TEXT,
  execution_token UUID,
  execution_started_at TIMESTAMPTZ,
  attempt_generation INTEGER NOT NULL,
  record_version INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  last_reconciled_at TIMESTAMPTZ,
  reconciliation_reason_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT procurement_operations_status_check CHECK (
    status IN (
      'PENDING',
      'READY',
      'IN_FLIGHT',
      'SUCCEEDED',
      'FAILED_RETRYABLE',
      'FAILED_TERMINAL',
      'AMBIGUOUS',
      'RECONCILIATION_REQUIRED'
    )
  ),
  CONSTRAINT procurement_operations_dispatch_state_check CHECK (
    dispatch_state IN (
      'NOT_DISPATCHED',
      'DISPATCH_STARTED',
      'DISPATCH_CONFIRMED'
    )
  ),
  CONSTRAINT procurement_operations_quantity_check CHECK (quantity = 1),
  CONSTRAINT procurement_operations_generation_check CHECK (attempt_generation > 0),
  CONSTRAINT procurement_operations_record_version_check CHECK (record_version > 0),
  CONSTRAINT procurement_operations_supplier_refs_check CHECK (
    length(trim(supplier_id)) > 0
    AND length(trim(supplier_product_id)) > 0
    AND length(trim(supplier_offer_id)) > 0
  ),
  CONSTRAINT procurement_operations_execution_tuple_check CHECK (
    (execution_token IS NULL AND execution_started_at IS NULL)
    OR (execution_token IS NOT NULL AND execution_started_at IS NOT NULL)
  ),
  CONSTRAINT procurement_operations_acquisition_tuple_check CHECK (
    (
      acquisition_amount_minor IS NULL
      AND acquisition_currency IS NULL
    )
    OR (
      acquisition_amount_minor IS NOT NULL
      AND acquisition_amount_minor >= 0
      AND acquisition_currency IS NOT NULL
    )
  ),
  CONSTRAINT procurement_operations_success_evidence_check CHECK (
    status <> 'SUCCEEDED'
    OR (
      dispatch_state = 'DISPATCH_CONFIRMED'
      AND external_supplier_order_id IS NOT NULL
      AND response_fingerprint IS NOT NULL
    )
  ),
  CONSTRAINT procurement_operations_no_product_key_fields_check CHECK (
    response_fingerprint IS NULL
    OR response_fingerprint !~* '(product.?key|serial|plaintext)'
  )
);

CREATE UNIQUE INDEX procurement_operations_order_generation_idx
  ON procurement_operations(order_id, attempt_generation);

CREATE UNIQUE INDEX procurement_operations_one_success_per_order_idx
  ON procurement_operations(order_id)
  WHERE status = 'SUCCEEDED';

CREATE UNIQUE INDEX procurement_operations_external_supplier_order_idx
  ON procurement_operations(supplier_id, external_supplier_order_id)
  WHERE external_supplier_order_id IS NOT NULL;

CREATE INDEX procurement_operations_order_status_idx
  ON procurement_operations(order_id, status, attempt_generation);

CREATE INDEX procurement_operations_execution_recovery_idx
  ON procurement_operations(status, dispatch_state, execution_started_at)
  WHERE execution_token IS NOT NULL;
