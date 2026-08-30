# Secure Customer Key Reveal

## Browser Flow

`Meine Käufe -> Kaufdetails -> Key anzeigen` is the only reveal path. Ordinary
GET responses, HTML before the action, invoices, WooCommerce metadata and
purchase lists contain no plaintext.

The reveal action requires all of the following:

- authenticated WordPress session;
- immutable WordPress-to-KeyCore mapping accepted by the bridge;
- exact KeyCore order ownership;
- a fulfillment marked available by the account projection;
- WordPress nonce validation;
- exact browser same-origin validation;
- signed CSRF result and fresh HMAC adapter request;
- per-customer/order rate limit;
- existing vault authorization immediately before decryption.

The bridge accepts only runtime fixtures beginning `SYNTHETIC_` and refuses to
start outside STAGING. `ProductKeyVaultService` provides AAD-authenticated
encryption, authorization-before-decryption and safe `KEY_REVEALED`/
`KEY_ACCESS_DENIED` audit events. Audit metadata contains record, actor,
OrderLine and reason identifiers, never plaintext.

Reveal responses use `Cache-Control: no-store`, `Pragma: no-cache`,
`Referrer-Policy: no-referrer` and `nosniff`. The key is not placed in a URL,
redirect, email, invoice, log, artifact or WooCommerce field. Evidence capture
must redact the revealed element completely.

Production reveal, real supplier retrieval and a distributed rate limiter are
not enabled by this work.
