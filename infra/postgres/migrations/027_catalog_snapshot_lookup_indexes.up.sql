CREATE UNIQUE INDEX region_evidence_offer_version_captured_idx
ON region_evidence(offer_id, source_evidence_version, captured_at)
INCLUDE (id);

CREATE UNIQUE INDEX region_decisions_snapshot_identity_idx
ON region_decisions(
  offer_id,
  region_evidence_id,
  decision,
  reason_code,
  policy_version
);
