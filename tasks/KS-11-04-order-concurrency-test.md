# KS-11-04 - Order Concurrency Test

## Goal

Prove under real isolated PostgreSQL concurrency that customer and order
operations cannot create duplicate commercial effects, lose ownership, bypass
gates or overwrite durable terminal state.

## Required Scope

- Concurrent order creation with identical and conflicting idempotency reuse.
- PriceLock contention and independent-order progression.
- Payment initialization and provider-event replay/conflict.
- Procurement creation, lease ownership, ambiguity and terminal completion.
- Fulfillment creation and retrieval ownership.
- Customer delivery and guest-order claim ownership.
- Refund requests and optimistic order-state transitions.
- CONC-001 through CONC-017 safe evidence.

Use production-facing domain services and PostgreSQL repositories wherever
practical. Competing transactions must own independent connections. PostgreSQL
is the durable source of truth. Use bounded timeouts and direct database
assertions; do not hide failures with sleeps, skips or global serialization.

## Safety

Use only synthetic data and adapters. Do not call Stripe, Kinguin,
WooCommerce, suppliers or any external network. Do not use production data,
credentials or real Product Keys. Do not weaken security gates, database
constraints, idempotency, ambiguity handling or ownership rules.

## Evidence And CI

`npm run order:concurrency` must be release blocking and write omission-first
JSON and Markdown under `artifacts/order-concurrency/`. CI must always upload
the directory as `ks-11-04-order-concurrency-evidence` with 14-day retention.

## Completion Boundary

Open one PR named `KS-11-04: Add order concurrency validation` and do not merge
it. Do not start KS-11-05. Phase 11 remains incomplete and
`SECURITY-READINESS` remains unapproved.
