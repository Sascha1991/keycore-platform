CREATE TABLE promotion_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL UNIQUE,
  name TEXT NOT NULL,
  internal_description TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'DRAFT',
  discount_type TEXT NOT NULL,
  discount_value BIGINT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  product_scope TEXT NOT NULL DEFAULT 'ALL_ELIGIBLE_PRODUCTS',
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  minimum_subtotal_minor BIGINT,
  usage_limit BIGINT,
  record_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT promotion_campaigns_name_check CHECK (length(trim(name)) BETWEEN 1 AND 120),
  CONSTRAINT promotion_campaigns_description_check CHECK (length(internal_description) <= 500),
  CONSTRAINT promotion_campaigns_code_check CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  CONSTRAINT promotion_campaigns_lifecycle_check CHECK (lifecycle IN ('DRAFT', 'ENABLED', 'DISABLED', 'ARCHIVED')),
  CONSTRAINT promotion_campaigns_discount_type_check CHECK (discount_type IN ('PERCENTAGE', 'FIXED_AMOUNT')),
  CONSTRAINT promotion_campaigns_discount_value_check CHECK (
    (discount_type = 'PERCENTAGE' AND discount_value BETWEEN 1 AND 9999)
    OR (discount_type = 'FIXED_AMOUNT' AND discount_value > 0)
  ),
  CONSTRAINT promotion_campaigns_currency_check CHECK (currency = 'EUR'),
  CONSTRAINT promotion_campaigns_product_scope_check CHECK (product_scope IN ('ALL_ELIGIBLE_PRODUCTS', 'SELECTED_PRODUCTS')),
  CONSTRAINT promotion_campaigns_schedule_check CHECK (ends_at IS NULL OR starts_at IS NULL OR starts_at < ends_at),
  CONSTRAINT promotion_campaigns_minimum_check CHECK (minimum_subtotal_minor IS NULL OR minimum_subtotal_minor > 0),
  CONSTRAINT promotion_campaigns_usage_limit_check CHECK (usage_limit IS NULL OR usage_limit > 0),
  CONSTRAINT promotion_campaigns_version_check CHECK (record_version > 0)
);

CREATE UNIQUE INDEX promotion_campaigns_code_unique ON promotion_campaigns(upper(code));
CREATE INDEX promotion_campaigns_overview_idx ON promotion_campaigns(lifecycle, starts_at, ends_at, updated_at DESC, id);

CREATE TABLE promotion_campaign_products (
  campaign_id UUID NOT NULL REFERENCES promotion_campaigns(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  PRIMARY KEY (campaign_id, product_id)
);

CREATE TABLE promotion_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES promotion_campaigns(id) ON DELETE RESTRICT,
  checkout_token CHAR(64) NOT NULL UNIQUE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  order_id UUID UNIQUE REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  code_snapshot TEXT NOT NULL,
  campaign_name_snapshot TEXT NOT NULL,
  discount_type_snapshot TEXT NOT NULL,
  discount_value_snapshot BIGINT NOT NULL,
  base_amount_minor BIGINT NOT NULL,
  discount_amount_minor BIGINT NOT NULL,
  final_amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  CONSTRAINT promotion_redemptions_state_check CHECK (state IN ('RESERVED', 'CONSUMED', 'RELEASED')),
  CONSTRAINT promotion_redemptions_code_check CHECK (code_snapshot ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
  CONSTRAINT promotion_redemptions_type_check CHECK (discount_type_snapshot IN ('PERCENTAGE', 'FIXED_AMOUNT')),
  CONSTRAINT promotion_redemptions_currency_check CHECK (currency = 'EUR'),
  CONSTRAINT promotion_redemptions_amount_check CHECK (
    base_amount_minor > 0 AND discount_amount_minor > 0
    AND final_amount_minor > 0
    AND final_amount_minor = base_amount_minor - discount_amount_minor
  ),
  CONSTRAINT promotion_redemptions_terminal_check CHECK (
    (state = 'CONSUMED' AND order_id IS NOT NULL AND consumed_at IS NOT NULL AND released_at IS NULL)
    OR (state = 'RELEASED' AND order_id IS NULL AND consumed_at IS NULL AND released_at IS NOT NULL)
    OR (state = 'RESERVED' AND order_id IS NULL AND consumed_at IS NULL AND released_at IS NULL)
  )
);

CREATE INDEX promotion_redemptions_campaign_state_idx
  ON promotion_redemptions(campaign_id, state, expires_at, created_at);

CREATE FUNCTION protect_consumed_promotion_redemption() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'CONSUMED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'consumed promotion evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER promotion_redemptions_consumed_immutable
BEFORE UPDATE OR DELETE ON promotion_redemptions
FOR EACH ROW EXECUTE FUNCTION protect_consumed_promotion_redemption();

ALTER TABLE admin_permission_grants
  DROP CONSTRAINT admin_permission_grants_capability_check,
  ADD CONSTRAINT admin_permission_grants_capability_check CHECK (
    capability IN (
      'ADMIN_ACCESS', 'ORDER_VIEW', 'SENSITIVE_OPERATION', 'PRODUCT_KEY_REVEAL',
      'AUDIT_VIEW', 'STAFF_VIEW', 'STAFF_MANAGE', 'ROLE_ASSIGN',
      'PERMISSION_OVERRIDE_MANAGE', 'CUSTOMER_VIEW', 'CATALOG_VIEW',
      'SUPPLIER_VIEW', 'SUPPLIER_MANAGE', 'PROMOTION_VIEW', 'PROMOTION_MANAGE',
      'SUPPORT_VIEW', 'SUPPORT_MANAGE', 'FINANCE_VIEW', 'REPORT_VIEW',
      'FRAUD_REVIEW_VIEW', 'FRAUD_REVIEW_MANAGE', 'REFUND_MANAGE',
      'OPERATIONS_CONTROL_VIEW', 'OPERATIONS_CONTROL_MANAGE'
    )
  );
