# PHASE_12_END_TO_END_STOREFRONT_INTEGRATION

Risk: CRITICAL

Human approval: Implementation review and separate Human-UAT are required.
Creating or completing this task does not change any UAT result, approve
KS-11-07, approve `SECURITY-READINESS`, or authorize production operation.

## 1. Objective

Compose the existing KeyRaNo WooCommerce staging storefront with the existing
KeyCore checkout, payment, guest-claim, order, fulfillment, account, audit and
Admin foundations so three incomplete synthetic browser journeys can be
executed end to end:

1. guest checkout followed by safe account-claim instructions;
2. a captured order moving visibly from delayed fulfillment to ready state
   through an authorized staging-only control; and
3. synthetic payment failure and cancellation with truthful, retry-safe browser
   outcomes.

The implementation is staging/test/synthetic only. It must reuse authoritative
KeyCore services and PostgreSQL state rather than introducing a second checkout,
claim, payment, fulfillment or authorization model.

## 2. Why This Block Is Next

KS-11-07 currently has 8 of 18 Human-UAT scenarios at `PASS`. UAT-003 and
UAT-007 remain `PENDING` because their browser journeys are only partially
composed. UAT-009 remains `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` even though
the lower staging checkout already models definitive synthetic failure and
cancellation.

The storefront already supports eligible synthetic products, cart, registered
checkout, account history, one-time Guest Claim, owner-only synthetic reveal
and owner-only synthetic invoice access. This task closes the smallest coherent
customer-facing integration gap before broader identity, fraud, refund, support
or production-readiness work.

## 3. UAT Scenarios Intended To Be Unblocked

- `UAT-003` - Guest purchase journey: intended to become fully
  `EXECUTABLE_NOW` after implementation and technical review.
- `UAT-007` - Delayed fulfillment: intended to become fully `EXECUTABLE_NOW`
  after implementation and technical review.
- `UAT-009` - Payment failure: intended to become fully `EXECUTABLE_NOW` after
  implementation and technical review. The cancellation variant is required
  regression coverage for the same boundary.
- `UAT-016` - Authentication and verification experience: not unblocked by this
  task. Existing synthetic mapped-account login must remain working, but
  registration, unverified-account handling, verification delivery and an
  approved identity provider remain a separate `PHASE_12_AUTHENTICATION_TRANSPORT`
  dependency.

Implementation may update technical readiness for UAT-003, UAT-007 and UAT-009
only after their complete browser paths exist. Their human results must remain
unchanged until the product owner executes each scenario and supplies safe
evidence.

## 4. Current Implementation Baseline

- `PHASE_12_CUSTOMER_CHECKOUT_INTEGRATION` provides three native staging-only
  WooCommerce gateways: success, failure and cancellation.
- The current gateway and `/v1/checkout` bridge require a logged-in WordPress
  user with an exact server-maintained KeyCore customer mapping. Guest checkout
  therefore cannot create an authoritative KeyCore guest order.
- `PostgresStagingCheckout` creates one durable KeyCore order and payment record
  and already maps definitive synthetic payment outcomes to `CAPTURED`, `FAILED`
  or `CANCELLED`. Failed and cancelled orders remain non-procurement-eligible.
- The current WooCommerce gateway returns checkout notices for failure and
  cancellation, but UAT-009 lacks a stable complete browser result, account
  observation and retry path.
- `PHASE_12_ACCOUNT_TRANSPORT` exposes the authenticated, one-time,
  verified-same-email `Kauf hinzufuegen` path. It consumes hash-only challenges
  and binds ownership in PostgreSQL.
- `GuestOrderClaimService` and `PersistedGuestOrderClaimIssuanceAuthority`
  already support trusted post-order claim issuance and revoke undelivered
  challenges. The staging runtime does not yet compose this issuance path with
  a newly completed guest checkout.
- The staging Compose stack already contains Mailpit as a loopback-bound capture
  sink. No unrestricted or production mail delivery is enabled.
- Account pages already render pending and ready states, but there is no
  authorized browser control that advances a newly captured synthetic order
  through delayed fulfillment.
