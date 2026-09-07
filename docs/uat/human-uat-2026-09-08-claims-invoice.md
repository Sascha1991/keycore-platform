# Human UAT Record - 2026-09-08

## Recorded Results

The KeyRaNo product owner completed UAT-012, UAT-005 and UAT-004 using only
synthetic staging data. This record preserves the supplied observations without
recording the one-time claim value or fabricating screenshots, durable audit
evidence or other unobserved facts.

Before UAT-005, the documented isolated staging Compose environment received an
authoritative full volume reset because the guest-claim fixture was already
owned and consumed. The four staging volumes were deleted, the synthetic
environment was rebuilt and bootstrapped, and the fixture returned to
`owned=false`, `active=1`, `consumed=0`. This preparation is not a UAT result.

## UAT-012 - Owned Purchase Invoice Action

Customer A opened the available purchase invoice PDF. It visibly contained:

- `KeyRaNo - Synthetische Staging-Rechnung`;
- a synthetic, non-legally-valid UAT marker;
- reference `KR-SYNTHETIC-0001`;
- date `2026-08-30`;
- product `Neonpfad: Berlin`; and
- total `12.99 EUR`.

No Product Key, claim value, credential, storage/provider detail or other
sensitive authority was visible. In a separate private session, Customer B was
denied direct access to Customer A's purchase detail with `Dieser Kauf ist nicht
verfügbar.`

Result: `PASS`.

Invoice-view auditing uses process-local `MemoryAudit`; this record does not
claim PostgreSQL persistence for an invoice-view audit event.

## UAT-005 - Guest Claim With Wrong Email

Starting from `owned=false`, `active=1`, `consumed=0`, Customer B submitted the
guest claim exactly once. The UI returned `Code ungültig oder Kauf nicht
verfügbar.` Customer B's `Meine Käufe` page did not contain the guest purchase
and showed only Customer B's existing purchase.

The post-attempt database state remained `owned=false`, `active=1`,
`consumed=0`. No ownership transferred, the challenge remained active and
unconsumed, and the denial disclosed no purchase information.

Result: `PASS`.

## UAT-004 - Legitimate Guest Purchase Claim

UAT-004 started immediately after UAT-005 without another reset. Customer A
submitted the same legitimate guest claim and saw `Kauf erfolgreich
hinzugefügt.` Immediate database verification showed `owned=true`, `active=0`,
`consumed=1`.

Customer A's `Meine Käufe` page showed the newly claimed `Neonpfad: Berlin`
purchase dated `08.09.2026`, with `12,99 EUR` and status `Bereit`. Ownership
remained visible after logout and a new login. One replay of the same claim was
denied with `Code ungültig oder Kauf nicht verfügbar.` Final database state
remained `owned=true`, `active=0`, `consumed=1`.

Ownership was permanently bound, the challenge remained consumed, the new
authenticated session retained access and replay was denied.

Result: `PASS`.

## Gate Boundaries

- Human `PASS` results: 8 of 18.
- KS-11-07: incomplete; ten scenarios remain pending or not executable.
- Human acceptance: `IN_REVIEW`.
- Human approval: `NOT_APPROVED`.
- `SECURITY-READINESS`: `NOT_APPROVED`.
- Production approval: not granted.
- No real payment, supplier purchase, Product Key, production credential or
  production deployment was used.

The review date is normalized to `2026-09-08T00:00:00Z` in the machine-readable
results.
