# PHASE_12_ACCOUNT_TRANSPORT

Risk: CRITICAL

Human approval: Required. Automated implementation made the Guest Claim path
executable without approving any gate. The product owner subsequently accepted
UAT-015 and UAT-018; KS-11-07, `SECURITY-READINESS` and production release
remain unapproved.

## Objective

Compose the existing one-time, verified-same-email Guest Claim service behind
the authenticated KeyRaNo `Mein Konto -> Kauf hinzufügen` staging surface.
WordPress remains a presentation/integration shell and KeyCore remains the
authority for identity, claim consumption and ownership.

## Scope

- Add an exact-schema HMAC-authenticated and CSRF-protected staging claim route.
- Reuse `CustomerRegistrationService`, `PersistedGuestOrderClaimAuthority` and
  PostgreSQL customer, claim, ownership and audit repositories.
- Add a minimal German password-style claim-code form and safe result states.
- Seed one deterministic synthetic unowned order and hash-only claim challenge.
- Preserve claimed ownership across sessions and idempotent bootstrap runs.
- Make the remaining Guest Claim steps of UAT-015 executable for human review.

## Forbidden Scope

- A second Guest Claim business implementation or weaker ownership rule.
- Browser-supplied authoritative customer, order, payment or fulfillment state.
- Raw claim-code persistence, logging, response reflection or screenshots.
- Product Key handling, live Stripe/Kinguin, production data or deployment.
- Invoice, fulfillment, guest checkout, registration or production identity.
- Agent approval of any human gate or merge of PR #47/the stacked PR.

## Acceptance Criteria

- [x] Only an authenticated mapped verified customer can reach the claim service.
- [x] Claim requests require a valid WordPress nonce, same origin, HMAC and exact
      `{ "claimCode": string }` schema; unknown fields fail closed.
- [x] Existing same-email, one-time, replay, cross-owner and ownership-binding
      rules remain authoritative in KeyCore/PostgreSQL.
- [x] Invalid, wrong-user, replayed and already-unavailable claims return the
      same enumeration-resistant public failure.
- [x] Backend outage returns temporary unavailability without partial browser
      success or raw exception disclosure.
- [x] The synthetic claim code is supplied only through staging environment
      configuration and only its SHA-256 hash is persisted.
- [x] Repeated bootstrap never reactivates a consumed challenge or changes an
      existing owner; fixture identity conflicts fail closed.
- [x] A successful claim appears in the owner's account and remains absent from
      another customer's list/detail access in later sessions.
- [x] No Product Key, claim secret, HMAC/session secret or production data is
      exposed or committed.
- [x] Implementation did not infer human acceptance; the later product-owner
      results for UAT-015 and UAT-018 are recorded separately.
- [x] UAT-002 remains `PASS`; KS-11-07 and `SECURITY-READINESS` remain unapproved.

## Rollback

Revert the WordPress claim hooks/templates, bridge route, claim composition and
synthetic fixture additions together. Existing Guest Claim tables and domain
services are unchanged. A staging reset may delete and recreate only the
isolated staging volumes after confirming the environment identity.

## Human Gate

The product owner was required to execute UAT-015 through the approved staging
channel. The supplied `PASS` is recorded separately without claim codes,
cookies, HMAC values, customer email addresses or private identifiers.
