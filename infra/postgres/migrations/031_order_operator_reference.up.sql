CREATE SEQUENCE keycore_order_operator_reference_seq
  AS BIGINT
  MINVALUE 1
  MAXVALUE 268435455
  NO CYCLE;

ALTER TABLE keycore_orders
  ADD COLUMN operator_reference TEXT;

UPDATE keycore_orders
SET operator_reference = 'KR' || upper(lpad(to_hex(nextval('keycore_order_operator_reference_seq')), 7, '0'));

ALTER TABLE keycore_orders
  ALTER COLUMN operator_reference SET DEFAULT (
    'KR' || upper(lpad(to_hex(nextval('keycore_order_operator_reference_seq')), 7, '0'))
  ),
  ALTER COLUMN operator_reference SET NOT NULL,
  ADD CONSTRAINT keycore_orders_operator_reference_format_check CHECK (
    operator_reference ~ '^KR[0-9A-F]{7}$'
  ),
  ADD CONSTRAINT keycore_orders_operator_reference_unique UNIQUE (operator_reference);

ALTER SEQUENCE keycore_order_operator_reference_seq
  OWNED BY keycore_orders.operator_reference;
