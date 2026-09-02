# KeyCore Security Threat Model

## Assets

Protected assets are Product Keys, customer identity and ownership, session and
claim credentials, payment and fraud state, supplier purchase authority,
commercial state, audit history, emergency controls and configuration secrets.
PostgreSQL is durable authority; Redis is never correctness authority.

| Trust boundary         | Attacker capability and entry point                            | Trust assumption                                                       | Existing mitigation and evidence                             | Residual risk                                           |
| ---------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| Anonymous browser      | Guess IDs/tokens, replay requests, forge transport fields      | No anonymous assertion is trusted                                      | SEC-001, SEC-003, SEC-010 and one-time hash-only credentials | Production edge controls deferred to Phase 12           |
| Authenticated customer | Attempt horizontal access or claim another order               | Session identity is authoritative, email/order ID is not proof         | SEC-001 through SEC-003 and SQL-scoped ownership             | KS-11-07 human UX review                                |
| WooCommerce adapter    | Supply stale or forged storefront/catalog data                 | Adapter input is untrusted until normalized and policy-checked         | SEC-010, SEC-017 and fail-closed publication                 | Production transport deferred to Phase 12               |
| KeyCore services       | Bug or unsafe metadata producer                                | Domain gates precede effects and metadata is omission-first            | SEC-005 through SEC-014                                      | Pattern matching cannot replace least privilege         |
| PostgreSQL             | Direct invalid write or concurrent transaction                 | Constraints and transactions are final durable guards                  | SEC-003, SEC-007 through SEC-016                             | Recovery validation deferred to KS-11-06                |
| Redis                  | Loss, delay, duplicate or unavailable cache/queue              | Redis is recoverable delivery infrastructure only                      | SEC-008 and SEC-016 authority tests                          | Outage exercise deferred to KS-11-06                    |
| Stripe                 | Forged/replayed webhook or mismatched payment                  | Signature and immutable provider identity are required                 | SEC-007                                                      | Production endpoint/configuration deferred to Phase 12  |
| Supplier/Kinguin       | Ambiguous response, duplicate request or unsafe payload        | Supplier output is untrusted and purchase identity is durable          | SEC-008, SEC-009 and SEC-014                                 | Production credentials/network deferred to Phase 12     |
| Email transport        | Message observation or replayed link                           | Ordinary mail contains no Product Key; tokens are bounded              | SEC-003 through SEC-005 and SEC-011                          | Production mail transport deferred to Phase 12          |
| Operations/admin       | Forged authority, unsafe metadata or paused-operation bypass   | Authority is derived and durable controls deny by default              | SEC-006, SEC-013, SEC-014 and SEC-016                        | Human operating procedures remain Phase 12              |
| Admin browser          | Reuse customer sessions, force sensitive POSTs or bypass roles | Separate current Admin session and server-side capability are required | KS-ADMIN-01 hash-only sessions, exact origin/CSRF and audit  | Production IdP/MFA, edge controls and Admin UAT pending |
| Vault/key management   | Ciphertext swap, malformed material or key disclosure          | Authenticated context binds ciphertext; plaintext is boundary-limited  | SEC-004, SEC-009 and SEC-015                                 | Production KMS integration deferred to Phase 12         |

This model covers repository-owned behavior only. It does not claim a deployed
WAF, production HTTP edge, production KMS, observability exporter or external
provider configuration.
