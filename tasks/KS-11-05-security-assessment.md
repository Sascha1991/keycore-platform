# KS-11-05 - Security Assessment

## Objective

Add a release-blocking, repository-grounded security assessment covering
SEC-001 through SEC-020, safe evidence, findings, a threat model and residual
risk without production data, credentials, provider calls or mutations.

## Acceptance Criteria

- `npm run security:assessment` maps every SEC ID to explicit evidence.
- Applicable scenarios may skip locally without PostgreSQL, but cannot skip in
  GitHub Actions.
- Unresolved Critical or High findings fail the release gate.
- Synthetic canary leakage outside the authorized delivery boundary is zero.
- Evidence contains no raw canary, credential, Product Key or customer data.
- Security findings include severity, exploitability, impact, remediation and
  residual risk.
- SEC-020 is explicitly not applicable until the repository owns a production
  HTTP edge.
- CI archives the evidence for 14 days after the assessment runs.
- KS-11-06, KS-11-07 and `SECURITY-READINESS` remain untouched.

## Delivery

Open one PR named `KS-11-05: Add security assessment and release gate` and do
not merge it. Migration baseline 027 remains unchanged.
