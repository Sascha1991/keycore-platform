DROP TRIGGER IF EXISTS order_payments_identity_commercial_immutable
  ON order_payments;

DROP FUNCTION IF EXISTS prevent_order_payment_commercial_update();

DROP TABLE IF EXISTS order_payments;
