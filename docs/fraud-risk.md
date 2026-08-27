# Fraud Risk

KS-09-01 adds the KeyCore fraud risk foundation for Phase 09. KS-09-02 extends
it with durable fraud velocity limits. The fraud foundation is supplier
neutral, payment-provider neutral and deterministic. It does not integrate an
external fraud vendor, Stripe Radar, Kinguin, production operator UI or
customer fraud disclosures.

Public storefront branding remains KeyRaNo:

- KeyRaNo — Rapid Access. No Waiting.
- Dein Key. Direkt. Ohne Warten.

Fraud internals remain KeyCore terminology.

## Existing Semantics

Phase 07 already models order `riskStatus`:

- `NOT_EVALUATED`;
- `APPROVED`;
- `REVIEW_REQUIRED`;
- `REJECTED`.

Supplier procurement is already gated by captured payment plus approved order
risk status. KS-09-01 does not remove or weaken that gate.

Fulfillment `MANUAL_REVIEW_REQUIRED` and order `MANUAL_REVIEW` may also be
caused by procurement or delivery ambiguity. Fraud review is a separate source
and must not be treated as fulfillment ambiguity.

## Decisions

Fraud risk decisions are:

- `ALLOW`: fraud policy does not currently block the order.
- `REVIEW`: trusted human/operator review is required before a protected
  downstream transition.
- `DENY`: fraud policy rejects the order for fraud-risk purposes.

Decision precedence is deterministic:

```text
DENY > REVIEW > ALLOW
```

`ALLOW` does not mean payment succeeded, procurement is safe, key reveal is
authorized, order ownership is proven or invoice state is valid. Existing order,
payment, procurement, fulfillment and customer account state machines remain
authoritative.

`DENY` does not automatically refund, cancel, call Stripe, cancel Kinguin,
delete an order or alter fulfillment. It records decision state only.

## Trusted Facts

Risk evaluation loads trusted server-side facts from persistence. A caller may
identify an order, but request-supplied `customerId`, email, payment amount,
currency, payment status, supplier, product price, risk score, risk decision,
country, IP reputation, order ownership and verification state are not
authority.

KS-09-01 base facts include only currently persisted facts:

- order ID;
- optional customer ID;
- customer email verification state when an owned customer exists;
- checkout email snapshot presence;
- order amount in minor units;
- currency;
- order status;
- payment status;
- existing order risk status;
- order creation timestamp.

No IP, device, geolocation, billing address, Radar field or external fraud
vendor signal is fabricated.

When KS-09-02 velocity policy is configured, the service also attaches trusted
velocity facts loaded from `fraud_velocity_events` for the current evaluation
time. Velocity subjects are limited to internal `CUSTOMER` IDs and
pseudonymous `CHECKOUT_EMAIL` subjects derived from the immutable checkout
email snapshot. Raw email is not stored in velocity events.

## Policy Versioning

KS-09-01 evaluations store `KS09_POLICY_V1`. KS-09-02 velocity-enabled
evaluations store `KS09_POLICY_V2`. Historical decisions must not be silently
reinterpreted under a later policy.

The policy version is part of both the stored evaluation identity and the fact
fingerprint input. A later `KS09_POLICY_V2` evaluation for the same order facts
must be evaluated and approved independently; a `KS09_POLICY_V1` approval is not
blanket authority for later policy versions.

## Fact Fingerprint

The service canonicalizes the trusted fact snapshot and stores a SHA-256 fact
fingerprint. The fingerprint supports idempotency, explainability and safe
re-evaluation detection. It is not authentication authority and does not hash
secrets.

Fingerprint inputs are:

- order ID;
- optional customer ID;
- customer verification state;
- checkout email snapshot presence;
- order amount minor;
- currency;
- order status;
- payment status;
- order risk status;
- order creation timestamp;
- policy version;
- velocity aggregate facts when evaluating under `KS09_POLICY_V2`.

The fingerprint intentionally excludes volatile values such as correlation IDs,
random IDs, audit timestamps and repository fetch timestamps. Velocity
`evaluatedAt` is not fingerprinted; the stable aggregate result for that
evaluation is.

## Rules

KS-09-01 ships a deliberately conservative deterministic rule set:

