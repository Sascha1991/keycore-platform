# Secure Admin Foundation and Orders

## Scope

KS-ADMIN-01 introduces the first internal KeyRaNo backoffice foundation. It is
a separate server-rendered Node transport backed by the authoritative KeyCore
PostgreSQL order, customer, fulfillment, guest-claim and audit records. It is
not a WordPress administrator extension and does not trust customer sessions.

The implemented modules are Dashboard and Bestellungen. Kunden, Produkte,
Lieferanten, Finanzen and Sicherheit are visible only as disabled navigation
labels so that no unavailable workflow is implied.

## Trust boundary

- Admin identities, roles and sessions are persisted separately from customer
  identities and WordPress sessions.
- Raw admin session values are never persisted. PostgreSQL stores an HMAC-SHA256
  correlation hash using a separately injected secret.
- Every protected request performs server-side session and capability checks.
- Disabled identities, revoked sessions, expired sessions, absent roles,
  malformed filters and backend/audit failures fail closed.
- Sensitive POSTs require an exact configured origin, an exact bounded form
  shape and an HMAC CSRF value bound to the administrator, method and path.
- Admin cookies are `HttpOnly`, `SameSite=Strict`, path-scoped and `Secure`.
  Non-Secure cookies are permitted only for explicit localhost HTTP staging.
- Responses use no-store caching, a restrictive CSP, frame denial, no-referrer
  and MIME-sniffing protection.

The staging synthetic session-code login is a development/UAT bootstrap, not a
production authentication decision. Production use requires an approved IdP,
MFA, lifecycle administration, credential rotation and network controls for
`admin.keyrano.de`.

## Roles and capabilities

| Role             | Admin access | Orders | Sensitive operation | Key reveal | Audit |
| ---------------- | ------------ | ------ | ------------------- | ---------- | ----- |
| PROJECT_OWNER    | yes          | yes    | yes                 | boundary   | yes   |
| OPERATIONS       | yes          | yes    | yes                 | no         | no    |
| SUPPORT          | yes          | yes    | no                  | no         | no    |
| FINANCE          | yes          | yes    | no                  | no         | no    |
| SECURITY_AUDITOR | yes          | no     | no                  | no         | yes   |

`boundary` means that the dedicated capability, POST, CSRF and audit controls
exist. Actual fulfillment-secret decryption is deliberately not enabled.

## Order operations

The dashboard reports aggregate order counts, attention/processing/failure
counts, captured/refunded amounts grouped by currency and ten recent orders.
Order search supports:

- exact internal order UUID or exact normalized customer email;
- one validated order status;
- ISO date boundaries;
- keyset pagination ordered by `created_at DESC, id DESC`;
- a maximum page size of 100 and HMAC-signed cursors bound to the filters.

SQL predicates are parameterized. Detail reads include safe order/customer
identifiers, product title, workflow statuses, latest fulfillment references,
guest-claim state and order transition history. Invoice status is explicitly
`NOT_AVAILABLE` because no authoritative persistent admin invoice projection
exists. No invoice state is invented.

## Product-Key decision

Normal dashboard, list, search and detail projections never select fulfillment
secret ciphertext, nonces, tags, wrapped keys or plaintext. Detail receives
only `encryptedSecretAvailable: boolean`.

The reveal-attempt endpoint is POST-only and requires `PRODUCT_KEY_REVEAL`, an
authenticated current session, exact origin, exact CSRF context and an existing
order. Every attempt is audited. It always returns either
`ADMIN_KEY_NOT_AVAILABLE` or `ADMIN_KEY_REVEAL_NOT_ENABLED`; it does not decrypt
or return key material. Enabling an actual reveal needs a separate approved task
that composes the active fulfillment crypto boundary, step-up authentication,
operational policy and human security approval.

## Audit

Authentication outcomes, authorization denials, dashboard/list/detail reads
and reveal attempts append safe `AUTH_SECURITY_EVENT` or `ADMIN_ACTION` events.
Audit metadata contains action/reason/count information only. Session values,
customer cookies, request bodies, secret material and Product Keys are omitted.
If required audit persistence fails, protected data is not returned.

## Staging

Configure the values documented in `infra/docker/staging.env.example`. Generate
all session and HMAC values locally and keep the real `.env` ignored. For local
HTTP testing only, use:

```text
KEYRANO_STAGING_ADMIN_ORIGIN=http://localhost:18081
KEYRANO_STAGING_ADMIN_SECURE_COOKIES=false
```

Start or rebuild the staging stack:

```bash
docker compose --env-file .env.staging -f infra/docker/compose.staging.yaml up -d --build
```

The admin portal is then available at the configured origin. The bootstrap is
staging-only, idempotently provisions one synthetic `PROJECT_OWNER`, replaces
its previous synthetic session, persists only the HMAC hash and expires the new
session after eight hours.

## Remaining approvals

Admin browser UAT, production IdP/MFA, role assignment governance, real invoice
projection, actual Product-Key reveal, audit review workflow, penetration review
and production network deployment remain unapproved. KS-11-07 is incomplete and
`SECURITY-READINESS` remains `NOT_APPROVED`.
