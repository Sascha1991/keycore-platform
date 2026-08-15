CREATE TABLE keycore_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  price_lock_id UUID NOT NULL REFERENCES price_locks(id) ON DELETE RESTRICT,
  customer_amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  quantity INTEGER NOT NULL,
  status TEXT NOT NULL,
  payment_status TEXT NOT NULL,
  procurement_status TEXT NOT NULL,
  fulfillment_status TEXT NOT NULL,
  risk_status TEXT NOT NULL,
  refund_status TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  idempotency_fingerprint TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT keycore_orders_money_quantity_version_check CHECK (
    customer_amount_minor > 0
    AND currency ~ '^[A-Z]{3}$'
    AND quantity = 1
    AND record_version > 0
    AND length(trim(idempotency_key)) > 0
    AND length(trim(idempotency_fingerprint)) > 0
  ),
  CONSTRAINT keycore_orders_status_check CHECK (
    status IN (
      'CREATED',
      'AWAITING_PAYMENT',
      'PAYMENT_AUTHORIZED',
      'PAYMENT_CAPTURED',
      'PROCUREMENT_PENDING',
      'PROCUREMENT_IN_PROGRESS',
      'FULFILLMENT_PENDING',
      'COMPLETED',
      'CANCELLED',
      'FAILED',
      'REFUND_PENDING',
      'REFUNDED',
      'MANUAL_REVIEW'
    )
  ),
  CONSTRAINT keycore_orders_payment_status_check CHECK (
    payment_status IN (
      'NOT_STARTED',
      'PENDING',
      'AUTHORIZED',
      'CAPTURED',
      'FAILED',
      'CANCELLED',
      'REFUNDED',
      'PARTIALLY_REFUNDED'
    )
  ),
  CONSTRAINT keycore_orders_procurement_status_check CHECK (
    procurement_status IN (
      'NOT_STARTED',
      'PENDING',
      'IN_PROGRESS',
      'SUCCEEDED',
      'FAILED_RETRYABLE',
      'FAILED_TERMINAL',
      'AMBIGUOUS'
    )
  ),
  CONSTRAINT keycore_orders_fulfillment_status_check CHECK (
    fulfillment_status IN (
      'NOT_STARTED',
      'PENDING',
      'SUCCEEDED',
      'FAILED',
      'MANUAL_REVIEW'
    )
  ),
  CONSTRAINT keycore_orders_risk_status_check CHECK (
    risk_status IN (
      'NOT_EVALUATED',
      'APPROVED',
      'REVIEW_REQUIRED',
      'REJECTED'
    )
  ),
  CONSTRAINT keycore_orders_refund_status_check CHECK (
    refund_status IN (
      'NOT_REQUESTED',
      'PENDING',
      'SUCCEEDED',
      'FAILED',
      'MANUAL_REVIEW'
    )
  ),
  CONSTRAINT keycore_orders_procurement_gate_check CHECK (
    procurement_status NOT IN ('PENDING', 'IN_PROGRESS')
    OR (
      payment_status = 'CAPTURED'
      AND risk_status = 'APPROVED'
    )
  ),
  CONSTRAINT keycore_orders_fulfillment_gate_check CHECK (
    fulfillment_status <> 'SUCCEEDED'
    OR procurement_status = 'SUCCEEDED'
  )
);

CREATE UNIQUE INDEX keycore_orders_idempotency_key_idx
  ON keycore_orders(idempotency_key);

CREATE UNIQUE INDEX keycore_orders_price_lock_owner_idx
  ON keycore_orders(price_lock_id);

CREATE INDEX keycore_orders_status_updated_idx
  ON keycore_orders(status, updated_at);

CREATE TABLE order_transition_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  from_status TEXT,
  to_status TEXT NOT NULL,
  from_payment_status TEXT,
  to_payment_status TEXT,
  from_procurement_status TEXT,
  to_procurement_status TEXT,
  from_fulfillment_status TEXT,
  to_fulfillment_status TEXT,
  from_risk_status TEXT,
  to_risk_status TEXT,
  from_refund_status TEXT,
  to_refund_status TEXT,
  reason_code TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT order_transition_history_actor_type_check CHECK (
    actor_type IN ('CUSTOMER', 'ADMIN', 'SYSTEM', 'SERVICE')
  )
);

CREATE INDEX order_transition_history_order_occurred_idx
  ON order_transition_history(order_id, occurred_at, id);

CREATE TABLE external_event_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_fingerprint TEXT NOT NULL,
  order_id UUID REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  correlation_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT external_event_receipts_identity_check CHECK (
    length(trim(provider)) > 0
    AND length(trim(external_event_id)) > 0
    AND length(trim(event_type)) > 0
    AND length(trim(event_fingerprint)) > 0
  ),
  CONSTRAINT external_event_receipts_provider_event_unique
    UNIQUE (provider, external_event_id, event_type)
);

CREATE INDEX external_event_receipts_order_idx
  ON external_event_receipts(order_id, received_at);

CREATE FUNCTION prevent_keycore_order_commercial_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.product_id <> OLD.product_id
    OR NEW.price_lock_id <> OLD.price_lock_id
    OR NEW.customer_amount_minor <> OLD.customer_amount_minor
    OR NEW.currency <> OLD.currency
    OR NEW.quantity <> OLD.quantity THEN
    RAISE EXCEPTION 'KeyCore order commercial fields are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER keycore_orders_commercial_immutable
BEFORE UPDATE ON keycore_orders
FOR EACH ROW
EXECUTE FUNCTION prevent_keycore_order_commercial_update();
