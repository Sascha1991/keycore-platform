CREATE TABLE fraud_risk_evaluations (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL,
  risk_score INTEGER NOT NULL,
  reason_codes TEXT[] NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  policy_version TEXT NOT NULL,
  fact_fingerprint TEXT NOT NULL,
  CONSTRAINT fraud_risk_evaluations_decision_check CHECK (
    decision IN ('ALLOW', 'REVIEW', 'DENY')
  ),
  CONSTRAINT fraud_risk_evaluations_score_check CHECK (
    risk_score >= 0 AND risk_score <= 100
  ),
  CONSTRAINT fraud_risk_evaluations_reason_codes_check CHECK (
    array_length(reason_codes, 1) IS NOT NULL
    AND cardinality(reason_codes) <= 20
  ),
  CONSTRAINT fraud_risk_evaluations_policy_check CHECK (
    policy_version ~ '^[A-Z0-9_]{1,64}$'
  ),
  CONSTRAINT fraud_risk_evaluations_fingerprint_check CHECK (
    fact_fingerprint ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX fraud_risk_evaluations_idempotency_idx
  ON fraud_risk_evaluations(order_id, policy_version, fact_fingerprint);

CREATE INDEX fraud_risk_evaluations_order_current_idx
  ON fraud_risk_evaluations(order_id, evaluated_at DESC, id DESC);

CREATE TABLE fraud_manual_review_cases (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  evaluation_id UUID NOT NULL REFERENCES fraud_risk_evaluations(id) ON DELETE RESTRICT,
  fact_fingerprint TEXT NOT NULL,
  reason_codes TEXT[] NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  operator_reference TEXT,
  CONSTRAINT fraud_manual_review_cases_source_check CHECK (
    source IN ('FRAUD')
  ),
  CONSTRAINT fraud_manual_review_cases_status_check CHECK (
    status IN ('OPEN', 'APPROVED', 'REJECTED', 'CANCELLED')
  ),
  CONSTRAINT fraud_manual_review_cases_resolution_check CHECK (
    (
      status = 'OPEN'
      AND resolved_at IS NULL
      AND resolution IS NULL
      AND operator_reference IS NULL
    )
    OR (
      status IN ('APPROVED', 'REJECTED', 'CANCELLED')
      AND resolved_at IS NOT NULL
      AND resolution = status
      AND operator_reference IS NOT NULL
      AND length(trim(operator_reference)) BETWEEN 1 AND 128
      AND operator_reference !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT fraud_manual_review_cases_reason_codes_check CHECK (
    array_length(reason_codes, 1) IS NOT NULL
    AND cardinality(reason_codes) <= 20
  ),
  CONSTRAINT fraud_manual_review_cases_fingerprint_check CHECK (
    fact_fingerprint ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX fraud_manual_review_cases_one_open_fraud_case_idx
  ON fraud_manual_review_cases(order_id, source)
  WHERE status = 'OPEN';

CREATE INDEX fraud_manual_review_cases_order_idx
  ON fraud_manual_review_cases(order_id, opened_at DESC, id DESC);
