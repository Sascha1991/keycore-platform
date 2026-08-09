# ADR-0007: Germany Compatibility Decision Engine

Status: Accepted

## Decision

Germany compatibility decisions are exactly `ALLOWED`, `BLOCKED`, `REVIEW_REQUIRED`, and `DISABLED`. Only `ALLOWED` may be sold or published. `REVIEW_REQUIRED` is fail-closed.

## Requirements

- Explicit DE allow, EU, Global, and Region Free may become `ALLOWED` only when no blocking evidence exists.
- Explicit DE exclusion, incompatible regions, VPN activation, and foreign-account requirements are `BLOCKED`.
- Missing evidence, contradictory evidence, and unknown region values are `REVIEW_REQUIRED`.
- Structured blocking evidence always wins.
- Free-text product titles alone are never sufficient for `ALLOWED`.
- Decisions must include machine-readable reason codes and revalidation triggers.
