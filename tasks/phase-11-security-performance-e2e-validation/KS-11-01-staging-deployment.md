# KS-11-01: Staging Deployment

## Goal

Provide a repeatable production-like staging foundation with isolated
credentials and synthetic data.

## Umbrella Relationship

The existing `KS-11-01-validation.md` remains the overarching Phase-11
validation requirement. This detailed task implements staging only and does not
complete any validation checkpoint numbered KS-11-02 through KS-11-07 in
`docs/phase-11-acceptance-matrix.md`.

## Scope

- Explicit LOCAL, TEST, STAGING and PRODUCTION environment identity.
- Fail-closed staging preflight and role-aware readiness.
- Isolated pinned Docker Compose staging scaffold.
- Fresh migration initialization through 026.
- Small idempotent synthetic catalog seed.
- Safe mock/sandbox supplier, Stripe test and mail-capture boundaries.
- Documented bootstrap, verification and reset.

## Forbidden Scope

- Production deployment, credentials, data, Product Keys or external mutation.
- Full E2E, 50k scale, order concurrency, security assessment, recovery drill or
  UAT execution.
- Production WordPress/WooCommerce hosting or customer journey claims.
- Historical migration modification or new business behavior.

## Acceptance Criteria

- [x] Deployment configuration is repeatable and version-pinned.
- [x] STAGING identity and staging deployment ID are explicit.
- [x] PostgreSQL, Redis, Stripe, supplier, mail, origin, encryption and
      Operations Control boundaries fail closed on unsafe staging config.
- [x] Current migrations through 026 can initialize a clean database.
- [x] Synthetic seed is small, idempotent and refuses production.
- [x] Preflight is deterministic, machine-testable and omission-first.
- [x] Readiness extends the existing role-aware health system.
- [x] Unit/integration/CI coverage uses synthetic configuration only.
- [x] Deployment, reset, limitations and remaining Phase-11 work are documented.
- [ ] Independent review and merge completed.
- [ ] `SECURITY-READINESS` human approval granted.

## Applicable Acceptance Matrix Rows

- No secrets committed.
- Production approval.
- No agent production deploy.
- Critical rules tested.
- Reversible migrations.
- External behavior documented.
- Data minimization.
- Partial outage safety.

## Human Approval

`SECURITY-READINESS` remains required for staging acceptance. Agents may prepare
evidence but cannot approve the gate.
