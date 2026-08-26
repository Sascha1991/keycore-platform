ALTER TABLE keycore_orders
  ADD COLUMN checkout_email_normalized TEXT;

ALTER TABLE keycore_orders
  ADD CONSTRAINT keycore_orders_checkout_email_snapshot_check CHECK (
    checkout_email_normalized IS NULL
    OR (
      length(checkout_email_normalized) > 2
      AND length(checkout_email_normalized) <= 254
      AND checkout_email_normalized = btrim(checkout_email_normalized)
      AND checkout_email_normalized !~ '[[:space:][:cntrl:]]'
      AND position('@' in checkout_email_normalized) > 1
      AND checkout_email_normalized !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
    )
  );

CREATE FUNCTION prevent_keycore_order_checkout_email_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.checkout_email_normalized IS DISTINCT FROM OLD.checkout_email_normalized THEN
    RAISE EXCEPTION 'KeyCore order checkout email snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER keycore_orders_checkout_email_immutable
BEFORE UPDATE ON keycore_orders
FOR EACH ROW
EXECUTE FUNCTION prevent_keycore_order_checkout_email_update();

CREATE INDEX keycore_orders_guest_checkout_email_idx
  ON keycore_orders(checkout_email_normalized)
  WHERE customer_id IS NULL AND checkout_email_normalized IS NOT NULL;

CREATE TABLE guest_order_claim_challenges (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  email_normalized_snapshot TEXT NOT NULL,
  purpose TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  record_version INTEGER NOT NULL,
  CONSTRAINT guest_order_claim_purpose_check CHECK (
    purpose IN ('GUEST_ORDER_CLAIM')
  ),
  CONSTRAINT guest_order_claim_token_hash_check CHECK (
    token_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT guest_order_claim_lifecycle_check CHECK (
    record_version > 0
    AND length(email_normalized_snapshot) > 2
    AND length(email_normalized_snapshot) <= 254
    AND email_normalized_snapshot = btrim(email_normalized_snapshot)
    AND email_normalized_snapshot !~ '[[:space:][:cntrl:]]'
    AND position('@' in email_normalized_snapshot) > 1
    AND expires_at > created_at
    AND (consumed_at IS NULL OR consumed_at >= created_at)
    AND (revoked_at IS NULL OR revoked_at >= created_at)
    AND NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT guest_order_claim_safe_text_check CHECK (
    email_normalized_snapshot !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
  )
);

CREATE UNIQUE INDEX guest_order_claim_token_hash_idx
  ON guest_order_claim_challenges(token_hash);

CREATE INDEX guest_order_claim_order_active_idx
  ON guest_order_claim_challenges(order_id, purpose, created_at DESC)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX guest_order_claim_expires_at_idx
  ON guest_order_claim_challenges(expires_at);
