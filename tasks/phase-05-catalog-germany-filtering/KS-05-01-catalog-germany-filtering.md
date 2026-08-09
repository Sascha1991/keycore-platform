# KS-05-01: Catalog and Germany Filtering

## Goal

Import and synchronize supplier offers while publishing only `ALLOWED` Germany-compatible offers.

## Dependencies

- KS-03-01
- ADR-0007

## Scope

- Full and incremental catalog import.
- Germany compatibility decision engine.
- Product grouping.
- WooCommerce publication gates.
- Search indexing of publishable offers.
- Revalidation triggers and reason codes.

## Forbidden Scope

- Publishing `REVIEW_REQUIRED`, `BLOCKED`, or `DISABLED` offers.
- Using free-text product titles alone for `ALLOWED`.
- Real supplier integration unless Phase 04 approval exists.

## Deliverables

- Catalog import workflow.
- Germany compatibility decision records.
- Publication gate.
- Revalidation jobs.

## Acceptance Criteria

- Only `ALLOWED` offers are published or sold.
- Structured blocking evidence always wins.
- Unknown, missing, or contradictory region data fails closed.

## Required Tests

- Unit tests for the full decision matrix.
- Integration tests for import and publication gates.
- Supplier contract tests for region metadata mapping.

## Risk Level

Critical.

## Human Approval Requirement

`POLICY-EXCEPTION` required for any future VPN policy change.
