# KeyRaNo UAT UI Readiness

## Repository Reality

The WordPress plugin now registers native WooCommerce hooks, product
publication, account endpoints, an explicit synthetic reveal action and three
registered-customer-only synthetic checkout outcomes. A staging-only Node
bridge composes existing KeyCore account, PriceLock, order, payment, ownership
and vault services behind an HMAC-authenticated WordPress adapter.

This creates an executable synthetic registered-customer checkout boundary, but
does not create a complete commerce system. Live payment, procurement,
fulfillment for the resulting order, guest claim mutation, production identity,
invoice documents, support/operator interfaces and real Product Key retrieval
remain absent.

## Journey Classification

| Journey                     | Classification                          | Browser capability                                                                        | Remaining dependency                                        |
| --------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Catalog discovery           | `EXECUTABLE_NOW` / `PASS`               | Branded catalog, product, price, cart and eligibility-filtered fixtures                   | None for scoped UAT-001 result                              |
| Registered purchase         | `EXECUTABLE_NOW` / `PASS`               | Login, catalog, cart, synthetic payment, authoritative owned order and account projection | None for scoped UAT-002 result                              |
| Guest purchase/messaging    | `PARTIALLY_EXECUTABLE`                  | Woo guest checkout shell                                                                  | KeyCore guest completion and safe messaging                 |
| Guest purchase claim        | `PARTIALLY_EXECUTABLE`                  | Kauf hinzufügen shell                                                                     | One-time verified-same-email adapter                        |
| Product Key reveal          | `EXECUTABLE_NOW` / `PASS`               | Owner-only explicit synthetic reveal                                                      | Real-key task remains gated                                 |
| Delayed/order status        | `PARTIALLY_EXECUTABLE`                  | Pending status is visible                                                                 | Authorized transition control                               |
| Payment failure/refund      | `PARTIALLY_EXECUTABLE`                  | Explicit synthetic failure/cancel paths; no captured order                                | Refund UI remains outside this task                         |
| Fraud review/deny           | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | No operator UI                                                                            | Least-privilege risk interface                              |
| Invoice                     | `PARTIALLY_EXECUTABLE`                  | Owner-filtered availability/reference shell                                               | Document provider/download                                  |
| Support                     | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | No support UI                                                                             | Customer/operator support interface                         |
| Purchase history            | `EXECUTABLE_NOW`                        | Owner-filtered Meine Käufe and detail                                                     | Human staging review                                        |
| Authentication/verification | `PARTIALLY_EXECUTABLE`                  | Controlled synthetic WordPress login mapping                                              | Registration and production verification                    |
| Emergency/degraded state    | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Safe generic unavailable states only                                                      | Authorized operations interface                             |
| Full browser walkthrough    | `PARTIALLY_EXECUTABLE`                  | Discovery through resulting synthetic paid order and existing account shell               | Procurement/fulfillment linkage, claim and invoice document |

The machine-readable `uat-readiness.json` and `uat-results.json` remain the
binding status sources. Human acceptance is `IN_REVIEW`; UAT-001, UAT-002 and
UAT-006 are `PASS`, while purchase history does not complete the broader Guest
Claim scenario. Phase 11 remains incomplete and `SECURITY-READINESS` remains
`NOT_APPROVED`.
