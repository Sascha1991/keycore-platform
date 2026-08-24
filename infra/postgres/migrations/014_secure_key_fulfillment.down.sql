DROP INDEX IF EXISTS fulfillment_operations_supplier_order_idx;
DROP INDEX IF EXISTS fulfillment_operations_status_idx;
DROP INDEX IF EXISTS fulfillment_operations_order_procurement_idx;
DROP INDEX IF EXISTS fulfillment_operations_controlled_approval_idx;

ALTER TABLE fulfillment_operations
  DROP CONSTRAINT IF EXISTS fulfillment_operations_secret_fk;

DROP TABLE IF EXISTS fulfillment_secrets;
DROP TABLE IF EXISTS fulfillment_operations;
