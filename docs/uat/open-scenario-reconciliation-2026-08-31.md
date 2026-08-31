# Open Human-UAT Scenario Reconciliation - 2026-08-31

## Scope And Decision

This review reconciles UAT-002, UAT-015 and UAT-018 against the implemented
staging browser boundary. On 2026-08-31 the KeyRaNo product owner completed
UAT-002 with synthetic staging data and accepted the complete registered-customer
journey. UAT-015 and UAT-018 remain `PENDING` because Guest Claim and the full
invoice/fulfillment walkthrough remain outside the tested browser boundary.

No live Stripe or Kinguin call, supplier purchase, real Product Key, production
credential, production data, production DNS change or deployment was used.
`PRE-UAT-KEY-REAL-01` was not executed. The narrow
`PHASE_12_CUSTOMER_CHECKOUT_INTEGRATION` staging task supplied the tested
checkout composition; no broader Phase-12 production release work or approval
was started. `SECURITY-READINESS` remains `NOT_APPROVED`.

## UAT-002 - Registered Customer Purchase Journey

Overall status: `PASS`.

The product owner executed the complete UAT-002 browser scenario on 2026-08-31.
Customer A selected `Lumen Grid`, quantity one, completed the staging-only
synthetic success checkout, and reached the resulting WooCommerce confirmation.
The confirmation showed EUR 7.99 and the date `31-08-2026`, with no Product Key.
The resulting purchase appeared in Customer A's `Meine Käufe` view with paid,
in-progress, invoice-unavailable and safe activation states. Before explicit
reveal it showed `Dein Key ist noch nicht verfügbar.` Customer B could not find
the purchase and direct detail access returned `Kauf nicht verfügbar`.

| Acceptance step                                                          | Status | Evidence and result                                                                                                                                             |
| ------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in as synthetic customer A and select a synthetic offer             | `PASS` | Customer A selected `Lumen Grid`, quantity one, and the cart/checkout displayed the expected synthetic purchase.                                                |
| Complete checkout with a sandbox payment method                          | `PASS` | The staging-only synthetic success method completed without a live payment provider or external mutation.                                                       |
| Create exactly one KeyCore order and preserve correct customer ownership | `PASS` | Human review observed one resulting owned purchase; E2E-001/E2E-011 provide the supporting exact-one and replay-idempotency evidence not inferred from the UI.  |
| Open the resulting confirmation and account purchase list                | `PASS` | The confirmation showed the tested product, quantity, EUR 7.99 and `31-08-2026`; Customer A's account showed the resulting purchase and coherent safe statuses. |
| Customer B cannot locate or directly access customer A's order           | `PASS` | Customer B's list omitted the purchase and direct detail access returned `Kauf nicht verfügbar`.                                                                |
| Ordinary confirmation contains no Product Key                            | `PASS` | The resulting confirmation contained no Product Key, and the account showed the key as unavailable before any explicit reveal.                                  |

Automated evidence was rerun on 2026-08-31 with synthetic data only. E2E-001
and E2E-011 passed, including idempotent order creation, verified synthetic
payment-webhook replay and exact owned-order binding. It supports the exact-one
and persistence invariants; it is not represented as a human database
inspection.

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
specification. It remains outside this documentation-only reconciliation.

## UAT-018 - Complete Acceptance Walkthrough

Overall status: `PENDING`.

| Walkthrough step                                                                    | Status                                                    | Evidence and remaining gate                                                                                    |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Discover and select an eligible synthetic product                                   | `PASS`                                                    | UAT-001 human result.                                                                                          |
| Authenticate as the mapped synthetic customer                                       | `PASS`                                                    | Human account A review. Production identity remains out of scope.                                              |
| Open cart and checkout shell                                                        | `PASS`                                                    | Human review confirmed the shell and absence of a live payment method.                                         |
| Complete sandbox payment                                                            | `PASS`                                                    | UAT-002 human review completed the staging-only synthetic success checkout.                                    |
| Create the resulting KeyCore order idempotently                                     | `PASS` (scoped)                                           | The resulting purchase was human-visible; E2E-001/E2E-011 support exact-one and replay invariants.             |
| Observe synthetic procurement and encrypted fulfillment for that order              | `PENDING`                                                 | The tested order remained in progress with no key available; composed fulfillment was not executed.            |
| Review owned purchase history                                                       | `PASS` for direct purchase / `GATED` for claimed purchase | The resulting UAT-002 purchase was owner-visible; Guest Claim still needs `PHASE_12_ACCOUNT_TRANSPORT`.        |
| Reveal only through the secure owner path                                           | `PASS`                                                    | UAT-006 human result.                                                                                          |
| Review invoice access                                                               | `PENDING`                                                 | Owner-filtered metadata exists; real invoice document/provider transport remains `PHASE_12_INVOICE_TRANSPORT`. |
| Review one coherent ordered evidence set and explicitly accept the complete journey | `PENDING`                                                 | UAT-002 now passes, but Guest Claim, fulfillment and invoice-document steps prevent UAT-018 acceptance.        |

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

UAT-002 is accepted for the synthetic staging scope. UAT-015 still requires the
dedicated Guest Claim browser adapter, and UAT-018 still depends on that path,
composed fulfillment and invoice-document transport. PR #47 therefore does not
complete KS-11-07, approve production or approve `SECURITY-READINESS`.

This record contains the supplied human observations but does not claim that
new screenshots were committed or attached. Any redacted screenshots still
required by the repository-wide `AGENTS.md` PR policy must be attached by a
human without keys, credentials, sessions, checkout capabilities, payment
details, personal data or private identifiers. PR #47 remains open and must not
be merged by the implementing agent.
