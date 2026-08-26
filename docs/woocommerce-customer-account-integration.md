# WooCommerce Customer Account Integration

KS-08-03 documents the future WooCommerce/Keyrano account integration boundary.
It does not install WordPress, add WooCommerce dependencies, build a frontend or
expose a production API.

## Ownership Boundary

WooCommerce may own:

- storefront rendering;
- WooCommerce user/session UX;
- cart and product presentation;
- checkout handoff shell;
- future signed adapter assertions after review.

KeyCore owns:

- customer IDs;
- verified email state;
- identity bindings;
- order ownership;
- key-vault metadata;
- delivery authorization;
- secure key reveal workflow;
- account order history/detail source of truth.

WooCommerce is an adapter/client. It is never authoritative for protected
KeyCore customer account data.

## Trust Boundary

WooCommerce user ID, billing email, account email, order email or matching
profile data must not automatically:

- authenticate a KeyCore customer;
- bind a KeyCore external identity;
- claim a guest or legacy order;
- authorize account reads;
- authorize key reveal.

Email-only linking is denied. A future WooCommerce bridge must provide a signed
and verified provider assertion to a trusted KeyCore authority port. That
assertion must be validated server-side and must not be accepted directly from
browser request fields.

## Customer Account Rendering

A future adapter may render the Keyrano account area by calling the
transport-neutral handlers:

- account summary;
- owned order history;
- owned order detail;
- registration request;
- email verification;
- identity linking.

The adapter must pass only an extracted session credential and request metadata.
It must not pass caller-selected `customerId` as authorization input.

## Order History Source

Order history must come from the KeyCore customer account read model scoped by
`AuthenticatedCustomerPrincipal.customerId`. WooCommerce order records are not
used as the source of truth for KeyCore ownership.

Unknown, wrong-owner and legacy/unclaimed orders remain indistinguishable at the
customer boundary.

## Key Reveal Flow

Account order detail may show safe metadata and `keyAccessAvailable=true`.
Actual reveal remains a separate explicit customer action:

```text
account order detail
-> explicit customer reveal action
-> secure delivery capability
-> KS-07-08 authenticated delivery transport
```

Order detail must not decrypt or reveal automatically.

## Registration Flow

Registration uses enumeration-safe public responses. Existing and new emails
receive the same public success. Verification uses a secret one-time token and
does not create a session automatically.

## Future Signed Provider Assertion

A future WooCommerce adapter may implement trusted evidence that binds a
WooCommerce identity to a KeyCore customer. The browser request body must not
contain arbitrary `providerSubject` as proof. The adapter evidence must be
issued by server-side trusted integration code and consumed through
`CustomerIdentityBindingAuthorityPort`.

## Production Status

- WORDPRESS INSTALLED BY KS-08-03: NO
- WOOCOMMERCE DEPENDENCY ADDED BY KS-08-03: NO
- PRODUCTION CUSTOMER ACCOUNT API EXPOSED: NO
- EMAIL-ONLY ACCOUNT LINKING ALLOWED: NO
- REAL KEY REVEAL ENABLED: NO
