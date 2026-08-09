# ADR-0009: Audit Event Model

Status: Accepted

## Decision

Security and financial events are audited with a minimal, non-secret schema.

## Schema

- `uuid`
- `event_type`
- `timestamp_utc`
- `actor`
- `correlation_id`
- `entity`
- `environment`
- `outcome`
- `reason_code`
- `metadata`

## Forbidden Fields

Audit events must not contain product keys, API secrets, passwords, payment credentials, unnecessary sensitive request bodies, or plaintext supplier/customer secrets.

## Consequences

- Security, financial, admin, supplier, refund, and key-reveal events must be auditable.
- Retention and access controls must be documented before production.
- Audit tests must verify useful traceability without secret exposure.