- KS-07-04/KS-07-05 provide encrypted fulfillment and secure customer-delivery
  boundaries. KS-ADMIN-01/KS-ADMIN-02 provide authenticated Admin sessions,
  exact-origin and CSRF controls, durable audit, and the existing
  `SENSITIVE_OPERATION` capability for `PROJECT_OWNER` and `OPERATIONS`.
- The migration baseline is `029`. No schema change is expected for this task
  unless implementation proves an actual representational defect.

## 5. In Scope

- Anonymous WooCommerce checkout for an explicitly synthetic guest identity.
- A conditional, exact-schema guest checkout bridge command that creates an
  unowned KeyCore order with an immutable checkout-email snapshot.
- Synthetic captured payment for that guest order using the existing staging
  payment provider and idempotency rules.
- Trusted one-time Guest Claim issuance after confirmed guest payment, with
  hash-only PostgreSQL persistence and delivery only to Mailpit.
- Guest confirmation content explaining account-required access and exact
  same-email claim requirements without displaying claim material.
- Stable browser-visible failed and cancelled payment result pages or notices,
  including a bounded return/retry action.
- An authorized, POST-only staging Admin control that advances one eligible
  captured synthetic order through a deterministic delayed-fulfillment path.
- Existing account projection refresh from pending to ready after durable
  synthetic fulfillment succeeds.
- A status-only Mailpit notification after readiness, with no Product Key.
- Focused WordPress, TypeScript, PostgreSQL, security and staging integration
  tests plus task/runbook documentation and an implementation report.

## 6. Explicit Out Of Scope

- Live Stripe API calls, credentials, PaymentIntents, charges, refunds or
  webhooks.
- Kinguin or any other real or mock supplier purchase request.
- Real supplier key retrieval, real Product Keys or production key reveal.
- Product Key delivery by email or inclusion in WooCommerce metadata.
- Production email providers, unrestricted recipients or publicly exposed
  Mailpit.
- Production invoice issuance, VAT/tax policy, accounting integration or
  `TAX-INVOICE` approval.
- Customer registration, email-verification UI, password handling, account
  recovery, identity-provider integration or completion of UAT-016.
- Fraud operator UI, refund UI, support UI, supplier reconciliation UI or
  emergency-control UI beyond the narrow delayed-fulfillment staging action.
- Changes to supplier routing, real procurement, Admin role semantics or
  production Operations Authority.
- Production deployment, production configuration or any approval-state change.
- Page-builder dependencies or unrelated storefront redesign.

## 7. Functional Requirements

### 7.1 Guest Checkout

1. WooCommerce must allow the synthetic success gateway for a logged-out guest
   only in the validated staging environment.
2. Guest checkout requires one valid synthetic checkout email. The staging
   implementation must accept only an explicitly configured or deterministic
   `.test` fixture identity and reject real/public recipient domains.
3. WordPress derives product reference, quantity, total, currency, timestamp,
   checkout token and checkout email from the server-side WooCommerce order.
   Browser fields are input, never authority.
4. The signed bridge command must distinguish `ACCOUNT` and `GUEST` checkout
   with an exact conditional schema. Account mode derives the KeyCore customer
   from the trusted WordPress mapping. Guest mode must not accept a customer ID.
5. A successful guest checkout persists
   `keycore_orders.customer_id IS NULL` and a non-null normalized immutable
   checkout-email snapshot. It must never create an authenticated ownership
   binding.
6. Claim issuance starts only after payment is durably `CAPTURED`. It must reuse
   `GuestOrderClaimService`, `PersistedGuestOrderClaimIssuanceAuthority` and the
   PostgreSQL Guest Claim repository.
7. Each dynamically created guest order receives a fresh high-entropy claim
   value. It must not reuse the static bootstrap fixture value or derive a value
   from an order ID, email, WooCommerce order key or checkout token.
8. PostgreSQL stores only the claim hash. The raw value may exist only within
   the narrow Mailpit delivery adapter and must not be returned by the bridge.
9. If Mailpit delivery definitively fails, the new challenge is revoked by the
   existing service. The captured order remains paid and unowned; the browser
   reports that claim instructions are temporarily unavailable without
   reporting checkout failure or exposing internals.
