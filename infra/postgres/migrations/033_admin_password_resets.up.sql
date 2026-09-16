CREATE TABLE admin_password_reset_requests (
  id UUID PRIMARY KEY,
  admin_id UUID NOT NULL REFERENCES admin_identities(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  CONSTRAINT admin_password_reset_requests_token_hash_check CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT admin_password_reset_requests_lifecycle_check CHECK (
    expires_at > issued_at
    AND (consumed_at IS NULL OR consumed_at >= issued_at)
    AND (invalidated_at IS NULL OR invalidated_at >= issued_at)
    AND NOT (consumed_at IS NOT NULL AND invalidated_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX admin_password_reset_requests_token_hash_idx
  ON admin_password_reset_requests(token_hash);
CREATE INDEX admin_password_reset_requests_admin_issued_idx
  ON admin_password_reset_requests(admin_id, issued_at DESC);
CREATE UNIQUE INDEX admin_password_reset_requests_active_idx
  ON admin_password_reset_requests(admin_id)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;
