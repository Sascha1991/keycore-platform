# KS-12-01: Production Readiness

## Goal

Prepare controlled production release only after all approval gates, validation evidence, rollback plans, and operational controls are complete.

## Dependencies

- KS-11-01
- `REAL-SUPPLIER` if real supplier ordering is enabled
- `LIVE-PAYMENTS` if live payment capture is enabled
- `TAX-INVOICE`
- `SECURITY-READINESS`

## Scope

- Legal and tax configuration verification.
- Production credential readiness.
- Controlled rollout plan.
- Go-live checklist.
- Rollback plan.
- Post-launch review plan.

## Forbidden Scope

- Agent-approved production deployment.
- Production release without approval artifacts.
- Policy exceptions without `POLICY-EXCEPTION`.

## Deliverables

- Production readiness checklist.
- Approval artifacts.
- Rollback notes.
- Post-launch review plan.

## Acceptance Criteria

- Required approvals exist in `docs/approvals/`.
- All release-blocking tests pass.
- Production deployment is performed only by approved humans.

## Required Tests

- Release checklist validation.
- Approval artifact validation.
- Production smoke-test plan using safe data.

## Risk Level

Critical.

## Human Approval Requirement

`PRODUCTION-RELEASE` required.
