# Human UAT Record - 2026-09-08 - Guest Checkout

## Recorded Result

The KeyRaNo product owner completed UAT-003 on hosted staging using only the
synthetic storefront, customer data and payment method. This record preserves
the supplied browser, PostgreSQL and private-mail observations without
recording the one-time purchase code, its hash, an order identifier,
credentials, Product Keys or other sensitive material.

## Guest Checkout

The reviewer used a logged-out private browser session to buy quantity one of
`Neonpfad: Berlin` with `guest-checkout@example.test` and `Synthetische Zahlung
(Erfolg)`. Checkout completed successfully. The browser confirmation stated:

- `Die synthetische Zahlung wurde bestätigt. Ein Produktschlüssel wird hier
nicht angezeigt.`;
- `Für den Zugriff ist ein KeyRaNo-Konto mit exakt derselben E-Mail-Adresse wie
beim Checkout erforderlich.`; and
- `Der einmalige Kauf-Code wurde an die Staging-Mailbox gesendet.`

No Product Key was exposed in the browser.

## Durable State

Read-only PostgreSQL verification of the latest dedicated guest-checkout order
showed:

- ownership remained absent;
- order status `PAYMENT_CAPTURED` and payment status `CAPTURED`;
- procurement and fulfillment both `NOT_STARTED`;
- exactly one active, unconsumed and non-revoked claim challenge; and
- zero fulfillment operations and zero fulfillment secrets.

The claim remains unconsumed and was not revoked. Its raw value and stored hash
were not captured or recorded.

## Private Mail Delivery

The authorized hosted-staging Mailpit inbox contained one message to the
dedicated synthetic guest address with subject
`Dein KeyRaNo Kauf kann hinzugefügt werden`. The reviewer confirmed that it
reported the synthetic payment, required a KeyRaNo account with exactly the
checkout email, visibly contained one time-bounded purchase code and explicitly
said that the code was not a Product Key. The code itself is intentionally
omitted from all evidence.

The initially inspected empty mailbox was a local endpoint mismatch. Windows
port `18025` belonged to Docker Desktop, so the browser was showing a local
Docker-managed service rather than hosted staging. A new SSH tunnel from local
port `28025` to hosted loopback port `18025` reached the correct inbox and the
already delivered message. Hosted Mailpit and the storefront were healthy,
had restart count zero, used the intended internal `http://mail:8025` endpoint
and returned HTTP 200. No application or deployment defect existed, and no
remediation was required.

Result: `PASS`.

## Gate Boundaries

- Human `PASS` results: 10 of 18.
- KS-11-07: incomplete; eight scenarios remain pending or not executable.
- Human acceptance: `IN_REVIEW`.
- Human approval: `NOT_APPROVED`.
- `SECURITY-READINESS`: `NOT_APPROVED`.
- Production approval: not granted.
- No live payment, supplier purchase, real Product Key, production credential
  or production deployment was used.

The review date is normalized to `2026-09-08T00:00:00Z` in the machine-readable
results.
