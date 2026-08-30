# KS-11-07 User Acceptance Plan

## Purpose

This plan governs the human User Acceptance Review for KeyRaNo. Automated
evidence proves technical properties only; a product owner must execute and
judge the actual customer and operator experience.

## Current Decision

The repository now has a synthetic staging browser surface for catalog, product,
cart, checkout shell, mapped account purchases and explicit secure reveal.
Human review on 2026-08-30 passed UAT-001 and UAT-006. Tested portions of the
checkout and account journeys were also accepted, but their complete scenarios
remain pending because payment/order creation, guest claim and invoice documents
were outside scope.

Human acceptance is therefore `IN_REVIEW`, not `APPROVED`. Phase 11 remains
incomplete, Phase 12 is not started and `SECURITY-READINESS` remains
`NOT_APPROVED`.

## Roles

| ID          | Role                                  | Responsibility                                             |
| ----------- | ------------------------------------- | ---------------------------------------------------------- |
| ROLE-UAT-01 | Anonymous or guest customer           | Assess discovery, guest checkout and safe guest messaging  |
| ROLE-UAT-02 | Registered and verified customer      | Assess identity, checkout, claim and protected actions     |
| ROLE-UAT-03 | Customer with an existing purchase    | Assess history, invoice, fulfillment and secure key access |
| ROLE-UAT-04 | Repository-supported support/operator | Assess only workflows backed by real repository capability |
| ROLE-UAT-05 | Product owner and acceptance reviewer | Record human results and make the acceptance decision      |

No role implies an interface that does not exist. A future operator may use
only approved least-privilege tooling.

## Entry Criteria

1. The named Phase-12 browser/transport dependency for the scenario is
   implemented and deployed to approved staging.
2. Staging isolation and HTTPS preflight pass.
3. Only synthetic catalog, customer, order, payment, supplier, fulfillment and
   invoice data is loaded.
4. Sandbox payment and synthetic supplier adapters are active; production
   credentials and mutations are absent.
5. The reviewer has the checklist, safe test data and evidence guide.
6. Required operator actions have explicit authority and staging-only controls.

## Execution

1. ROLE-UAT-05 selects one scenario whose UI readiness is no longer blocked.
2. The named role follows the exact checklist without substituting service-level
   tests for browser behavior.
3. The reviewer records `PASS`, `FAIL` or `BLOCKED`, notes, safe evidence
   references, reviewer identity and UTC review time in `uat-results.json`.
4. A failure remains open until corrected and rerun. A blocker records a
   concrete reason and target dependency.
5. `npm run uat:validate` validates structure and safety; it does not judge or
   approve the result.

## Acceptance Lifecycle

The machine-readable lifecycle is:

1. `PENDING`: preparation state. No human result has been recorded and human
   approval is `NOT_APPROVED`.
2. `IN_REVIEW`: at least one human `PASS`, `FAIL` or `BLOCKED` result has a real
   reviewer, ISO-8601 UTC review time and policy-compliant evidence/notes. Human
   approval remains `NOT_APPROVED`.
3. `APPROVED`: every release-applicable scenario is `PASS`, every pass has safe
   human evidence, UAT-018 passed, and ROLE-UAT-05 explicitly records
   `APPROVED` with reviewer and UTC approval time.
4. `REJECTED`: ROLE-UAT-05 explicitly rejects UAT and at least one human `FAIL`
   remains documented.

The validator supports all four states and rejects contradictory combinations.
It checks consistency but cannot determine who edited Git. Git/PR review is the
human authority record. Codex and automation must not originate a human
decision; they may transcribe an explicit product-owner result without widening
its scope.

## Exit And Approval Criteria

Human UAT may be approved only after every release-applicable scenario has an
explicit human result, no blocking result remains, UAT-018 passes as a real
browser walkthrough, and the product owner explicitly updates
`human-approval.json`. Codex and CI cannot approve it.

`SECURITY-READINESS` is a separate human gate. Its reviewer must consider the
KS-11-05 assessment, unresolved findings, KS-11-06 recovery residual risks,
human UAT results and all remaining Phase-12 production boundaries. Green CI,
UAT approval or PR merge alone does not grant it.

## Stop Conditions

Stop immediately for production data or credentials, a live payment or supplier
request, a real Product Key, cross-customer disclosure, unsafe fallback,
unapproved operations authority, or evidence containing a secret or capability.
