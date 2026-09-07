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

## Staging Retest Preparation

Use two genuinely separate browser cookie stores: keep the `PROJECT_OWNER` in
the normal browser profile and open the managed synthetic staff member in a
different browser application/profile or in a fresh private/incognito window
after closing every existing private window for that browser. Two tabs or two
ordinary windows in the same profile are not separate contexts: they share the
single host-scoped `keyrano_admin_session` cookie and the later login replaces
the earlier browser-side cookie, even though both server-side sessions remain
valid.

In the owner context, reactivate the target if necessary, set its role to
`SUPPORT`, confirm it has no sensitive individual grant, and copy only its
non-secret Admin UUID. Do not run the normal owner bootstrap between the two
retests; it intentionally rotates the owner's staging session.

On the staging server, update the branch and rebuild the bootstrap image:

```bash
git fetch origin
git checkout feature/ks-admin-02-staff-roles-audit
git pull --ff-only origin feature/ks-admin-02-staff-roles-audit
docker compose --env-file .env.staging -f infra/docker/compose.staging.yaml build keycore-admin-bootstrap
```

Choose a fresh random URL-safe value of at least 32 characters in a password
manager. Paste it silently when prompted, and provide the target UUID:

```bash
read -r -p "Synthetic staff Admin UUID: " KEYRANO_STAGING_ADMIN_UAT_TARGET_ID
read -r -s -p "Fresh runtime-only UAT session value: " KEYRANO_STAGING_ADMIN_UAT_SESSION_CODE
printf '\n'
export KEYRANO_STAGING_ADMIN_UAT_TARGET_ID KEYRANO_STAGING_ADMIN_UAT_SESSION_CODE
docker compose --env-file .env.staging -f infra/docker/compose.staging.yaml run --rm \
  -e KEYRANO_STAGING_ADMIN_UAT_SESSION_ENABLED=true \
  -e KEYRANO_STAGING_ADMIN_UAT_TARGET_ID \
  -e KEYRANO_STAGING_ADMIN_UAT_SESSION_CODE \
  keycore-admin-bootstrap \
  node --import tsx scripts/staging-admin-uat-session.ts
unset KEYRANO_STAGING_ADMIN_UAT_TARGET_ID KEYRANO_STAGING_ADMIN_UAT_SESSION_CODE
```

The command may display only safe `READY` metadata. It must not display the raw
session value. Do not place that value in `.env.staging`, shell history,
screenshots, audit evidence or this document.

### UAT-ADMIN-02-04 Retest

1. Without logging the owner out, open `/admin/login` in the separate staff
   cookie store, enter the same runtime-only value and confirm protected order
   access works with only the effective `SUPPORT` permissions.
2. Return to the owner browser and confirm its existing Dashboard and Staff
   access still work. If this fails before any owner mutation, stop and verify
   that the two windows do not share a browser profile/cookie store.
3. In the owner context, change the target from `SUPPORT` to `FINANCE`.
4. Confirm role history remains, exactly one active role remains and the current
   role is `FINANCE`.
5. Refresh or directly revisit a protected Admin URL in the old staff context.
   Confirm it is denied neutrally and no protected staff/order data appears.
6. Confirm the owner context remains authenticated and safe
   `ADMIN_ROLE_CHANGED` evidence shows previous role `SUPPORT` and
   new role `FINANCE`. Do not capture cookies or the session value.

### UAT-ADMIN-02-08 Retest

1. Keep the target active with role `FINANCE` (or restore `SUPPORT`) and run the
   preparation command again with a different fresh runtime-only value.
2. Log in with that value in the separate staff cookie store and confirm the
   session works with only the target's effective permissions. Confirm the owner
   context remains authenticated before continuing.
3. In the owner context, disable the target.
4. Refresh or directly revisit a protected Admin URL in the staff context.
   Confirm neutral denial with no staff or order disclosure.
5. Confirm the owner remains authenticated, target status is `DISABLED`, and
   safe `ADMIN_STAFF_DISABLED` evidence is present.
6. Reactivate the target in the owner context, then retry the old staff context.
   Confirm the old session remains invalid. A new explicit CLI issuance is
   required for any later session.

These instructions make the two checks executable but do not change their
`PARTIAL` status. Only the Product Owner may record `PASS` after completing the
browser retests.

## Gates

- KS-11-07 remains incomplete and unapproved.
- `SECURITY-READINESS` remains `NOT_APPROVED`.
- Production IdP/MFA, production deployment and real Product-Key reveal are not approved.
- No live Stripe or Kinguin operation is authorized by this checklist.
