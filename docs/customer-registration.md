# Customer Registration

KS-08-02 adds the transport-neutral customer registration, email verification
challenge, external identity linking and guest-order claim foundation. It does
not add password authentication, OAuth login, WooCommerce login, production
email delivery, frontend UI, automatic login, account merging, email-only order
claiming, Kinguin retrieval/purchase or live Stripe mutation.

## Registration Trust Boundary

Registration accepts an email address only as contact metadata. The email is
normalized through the same KS-07-06 policy used by customer identity
persistence: trim the address and lowercase the domain only. There is no Gmail
dot stripping, plus stripping or provider-specific canonicalization.

Normal registration always creates or reuses a customer with
`emailVerificationState = UNVERIFIED`. Untrusted registration input cannot set
`VERIFIED`, cannot create an authenticated principal and cannot create a
session.

The public registration result is enumeration-safe:

```text
REGISTRATION_ACCEPTED
```

is returned for both new and existing normalized emails. The public result does
not expose customer ID, existing-account status, verification state, provider
bindings or order ownership.

## Verification Challenge

Each accepted registration issues an email verification challenge:

- 32 random bytes encoded as base64url, giving at least 256 bits of entropy;
- SHA-256 hash persisted in PostgreSQL;
- raw token returned only to the immediate outbound delivery port;
- purpose-bound to `EMAIL_VERIFICATION`;
- customer-bound;
- normalized-email-snapshot-bound;
- short-lived, default TTL `900000` ms;
- single-use.

Runtime configuration:

```text
KEYCORE_CUSTOMER_EMAIL_VERIFICATION_TTL_MS=900000
```

Invalid TTL configuration fails closed.

## Delivery

KS-08-02 includes only `FakeCustomerEmailVerificationDeliveryPort` for tests
and local composition. No production mail provider is connected. A future email
adapter must not log or persist the raw token, token hash, mailbox token URLs or
provider credentials.

If delivery returns `FAILED` or throws after the challenge has been persisted,
the registration service revokes the newly generated challenge and returns a
safe `DELIVERY_FAILED` result. The undelivered token must not remain usable. If
revocation itself fails, the request still fails closed and the token is not
treated as successfully issued; operations must investigate the ambiguous
challenge state before production use.

If a future link transport is used:

- HTTPS is required;
- `Cache-Control: no-store` is required;
- `Referrer-Policy: no-referrer` is required;
- third-party analytics/resources must not receive token-bearing URLs;
- the token must be consumed immediately;
- the token must not be stored client-side.

## Verification

Email verification hashes the raw token, loads an active challenge, verifies it
is unexpired and unconsumed, verifies the customer still exists, verifies the
current normalized customer email still matches the challenge snapshot, consumes
the challenge atomically, then uses `EmailVerificationAuthorityPort` through
`CustomerOrderIdentityService.markEmailVerified`.

Failures collapse to the stable public result:

```text
VERIFICATION_INVALID
```

This covers unknown token, malformed token, expired token, consumed token,
revoked token, customer mismatch and email snapshot mismatch.

## Reissue And Concurrency

New challenge creation revokes older active challenges for the same customer,
purpose and normalized email snapshot. This single-active policy reduces replay
surface.

If a replacement challenge is persisted but delivery fails, the replacement is
revoked too. Older challenges are not re-enabled; the customer must request a
fresh challenge.

PostgreSQL uses a transaction, an advisory lock for reissue, unique token hash
storage, and `FOR UPDATE SKIP LOCKED` during consume. Ten concurrent consumes
of the same token can produce at most one `VERIFIED` result.

Challenge consumption commits before the trusted customer verification
transition. If that later transition fails because of a transient stale writer
or similar internal failure, the already-consumed token remains invalid and the
customer must request a new challenge.

## Rate Limiting

`CustomerRegistrationRateLimitPort` protects registration attempts using hashed
limiter identities such as normalized email hash and optional IP hash. The
local in-memory implementation is suitable only for tests/local development.
Production distributed rate limiting is not ready; production composition must
fail closed rather than silently bypass abuse protection.

## External Identity Linking

External identity linking is an authenticated account operation. Preconditions:

- current `AuthenticatedCustomerPrincipal`;
- assurance `AUTHENTICATED`;
- persisted customer exists;
- customer email is `VERIFIED`;
- trusted `CustomerIdentityBindingAuthorityPort` evidence;
- provider subject is not already bound to another customer.

The service never binds from request-supplied provider subject and never binds
because a provider email equals the customer email. If the provider/subject is
already bound to a different customer, linking returns `IDENTITY_CONFLICT`. No
automatic transfer, merge or reassignment occurs.

## Account Merge Policy

Account merge is not implemented. Same email, same provider email, same name,
same payment email or similar profile data must not merge customers. A future
manual account-merge workflow is required if the platform later needs it.

## Guest Order Claim Foundation

`GuestOrderClaimAuthorityPort` represents future trusted claim evidence. The
default authority fails closed. A future trusted adapter may use evidence such
as:

- one-time order claim secret generated at checkout;
- authenticated payment-provider verified context;
- signed WooCommerce order claim token;
- secure claim link issued at order creation.

Normalized order email equal to verified customer email is not sufficient to
claim an order. Existing ownership is immutable: same customer retries are
idempotent, different customer attempts conflict, and no overwrite occurs.

The known live fulfillment `fd61be5e-44ea-4914-98ae-c4404dc31779` remains
legacy/unclaimed. KS-08-02 does not generate retroactive claim evidence and does
not bind it to any customer.

## Audit

Safe audit events include:

- `CUSTOMER_REGISTRATION_REQUESTED`;
- `CUSTOMER_EMAIL_VERIFICATION_ISSUED`;
- `CUSTOMER_EMAIL_VERIFIED`;
- `CUSTOMER_EMAIL_VERIFICATION_FAILED`;
- `CUSTOMER_IDENTITY_LINKED`;
- `CUSTOMER_IDENTITY_LINK_DENIED`;
- `CUSTOMER_ORDER_CLAIM_DENIED`;
- `CUSTOMER_ORDER_CLAIMED` for synthetic/future trusted evidence only.

Audit metadata uses customer IDs, challenge IDs, provider names and safe reason
codes. It must not include raw tokens, token hashes, raw emails when customer ID
is sufficient, provider subjects, bearer tokens, session tokens, product keys,
ciphertext or decrypted material.

## Safe Inspect

DB-only inspection:

```sh
npm run customer-registration:inspect -- <customerId>
```

The command returns customer ID, verification state, active challenge count,
last challenge creation timestamp and identity binding count. Active challenge
count means unconsumed, unrevoked and unexpired at inspection time. It does not
print raw email, raw verification token, token hash, provider subject, session
token, product key or order/customer secret material.

## Production Readiness

KS-08-03 adds transport-neutral handlers for registration request, email
verification and identity linking. They are not production HTTP endpoints.
Registration remains enumeration-safe, verification tokens are POST secret
input and are not echoed, and identity linking rejects browser-supplied
`providerSubject` fields. Authenticated identity-link mutations require session
resolution, Origin validation and CSRF protection.

- REAL LOGIN PROVIDER CONNECTED: NO
- PRODUCTION EMAIL VERIFICATION DELIVERY CONNECTED: NO
- PRODUCTION REGISTRATION HTTP EXPOSED: NO
- PRODUCTION FRONTEND CONNECTED: NO
- PRODUCTION DISTRIBUTED RATE LIMITER READY: NO
- GUEST ORDER CLAIM FLOW READY: NO
