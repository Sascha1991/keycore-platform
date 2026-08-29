# Acceptance Test Matrix

Specification version: 1.0.2

Critical business rules are release-blocking. A release cannot proceed while required tests for a critical rule are absent, failing, or waived without a `POLICY-EXCEPTION` approval artifact.

| Constitutional rule                   | Unit tests                       | Integration tests              | Supplier contract tests             | E2E tests                    | Security tests                   |
| ------------------------------------- | -------------------------------- | ------------------------------ | ----------------------------------- | ---------------------------- | -------------------------------- |
| Keys encrypted at rest                | encryption/decryption boundaries | vault persistence and restore  | key payload never plaintext         | customer reveal path         | ciphertext-only DB/backups       |
| Keys never leak                       | redaction helpers                | logs/traces/queues/cache scans | supplier response redaction         | checkout to reveal scan      | canary leakage tests             |
| No secrets committed                  | secret patterns                  | repository scan in CI          | fixture validation                  | release scan                 | credential detectors             |
| Germany compatibility only            | decision matrix                  | catalog publication gate       | supplier region mapping             | product visibility           | blocking evidence precedence     |
| Unknown region fail-closed            | unknown value cases              | import with unknown data       | adapter unknown fixture             | publication denied           | reason-code audit                |
| VPN offers blocked                    | VPN evidence cases               | catalog publication gate       | VPN fixture                         | product hidden               | policy exception check           |
| Idempotent payment/procurement/refund | idempotency keys                 | replay and retry workflows     | supplier duplicate purchase tests   | retry scenario               | race-condition tests             |
| No double charge                      | payment state guards             | webhook replay                 | not applicable                      | checkout replay              | provider event uniqueness        |
| No blind repeat purchase              | timeout state guards             | reconciliation job             | ambiguous timeout fixture           | delayed order flow           | manual-review escalation         |
| Production approval                   | gate validator                   | deploy pipeline gate           | supplier gate                       | release checklist            | approval artifact validation     |
| No agent production deploy            | authorization rules              | deploy workflow denial         | not applicable                      | release workflow             | audit event check                |
| Critical rules tested                 | rule registry                    | release blocker                | contract coverage                   | release suite                | security coverage                |
| Reversible migrations                 | migration metadata               | migrate/rollback               | not applicable                      | upgrade scenario             | rollback data safety             |
| External behavior documented          | doc check                        | release checklist              | adapter docs                        | user-facing path             | changelog/version check          |
| Customer key authorization            | ownership checks                 | WooCommerce identity mapping   | not applicable                      | cross-customer denial        | access-control tests             |
| Least privilege admin                 | role permissions                 | admin workflow                 | not applicable                      | support workflow             | privilege escalation tests       |
| Data minimization                     | metadata validators              | audit/event payloads           | supplier payload mapping            | customer journey             | sensitive-field scan             |
| Auditable safe events                 | event schema                     | event persistence              | supplier event mapping              | refund/dispute path          | secret-free audit scan           |
| Supplier behavior outside core        | port contract                    | adapter boundary               | all adapters                        | catalog/procurement          | dependency boundary scan         |
| Partial outage safety                 | state guards                     | outage simulations             | supplier outage fixtures            | degraded checkout            | fail-closed mutation tests       |
| Staging production isolation          | preflight configuration guards   | clean migrations and seed      | mock/sandbox only                   | staging preflight regression | secret-free fail-closed scan     |
| Critical customer/order journeys      | service state guards             | migrated PostgreSQL coherence  | supplier-neutral synthetic outcomes | E2E-001 through E2E-015      | leakage canary and safe evidence |

## Release Rule

Each implementation task must list the applicable rows from this matrix. Missing tests must be recorded as release blockers unless the affected behavior is outside the task scope and unchanged.

Detailed Phase-11 status and reconciliation with the consolidated validation
task are maintained in `docs/phase-11-acceptance-matrix.md`.
