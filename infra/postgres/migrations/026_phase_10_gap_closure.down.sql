DROP TRIGGER IF EXISTS operations_control_events_no_delete ON operations_control_events;

DELETE FROM operations_control_events
WHERE capability IN ('GLOBAL_COMMERCE_MUTATIONS', 'CHECKOUT_CREATE');

DELETE FROM operations_controls
WHERE capability IN ('GLOBAL_COMMERCE_MUTATIONS', 'CHECKOUT_CREATE');

CREATE TRIGGER operations_control_events_no_delete
BEFORE DELETE ON operations_control_events
FOR EACH ROW EXECUTE FUNCTION prevent_operations_control_event_mutation();

ALTER TABLE operations_controls
  DROP CONSTRAINT operations_controls_capability_check;

ALTER TABLE operations_controls
  ADD CONSTRAINT operations_controls_capability_check CHECK (
    capability IN (
      'PROCUREMENT_CREATE',
      'SUPPLIER_KEY_RETRIEVAL',
      'CUSTOMER_KEY_DELIVERY',
      'SUPPLIER_CLAIM_SUBMISSION'
    )
  );
