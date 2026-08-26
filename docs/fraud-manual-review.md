# Fraud Manual Review

KS-09-01 adds a durable fraud manual-review case foundation. It does not add a
production admin UI, production operator authentication, support tickets,
dispute evidence or supplier claim workflow.

## Model

A `REVIEW` fraud decision can open one active `FRAUD` review case for the order.

Case fields include:

- case ID;
- order ID;
- source `FRAUD`;
- status: `OPEN`, `APPROVED`, `REJECTED`, `CANCELLED`;
- evaluation ID;
- fact fingerprint;
- reason codes;
- opened/resolved timestamps;
- safe operator reference when resolved.

At most one active `FRAUD` case can exist for an order.

## Distinction From Fulfillment Review

Fraud review is separate from fulfillment ambiguity and supplier/procurement
ambiguity. Existing `MANUAL_REVIEW_REQUIRED` fulfillment states represent
delivery or retrieval safety conditions, not fraud decisions.

Future shared operator queues may classify sources such as:

- `FRAUD`;
- `FULFILLMENT_DELIVERY_AMBIGUITY`;
- `SUPPORT`;
- `SUPPLIER`.

KS-09-01 implements only the `FRAUD` source.

## Authority Boundary

Manual review resolution requires `FraudManualReviewAuthorityPort`. The
production default authority fails closed. Browser/request-supplied
`approved=true`, `operatorId`, `resolution` or `riskDecision` is never
authority.

Tests may use a synthetic trusted authority, but production composition must
connect a real operator/admin authority before review resolution can be used.

## Resolution Semantics

Trusted resolution supports:

- `APPROVE`;
- `REJECT`.

Resolution is durable and audited. It does not decrypt, retrieve, display,
email or deliver Product Keys. It does not call Kinguin and does not mutate
Stripe. It changes fraud-review authorization state only.

`APPROVED` can clear `FraudRiskService.isFraudCleared(orderId)` only for the
current matching evaluation/fact fingerprint.

`REJECTED` remains blocked.

Replay resolution is idempotent/safe and does not create another case.

## Stale Evaluations

Review cases are tied to the evaluation ID and fact fingerprint. If facts change
and a new current evaluation exists, approval of an older review is denied as
stale. An approval for old facts cannot become blanket permanent authorization.

## Audit

Audit events:

- `FRAUD_RISK_EVALUATED`;
- `FRAUD_MANUAL_REVIEW_OPENED`;
- `FRAUD_MANUAL_REVIEW_RESOLVED`.

Audit metadata may include safe order IDs, evaluation IDs, case IDs, decision,
policy version, reason codes, fact fingerprint and safe operator reference. It
must not include Product Keys, passwords, session tokens, claim codes, delivery
capabilities, Stripe secrets or Kinguin secrets.

## Future Work

Future Phase 09 work may add production operator UI, velocity limits, dispute
evidence, support tickets, supplier claim workflow and external fraud provider
normalization.
