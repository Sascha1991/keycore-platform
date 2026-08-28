# Emergency Operations Controls

Operations Controls are global, provider-neutral deny-only gates. `ENABLED`
means only that the operations layer does not pause an action. It never enables
a production adapter or bypasses payment, fraud, ownership, fulfillment,
authorization, approval, idempotency or state-machine rules.

## Capabilities

- `GLOBAL_COMMERCE_MUTATIONS`
- `CHECKOUT_CREATE`
- `PROCUREMENT_CREATE`
- `SUPPLIER_KEY_RETRIEVAL`
- `CUSTOMER_KEY_DELIVERY`
- `SUPPLIER_CLAIM_SUBMISSION`

Migration 025 created the original four controls. Reversible migration 026 adds
`GLOBAL_COMMERCE_MUTATIONS` and `CHECKOUT_CREATE` without modifying migration 025. Each has one authoritative PostgreSQL row and initialization event.
Missing,
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

- checkout checks after exact idempotent replay detection and commercial
  matching, but before PriceLock validation/consumption and authoritative order
  creation;
- procurement checks before acquiring an execution lease and before supplier
  purchase dispatch; reconciliation remains available;
- key retrieval checks before retrieval lease, KMS use and supplier request;
- customer delivery checks before delivery claim/capability consumption,
  decryption and delivery;
- supplier claims check before `PREPARED` becomes `DISPATCHING` and before the
  submission adapter call.

`GLOBAL_COMMERCE_MUTATIONS` is evaluated before each capability-specific
control. When paused it denies new checkout acceptance, procurement,
supplier-key retrieval, customer-key delivery and supplier-claim submission.
It deliberately does not gate payment/webhook ingestion, reconciliation of
already-dispatched work, audit/history append, health/readiness, diagnostics,
backup validation or isolated recovery drills. Those paths establish and
preserve truth during an incident.

Pausing does not rewrite already dispatched or ambiguous work and does not
erase encrypted secrets. There is an unavoidable check-to-call race: an action
already past its gate cannot be recalled; its durable idempotency and
reconciliation semantics remain authoritative.

Payment mutation, webhook ingestion and global outbox dispatch are not gated.
Dropping provider webhooks or consistency events would make state less safe.
Checkout pause is enforced at the current transport-neutral KeyCore order
creation boundary; production WooCommerce wiring remains pending. Category
pause is not implemented because no immutable authoritative category identity
is bound to checkout/procurement. Customer-supplied category input would be
unsafe; a future trusted product/category snapshot is required.

No unauthenticated mutation CLI or production operations UI is provided.
`SECURITY-READINESS` human approval remains pending.
