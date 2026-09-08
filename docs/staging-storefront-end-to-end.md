# Staging Storefront End-to-End Journeys

## Scope

This runbook covers only the synthetic staging implementation for UAT-003,
UAT-007 and UAT-009. It authorizes no Human-UAT result, production deployment,
live payment, supplier request or real Product Key.

## Deployment

Use the existing staging environment file kept outside Git:

```bash
docker compose --env-file infra/docker/staging.env -f infra/docker/compose.staging.yaml pull
docker compose --env-file infra/docker/staging.env -f infra/docker/compose.staging.yaml up -d --build postgres redis mail wordpress-db keycore-checkout-bootstrap keycore-storefront keycore-admin-bootstrap keycore-admin wordpress
docker compose --env-file infra/docker/staging.env -f infra/docker/compose.staging.yaml --profile bootstrap run --rm wordpress-bootstrap
```

The environment must retain `KEYCORE_ENV=STAGING`, mock supplier mode, Stripe
test mode, disabled live Kinguin flags, capture-only mail, disabled Operations
Authority and isolated staging resource identities. The guest fixture address
is `guest-checkout@example.test`. Mailpit remains loopback-bound.

## UAT-003 Guest Checkout

1. Open the staging Shop in a private logged-out browser.
2. Select one synthetic product, add quantity one and proceed to checkout.
3. Use `guest-checkout@example.test` and synthetic address data.
4. Choose `Synthetische Zahlung (Erfolg)` and submit once.
5. Confirm the German result says that no Product Key is displayed, an account
   with the exact checkout email is required, and the one-time purchase code
   was sent to the staging mailbox.
6. Open Mailpit through its approved operator-only loopback access. Do not put
   the displayed claim code in screenshots, chat, shell history or evidence.

PostgreSQL must show a captured order with `customer_id IS NULL`, one active
hash-only claim challenge and no fulfillment secret. A Mailpit delivery failure
leaves the paid order unowned and revokes the undelivered challenge.

## UAT-007 Delayed Fulfillment

1. Complete a registered synthetic success checkout and open the resulting
   purchase as its owning customer.
2. Capture the pending state without private URLs, sessions or identifiers.
3. Sign in separately to the staging Admin as an authorized `PROJECT_OWNER` or
   `OPERATIONS` user.
4. Open the matching order. If and only if all durable eligibility gates pass,
   the `Synthetische Auslieferung bestätigen` action is visible.
5. Submit the action once. It requires the active Admin session, exact origin,
   CSRF token, `SENSITIVE_OPERATION` and the fixed confirmation value.
6. Refresh the customer purchase. Confirm the ready/completed state and inspect
   the status-only Mailpit notification without recording sensitive material.

The action performs no supplier network request. It serializes concurrent
attempts, uses the existing order transitions, stores one AES-256-GCM encrypted
synthetic secret and returns an idempotent result on replay. A failed Mailpit
acceptance rolls back the transition.

## UAT-009 Failure And Cancellation

1. Start a fresh registered synthetic checkout.
2. Select `Synthetische Zahlung (Fehler)` and submit once.
3. Confirm the stable German failure panel, the explicit no-fulfillment/no-key
   statement and the link back to the cart. Refresh the result.
4. Repeat separately with `Synthetische Zahlung (Abbruch)` if cancellation
   regression evidence is required.
5. A retry starts from the cart as a new WooCommerce order and idempotency root.

The original KeyCore payment remains terminal `FAILED` or `CANCELLED` with
procurement and fulfillment `NOT_STARTED`. No Guest Claim, notification or
encrypted fulfillment material may exist.

## Rollback

Stop the changed application containers and redeploy the previously reviewed
image revision. Do not delete PostgreSQL or WordPress volumes as an ordinary
rollback step. Existing terminal payment attempts and consumed claim
challenges must not be rewritten. A destructive synthetic staging reset remains
the separate documented volume-reset procedure.
