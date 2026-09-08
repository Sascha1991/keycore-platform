# Phase 12 End-to-End Storefront Integration Report

## Status

Implementation complete for technical review. UAT-007 is technically
executable after staging deployment, but remains human `PENDING`. UAT-003 and
UAT-009 passed hosted Human-UAT. The authoritative Human-UAT total is 10 of 18
`PASS`. KS-11-07 remains
incomplete, Human Approval remains `NOT_APPROVED`, and `SECURITY-READINESS`
remains `NOT_APPROVED`.

## Implementation

- Added an exact conditional `ACCOUNT`/`GUEST` checkout command. Anonymous
  bridge access is limited to the CSRF-verified signed Guest Checkout route.
- Guest success creates a captured unowned order, issues a fresh high-entropy
  claim through the existing service, persists only its hash and sends the raw
  value solely to internal Mailpit.
- Added stable German WooCommerce failure, cancellation and guest confirmation
  content with safe cart/account guidance and no secret-bearing output.
- Added a POST-only Admin delayed-fulfillment action guarded by session,
  capability, exact origin, CSRF, fixed confirmation and full staging preflight.
- The delayed transition uses existing order services, PostgreSQL advisory
  locking, deterministic fulfillment identity, AES-256-GCM encryption and a
  status-only Mailpit notification. It performs no supplier network request.
- Updated Mailpit to 1.30.6 because the newly used Send API requires a supported
  bounded implementation. No npm dependency or database migration was added.

## Security And Limitations

All recipients are restricted to `example.test`, Mailpit uses only the internal
Compose address, and its UI remains loopback-bound. Claim values and synthetic
secret plaintext are absent from bridge responses, WordPress metadata, Admin
HTML, readiness mail, audit metadata and test snapshots. Live Stripe and
Kinguin controls remain disabled.

The dynamically encrypted delayed-fulfillment material is intentionally not
automatically revealed or emailed. Owner-authorized reveal remains a separate
explicit boundary. Mailpit acceptance is part of the same database transaction,
so a definite notification failure rolls the synthetic transition back; an
unknown response after Mailpit accepted a message remains an operator-visible
staging-only reconciliation risk. UAT-016 registration and verification remain
outside this block.

## Verification

Focused browser, Admin, Mailpit, WordPress and PostgreSQL coverage verifies the
three journeys, exact schemas, denial paths, terminal payment invariants,
hash-only claims, encrypted-at-rest fulfillment, concurrent idempotency and
secret omission.

- `npm run check`: passed; 89 files and 954 tests passed; secret scan passed.
- Focused Browser/Admin/Mailpit tests: 29 passed.
- Focused PostgreSQL staging checkout/fulfillment tests: 7 passed against
  PostgreSQL 16, including delivery-failure revocation and concurrent replay.
- `npm run e2e:acceptance`: 16 passed.
- `npm run security:assessment`: 60 passed, 345 intentionally skipped by the
  focused assessment configuration.
- PHP 8.3 syntax and WordPress adapter tests: passed.
- Staging Compose rendering and UAT structure validation: passed.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- `git diff --check`: passed.

## UAT-009 Browser Correction

Hosted Human-UAT exposed that WooCommerce 11 renders failed and cancelled
orders through its Order Confirmation Status block before the gateway-specific
Additional Information hook. The adapter now uses the block's supported title
and text filters for verified synthetic terminal orders, suppresses the generic
failed-payment actions on that marked result, and retains the existing hook as
a non-block fallback. Payment, procurement, fulfillment and claim semantics are
unchanged. UAT-009 remained human `PENDING` until the corrected browser flow
was redeployed and retested.

The first hosted retest confirmed the deterministic failure content and refresh
stability but exposed that the CSS action guard targeted the classic checkout
wrapper rather than the active Order Confirmation Block wrapper. The follow-up
uses the dynamic block render filter to mark WooCommerce's same-order payment
action hidden and inaccessible only for a validated synthetic terminal order;
the corrected block-scoped selector is defense in depth. The approved fresh
`Zurueck zum Warenkorb` path remains visible. The product owner subsequently
confirmed both terminal browser paths, refresh stability and the corresponding
fail-closed database states and accepted UAT-009 on 2026-09-08.

## UAT-003 Human Acceptance

The product owner completed the logged-out guest checkout on hosted staging
using `Neonpfad: Berlin`, quantity one, the dedicated synthetic guest address
and the synthetic success payment method. The browser confirmed payment,
displayed no Product Key, required a KeyRaNo account with the exact checkout
email and reported private delivery of the one-time purchase code.

PostgreSQL verification showed an unowned `PAYMENT_CAPTURED` order with payment
`CAPTURED`, procurement and fulfillment `NOT_STARTED`, exactly one active
unconsumed claim, and no fulfillment operation or secret. The authorized
Mailpit inbox contained the expected claim message. Its raw code and hash are
intentionally absent from this record.

The initial empty Mailpit view was traced to local Windows port `18025` being
owned by Docker Desktop. A new SSH tunnel on local port `28025` reached hosted
staging port `18025` and exposed the already delivered message. Hosted Mailpit
and the storefront had not restarted, and the internal Mailpit API remained
reachable. This was an operator endpoint collision, not an application or
deployment defect; no remediation was required.
