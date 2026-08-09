# ADR-0003: PostgreSQL 16+ Persistence

Status: Accepted

## Decision

Use PostgreSQL 16+ for catalog, workflow, idempotency, authorization, approval, and audit persistence.

## Consequences

- Every schema change requires a reversible migration.
- Idempotency roots, provider event IDs, order-line UUIDs, and audit event UUIDs require database-level uniqueness where applicable.
- Product-key plaintext must never be stored in PostgreSQL; only encrypted vault payloads and non-secret metadata may be stored.