| Rule ID                           | Condition                                              | Decision       | Reason Code                                                  |
| --------------------------------- | ------------------------------------------------------ | -------------- | ------------------------------------------------------------ |
| `RISK_AMOUNT_VALID`               | amount minor is zero or negative                       | `DENY`         | `INVALID_ORDER_AMOUNT`                                       |
| `RISK_ORDER_STATE_VALID`          | order is `CANCELLED`, `FAILED` or `REFUNDED`           | `DENY`         | `ORDER_STATE_INVALID`                                        |
| `RISK_PAYMENT_CAPTURED`           | payment status is not `CAPTURED`                       | `REVIEW`       | `PAYMENT_NOT_CONFIRMED`                                      |
| `RISK_CUSTOMER_VERIFICATION`      | owned customer exists and is explicitly unverified     | `REVIEW`       | `CUSTOMER_UNVERIFIED`                                        |
| `RISK_EXISTING_ORDER_RISK_STATUS` | existing order risk status is review-required/rejected | review or deny | `MANUAL_REVIEW_POLICY_MATCH` or `ORDER_STATE_INVALID`        |
| currency support check            | currency outside configured supported set              | `REVIEW`       | `CURRENCY_UNSUPPORTED`                                       |
| rule exception guard              | any rule throws                                        | `REVIEW`       | `RISK_RULE_EXCEPTION`                                        |
| velocity unavailable              | required velocity facts unavailable                    | `REVIEW`       | `VELOCITY_SIGNAL_UNAVAILABLE`                                |
| velocity timestamp anomaly        | future velocity event exists                           | `REVIEW`       | `VELOCITY_TIMESTAMP_ANOMALY`                                 |
| velocity count threshold          | configured count threshold crossed                     | review or deny | `VELOCITY_ORDER_COUNT_REVIEW` or `VELOCITY_ORDER_COUNT_DENY` |
| velocity amount threshold         | configured amount threshold crossed                    | review or deny | `VELOCITY_AMOUNT_REVIEW` or `VELOCITY_AMOUNT_DENY`           |

Reason codes are stable, machine-readable and safe for audit/logs. They never
include PII, Product Keys, credentials or dynamic provider payloads.

Guest/unclaimed checkout is not automatically treated as fraud. Absence of an
account is separate from key-access eligibility and order-claim policy.

## Idempotency And Re-Evaluation

The persistence model is immutable evaluation history. The tuple `(orderId,
policyVersion, factFingerprint)` is unique, so repeated evaluation of unchanged
facts returns the same persisted evaluation.

When trusted facts change, the fact fingerprint changes and a new evaluation can
be persisted. Review approvals are bound to the evaluation fingerprint and do
not become blanket permanent authorization for materially changed facts.

For downstream clearance, "current fraud decision" means:

```text
load current trusted facts
-> derive current policy-versioned fact fingerprint
-> find the evaluation for orderId + current policyVersion + current fingerprint
-> apply decision/review semantics for that exact evaluation
```

It does not mean highest UUID, insertion order, arbitrary latest row or a stale
approved review for older facts. If the current facts have no matching
evaluation yet, the guard fails closed and requires re-evaluation.

Under `KS09_POLICY_V2`, current facts include current velocity aggregates. If
another trusted payment-confirmed event changes a relevant aggregate after an
earlier `ALLOW` or approved `REVIEW`, the previous decision no longer matches
the current fingerprint and downstream clearance fails closed.

## Downstream Guard

`FraudRiskService.isFraudCleared(orderId)` is the KS-09-01 downstream guard
foundation. It fails closed when:

- no decision exists;
- current trusted facts no longer match a persisted current-policy evaluation;
- the current decision is `REVIEW` and there is no matching approved review;
- the current decision is `DENY`;
- the repository is unavailable.

The guard is not broadly wired into production orchestration in KS-09-01.
Future tasks can integrate it at protected supplier procurement, key retrieval
or customer delivery transitions.

See `docs/fraud-velocity-limits.md` for KS-09-02 velocity event semantics,
windows, pseudonymization, threshold configuration and retention limitations.

## Failure Behavior

Missing facts or repository failure do not return `ALLOW`. Rule exceptions do
not get skipped to `ALLOW`; they produce `REVIEW` with `RISK_RULE_EXCEPTION`.
Errors are redacted.

Audit writes are best-effort in KS-09-01. An audit append failure does not roll
back or change the authoritative fraud-risk persistence state, and the service
does not fabricate a successful audit event when the audit port fails.

## Data Minimization

Fraud records persist IDs, reason codes, scores, timestamps, policy version and
fact fingerprints. They do not persist Product Keys, session credentials, claim
tokens, delivery capabilities, raw Stripe secrets, Kinguin credentials, raw IP,
user agent, address or billing details.

## Production Status

- PRODUCTION FRAUD POLICY APPROVED: NO
- EXTERNAL FRAUD PROVIDER CONNECTED: NO
- PRODUCTION VELOCITY POLICY APPROVED: NO
- STRIPE RADAR INTEGRATED: NO
- KINGUIN CALLED BY FRAUD EVALUATION: NO
- REAL KEY REVEAL ENABLED BY FRAUD REVIEW: NO
