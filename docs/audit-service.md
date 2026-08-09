# Secure Audit Service

## Purpose

The KeyCore audit service records security-relevant platform facts in PostgreSQL using append-oriented events. Audit data is for traceability and investigation. It is not a durable business-state store and must never contain product-key material, payment credentials, supplier secrets, full request bodies, or full response bodies.

## Event Model

Audit events contain:

- `uuid`
- `eventType`
- `timestampUtc`
- `actor`
- `correlationId`
- `entity`
- `environment`
- `outcome`
- `reasonCode`
- `metadata`

Actor categories are `CUSTOMER`, `ADMIN`, `SYSTEM`, and `SERVICE`.

Current key-vault events are:

- `KEY_STORED`
- `KEY_REVEALED`
- `KEY_ACCESS_DENIED`
- `KEY_REWRAPPED`
- `KEY_RETIRED`

The foundation also reserves future platform classes for payment, procurement, refunds, region decisions, price gates, admin actions, approvals, authentication/security events, system degradation, and audit-query activity.

## Metadata Safety

Audit metadata uses a JSON-safe subset only. The validator rejects unsafe field names case-insensitively after normalization, at any depth, including arrays. It rejects product-key, plaintext-key, raw-key, decrypted-key, API-secret, API-key, token, authorization, cookie, session, ciphertext, DEK, wrapped-DEK, nonce, IV, authentication-tag, master-key, card, CVV/CVC, credential, password, and request/response body fields.

The validator also rejects binary buffers, error objects, unsupported objects, functions, bigint values, non-finite numbers, excessive nesting, excessive string size, oversized arrays, oversized objects, and oversized serialized payloads.

Safe non-secret references such as `keyVersion`, `orderLineId`, `retryCount`, reason codes, and filter summaries are allowed.

## Persistence

`PostgresAuditEventRepository` inserts audit rows with parameterized queries and validates each event before persistence. The normal audit append API exposes no update or delete operations.

The `audit_events` table stores structured actor/entity JSON, correlation ID, outcome, reason code, environment, UTC timestamp, event type, and metadata. KS-02-04 adds reversible indexes for:

- correlation ID plus keyset ordering;
- entity type/id plus keyset ordering;
- event type plus keyset ordering;
- actor type/id plus keyset ordering;
- timestamp plus UUID keyset ordering;
- outcome plus keyset ordering;
- reason code plus keyset ordering.

## Query Access

Audit reads go through `AuditQueryService` and `AuditQueryAuthorizationPort`. Authorization happens before the query repository is called. Support access is not unrestricted, and `SECURITY_AUDITOR` is represented as a read-only role.

Allowed query filters are:

- time range;
- event type;
- correlation ID;
- entity type and ID;
- actor type and ID;
- outcome;
- reason code.

Queries do not accept arbitrary SQL, arbitrary filter expressions, or metadata JSON querying. Pagination is bounded and deterministic using `timestampUtc` plus UUID keyset cursors.

## Audit Of Audit Access

Successful audit queries append `AUDIT_QUERY_EXECUTED`; denied attempts append `AUDIT_QUERY_DENIED`. These events contain only safe summaries such as selected filter values, page size, result count, and denial reason code. They do not store result payloads.

The query service writes these events directly through `AuditEventPort`, avoiding recursive query auditing.

## Known Limits

This foundation does not implement customer-facing or admin-facing audit endpoints. Later tasks must provide application-specific authorization policy and UI/endpoint integration without weakening the append-only and secret-safe guarantees.
