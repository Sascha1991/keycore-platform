# Queue, Outbox, and Reconciliation Foundation

KS-02-02 establishes KeyCore's asynchronous execution foundation. It does not implement business-specific catalog, procurement, fulfillment, email, invoice, refund, payment, supplier, or WooCommerce workflows.

## PostgreSQL vs Redis Responsibilities

PostgreSQL remains the durable source of truth for platform state and business intent.

Redis is used only for:

- job delivery;
- scheduling assistance;
- short-lived coordination where later tasks explicitly allow it;
- safe caching where explicitly allowed.

Redis must never be the only durable record of payments, procurement, fulfillment, refunds, product keys, order state, or financial effects.

## Delivery Semantics

The queue foundation assumes at-least-once delivery. A job may run more than once, especially after worker crashes or lost acknowledgments.

Exactly-once message delivery is not claimed. Exactly-once business effects must be achieved by later handlers through durable idempotency records, order-line idempotency roots, and reconciliation.

## Transactional Outbox

Future business mutations must create outbox records in the same PostgreSQL transaction as the state change they describe. The reusable transaction boundary in `infra/postgres/client.ts` supports that pattern.

The generic dispatcher:

1. claims due unpublished records with PostgreSQL locking;
2. publishes a safe queue job;
3. marks successful publication;
4. schedules retry on retryable publication failure;
5. escalates exhausted failures to manual review.

## Retry Policy

The retry policy supports:

- maximum attempts;
- exponential backoff;
- configurable base delay;
- configurable maximum delay;
- jitter;
- retryable vs non-retryable classification.

Retries are bounded and must not continue indefinitely.

## Reconciliation

`reconciliation_records` provide durable work tracking for future ambiguity and recovery scenarios, including payment ambiguity, supplier purchase ambiguity, delayed fulfillment, refunds, and WooCommerce projection.

The foundation supports creation, due-work claiming, retry counters, next-attempt timestamps, last error classification, completion, failure, and `MANUAL_REVIEW` escalation.

## Worker Lifecycle

The generic worker lifecycle supports:

- startup;
- graceful shutdown;
- health state;
- queue connection;
- handler registration;
- error classification;
- correlation propagation;
- safe observability events.

Workers do not log full payloads by default.

## Crash Recovery

If PostgreSQL is available and Redis is unavailable, durable intent remains in PostgreSQL and outbox publication remains retryable.

If Redis is available and PostgreSQL is unavailable, new durable business intent must not be invented in Redis.

If a worker crashes after processing but before acknowledgment, work may be redelivered. Later business handlers must use idempotency records and reconciliation to prevent duplicate irreversible effects.

## Security Boundaries

Queue jobs contain only references, identifiers, correlation IDs, idempotency keys, schema versions, attempt metadata, and minimal safe payloads.

Payload validation rejects forbidden top-level or nested field names resembling product keys, plaintext keys, decrypted keys, API secrets, passwords, and payment credentials.

## Local Development

Redis is available through the local Docker Compose stack:

```sh
docker compose -f infra/docker/compose.yaml up redis
```

Set `KEYCORE_TEST_REDIS_URL` to run Redis integration tests locally.

## CI Integration Testing

GitHub Actions provides PostgreSQL and Redis services for the Node quality gate. PostgreSQL tests use `KEYCORE_TEST_DATABASE_URL`; Redis tests use `KEYCORE_TEST_REDIS_URL`.
