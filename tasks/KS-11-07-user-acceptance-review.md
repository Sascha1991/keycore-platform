# KS-11-07 - User Acceptance Review

## Objective

Prepare a reproducible human User Acceptance Review for actual KeyRaNo customer
and operator experiences without fabricating UI, evidence, results or approval.

## Scope

- Define ROLE-UAT-01 through ROLE-UAT-05.
- Define deterministic UAT-001 through UAT-018 with human steps and expected
  business/security outcomes.
- Inventory actual browser/UI readiness and name missing Phase-12 boundaries.
- Provide a non-developer checklist, safe synthetic test-data policy and evidence
  guide.
- Store machine-readable initial results, readiness, supporting evidence,
  residual risks and human approval state.
- Add a deterministic `npm run uat:validate` CI gate and 14-day safe artifact.

No production UI, schema, payment, supplier, invoice, mail, infrastructure or
Phase-12 behavior is implemented.

## Acceptance Criteria

- [x] UAT-001 through UAT-018 exist exactly once with all required fields.
- [x] Actual customer/operator surfaces are inspected and classified honestly.
- [x] Every non-executable scenario has a reason and named Phase-12 dependency.
- [x] Initial artifacts contain no human `PASS`, reviewer or review timestamp.
- [x] Human approval is `NOT_APPROVED`; `SECURITY-READINESS` is `NOT_APPROVED`.
- [x] Automated evidence is explicitly supporting evidence, not human acceptance.
- [x] Validator rejects malformed IDs/statuses/references, fabricated approval,
      incomplete blockers and secret-shaped evidence.
- [x] Validator is deterministic, read-only and uses no network or new dependency.
- [x] CI runs validation after the existing KS-11-06 recovery gate and archives
      the complete safe package for 14 days.
- [x] Migration baseline remains 027.
- [ ] Human product owner executes applicable scenarios and records results.
- [ ] Human product owner explicitly approves or rejects KS-11-07.

## Approval Gates

Codex and CI cannot complete the two unchecked criteria. KS-11-07 preparation
does not complete human UAT, Phase 11 or the separate `SECURITY-READINESS` gate.
