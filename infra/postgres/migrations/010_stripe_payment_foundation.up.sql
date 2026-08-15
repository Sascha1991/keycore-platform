CREATE TABLE order_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  external_payment_id TEXT,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  operation_version INTEGER NOT NULL,
  stripe_idempotency_key TEXT NOT NULL,
  provider_fingerprint TEXT,
  reconciliation_required BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_provider_event_at TIMESTAMPTZ,
  CONSTRAINT order_payments_provider_check CHECK (provider = 'STRIPE'),
  CONSTRAINT order_payments_amount_currency_version_check CHECK (
    amount_minor > 0
    AND currency ~ '^[A-Z]{3}$'
    AND record_version > 0
    AND operation_version > 0
    AND length(trim(stripe_idempotency_key)) > 0
  ),
  CONSTRAINT order_payments_status_check CHECK (
    status IN (
      'CREATION_PENDING',
      'REQUIRES_PAYMENT_METHOD',
      'REQUIRES_CUSTOMER_ACTION',
      'PROCESSING',
      'AUTHORIZED',
      'CAPTURED',
      'FAILED',
      'CANCELLED',
      'RECONCILIATION_REQUIRED'
    )
  ),
  CONSTRAINT order_payments_external_identity_check CHECK (
    external_payment_id IS NULL
    OR length(trim(external_payment_id)) > 0
  ),
  CONSTRAINT order_payments_reconciliation_status_check CHECK (
    reconciliation_required = false
    OR status = 'RECONCILIATION_REQUIRED'
  )
);

CREATE UNIQUE INDEX order_payments_order_provider_idx
  ON order_payments(order_id, provider);

CREATE UNIQUE INDEX order_payments_provider_external_idx
  ON order_payments(provider, external_payment_id)
  WHERE external_payment_id IS NOT NULL;

CREATE UNIQUE INDEX order_payments_stripe_idempotency_key_idx
  ON order_payments(stripe_idempotency_key);

CREATE INDEX order_payments_status_updated_idx
  ON order_payments(status, updated_at);

CREATE FUNCTION prevent_order_payment_commercial_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.order_id <> OLD.order_id
    OR NEW.provider <> OLD.provider
    OR NEW.amount_minor <> OLD.amount_minor
    OR NEW.currency <> OLD.currency
    OR NEW.operation_version <> OLD.operation_version
    OR NEW.stripe_idempotency_key <> OLD.stripe_idempotency_key THEN
    RAISE EXCEPTION 'Order payment identity and commercial fields are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_payments_identity_commercial_immutable
BEFORE UPDATE ON order_payments
FOR EACH ROW
EXECUTE FUNCTION prevent_order_payment_commercial_update();
