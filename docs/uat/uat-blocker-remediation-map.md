# UAT Browser Blocker Remediation Map

| Area                 | Remediation in this change                                                            | Remaining gate                                                    |
| -------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| KS-05-06 publication | Signed fail-closed synthetic manifest and idempotent native Woo publisher             | Durable production publisher deployment and live catalog approval |
| Catalog discovery    | KeyRaNo shop, product facts, price, cart and checkout navigation                      | Human staging review                                              |
| Phase 08 account     | Native login/account, owner-filtered Meine Käufe and detail                           | Production identity provider and durable HTTP composition         |
| Secure reveal        | Explicit owner-only synthetic vault reveal with CSRF, origin, rate and audit controls | `PRE-UAT-KEY-REAL-01`, separately approved and never automatic    |
| Guest claim          | Honest browser shell                                                                  | One-time verified-same-email browser adapter                      |
| Invoice              | Owner-filtered availability/reference shell                                           | Authorized document provider and download transport               |
| Checkout             | Navigable WooCommerce shell and no-live-payment warning                               | Sandbox payment and KeyCore order orchestration composition       |
| KS-11-07             | Previously absent browser paths now classified honestly                               | Human review remains pending; no automated PASS                   |
| Phase 12             | Not changed                                                                           | Entire phase remains NOT STARTED                                  |

This change remediates historical integration gaps without rewriting completed
foundation tasks. Partial browser availability does not make payment, guest
claim, production identity, real fulfillment or full UAT complete.
