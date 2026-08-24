ALTER TABLE controlled_procurement_approvals
  DROP CONSTRAINT IF EXISTS controlled_procurement_safe_rejection_reason_code_check,
  DROP CONSTRAINT IF EXISTS controlled_procurement_supplier_error_category_check,
  DROP CONSTRAINT IF EXISTS controlled_procurement_supplier_error_code_check,
  DROP CONSTRAINT IF EXISTS controlled_procurement_supplier_http_status_check,
  DROP COLUMN IF EXISTS safe_rejection_reason_code,
  DROP COLUMN IF EXISTS supplier_error_category,
  DROP COLUMN IF EXISTS supplier_error_code,
  DROP COLUMN IF EXISTS supplier_http_status;
