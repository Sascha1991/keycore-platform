# KS-ADMIN-02 - Staff, Roles and Audit

## Objective

Extend the existing KeyRaNo Admin foundation with least-privilege staff
identity management, single active role assignments, additive individual
permission grants and a bounded, redacted audit view.

## Acceptance criteria

- [x] Existing Admin identities are extended without introducing passwords or a parallel authentication system.
- [x] Staff list/detail routes and every mutation enforce server-side capabilities.
- [x] Role changes retain history, allow one active role and revoke active target sessions.
- [x] Disable and critical permission changes revoke active target sessions.
- [x] The final active `PROJECT_OWNER` cannot be disabled or demoted.
- [x] Effective capabilities are the union of role defaults and active additive grants.
- [x] Sensitive self-grants and grants by non-owners fail closed.
- [x] Successful staff mutations and denied escalation attempts are safely audited.
- [x] Audit list filters and signed keyset pagination are bounded and disclose only allowlisted metadata.
- [x] Migration 029 is reversible and covered by PostgreSQL/recovery tests.
- [x] Staff and audit views remain usable at mobile and desktop widths.
- [x] Existing login, orders and fail-closed Product-Key behavior remain unchanged.
- [ ] Product owner completes the documented Human-UAT checklist.

Human UAT was executed for all twelve scenarios. Ten are `PASS`; role-change
session revocation and disabled-staff session/direct-access revocation are
`PARTIAL` because the available synthetic staff profile has no login mechanism
or active session. Under the repository acceptance rules this criterion remains
open until both scenarios receive complete human verification. A guarded,
CLI-only staging helper now makes those session-revocation retests executable;
it does not change their recorded status or grant human approval.

## Non-approvals

This task does not provide production authentication, MFA, SSO or IdP
approval. It does not enable Product-Key decryption, production deployment,
live Stripe/Kinguin use, KS-11-07 or `SECURITY-READINESS`.
