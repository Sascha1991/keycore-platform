ALTER TABLE admin_identities
  ADD COLUMN first_name TEXT,
  ADD COLUMN last_name TEXT,
  ADD COLUMN employee_number TEXT,
  ADD COLUMN email_normalized TEXT,
  ADD CONSTRAINT admin_identities_staff_profile_check CHECK (
    (first_name IS NULL AND last_name IS NULL AND employee_number IS NULL)
    OR (
      first_name = btrim(first_name)
      AND last_name = btrim(last_name)
      AND employee_number = btrim(employee_number)
      AND length(first_name) BETWEEN 1 AND 80
      AND length(last_name) BETWEEN 1 AND 80
      AND length(employee_number) BETWEEN 1 AND 64
      AND first_name !~ '[[:cntrl:]]'
      AND last_name !~ '[[:cntrl:]]'
      AND employee_number ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    )
  ),
  ADD CONSTRAINT admin_identities_email_check CHECK (
    email_normalized IS NULL
    OR (
      email_normalized = lower(btrim(email_normalized))
      AND length(email_normalized) BETWEEN 3 AND 254
      AND email_normalized ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  );

CREATE UNIQUE INDEX admin_identities_employee_number_idx
  ON admin_identities(employee_number)
  WHERE employee_number IS NOT NULL;

CREATE UNIQUE INDEX admin_identities_email_idx
  ON admin_identities(email_normalized)
  WHERE email_normalized IS NOT NULL;

CREATE UNIQUE INDEX admin_role_assignments_one_active_idx
  ON admin_role_assignments(admin_id)
  WHERE revoked_at IS NULL;

CREATE TABLE admin_permission_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES admin_identities(id) ON DELETE RESTRICT,
  capability TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL,
  granted_by_admin_id UUID NOT NULL REFERENCES admin_identities(id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  revoked_by_admin_id UUID REFERENCES admin_identities(id) ON DELETE RESTRICT,
  reason TEXT,
  CONSTRAINT admin_permission_grants_capability_check CHECK (
    capability IN (
      'ADMIN_ACCESS',
      'ORDER_VIEW',
      'SENSITIVE_OPERATION',
      'PRODUCT_KEY_REVEAL',
      'AUDIT_VIEW',
      'STAFF_VIEW',
      'STAFF_MANAGE',
      'ROLE_ASSIGN',
      'PERMISSION_OVERRIDE_MANAGE'
    )
  ),
  CONSTRAINT admin_permission_grants_lifecycle_check CHECK (
    (revoked_at IS NULL AND revoked_by_admin_id IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_admin_id IS NOT NULL AND revoked_at >= granted_at)
  ),
  CONSTRAINT admin_permission_grants_reason_check CHECK (
    reason IS NULL
    OR (
      reason = btrim(reason)
      AND length(reason) BETWEEN 1 AND 240
      AND reason !~ '[[:cntrl:]]'
    )
  )
);

CREATE UNIQUE INDEX admin_permission_grants_active_idx
  ON admin_permission_grants(admin_id, capability)
  WHERE revoked_at IS NULL;

CREATE INDEX admin_permission_grants_admin_history_idx
  ON admin_permission_grants(admin_id, granted_at DESC, id DESC);

CREATE INDEX audit_events_admin_staff_idx
  ON audit_events((entity->>'type'), timestamp_utc DESC, id DESC)
  WHERE entity->>'type' IN ('ADMIN_IDENTITY', 'ADMIN_PORTAL');
