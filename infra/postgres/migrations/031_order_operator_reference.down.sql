ALTER SEQUENCE keycore_order_operator_reference_seq OWNED BY NONE;

ALTER TABLE keycore_orders
  DROP COLUMN operator_reference;

DROP SEQUENCE keycore_order_operator_reference_seq;
