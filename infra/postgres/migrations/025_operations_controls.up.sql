CREATE TABLE operations_controls (
  capability TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  reason_code TEXT,
  record_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT operations_controls_capability_check CHECK (
    capability IN (
      'PROCUREMENT_CREATE',
      'SUPPLIER_KEY_RETRIEVAL',
      'CUSTOMER_KEY_DELIVERY',
      'SUPPLIER_CLAIM_SUBMISSION'
    )
  ),
  CONSTRAINT operations_controls_state_check CHECK (state IN ('ENABLED', 'PAUSED')),
  CONSTRAINT operations_controls_reason_check CHECK (
    (
      state = 'ENABLED'
      AND reason_code IS NULL
    )
    OR (
      state = 'PAUSED'
      AND reason_code IN (
        'MAINTENANCE',
        'INCIDENT_RESPONSE',
        'SUPPLIER_INCIDENT',
        'SECURITY_INCIDENT',
        'MANUAL_OPERATIONS_PAUSE'
      )
    )
  ),
  CONSTRAINT operations_controls_version_time_check CHECK (
    record_version > 0
    AND created_at <= updated_at
  )
);

CREATE TABLE operations_control_events (
  id UUID PRIMARY KEY,
  capability TEXT NOT NULL REFERENCES operations_controls(capability) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason_code TEXT,
  actor_reference TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  correlation_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT operations_control_events_type_check CHECK (
    event_type IN ('CONTROL_INITIALIZED', 'CONTROL_PAUSED', 'CONTROL_RESUMED')
  ),
  CONSTRAINT operations_control_events_state_check CHECK (
    from_state IN ('ENABLED', 'PAUSED')
    AND to_state IN ('ENABLED', 'PAUSED')
    AND (
      (event_type = 'CONTROL_INITIALIZED' AND from_state = 'ENABLED' AND to_state = 'ENABLED')
      OR (event_type = 'CONTROL_PAUSED' AND from_state = 'ENABLED' AND to_state = 'PAUSED')
      OR (event_type = 'CONTROL_RESUMED' AND from_state = 'PAUSED' AND to_state = 'ENABLED')
    )
  ),
  CONSTRAINT operations_control_events_reason_check CHECK (
    (
      to_state = 'ENABLED'
      AND reason_code IS NULL
    )
    OR (
      to_state = 'PAUSED'
      AND reason_code IN (
        'MAINTENANCE',
        'INCIDENT_RESPONSE',
        'SUPPLIER_INCIDENT',
        'SECURITY_INCIDENT',
        'MANUAL_OPERATIONS_PAUSE'
      )
    )
  ),
  CONSTRAINT operations_control_events_safe_reference_check CHECK (
    length(actor_reference) BETWEEN 1 AND 128
    AND actor_reference = trim(actor_reference)
    AND actor_reference !~ '[[:cntrl:]]'
    AND length(operation_id) BETWEEN 1 AND 128
    AND operation_id = trim(operation_id)
    AND operation_id !~ '[[:cntrl:]]'
    AND length(correlation_id) BETWEEN 1 AND 128
    AND correlation_id = trim(correlation_id)
    AND correlation_id !~ '[[:cntrl:]]'
  )
);

CREATE INDEX operations_control_events_capability_idx
  ON operations_control_events(capability, occurred_at, id);

INSERT INTO operations_controls(
  capability, state, reason_code, record_version, created_at, updated_at
)
SELECT capability, 'ENABLED', NULL, 1, statement_timestamp(), statement_timestamp()
FROM unnest(ARRAY[
  'PROCUREMENT_CREATE',
  'SUPPLIER_KEY_RETRIEVAL',
  'CUSTOMER_KEY_DELIVERY',
  'SUPPLIER_CLAIM_SUBMISSION'
]) AS capability;

INSERT INTO operations_control_events(
  id, capability, event_type, from_state, to_state, reason_code,
  actor_reference, operation_id, correlation_id, occurred_at
)
SELECT
  gen_random_uuid(), capability, 'CONTROL_INITIALIZED', 'ENABLED', 'ENABLED', NULL,
  'MIGRATION_025', 'ks-10-01:init:' || lower(capability),
  'ks-10-01-migration', statement_timestamp()
FROM operations_controls;

CREATE FUNCTION prevent_operations_control_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Operations control history is append-only';
END;
$$;

CREATE TRIGGER operations_control_events_no_update
BEFORE UPDATE ON operations_control_events
FOR EACH ROW EXECUTE FUNCTION prevent_operations_control_event_mutation();

CREATE TRIGGER operations_control_events_no_delete
BEFORE DELETE ON operations_control_events
FOR EACH ROW EXECUTE FUNCTION prevent_operations_control_event_mutation();

CREATE FUNCTION prevent_operations_control_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.capability <> OLD.capability OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Operations control identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER operations_controls_identity_immutable
BEFORE UPDATE ON operations_controls
FOR EACH ROW EXECUTE FUNCTION prevent_operations_control_identity_change();

CREATE TABLE dead_letter_items (
  id UUID PRIMARY KEY,
  work_type TEXT NOT NULL,
  safe_reference_id TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  reason_code TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  state TEXT NOT NULL,
  first_failed_at TIMESTAMPTZ NOT NULL,
  last_failed_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  record_version INTEGER NOT NULL,
  CONSTRAINT dead_letter_work_type_check CHECK (
    work_type IN ('OUTBOX_DISPATCH', 'RECONCILIATION', 'NOTIFICATION', 'CATALOG_SYNC')
  ),
  CONSTRAINT dead_letter_state_check CHECK (state IN ('OPEN', 'REPLAYING', 'RESOLVED')),
  CONSTRAINT dead_letter_tuple_check CHECK (
    attempt_count > 0
    AND record_version > 0
    AND first_failed_at <= last_failed_at
    AND ((state = 'RESOLVED' AND resolved_at IS NOT NULL) OR (state <> 'RESOLVED' AND resolved_at IS NULL))
  ),
  CONSTRAINT dead_letter_safe_metadata_check CHECK (
    safe_reference_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
    AND correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  CONSTRAINT dead_letter_identity_unique UNIQUE (work_type, safe_reference_id)
);

CREATE INDEX dead_letter_state_idx ON dead_letter_items(state, last_failed_at, id);
