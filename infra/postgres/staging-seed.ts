import type { TransactionalQueryable } from "./client.js";

export interface StagingSeedResult {
  readonly status: "SEEDED";
  readonly supplierCount: number;
  readonly productCount: number;
  readonly offerCount: number;
  readonly decisionCount: number;
}

export const seedSyntheticStagingData = async (
  database: TransactionalQueryable,
  input: {
    readonly environment: string | undefined;
    readonly deploymentId: string | undefined;
  },
): Promise<StagingSeedResult> => {
  if (
    input.environment !== "STAGING" ||
    !input.deploymentId ||
    !/^staging-[a-z0-9][a-z0-9-]{2,62}$/u.test(input.deploymentId)
  ) {
    throw new Error("STAGING_SEED_ENVIRONMENT_REQUIRED");
  }
  return database.transaction(async (client) => {
    await client.query(stagingSeedSql);
    const result = await client.query<{
      readonly suppliers: string;
      readonly products: string;
      readonly offers: string;
      readonly decisions: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM suppliers WHERE supplier_code = 'STAGING_MOCK') AS suppliers,
        (SELECT count(*)::text FROM products WHERE id::text LIKE '00000000-0000-4000-8000-0000001101%') AS products,
        (SELECT count(*)::text FROM offers WHERE id::text LIKE '00000000-0000-4000-8000-0000001104%') AS offers,
        (SELECT count(*)::text FROM region_decisions WHERE id::text LIKE '00000000-0000-4000-8000-0000001106%') AS decisions
    `);
    const row = result.rows[0];
    if (!row) throw new Error("STAGING_SEED_VERIFICATION_FAILED");
    return {
      decisionCount: Number.parseInt(row.decisions, 10),
      offerCount: Number.parseInt(row.offers, 10),
      productCount: Number.parseInt(row.products, 10),
      status: "SEEDED",
      supplierCount: Number.parseInt(row.suppliers, 10),
    };
  });
};

const stagingSeedSql = `
INSERT INTO suppliers(id, supplier_code, display_name, capabilities)
VALUES ('00000000-0000-4000-8000-000000110001', 'STAGING_MOCK', 'Staging Synthetic Mock', '{"catalog":true,"purchase":false}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO products(id, product_type, title, platform, lifecycle, active, canonical_metadata_confidence, canonical_metadata)
VALUES
  ('00000000-0000-4000-8000-000000110101', 'GAME', 'STAGING SYNTHETIC DE ALLOWED', 'PC', 'ACTIVE', true, 'HIGH', '{"synthetic":true}'::jsonb),
  ('00000000-0000-4000-8000-000000110102', 'GAME', 'STAGING SYNTHETIC GLOBAL ALLOWED', 'PC', 'ACTIVE', true, 'HIGH', '{"synthetic":true}'::jsonb),
  ('00000000-0000-4000-8000-000000110103', 'GAME', 'STAGING SYNTHETIC BLOCKED', 'PC', 'ACTIVE', true, 'HIGH', '{"synthetic":true}'::jsonb),
  ('00000000-0000-4000-8000-000000110104', 'GAME', 'STAGING SYNTHETIC REVIEW', 'PC', 'ACTIVE', true, 'LOW', '{"synthetic":true}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO supplier_products(id, supplier_id, supplier_product_id, title, raw_metadata, product_id, lifecycle, active)
SELECT
  ('00000000-0000-4000-8000-00000011020' || ordinal)::uuid,
  '00000000-0000-4000-8000-000000110001'::uuid,
  'staging-product-' || ordinal,
  title,
  '{"synthetic":true}'::jsonb,
  product_id,
  'ACTIVE',
  true
FROM (VALUES
  ('1', 'STAGING SYNTHETIC DE ALLOWED', '00000000-0000-4000-8000-000000110101'::uuid),
  ('2', 'STAGING SYNTHETIC GLOBAL ALLOWED', '00000000-0000-4000-8000-000000110102'::uuid),
  ('3', 'STAGING SYNTHETIC BLOCKED', '00000000-0000-4000-8000-000000110103'::uuid),
  ('4', 'STAGING SYNTHETIC REVIEW', '00000000-0000-4000-8000-000000110104'::uuid)
) AS fixtures(ordinal, title, product_id)
ON CONFLICT (id) DO NOTHING;

INSERT INTO supplier_offers(id, supplier_id, supplier_product_id, supplier_offer_id, raw_metadata, active)
SELECT
  ('00000000-0000-4000-8000-00000011030' || ordinal)::uuid,
  '00000000-0000-4000-8000-000000110001'::uuid,
  ('00000000-0000-4000-8000-00000011020' || ordinal)::uuid,
  'staging-offer-' || ordinal,
  '{"synthetic":true}'::jsonb,
  true
FROM unnest(ARRAY['1','2','3','4']) AS ordinal
ON CONFLICT (id) DO NOTHING;

INSERT INTO offers(id, product_id, supplier_offer_id, availability)
SELECT
  ('00000000-0000-4000-8000-00000011040' || ordinal)::uuid,
  ('00000000-0000-4000-8000-00000011010' || ordinal)::uuid,
  ('00000000-0000-4000-8000-00000011030' || ordinal)::uuid,
  'IN_STOCK'
FROM unnest(ARRAY['1','2','3','4']) AS ordinal
ON CONFLICT (id) DO NOTHING;

INSERT INTO region_evidence(
  id, offer_id, allowed_countries, excluded_countries, supplier_region_identifier,
  documented_semantics_reference, requires_vpn, requires_foreign_account,
  has_missing_values, has_unknown_values, has_contradictory_evidence,
  source_evidence_version, captured_at
)
VALUES
  ('00000000-0000-4000-8000-000000110501', '00000000-0000-4000-8000-000000110401', ARRAY['DE'], ARRAY[]::text[], 'DE', 'STAGING_SYNTHETIC', false, false, false, false, false, 'staging-v1', statement_timestamp()),
  ('00000000-0000-4000-8000-000000110502', '00000000-0000-4000-8000-000000110402', ARRAY['GLOBAL'], ARRAY[]::text[], 'GLOBAL', 'STAGING_SYNTHETIC', false, false, false, false, false, 'staging-v1', statement_timestamp()),
  ('00000000-0000-4000-8000-000000110503', '00000000-0000-4000-8000-000000110403', ARRAY[]::text[], ARRAY['DE'], 'US', 'STAGING_SYNTHETIC', false, false, false, false, false, 'staging-v1', statement_timestamp()),
  ('00000000-0000-4000-8000-000000110504', '00000000-0000-4000-8000-000000110404', ARRAY[]::text[], ARRAY[]::text[], NULL, 'STAGING_SYNTHETIC', NULL, NULL, true, true, false, 'staging-v1', statement_timestamp())
ON CONFLICT (id) DO NOTHING;

INSERT INTO region_decisions(id, offer_id, region_evidence_id, decision, reason_code, policy_version, source_evidence_version, evaluated_at)
VALUES
  ('00000000-0000-4000-8000-000000110601', '00000000-0000-4000-8000-000000110401', '00000000-0000-4000-8000-000000110501', 'ALLOWED', 'REGION_DE_ALLOWED', 'staging-policy-v1', 'staging-v1', statement_timestamp()),
  ('00000000-0000-4000-8000-000000110602', '00000000-0000-4000-8000-000000110402', '00000000-0000-4000-8000-000000110502', 'ALLOWED', 'REGION_GLOBAL_ALLOWED', 'staging-policy-v1', 'staging-v1', statement_timestamp()),
  ('00000000-0000-4000-8000-000000110603', '00000000-0000-4000-8000-000000110403', '00000000-0000-4000-8000-000000110503', 'BLOCKED', 'REGION_DE_EXCLUDED', 'staging-policy-v1', 'staging-v1', statement_timestamp()),
  ('00000000-0000-4000-8000-000000110604', '00000000-0000-4000-8000-000000110404', '00000000-0000-4000-8000-000000110504', 'REVIEW_REQUIRED', 'REGION_EVIDENCE_MISSING', 'staging-policy-v1', 'staging-v1', statement_timestamp())
ON CONFLICT (id) DO NOTHING;

INSERT INTO price_snapshots(id, offer_id, amount_minor, currency, availability, captured_at)
SELECT
  ('00000000-0000-4000-8000-00000011070' || ordinal)::uuid,
  ('00000000-0000-4000-8000-00000011040' || ordinal)::uuid,
  1000 + ordinal::integer * 100,
  'EUR',
  'IN_STOCK',
  statement_timestamp()
FROM unnest(ARRAY['1','2','3','4']) AS ordinal
ON CONFLICT (id) DO NOTHING;
`;
