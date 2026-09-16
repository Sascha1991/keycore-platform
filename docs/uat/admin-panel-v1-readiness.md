# Admin Panel V1 UAT Readiness

This document records technical browser readiness introduced by Admin Panel
V1. It is not Human-UAT evidence and does not change the authoritative results
in `artifacts/user-acceptance/uat-results.json`.

## V1.1 category review

Category 05/13, `Lieferanten`, is `HUMAN_ACCEPTED`. Human browser review
confirmed Supplier creation independently from integration, a truthful
no-integration state, separate staging-only synthetic-adapter setup without
fabricated credential fields, distinct master-data editing, functional search,
filters, KPIs and detail, and correct rendering of multiple Suppliers. The
existing `Staging Synthetic Mock` data remained intact. The adjacent Product
workspace remained at 10 total and active Products, four Products with Supplier
offers and four deliverable Products.

This category acceptance is not a KS-11-07 Human-UAT scenario result. The
authoritative Human-UAT total remains 11/18 PASS; Human Acceptance remains
`IN_REVIEW`, Human Approval remains `NOT_APPROVED`, and `SECURITY-READINESS`
remains `NOT_APPROVED`.

Category 06/13, `Rabatte & Kampagnen`, is
`READY_FOR_HUMAN_BROWSER_REVIEW`. Technical evidence covers Draft-first
Campaign management, percentage and fixed EUR rules, code normalization,
bounded Product eligibility, schedule/lifecycle behavior, concurrency-safe
global limits, Storefront application, failure/cancellation release and
immutable Price-Lock/Order snapshots. Automatic Campaigns, per-customer limits,
mixed carts, zero-payable Orders and refund restoration are explicitly outside
the supported initial boundary. Category 06 is not Human accepted and does not
change any KS-11-07 scenario result or approval state.

The UX correction preserves that boundary. Campaign KPI cards now provide
selected quick filters independently from the collapsed advanced filter panel;
manual filters show an active count. Create and Edit share grouped fields,
explicit unlimited/limited usage, state-preserving validation and responsive
controls. Percentage/fixed-EUR units follow the chosen rule, Product and usage
wording is natural, and consumed usage presents the operator-facing Order
reference with the UUID as secondary evidence. Selected Products continue to be
assigned immediately after Draft creation with the existing bounded server-side
search. No client script, broader CSP, automatic Campaign or provider authority
was introduced.

Local technical browser evidence covered 1600 x 950, 1280 x 720 and 1025 x 826,
including Draft creation, bounded Product assignment, explicit activation and
the real WooCommerce code/checkout path. One synthetic captured checkout
produced a consumed Campaign use with zero remaining reservations and immutable
Order evidence; a later Campaign rename did not alter that evidence. This is
technical readiness evidence only and is not Human acceptance.

Correction validation also exercised a controlled inactive fixed-EUR Draft,
retained values after a validation error, Product assignment, Edit/Cancel
behavior and responsive Campaign controls. The focused Campaign/Admin group
passed 35 tests, the focused PostgreSQL group passed 12, and the full repository
check passed 868 tests with 150 service-gated skips. Security, 16/16 E2E,
10/10 scale, 38/38 concurrency, UAT structure, audit, Compose and diff checks
passed. Category 06 remains `READY_FOR_HUMAN_BROWSER_REVIEW`.

| Scenario | Post-deployment readiness   | Admin Panel V1 contribution                                                                                 | Remaining gate                                                                                          |
| -------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| UAT-008  | `BLOCKED`                   | Order and supplier state are visible                                                                        | No approved synthetic ambiguous trigger, reconciliation action or customer-safe reconciliation state    |
| UAT-010  | `BLOCKED`                   | Authorized operators can inspect open fraud reviews                                                         | No approved REVIEW trigger/customer state or review-resolution mutation                                 |
| UAT-011  | `BLOCKED`                   | Authorized operators can inspect denied/open risk state                                                     | No approved DENY trigger/customer-safe denial journey or ordinary-progression test surface              |
| UAT-013  | `BLOCKED`                   | Finance and order payment state are visible                                                                 | No authorized idempotent synthetic refund adapter and customer refund journey                           |
| UAT-014  | `READY_FOR_HUMAN_EXECUTION` | Ownership-scoped customer Support plus least-privilege operator case detail, internal notes and transitions | Deploy to approved staging and execute the full customer/support/cross-owner scenario                   |
| UAT-016  | `BLOCKED`                   | Existing customer and Admin identities remain separate                                                      | Registration, verification and approved production-shaped IdP transport remain unresolved               |
| UAT-017  | `READY_FOR_HUMAN_EXECUTION` | Authorized versioned checkout pause/resume and customer fail-closed checkout path                           | Deploy to approved staging, use synthetic checkout only, restore the control and capture human evidence |

For UAT-014, the human review must prove that customer-visible and internal
messages remain separated and that another customer cannot access the case.
No Product Key or submitted secret may be used as support content.

For UAT-017, the bounded scenario is `CHECKOUT_CREATE`: pause it in Admin,
attempt one fresh synthetic customer checkout, confirm no order/payment/
fulfillment effect, verify read-only state remains coherent, then re-enable the
control. The test must stop if the control cannot be restored.

The machine-readable readiness/result files retain their pre-deployment state
until the repository's normal readiness reconciliation and Human-UAT workflow
is explicitly authorized. No scenario is `PASS` based on this implementation.
