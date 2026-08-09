# ADR-0010: Human Approval Gates

Status: Accepted

## Decision

KeyCore uses explicit human approval gates stored under `docs/approvals/`.

## Gates

- `REAL-SUPPLIER`: required before non-mock supplier ordering.
- `LIVE-PAYMENTS`: required before live payment credentials or live payment capture.
- `TAX-INVOICE`: required before production sales and invoice issuance.
- `SECURITY-READINESS`: required before staging acceptance and production release.
- `PRODUCTION-RELEASE`: required before production deployment.
- `POLICY-EXCEPTION`: required for exceptions such as VPN-dependent activation policy changes.

Agents may prepare evidence but cannot approve their own gates.
