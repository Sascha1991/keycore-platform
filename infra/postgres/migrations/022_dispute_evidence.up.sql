CREATE TABLE dispute_evidence_snapshots (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  fact_fingerprint TEXT NOT NULL,
  sections JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  finalized_at TIMESTAMPTZ,
  CONSTRAINT dispute_evidence_snapshots_state_check CHECK (
    state IN ('DRAFT', 'FINALIZED', 'INVALIDATED')
  ),
  CONSTRAINT dispute_evidence_snapshots_version_check CHECK (
    version > 0
    AND schema_version = 'KS_DISPUTE_EVIDENCE_V1'
    AND policy_version = 'KS_DISPUTE_EVIDENCE_V1'
    AND fact_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT dispute_evidence_snapshots_sections_check CHECK (
    jsonb_typeof(sections) = 'array'
    AND jsonb_array_length(sections) > 0
  ),
  CONSTRAINT dispute_evidence_snapshots_finalized_check CHECK (
    (state = 'FINALIZED' AND finalized_at IS NOT NULL)
    OR (state <> 'FINALIZED' AND finalized_at IS NULL)
  )
);

CREATE UNIQUE INDEX dispute_evidence_snapshot_version_idx
  ON dispute_evidence_snapshots(order_id, schema_version, version);

CREATE UNIQUE INDEX dispute_evidence_snapshot_fingerprint_idx
  ON dispute_evidence_snapshots(order_id, schema_version, fact_fingerprint);

CREATE INDEX dispute_evidence_snapshot_order_created_idx
  ON dispute_evidence_snapshots(order_id, created_at DESC, id DESC);

CREATE FUNCTION prevent_finalized_dispute_evidence_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state = 'FINALIZED' THEN
    RAISE EXCEPTION 'Finalized dispute evidence snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dispute_evidence_finalized_immutable
BEFORE UPDATE ON dispute_evidence_snapshots
FOR EACH ROW
EXECUTE FUNCTION prevent_finalized_dispute_evidence_update();
