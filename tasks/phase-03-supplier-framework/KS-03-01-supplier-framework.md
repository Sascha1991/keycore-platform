# KS-03-01: Supplier Framework and MockSupplier

## Goal

Create the supplier port, adapter contract, and MockSupplier behavior for deterministic development and testing.

## Dependencies

- KS-02-01
- ADR-0001
- ADR-0008

## Scope

- Supplier capability model.
- Offer normalization.
- Contract tests.
- MockSupplier with at least 50,000 deterministic synthetic products.
- Mock scenarios for DE, EU, Global, US, LATAM, CIS, Asia, unknown regions, contradictory metadata, VPN activation, stock changes, price changes, API delays, rate limits, outages, ambiguous purchase timeouts, delayed key delivery, and refund capability.

## Forbidden Scope

- Real Kinguin endpoints, authentication, payloads, pagination, rate limits, webhook signatures, key delivery, refund behavior, tax fields, or credentials.
- Real keys or customer data.

## Deliverables

- Supplier port specification.
- MockSupplier fixtures and deterministic generation rules.
- Supplier contract test suite.

## Acceptance Criteria

- MockSupplier never emits real keys or customer data.
- Contract tests cover all required mock scenarios.
- Core code has no supplier-specific mappings.

## Required Tests

- Supplier contract tests.
- Fixture determinism tests.
- Secret/key leakage tests.

## Risk Level

High.

## Human Approval Requirement

`REAL-SUPPLIER` approval is required before replacing MockSupplier with real ordering.
