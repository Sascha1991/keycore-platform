# Customer Order Identity

KS-07-06 adds the customer identity and order ownership foundation required by
secure customer key delivery. It does not add a production login provider,
customer account UI, live email flow, real Stripe mutation or supplier
procurement.

## Identity Model

`CustomerId` is an opaque immutable UUID. Email is contact metadata, not the
customer identity.

Customers persist:

- normalized email;
- verification state `UNVERIFIED` or `VERIFIED`;
- record version;
- creation and update timestamps.

Email normalization trims the address and lowercases only the domain. It does
not apply provider-specific behavior such as removing dots or plus tags. A
duplicate normalized email returns the existing customer explicitly; it does not
silently merge unrelated identities.

External identity bindings are stored separately with `(provider,
provider_subject)` uniqueness. Binding an already-used external subject to a
different customer fails closed with `IDENTITY_CONFLICT`.

## Order Ownership

`keycore_orders.customer_id` records the owner when ownership is proven by a
trusted service or admin context. Existing legacy orders may remain unowned.

Ownership binding is concurrency-safe:

- missing trusted context returns `UNTRUSTED_CONTEXT`;
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

Production authentication is represented by
`FailClosedProductionPrincipalProvider`, which always returns no principal until
a real auth integration is explicitly added in a later task.

## Safe Inspect

DB-only inspection:

```sh
npm run customer:inspect -- <customerId>
npm run order:ownership-inspect -- <orderId>
```

The customer command masks email. Neither command decrypts secrets, calls
Kinguin, calls Stripe, sends customer delivery, retrieves keys or mutates
supplier/customer state.

## Live Data Rule

The known live fulfillment `fd61be5e-44ea-4914-98ae-c4404dc31779` must remain
untouched by KS-07-06. Without cryptographically or operationally proven
ownership it stays legacy/unclaimed and customer delivery authorization denies
access.
