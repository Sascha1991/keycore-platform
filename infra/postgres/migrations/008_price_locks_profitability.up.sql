CREATE TABLE price_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  currency CHAR(3) NOT NULL,
  locked_sell_price_minor BIGINT NOT NULL,
  pricing_quote_fingerprint TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  pricing_policy_version TEXT NOT NULL,
  pricing_policy_record_version INTEGER NOT NULL,
  product_override_version INTEGER,
  manual_price_version INTEGER,
  tax_policy_version TEXT NOT NULL,
  fee_policy_version TEXT NOT NULL,
  fx_rate_version TEXT,
  status TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  idempotency_key TEXT,
  idempotency_fingerprint TEXT,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  reason_code TEXT,
  CONSTRAINT price_locks_status_check CHECK (
    status IN (
      'ACTIVE',
      'CONSUMED',
      'EXPIRED',
      'INVALIDATED',
      'REPRICE_REQUIRED',
      'BLOCKED'
    )
  ),
  CONSTRAINT price_locks_money_version_check CHECK (
    locked_sell_price_minor > 0
    AND record_version > 0
    AND pricing_policy_record_version > 0
    AND (product_override_version IS NULL OR product_override_version > 0)
    AND (manual_price_version IS NULL OR manual_price_version > 0)
    AND expires_at > created_at
    AND (
      (
        idempotency_key IS NULL
        AND idempotency_fingerprint IS NULL
      )
      OR (
        idempotency_key IS NOT NULL
        AND idempotency_fingerprint IS NOT NULL
      )
    )
  )
);

CREATE UNIQUE INDEX price_locks_idempotency_key_idx
  ON price_locks(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX price_locks_product_status_expiry_idx
  ON price_locks(product_id, status, expires_at);
