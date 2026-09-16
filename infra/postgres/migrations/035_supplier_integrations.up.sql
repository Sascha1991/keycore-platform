CREATE TABLE supplier_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  adapter_type TEXT NOT NULL,
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'CONFIGURED',
  operation_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  record_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT supplier_integrations_supplier_unique UNIQUE (supplier_id),
  CONSTRAINT supplier_integrations_adapter_check CHECK (adapter_type IN ('SYNTHETIC')),
  CONSTRAINT supplier_integrations_status_check CHECK (status IN ('CONFIGURED')),
  CONSTRAINT supplier_integrations_configuration_object_check CHECK (jsonb_typeof(configuration) = 'object'),
  CONSTRAINT supplier_integrations_capabilities_object_check CHECK (jsonb_typeof(capabilities) = 'object'),
  CONSTRAINT supplier_integrations_record_version_check CHECK (record_version > 0)
);

INSERT INTO supplier_integrations(
  supplier_id, adapter_type, configuration, capabilities, status, operation_id,
  record_version, created_at, updated_at
)
SELECT
  supplier.id, 'SYNTHETIC', '{}'::jsonb, supplier.capabilities, 'CONFIGURED',
  gen_random_uuid(), 1, supplier.created_at, supplier.updated_at
FROM suppliers supplier
WHERE supplier.supplier_code = 'STAGING_MOCK'
   OR supplier.supplier_code LIKE 'synthetic-admin-%'
ON CONFLICT (supplier_id) DO NOTHING;

CREATE INDEX supplier_integrations_adapter_idx
  ON supplier_integrations(adapter_type, supplier_id);
