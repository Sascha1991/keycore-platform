# Supplier Claim Workflow Foundation

KS-09-05 adds a provider-neutral internal `SupplierClaim` workflow for
escalating a structured supplier-related problem. A claim records that a
trusted KeyCore actor requested supplier review. It does not prove supplier
fault, customer truthfulness, key invalidity, refund eligibility or replacement
eligibility.

No production supplier claim adapter, Kinguin mutation, key return, Stripe
refund, replacement-key workflow, customer transport or operator UI is enabled.

## Model and Trust Boundary

A claim is tied to exactly one persisted order, order-scoped support case and
procurement operation. Key-related categories also require an exact
fulfillment operation. Supplier identity and the safe external supplier order
reference are loaded from procurement persistence; request values cannot
override them.

Supported categories are:

- `KEY_NOT_WORKING`;
- `KEY_ALREADY_USED`;
- `KEY_NOT_RECEIVED_FROM_SUPPLIER`;
- `WRONG_PRODUCT`;
- `WRONG_REGION`;
- `DUPLICATE_FULFILLMENT`;
- `SUPPLIER_ORDER_PROBLEM`;
- `OTHER`.

These are reported problem classifications. For example,
`KEY_ALREADY_USED` means that the claim alleges an already-used key; it is not
an authoritative finding that the supplier delivered one.

Sources are `SUPPORT`, `OPERATOR` and `SYSTEM`. Every mutation requires
`SupplierClaimAuthorityPort`. The default authority denies all actions. A
customer cannot directly create an authoritative supplier claim, and request
fields such as operator identity, supplier identity, approval or supplier
acceptance are not authority.

## Eligibility

Eligible support case states are `OPEN`, `IN_PROGRESS` and
`WAITING_FOR_INTERNAL`. `WAITING_FOR_CUSTOMER`, `RESOLVED` and `CLOSED` cannot
escalate in KS-09-05.

The explicit support-category mapping is:

- `ACTIVATION_PROBLEM` may become `KEY_NOT_WORKING`, `KEY_ALREADY_USED`,
  `WRONG_PRODUCT` or `WRONG_REGION`;
- `KEY_NOT_AVAILABLE` may become `KEY_NOT_RECEIVED_FROM_SUPPLIER` or
  `SUPPLIER_ORDER_PROBLEM`;
- `SUPPLIER_PROBLEM` may use any supplier-claim category.

No category is inferred from customer message text. Payment, invoice, account,
refund-request and generic support cases do not automatically become supplier
claims.

A normal supplier claim requires a `SUCCEEDED` procurement with
`DISPATCH_CONFIRMED`. An `AMBIGUOUS` or `RECONCILIATION_REQUIRED` procurement
may only be represented as `SUPPLIER_ORDER_PROBLEM`; this records uncertainty
and does not claim that purchase success was proven. A procurement that was
never dispatched is not eligible.

`KEY_NOT_WORKING`, `KEY_ALREADY_USED`, `WRONG_PRODUCT`, `WRONG_REGION` and
`DUPLICATE_FULFILLMENT` require fulfillment metadata bound to the same order
and procurement operation. The workflow never reads `fulfillment_secrets` and
never decrypts, hashes, compares, displays, exports or submits a Product Key.

## Workflow

Internal claim states are:

- `OPEN`;
- `UNDER_REVIEW`;
- `READY_FOR_SUBMISSION`;
- `RESOLVED`;
- `CLOSED`.

`READY_FOR_SUBMISSION` means only that KeyCore's internal review marked the
claim ready. It does not mean a supplier received anything.

Resolution requires a structured outcome. Supplier-authoritative outcomes
(`SUPPLIER_ACCEPTED`, `SUPPLIER_REJECTED`, `INFORMATION_REQUIRED`) are rejected
unless a supplier submission is already durably `CONFIRMED`. Internal outcomes
remain distinct from supplier refunds, customer Stripe refunds and replacement
fulfillment.

Optimistic `recordVersion` updates prevent lost status changes. Immutable
identity fields cannot be retargeted after creation.

## Evidence and Customer Assertions

A claim may link finalized `DisputeEvidenceSnapshot` records from the exact
same order. Links store identifiers only; evidence JSON is not copied into the
claim. Draft evidence is not accepted, cross-order evidence fails closed and
duplicate linking is idempotent without duplicate history events.

Customer support messages and internal notes are not copied. The structured
category remains an allegation classification separate from verified platform
facts. No raw email, customer message body, provider payload, payment secret,
session, guest-claim token, velocity correlation value, ciphertext or Product
Key belongs in the claim, history, audit or submission model.

## Submission Boundary

Internal claim state and external submission state are separate. A durable
`supplier_claim_submission_operations` record uses:

- `PREPARED`;
- `DISPATCHING`;
- `CONFIRMED`;
- `AMBIGUOUS`;
- `FAILED`.

Preparation persists only safe identifiers and a deterministic payload
fingerprint. The provider-neutral payload contains claim/order references,
supplier order reference, structured category, finalized evidence IDs and a
stable non-secret idempotency reference. It contains no customer prose or key
material. Evidence links are frozen after preparation so the dispatched payload
cannot diverge from its persisted fingerprint. Returning an internally ready
claim to review also prevents dispatch of its existing prepared operation.

The production/default `SupplierClaimSubmissionPort` reports unavailable, so
no dispatch begins. A future adapter must use the durable operation and stable
idempotency reference. A timeout or exception after dispatch becomes
`AMBIGUOUS`; that state cannot be automatically redispatched. Reconciliation
must establish authoritative supplier state before another attempt. This is an
effectively-exactly-once business-effect design, not a claim of network
exactly-once delivery.

Current official Kinguin material represented in the repository documents
order creation, order reads, key retrieval and a separate key-return mutation.
It does not establish a generic supplier-claim API. Kinguin claim capability is
therefore `NOT VERIFIED`, and key return is not used as a substitute.

## Persistence

Migration 024 adds:

- `supplier_claims`;
- `supplier_claim_submission_operations`;
- `supplier_claim_evidence_links`;
- `supplier_claim_events`.

PostgreSQL enforces foreign keys, typed states/outcomes, timestamps, positive
versions, unique idempotency keys, one active claim per exact issue identity,
immutable claim/submission identity, exact-order support/procurement/
fulfillment/evidence binding, supplier identity derived from procurement,
finalized evidence, append-only links/events and valid submission tuples.
Submission transitions are database-enforced; direct state skips fail closed.

Claim creation and its event, evidence linking and its event, status changes
and their events, and submission state changes and their events are
transactional. PostgreSQL is the durable source of truth.

## Audit and Production Status

Global `SUPPLIER_CLAIM_` audit events contain safe IDs, category, source,
status and supplier ID only. Audit append remains best-effort; durable claim
state remains authoritative when audit infrastructure is unavailable.

Phase 09 backend/application foundation is complete with KS-09-05, but supplier
claims are not production-ready. Production operator authority, supplier API
adapter and policy, support UI, retention/operations, refund integration and
replacement fulfillment still require implementation and human review.
