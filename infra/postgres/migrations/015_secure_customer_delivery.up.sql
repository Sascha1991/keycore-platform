CREATE TABLE customer_key_delivery_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fulfillment_id UUID NOT NULL REFERENCES fulfillment_operations(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  version INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  context_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  correlation_id TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT customer_key_delivery_approvals_status_check CHECK (
    status IN ('AUTHORIZED', 'CONSUMED', 'EXPIRED', 'CANCELLED')
  ),
  CONSTRAINT customer_key_delivery_approvals_identity_check CHECK (
    purpose = 'customer-key-delivery'
    AND version = 1
    AND token_hash ~ '^[a-f0-9]{64}$'
    AND context_fingerprint ~ '^[a-f0-9]{64}$'
    AND length(trim(customer_id)) > 0
    AND record_version > 0
    AND expires_at > issued_at
  ),
  CONSTRAINT customer_key_delivery_approvals_consumed_check CHECK (
    (status = 'CONSUMED' AND consumed_at IS NOT NULL)
    OR (status <> 'CONSUMED' AND consumed_at IS NULL)
  ),
  CONSTRAINT customer_key_delivery_approvals_safe_text_check CHECK (
    customer_id !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
    AND correlation_id !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
  )
);

CREATE UNIQUE INDEX customer_key_delivery_one_active_approval_idx
  ON customer_key_delivery_approvals(fulfillment_id, order_id, customer_id)
  WHERE status = 'AUTHORIZED';

CREATE INDEX customer_key_delivery_approval_lookup_idx
  ON customer_key_delivery_approvals(customer_id, order_id, fulfillment_id, status);

CREATE INDEX customer_key_delivery_approval_created_idx
  ON customer_key_delivery_approvals(created_at, id);

CREATE TABLE customer_key_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID NOT NULL REFERENCES customer_key_delivery_approvals(id) ON DELETE RESTRICT,
  fulfillment_id UUID NOT NULL REFERENCES fulfillment_operations(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  execution_token UUID,
  started_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  delivery_reference TEXT,
  failure_reason_code TEXT,
  correlation_id TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT customer_key_delivery_attempts_channel_check CHECK (
    channel IN ('FAKE', 'TEST', 'ADMIN_CONTROLLED_TEST')
  ),
  CONSTRAINT customer_key_delivery_attempts_status_check CHECK (
    status IN (
      'PENDING',
      'AUTHORIZED',
      'DELIVERY_IN_FLIGHT',
      'DELIVERED',
      'FAILED_RETRYABLE',
      'FAILED_TERMINAL',
      'AMBIGUOUS',
      'MANUAL_REVIEW_REQUIRED'
    )
  ),
  CONSTRAINT customer_key_delivery_attempts_version_check CHECK (record_version > 0),
  CONSTRAINT customer_key_delivery_attempts_lease_check CHECK (
    (execution_token IS NULL AND status <> 'DELIVERY_IN_FLIGHT')
    OR (execution_token IS NOT NULL AND started_at IS NOT NULL AND status = 'DELIVERY_IN_FLIGHT')
  ),
  CONSTRAINT customer_key_delivery_attempts_delivered_check CHECK (
    (status = 'DELIVERED' AND delivered_at IS NOT NULL AND delivery_reference IS NOT NULL)
    OR status <> 'DELIVERED'
  ),
  CONSTRAINT customer_key_delivery_attempts_failure_check CHECK (
    (status IN ('FAILED_RETRYABLE', 'FAILED_TERMINAL', 'AMBIGUOUS', 'MANUAL_REVIEW_REQUIRED')
      AND failure_reason_code IS NOT NULL)
    OR status NOT IN ('FAILED_RETRYABLE', 'FAILED_TERMINAL', 'AMBIGUOUS', 'MANUAL_REVIEW_REQUIRED')
  ),
  CONSTRAINT customer_key_delivery_attempts_safe_text_check CHECK (
    customer_id !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
    AND COALESCE(delivery_reference, '') !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
    AND COALESCE(failure_reason_code, '') !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
  )
);

CREATE UNIQUE INDEX customer_key_delivery_one_success_idx
  ON customer_key_delivery_attempts(fulfillment_id)
  WHERE status = 'DELIVERED';

CREATE INDEX customer_key_delivery_attempts_state_idx
  ON customer_key_delivery_attempts(status, started_at, updated_at);

CREATE INDEX customer_key_delivery_attempts_fulfillment_idx
  ON customer_key_delivery_attempts(fulfillment_id, created_at DESC);
