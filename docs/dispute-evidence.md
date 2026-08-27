# Dispute Evidence Foundation

KS-09-03 adds a provider-neutral dispute evidence snapshot foundation for
support and payment-dispute preparation. It does not call Stripe Disputes,
Stripe Files, Kinguin, key retrieval, key display or customer delivery APIs.

## Evidence Model

Evidence is built from authoritative persisted KeyCore facts for one exact
order. The snapshot schema version is `KS_DISPUTE_EVIDENCE_V1`.

Mandatory sections:

- `ORDER`
- `PAYMENT`

Optional sections are still represented explicitly as `NOT_APPLICABLE`,
`NOT_AVAILABLE` or `AMBIGUOUS` instead of being omitted:

- `CUSTOMER_ACCOUNT`
- `OWNERSHIP`
- `GUEST_CLAIM`
- `FRAUD`
- `VELOCITY`
- `PROCUREMENT`
- `FULFILLMENT`
- `DELIVERY`
- `INVOICE`
- `AUDIT_SUMMARY`

Snapshots contain structured, allowlisted facts only. They intentionally do
not include plaintext product keys, encrypted key material, ciphertext, nonces,
tags, delivery capability tokens, guest claim token hashes, checkout email
values, velocity subject keys, full payment references, raw supplier responses,
customer addresses, device data, IP addresses, Stripe Radar data or provider
API payloads.

## Drafts, Versions and Fingerprints

Draft creation computes a deterministic SHA-256 fingerprint over:

- exact `orderId`;
- schema version;
- canonicalized evidence sections and facts.

The repository reuses an existing draft or finalized snapshot for the same
order/schema/fingerprint. If authoritative facts change, a new snapshot version
is created. Drafts may be regenerated; finalized snapshots are immutable.

## Finalization

Finalization requires `DisputeEvidenceFinalizationAuthorityPort`. The default
authority denies every request, so production usage fails closed until a trusted
operator/admin control is supplied.

PostgreSQL enforces immutability with a trigger that rejects every update to a
`FINALIZED` `dispute_evidence_snapshots` row. Finalization is exact-order bound
and is idempotent for replay of an already finalized snapshot.

## Export

Export requires `DisputeEvidenceExportAuthorityPort`. The default authority
denies every request. Export is bound to the exact `orderId` and snapshot id;
cross-order export attempts fail closed with `DISPUTE_EVIDENCE_ORDER_MISMATCH`.

The export format is provider-neutral structured data. It is suitable as an
internal preparation artifact for later payment-provider evidence work, but it
does not submit, upload or mutate external provider state.

## Persistence

Migration 022 adds `dispute_evidence_snapshots`:

- exact order foreign key to `keycore_orders`;
- schema/policy version checks;
- DRAFT/FINALIZED/INVALIDATED state checks;
- SHA-256 fingerprint validation;
- non-empty JSONB evidence sections;
- unique `(order_id, schema_version, version)`;
- unique `(order_id, schema_version, fact_fingerprint)`;
- finalized tuple and immutable-finalized trigger.

PostgreSQL remains the durable source of truth. Redis and external providers
are not used for dispute evidence.

## Audit

Evidence creation, finalization and export append best-effort audit events.
Audit metadata is deliberately small:

- snapshot id;
- schema version;
- snapshot state;
- short fingerprint prefix.

Audit events do not contain the evidence body, payment references, supplier
references, customer email values, product-key material or provider payloads.
Audit failure does not roll back durable evidence creation.

## Production Status

Production dispute submission is not ready in KS-09-03.

## Support Case Linkage

KS-09-04 may reference a dispute evidence snapshot from a support case as a
safe exact-order link. The support case stores only the snapshot identifier and
order-bound reference metadata. It does not copy evidence sections, payment
references, supplier payloads, Product Keys or customer-visible evidence into
support messages.

KS-09-05 may also reference a `FINALIZED` snapshot from a supplier claim for
the exact same order. The supplier claim stores only the snapshot identifier;
it does not copy evidence sections. Draft and cross-order snapshots fail closed.

Not included:

- Stripe Dispute API integration;
- Stripe File upload;
- provider-specific evidence mapping;
- production operator UI;
- support ticket workflow;
- supplier claim workflow;
- customer-visible dispute evidence;
- product-key retrieval, reveal or delivery.
