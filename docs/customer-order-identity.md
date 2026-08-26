# Customer Order Identity

KS-07-06 adds the customer identity and order ownership foundation required by
secure customer key delivery. It does not add a production login provider,
customer account UI, live email flow, real Stripe mutation or supplier
procurement.

## Identity Model

`CustomerId` is an opaque immutable UUID. Email is contact metadata, not the
customer identity and not authentication. Creating or replaying a customer by
email never proves that the caller owns the mailbox.

Customers persist:

- normalized email;
- verification state `UNVERIFIED` or `VERIFIED`;
- record version;
- creation and update timestamps.

Normal customer creation always creates `UNVERIFIED`. `VERIFIED` requires
trusted evidence through `EmailVerificationAuthorityPort`; the default
authority fails closed until a real verification source is connected. The only
implemented transition is `UNVERIFIED -> VERIFIED`; PostgreSQL blocks
`VERIFIED -> UNVERIFIED` regression.

Email normalization trims the address and lowercases only the domain. It does
not apply provider-specific behavior such as removing dots or plus tags. A
duplicate normalized email returns the existing customer explicitly for internal
idempotency; it does not silently merge unrelated identities, authenticate a
caller, bind external identity, bind an order or authorize delivery. Future
public boundaries must avoid exposing detailed existing-customer results in a
way that enables account discovery.

External identity bindings are stored separately with `(provider,
provider_subject)` uniqueness. Binding requires
`CustomerIdentityBindingAuthorityPort`, where a future provider integration
derives the provider subject from verified provider-side context. Knowing a
`customerId` plus a `providerSubject` string is not proof. Binding an already
used external subject to a different customer fails closed with
`IDENTITY_CONFLICT`; binding to a nonexistent customer returns
`CUSTOMER_NOT_FOUND`.

## Order Ownership

`keycore_orders.customer_id` records the owner when ownership is proven by
`OrderOwnershipBindingAuthorityPort`. Plain caller-created metadata objects are
not trust boundaries. Existing legacy orders may remain unowned.

KS-08-05 adds an optional immutable guest-checkout email snapshot on
`keycore_orders.checkout_email_normalized`. The snapshot is purchase-time
contact context, not ownership proof. PostgreSQL prevents changing the snapshot
after insert, including `NULL -> value`, `value A -> value B` and
`value -> NULL`. Secure guest claim uses it only together with an authenticated
verified account, a one-time claim credential and trusted claim authority.

Ownership binding is concurrency-safe:

- missing ownership authority returns `UNTRUSTED_AUTHORITY`;
- unknown customer returns `CUSTOMER_NOT_FOUND`;
- unknown order returns `ORDER_NOT_FOUND`;
- stale order version returns `STALE_WRITER`;
- binding the same customer again returns `ALREADY_BOUND`;
- binding a different customer after ownership is set returns
  `OWNERSHIP_CONFLICT`;
- PostgreSQL rejects later customer reassignment.

## Delivery Authorization

`PersistedCustomerOrderAuthorizationPort` backs KS-07-05 customer delivery with
database ownership checks. Authorization requires:

- a trusted authenticated customer principal;
- the requested principal customer ID matching the authorization customer ID;
- `keycore_orders.customer_id` matching that customer;
- the fulfillment operation linked to the same order;
- verified email when verification is required;
- order procurement succeeded and fulfillment pending;
- fulfillment status `DELIVERY_PENDING`;
- retrieval state `RETRIEVED`;
- delivery state `PENDING`;
- an encrypted fulfillment secret present.

Missing, unknown, wrong, unverified, unowned, wrong-order, unlinked, legacy and
malformed contexts are denied. Public callers should receive the same generic
unauthorized/not-ready response shape to avoid enumeration.

KS-07-08 keeps `customerId` out of customer-facing delivery requests. The
delivery transport resolves the customer from the authenticated session and then
uses persisted order/fulfillment ownership checks. A request-supplied customer
ID cannot escalate access and supplier order IDs are not accepted as customer
delivery references.

KS-07-07 adds a production session foundation that can provide this principal
through `CustomerSessionPrincipalProvider` after a trusted authentication
assertion resolves through a persisted identity binding. The fail-closed
production provider remains available for composition roots that have not wired
session authentication. Test principals are rejected by persisted delivery
authorization unless the composition root explicitly enables
`allowTestPrincipal` for tests.

## Safe Inspect

DB-only inspection:

```sh
npm run customer:inspect -- <customerId>
npm run order:ownership-inspect -- <orderId>
npm run customer-session:inspect -- <sessionId>
```

The customer command masks email. Neither command decrypts secrets, calls
Kinguin, calls Stripe, sends customer delivery, retrieves keys or mutates
supplier/customer state.

## Live Data Rule

The known live fulfillment `fd61be5e-44ea-4914-98ae-c4404dc31779` must remain
untouched by KS-07-06. Without cryptographically or operationally proven
ownership it stays legacy/unclaimed and customer delivery authorization denies
access.

## Customer Account Reads

KS-08-01 reuses this ownership model for customer account order history and
order detail. Account reads are scoped by the authenticated principal's
`customerId` and the PostgreSQL account read adapter filters with
`keycore_orders.customer_id` in SQL. Wrong-customer, unknown and legacy
unclaimed orders return the same customer-facing unavailable semantics.

KS-08-02 adds the registration and verified account-linking lifecycle on top of
this model. Registration still creates only `UNVERIFIED` customers; verified
email requires the challenge flow and trusted `EmailVerificationAuthorityPort`.
External identity linking requires an authenticated verified customer and
trusted `CustomerIdentityBindingAuthorityPort` evidence. Guest order claiming
remains fail-closed unless future trusted order-claim evidence is supplied; email
equality alone is never ownership proof.

KS-08-05 supplies the first transport-neutral trusted guest-claim evidence path:
hash-only one-time Kaufcode plus verified account email matching the
purchase-time checkout email snapshot for the exact unclaimed order. Successful
claim still mutates ownership only through the same
`OrderOwnershipBindingAuthorityPort` boundary.
