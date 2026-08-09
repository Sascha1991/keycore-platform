# ADR-0004: Redis 7+ Queue and Cache Usage

Status: Accepted

## Decision

Use Redis 7+ for queues, locks, short-lived caching, and rate-limiting support.

## Consequences

- Redis is not a source of truth for payments, procurement, fulfillment, refunds, keys, or approvals.
- Unsafe mutations must stop when required locks or queues are unavailable.
- Product keys, API credentials, payment credentials, passwords, and sensitive request bodies must never be written to Redis.
