# KS-09-01: Fraud, Support, Claims, and Disputes

## Goal

Build fraud review, support case, supplier claim, refund support, and dispute evidence workflows.

## Dependencies

- KS-07-01
- KS-08-01

## Scope

- Risk rules.
- Manual review workflow.
- Velocity limits.
- Support tickets.
- Supplier claim workflow.
- Dispute evidence collection.

## Forbidden Scope

- Revealing product keys to unauthorized support roles.
- Collecting unnecessary personal data.
- Inventing supplier refund behavior.

## Deliverables

- Support and fraud workflow specification/implementation.
- Dispute evidence records.
- Supplier claim coordination.

## Acceptance Criteria

- Support access follows least privilege.
- Dispute evidence excludes secrets.
- Manual review outcomes are audited.

## Required Tests

- Role-permission tests.
- Audit metadata tests.
- Refund/dispute workflow tests.

## Risk Level

High.

## Human Approval Requirement

`POLICY-EXCEPTION` required for exceptional selling or refund policy changes.
