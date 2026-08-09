# ADR-0012: Outage and Degradation Behavior

Status: Accepted

## Decision

Unsafe mutations fail closed during partial outages.

## Required Behavior

- Supplier outage: pause affected procurement and reconcile pending purchases.
- Payment outage: block payment-dependent mutations and replay provider events safely later.
- Mail outage: retry notifications without exposing keys; account reveal can continue only if authorized and stored safely.
- Invoice outage: block production sales unless an approved legal fallback exists.
- Redis/queue outage: stop workflows requiring locks or durable async processing.
- PostgreSQL outage: disable checkout and procurement mutations.
- WooCommerce synchronization outage: pause publication changes and reconcile before resuming.

All outage paths require audit events, operator-visible status, and recovery playbooks before production.
