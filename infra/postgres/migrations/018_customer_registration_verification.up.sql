CREATE TABLE customer_email_verification_challenges (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES keycore_customers(id) ON DELETE RESTRICT,
  email_normalized_snapshot TEXT NOT NULL,
  purpose TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  record_version INTEGER NOT NULL,
  CONSTRAINT customer_email_verification_purpose_check CHECK (
    purpose IN ('EMAIL_VERIFICATION')
  ),
  CONSTRAINT customer_email_verification_token_hash_check CHECK (
    token_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT customer_email_verification_lifecycle_check CHECK (
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
  CONSTRAINT customer_email_verification_safe_text_check CHECK (
    email_normalized_snapshot !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
  )
);

CREATE UNIQUE INDEX customer_email_verification_token_hash_idx
  ON customer_email_verification_challenges(token_hash);

CREATE INDEX customer_email_verification_customer_active_idx
  ON customer_email_verification_challenges(customer_id, purpose, email_normalized_snapshot, created_at DESC)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX customer_email_verification_expires_at_idx
  ON customer_email_verification_challenges(expires_at);
