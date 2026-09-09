ALTER TABLE admin_permission_grants
  DROP CONSTRAINT admin_permission_grants_capability_check,
  ADD CONSTRAINT admin_permission_grants_capability_check CHECK (
    capability IN (
      'ADMIN_ACCESS',
      'ORDER_VIEW',
      'SENSITIVE_OPERATION',
      'PRODUCT_KEY_REVEAL',
      'AUDIT_VIEW',
      'STAFF_VIEW',
      'STAFF_MANAGE',
      'ROLE_ASSIGN',
      'PERMISSION_OVERRIDE_MANAGE',
      'CUSTOMER_VIEW',
      'CATALOG_VIEW',
      'SUPPLIER_VIEW',
      'SUPPORT_VIEW',
      'SUPPORT_MANAGE',
      'FINANCE_VIEW',
      'REPORT_VIEW',
      'FRAUD_REVIEW_VIEW',
      'FRAUD_REVIEW_MANAGE',
      'REFUND_MANAGE',
      'OPERATIONS_CONTROL_VIEW',
      'OPERATIONS_CONTROL_MANAGE'
    )
  );
