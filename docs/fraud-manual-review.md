# Fraud Manual Review

KS-09-01 adds a durable fraud manual-review case foundation. KS-09-02 velocity
`REVIEW` decisions flow through the same `FRAUD` review case model. It does not
add a production admin UI, production operator authentication, support tickets,
dispute evidence or supplier claim workflow.

## Model

A `REVIEW` fraud decision can open one active `FRAUD` review case for the exact
fraud evaluation.

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

At most one active `FRAUD` case can exist for an evaluation. Historical or stale
cases are retained for explainability. A later evaluation created from changed
facts can open its own current review case without deleting old review history.

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
current matching evaluation/fact fingerprint/policy version. The guard reloads
current trusted facts before accepting the approval.

`REJECTED` remains blocked.

Replay resolution is idempotent/safe and does not create another case.
Once a case is resolved, later approval or rejection replays cannot flip the
durable result.

## Stale Evaluations

Review cases are tied to the evaluation ID and fact fingerprint. If facts change
or the current policy-versioned fingerprint no longer matches the case,
approval of an older review is denied as stale. An approval for old facts cannot
become blanket permanent authorization.

## Audit

Audit events:

- `FRAUD_RISK_EVALUATED`;
- `FRAUD_MANUAL_REVIEW_OPENED`;
- `FRAUD_MANUAL_REVIEW_RESOLVED`.

Audit metadata may include safe order IDs, evaluation IDs, case IDs, decision,
policy version, reason codes, fact fingerprint and safe operator reference. It
must not include Product Keys, passwords, session tokens, claim codes, delivery
capabilities, Stripe secrets or Kinguin secrets.

Audit writes are best-effort for this foundation. A failed audit append does not
change the already persisted fraud state, and no synthetic successful audit
event is produced when the audit port rejects the write.

## Future Work

KS-09-02 added velocity limits as fraud signals only. Future Phase 09 work may
add production operator UI, dispute evidence, support tickets, supplier claim
workflow and external fraud provider normalization.

## Support Case Linkage

KS-09-04 may reference fraud manual-review cases or fraud risk evaluations from
a support case as exact-order internal links. Support does not expose fraud
internals to customer projections and does not grant fraud approval,
rejection, clearance or review-resolution authority.
