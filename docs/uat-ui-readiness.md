# KeyRaNo UAT UI Readiness

## Repository Reality

The WordPress plugin now registers native WooCommerce hooks, a branded shop
shell, product publication, account endpoints and an explicit synthetic reveal
action. A staging-only Node bridge composes existing KeyCore account and vault
services behind an HMAC-authenticated WordPress adapter.

This creates the first real browser boundary, but does not create a complete
commerce system. Live or sandbox payment submission, KeyCore order creation,
guest claim mutation, production identity, invoice documents, support/operator
interfaces and real Product Key retrieval remain absent.

## Journey Classification

| Journey                     | Classification                          | Browser capability                                                      | Remaining dependency                           |
| --------------------------- | --------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| Catalog discovery           | `EXECUTABLE_NOW`                        | Branded catalog, product, price, cart and eligibility-filtered fixtures | Human staging review                           |
| Registered purchase         | `PARTIALLY_EXECUTABLE`                  | Login, catalog, cart, checkout shell and account                        | Sandbox payment and order composition          |
| Guest purchase/messaging    | `PARTIALLY_EXECUTABLE`                  | Woo guest checkout shell                                                | KeyCore guest completion and safe messaging    |
| Guest purchase claim        | `PARTIALLY_EXECUTABLE`                  | Kauf hinzufügen shell                                                   | One-time verified-same-email adapter           |
| Product Key reveal          | `EXECUTABLE_NOW`                        | Owner-only explicit synthetic reveal                                    | Human review; real-key task remains gated      |
| Delayed/order status        | `PARTIALLY_EXECUTABLE`                  | Pending status is visible                                               | Authorized transition control                  |
| Payment failure/refund      | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | No mutation UI                                                          | Sandbox payment/refund integration             |
| Fraud review/deny           | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | No operator UI                                                          | Least-privilege risk interface                 |
| Invoice                     | `PARTIALLY_EXECUTABLE`                  | Owner-filtered availability/reference shell                             | Document provider/download                     |
| Support                     | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | No support UI                                                           | Customer/operator support interface            |
| Purchase history            | `EXECUTABLE_NOW`                        | Owner-filtered Meine Käufe and detail                                   | Human staging review                           |
| Authentication/verification | `PARTIALLY_EXECUTABLE`                  | Controlled synthetic WordPress login mapping                            | Registration and production verification       |
| Emergency/degraded state    | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Safe generic unavailable states only                                    | Authorized operations interface                |
| Full browser walkthrough    | `PARTIALLY_EXECUTABLE`                  | Discovery through synthetic reveal, excluding real purchase             | Payment, order, claim and document composition |

The machine-readable `uat-readiness.json` and `uat-results.json` remain the
binding status sources. Human acceptance is `PENDING`; no row is `PASS`, Phase
11 remains incomplete, Phase 12 is not started and `SECURITY-READINESS` remains
`NOT_APPROVED`.
