# Customer Account

KS-08-01 adds the transport-neutral customer account backend foundation. It
does not add a production HTTP server, frontend, registration provider,
password login, OAuth, WooCommerce login, invoice generation, guest claim flow
or product-key reveal endpoint.

KS-08-02 adds the transport-neutral registration and verified account-linking
foundation. Registration does not authenticate the customer and email
verification does not create a session; account reads still require an
authenticated principal.

## Trust Boundary

Customer account reads are scoped only by
`AuthenticatedCustomerPrincipal.customerId`. Request-supplied `customerId`,
supplier order IDs, fulfillment IDs alone, provider subjects, emails and
session internals are not account authorization sources.

The intended flow is:

```text
transport -> session resolution -> authenticated principal -> CustomerAccountService
```

`CustomerAccountService` rejects missing or non-authenticated principals. Test
principals are not accepted by the account service.

## Read Model

The account service uses `CustomerAccountReadRepository` for read-only
projections:

- account summary;
- owned order history;
- owned order detail.

The PostgreSQL adapter filters order history and detail with
`keycore_orders.customer_id = principal.customerId` in SQL. It does not load an
arbitrary order and then rely on application-only ownership checks.

No migration 018 was added. Existing KS-07 schema already contains:

- `keycore_customers`;
- immutable `keycore_orders.customer_id`;
- `fulfillment_operations.order_id`;
- encrypted fulfillment secret metadata.

## Account Summary

The account summary exposes only:

- `customerId`;
- masked email;
- email verification state;
- creation timestamp.

It does not expose provider subjects, raw email, auth context IDs, session IDs,
session tokens, token hashes or provider credentials.

## Order History

Order history is bounded:

- default limit: `20`;
- maximum limit: `100`;
- deterministic ordering: `createdAt DESC, orderId DESC`;
- opaque HMAC-signed cursor.

Malformed, tampered or cross-customer cursors fail safely with `BAD_REQUEST`.
Explicit invalid limits such as zero, negative, fractional, `NaN`, infinity or
unsafe integers also fail with `BAD_REQUEST` before a repository query runs.
Values greater than `100` are clamped to the documented maximum.
The order history DTO excludes supplier credentials, supplier payloads,
supplier internal errors, product keys, ciphertext, wrapped DEKs, nonces,
authentication tags and delivery capabilities.

Customer-facing order states are projected as:

| Internal State                                                    | Customer State    |
| ----------------------------------------------------------------- | ----------------- |
| Refund succeeded or order refunded                                | `REFUNDED`        |
| Cancelled                                                         | `CANCELLED`       |
| Manual review, ambiguous procurement or fulfillment manual review | `ACTION_REQUIRED` |
| Completed or fulfillment succeeded                                | `COMPLETED`       |
| Procurement succeeded and fulfillment pending                     | `READY`           |
| Otherwise                                                         | `PROCESSING`      |

## Order Detail

`getOwnedOrderDetail(principal, orderId)` returns detail only when the order is
owned by the authenticated customer. Wrong-customer, unknown and legacy
unclaimed orders share the same customer-facing `RESOURCE_NOT_AVAILABLE`
semantics.

Authorization follows:

```text
principal.customerId -> keycore_orders.customer_id -> order -> linked fulfillment metadata
```

Knowing an order UUID, fulfillment UUID, external supplier order ID or Kinguin
order ID is never sufficient authorization.

## Key Vault Metadata

KS-08-01 exposes metadata only:

- fulfillment ID;
- key-vault status;
- customer-facing delivery status;
- encrypted-secret presence;
- retrieved timestamp;
- delivered timestamp;
- `keyAccessAvailable`.

It does not expose plaintext, ciphertext, nonce, tag, wrapped key, delivery
capability or master-key details.

`keyAccessAvailable` is true only when:

- the order is owned by the authenticated customer;
- fulfillment is linked to that order;
- `fulfillment.orderId` exactly equals the projected `orderId`;
- retrieval state is `RETRIEVED`;
- fulfillment status is `DELIVERY_PENDING`;
- delivery state is `PENDING`;
- an encrypted secret exists.

The account service never decrypts to calculate metadata and never calls the
delivery port. Future key reveal must still route through the KS-07-05/08
secure delivery pipeline.

