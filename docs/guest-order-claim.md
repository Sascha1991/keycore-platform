# Guest Order Claim

KS-08-05 establishes the secure foundation for KeyRaNo guest order claiming. It
does not expose production HTTP, connect production email, install WooCommerce,
implement passwords or reveal real Product Keys.

## Claim Credential

The customer-facing credential is the Kaufcode. The default raw credential is
32 random bytes encoded as base64url. PostgreSQL stores only a SHA-256 hash.

Claim challenges are bound to:

- exact KeyCore order ID;
- purchase-time `checkout_email_normalized` snapshot;
- purpose `GUEST_ORDER_CLAIM`;
- creation/version context;
- explicit expiry.

Default TTL is seven days (`604800000` ms). Expired, consumed, revoked,
unknown, mismatched and wrong-email claims collapse to safe invalid semantics at
public boundaries.

## Issuance

Only trusted post-order/checkout orchestration may issue a claim credential.
Unauthenticated callers cannot generate claim codes by knowing an order ID.

Issuance:

```text
trusted order evidence
-> unclaimed KeyCore order
-> existing purchase-time checkout email snapshot
-> persist hash-only claim challenge
-> send fake/local claim email in this task
```

Reissue revokes older active challenges for the same order and purpose. If
delivery of the replacement email definitively fails or throws, the newly
persisted challenge is revoked and remains unusable.

Claim issuance must not backfill legacy orders. Orders with no persisted
checkout email snapshot remain unclaimable until a future approved support flow
defines separate evidence. The normal trusted path writes the snapshot at order
creation/checkout time, not during later claim issuance.

## Verification

Claim verification requires authenticated verified customer context plus the
claim code. The code may resolve the order by itself; an optional order
reference is context only and not authority.

Verification consumes the active challenge, verifies the current verified
customer email equals the checkout snapshot, then delegates ownership mutation
to the existing `OrderOwnershipBindingAuthorityPort` path through
`CustomerRegistrationService.claimGuestOrder()`.

Ten concurrent claims with the same active token can produce at most one
ownership bind. With the persisted authority, replay after consumption is denied
and cannot deliver a key.

## Email Contract

Future claim email subject:

```text
Deinen KeyRaNo-Kauf zum Konto hinzufuegen
```

Required German message:

```text
Wichtig: Erstelle dein KeyRaNo-Konto mit derselben E-Mail-Adresse, die du bei deiner Bestellung angegeben hast. Nur so koennen wir deinen Kauf sicher deinem Konto zuordnen.
```

The email may contain KeyRaNo branding, order-safe metadata, account-required
instructions, the Kaufcode or a secure claim link. It must not contain Product
Keys, encrypted secret material, delivery capability, session token, supplier
order IDs where unnecessary or payment credentials.

This is an ownership-claim email, not Product Key delivery and not a promise
that procurement or fulfillment has completed unless a future flow explicitly
issues it only after fulfillment readiness.

Future UX:

```text
Meine Kaeufe -> Kauf hinzufuegen -> Kaufcode eingeben
```

The UI never decides claim success. KeyCore decides.

## Safe Inspect

Safe claim inspection may show order ID, ownership state, whether a checkout
email snapshot exists, active claim count, last claim creation timestamp and
state summary. It must not show raw checkout email, raw claim code, token hash,
Product Key, ciphertext, session token or delivery capability.

## Production Status

- REAL LOGIN PROVIDER CONNECTED: NO
- PRODUCTION PASSWORD/ACCOUNT UI CONNECTED: NO
- PRODUCTION CUSTOMER ACCOUNT API EXPOSED: NO
- PRODUCTION GUEST CLAIM EMAIL CONNECTED: NO
- PRODUCTION GUEST CLAIM HTTP EXPOSED: NO
- WOOCOMMERCE CONNECTED: NO
- PRODUCTION FRONTEND CONNECTED: NO
- PRODUCTION DISTRIBUTED RATE LIMITER READY: NO
- REAL KEY REVEAL ENABLED: NO
