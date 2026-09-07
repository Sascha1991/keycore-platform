# KS-ADMIN-02 Human UAT Checklist

Status: `PENDING / IN_REVIEW`

This checklist is prepared evidence only. No scenario is marked passed until a
human reviewer performs it in the isolated staging environment.

| ID              | Scenario                        | Expected result                                                                         | Status  |
| --------------- | ------------------------------- | --------------------------------------------------------------------------------------- | ------- |
| UAT-ADMIN-02-01 | Owner Staff List                | `PROJECT_OWNER` sees the responsive bounded staff list                                  | PENDING |
| UAT-ADMIN-02-02 | Unauthorized Direct URL         | `SUPPORT` receives neutral denial from `/admin/staff` with no staff data                | PENDING |
| UAT-ADMIN-02-03 | Create Synthetic Staff          | Owner creates a synthetic profile; no password or login credential is generated         | PENDING |
| UAT-ADMIN-02-04 | Role Change                     | `SUPPORT` to `FINANCE` retains history, leaves one active role and revokes old sessions | PENDING |
| UAT-ADMIN-02-05 | Permission Grant                | Owner grants a non-sensitive additive permission; effective rights and audit update     | PENDING |
| UAT-ADMIN-02-06 | Sensitive Permission Protection | Support/self escalation to `PRODUCT_KEY_REVEAL` is denied and audited; no key appears   | PENDING |
| UAT-ADMIN-02-07 | Last Owner Protection           | Final active owner cannot be disabled or demoted                                        | PENDING |
| UAT-ADMIN-02-08 | Staff Disable                   | Disabled synthetic staff loses all active sessions and direct access                    | PENDING |
| UAT-ADMIN-02-09 | Audit UI                        | Authorized audit reader sees bounded filters and safe metadata only                     | PENDING |
| UAT-ADMIN-02-10 | Responsive                      | Staff and audit views work at 390, 430, 500, 768 and 1280 px without document overflow  | PENDING |
| UAT-ADMIN-02-11 | DB Outage                       | Staff/audit requests fail closed with neutral temporary-unavailable output              | PENDING |
| UAT-ADMIN-02-12 | Audit Evidence                  | Role, grant and denial evidence is visible in DB/UI without secrets or Product Keys     | PENDING |

## Gates

- KS-11-07 remains incomplete and unapproved.
- `SECURITY-READINESS` remains `NOT_APPROVED`.
- Production IdP/MFA, production deployment and real Product-Key reveal are not approved.
- No live Stripe or Kinguin operation is authorized by this checklist.
