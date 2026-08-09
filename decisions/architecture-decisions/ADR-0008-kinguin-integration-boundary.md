# ADR-0008: Kinguin Integration Boundary and No-Go Gate

Status: Accepted

## Decision

Development uses MockSupplier until current official/private Kinguin Purchase/Reseller API documentation and required access exist. `REAL-SUPPLIER` approval is required before non-mock ordering.

## No-Guess Rule

The project must not guess Kinguin endpoints, authentication, payloads, pagination, rate limits, region semantics, purchase semantics, webhook signatures, key delivery, refund behavior, or tax/fee fields.

## Consequences

- Phase 04 may define interfaces, mocks, fixtures, and contract tests before real documentation exists.
- Real Kinguin integration remains blocked until documentation, credentials, sandbox or test access, contract evidence, and approval artifact are present.
