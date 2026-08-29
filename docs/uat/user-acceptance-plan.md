# KS-11-07 User Acceptance Plan

## Purpose

This plan prepares the human User Acceptance Review for KeyRaNo. It does not
claim that a customer journey has been accepted. Automated evidence proves
technical properties only; a product owner must execute and judge the actual
customer and operator experience.

## Current Decision

The repository has no KeyCore-backed browser surface. The WordPress plugin is a
metadata-only foundation shell, and the account, checkout, secure delivery,
invoice, support, fraud, refund and operations capabilities stop at domain,
persistence or transport-neutral application boundaries. UAT-001 through
UAT-018 are therefore initially
`NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY`.

KS-11-07 preparation is complete when this package validates. Human UAT,
Phase 11 and `SECURITY-READINESS` remain incomplete and not approved.

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