10. Confirmation must state in German that no Product Key is delivered there,
    that a KeyRaNo account is required, and that the verified account email must
    match the checkout email. It must not show the claim value.
11. The existing authenticated `Kauf hinzufuegen` transport remains the only
    browser path that can consume the claim and bind ownership.

### 7.2 Payment Failure And Cancellation

1. The existing synthetic failure and cancellation gateways remain available
   only in staging and must use the existing payment service and order state
   machine.
2. A definitive failure persists `payment_status = FAILED`; cancellation
   persists `payment_status = CANCELLED`. Neither state may start procurement,
   fulfillment, claim issuance, notification or key access.
3. The WooCommerce order must show the corresponding failed/cancelled state and
   a stable German result message after submission, refresh and direct revisit.
4. A registered customer may see only their own resulting safe order state.
   Guest failure/cancellation must reveal no ownership or claim information.
5. Retry must create a new explicit WooCommerce checkout attempt and a new
   idempotency root. It must not mutate a terminal failed/cancelled payment into
   `CAPTURED`, replay the old attempt, or silently duplicate an order/payment.
6. Refresh, back navigation and repeated submission of the same attempt must
   remain idempotent and display the same terminal result.

### 7.3 Delayed Fulfillment

1. A successful synthetic checkout initially remains visibly non-ready. No key
   or readiness promise may appear before the durable transition succeeds.
2. Only a KeyCore order created by the staging checkout composition, with
   `payment_status = CAPTURED`, approved risk, no prior procurement/fulfillment
   completion and no conflicting operation, is eligible for the test action.
3. Transition authority must be server-side. The customer browser may observe
   state but cannot choose or advance payment, procurement or fulfillment state.
4. The staging Admin action must require an active Admin session,
   `ADMIN_ACCESS`, `SENSITIVE_OPERATION`, exact staging origin, POST, valid CSRF,
   an exact order identifier and an explicit confirmation step.
5. The action must be hard-disabled unless `KEYCORE_ENV=STAGING`, the configured
   storefront/Admin origins are approved staging origins, and all staging
   preflight isolation checks pass.
6. The action may create deterministic synthetic procurement evidence required
   by the existing order state machine, but it must perform no supplier network
   request and must not call a real supplier adapter.
7. Synthetic fulfillment must reuse the existing fulfillment/vault services and
   the separately injected `KEYRANO_STAGING_SYNTHETIC_KEY`. The value must remain
   encrypted at rest and absent from the Admin response, account list, ordinary
   order detail, email, logs, audit and test snapshots.
8. Successful execution advances the authoritative order through valid states
   to completed/ready, persists one fulfillment operation and one encrypted
   synthetic secret, and makes the existing owner-only account projection show
   the ready state.
9. Readiness notification is status-only and captured by Mailpit. It may link to
   the authenticated account but must not contain a Product Key, reveal
   capability, session value or provider/supplier detail.
10. Repeated or concurrent Admin execution must produce at most one logical
    procurement transition, fulfillment operation, encrypted secret and
    notification. Ambiguous or partial failure must fail closed to reconciliation
    or manual review rather than repeat unsafe work.
11. Product Key access remains a separate explicit owner-authorized action.
    This task must not automatically reveal any value.

## 8. Browser And UI Requirements

- Preserve native WordPress/WooCommerce presentation ownership and the current
  KeyRaNo dark account design. Do not introduce a page builder.
- Guest checkout must work from Shop to product, cart and checkout in a logged-
  out normal/private browser session.
- The guest confirmation must remain accessible only through normal
  WooCommerce order-confirmation authority and must not expose internal KeyCore
  IDs unnecessarily.
- Failure and cancellation require distinct, understandable German headings,
  non-success styling and a clear action back to cart/shop or a fresh retry.
- Pending order detail must clearly say the purchase is being processed and the
  key is not yet available. Refresh must not create another purchase.
- After the authorized synthetic transition, the same customer order detail and
  `Meine Kaeufe` list must show a coherent ready state without manual database
  editing.
- The Admin control must appear only for eligible synthetic staging orders and
  authorized staff. It must never render for ineligible, production, failed,
  cancelled, already-completed, ambiguous or unrelated orders.
