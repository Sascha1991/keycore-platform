# Order Concurrency Test

## Scope

KS-11-04 is a release-blocking correctness suite for concurrent customer and
order operations. It runs existing application services and PostgreSQL
repositories against an isolated migrated schema. Payment and supplier effects
are synthetic; Stripe, Kinguin, WooCommerce and all other external networks are
not called.

The suite validates durable commercial invariants, not merely successful
responses. Migration 027 remains the schema baseline. No migration or
production business behavior is changed by KS-11-04.

## Connection Model

Each competing repository operation opens and owns an independent PostgreSQL
`Client`, sets the isolated schema search path, completes its transaction and
then closes the connection. No actor overlaps `BEGIN` or `COMMIT` on one client.
Scenario files execute serially to avoid unrelated fixture setup contention;
the actors inside every race remain genuinely concurrent.

Ten actors are used for high-value races. Two actors are used where the domain
invariant is specifically current-owner versus stale-owner or competing
terminal writers. Each test has a 60-second bound and the CI step has a
15-minute bound. There are no arbitrary sleeps, unbounded retries or global
repository locks.

## Scenarios

| ID       | Durable proof                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------- |
| CONC-001 | Same key and input create one order, consume one PriceLock and replay safely                   |
| CONC-002 | Conflicting reuse creates one winner and leaves losing PriceLocks active                       |
| CONC-003 | Different keys racing for one PriceLock produce one order and one consumption                  |
| CONC-004 | Payment initialization creates one payment, stable idempotency and one lease owner             |
| CONC-005 | Ten identical external events persist one receipt and replay idempotently                      |
| CONC-006 | Changed payload identity for one provider event fails as a conflict                            |
| CONC-007 | Ten procurement starts create one operation and no duplicate dispatch permission               |
| CONC-008 | Current procurement lease ownership defeats stale writers and recovers by policy               |
| CONC-009 | Post-dispatch uncertainty remains ambiguous and blocks blind repeat purchase                   |
| CONC-010 | Competing procurement completion permits one stable terminal success                           |
| CONC-011 | Fulfillment creation is idempotent and persists encrypted material only                        |
| CONC-012 | Retrieval has one lease owner; stale completion and terminal regression fail                   |
| CONC-013 | Customer delivery has one effect, preserves ownership and protects capability data             |
| CONC-014 | Guest claim consumes the hash-only challenge once and binds one customer                       |
| CONC-015 | Concurrent refund requests produce one logical effect and preserve commercial fields           |
| CONC-016 | Optimistic versions reject stale transitions and database constraints reject impossible states |
| CONC-017 | Ten unrelated orders progress concurrently with distinct identities and effects                |

The command runs the complete focused persistence files around these scenarios,
so supporting ownership, terminal-state, constraint and orphan checks remain
release blocking even when one scenario maps to several test cases.

## Durable Assertions

The tests query PostgreSQL directly for order and lock counts, history/outbox
effects, payment and provider-event uniqueness, procurement generations and
leases, fulfillment and encrypted-record relationships, customer-delivery
effects, guest-claim challenge state, ownership and immutable commercial
fields. Repository return values alone are not accepted as proof.

CONC-017 additionally creates ten distinct active PriceLocks and processes ten
orders concurrently. It requires ten distinct orders, ten consumed locks, ten
creation-history rows and ten creation-outbox rows, proving there is no shared
repository-wide mutex or accidental cross-order identity.

## Evidence

`npm run order:concurrency` writes:

- `artifacts/order-concurrency/order-concurrency-evidence.json`
- `artifacts/order-concurrency/order-concurrency-evidence.md`

Evidence contains aggregate actor counts, expected and observed winners,
durable row counts, conflict/replay counts, lease-owner counts, duplicate and
terminal-regression counts, durations and safe reason codes. Observed counts
are emitted only after the corresponding exact assertions pass. Secrets,
Product Keys, raw capabilities, claim tokens, ciphertext, credentials and
provider payloads are omitted and rejected by a reporter allowlist check.

CI uploads `ks-11-04-order-concurrency-evidence` for 14 days with `if: always()`.
When PostgreSQL is unavailable locally, scenarios are explicitly `SKIPPED`;
the CI PostgreSQL service is mandatory and produces the release decision.

## Limits

This task is not a throughput benchmark, security assessment, recovery drill or
UAT. KS-11-05 through KS-11-07 remain not started. Phase 11 remains incomplete
and `SECURITY-READINESS` remains unapproved.
