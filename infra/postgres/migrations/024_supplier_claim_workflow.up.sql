CREATE TABLE supplier_claims (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  support_case_id UUID NOT NULL REFERENCES support_cases(id) ON DELETE RESTRICT,
  procurement_operation_id UUID NOT NULL REFERENCES procurement_operations(id) ON DELETE RESTRICT,
  fulfillment_id UUID REFERENCES fulfillment_operations(id) ON DELETE RESTRICT,
  supplier_id TEXT NOT NULL,
  supplier_order_reference TEXT,
  category TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  outcome TEXT,
  idempotency_key TEXT NOT NULL,
  idempotency_fingerprint TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  CONSTRAINT supplier_claims_category_check CHECK (
    category IN (
      'KEY_NOT_WORKING',
      'KEY_ALREADY_USED',
      'KEY_NOT_RECEIVED_FROM_SUPPLIER',
      'WRONG_PRODUCT',
      'WRONG_REGION',
      'DUPLICATE_FULFILLMENT',
      'SUPPLIER_ORDER_PROBLEM',
      'OTHER'
    )
  ),
  CONSTRAINT supplier_claims_source_check CHECK (
    source IN ('SUPPORT', 'OPERATOR', 'SYSTEM')
  ),
  CONSTRAINT supplier_claims_status_check CHECK (
    status IN ('OPEN', 'UNDER_REVIEW', 'READY_FOR_SUBMISSION', 'RESOLVED', 'CLOSED')
  ),
  CONSTRAINT supplier_claims_priority_check CHECK (
    priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')
  ),
  CONSTRAINT supplier_claims_outcome_check CHECK (
    outcome IS NULL
    OR outcome IN (
      'SUPPLIER_ACCEPTED',
      'SUPPLIER_REJECTED',
      'INFORMATION_REQUIRED',
      'INTERNAL_NOT_ELIGIBLE',
      'CUSTOMER_ISSUE_RESOLVED',
      'NO_SUPPLIER_ACTION_REQUIRED'
    )
  ),
  CONSTRAINT supplier_claims_resolution_tuple_check CHECK (
    (
      status = 'RESOLVED'
      AND outcome IS NOT NULL
      AND resolved_at IS NOT NULL
      AND closed_at IS NULL
    )
    OR (
      status = 'CLOSED'
      AND outcome IS NOT NULL
      AND resolved_at IS NOT NULL
      AND closed_at IS NOT NULL
    )
    OR (
      status NOT IN ('RESOLVED', 'CLOSED')
      AND outcome IS NULL
      AND resolved_at IS NULL
      AND closed_at IS NULL
    )
  ),
  CONSTRAINT supplier_claims_safe_text_check CHECK (
    length(trim(supplier_id)) BETWEEN 1 AND 120
    AND supplier_id = trim(supplier_id)
    AND supplier_id !~ '[[:cntrl:]]'
    AND (supplier_order_reference IS NULL OR (
      length(trim(supplier_order_reference)) BETWEEN 1 AND 200
      AND supplier_order_reference = trim(supplier_order_reference)
      AND supplier_order_reference !~ '[[:cntrl:]]'
      AND supplier_order_reference !~* '(product.?key|plaintext|api.?key|secret|token)'
    ))
    AND length(idempotency_key) BETWEEN 1 AND 128
    AND idempotency_key = trim(idempotency_key)
    AND idempotency_key !~ '[[:cntrl:]]'
    AND idempotency_fingerprint ~ '^[a-f0-9]{64}$'
    AND length(correlation_id) BETWEEN 1 AND 128
    AND correlation_id = trim(correlation_id)
    AND correlation_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT supplier_claims_version_time_check CHECK (
    record_version > 0
    AND created_at <= updated_at
    AND (resolved_at IS NULL OR resolved_at >= created_at)
    AND (closed_at IS NULL OR closed_at >= resolved_at)
  )
);

CREATE UNIQUE INDEX supplier_claims_idempotency_idx
  ON supplier_claims(idempotency_key);

CREATE UNIQUE INDEX supplier_claims_active_issue_idx
  ON supplier_claims(
    order_id,
    support_case_id,
    category,
    procurement_operation_id,
    fulfillment_id
  ) NULLS NOT DISTINCT
  WHERE status NOT IN ('RESOLVED', 'CLOSED');

CREATE INDEX supplier_claims_order_updated_idx
  ON supplier_claims(order_id, updated_at DESC, id DESC);

CREATE TABLE supplier_claim_submission_operations (
  id UUID PRIMARY KEY,
  claim_id UUID NOT NULL UNIQUE REFERENCES supplier_claims(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  supplier_id TEXT NOT NULL,
  supplier_order_reference TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_reference TEXT NOT NULL UNIQUE,
  payload_fingerprint TEXT NOT NULL,
  supplier_claim_reference TEXT,
  response_type TEXT,
  record_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  dispatched_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  CONSTRAINT supplier_claim_submission_status_check CHECK (
    status IN ('PREPARED', 'DISPATCHING', 'CONFIRMED', 'AMBIGUOUS', 'FAILED')
  ),
  CONSTRAINT supplier_claim_submission_response_check CHECK (
    response_type IS NULL
    OR response_type IN ('ACCEPTED', 'REJECTED', 'INFORMATION_REQUIRED', 'RETRYABLE', 'TERMINAL')
  ),
  CONSTRAINT supplier_claim_submission_tuple_check CHECK (
    (status = 'PREPARED' AND dispatched_at IS NULL AND confirmed_at IS NULL AND supplier_claim_reference IS NULL AND response_type IS NULL)
    OR (status = 'DISPATCHING' AND dispatched_at IS NOT NULL AND confirmed_at IS NULL AND supplier_claim_reference IS NULL AND response_type IS NULL)
    OR (status = 'CONFIRMED' AND dispatched_at IS NOT NULL AND confirmed_at IS NOT NULL AND supplier_claim_reference IS NOT NULL AND response_type IN ('ACCEPTED', 'REJECTED', 'INFORMATION_REQUIRED'))
    OR (status = 'AMBIGUOUS' AND dispatched_at IS NOT NULL AND confirmed_at IS NULL AND supplier_claim_reference IS NULL AND response_type IS NULL)
    OR (status = 'FAILED' AND dispatched_at IS NOT NULL AND confirmed_at IS NULL AND supplier_claim_reference IS NULL AND response_type IN ('RETRYABLE', 'TERMINAL'))
  ),
  CONSTRAINT supplier_claim_submission_safe_text_check CHECK (
    length(trim(supplier_id)) BETWEEN 1 AND 120
    AND supplier_id = trim(supplier_id)
    AND length(trim(supplier_order_reference)) BETWEEN 1 AND 200
    AND supplier_order_reference = trim(supplier_order_reference)
    AND supplier_order_reference !~* '(product.?key|plaintext|api.?key|secret|token)'
    AND length(idempotency_reference) BETWEEN 1 AND 200
    AND idempotency_reference = trim(idempotency_reference)
    AND idempotency_reference !~ '[[:cntrl:]]'
    AND payload_fingerprint ~ '^[a-f0-9]{64}$'
    AND (supplier_claim_reference IS NULL OR (
      length(trim(supplier_claim_reference)) BETWEEN 1 AND 200
      AND supplier_claim_reference = trim(supplier_claim_reference)
      AND supplier_claim_reference !~ '[[:cntrl:]]'
      AND supplier_claim_reference !~* '(product.?key|plaintext|api.?key|secret|token)'
    ))
  ),
  CONSTRAINT supplier_claim_submission_time_check CHECK (
    record_version > 0
    AND created_at <= updated_at
    AND (dispatched_at IS NULL OR dispatched_at >= created_at)
    AND (confirmed_at IS NULL OR confirmed_at >= dispatched_at)
  )
);

CREATE INDEX supplier_claim_submission_status_idx
  ON supplier_claim_submission_operations(status, updated_at, id);

CREATE TABLE supplier_claim_evidence_links (
  id UUID PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES supplier_claims(id) ON DELETE RESTRICT,
  evidence_snapshot_id UUID NOT NULL REFERENCES dispute_evidence_snapshots(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT supplier_claim_evidence_unique UNIQUE (claim_id, evidence_snapshot_id)
);

CREATE INDEX supplier_claim_evidence_claim_idx
  ON supplier_claim_evidence_links(claim_id, created_at, id);

CREATE TABLE supplier_claim_events (
  id UUID PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES supplier_claims(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_reference TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  evidence_snapshot_id UUID REFERENCES dispute_evidence_snapshots(id) ON DELETE RESTRICT,
  submission_operation_id UUID REFERENCES supplier_claim_submission_operations(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT supplier_claim_events_type_check CHECK (
    event_type IN (
      'CLAIM_CREATED',
      'CLAIM_STATUS_CHANGED',
      'EVIDENCE_LINKED',
      'SUBMISSION_PREPARED',
      'SUBMISSION_DISPATCHING',
      'SUBMISSION_CONFIRMED',
      'SUBMISSION_AMBIGUOUS',
      'SUBMISSION_FAILED',
      'CLAIM_RESOLVED',
      'CLAIM_CLOSED'
    )
  ),
  CONSTRAINT supplier_claim_events_actor_check CHECK (
    actor_type IN ('OPERATOR', 'SYSTEM')
  ),
  CONSTRAINT supplier_claim_events_status_check CHECK (
    (from_status IS NULL OR from_status IN ('OPEN', 'UNDER_REVIEW', 'READY_FOR_SUBMISSION', 'RESOLVED', 'CLOSED'))
    AND (to_status IS NULL OR to_status IN ('OPEN', 'UNDER_REVIEW', 'READY_FOR_SUBMISSION', 'RESOLVED', 'CLOSED'))
  ),
  CONSTRAINT supplier_claim_events_safe_actor_check CHECK (
    length(trim(actor_reference)) BETWEEN 1 AND 128
    AND actor_reference = trim(actor_reference)
    AND actor_reference !~ '[[:cntrl:]]'
    AND actor_reference !~* '(product.?key|plaintext|api.?key|secret|token)'
  ),
  CONSTRAINT supplier_claim_events_time_check CHECK (
    occurred_at >= '2026-01-01T00:00:00Z'::timestamptz
  )
);

CREATE INDEX supplier_claim_events_claim_idx
  ON supplier_claim_events(claim_id, occurred_at, id);

CREATE FUNCTION validate_supplier_claim_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  support_order_id UUID;
  procurement_order_id UUID;
  procurement_supplier_id TEXT;
  procurement_supplier_order_reference TEXT;
  fulfillment_order_id UUID;
  fulfillment_procurement_id UUID;
BEGIN
  SELECT order_id INTO support_order_id FROM support_cases WHERE id = NEW.support_case_id;
  IF support_order_id IS NULL OR support_order_id IS DISTINCT FROM NEW.order_id THEN
    RAISE EXCEPTION 'Supplier claim support case order mismatch';
  END IF;

  SELECT order_id, supplier_id, external_supplier_order_id
    INTO procurement_order_id, procurement_supplier_id, procurement_supplier_order_reference
  FROM procurement_operations WHERE id = NEW.procurement_operation_id;
  IF procurement_order_id IS NULL OR procurement_order_id IS DISTINCT FROM NEW.order_id THEN
    RAISE EXCEPTION 'Supplier claim procurement order mismatch';
  END IF;
  IF procurement_supplier_id IS DISTINCT FROM NEW.supplier_id
    OR procurement_supplier_order_reference IS DISTINCT FROM NEW.supplier_order_reference THEN
    RAISE EXCEPTION 'Supplier claim supplier identity must derive from procurement';
  END IF;

  IF NEW.fulfillment_id IS NOT NULL THEN
    SELECT order_id, procurement_operation_id
      INTO fulfillment_order_id, fulfillment_procurement_id
    FROM fulfillment_operations WHERE id = NEW.fulfillment_id;
    IF fulfillment_order_id IS NULL
      OR fulfillment_order_id IS DISTINCT FROM NEW.order_id
      OR fulfillment_procurement_id IS DISTINCT FROM NEW.procurement_operation_id THEN
      RAISE EXCEPTION 'Supplier claim fulfillment order mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supplier_claims_exact_identity
BEFORE INSERT ON supplier_claims
FOR EACH ROW
EXECUTE FUNCTION validate_supplier_claim_identity();

CREATE FUNCTION prevent_supplier_claim_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.support_case_id IS DISTINCT FROM OLD.support_case_id
    OR NEW.procurement_operation_id IS DISTINCT FROM OLD.procurement_operation_id
    OR NEW.fulfillment_id IS DISTINCT FROM OLD.fulfillment_id
    OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
    OR NEW.supplier_order_reference IS DISTINCT FROM OLD.supplier_order_reference
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.idempotency_fingerprint IS DISTINCT FROM OLD.idempotency_fingerprint
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Supplier claim identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supplier_claims_identity_immutable
BEFORE UPDATE ON supplier_claims
FOR EACH ROW
EXECUTE FUNCTION prevent_supplier_claim_identity_change();

CREATE FUNCTION validate_supplier_claim_evidence_link()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  claim_order_id UUID;
  evidence_order_id UUID;
  evidence_state TEXT;
BEGIN
  SELECT order_id INTO claim_order_id FROM supplier_claims WHERE id = NEW.claim_id;
  SELECT order_id, state INTO evidence_order_id, evidence_state
  FROM dispute_evidence_snapshots WHERE id = NEW.evidence_snapshot_id;
  IF claim_order_id IS NULL
    OR evidence_order_id IS NULL
    OR NEW.order_id IS DISTINCT FROM claim_order_id
    OR evidence_order_id IS DISTINCT FROM claim_order_id THEN
    RAISE EXCEPTION 'Supplier claim evidence order mismatch';
  END IF;
  IF evidence_state <> 'FINALIZED' THEN
    RAISE EXCEPTION 'Supplier claim evidence must be finalized';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supplier_claim_evidence_exact_order
BEFORE INSERT ON supplier_claim_evidence_links
FOR EACH ROW
EXECUTE FUNCTION validate_supplier_claim_evidence_link();

CREATE FUNCTION validate_supplier_claim_submission_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  claim_order_id UUID;
  claim_supplier_id TEXT;
  claim_supplier_order_reference TEXT;
BEGIN
  SELECT order_id, supplier_id, supplier_order_reference
    INTO claim_order_id, claim_supplier_id, claim_supplier_order_reference
  FROM supplier_claims WHERE id = NEW.claim_id;
  IF claim_order_id IS NULL
    OR NEW.order_id IS DISTINCT FROM claim_order_id
    OR NEW.supplier_id IS DISTINCT FROM claim_supplier_id
    OR NEW.supplier_order_reference IS DISTINCT FROM claim_supplier_order_reference THEN
    RAISE EXCEPTION 'Supplier claim submission identity mismatch';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supplier_claim_submission_exact_identity
BEFORE INSERT ON supplier_claim_submission_operations
FOR EACH ROW
EXECUTE FUNCTION validate_supplier_claim_submission_identity();

CREATE FUNCTION prevent_supplier_claim_submission_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.claim_id IS DISTINCT FROM OLD.claim_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
    OR NEW.supplier_order_reference IS DISTINCT FROM OLD.supplier_order_reference
    OR NEW.idempotency_reference IS DISTINCT FROM OLD.idempotency_reference
    OR NEW.payload_fingerprint IS DISTINCT FROM OLD.payload_fingerprint
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Supplier claim submission identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supplier_claim_submission_identity_immutable
BEFORE UPDATE ON supplier_claim_submission_operations
FOR EACH ROW
EXECUTE FUNCTION prevent_supplier_claim_submission_identity_change();

CREATE FUNCTION validate_supplier_claim_submission_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (
    (OLD.status = 'PREPARED' AND NEW.status = 'DISPATCHING')
    OR (
      OLD.status = 'DISPATCHING'
      AND NEW.status IN ('CONFIRMED', 'AMBIGUOUS', 'FAILED')
    )
  ) THEN
    RAISE EXCEPTION 'Invalid supplier claim submission transition';
  END IF;
  IF NEW.record_version <> OLD.record_version + 1
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Invalid supplier claim submission version';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supplier_claim_submission_transition_valid
BEFORE UPDATE ON supplier_claim_submission_operations
FOR EACH ROW
EXECUTE FUNCTION validate_supplier_claim_submission_transition();

CREATE FUNCTION prevent_supplier_claim_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Supplier claim history is append-only';
END;
$$;

CREATE TRIGGER supplier_claim_events_no_update
BEFORE UPDATE ON supplier_claim_events
FOR EACH ROW
EXECUTE FUNCTION prevent_supplier_claim_history_mutation();

CREATE TRIGGER supplier_claim_events_no_delete
BEFORE DELETE ON supplier_claim_events
FOR EACH ROW
EXECUTE FUNCTION prevent_supplier_claim_history_mutation();

CREATE TRIGGER supplier_claim_evidence_no_update
BEFORE UPDATE ON supplier_claim_evidence_links
FOR EACH ROW
EXECUTE FUNCTION prevent_supplier_claim_history_mutation();

CREATE TRIGGER supplier_claim_evidence_no_delete
BEFORE DELETE ON supplier_claim_evidence_links
FOR EACH ROW
EXECUTE FUNCTION prevent_supplier_claim_history_mutation();

CREATE FUNCTION prevent_evidence_link_after_submission_preparation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM supplier_claim_submission_operations
    WHERE claim_id = NEW.claim_id
  ) THEN
    RAISE EXCEPTION 'Supplier claim evidence is frozen after submission preparation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER supplier_claim_evidence_preparation_freeze
BEFORE INSERT ON supplier_claim_evidence_links
FOR EACH ROW
EXECUTE FUNCTION prevent_evidence_link_after_submission_preparation();
