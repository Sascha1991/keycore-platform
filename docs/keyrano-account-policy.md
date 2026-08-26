# KeyRaNo Account Policy

Public customer-facing brand: KeyRaNo — Rapid Access. No Waiting.

German brand message: Dein Key. Direkt. Ohne Warten.

Internal technical platform naming remains KeyCore.

## Authoritative Rule

Product Key access always requires a verified KeyRaNo customer account.

A customer may purchase through authenticated/account checkout or through guest
checkout. Guest checkout does not receive the Product Key by ordinary
transactional email. It receives only a secure one-time claim credential for the
order.

## Account Checkout

Future account checkout may let an existing customer log in or a new customer
create a KeyRaNo account during checkout. KeyCore must receive trusted customer
identity evidence from the selected login/storefront layer. KeyCore does not
store storefront passwords and does not implement password reset.

If checkout finishes before email verification, payment/procurement may proceed
where business policy permits, but key reveal remains blocked until the customer
email is `VERIFIED`.

## Guest Checkout

A guest order is:

```text
keycore_orders.customer_id IS NULL
checkout_email_normalized IS NOT NULL
```

This state alone is not claim proof. Secure claim requires:

- authenticated KeyRaNo account;
- persisted customer email is `VERIFIED`;
- verified account email equals the purchase-time checkout email snapshot;
- valid high-entropy one-time Kaufcode;
- claim code belongs to the exact KeyCore order;
- order is still unclaimed;
- trusted claim authority.

Email equality alone is never ownership proof. Order ID alone is not a claim
secret. Order ID plus email is still not sufficient.

The checkout email snapshot is written from trusted checkout/order creation
evidence. Guest claim issuance must not fabricate or backfill it later for
legacy orders.

Successful claim permanently binds `keycore_orders.customer_id` to the KeyCore
`CustomerId`. After that, normal KS-08-04 key access and secure delivery rules
apply. There is no special guest reveal path.

## WooCommerce Boundary

WooCommerce may later provide checkout email through a trusted checkout bridge.
It cannot authenticate a KeyCore customer, verify email, bind order ownership or
authorize key reveal from browser-supplied email, user ID, billing email or
order metadata.

## Email Security Boundary

If an attacker controls the original purchase mailbox and also has the claim
code, the system cannot distinguish them from the legitimate mailbox controller
within this scope. Additional identity proof and account merge/recovery remain
future support workflows.