- All new surfaces must remain responsive, keyboard operable, escaped, CSRF
  protected where mutating, and free of secret-bearing URLs or DOM attributes.

## 9. State Transition Requirements

### Guest success

```text
Woo order created
-> KeyCore order CREATED/AWAITING_PAYMENT with customer_id NULL
-> synthetic payment CAPTURED
-> KeyCore order PAYMENT_CAPTURED
-> hash-only Guest Claim challenge issued
-> claim message accepted by Mailpit
-> guest confirmation with account-required instructions
```

Claim delivery failure must leave the payment/order truthful and the challenge
revoked; it must not bind ownership or create key authority.

### Delayed fulfillment

```text
PAYMENT_CAPTURED / procurement NOT_STARTED / fulfillment NOT_STARTED
-> authorized staging-only synthetic transition
-> PROCUREMENT_PENDING
-> PROCUREMENT_IN_PROGRESS
-> synthetic procurement SUCCEEDED without supplier network mutation
-> FULFILLMENT_PENDING
-> synthetic secret encrypted and persisted through existing services
-> fulfillment SUCCEEDED / order COMPLETED
-> status-only Mailpit readiness notification
```

Every transition must satisfy the existing optimistic-concurrency,
idempotency, outbox and order-history rules. No direct SQL status editing is an
accepted implementation.

### Failure and cancellation

```text
AWAITING_PAYMENT -> FAILED
AWAITING_PAYMENT -> CANCELLED
```

Both are terminal for the original payment attempt. Procurement and fulfillment
remain `NOT_STARTED`, and no claim challenge or key material is created.

## 10. Security Requirements

- Keep strict origin equality, HMAC request/response authentication, bounded
  request bodies, exact schemas, timestamps, CSRF and no-store behavior.
- Anonymous bridge access is permitted only for the narrowly defined guest
  checkout route. Account, claim, invoice, reveal and all other protected routes
  remain authenticated and owner-scoped.
- Never trust browser-supplied customer IDs, KeyCore order IDs, totals,
  currencies, product eligibility, payment status, fulfillment state or Admin
  authority.
- Preserve Germany eligibility and positive-price checks before order creation.
- Preserve the immutable checkout-email snapshot and verified-same-email Guest
  Claim rules. Email equality alone remains insufficient ownership proof.
- Restrict guest test email input and Mailpit delivery to synthetic staging data.
- Keep Mailpit loopback/private; do not add a public unauthenticated mail UI.
- No raw claim value, Product Key, token hash, ciphertext, HMAC secret, cookie,
  Admin session code or payment credential may enter logs, audit, outbox,
  WordPress metadata, browser JSON or snapshots.
- Preserve the existing Admin role/capability model. Do not grant customers,
  SUPPORT, FINANCE or SECURITY_AUDITOR synthetic transition authority.
- All outages and uncertain outcomes fail closed. PostgreSQL outage disables
  checkout and transition mutations; Mailpit outage cannot create an active
  undelivered claim credential.
- Live Stripe, supplier and customer-delivery flags remain disabled.

## 11. Audit Requirements

- Reuse existing durable audit events for order, payment, Guest Claim,
  fulfillment and Admin access wherever available.
- Add stable, supplier-neutral reason codes only where an existing code cannot
  represent the staging composition event.
- Record safe outcomes for guest checkout creation, claim issuance/delivery
  acceptance or failure, payment failure/cancellation, Admin transition denial,
  transition start, transition completion and idempotent replay.
- Audit metadata may contain internal IDs, synthetic mode, state names,
  correlation IDs and reason codes. It must omit checkout email, claim value,
  Product Key, encrypted material, session/cookie values, request bodies and
  provider credentials.
- The Admin transition audit must identify the authenticated Admin actor and the
  exact order entity without exposing customer personal data.
- Tests must prove that audit failure handling follows existing workflow rules
  and never creates a false browser success.

## 12. Synthetic Fixture And Test Requirements

- Add one dedicated `.test` guest checkout identity distinct from Customer A and
  Customer B. Do not use a real mailbox or personal data.
- Dynamic guest claims use runtime-generated values; the existing deterministic
  bootstrap claim fixture remains separate and must not be reused or reset by a
  normal checkout.
