# UAT Browser Blocker Remediation Map

| Area                 | Remediation in this change                                                            | Remaining gate                                                       |
| -------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| KS-05-06 publication | Signed fail-closed synthetic manifest and idempotent native Woo publisher             | Durable production publisher deployment and live catalog approval    |
| Catalog discovery    | KeyRaNo shop, product facts, price, cart and checkout navigation                      | Human staging review                                                 |
| Phase 08 account     | Native login/account, owner-filtered Meine Käufe and detail                           | Production identity provider and durable HTTP composition            |
| Secure reveal        | Explicit owner-only synthetic vault reveal with CSRF, origin, rate and audit controls | `PRE-UAT-KEY-REAL-01`, separately approved and never automatic       |
| Guest claim          | Honest browser shell                                                                  | One-time verified-same-email browser adapter                         |
| Invoice              | Owner-only deterministic PDF through the signed staging bridge                        | Human UAT evidence and production tax/provider approval              |
| Checkout             | Synthetic payment and KeyCore order orchestration compose the registered journey      | Guest/failure/fulfillment paths remain separately gated              |
| KS-11-07             | UAT-001/UAT-002/UAT-006 passed; UAT-015/UAT-018 reconciled step by step               | Complete human review remains pending behind named integration gates |
| Phase 12             | Narrow registered-customer checkout integration completed on the feature branch       | Broader production-readiness work and approvals remain gated         |

This change remediates historical integration gaps without rewriting completed
foundation tasks. Partial browser availability does not make payment, guest
claim, production identity, real fulfillment or full UAT complete. The synthetic
invoice action is executable but has no human acceptance result.
