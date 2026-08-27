# Fraud Velocity Limits

KS-09-02 extends the KS-09-01 fraud foundation with durable, deterministic
velocity signals. It remains supplier-neutral and payment-provider-neutral. It
does not add device fingerprinting, IP reputation, geolocation, Stripe Radar,
external fraud vendors, production operator UI, support tickets, supplier claim
workflow, Product Key retrieval or Product Key delivery.

## Authoritative Subjects

Velocity is calculated only from trusted persisted order state.

Supported subject types:

- `CUSTOMER`: the internal `customerId` on an owned order.
- `CHECKOUT_EMAIL`: a keyed pseudonymous identifier derived from the immutable
  normalized checkout email snapshot.

Request-supplied customer IDs, emails, amounts, currencies, counts, windows,
payment states and risk decisions are never authority. The caller may identify
an order; the service reloads the persisted order facts.

The checkout-email subject uses the existing normalized checkout email exactly.
KS-09-02 does not strip plus aliases, dots or provider-specific formatting.

## Pseudonymization

Checkout-email velocity uses:

```text
v1:HMAC-SHA-256(dedicatedVelocityCorrelationSecret, checkoutEmailNormalized)
```

The raw checkout email and HMAC secret are not stored in
`fraud_velocity_events`. There is no plain SHA-256 fallback and no raw-email
fallback. If an order requires checkout-email velocity and the dedicated
correlation secret is missing or invalid, velocity facts are unavailable and
fraud evaluation fails closed to `REVIEW` with
`VELOCITY_SIGNAL_UNAVAILABLE`.

The dedicated correlation secret is purpose-specific. It must not reuse session
signing keys, CSRF keys, encryption master keys, claim-token secrets, Stripe
secrets or Kinguin secrets.

Checkout-email subject keys are version-prefixed as `v1:<hex>`. Full secret
rotation is not implemented in KS-09-02. Changing the correlation secret changes
current fraud fingerprints and breaks historical cross-key email correlation
unless a future planned rotation strategy records versioned correlation material
safely. Old approvals must fail closed after correlation-key rotation until the
order is re-evaluated.

## Event Semantics

KS-09-02 records one event type:

- `PAYMENT_CONFIRMED`

An event is eligible only when trusted service composition provides
`FraudVelocityEventAuthorityPort` approval and the existing order has persisted
`payment_status = CAPTURED`. The production default event authority fails
closed. Failed requests, page views, fraud evaluations, duplicate webhooks, key
reveal attempts and retries of the same logical event do not create additional
velocity contributions.

`occurredAt` comes from the trusted event authority, not from browser or
request input. The service rejects invalid timestamps and timestamps in the
future relative to the trusted service clock. Repositories additionally reject
invalid timestamps and events before the order creation timestamp. PostgreSQL
does not use a `CHECK (occurred_at <= now())`; timestamp trust belongs at the
trusted event-authority boundary.

One logical order may create one event per supported subject type. For example,
an owned order with an immutable checkout email snapshot may contribute one
`CUSTOMER` event and one `CHECKOUT_EMAIL` event. The unique key
`(event_type, order_id, subject_type)` prevents duplicates for the same subject.
Recording returns both `subjectEventCount` and `insertedEventCount`, so a
guest-to-customer partial replay can report one newly inserted subject event
without pretending both subject rows were newly written.

For guest-to-customer transitions, historical checkout-email events remain
correlated to the checkout-email subject. If the same order later has a
customer subject and event recording is retried, the customer subject can be
recorded separately, but a single subject aggregate cannot double-count the
same order.

If no supported subject can be derived, velocity facts are unavailable. The
service must not treat an order with no `CUSTOMER` and no `CHECKOUT_EMAIL` as
an available zero-velocity case.

## Windows

Initial windows are explicit and deterministic:

- `PT15M`: 15 minutes
- `PT1H`: 1 hour
- `PT24H`: 24 hours

Window inclusion is closed on both ends:

```text
[evaluatedAt - duration, evaluatedAt]
```

An event exactly at the window start counts. An event just before the window
start does not count. An event exactly at evaluation time counts. Future-dated
events are not counted as normal history; their presence produces
`VELOCITY_TIMESTAMP_ANOMALY` and a fail-closed `REVIEW`.

## Aggregates

The repository returns aggregates for each subject, event type, currency and
window:

- `eventCount`
- `amountMinorTotal`
- `currency`

Amounts use integer minor units only. No floating point math or FX conversion
is introduced. Monetary thresholds are currency-aware. Counts are also scoped
to the evaluated order currency in this foundation so mixed-currency histories
do not affect each other.

PostgreSQL computes aggregates from indexed durable events instead of storing
cached counters.

## Policy Version

KS-09-01 evaluations remain `KS09_POLICY_V1`.

