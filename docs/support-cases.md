# Support Case Foundation

KS-09-04 adds a provider-neutral `SupportCase` foundation for customer-owned
order support and internal/operator-created cases. It does not integrate a
production helpdesk, send email, mutate Stripe, mutate Kinguin, retrieve keys,
display keys, deliver keys, issue refunds or create supplier claims.

## Model

Support cases are internal KeyCore records. They are not Zendesk, Freshdesk,
Intercom or any other helpdesk-provider records.

Case fields include:

- case ID;
- immutable customer ID and order ID references where applicable;
- category;
- status;
- priority;
- source;
- optional structured resolution code;
- record version;
- correlation ID;
- created, updated, resolved and closed timestamps.

Supported statuses are `OPEN`, `IN_PROGRESS`, `WAITING_FOR_CUSTOMER`,
`WAITING_FOR_INTERNAL`, `RESOLVED` and `CLOSED`.

Customer replies are accepted only while the case is open, in progress, waiting
for the customer or waiting for internal action. `RESOLVED` and `CLOSED` cases
reject customer replies; reopening is not part of KS-09-04.

## Customer Boundary

Customer actions require an authenticated KeyRaNo/KeyCore customer principal
with `AUTHENTICATED` assurance and a persisted customer. Order-scoped cases
also require an order already owned by that customer. SQL and repository reads
filter by `customer_id`; request-supplied customer IDs, emails, WooCommerce
IDs, billing emails or bare order IDs are never authority.

Wrong-owner, unknown and unclaimed orders fail closed as
`RESOURCE_NOT_AVAILABLE` to avoid enumeration. A guest or unclaimed order cannot
be opened as order-scoped support merely by knowing an order ID or checkout
email.

Non-order customer cases are limited to account support categories such as
`ACCOUNT_PROBLEM`.

Customers may:

- create allowed support cases;
- list their own cases;
- view their own case detail;
- add customer-visible replies.

Customers may not set status, priority, internal visibility, resolution codes,
operator references, evidence links, fraud links or fulfillment links.

Customer projections are explicit DTOs. They expose only safe case fields:
case ID, customer ID, order ID, category, status, resolution code and
timestamps. They do not expose internal priority, source, correlation ID or
record version. Customer detail loads only `CUSTOMER_VISIBLE` messages at the
repository SQL boundary and filters visibility again in application code.

## Operator Boundary

Operator actions require `SupportOperatorAuthorityPort`. The default production
authority fails closed. Request-supplied `operatorId`, `isAdmin`, `priority` or
status fields are not trusted.

Trusted operators may create internal cases, add internal notes, change status,
set priority and link safe references. KS-09-04 does not provide production
operator authentication or UI.

If an operator provides an unclaimed `orderId`, the case may be order-scoped
with `customerId = NULL`. The operator cannot attach an arbitrary customer to
that unclaimed order. If the order already has an authoritative customer, a
mismatching request customer is rejected and the support case uses the
authoritative order customer. Support cases do not repair, fabricate or imply
order ownership.

## Messages

`SupportMessage` stores plain text only:

- author type: `CUSTOMER`, `OPERATOR` or `SYSTEM`;
- visibility: `CUSTOMER_VISIBLE` or `INTERNAL`;
- non-empty trimmed body;
- explicit 5,000 character maximum;
- no carriage returns or control characters.

Customers cannot create internal notes or impersonate operators. Internal notes
are excluded from customer projections and included only in operator
projections. Message bodies are not copied into audit metadata.

Support messages are append-only in PostgreSQL. KS-09-04 has no correction or
redaction workflow, so direct update and delete attempts are rejected.

KS-09-04 does not promise to redact arbitrary secrets deliberately typed by a
customer into a customer-visible message. It does ensure generated DTOs,
system/operator projections, errors and audit metadata do not include platform
secret markers.

## Links

Support links are references only. They do not copy provider payloads, Product
Keys, ciphertext, capability tokens, raw payment references or supplier
responses.

Trusted operators may link:

- dispute evidence snapshots;
- fraud manual-review cases;
- fraud risk evaluations;
- fulfillment operations.

Every link is exact-order bound: the referenced record must belong to the same
order as the support case. Cross-order links fail closed.

PostgreSQL repeats the exact-order validation in a `BEFORE INSERT` trigger and
support links are append-only. Link retargeting and unlinking are not part of
KS-09-04.

Support links are not refund authority, supplier claim authority, fraud
approval authority or key-delivery authority.

## Persistence

Migration 023 adds:

- `support_cases`;
- `support_messages`;
- `support_case_events`;
- `support_case_links`.

PostgreSQL enforces:

- customer/order/source immutability on support cases;
- bounded safe message text;
- customer messages as customer-visible only;
- append-only support messages;
- append-only support events;
- append-only support links;
- exact-order link validation against the selected target table;
- typed status, priority, category, source and resolution values;
- `CLOSED`/`RESOLVED` cases with structured resolution codes;
- chronological timestamp consistency;
- deterministic customer-list indexes;
- unique reference links per case and target.

PostgreSQL remains the durable source of truth. Redis and external helpdesks
are not durable business-state stores for support cases.

## Audit

Support audit events use the `SUPPORT_` prefix and contain only safe metadata:
case ID, category, status, source, customer ID, order ID, author type and
visibility. Audit metadata does not include message bodies, Product Keys,
credentials, sessions, claim codes, payment secrets, Kinguin secrets, velocity
correlation secrets or provider payloads.

## Production Status

Production support workflow is not ready in KS-09-04.

Not included:

- production HTTP transport;
- customer/support UI;
- helpdesk SaaS integration;
- production operator authentication;
- email notifications;
- supplier claim workflow;
- refund execution;
- Stripe or Kinguin mutations;
- product-key retrieval, reveal, display or delivery.
