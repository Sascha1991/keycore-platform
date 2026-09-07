# KS-ADMIN-02 Human UAT Checklist

Status: `PASS`

The Product Owner completed all twelve scoped scenarios in the isolated
staging environment. This result accepts only the KS-ADMIN-02 Human-UAT scope;
it does not approve production authentication, deployment or broader security
readiness.

| ID              | Scenario                        | Expected result                                                                         | Status |
| --------------- | ------------------------------- | --------------------------------------------------------------------------------------- | ------ |
| UAT-ADMIN-02-01 | Owner Staff List                | `PROJECT_OWNER` sees the responsive bounded staff list                                  | PASS   |
| UAT-ADMIN-02-02 | Unauthorized Direct URL         | `SUPPORT` receives neutral denial from `/admin/staff` with no staff data                | PASS   |
| UAT-ADMIN-02-03 | Create Synthetic Staff          | Owner creates a synthetic profile; no password or login credential is generated         | PASS   |
| UAT-ADMIN-02-04 | Role Change                     | `SUPPORT` to `FINANCE` retains history, leaves one active role and revokes old sessions | PASS   |
| UAT-ADMIN-02-05 | Permission Grant                | Owner grants a non-sensitive additive permission; effective rights and audit update     | PASS   |
| UAT-ADMIN-02-06 | Sensitive Permission Protection | Support/self escalation to `PRODUCT_KEY_REVEAL` is denied and audited; no key appears   | PASS   |
| UAT-ADMIN-02-07 | Last Owner Protection           | Final active owner cannot be disabled or demoted                                        | PASS   |
| UAT-ADMIN-02-08 | Staff Disable                   | Disabled synthetic staff loses all active sessions and direct access                    | PASS   |
| UAT-ADMIN-02-09 | Audit UI                        | Authorized audit reader sees bounded filters and safe metadata only                     | PASS   |
| UAT-ADMIN-02-10 | Responsive                      | Staff and audit views work at 390, 430, 500, 768 and 1280 px without document overflow  | PASS   |
| UAT-ADMIN-02-11 | DB Outage                       | Staff/audit requests fail closed with neutral temporary-unavailable output              | PASS   |
| UAT-ADMIN-02-12 | Audit Evidence                  | Role, grant and denial evidence is visible in DB/UI without secrets or Product Keys     | PASS   |

## Completed Role-Change Retest

UAT-ADMIN-02-04 passed on the managed synthetic staff identity
`1e349231-8581-4205-85f9-369249b2ddd7`:

1. The `PROJECT_OWNER` remained authenticated in the normal browser profile.
2. The active `SUPPORT` identity received a fresh guarded staging session with
   safe result `READY` and authenticated in a separate fresh incognito cookie
   store.
3. Both identities remained authenticated concurrently with only their
   effective permissions.
4. The owner changed the target role from `SUPPORT` to `FINANCE`.
5. The old staff session was rejected neutrally on its next protected request;
   no protected Admin data remained accessible.
6. The owner session remained authenticated and functional.
7. Audit evidence showed `ADMIN_ROLE_CHANGED`, outcome `SUCCEEDED`, the correct
   target Admin ID, previous role `SUPPORT` and new role `FINANCE`.
8. Subsequent revoked access showed `ADMIN_SESSION_UNAVAILABLE` with outcome
   `DENIED`. No raw session value or cookie appeared in the evidence.

## Completed Disable/Reactivation Retest

UAT-ADMIN-02-08 passed on the same managed synthetic staff identity:

1. The active `FINANCE` identity received a fresh guarded staging session and
   authenticated in a fresh isolated incognito cookie store while the owner
   remained authenticated.
2. The owner disabled the target identity. Its existing session was rejected
   immediately on the next protected request without protected-data exposure.
3. The owner remained authenticated and functional.
4. Audit evidence showed `ADMIN_STAFF_DISABLED`, outcome `SUCCEEDED`, and the
   correct target Admin ID. Revoked access showed
   `ADMIN_SESSION_UNAVAILABLE`, outcome `DENIED`.
5. The owner reactivated the identity without issuing a new session. The old
   `FINANCE` session remained invalid and returned a neutral unavailable login
   response. Reactivation did not revive it.

## Previously Verified Evidence

- UAT-ADMIN-02-05 granted additive `AUDIT_VIEW`, updated effective permissions
  and showed `ADMIN_PERMISSION_GRANTED` in the audit view.
- UAT-ADMIN-02-06 denied prohibited sensitive escalation fail-closed, exposed
  no Product Key and provided denial evidence.
- UAT-ADMIN-02-07 prevented demotion of the final active `PROJECT_OWNER` and
  showed `ADMIN_LAST_OWNER_PROTECTED` with outcome `DENIED`.
- UAT-ADMIN-02-09 confirmed authorized bounded audit access, safe metadata and
  the reason-code filter.
- UAT-ADMIN-02-10 passed at 390, 430, 500, 768 and 1280 px without
  document-wide horizontal overflow. Heavy audit-column wrapping near 1280 px
  remains a non-blocking presentation observation.
- UAT-ADMIN-02-11 confirmed neutral fail-closed output during a controlled
  PostgreSQL outage and normal recovery after restart.
- UAT-ADMIN-02-12 confirmed role-change, permission-grant and denial evidence
  without passwords, session codes, secrets or Product Keys.

The separately exercised self-disable attempt was denied and its corresponding
`ADMIN_SELF_DISABLE_DENIED` audit evidence is present. Automated service tests
also protect this denial evidence, while PostgreSQL tests protect the
transactional `ADMIN_LAST_OWNER_PROTECTED` evidence. No stale missing-audit
observation remains.

## Completion Assessment

Every applicable KS-ADMIN-02 Human-UAT scenario is now `PASS`; the task's
scoped Product Owner Human-UAT criterion is satisfied. The result does not
change any independent release or production approval gate.

## Independent Gates

- KS-11-07 remains incomplete and unapproved.
- `SECURITY-READINESS` remains `NOT_APPROVED`.
- Production IdP/MFA, production deployment and real Product-Key reveal remain
  unapproved.
- No live Stripe or Kinguin operation is authorized by this checklist.
