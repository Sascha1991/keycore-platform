CREATE TABLE support_cases (
  id UUID PRIMARY KEY,
  customer_id UUID REFERENCES keycore_customers(id) ON DELETE RESTRICT,
  order_id UUID REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  source TEXT NOT NULL,
  resolution_code TEXT,
  record_version INTEGER NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  CONSTRAINT support_cases_category_check CHECK (
    category IN (
      'ACCOUNT_PROBLEM',
      'ACTIVATION_PROBLEM',
      'INVOICE_PROBLEM',
      'KEY_NOT_AVAILABLE',
      'KEY_REVEAL_PROBLEM',
      'ORDER_STATUS',
      'PAYMENT_PROBLEM',
      'REFUND_REQUEST',
      'SUPPLIER_PROBLEM',
      'SUSPECTED_DUPLICATE_ORDER',
      'OTHER'
    )
  ),
  CONSTRAINT support_cases_status_check CHECK (
    status IN (
      'OPEN',
      'IN_PROGRESS',
      'WAITING_FOR_CUSTOMER',
      'WAITING_FOR_INTERNAL',
      'RESOLVED',
      'CLOSED'
    )
  ),
  CONSTRAINT support_cases_priority_check CHECK (
    priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')
  ),
  CONSTRAINT support_cases_source_check CHECK (
    source IN ('CUSTOMER', 'OPERATOR', 'SYSTEM')
  ),
  CONSTRAINT support_cases_resolution_check CHECK (
    resolution_code IS NULL
    OR resolution_code IN (
      'CUSTOMER_ACTION_REQUIRED',
      'DUPLICATE_REQUEST',
      'INFORMATION_PROVIDED',
      'NO_PLATFORM_ERROR_FOUND',
      'ORDER_COMPLETED',
      'REFUND_REFERRED',
      'SUPPLIER_REVIEW_REQUIRED'
    )
  ),
  CONSTRAINT support_cases_version_check CHECK (
    record_version > 0
    AND length(trim(correlation_id)) BETWEEN 1 AND 128
    AND correlation_id !~ '[[:cntrl:]]'
  ),
  CONSTRAINT support_cases_resolution_tuple_check CHECK (
    (
      status = 'RESOLVED'
      AND resolution_code IS NOT NULL
      AND resolved_at IS NOT NULL
      AND closed_at IS NULL
    )
    OR (
      status = 'CLOSED'
      AND resolution_code IS NOT NULL
      AND closed_at IS NOT NULL
    )
    OR (
      status NOT IN ('RESOLVED', 'CLOSED')
      AND resolution_code IS NULL
      AND resolved_at IS NULL
      AND closed_at IS NULL
    )
  ),
  CONSTRAINT support_cases_timestamp_order_check CHECK (
    created_at <= updated_at
    AND (resolved_at IS NULL OR resolved_at >= created_at)
    AND (closed_at IS NULL OR closed_at >= created_at)
    AND (
      resolved_at IS NULL
      OR closed_at IS NULL
      OR closed_at >= resolved_at
    )
  )
);

CREATE INDEX support_cases_customer_list_idx
  ON support_cases(customer_id, updated_at DESC, id DESC)
  WHERE customer_id IS NOT NULL;

CREATE INDEX support_cases_order_idx
  ON support_cases(order_id, updated_at DESC, id DESC)
  WHERE order_id IS NOT NULL;

CREATE TABLE support_messages (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES support_cases(id) ON DELETE RESTRICT,
  author_type TEXT NOT NULL,
  visibility TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT support_messages_author_check CHECK (
    author_type IN ('CUSTOMER', 'OPERATOR', 'SYSTEM')
  ),
  CONSTRAINT support_messages_visibility_check CHECK (
    visibility IN ('CUSTOMER_VISIBLE', 'INTERNAL')
  ),
  CONSTRAINT support_messages_body_check CHECK (
    length(btrim(body)) BETWEEN 1 AND 5000
    AND body = btrim(body)
    AND body !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    AND body !~ '\r'
  ),
  CONSTRAINT support_messages_customer_visibility_check CHECK (
    author_type <> 'CUSTOMER' OR visibility = 'CUSTOMER_VISIBLE'
  )
);

