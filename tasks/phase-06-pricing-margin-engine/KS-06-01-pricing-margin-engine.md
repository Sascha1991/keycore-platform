# KS-06-01: Pricing and Margin Engine

## Goal

Define pricing, fees, VAT-aware calculations, target margin, minimum profit, rounding, price locks, and profitability safeguards.

## Dependencies

- KS-05-01
- `TAX-INVOICE` preparation evidence where tax assumptions are used

## Scope

- Pricing inputs and outputs.
- Margin and minimum-profit rules.
- Rounding policy.
- Price locks and stale-price protection.

## Forbidden Scope

- Inventing legal or tax policy.
- Production sales without approved tax and invoicing configuration.

## Deliverables

- Pricing rule specification and implementation task output.
- Profitability safeguards.
- Documentation for external price behavior.

## Acceptance Criteria

- Prices fail closed when required tax/fee inputs are missing.
- Price locks prevent unsafe stale-price procurement.
- Externally visible pricing behavior is documented.

## Required Tests

- Unit tests for pricing rules.
- Integration tests for stale-price and lock behavior.
- Acceptance tests for missing inputs.

## Risk Level

High.

## Human Approval Requirement

`TAX-INVOICE` required before production sales.
