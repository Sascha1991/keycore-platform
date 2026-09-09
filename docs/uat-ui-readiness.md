# KeyRaNo UAT UI Readiness

## Repository Reality

The WordPress plugin now registers native WooCommerce hooks, product
publication, account endpoints, an explicit synthetic reveal and Guest Claim action and three
registered-customer-only synthetic checkout outcomes. A staging-only Node
bridge composes existing KeyCore account, PriceLock, order, payment, ownership
claim, ownership and vault services behind an HMAC-authenticated WordPress adapter.

This creates executable synthetic registered-customer checkout and delayed
fulfillment boundaries, but does not create a complete commerce system. Live
payment, real supplier procurement and fulfillment, production identity,
production invoice documents, broader support/operator interfaces and real
Product Key retrieval remain absent.

## Journey Classification

| Journey                     | Classification                          | Browser capability                                                                        | Remaining dependency                                                   |
| --------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Catalog discovery           | `EXECUTABLE_NOW` / `PASS`               | Branded catalog, product, price, cart and eligibility-filtered fixtures                   | None for scoped UAT-001 result                                         |
| Registered purchase         | `EXECUTABLE_NOW` / `PASS`               | Login, catalog, cart, synthetic payment, authoritative owned order and account projection | None for scoped UAT-002 result                                         |
| Guest purchase/messaging    | `EXECUTABLE_NOW` / `PASS`               | Logged-out synthetic checkout, safe confirmation and private Mailpit claim delivery       | None for scoped UAT-003 result                                         |
| Guest purchase claim        | `EXECUTABLE_NOW` / `PASS`               | One-time verified-same-email synthetic claim through Kauf hinzufügen                      | None for scoped UAT-004/UAT-005/UAT-015 results                        |
| Product Key reveal          | `EXECUTABLE_NOW` / `PASS`               | Owner-only explicit synthetic reveal                                                      | Real-key task remains gated                                            |
| Delayed/order status        | `EXECUTABLE_NOW` / `PASS`               | Pending owner view, authorized synthetic transition, ready view and status-only mail      | Real supplier fulfillment and production KMS remain gated              |
| Payment failure/refund      | `PARTIALLY_EXECUTABLE` / UAT-009 `PASS` | Stable synthetic failure/cancel results with fresh-cart retry; no captured payment        | Refund UI remains outside this task                                    |
| Fraud review/deny           | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | No operator UI                                                                            | Least-privilege risk interface                                         |
| Invoice                     | `EXECUTABLE_NOW` / `PASS`               | Owner-only deterministic synthetic PDF through the signed account bridge                  | Production tax/provider approval remains separate                      |
| Support                     | `READY_AFTER_ADMIN_PANEL_DEPLOYMENT`    | Ownership-scoped customer cases and least-privilege operator workflow                     | Human staging execution for UAT-014                                    |
| Purchase history            | `EXECUTABLE_NOW` / `PASS`               | Owner-filtered Meine Käufe and detail                                                     | None for scoped UAT-015 result                                         |
| Authentication/verification | `PARTIALLY_EXECUTABLE`                  | Controlled synthetic WordPress login mapping                                              | Registration and production verification                               |
| Emergency/degraded state    | `READY_AFTER_ADMIN_PANEL_DEPLOYMENT`    | Authorized checkout pause/resume and fail-closed customer mutation path                   | Human staging execution and mandatory control restoration for UAT-017  |
| Full browser walkthrough    | `EXECUTABLE_NOW` / `PASS`               | Discovery, synthetic checkout, account, claim, reveal and invoice surfaces                | None for scoped UAT-018 result; broader production gates remain closed |

The machine-readable `uat-readiness.json` and `uat-results.json` remain the
binding status sources. Human acceptance is `IN_REVIEW`; UAT-001, UAT-002,
UAT-003, UAT-004, UAT-005, UAT-006, UAT-007, UAT-009, UAT-012, UAT-015 and
UAT-018 are `PASS`. Seven required scenarios remain pending or not executable, so Phase 11
remains incomplete and `SECURITY-READINESS` remains `NOT_APPROVED`. Admin
Panel V1 readiness is documented separately and does not change machine-readable
or Human-UAT status before deployment and explicit human execution.
