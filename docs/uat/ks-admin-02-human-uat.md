# KS-ADMIN-02 Human UAT Checklist

Status: `IN_REVIEW / NOT_APPROVED`

The product owner executed this scoped checklist in the isolated staging
environment. Ten scenarios passed and two are `PARTIAL` because their required
session effects could not be exercised with the available synthetic profile.
`PARTIAL` records verified behavior without representing a complete pass.

| ID              | Scenario                        | Expected result                                                                         | Status  |
| --------------- | ------------------------------- | --------------------------------------------------------------------------------------- | ------- |
| UAT-ADMIN-02-01 | Owner Staff List                | `PROJECT_OWNER` sees the responsive bounded staff list                                  | PASS    |
| UAT-ADMIN-02-02 | Unauthorized Direct URL         | `SUPPORT` receives neutral denial from `/admin/staff` with no staff data                | PASS    |
| UAT-ADMIN-02-03 | Create Synthetic Staff          | Owner creates a synthetic profile; no password or login credential is generated         | PASS    |
| UAT-ADMIN-02-04 | Role Change                     | `SUPPORT` to `FINANCE` retains history, leaves one active role and revokes old sessions | PARTIAL |
| UAT-ADMIN-02-05 | Permission Grant                | Owner grants a non-sensitive additive permission; effective rights and audit update     | PASS    |
| UAT-ADMIN-02-06 | Sensitive Permission Protection | Support/self escalation to `PRODUCT_KEY_REVEAL` is denied and audited; no key appears   | PASS    |
| UAT-ADMIN-02-07 | Last Owner Protection           | Final active owner cannot be disabled or demoted                                        | PASS    |
| UAT-ADMIN-02-08 | Staff Disable                   | Disabled synthetic staff loses all active sessions and direct access                    | PARTIAL |
| UAT-ADMIN-02-09 | Audit UI                        | Authorized audit reader sees bounded filters and safe metadata only                     | PASS    |
| UAT-ADMIN-02-10 | Responsive                      | Staff and audit views work at 390, 430, 500, 768 and 1280 px without document overflow  | PASS    |
| UAT-ADMIN-02-11 | DB Outage                       | Staff/audit requests fail closed with neutral temporary-unavailable output              | PASS    |
| UAT-ADMIN-02-12 | Audit Evidence                  | Role, grant and denial evidence is visible in DB/UI without secrets or Product Keys     | PASS    |

## Verified Evidence

- UAT-ADMIN-02-04 changed `SUPPORT` to `FINANCE`, retained role history, left
  exactly one active role and showed the expected UI and audit evidence. Session
  revocation remains unverified because the synthetic profile has no login
  mechanism or active staff session.
- UAT-ADMIN-02-05 granted additive `AUDIT_VIEW`, updated effective permissions
  and showed `ADMIN_PERMISSION_GRANTED` in the audit view.
- UAT-ADMIN-02-06 denied a prohibited sensitive escalation fail-closed, exposed
  no Product Key and provided denial evidence in the audit view.
- UAT-ADMIN-02-07 prevented demotion of the final active `PROJECT_OWNER` to
  `SUPPORT` and showed `ADMIN_LAST_OWNER_PROTECTED` with outcome `DENIED`.
- UAT-ADMIN-02-08 disabled the synthetic profile, changed its status to
  `DISABLED`, offered reactivation and showed `ADMIN_STAFF_DISABLED` with
  outcome `SUCCEEDED`. Session and direct-access revocation remain unverified
  because this profile has no login identifier, password or active session.
- UAT-ADMIN-02-09 confirmed authorized audit access, bounded safe metadata and a
  working reason-code filter that returned the expected
  `ADMIN_STAFF_DISABLED` entry.
- UAT-ADMIN-02-10 passed at 390, 430, 500, 768 and 1280 px without document-wide
  horizontal overflow. Some audit columns wrap heavily around 1280 px; this is
  a non-blocking presentation observation.
- UAT-ADMIN-02-11 confirmed neutral fail-closed output during a controlled
  PostgreSQL outage and normal recovery after restart. No stale staff/audit
  data, stack trace, database error or internal detail was shown.
- UAT-ADMIN-02-12 confirmed role-change, permission-grant and last-owner-denial
  evidence with the expected safe metadata. No password, session code, secret
  or Product Key was visible.

## Additional Observation

A separate self-disable attempt was also denied neutrally, but no corresponding
denied audit entry was visible. This does not change the PASS result for the
tested last-owner protection requirement and remains a documented observation.

## Completion Assessment

The checklist was executed, but it is not completely passed. The repository's
acceptance rules require every applicable scenario to pass before approval.
UAT-ADMIN-02-04 and UAT-ADMIN-02-08 therefore remain open for a future human
retest with a synthetic staff identity that has its own active session and
direct-access capability.

## Gates

- KS-11-07 remains incomplete and unapproved.
- `SECURITY-READINESS` remains `NOT_APPROVED`.
- Production IdP/MFA, production deployment and real Product-Key reveal are not approved.
- No live Stripe or Kinguin operation is authorized by this checklist.
