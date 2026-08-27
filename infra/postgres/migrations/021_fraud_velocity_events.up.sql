CREATE TABLE fraud_velocity_events (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  order_id UUID NOT NULL REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  subject_type TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT fraud_velocity_events_event_type_check CHECK (
    event_type IN ('PAYMENT_CONFIRMED')
  ),
  CONSTRAINT fraud_velocity_events_subject_type_check CHECK (
    subject_type IN ('CUSTOMER', 'CHECKOUT_EMAIL')
  ),
  CONSTRAINT fraud_velocity_events_subject_key_check CHECK (
    length(trim(subject_key)) BETWEEN 1 AND 128
    AND subject_key ~ '^[A-Za-z0-9:_-]+$'
  ),
  CONSTRAINT fraud_velocity_events_money_check CHECK (
    amount_minor >= 0
    AND currency ~ '^[A-Z]{3}$'
  )
);

CREATE UNIQUE INDEX fraud_velocity_events_idempotency_idx
  ON fraud_velocity_events(event_type, order_id, subject_type);

CREATE INDEX fraud_velocity_events_window_idx
  ON fraud_velocity_events(subject_type, subject_key, event_type, currency, occurred_at);

CREATE INDEX fraud_velocity_events_order_idx
  ON fraud_velocity_events(order_id, occurred_at);
