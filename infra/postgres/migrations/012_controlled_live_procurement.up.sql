CREATE TABLE controlled_procurement_approvals (
  id UUID PRIMARY KEY,
  mode TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  supplier_product_id TEXT NOT NULL,
  supplier_offer_id TEXT NOT NULL,
  product_title TEXT,
  quantity INTEGER NOT NULL,
  maximum_acquisition_amount_minor BIGINT NOT NULL,
  current_acquisition_amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  purchase_request_fingerprint TEXT NOT NULL,
  order_external_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  dispatch_state TEXT NOT NULL,
  external_supplier_order_id TEXT,
  supplier_status TEXT,
  response_fingerprint TEXT,
  failure_reason_code TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  dispatch_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  record_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT controlled_procurement_mode_check CHECK (
    mode = 'CONTROLLED_VERIFICATION'
  ),
  CONSTRAINT controlled_procurement_supplier_check CHECK (
    supplier_id = 'kinguin'
  ),
  CONSTRAINT controlled_procurement_quantity_check CHECK (quantity = 1),
  CONSTRAINT controlled_procurement_amounts_check CHECK (
    maximum_acquisition_amount_minor > 0
    AND current_acquisition_amount_minor > 0
    AND current_acquisition_amount_minor <= maximum_acquisition_amount_minor
  ),
  CONSTRAINT controlled_procurement_currency_check CHECK (
    currency ~ '^[A-Z]{3}$'
  ),
  CONSTRAINT controlled_procurement_refs_check CHECK (
    length(trim(supplier_product_id)) > 0
    AND length(trim(supplier_offer_id)) > 0
    AND length(trim(purchase_request_fingerprint)) = 64
    AND length(trim(order_external_id)) > 0
    AND length(trim(token_hash)) = 64
  ),
  CONSTRAINT controlled_procurement_status_check CHECK (
    status IN (
      'PENDING_APPROVAL',
      'APPROVED',
      'CONSUMED',
      'EXPIRED',
      'CANCELLED',
      'PROCUREMENT_CONFIRMED',
      'PROCUREMENT_REJECTED',
      'AMBIGUOUS',
      'MANUAL_REVIEW_REQUIRED'
    )
  ),
  CONSTRAINT controlled_procurement_dispatch_check CHECK (
    dispatch_state IN (
      'NOT_DISPATCHED',
      'CLAIMED',
      'DISPATCH_STARTED',
      'DISPATCH_CONFIRMED',
      'DISPATCH_REJECTED',
      'DISPATCH_AMBIGUOUS'
    )
  ),
  CONSTRAINT controlled_procurement_version_check CHECK (record_version > 0),
  CONSTRAINT controlled_procurement_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT controlled_procurement_claim_tuple_check CHECK (
    (claimed_at IS NULL AND consumed_at IS NULL)
    OR (claimed_at IS NOT NULL AND consumed_at IS NOT NULL)
  ),
  CONSTRAINT controlled_procurement_success_evidence_check CHECK (
    status <> 'PROCUREMENT_CONFIRMED'
    OR (
      dispatch_state = 'DISPATCH_CONFIRMED'
      AND external_supplier_order_id IS NOT NULL
      AND response_fingerprint IS NOT NULL
    )
  ),
  CONSTRAINT controlled_procurement_no_sensitive_text_check CHECK (
    purchase_request_fingerprint !~* '(product.?key|serial|plaintext|token|api.?key)'
    AND order_external_id !~* '(product.?key|serial|plaintext|token|api.?key)'
    AND token_hash !~* '(product.?key|serial|plaintext|token|api.?key)'
    AND (
      response_fingerprint IS NULL
      OR response_fingerprint !~* '(product.?key|serial|plaintext|token|api.?key)'
    )
  )
);

CREATE UNIQUE INDEX controlled_procurement_order_external_id_idx
  ON controlled_procurement_approvals(supplier_id, order_external_id);

CREATE UNIQUE INDEX controlled_procurement_one_active_identity_idx
  ON controlled_procurement_approvals(
    supplier_id,
    supplier_product_id,
    supplier_offer_id,
    order_external_id
  )
  WHERE status IN ('PENDING_APPROVAL', 'APPROVED', 'CONSUMED');

CREATE INDEX controlled_procurement_status_expiry_idx
  ON controlled_procurement_approvals(status, expires_at);