CREATE INDEX support_messages_case_created_idx
  ON support_messages(case_id, created_at, id);

CREATE TABLE support_case_events (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES support_cases(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_reference TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  from_priority TEXT,
  to_priority TEXT,
  link_type TEXT,
  link_target_id UUID,
  occurred_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT support_case_events_type_check CHECK (
    event_type IN (
      'CASE_CREATED',
      'MESSAGE_ADDED',
      'STATUS_CHANGED',
      'PRIORITY_CHANGED',
      'EVIDENCE_LINKED',
      'FRAUD_REVIEW_LINKED',
      'FRAUD_EVALUATION_LINKED',
      'FULFILLMENT_LINKED',
      'CASE_RESOLVED',
      'CASE_CLOSED'
    )
  ),
  CONSTRAINT support_case_events_actor_check CHECK (
    actor_type IN ('CUSTOMER', 'OPERATOR', 'SYSTEM')
  ),
  CONSTRAINT support_case_events_status_check CHECK (
    (from_status IS NULL OR from_status IN ('OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'WAITING_FOR_INTERNAL', 'RESOLVED', 'CLOSED'))
    AND (to_status IS NULL OR to_status IN ('OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'WAITING_FOR_INTERNAL', 'RESOLVED', 'CLOSED'))
  ),
  CONSTRAINT support_case_events_priority_check CHECK (
    (from_priority IS NULL OR from_priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT'))
    AND (to_priority IS NULL OR to_priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT'))
  ),
  CONSTRAINT support_case_events_link_check CHECK (
    link_type IS NULL
    OR link_type IN ('DISPUTE_EVIDENCE', 'FRAUD_REVIEW', 'FRAUD_EVALUATION', 'FULFILLMENT')
  ),
  CONSTRAINT support_case_events_safe_actor_check CHECK (
    length(trim(actor_reference)) BETWEEN 1 AND 128
    AND actor_reference !~ '[[:cntrl:]]'
    AND actor_reference !~* '(product.?key|plaintext|api.?key|secret|token)'
  ),
  CONSTRAINT support_case_events_timestamp_check CHECK (
    occurred_at >= '2026-01-01T00:00:00Z'::timestamptz
  )
);

CREATE INDEX support_case_events_case_occurred_idx
  ON support_case_events(case_id, occurred_at, id);

CREATE TABLE support_case_links (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES support_cases(id) ON DELETE RESTRICT,
  link_type TEXT NOT NULL,
  dispute_evidence_snapshot_id UUID REFERENCES dispute_evidence_snapshots(id) ON DELETE RESTRICT,
  fraud_review_case_id UUID REFERENCES fraud_manual_review_cases(id) ON DELETE RESTRICT,
  fraud_evaluation_id UUID REFERENCES fraud_risk_evaluations(id) ON DELETE RESTRICT,
  fulfillment_id UUID REFERENCES fulfillment_operations(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL REFERENCES keycore_orders(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT support_case_links_type_check CHECK (
    link_type IN ('DISPUTE_EVIDENCE', 'FRAUD_REVIEW', 'FRAUD_EVALUATION', 'FULFILLMENT')
  ),
  CONSTRAINT support_case_links_exact_target_check CHECK (
    (
      link_type = 'DISPUTE_EVIDENCE'
      AND dispute_evidence_snapshot_id IS NOT NULL
      AND fraud_review_case_id IS NULL
      AND fraud_evaluation_id IS NULL
      AND fulfillment_id IS NULL
    )
    OR (
      link_type = 'FRAUD_REVIEW'
      AND dispute_evidence_snapshot_id IS NULL
      AND fraud_review_case_id IS NOT NULL
      AND fraud_evaluation_id IS NULL
      AND fulfillment_id IS NULL
    )
    OR (
      link_type = 'FRAUD_EVALUATION'
      AND dispute_evidence_snapshot_id IS NULL
      AND fraud_review_case_id IS NULL
      AND fraud_evaluation_id IS NOT NULL
      AND fulfillment_id IS NULL
    )
    OR (
      link_type = 'FULFILLMENT'
      AND dispute_evidence_snapshot_id IS NULL
      AND fraud_review_case_id IS NULL
      AND fraud_evaluation_id IS NULL
      AND fulfillment_id IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX support_case_links_dispute_idx
  ON support_case_links(case_id, dispute_evidence_snapshot_id)
  WHERE dispute_evidence_snapshot_id IS NOT NULL;

CREATE UNIQUE INDEX support_case_links_fraud_review_idx
  ON support_case_links(case_id, fraud_review_case_id)
  WHERE fraud_review_case_id IS NOT NULL;

CREATE UNIQUE INDEX support_case_links_fraud_evaluation_idx
  ON support_case_links(case_id, fraud_evaluation_id)
  WHERE fraud_evaluation_id IS NOT NULL;

CREATE UNIQUE INDEX support_case_links_fulfillment_idx
  ON support_case_links(case_id, fulfillment_id)
  WHERE fulfillment_id IS NOT NULL;

CREATE INDEX support_case_links_case_idx
  ON support_case_links(case_id, created_at, id);

CREATE FUNCTION prevent_support_case_ownership_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Support case ownership and source are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER support_cases_ownership_immutable
BEFORE UPDATE ON support_cases
FOR EACH ROW
EXECUTE FUNCTION prevent_support_case_ownership_change();

CREATE FUNCTION prevent_support_case_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Support case events are append-only';
END;
$$;

CREATE TRIGGER support_case_events_no_update
BEFORE UPDATE ON support_case_events
FOR EACH ROW
EXECUTE FUNCTION prevent_support_case_event_mutation();

CREATE TRIGGER support_case_events_no_delete
BEFORE DELETE ON support_case_events
FOR EACH ROW
EXECUTE FUNCTION prevent_support_case_event_mutation();

CREATE FUNCTION prevent_support_message_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Support messages are append-only';
END;
$$;

CREATE TRIGGER support_messages_no_update
BEFORE UPDATE ON support_messages
FOR EACH ROW
EXECUTE FUNCTION prevent_support_message_mutation();

CREATE TRIGGER support_messages_no_delete
BEFORE DELETE ON support_messages
FOR EACH ROW
EXECUTE FUNCTION prevent_support_message_mutation();

CREATE FUNCTION validate_support_case_link_exact_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  case_order_id UUID;
  target_order_id UUID;
BEGIN
  SELECT order_id INTO case_order_id
  FROM support_cases
  WHERE id = NEW.case_id;

  IF case_order_id IS NULL THEN
    RAISE EXCEPTION 'Support case link requires an order-scoped case';
  END IF;

  IF NEW.order_id IS DISTINCT FROM case_order_id THEN
    RAISE EXCEPTION 'Support case link order must match support case order';
  END IF;

  IF NEW.link_type = 'DISPUTE_EVIDENCE' THEN
    SELECT order_id INTO target_order_id
    FROM dispute_evidence_snapshots
    WHERE id = NEW.dispute_evidence_snapshot_id;
  ELSIF NEW.link_type = 'FRAUD_REVIEW' THEN
    SELECT order_id INTO target_order_id
    FROM fraud_manual_review_cases
    WHERE id = NEW.fraud_review_case_id;
  ELSIF NEW.link_type = 'FRAUD_EVALUATION' THEN
    SELECT order_id INTO target_order_id
    FROM fraud_risk_evaluations
    WHERE id = NEW.fraud_evaluation_id;
  ELSIF NEW.link_type = 'FULFILLMENT' THEN
    SELECT order_id INTO target_order_id
    FROM fulfillment_operations
    WHERE id = NEW.fulfillment_id;
  END IF;

  IF target_order_id IS NULL OR target_order_id IS DISTINCT FROM case_order_id THEN
    RAISE EXCEPTION 'Support case link target order mismatch';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER support_case_links_exact_order
BEFORE INSERT ON support_case_links
FOR EACH ROW
EXECUTE FUNCTION validate_support_case_link_exact_order();

CREATE FUNCTION prevent_support_case_link_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Support case links are append-only';
END;
$$;

CREATE TRIGGER support_case_links_no_update
BEFORE UPDATE ON support_case_links
FOR EACH ROW
EXECUTE FUNCTION prevent_support_case_link_mutation();

CREATE TRIGGER support_case_links_no_delete
BEFORE DELETE ON support_case_links
FOR EACH ROW
EXECUTE FUNCTION prevent_support_case_link_mutation();
