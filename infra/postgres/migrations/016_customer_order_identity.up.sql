CREATE TABLE keycore_customers (
  id UUID PRIMARY KEY,
  email_normalized TEXT NOT NULL,
  email_verification_state TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT keycore_customers_email_verification_state_check CHECK (
    email_verification_state IN ('UNVERIFIED', 'VERIFIED')
  ),
  CONSTRAINT keycore_customers_identity_check CHECK (
    record_version > 0
    AND length(trim(email_normalized)) > 0
    AND length(email_normalized) <= 254
    AND email_normalized = btrim(email_normalized)
    AND email_normalized ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  CONSTRAINT keycore_customers_safe_text_check CHECK (
    email_normalized !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
  )
);

CREATE UNIQUE INDEX keycore_customers_email_normalized_idx
  ON keycore_customers(email_normalized);

CREATE INDEX keycore_customers_verification_idx
  ON keycore_customers(email_verification_state, created_at);

CREATE TABLE customer_identity_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES keycore_customers(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT customer_identity_bindings_provider_check CHECK (
    provider IN ('KEYCORE', 'WOOCOMMERCE', 'TEST')
  ),
  CONSTRAINT customer_identity_bindings_identity_check CHECK (
    length(trim(provider_subject)) > 0
    AND length(provider_subject) <= 256
    AND provider_subject = btrim(provider_subject)
    AND provider_subject !~ '[[:cntrl:]]'
  ),
  CONSTRAINT customer_identity_bindings_safe_text_check CHECK (
    provider_subject !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
  )
);

CREATE UNIQUE INDEX customer_identity_bindings_provider_subject_idx
  ON customer_identity_bindings(provider, provider_subject);

CREATE INDEX customer_identity_bindings_customer_idx
  ON customer_identity_bindings(customer_id, provider);

ALTER TABLE keycore_orders
  ADD COLUMN customer_id UUID REFERENCES keycore_customers(id) ON DELETE RESTRICT;

CREATE INDEX keycore_orders_customer_idx
  ON keycore_orders(customer_id, created_at)
  WHERE customer_id IS NOT NULL;

ALTER TABLE fulfillment_operations
  ADD CONSTRAINT fulfillment_operations_order_fk
  FOREIGN KEY (order_id) REFERENCES keycore_orders(id) ON DELETE RESTRICT;

CREATE INDEX fulfillment_operations_order_idx
  ON fulfillment_operations(order_id)
  WHERE order_id IS NOT NULL;

CREATE FUNCTION prevent_keycore_order_customer_reassignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.customer_id IS NOT NULL AND NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'KeyCore order customer ownership is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER keycore_orders_customer_ownership_immutable
BEFORE UPDATE ON keycore_orders
FOR EACH ROW
EXECUTE FUNCTION prevent_keycore_order_customer_reassignment();

CREATE FUNCTION prevent_customer_verification_regression()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.email_verification_state = 'VERIFIED'
    AND NEW.email_verification_state <> 'VERIFIED' THEN
    RAISE EXCEPTION 'KeyCore customer verification state cannot regress';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER keycore_customers_verification_no_regression
BEFORE UPDATE ON keycore_customers
FOR EACH ROW
EXECUTE FUNCTION prevent_customer_verification_regression();
