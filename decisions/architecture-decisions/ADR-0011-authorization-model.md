# ADR-0011: Authorization Model

Status: Accepted

## Decision

KeyCore uses least-privilege roles and explicit customer ownership checks.

## Roles

- `PROJECT_OWNER`
- `OPERATIONS`
- `SUPPORT`
- `FINANCE`
- `SECURITY_AUDITOR`

## Requirements

- Customer key access requires authenticated identity, exact order-line ownership, eligible order state, and immediate authorization before decryption.
- Cross-customer key access is always denied.
- Support access must be scoped, audited, and insufficient to reveal product keys unless a separately approved workflow permits it.
- Admin role permissions must be tested for least privilege.
