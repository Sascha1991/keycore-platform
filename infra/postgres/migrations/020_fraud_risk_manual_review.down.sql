DROP INDEX IF EXISTS fraud_manual_review_cases_order_idx;
DROP INDEX IF EXISTS fraud_manual_review_cases_one_open_fraud_case_idx;
DROP TABLE IF EXISTS fraud_manual_review_cases;
DROP INDEX IF EXISTS fraud_risk_evaluations_order_current_idx;
DROP INDEX IF EXISTS fraud_risk_evaluations_idempotency_idx;
DROP TABLE IF EXISTS fraud_risk_evaluations;
