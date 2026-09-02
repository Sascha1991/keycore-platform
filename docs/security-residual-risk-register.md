# KS-11-05 Residual Risk Register

| ID     | Risk                                        | Classification             | Owner                  | Rationale                                                                                      |
| ------ | ------------------------------------------- | -------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| RR-001 | Production HTTP edge and browser headers    | DEFERRED_TO_PHASE_12       | SECURITY               | No concrete production HTTP edge is repository-owned                                           |
| RR-002 | Production key-management integration       | DEFERRED_TO_PHASE_12       | SECURITY               | Current providers are development/test boundaries                                              |
| RR-003 | Production observability exporters          | DEFERRED_TO_PHASE_12       | OPERATIONS             | Safe schemas exist without a production exporter deployment                                    |
| RR-004 | Production Stripe endpoint/configuration    | DEFERRED_TO_PHASE_12       | FINANCE_ENGINEERING    | Only synthetic/test payment boundaries were assessed                                           |
| RR-005 | Supplier credentials and production network | DEFERRED_TO_PHASE_12       | OPERATIONS_SECURITY    | No supplier network or credential was used                                                     |
| RR-006 | WooCommerce production transport            | DEFERRED_TO_PHASE_12       | ENGINEERING            | Current adapter is not a deployed production edge                                              |
| RR-007 | Infrastructure WAF and edge limiting        | DEFERRED_TO_PHASE_12       | SECURITY_OPERATIONS    | Infrastructure is outside the repository boundary                                              |
| RR-008 | Repository recovery and outage proof        | ACCEPTED_FOR_CURRENT_PHASE | OPERATIONS             | KS-11-06 validates native isolated database recovery; production recovery remains Phase 12     |
| RR-009 | Customer/operator UX acceptance             | BLOCKING_UAT               | PROJECT_OWNER          | Customer results are partial and the new KS-ADMIN-01 operator surface still requires human UAT |
| RR-010 | Mutable CI action references                | DEFERRED_TO_PHASE_12       | ENGINEERING_SECURITY   | Minimal permissions reduce but do not remove upstream tag risk                                 |
| RR-011 | Synthetic-only assessment                   | ACCEPTED_FOR_CURRENT_PHASE | SECURITY               | Phase 11 prohibits production data, credentials and mutations                                  |
| RR-012 | Production Admin identity and key reveal    | DEFERRED_TO_PHASE_12       | SECURITY_PROJECT_OWNER | KS-ADMIN-01 uses a staging-only session bootstrap and keeps actual Admin key reveal disabled   |

No item is classified `BLOCKING_FINDING` in the implemented assessment. This
register does not approve `SECURITY-READINESS`; it records the current technical
scope and named follow-up ownership.

KS-11-07 details the three blocking UI groups and Phase-12 production boundaries
in `artifacts/user-acceptance/uat-residual-risks.json`. No item is accepted by an
agent: human UAT, Phase 11 and `SECURITY-READINESS` remain incomplete.
