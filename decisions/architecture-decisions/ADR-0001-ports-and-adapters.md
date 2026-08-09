# ADR-0001: Modular Supplier Ports-and-Adapters Architecture

Status: Accepted

## Decision

KeyCore uses a ports-and-adapters architecture. The platform core owns generic business rules and exposes supplier, payment, storefront, persistence, queue, mail, invoice, monitoring, and secret-management ports. Supplier-specific logic lives only inside supplier adapters.

## Consequences

- The core cannot depend on Kinguin-specific fields, endpoints, statuses, or region semantics.
- MockSupplier must implement the same supplier port as real suppliers.
- Contract tests define adapter behavior before a supplier can be used outside mocks.
- Adding a supplier must not require changing generic order, pricing, vault, audit, or Germany decision logic unless the port itself changes through an ADR.