KS-08-04 connects this metadata to an explicit customer key access action. The
new application service rechecks order ownership, fulfillment linkage and
eligibility before delegating to the existing KS-07 secure delivery boundary.
It does not add automatic reveal to account reads.

If a defensive domain projection contains fulfillment metadata whose `orderId`
does not match the projected order, account metadata may remain visible but the
key is not reported as available for access.

Customer-facing delivery mapping:

| Fulfillment Metadata                                  | Customer Status   |
| ----------------------------------------------------- | ----------------- |
| Manual review required                                | `ACTION_REQUIRED` |
| Delivered                                             | `DELIVERED`       |
| Retrieved, pending delivery, encrypted secret present | `AVAILABLE`       |
| Pending or in-flight retrieval                        | `PENDING`         |
| Otherwise                                             | `UNAVAILABLE`     |

## Invoice Metadata

Invoice support is metadata-only:

- `NOT_AVAILABLE`;
- `PENDING`;
- `AVAILABLE`;
- `FAILED`.

The account service does not invent invoice numbers, tax content, VAT behavior,
PDFs, storage paths or internal document IDs. Invoice access inherits order
ownership. Production invoice generation remains blocked on the `TAX-INVOICE`
approval gate.

## Activation Instructions

Activation instructions are safe and structured. Known platforms may be
projected only from structured metadata:

- `STEAM`;
- `EPIC`;
- `UBISOFT_CONNECT`;
- `EA_APP`;
- `XBOX`;
- `PLAYSTATION`;
- `OTHER`.

Product title text alone is never treated as authoritative instructions.
Unknown or title-only metadata uses generic safe `NOT_AVAILABLE` behavior.

## Guest And Legacy Orders

Unowned and legacy orders remain inaccessible. KS-08-01 does not claim orders
by email equality, payment email, provider email, supplier data or historical
fulfillment metadata. A future guest claim flow must require explicit verified
ownership proof.

KS-08-02 keeps this rule: verified customer email matching historical order
email is still not enough to claim ownership. Guest claims require trusted
`GuestOrderClaimAuthorityPort` evidence and remain production-not-ready.

The known live fulfillment `fd61be5e-44ea-4914-98ae-c4404dc31779` remains
legacy/unclaimed and must not be decrypted, displayed, delivered, ownership
mutated or delivery-state mutated.

## Audit

Account reads produce safe audit events:

- `CUSTOMER_ACCOUNT_VIEWED`;
- `CUSTOMER_ORDER_HISTORY_VIEWED`;
- `CUSTOMER_ORDER_VIEWED`;
- `CUSTOMER_ORDER_VIEW_DENIED`;
- `CUSTOMER_KEY_VAULT_VIEWED`;
- `CUSTOMER_INVOICE_METADATA_VIEWED`;
- `CUSTOMER_ACTIVATION_INSTRUCTIONS_VIEWED`.

Audit metadata contains safe IDs, reason codes and counts only. It must not
contain product keys, session tokens, delivery capabilities, provider
credentials, ciphertext or decrypted material.

## Transport And Cache Policy

KS-08-03 adds a transport-neutral account API boundary while still leaving
production HTTP and frontend exposure disabled. Future HTTP mappings may use:

- `GET /v1/customer/account`;
- `GET /v1/customer/orders`;
- `GET /v1/customer/orders/{orderId}`.

The transport resolves an opaque session credential through KS-07-07 before it
calls account services. Request-supplied `customerId`, supplier order IDs and
delivery capability fields are rejected rather than treated as authority.

Account responses use private non-cacheable headers, including
`Cache-Control: private, no-store`. Order detail returns safe key-vault metadata
only and never performs automatic key reveal.

See `docs/customer-account-api.md` for the route contract and
`docs/customer-key-access.md` for the explicit key access flow.
`docs/woocommerce-customer-account-integration.md` describes the future
WooCommerce adapter boundary.

## Production Readiness

- REAL LOGIN PROVIDER CONNECTED: NO
- PRODUCTION CUSTOMER ACCOUNT HTTP EXPOSED: NO
- WOOCOMMERCE CONNECTED: NO
- PRODUCTION FRONTEND CONNECTED: NO
- REAL KEY REVEAL ENABLED: NO
- PRODUCTION INVOICE GENERATION READY: NO
- GUEST ORDER CLAIM FLOW READY: NO
