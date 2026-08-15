CREATE TABLE pricing_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_version TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL,
  currency CHAR(3) NOT NULL,
  markup_basis_points BIGINT NOT NULL,
  target_margin_basis_points BIGINT,
  fixed_markup_minor BIGINT NOT NULL,
  minimum_profit_minor BIGINT NOT NULL,
  minimum_sell_price_minor BIGINT NOT NULL,
  rounding JSONB NOT NULL,
  quote_ttl_ms INTEGER,
  actor_ref TEXT,
  reason TEXT,
  effective_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pricing_policies_version_check CHECK (policy_version = 'pricing-policy-v1'),
  CONSTRAINT pricing_policies_money_check CHECK (
    record_version > 0
    AND markup_basis_points >= 0
    AND (target_margin_basis_points IS NULL OR (target_margin_basis_points > 0 AND target_margin_basis_points < 10000))
    AND fixed_markup_minor >= 0
    AND minimum_profit_minor >= 0
    AND minimum_sell_price_minor >= 0
    AND (quote_ttl_ms IS NULL OR quote_ttl_ms > 0)
  )
);

CREATE UNIQUE INDEX pricing_policies_single_active_idx
  ON pricing_policies(active)
  WHERE active = true;

CREATE TABLE product_pricing_overrides (
  product_id UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  record_version INTEGER NOT NULL,
  enabled BOOLEAN NOT NULL,
  markup_basis_points BIGINT,
  target_margin_basis_points BIGINT,
  fixed_markup_minor BIGINT,
  fixed_markup_currency CHAR(3),
  minimum_profit_minor BIGINT,
  minimum_profit_currency CHAR(3),
  minimum_sell_price_minor BIGINT,
  minimum_sell_price_currency CHAR(3),
  rounding JSONB,
  quote_ttl_ms INTEGER,
  manual_sell_price_minor BIGINT,
  manual_sell_price_currency CHAR(3),
  manual_price_version INTEGER,
  actor_ref TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_pricing_overrides_money_check CHECK (
    record_version > 0
    AND (markup_basis_points IS NULL OR markup_basis_points >= 0)
    AND (target_margin_basis_points IS NULL OR (target_margin_basis_points > 0 AND target_margin_basis_points < 10000))
    AND (fixed_markup_minor IS NULL OR fixed_markup_minor >= 0)
    AND ((fixed_markup_minor IS NULL AND fixed_markup_currency IS NULL) OR (fixed_markup_minor IS NOT NULL AND fixed_markup_currency IS NOT NULL))
    AND (minimum_profit_minor IS NULL OR minimum_profit_minor >= 0)
    AND ((minimum_profit_minor IS NULL AND minimum_profit_currency IS NULL) OR (minimum_profit_minor IS NOT NULL AND minimum_profit_currency IS NOT NULL))
    AND (minimum_sell_price_minor IS NULL OR minimum_sell_price_minor >= 0)
    AND ((minimum_sell_price_minor IS NULL AND minimum_sell_price_currency IS NULL) OR (minimum_sell_price_minor IS NOT NULL AND minimum_sell_price_currency IS NOT NULL))
    AND (quote_ttl_ms IS NULL OR quote_ttl_ms > 0)
    AND (
      (manual_sell_price_minor IS NULL AND manual_sell_price_currency IS NULL)
      OR (manual_sell_price_minor > 0 AND manual_sell_price_currency IS NOT NULL)
    )
    AND (manual_price_version IS NULL OR manual_price_version > 0)
    AND (manual_sell_price_minor IS NOT NULL OR manual_price_version IS NULL)
  )
);

CREATE TABLE product_price_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  currency CHAR(3) NOT NULL,
  sell_price_minor BIGINT NOT NULL,
  pricing_policy_version TEXT NOT NULL,
  pricing_policy_record_version INTEGER NOT NULL,
  product_override_version INTEGER,
  manual_price_version INTEGER,
  source_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  reason_code TEXT,
  calculated_at TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_price_snapshots_status_check CHECK (status IN ('QUOTED', 'BLOCKED', 'REVIEW_REQUIRED')),
  CONSTRAINT product_price_snapshots_money_check CHECK (
    sell_price_minor >= 0
    AND pricing_policy_record_version > 0
    AND (product_override_version IS NULL OR product_override_version > 0)
    AND (manual_price_version IS NULL OR manual_price_version > 0)
  )
);

CREATE UNIQUE INDEX product_price_snapshots_fingerprint_idx
  ON product_price_snapshots(product_id, offer_id, source_fingerprint);

CREATE INDEX product_price_snapshots_product_calculated_idx
  ON product_price_snapshots(product_id, calculated_at DESC);
