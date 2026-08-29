# KS-11-05 Security Assessment

## Scope And Release Policy

KS-11-05 actively tests the repository-owned security boundaries as SEC-001
through SEC-020. `npm run security:assessment` selects exact existing
production-facing unit and PostgreSQL tests, adds synthetic canary and
supply-chain checks, emits omission-first evidence and fails when an applicable
scenario fails or is skipped in CI. It also fails for any unresolved Critical
or High finding.

Automated success does not approve `SECURITY-READINESS`. KS-11-06 recovery and
KS-11-07 human UAT remain separate required checkpoints.

## Coverage

| ID      | Boundary                    | Assessment outcome                                                           |
| ------- | --------------------------- | ---------------------------------------------------------------------------- |
| SEC-001 | Authentication              | Session lifecycle, hash-only persistence and invalid authentication          |
| SEC-002 | Authorization and IDOR      | Cross-customer order, invoice, key and account repository denial             |
| SEC-003 | Guest claims                | Hash-only one-time claim, matching verified identity and immutable ownership |
| SEC-004 | Product Key confidentiality | Synthetic canary omission and encrypted-at-rest persistence                  |
| SEC-005 | Secret/token leakage        | Synthetic credential classes and safe transport observations                 |
| SEC-006 | Logging and audit           | Nested forbidden names and secret-shaped values rejected before persistence  |
| SEC-007 | Payments                    | Signature, identity, replay, amount and state-regression protections         |
| SEC-008 | Procurement                 | Payment/risk gates, exclusive dispatch and ambiguity reconciliation          |
| SEC-009 | Fulfillment                 | Procurement gate, lease ownership and encrypted-record invariants            |
| SEC-010 | Customer delivery           | Authentication, ownership, CSRF, Origin, rate and capability lifecycle       |
| SEC-011 | Registration                | Hash-only, expiring, one-time verification challenges                        |
| SEC-012 | Fraud/risk                  | Stale decision and unavailable velocity-signal fail-closed behavior          |
| SEC-013 | Refund/support              | Customer scoping, internal-note isolation and immutable commercial state     |
| SEC-014 | Supplier claims             | Derived authority, exact references and immutable evidence/history           |
| SEC-015 | PostgreSQL                  | Direct invalid writes rejected by security-critical invariants               |
| SEC-016 | Emergency controls          | Durable PostgreSQL authority remains fail-closed without Redis               |
| SEC-017 | Germany eligibility         | Missing, unsafe and stale evidence cannot publish an ineligible offer        |
| SEC-018 | Supply chain                | Lockfile, lifecycle scripts and workflow dependency posture reviewed         |
| SEC-019 | Static secret scan          | Shared credential and Product Key patterns remain release-blocking           |
| SEC-020 | Production browser edge     | `NOT_APPLICABLE_CURRENT_ARCHITECTURE` until a real edge is repository-owned  |

## Findings

### FIND-001 - Medium - Remediated

- Component: audit metadata validation and repository secret scanning.
- Precondition: a trusted producer or contributor places a secret-shaped value
  under a safe-looking field or uses a previously uncovered credential format.
- Exploit narrative: the previous defense emphasized forbidden field names and
  a narrower static pattern set.
- Impact: sensitive material could become durable or visible to operators or CI.
- Remediation: central audit validation now rejects representative
  secret-shaped strings and both the test assessment and repository scan use an
  expanded shared detector.
- Residual risk: pattern matching remains defense in depth; typed omission-first
  producers and external secret management remain mandatory.

### FIND-002 - Low - Open, Deferred To Phase 12

- Component: GitHub Actions dependencies.
- Precondition: compromise or malicious retargeting of an upstream mutable
  major-version action tag.
- Exploit narrative: reviewed actions use mutable major tags instead of
  immutable commit SHAs.
- Impact: CI code execution could read repository contents and synthetic CI
  service credentials.
- Mitigation: workflow permission is limited to `contents: read`, and Phase 11
  carries no production credentials.
- Owner: `ENGINEERING_SECURITY`.
- Remediation target: `PHASE_12_DEPLOYMENT_HARDENING`.

There are no unresolved Critical or High findings in the implemented
assessment definition. Every PR head must still pass the CI assessment before
that result is accepted; automated success does not grant human readiness
approval.

## Evidence Safety

Runtime tests generate synthetic Product Key, session, claim, verification,
delivery, payment, supplier, wrapping-key and webhook canaries. Evidence stores
only scenario IDs, safe reason codes, statuses, counts and durations. Raw
canaries, credentials, ciphertext, customer data and provider responses are
forbidden. The suite makes no external network call.

Evidence is written under `artifacts/security-assessment/` and archived by CI
as `ks-11-05-security-assessment-evidence` for 14 days.
