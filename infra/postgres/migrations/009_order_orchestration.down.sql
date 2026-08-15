DROP TRIGGER IF EXISTS keycore_orders_commercial_immutable ON keycore_orders;

DROP FUNCTION IF EXISTS prevent_keycore_order_commercial_update();

DROP TABLE IF EXISTS external_event_receipts;

DROP TABLE IF EXISTS order_transition_history;

DROP TABLE IF EXISTS keycore_orders;
