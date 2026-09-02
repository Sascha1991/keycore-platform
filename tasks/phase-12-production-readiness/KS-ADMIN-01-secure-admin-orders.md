# KS-ADMIN-01 - Secure Admin Foundation and Orders

## Objective

Create a separate, fail-closed internal KeyRaNo administrator foundation with
authenticated role-based access, safe order operations and an explicit audited
Product-Key access boundary.

## Acceptance criteria

- [x] Admin identities, role assignments and hash-only sessions are separate
      from customer and WordPress identities.
- [x] Protected routes enforce server-side authentication and explicit
      capabilities before repository access.
- [x] Dashboard and deterministic bounded order list/search/detail views reuse
      authoritative KeyCore PostgreSQL records.
- [x] Order search is exact, parameterized and cursor pagination is signed and
      filter-bound.
- [x] Normal views never select or return Product-Key material.
- [x] Product-Key access is POST-only, capability-controlled, origin/CSRF-bound
      and audited; actual decryption remains fail-closed and disabled.
- [x] Authentication, reads, denials and reveal attempts are audit events with
      safe omission-first metadata.
- [x] Staging bootstrap and deployment are explicit, isolated and secret-free
      in committed configuration.
- [x] Migration 028 is reversible and does not weaken existing constraints.
- [x] Automated unit, HTTP, PostgreSQL, Compose and regression checks exist.
- [ ] Product owner completes focused Admin browser UAT.
- [ ] Authorized security reviewer approves production IdP/MFA, role lifecycle,
      network boundary and any future real reveal workflow.

## Non-approvals

This task does not approve production deployment, real Product-Key reveal,
live Stripe or Kinguin use, KS-11-07 or `SECURITY-READINESS`.
