# UAT Browser Blocker Remediation Map

| Area                 | Remediation in this change                                                            | Remaining gate                                                    |
| -------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| KS-05-06 publication | Signed fail-closed synthetic manifest and idempotent native Woo publisher             | Durable production publisher deployment and live catalog approval |
| Catalog discovery    | KeyRaNo shop, product facts, price, cart and checkout navigation                      | Human staging review                                              |
| Phase 08 account     | Native login/account, owner-filtered Meine Käufe and detail                           | Production identity provider and durable HTTP composition         |
| Secure reveal        | Explicit owner-only synthetic vault reveal with CSRF, origin, rate and audit controls | `PRE-UAT-KEY-REAL-01`, separately approved and never automatic    |
| Guest claim          | One-time verified-same-email browser adapter; UAT-004/UAT-005/UAT-015 passed          | Production identity remains separately gated                      |
| Invoice              | Owner-only deterministic PDF through the signed staging bridge; UAT-012 passed        | Production tax/provider approval                                  |
| Checkout             | Synthetic payment and KeyCore order orchestration compose the registered journey      | Guest/failure/fulfillment paths remain separately gated           |
| KS-11-07             | Eight scoped Human-UAT scenarios passed                                               | Ten scenarios and complete human approval remain open             |
| Phase 12             | Narrow registered-customer checkout integration completed on the feature branch       | Broader production-readiness work and approvals remain gated      |

This change remediates historical integration gaps without rewriting completed
foundation tasks. The scoped claim and invoice Human-UAT results do not make
payment, production identity, real fulfillment or full UAT complete.
