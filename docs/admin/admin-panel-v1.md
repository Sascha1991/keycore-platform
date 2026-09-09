# KeyRaNo Admin Panel V1

## Purpose and boundary

Admin Panel V1 extends the existing server-rendered KeyRaNo Admin. PostgreSQL
remains authoritative and every route is protected by the existing hash-only
Admin session, role and capability model. The panel does not introduce a
second identity system, a Product Key decryption path or client-side business
authority.

The interface is a dense German operations workspace. Navigation and content
are permission-filtered on the server; hiding a link is never treated as an
authorization decision.

## Available areas

| Area                   | Capability                                              | Behavior                                                                       |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Übersicht              | `ADMIN_ACCESS`                                          | Real order, payment and operational summaries                                  |
| Bestellungen           | `ORDER_VIEW`                                            | Bounded search, status overview and order detail                               |
| Kunden                 | `CUSTOMER_VIEW`                                         | Bounded customer list/detail and recent owned orders                           |
| Produkte / Katalog     | `CATALOG_VIEW`                                          | Canonical products and current publication state                               |
| Lieferanten            | `SUPPLIER_VIEW`                                         | Supplier and offer health without credentials                                  |
| Support                | `SUPPORT_VIEW` / `SUPPORT_MANAGE`                       | Case detail, visibility-aware notes, priority and status transitions           |
| Betrugsprüfung         | `FRAUD_REVIEW_VIEW`                                     | Read-only open-review visibility without customer-facing risk detail           |
| Finanzen               | `FINANCE_VIEW`                                          | Captured/refunded operational totals, explicitly not accounting                |
| Berichte & Statistiken | `REPORT_VIEW`                                           | Deterministic operational aggregates without invented analytics                |
| Mitarbeiter & Rollen   | existing staff capabilities                             | Existing least-privilege staff and grant administration                        |
| Einstellungen          | `OPERATIONS_CONTROL_VIEW` / `OPERATIONS_CONTROL_MANAGE` | Versioned pause/resume of existing Operations Authority controls               |
| Benachrichtigungen     | permission-filtered                                     | Live open support, fraud and paused-control states; no fabricated unread count |

`Rabatte & Kampagnen` remains visibly unavailable because the repository has no
approved discount authority. Refund initiation, procurement reconciliation and
fraud resolution are also intentionally absent until their domain workflows
and customer-safe transports are specified.

## Mutation safety

Admin mutations are POST-only and require an exact configured Origin, an exact
allowlisted form shape, path-bound HMAC CSRF, an authorized capability and the
current record version where applicable. Operations-control changes also
require explicit confirmation and an idempotent operation identifier. Support
status changes use the existing domain transition graph.

The panel never renders Product Keys, encrypted key material, session codes,
claim codes, credentials, provider payloads or raw audit metadata. The existing
controlled key-reveal endpoint remains fail-closed and disconnected from
decryption.

## Customer support transport

Authenticated customers can create and view their own support cases through
`Mein Konto > Support`. Requests use the existing signed WordPress bridge,
customer principal and ownership-scoped support service. Customer replies are
always customer-visible; internal notes exist only in the authorized Admin
view. Cross-customer lookups return the same unavailable boundary and response
bodies never echo submitted messages.

## Operational controls

The settings page operates on the existing PostgreSQL-backed Operations
Authority. A paused `CHECKOUT_CREATE` control causes the staging storefront to
deny order creation before an order, payment or fulfillment record is written.
Read-only account and Admin state remains available. Restoring the control is a
separate authorized, version-checked action.

These controls are not production approval. Hosted staging execution requires
the existing approved Admin session mechanism and a human restoration check.

## Deployment and approval

Migration 030 only expands the allowlisted values of existing Admin permission
grants and is reversible. Normal migration/bootstrap applies it; no volume
reset is required.

Admin Panel V1 does not change the eleven existing KS-11-07 PASS results.
Human Acceptance remains `IN_REVIEW`, Human Approval remains `NOT_APPROVED`,
and `SECURITY-READINESS` remains `NOT_APPROVED`.
