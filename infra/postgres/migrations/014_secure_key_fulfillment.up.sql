CREATE TABLE fulfillment_operations (
  id UUID PRIMARY KEY,
  order_id UUID,
  procurement_operation_id UUID REFERENCES procurement_operations(id) ON DELETE RESTRICT,
  controlled_procurement_approval_id UUID REFERENCES controlled_procurement_approvals(id) ON DELETE RESTRICT,
  supplier_id TEXT NOT NULL,
  external_supplier_order_id TEXT NOT NULL,
  supplier_item_reference TEXT,
  expected_quantity INTEGER NOT NULL,
  status TEXT NOT NULL,
  retrieval_state TEXT NOT NULL,
  delivery_state TEXT NOT NULL,
  token_hash TEXT,
  approval_expires_at TIMESTAMPTZ,
  retrieval_execution_token UUID,
  retrieval_started_at TIMESTAMPTZ,
  encrypted_secret_id UUID,
  failure_reason_code TEXT,
  record_version INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  retrieved_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  CONSTRAINT fulfillment_operations_expected_quantity_check CHECK (expected_quantity = 1),
  CONSTRAINT fulfillment_operations_status_check CHECK (
    status IN (
      'PENDING',
      'READY',
      'RETRIEVAL_IN_FLIGHT',
      'RETRIEVED',
      'DELIVERY_PENDING',
      'DELIVERED',
      'FAILED_RETRYABLE',
      'FAILED_TERMINAL',
      'AMBIGUOUS',
      'MANUAL_REVIEW_REQUIRED'
    )
  ),
  CONSTRAINT fulfillment_operations_retrieval_state_check CHECK (
    retrieval_state IN (
      'NOT_STARTED',
      'IN_FLIGHT',
      'RETRIEVED',
      'FAILED_RETRYABLE',
      'FAILED_TERMINAL',
      'AMBIGUOUS',
      'MANUAL_REVIEW_REQUIRED'
    )
  ),
  CONSTRAINT fulfillment_operations_delivery_state_check CHECK (
    delivery_state IN (
      'NOT_READY',
      'PENDING',
      'DELIVERED',
      'FAILED_RETRYABLE',
      'FAILED_TERMINAL'
    )
  ),
  CONSTRAINT fulfillment_operations_version_check CHECK (record_version > 0),
  CONSTRAINT fulfillment_operations_token_hash_check CHECK (
    token_hash IS NULL
    OR token_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT fulfillment_operations_lease_tuple_check CHECK (
    (retrieval_execution_token IS NULL AND retrieval_started_at IS NULL)
    OR (retrieval_execution_token IS NOT NULL AND retrieval_started_at IS NOT NULL)
  ),
  CONSTRAINT fulfillment_operations_retrieved_tuple_check CHECK (
    encrypted_secret_id IS NULL
    OR (
      retrieval_state = 'RETRIEVED'
      AND status IN ('RETRIEVED', 'DELIVERY_PENDING', 'DELIVERED')
      AND retrieved_at IS NOT NULL
    )
  ),
  CONSTRAINT fulfillment_operations_no_sensitive_text_check CHECK (
    external_supplier_order_id !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
    AND COALESCE(supplier_item_reference, '') !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
    AND COALESCE(failure_reason_code, '') !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
  )
);

CREATE TABLE fulfillment_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id UUID NOT NULL UNIQUE REFERENCES fulfillment_operations(id) ON DELETE RESTRICT,
  ciphertext BYTEA NOT NULL,
  encryption_nonce BYTEA NOT NULL,
  encryption_tag BYTEA NOT NULL,
  wrapped_data_encryption_key BYTEA NOT NULL,
  encryption_key_id TEXT NOT NULL,
  encryption_version INTEGER NOT NULL,
  encryption_algorithm TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fulfillment_secrets_crypto_check CHECK (
    octet_length(ciphertext) > 0
    AND octet_length(encryption_nonce) = 12
    AND octet_length(encryption_tag) = 16
    AND octet_length(wrapped_data_encryption_key) > 0
    AND encryption_version = 1
    AND encryption_algorithm = 'AES-256-GCM-v1'
  ),
  CONSTRAINT fulfillment_secrets_key_id_check CHECK (
    encryption_key_id ~ '^[A-Za-z0-9_.:-]{1,120}$'
    AND encryption_key_id !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
  )
);

ALTER TABLE fulfillment_operations
  ADD CONSTRAINT fulfillment_operations_secret_fk
  FOREIGN KEY (encrypted_secret_id) REFERENCES fulfillment_secrets(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX fulfillment_operations_controlled_approval_idx
  ON fulfillment_operations(controlled_procurement_approval_id)
  WHERE controlled_procurement_approval_id IS NOT NULL;

CREATE UNIQUE INDEX fulfillment_operations_order_procurement_idx
  ON fulfillment_operations(order_id, procurement_operation_id)
  WHERE order_id IS NOT NULL AND procurement_operation_id IS NOT NULL;

CREATE INDEX fulfillment_operations_status_idx
  ON fulfillment_operations(status, retrieval_state, delivery_state);

CREATE INDEX fulfillment_operations_supplier_order_idx
  ON fulfillment_operations(supplier_id, external_supplier_order_id);
