ALTER TABLE controlled_procurement_approvals
  ADD COLUMN supplier_http_status INTEGER,
  ADD COLUMN supplier_error_code TEXT,
  ADD COLUMN supplier_error_category TEXT,
  ADD COLUMN safe_rejection_reason_code TEXT;

ALTER TABLE controlled_procurement_approvals
  ADD CONSTRAINT controlled_procurement_supplier_http_status_check CHECK (
    supplier_http_status IS NULL
    OR supplier_http_status BETWEEN 100 AND 599
  ),
  ADD CONSTRAINT controlled_procurement_supplier_error_code_check CHECK (
    supplier_error_code IS NULL
    OR (
      length(supplier_error_code) BETWEEN 1 AND 80
      AND supplier_error_code ~ '^[A-Za-z0-9_.:-]+$'
      AND supplier_error_code !~* '(product.?key|serial|plaintext|token|api.?key|secret)'
    )
  ),
  ADD CONSTRAINT controlled_procurement_supplier_error_category_check CHECK (
    supplier_error_category IS NULL
    OR supplier_error_category IN (
      'AUTHENTICATION',
      'AUTHORIZATION',
      'VALIDATION',
      'INSUFFICIENT_BALANCE',
      'PRODUCT_UNAVAILABLE',
      'OFFER_UNAVAILABLE',
      'PRICE_MISMATCH',
      'DUPLICATE_REFERENCE',
      'RATE_LIMIT',
      'SUPPLIER_REJECTION',
      'UNKNOWN'
    )
  ),
  ADD CONSTRAINT controlled_procurement_safe_rejection_reason_code_check CHECK (
    safe_rejection_reason_code IS NULL
    OR (
      length(safe_rejection_reason_code) BETWEEN 1 AND 120
      AND safe_rejection_reason_code ~ '^[A-Z0-9_]+$'
      AND safe_rejection_reason_code !~* '(PRODUCT.?KEY|SERIAL|PLAINTEXT|TOKEN|API.?KEY|SECRET)'
    )
  );
