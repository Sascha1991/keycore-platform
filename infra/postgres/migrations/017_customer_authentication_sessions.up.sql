CREATE UNIQUE INDEX customer_identity_bindings_id_customer_unique_idx
  ON customer_identity_bindings(id, customer_id);

CREATE TABLE customer_auth_sessions (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES keycore_customers(id) ON DELETE RESTRICT,
  identity_binding_id UUID NOT NULL,
  provider TEXT NOT NULL,
  session_token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  authenticated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  record_version INTEGER NOT NULL,
  auth_assurance TEXT NOT NULL,
  auth_context_id TEXT NOT NULL,
  CONSTRAINT customer_auth_sessions_binding_customer_fk
    FOREIGN KEY (identity_binding_id, customer_id)
    REFERENCES customer_identity_bindings(id, customer_id)
    ON DELETE RESTRICT,
  CONSTRAINT customer_auth_sessions_provider_check CHECK (
    provider IN ('KEYCORE', 'WOOCOMMERCE', 'TEST')
  ),
  CONSTRAINT customer_auth_sessions_assurance_check CHECK (
    auth_assurance IN ('AUTHENTICATED', 'TEST')
  ),
  CONSTRAINT customer_auth_sessions_hash_check CHECK (
    session_token_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT customer_auth_sessions_lifecycle_check CHECK (
    record_version > 0
    AND created_at >= authenticated_at
    AND expires_at > authenticated_at
    AND expires_at > created_at
    AND last_seen_at >= created_at
    AND (revoked_at IS NULL OR revoked_at >= authenticated_at)
    AND length(trim(auth_context_id)) > 0
    AND length(auth_context_id) <= 120
    AND auth_context_id = btrim(auth_context_id)
    AND auth_context_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT customer_auth_sessions_safe_text_check CHECK (
    auth_context_id !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
  )
);

CREATE UNIQUE INDEX customer_auth_sessions_token_hash_idx
  ON customer_auth_sessions(session_token_hash);

CREATE INDEX customer_auth_sessions_customer_active_idx
  ON customer_auth_sessions(customer_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX customer_auth_sessions_expires_at_idx
  ON customer_auth_sessions(expires_at);

CREATE INDEX customer_auth_sessions_revoked_at_idx
  ON customer_auth_sessions(revoked_at)
  WHERE revoked_at IS NOT NULL;

CREATE INDEX customer_auth_sessions_binding_idx
  ON customer_auth_sessions(identity_binding_id, customer_id);
