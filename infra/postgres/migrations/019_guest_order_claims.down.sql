DROP INDEX IF EXISTS guest_order_claim_expires_at_idx;
DROP INDEX IF EXISTS guest_order_claim_order_active_idx;
DROP INDEX IF EXISTS guest_order_claim_token_hash_idx;
DROP TABLE IF EXISTS guest_order_claim_challenges;

DROP INDEX IF EXISTS keycore_orders_guest_checkout_email_idx;
DROP TRIGGER IF EXISTS keycore_orders_checkout_email_immutable ON keycore_orders;
DROP FUNCTION IF EXISTS prevent_keycore_order_checkout_email_update();
ALTER TABLE keycore_orders
  DROP CONSTRAINT IF EXISTS keycore_orders_checkout_email_snapshot_check;
ALTER TABLE keycore_orders
  DROP COLUMN IF EXISTS checkout_email_normalized;
