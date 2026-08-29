# KS-11-07 UI Readiness

## Repository Reality

The WordPress plugin at `apps/wordpress/keycore-platform/keycore-platform.php`
contains plugin metadata, an `ABSPATH` guard and a version constant only. It
registers no WordPress/WooCommerce hooks, REST routes, shortcodes, account
endpoints, pages or rendering callbacks. The TypeScript customer APIs are
transport-neutral contracts, not a running HTTP service. Storefront publication
targets the WooCommerce REST API but does not create a customer-facing KeyCore
browser integration in this repository.

Consequently there is no actual KeyCore-backed browser storefront, account,
purchase-history, guest-claim, secure reveal, invoice, support or operator/admin
surface today. Service-level tests and CLI inspection commands are not human UAT.

## Journey Classification

| Journey                     | Classification                          | Existing capability                                      | Missing surface/adapter                               | Future owner           | Target                                       |
| --------------------------- | --------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- | ---------------------- | -------------------------------------------- |
| Catalog discovery           | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Catalog, eligibility, pricing and publication services   | KeyCore-backed storefront rendering and routing       | Storefront engineering | `PHASE_12_STOREFRONT_TRANSPORT`              |
| Registered purchase         | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Identity, order, sandbox payment and orchestration logic | Browser identity, checkout and account composition    | Commerce engineering   | `PHASE_12_CUSTOMER_CHECKOUT_INTEGRATION`     |
| Guest purchase/messaging    | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Guest order and safe instruction contracts               | WooCommerce guest checkout and rendered instructions  | Commerce engineering   | `PHASE_12_CUSTOMER_CHECKOUT_INTEGRATION`     |
| Guest purchase claim        | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Verified same-email one-time claim service               | Meine Kaeufe claim page and HTTP adapter              | Account engineering    | `PHASE_12_ACCOUNT_TRANSPORT`                 |
| Product Key reveal          | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Vault authorization, reveal and delivery services        | Authenticated secure browser endpoint and page        | Security/account       | `PHASE_12_SECURE_DELIVERY_TRANSPORT`         |
| Delayed/order status        | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Durable workflow states and account projections          | Rendered customer order status                        | Account engineering    | `PHASE_12_ACCOUNT_TRANSPORT`                 |
| Payment failure/refund      | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Idempotent payment/refund application services           | Sandbox checkout and customer/operator refund UI      | Payments engineering   | `PHASE_12_PAYMENT_AND_REFUND_UI`             |
| Fraud review/deny           | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Fraud rules, velocity and persistence                    | Safe customer status and least-privilege review UI    | Risk operations        | `PHASE_12_FRAUD_REVIEW_UI`                   |
| Invoice                     | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Authorized invoice metadata projection                   | Account route, renderer and approved invoice provider | Finance/account        | `PHASE_12_INVOICE_TRANSPORT`                 |
| Support                     | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Ownership-scoped support case services                   | Customer and least-privilege support interfaces       | Support engineering    | `PHASE_12_SUPPORT_UI`                        |
| Purchase history            | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Ownership-scoped account summary/history handlers        | WooCommerce Meine Kaeufe page                         | Account engineering    | `PHASE_12_ACCOUNT_TRANSPORT`                 |
| Authentication/verification | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Session, registration and verification services          | Approved identity provider and browser session edge   | Identity/security      | `PHASE_12_AUTHENTICATION_TRANSPORT`          |
| Emergency/degraded state    | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Operations Authority controls and readiness checks       | Authorized operations UI and rendered customer errors | Operations engineering | `PHASE_12_OPERATIONS_UI`                     |
| Full browser walkthrough    | `NOT_EXECUTABLE_AT_CURRENT_UI_BOUNDARY` | Automated application/persistence acceptance evidence    | All browser transports above; first gap is storefront | Product/engineering    | `PHASE_12_END_TO_END_STOREFRONT_INTEGRATION` |

The current local/staging Docker WordPress and WooCommerce containers are an
environment skeleton, not evidence that these KeyCore journeys exist. No new UI
is implemented by KS-11-07.
