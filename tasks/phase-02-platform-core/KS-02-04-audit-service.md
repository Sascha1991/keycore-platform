# KS-02-04: Secure Audit Service

## Goal

Implement the secure audit service foundation for KeyCore so security-sensitive platform activity can be appended durably, queried through an explicit authorization boundary, and validated for secret-safe metadata.

This task provides infrastructure only. It does not add customer audit endpoints, admin UI, supplier behavior, payment execution, production deployment, or later workflow logic.

## Dependencies

- KS-01-01 completed and CI green
- KS-01-02 completed and CI green
- KS-02-01 completed and CI green
- KS-02-02 completed and CI green
- KS-02-03 completed and CI green
- ADR-0001 through ADR-0012
- Specification v1.0.2

## Scope

- Canonical audit event contract with UUID, event type, UTC timestamp, actor, correlation ID, entity, environment, outcome, reason code, and safe metadata.
- Recursive audit metadata validation that rejects product keys, credentials, tokens, ciphertext, DEKs, nonces, tags, payment credentials, request/response bodies, binary values, error objects, excessive nesting, excessive strings, and excessive payload size.
- Append-only audit event service and PostgreSQL repository validation.
- Read-only audit query service behind `AuditQueryAuthorizationPort`.
- Safe query filters for time range, event type, correlation ID, entity, actor, outcome, and reason code.
- Bounded deterministic keyset pagination by `timestamp_utc` and UUID.
- Audit-of-audit events for query execution and denied query attempts with minimal safe summaries.
- PostgreSQL indexes supporting the approved filters.
- Documentation and tests.

## Acceptance Criteria

- Audit metadata validation is central, recursive, and fail-closed.
- `keyVersion`, order-line references, retry counts, and other safe non-secret metadata remain accepted.
- Product keys, plaintext keys, API secrets, API keys, tokens, authorization headers, cookies, sessions, ciphertext, wrapped DEKs, DEKs, nonces, IVs, authentication tags, master keys, card data, and request/response bodies are rejected before persistence.
- Audit append uses durable UUIDs and UTC timestamps.
- Normal repository API is insert-only; no update/delete audit mutation API is exposed.
- PostgreSQL stores structured audit fields and metadata using parameterized queries.
- Query access is authorized before any audit records are returned.
- `SECURITY_AUDITOR` is represented as read-only; support access is not unrestricted.
- Query filters are allow-listed; no arbitrary SQL expressions or metadata JSON querying are accepted.
- Pagination is bounded and deterministic with no duplicate or missing records across pages.
- Query execution and denial are themselves audited without storing result payloads.
- Existing vault audit events remain secret-safe.
- Schema migrations are reversible.
- Core/domain remains independent of PostgreSQL, Redis, supplier, payment, and cloud provider clients.

## Required Tests

- Safe audit metadata accepted.
- Top-level product-key canary rejected.
- Nested plaintext-key canary rejected.
- Case-insensitive API secret canary rejected.
- Array-contained password canary rejected.
- Ciphertext and wrapped-DEK fields rejected.
- Request/response body metadata rejected.
- Binary buffers and error objects rejected.
- Excessive nesting, string size, and payload size rejected.
- Approved and future-prefixed audit event types accepted; arbitrary event types rejected.
- Append service validates before writing.
- PostgreSQL audit append persists canonical fields.
- PostgreSQL audit append rejects unsafe metadata before persistence.
- Query authorization happens before repository access.
- Unauthorized query is denied and audited.
- Authorized query is audited with safe summary metadata.
- Page size is bounded.
- Keyset pagination is deterministic.
- Query indexes exist.
- Concurrent audit appends preserve distinct UUIDs.
- Repository exposes no normal update/delete API.
- Existing vault canary tests remain green.

## Forbidden Scope

- Customer audit endpoint.
- Admin audit UI.
- Supplier implementations.
- Stripe or payment execution.
- Procurement execution.
- Real product keys.
- Production credentials.
- Production customer data.
- Production deployment.
- KS-03-01 or any later task.

## Risk Level

Critical.

## Human Approval Requirement

Review/merge approval is required. No production deployment or production-data approval is granted by this task.