- Use only the existing eligible synthetic catalog and EUR minor-unit amounts.
- Add a dedicated captured delayed-order scenario identifiable by trusted
  staging metadata, not by title substring or browser input.
- Reuse the injected synthetic key and staging encryption key. Never check in a
  runtime key, claim value or master key.
- Mail tests use an in-memory adapter or Mailpit test sink and assert omission of
  Product Keys from all notification bodies.
- Fixtures and bootstrap must be idempotent. Existing consumed claim challenges,
  owned orders and completed fulfillment must never be silently reset.
- A full staging-volume reset remains explicit and destructive; ordinary
  bootstrap must not be changed into a reset mechanism.

## 13. Automated Test Requirements

### WordPress/PHP

- Guest success gateway availability only in staging and with valid guest data.
- Protected/account checkout behavior remains unchanged for mapped users.
- Server-derived guest email and exact bridge command; spoofed identity/status
  fields are impossible.
- Guest confirmation omits claim values, Product Keys and internal authority.
- Stable failed/cancelled pages, refresh behavior and safe fresh-retry link.
- Existing checkout, account, claim, invoice, footer and reveal adapter tests.

### TypeScript/unit and adapter

- Exact conditional schema for `ACCOUNT` versus `GUEST` checkout.
- Anonymous access rejected everywhere except eligible guest checkout.
- Guest order remains unowned and cannot access account/reveal/invoice routes.
- Claim issuance occurs once only after capture; delivery failure revokes the
  new challenge.
- Failure/cancellation mapping is deterministic and cannot transition to
  procurement or fulfillment.
- Admin transition requires all existing authentication, capability, origin and
  CSRF controls; missing/wrong authority is denied before mutation.
- Delayed transition succeeds once, replays idempotently and handles concurrent
  execution without duplicate side effects.
- Secret/canary leakage tests cover bridge bodies, WordPress metadata, audit,
  outbox, mail, errors and snapshots.

### PostgreSQL/integration

- Captured guest order has `customer_id IS NULL`, the immutable normalized
  checkout-email snapshot, one payment and one active hash-only claim challenge.
- Claim value is absent from every persisted searchable text/JSON field.
- Failed/cancelled attempts persist terminal payment state with procurement and
  fulfillment `NOT_STARTED`, no claim challenge, no fulfillment operation and no
  encrypted key record.
- Pending-to-ready transition follows valid order history, outbox, fulfillment
  and encrypted-secret invariants transactionally where the existing services
  require it.
- Repeated/concurrent transition produces one fulfillment and notification
  effect; conflicting state fails closed.
- Owner account projection changes from pending to ready, while cross-owner and
  anonymous access remain denied.

### Repository gates

- `npm run check`
- focused storefront/browser/checkout/claim/fulfillment/Admin tests
- relevant PostgreSQL integration tests with PostgreSQL available
- PHP 8.3 syntax and WordPress adapter tests
- `docker compose -f infra/docker/compose.yaml config`
- staging Compose validation with the example environment
- `npm audit --audit-level=low`
- `npm run secrets:scan`
- `npm run uat:validate`
- `git diff --check`

Automated tests are supporting evidence only and cannot mark a Human-UAT result
`PASS`.

## 14. Human-UAT Acceptance Criteria

### UAT-003

- A logged-out human can buy one eligible synthetic product with the synthetic
  success method.
- The confirmation truthfully shows successful synthetic payment, no
  authenticated ownership and no Product Key.
- The confirmation clearly requires a KeyRaNo account with the same checkout
  email and directs the reviewer to the existing claim journey.
- The one-time claim message is visible only in the approved Mailpit channel and
  contains no Product Key.
- PostgreSQL evidence shows an unowned order and one active, unconsumed,
  hash-only challenge.

### UAT-007

- The owning customer sees the newly captured synthetic order as pending before
  transition and cannot reveal a key.
- An authorized staging operator executes exactly one explicit Admin action.
- The customer can refresh/revisit and see the same order become ready without a
  duplicate purchase.
- A status-only notification is captured, and secure access remains a separate
  owner-only action.
- Repeating the Admin action is visibly idempotent and creates no second
  fulfillment, secret or notification.

### UAT-009

