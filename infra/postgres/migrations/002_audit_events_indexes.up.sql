CREATE INDEX idx_audit_events_correlation_keyset ON audit_events(correlation_id, timestamp_utc, id);
CREATE INDEX idx_audit_events_entity_keyset ON audit_events((entity->>'type'), (entity->>'id'), timestamp_utc, id);
CREATE INDEX idx_audit_events_event_type_keyset ON audit_events(event_type, timestamp_utc, id);
CREATE INDEX idx_audit_events_actor_keyset ON audit_events((actor->>'type'), (actor->>'id'), timestamp_utc, id);
CREATE INDEX idx_audit_events_timestamp_keyset ON audit_events(timestamp_utc, id);
CREATE INDEX idx_audit_events_outcome_keyset ON audit_events(outcome, timestamp_utc, id);
CREATE INDEX idx_audit_events_reason_code_keyset ON audit_events(reason_code, timestamp_utc, id);
