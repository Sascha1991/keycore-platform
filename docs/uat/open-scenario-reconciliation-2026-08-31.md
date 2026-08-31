# Open Human-UAT Scenario Reconciliation - 2026-08-31

## Scope And Decision

This review reconciles UAT-002, UAT-015 and UAT-018 against the implemented
PRE-UAT visible-storefront boundary. It does not extend that boundary. All three
scenarios remain `PENDING`: their tested subsets are valid, but each full human
scenario still requires a browser integration that PR #46 deliberately does not
provide.

No live Stripe or Kinguin call, supplier purchase, real Product Key, production
credential, production data, production DNS change or deployment was used.
`PRE-UAT-KEY-REAL-01` and Phase 12 were not started. `SECURITY-READINESS` remains
`NOT_APPROVED`.

## UAT-002 - Registered Customer Purchase Journey

Overall status: `PENDING`.

| Acceptance step                                                          | Status    | Evidence and result                                                                                                                                                     |
| ------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in as synthetic customer A and select a synthetic offer             | `PASS`    | Human review on 2026-08-30 covered the storefront, product, cart and mapped account.                                                                                    |
| Complete checkout with a sandbox payment method                          | `GATED`   | WooCommerce exposes only the no-live-payment checkout shell. The PRE-UAT bridge has no payment or order-creation route. Gate: `PHASE_12_CUSTOMER_CHECKOUT_INTEGRATION`. |
| Create exactly one KeyCore order and preserve correct customer ownership | `PENDING` | E2E-001 proves the synthetic application path and E2E-011 proves order/payment replay idempotency, but no browser checkout creates the order under review.              |
| Open the resulting confirmation and account purchase list                | `PENDING` | The prepared owned order is visible, but it is a seed fixture rather than the result of the tested checkout. No resulting confirmation exists.                          |
| Customer B cannot locate or directly access customer A's order           | `PASS`    | Human review received `Dieser Kauf ist nicht verfügbar.` and cross-owner detail/reveal/key access remained blocked.                                                     |
| Ordinary confirmation contains no Product Key                            | `GATED`   | Omission is automated at application boundaries, but a confirmation from the missing browser checkout cannot be human-reviewed.                                         |

Automated evidence was rerun on 2026-08-31 with synthetic data only. E2E-001
and E2E-011 passed, including idempotent order creation, verified synthetic
payment-webhook replay and exact owned-order binding. Automated evidence cannot
replace the missing human browser steps.

## UAT-015 - Account Purchase History

Overall status: `PENDING`.

| Acceptance step                                                       | Status             | Evidence and result                                                                                                                                                                                   |
| --------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in as customer A and open `Meine Käufe`                          | `PASS`             | Human review confirmed customer A can see the owned synthetic READY purchase.                                                                                                                         |
| Compare direct-purchase status and key availability                   | `PASS`             | Human review confirmed no key before explicit reveal and synthetic-only reveal through the dedicated action.                                                                                          |
| Confirm a claimed guest purchase appears                              | `GATED`            | The secure Guest Claim service and repositories exist, but `Kauf hinzufügen` is intentionally a non-mutating shell and the staging bridge exposes no claim route. Gate: `PHASE_12_ACCOUNT_TRANSPORT`. |
| Wrong user, wrong code and replay remain denied                       | `PASS` (automated) | E2E-002 and focused Guest Claim tests passed with synthetic fixtures; no browser claim was fabricated.                                                                                                |
| Customer B's unrelated purchase is absent and direct access is denied | `PASS`             | Human cross-owner review passed; focused ownership and account tests also passed.                                                                                                                     |
| Claimed ownership survives a later session                            | `PENDING`          | PostgreSQL coverage exists in CI, but there is no PRE-UAT browser claim/session flow to execute as a human.                                                                                           |

The backend implementation is not the blocker. The missing component is the
dedicated one-time, verified-same-email browser adapter already named by the
specification. Building it in PR #46 would be scope creep.

## UAT-018 - Complete Acceptance Walkthrough

Overall status: `PENDING`.

| Walkthrough step                                                                    | Status                                                   | Evidence and remaining gate                                                                                     |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Discover and select an eligible synthetic product                                   | `PASS`                                                   | UAT-001 human result.                                                                                           |
| Authenticate as the mapped synthetic customer                                       | `PASS`                                                   | Human account A review. Production identity remains out of scope.                                               |
| Open cart and checkout shell                                                        | `PASS`                                                   | Human review confirmed the shell and absence of a live payment method.                                          |
| Complete sandbox payment                                                            | `GATED`                                                  | `PHASE_12_CUSTOMER_CHECKOUT_INTEGRATION`.                                                                       |
| Create the resulting KeyCore order idempotently                                     | `PENDING`                                                | E2E-001/E2E-011 pass automatically; browser composition is absent.                                              |
| Observe synthetic procurement and encrypted fulfillment for that order              | `PENDING`                                                | E2E-001 passes automatically; the human-visible order is a prepared fixture, not the checkout result.           |
| Review owned purchase history                                                       | `PASS` for direct fixture / `GATED` for claimed purchase | Human direct-purchase review passed; Guest Claim needs `PHASE_12_ACCOUNT_TRANSPORT`.                            |
| Reveal only through the secure owner path                                           | `PASS`                                                   | UAT-006 human result.                                                                                           |
| Review invoice access                                                               | `PENDING`                                                | Owner-filtered metadata exists; real invoice document/provider transport remains `PHASE_12_INVOICE_TRANSPORT`.  |
| Review one coherent ordered evidence set and explicitly accept the complete journey | `PENDING`                                                | Only the visible-storefront subset is accepted; the missing composed steps prevent complete UAT-018 acceptance. |

No required UAT-018 step is `NOT_APPLICABLE`. The gated steps are part of the
normative scenario and therefore cannot be removed merely to produce a pass.

## Executed Technical Evidence

- `npm run e2e:acceptance` with isolated PostgreSQL: 16 passed with no skips.
- Focused staging/storefront/account/ownership/claim/reveal/vault suite: 172
  passed across 13 test files.
- Focused isolated PostgreSQL staging/order/account/ownership/claim/delivery/E2E
  suite: 28 passed across 9 test files.
- `npm run security:assessment`: 36 passed, 366 intentionally filtered or
  PostgreSQL-dependent tests skipped.
- PHP 8.3 syntax checks and the deterministic WordPress adapter test passed in
  an isolated container.

The PostgreSQL checks used a disposable PostgreSQL 16.10 container on a
conflict-free local port with no persistent volume. It was removed after the
run. CI remains the authoritative shared-environment evidence.

These automated results support the safety rules but are not human acceptance.

## Merge Assessment

The remaining `PENDING` scenarios are option B: later acceptance gates outside
the defined PRE-UAT storefront/shell scope of PR #46. UAT-002 requires payment
and order composition, UAT-015 requires the dedicated Guest Claim browser
adapter, and UAT-018 depends on those integrations plus invoice transport.
Merging PR #46 would not complete Phase 11, start Phase 12, approve production or
approve `SECURITY-READINESS`.

PR #46 is nevertheless not yet merge-ready under the repository-wide
`AGENTS.md` PR expectations because the visible UI change has no redacted
screenshots attached to the PR. The concrete remaining merge action is human:
attach safe storefront, account and denial screenshots that contain no key,
credential, session, claim, payment or personal data. No additional product
implementation is required for this PR-specific gate.
