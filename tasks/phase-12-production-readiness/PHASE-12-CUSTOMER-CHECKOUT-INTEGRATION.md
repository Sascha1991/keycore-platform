# PHASE_12_CUSTOMER_CHECKOUT_INTEGRATION

Risk: CRITICAL

Human approval: Review, screenshots and Human-UAT are required. This task does
not approve KS-11-07, `SECURITY-READINESS` or production release.

## Objective

Compose the existing KeyRaNo WooCommerce staging storefront with KeyCore's
Phase-07 PriceLock, order, payment-idempotency and customer-ownership
foundations. A registered synthetic customer can complete a production-shaped
browser checkout and see the resulting KeyCore-owned purchase without any live
payment, supplier purchase, fulfillment or Product Key.

## Scope

- Provide native WooCommerce staging-only synthetic payment methods with
  explicit success, failure and cancellation outcomes.
- Submit a bounded, HMAC-authenticated checkout command from WooCommerce to the
  existing staging bridge.
- Resolve product, price, currency and customer email from server-controlled
  synthetic staging configuration.
- Persist PriceLock, KeyCore order, payment record, external-event receipt,
  ownership binding, history, outbox and safe audit evidence in PostgreSQL.
- Reuse Phase-07 order/payment idempotency and fail closed on conflicting,
  stale, malformed or ambiguous state.
- Project the resulting owned purchase through the existing KeyCore customer
  account boundary.
- Keep WordPress/WooCommerce as presentation and integration shell only.
- Document the WordPress/Site Editor presentation-ownership boundary.

## Forbidden Scope

- Live Stripe credentials, calls, PaymentIntents or charges.
- Kinguin or any other supplier mutation.
- Procurement, fulfillment, invoice issuance, email delivery or refunds.
- Real Product Keys or key plaintext in WordPress, PostgreSQL, logs, audit,
  order metadata or ordinary responses.
- Guest Claim and invoice-document transport.
- Production deployment, Phase-12 release work or approval changes.
- Elementor or another page-builder dependency.

## Acceptance Criteria

- [x] A successful synthetic checkout creates exactly one authoritative
      KeyCore order and one payment record.
- [x] The resulting order is bound only to the authenticated mapped customer
      and appears in that customer's account.
- [x] Repeated or concurrent submission with the same checkout token returns
      the same logical order and cannot duplicate payment capture.
- [x] Product reference, amount, currency, quantity, timestamp, identity and
      request-signature mismatches fail closed.
- [x] Synthetic failure and cancellation never produce captured payment,
      procurement or fulfillment state.
- [x] Cross-owner list and direct-detail access remain unavailable.
- [x] Confirmation, account, WordPress metadata, logs, audit and ordinary
      bridge responses contain no Product Key plaintext.
- [x] PostgreSQL outage or migration/fixture mismatch disables checkout.
- [x] The migration baseline remains `027`; synthetic checkout fixtures are
      idempotent and staging-only.
- [x] Header, footer, navigation, global styling, typography, page content and
      general layout remain editable through native WordPress/WooCommerce
      mechanisms without changing KeyCore security code.
- [x] UAT-002 remained `PENDING` until its successful human execution on
      2026-08-31; UAT-015 and UAT-018 remain `PENDING`.
- [x] KS-11-07 and `SECURITY-READINESS` remain unapproved.

## Required Tests

- Successful checkout and resulting account visibility.
- Duplicate and concurrent replay idempotency.
- Malformed, tampered, stale and cross-identity denial.
- Payment failure and cancellation.
- Cross-owner isolation and pre-fulfillment key omission.
- PostgreSQL durability, history/outbox/payment uniqueness and zero key rows.
- WordPress gateway, signed bridge and safe metadata tests.
- Existing storefront, account and reveal regressions.
- Repository checks, audit, secret scan and diff check.

## Human Gates

Codex and CI provide supporting evidence only. The product owner completed and
accepted UAT-002 on 2026-08-31; no agent or CI inferred that result. UAT-015
still depends on `PHASE_12_ACCOUNT_TRANSPORT`; UAT-018 also depends on Guest
Claim, composed fulfillment and invoice-document transport. Production requires
the independent approval gates defined by ADR-0010.
