DROP TRIGGER IF EXISTS keycore_customers_verification_no_regression ON keycore_customers;
DROP FUNCTION IF EXISTS prevent_customer_verification_regression();

DROP TRIGGER IF EXISTS keycore_orders_customer_ownership_immutable ON keycore_orders;
DROP FUNCTION IF EXISTS prevent_keycore_order_customer_reassignment();

DROP INDEX IF EXISTS fulfillment_operations_order_idx;
ALTER TABLE fulfillment_operations
  DROP CONSTRAINT IF EXISTS fulfillment_operations_order_fk;

DROP INDEX IF EXISTS keycore_orders_customer_idx;
ALTER TABLE keycore_orders
  DROP COLUMN IF EXISTS customer_id;

DROP INDEX IF EXISTS customer_identity_bindings_customer_idx;
DROP INDEX IF EXISTS customer_identity_bindings_provider_subject_idx;
DROP TABLE IF EXISTS customer_identity_bindings;

DROP INDEX IF EXISTS keycore_customers_verification_idx;
DROP INDEX IF EXISTS keycore_customers_email_normalized_idx;
DROP TABLE IF EXISTS keycore_customers;
