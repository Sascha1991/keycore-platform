ALTER TABLE operations_controls
  DROP CONSTRAINT operations_controls_capability_check;

ALTER TABLE operations_controls
  ADD CONSTRAINT operations_controls_capability_check CHECK (
    capability IN (
      'GLOBAL_COMMERCE_MUTATIONS',
      'CHECKOUT_CREATE',
      'PROCUREMENT_CREATE',
      'SUPPLIER_KEY_RETRIEVAL',
      'CUSTOMER_KEY_DELIVERY',
      'SUPPLIER_CLAIM_SUBMISSION'
    )
  );

INSERT INTO operations_controls(
  capability, state, reason_code, record_version, created_at, updated_at
)
SELECT capability, 'ENABLED', NULL, 1, statement_timestamp(), statement_timestamp()
FROM unnest(ARRAY[
  'GLOBAL_COMMERCE_MUTATIONS',
  'CHECKOUT_CREATE'
]) AS capability;

INSERT INTO operations_control_events(
  id, capability, event_type, from_state, to_state, reason_code,
  actor_reference, operation_id, correlation_id, occurred_at
)
SELECT
  gen_random_uuid(), capability, 'CONTROL_INITIALIZED', 'ENABLED', 'ENABLED', NULL,
  'MIGRATION_026', 'ks-10-02:init:' || lower(capability),
  'ks-10-02-migration', statement_timestamp()
FROM operations_controls
WHERE capability IN ('GLOBAL_COMMERCE_MUTATIONS', 'CHECKOUT_CREATE');
