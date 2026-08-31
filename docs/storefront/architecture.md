# KeyRaNo Storefront Architecture

## Boundary

WooCommerce renders; KeyCore authorizes. The WordPress plugin is a presentation
adapter and never treats a WooCommerce user ID, email address, URL order ID or
order metadata as proof of ownership.

The staging flow is:

1. WordPress authenticates the browser session and reads an immutable
   `_keyrano_customer_id` mapping installed by the controlled staging bootstrap.
2. `Bridge_Client` signs method, path, configured origin, WordPress user ID,
   mapped CustomerId, CSRF result and body hash with the staging-only bridge
   secret.
3. The Node bridge verifies freshness, exact origin, signature and the
   independently configured WordPress-to-Customer mapping.
4. Existing `CustomerAccountService` owner-filters reads. Existing
   `ProductKeyVaultService` performs authorization before authenticated
   decryption.
5. The response signature is bound to the exact fresh request signature before
   WordPress renders the safe view model.

PHP never queries KeyCore PostgreSQL, decrypts Product Keys, evaluates Germany
eligibility, decides ownership or stores Product Key plaintext. The bridge is a
staging-only process and refuses production startup.

## Trust Model

- The browser session alone is insufficient; the signed adapter mapping must
  match KeyCore's configured mapping.
- Account resource mismatches return the same unavailable result.
- Catalog publication consumes only a signed `PUBLISHABLE` manifest.
- Reveal is a separate POST with a WordPress nonce, exact same-origin check,
  signed CSRF result, bounded rate limit and vault audit.
- Responses are HMAC-signed and rejected by WordPress when modified.
- Key material exists only in the encrypted in-memory staging vault and the
  authorized reveal response. It is never WooCommerce state.

This is an intentionally narrow staging composition. Production identity,
distributed rate limiting, durable customer projections and production HTTP
deployment remain separate readiness work.
