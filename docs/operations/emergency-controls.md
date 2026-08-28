# Emergency Operations Controls

Operations Controls are global, provider-neutral deny-only gates. `ENABLED`
means only that the operations layer does not pause an action. It never enables
a production adapter or bypasses payment, fraud, ownership, fulfillment,
authorization, approval, idempotency or state-machine rules.

## Capabilities

- `PROCUREMENT_CREATE`
- `SUPPLIER_KEY_RETRIEVAL`
- `CUSTOMER_KEY_DELIVERY`
- `SUPPLIER_CLAIM_SUBMISSION`

Migration 025 creates exactly one authoritative PostgreSQL row for each
capability in `ENABLED` state and records initialization history. Missing,
malformed or unavailable state denies high-risk mutation. Controls survive
restart/redeploy and Redis flush because Redis is not consulted.

Trusted mutation uses `OperationsControlAuthorityPort`; its production/default
implementation denies. Business services receive only `OperationsControlGate`.
Pause requires a structured reason (`MAINTENANCE`, `INCIDENT_RESPONSE`,
`SUPPLIER_INCIDENT`, `SECURITY_INCIDENT` or `MANUAL_OPERATIONS_PAUSE`). Resume
requires trusted authority and a new expected version. Stable operation IDs
make exact replay idempotent; conflicting reuse fails. Optimistic concurrency
allows one writer per version. History is append-only at database level.

## Mutation Placement

- procurement checks before acquiring an execution lease and before supplier
  purchase dispatch; reconciliation remains available;
- key retrieval checks before retrieval lease, KMS use and supplier request;
- customer delivery checks before delivery claim/capability consumption,
  decryption and delivery;
- supplier claims check before `PREPARED` becomes `DISPATCHING` and before the
  submission adapter call.

Pausing does not rewrite already dispatched or ambiguous work and does not
erase encrypted secrets. There is an unavoidable check-to-call race: an action
already past its gate cannot be recalled; its durable idempotency and
reconciliation semantics remain authoritative.

Payment mutation, webhook ingestion and global outbox dispatch are not gated in
KS-10-01. Dropping provider webhooks or consistency events would make state
less safe. Checkout/category controls are not falsely advertised without a
production storefront enforcement boundary.

No unauthenticated mutation CLI or production operations UI is provided.
`SECURITY-READINESS` human approval remains pending.