- A human can select and submit the synthetic failure method and observe a
  stable German failure result after refresh/revisit.
- The synthetic cancellation method produces a distinct stable cancellation
  result.
- Neither attempt becomes paid, starts procurement/fulfillment, issues a claim
  or creates key authority.
- The browser provides a clear safe path to return or start a fresh attempt.
- Repeating the original request does not change its terminal result or create
  duplicate effects.

For all three scenarios, the product owner must capture only redacted evidence
and explicitly record `PASS`, `FAIL` or `BLOCKED`. Implementation completion,
green CI or PR merge does not alter the current 8/18 UAT count.

## 15. Regression Risks

- Accidentally allowing anonymous access to protected account or reveal routes.
- Binding a guest order to a browser-supplied identity.
- Issuing a claim before confirmed payment or leaving an undelivered challenge
  active.
- Reusing the deterministic UAT claim fixture for dynamic guest orders.
- Turning terminal payment retry into a state regression or duplicate charge
  analogue.
- Directly editing order status and bypassing order history/outbox invariants.
- Triggering duplicate synthetic fulfillment or notification under concurrency.
- Exposing synthetic key/claim material in WooCommerce metadata, mail, audit or
  test output.
- Granting the staging transition to an overly broad Admin role.
- Weakening existing UAT-002, UAT-004, UAT-005, UAT-006, UAT-012, UAT-015 or
  UAT-018 behavior while composing the new paths.
- Making Mailpit or staging controls reachable as production-capable services.

## 16. Dependencies

- `PROJECT_CONSTITUTION.md` and ADR-0001, ADR-0003 through ADR-0006, and
  ADR-0008 through ADR-0012.
- `PHASE_12_CUSTOMER_CHECKOUT_INTEGRATION`.
- `PHASE_12_ACCOUNT_TRANSPORT`.
- KS-07-01 order orchestration and KS-07-02 payment foundation.
- KS-07-04 secure key fulfillment and KS-07-05 secure customer delivery.
- KS-08-05 Guest Claim foundation.
- KS-10-01/KS-10-02 operations controls and fail-closed checkout gate.
- KS-ADMIN-01/KS-ADMIN-02 Admin authentication, capabilities and audit.
- KS-11-02 acceptance tests and KS-11-07 readiness/evidence conventions.
- PostgreSQL 16, Redis 7.4, WordPress/WooCommerce, and Mailpit 1.21.8 from the
  existing staging stack.

No live-provider, production-identity or production-approval dependency may be
introduced to complete this task.

## 17. Expected Files And Components Likely To Change

The implementation should remain within existing ownership boundaries. Likely
touch points include:

- `infra/storefront/staging-checkout.ts`
- `infra/storefront/staging-browser-adapter.ts`
- `infra/storefront/staging-storefront-runtime.ts`
- a narrow staging Guest Claim issuance/Mailpit delivery adapter under
  `infra/storefront/`
- `infra/postgres/staging-checkout-seed.ts` only for additive synthetic fixture
  metadata, not destructive reset behavior
- existing PostgreSQL repositories for composition only; no constraint changes
  are expected
- `apps/wordpress/keycore-platform/includes/class-keyrano-checkout-gateway.php`
- existing WordPress checkout/plugin/account templates and CSS where required
  for the three result states
- `infra/admin/admin-http.ts` and the existing Admin service boundary for the
  staging-only fulfillment action
- focused tests beside those components and relevant PostgreSQL integration
  tests
- `infra/docker/compose.staging.yaml` and `staging.env.example` only if internal
  Mailpit wiring or an explicit disabled-by-default staging control flag is
  required
- `docs/storefront/`, staging/UAT runbooks, `CHANGELOG.md`, and a dedicated
  implementation report
- UAT readiness/result documentation only after technical or human state
  actually changes; no result may be pre-marked `PASS`

Adding a migration requires evidence that migration 029 cannot represent the
required durable state and must include reversible up/down files. A migration
must not be added merely for fixture convenience.

## 18. Rollback Considerations

- Guest checkout enablement, claim issuance composition and Mailpit adapter must
  be removable together while retaining existing registered checkout and Guest
  Claim behavior.
- Failure/cancellation presentation may be reverted without deleting durable
  terminal order/payment records.
