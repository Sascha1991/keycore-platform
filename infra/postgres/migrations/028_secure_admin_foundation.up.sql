CREATE TABLE admin_identities (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT admin_identities_provider_check CHECK (
    provider IN ('OIDC', 'STAGING_SYNTHETIC')
  ),
  CONSTRAINT admin_identities_status_check CHECK (
    status IN ('ACTIVE', 'DISABLED')
  ),
  CONSTRAINT admin_identities_safe_text_check CHECK (
    provider_subject = btrim(provider_subject)
    AND display_name = btrim(display_name)
    AND length(provider_subject) BETWEEN 1 AND 256
    AND length(display_name) BETWEEN 1 AND 120
    AND provider_subject !~ '[[:cntrl:]]'
    AND display_name !~ '[[:cntrl:]]'
    AND provider_subject !~* '(password|product.?key|api.?key|secret|token)'
  )
);

CREATE UNIQUE INDEX admin_identities_provider_subject_idx
  ON admin_identities(provider, provider_subject);

CREATE TABLE admin_role_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES admin_identities(id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT admin_role_assignments_role_check CHECK (
    role IN ('PROJECT_OWNER', 'OPERATIONS', 'SUPPORT', 'FINANCE', 'SECURITY_AUDITOR')
  ),
  CONSTRAINT admin_role_assignments_lifecycle_check CHECK (
    length(btrim(granted_by)) BETWEEN 1 AND 120
    AND granted_by !~ '[[:cntrl:]]'
    AND (revoked_at IS NULL OR revoked_at >= granted_at)
  )
);

CREATE UNIQUE INDEX admin_role_assignments_active_idx
  ON admin_role_assignments(admin_id, role)
  WHERE revoked_at IS NULL;

CREATE INDEX admin_role_assignments_admin_idx
  ON admin_role_assignments(admin_id, granted_at DESC);

CREATE TABLE admin_sessions (
  id UUID PRIMARY KEY,
  admin_id UUID NOT NULL REFERENCES admin_identities(id) ON DELETE RESTRICT,
  session_hash TEXT NOT NULL,
  assurance TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  CONSTRAINT admin_sessions_hash_check CHECK (
    session_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT admin_sessions_assurance_check CHECK (
    assurance IN ('MFA', 'STAGING_SYNTHETIC')
  ),
  CONSTRAINT admin_sessions_lifecycle_check CHECK (
    expires_at > issued_at
    AND (revoked_at IS NULL OR revoked_at >= issued_at)
    AND (last_seen_at IS NULL OR last_seen_at >= issued_at)
  )
);

CREATE UNIQUE INDEX admin_sessions_hash_idx ON admin_sessions(session_hash);
CREATE INDEX admin_sessions_active_admin_idx
  ON admin_sessions(admin_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX keycore_orders_admin_created_idx
  ON keycore_orders(created_at DESC, id DESC);

CREATE INDEX keycore_orders_admin_status_created_idx
  ON keycore_orders(status, created_at DESC, id DESC);

CREATE INDEX keycore_orders_admin_checkout_email_created_idx
  ON keycore_orders(checkout_email_normalized, created_at DESC, id DESC)
  WHERE checkout_email_normalized IS NOT NULL;