When velocity policy is configured, the service evaluates under
`KS09_POLICY_V2`. Velocity facts are included in the policy-versioned fact
fingerprint. A prior `KS09_POLICY_V1` approval is not authority for a
`KS09_POLICY_V2` decision.

## Thresholds

Velocity thresholds are typed policy configuration. A threshold can define
review and deny limits for order count, amount in minor units or both.

Configuration validation rejects:

- missing windows;
- duplicate windows;
- non-canonical window durations;
- unsupported event types;
- invalid currency codes;
- thresholds with neither count nor amount;
- duplicate `(window, eventType, currency)` threshold definitions;
- zero, negative, non-integer, unsafe or unordered thresholds.

Invalid security-critical configuration fails at construction/startup. KS-09-02
does not define production-approved threshold values. Validated policy is
defensively deep-copied and frozen so caller mutation after service
construction cannot alter live fraud behavior.

## Rules

Velocity rules emit stable reason codes:

- `VELOCITY_ORDER_COUNT_REVIEW`
- `VELOCITY_ORDER_COUNT_DENY`
- `VELOCITY_AMOUNT_REVIEW`
- `VELOCITY_AMOUNT_DENY`
- `VELOCITY_SIGNAL_UNAVAILABLE`
- `VELOCITY_TIMESTAMP_ANOMALY`

Decision precedence remains:

```text
DENY > REVIEW > ALLOW
```

Velocity `REVIEW` uses the existing durable `FRAUD` manual-review workflow.
Velocity `DENY` records a normal fraud deny decision. Neither path refunds,
cancels payment, calls Kinguin, decrypts keys, delivers keys or consumes guest
claim credentials.

## Stale Clearance

`FraudRiskService.isFraudCleared(orderId)` reloads current trusted facts,
attaches current velocity facts for the active policy and looks up the exact
evaluation by `(orderId, policyVersion, factFingerprint)`.

If another trusted event changes the relevant aggregate after an earlier
`ALLOW`, the old evaluation no longer matches the current fingerprint and the
guard fails closed until re-evaluation. A review approval clears only the exact
current evaluation/fingerprint/policy version.

Historical evaluation explanation uses the persisted evaluation and
fingerprint. Current clearance uses current trusted time and current velocity
facts.

Rolling windows are time-authoritative. If an event ages out of the active
window, current velocity facts and fingerprints change; old `ALLOW` decisions
and old approved `REVIEW` cases no longer clear until re-evaluation.

If underlying event membership changes but the configured aggregate facts are
identical for the current policy, the fingerprint may remain identical because
KS-09-02 fingerprints decision-relevant aggregate facts, not exact event IDs.

## Persistence

Migration 021 adds `fraud_velocity_events`.

Persisted fields:

- event ID;
- event type;
- order ID;
- subject type;
- pseudonymous or opaque subject key;
- amount minor;
- currency;
- occurred timestamp;
- recorded timestamp.

Constraints enforce valid event type, subject type, subject-key format and
length, non-negative amount, three-letter uppercase currency, non-null
timestamps, order FK and idempotency.

Indexes support:

- duplicate/idempotent event insertion by `(event_type, order_id,
subject_type)`;
- window aggregation by `(subject_type, subject_key, event_type, currency,
occurred_at)`;
- order inspection by `(order_id, occurred_at)`.

Velocity snapshots are loaded in a repository operation using the explicit
evaluation time. PostgreSQL calculates all configured subject/window aggregates
and the future-event anomaly in one SQL statement, so the result is a coherent
statement snapshot under PostgreSQL `READ COMMITTED`. It does not require global
application serialization.

Future-event anomaly detection is scoped to the same derived subject type,
subject key and `PAYMENT_CONFIRMED` event semantics. It is subject-wide rather
than currency-specific, because a future commercial event for the subject is a
timestamp integrity signal even when the current order currency differs.

## Data Minimization

Velocity persistence and audit metadata must not contain raw checkout email,
customer name, billing address, IP address, user agent, Product Keys, session
credentials, claim codes, Stripe secrets, Kinguin secrets or the HMAC
correlation secret.

Customer APIs must not expose velocity counts, amounts, thresholds, subject
keys, fraud reason details or risk scores.

## Retention

KS-09-02 does not define a production retention policy. The largest active
window is 24 hours, but fraud velocity events may also be useful future dispute
or support evidence. Retention and deletion policy require later operational
approval.

## Production Status

- PRODUCTION FRAUD POLICY APPROVED: NO
- PRODUCTION VELOCITY POLICY APPROVED: NO
- PRODUCTION OPERATOR AUTHORITY CONNECTED: NO
- PRODUCTION MANUAL REVIEW UI CONNECTED: NO
- EXTERNAL FRAUD PROVIDER CONNECTED: NO
- STRIPE RADAR INTEGRATED: NO
- KINGUIN CALLED BY FRAUD EVALUATION: NO
- REAL KEY REVEAL ENABLED BY FRAUD REVIEW: NO