- The staging Admin transition route/control and synthetic fulfillment adapter
  must be independently disableable by configuration, defaulting to disabled
  outside validated staging.
- Rollback must not delete or decrypt existing encrypted synthetic fulfillment
  records, reactivate consumed claims, unbind ownership or rewrite order
  history.
- If a migration is exceptionally required, its down migration must refuse
  unsafe destructive rollback or document the exact synthetic-only cleanup
  precondition.
- Staging-volume deletion remains a deliberate operator reset, never an
  automatic rollback step.

## 19. Definition Of Done

- UAT-003, UAT-007 and UAT-009 have complete browser-visible synthetic staging
  paths matching their authoritative scenario definitions.
- Guest success creates a captured unowned order and delivers one hash-only
  claim challenge through private Mailpit without exposing its raw value outside
  that channel.
- Delayed fulfillment moves one eligible order from pending to ready through an
  authorized, audited, idempotent staging-only Admin action with no supplier
  network request.
- Failure and cancellation remain terminal, understandable, refresh-safe and
  ineligible for procurement, fulfillment, claim issuance and key access.
- Existing ownership, claim, reveal, invoice, Admin, payment and supplier
  boundaries remain green.
- Required automated tests and repository gates pass locally where available
  and in CI, including real PostgreSQL integration coverage.
- Documentation, runbooks, `CHANGELOG.md` and the implementation report are
  current without secrets or fabricated Human-UAT evidence.
- Technical readiness may be changed to `EXECUTABLE_NOW` only for fully composed
  scenarios. Human results remain unchanged until actual product-owner review.
- KS-11-07 remains incomplete, Human Acceptance remains `IN_REVIEW`, Human
  Approval remains `NOT_APPROVED`, and `SECURITY-READINESS` remains
  `NOT_APPROVED` unless separately changed by authorized humans in later work.
- No production configuration, live provider operation, real Product Key or
  production deployment occurs.

## 20. Recommended Branch Name

`feature/phase-12-end-to-end-storefront-integration`

Create it from current `main` after the reviewed Human-UAT documentation branch
has been merged or otherwise reconciled. Do not stack implementation on an
unmerged documentation branch without explicit repository-owner approval.

## 21. Recommended Commit And PR Strategy

Use one reviewable PR against `main` for this task only. Recommended commit
sequence:

1. compose anonymous guest checkout and Mailpit-only claim issuance;
2. add stable failure/cancellation browser results and retry semantics;
3. add the authorized staging delayed-fulfillment transition and account refresh;
4. add PostgreSQL/security/regression coverage;
5. update runbooks, UAT technical readiness, implementation report and
   changelog after behavior is verified.

Do not mix authentication transport, fraud/refund/support UI, production
configuration or legal/tax work into the PR. Do not merge until quality gates
are green, the diff is reviewed against this task, and the product owner has
approved the implementation for staging Human-UAT. Merge does not itself mark
any UAT scenario `PASS`.

## 22. Estimated Implementation Risk And Complexity

- Risk: `CRITICAL`, because the work touches anonymous checkout, payment
  terminal states, ownership creation, one-time claim material, fulfillment,
  encrypted synthetic key handling and privileged Admin mutation.
- Complexity: `HIGH`, spanning PHP/WooCommerce, the signed Node bridge,
  PostgreSQL repositories, Mailpit, Admin authorization and cross-runtime tests.
- Scope control: achievable as one focused block because all core business
  services already exist. The implementation should primarily add staging-only
  adapters and orchestration, not new domain models.
- Primary review focus: anonymous-route isolation, claim issuance timing,
  terminal payment idempotency, privileged transition authorization, concurrent
  fulfillment deduplication and secret omission.

## Approval Boundaries

This task does not authorize or approve:

- any Human-UAT result;
- KS-11-07 completion;
- `SECURITY-READINESS`;
- `LIVE-PAYMENTS`, `REAL-SUPPLIER`, `TAX-INVOICE` or `PRODUCTION-RELEASE`;
- production credentials, data, deployment or provider mutations.

Codex and CI may prepare implementation and automated evidence only. Human-UAT
must be executed and recorded separately, one scenario at a time.
