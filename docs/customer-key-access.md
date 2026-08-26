# Customer Key Access

KS-08-04 connects customer account key-vault metadata to the existing secure
customer delivery foundation. It adds a transport-neutral application boundary;
it does not expose production HTTP, install WooCommerce, add a frontend or
enable real customer key reveal.

## Flow

```text
Keyrano account
-> KeyCore authenticated session
-> owned order
-> safe key metadata
-> explicit reveal action
-> KS-07 secure delivery boundary
-> customer delivery result
```

Account reads remain metadata-only. Reading account summary, order history,
order detail or key-vault metadata never decrypts, delivers or prepares a
delivery capability.

## Authorization

Key access requires:

- authenticated `AuthenticatedCustomerPrincipal`;
- persisted verified customer;
- owned KeyCore order;
- fulfillment linked to that exact order;
- eligible retrieved encrypted fulfillment secret;
- KS-07-05 secure delivery authorization.

Request-supplied `customerId`, WooCommerce user ID, email, provider subject,
supplier ID, external supplier order ID and arbitrary headers are never
authorization inputs.

## Delivery Reuse

KS-08-04 reuses the existing KS-07-05 and KS-07-08 architecture:

- hash-only one-time capabilities;
- context-bound approval;
- explicit claim and acknowledge semantics;
- stale in-flight/manual-review recovery;
- post-dispatch ambiguity protection;
- plaintext lifetime limited to the delivery port boundary.

There is no second key vault, decrypt service, WooCommerce key store or
plaintext account endpoint.

## Safety

Successful synthetic tests use only
`KEYCORE_KS0804_SYNTHETIC_PRODUCT_KEY_DO_NOT_USE_918273`. The marker may appear
only inside the fake delivery port observation. It must not appear in audit,
repositories, responses, snapshots, limiter keys or errors.

If encrypted fulfillment material is missing, KeyCore fails closed. Customer
key access never calls Kinguin, never purchases from a supplier and never
retrieves a key from a supplier again.

## WooCommerce

WooCommerce remains a non-authoritative storefront adapter. WooCommerce email,
customer ID, order ID, billing email, user meta or order meta cannot
authenticate, claim ownership, issue a delivery capability, decrypt or deliver a
product key. Future WooCommerce code may only present KeyCore-authorized
results.

## Production Status

- REAL LOGIN PROVIDER CONNECTED: NO
- PRODUCTION CUSTOMER ACCOUNT API EXPOSED: NO
- WOOCOMMERCE CONNECTED: NO
- PRODUCTION FRONTEND CONNECTED: NO
- PRODUCTION EMAIL DELIVERY CONNECTED: NO
- PRODUCTION DISTRIBUTED RATE LIMITER READY: NO
- REAL KEY REVEAL ENABLED: NO
