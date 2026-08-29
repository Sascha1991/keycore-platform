# KS-11-02: End-to-End Acceptance Suite

## Objective

Provide deterministic, release-blocking automated acceptance coverage for the
critical KeyRaNo purchase journeys at the highest implemented application and
persistence boundaries, without production side effects.

## Scope

- Stable scenarios E2E-001 through E2E-015 for success, guest claim, delay,
  supplier and payment failure, supplier ambiguity, fraud, refund, support,
  replay, emergency controls, email safety, invoice access and leakage.
- Existing application services and authority ports driven by synthetic test
  adapters.
- A supplemental coherent cross-aggregate journey against an isolated real
  PostgreSQL service and migrations through 026.
- Safe machine-readable and human-readable CI evidence.

Browser storefront UAT, catalog scale, concurrency campaigns, security
assessment and recovery exercises are explicitly outside this task.

## Acceptance Criteria

- [x] All required stable E2E scenario IDs are implemented.
- [x] Success, delay, failure, refund and support are visibly represented.
- [x] Payment success, failure and replay use `StripePaymentService` with a
      deterministic local provider and verified synthetic webhooks.
- [x] Fraud review and denial use the real fraud policy service and trusted
      authority boundary.
- [x] Guest claim requires a verified matching account and one-time claim code;
      only the code hash is persisted.
- [x] Product-key material is unmistakably synthetic and enters only the real
      encryption boundary.
- [x] Emergency-control denial is covered for every required capability and
      checkout denial is composed with real order orchestration.
- [x] A real PostgreSQL integration scenario verifies coherent PriceLock,
      order, ownership, support, history and outbox persistence.
- [x] Generated evidence is omission-first and rejects protected or sensitive
      material before writing JSON and Markdown artifacts.
- [x] GitHub Actions runs the suite with isolated PostgreSQL and archives the
      safe evidence for 14 days.
- [x] No migration, production credential, production data, live Stripe call,
      Kinguin request, real email or real Product Key is required.
- [x] Documentation identifies implemented boundaries and remaining gaps.
- [ ] Independent review and merge are complete.

## Human Gates

This task does not approve `SECURITY-READINESS`, human UAT, tax/invoice
correctness or production deployment. KS-11-03 through KS-11-07 remain open.
