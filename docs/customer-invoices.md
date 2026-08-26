# Customer Invoices

KS-08-06 adds the customer invoice access foundation for KeyRaNo account
surfaces while keeping invoice generation, tax/legal accounting, PDF rendering
and production HTTP out of scope.

Public customer copy uses KeyRaNo:

- KeyRaNo — Rapid Access. No Waiting.
- Dein Key. Direkt. Ohne Warten.

Internal service, package, audit and repository names remain KeyCore.

## Scope

The foundation exposes safe invoice metadata for an authenticated customer and
owned order:

- invoice status: `NOT_AVAILABLE`, `PENDING`, `AVAILABLE` or `FAILED`;
- optional customer-safe invoice reference;
- optional issued timestamp;
- `downloadAvailable` capability flag.

It does not create invoices, calculate tax, store legal invoice artifacts,
render PDFs, connect accounting systems or issue production download URLs.

## Ownership

Invoice reads are scoped by `AuthenticatedCustomerPrincipal.customerId` and the
KeyCore order UUID. The service calls the customer account read repository with
both values and never trusts request-supplied `customerId`, invoice owner,
invoice reference, storage ID or download URL fields as authority.

Unknown orders, wrong-owner orders and legacy/unclaimed orders all return the
same customer-safe `RESOURCE_NOT_AVAILABLE` result.

## Transport Contract

Future route:

```text
GET /v1/customer/orders/{orderId}/invoice
```

The transport-neutral handler:

- requires a valid customer session resolved through KS-07-07;
- rejects request body fields and query parameters;
- accepts only the path `orderId` as lookup context;
- returns `Cache-Control: private, no-store`;
- maps service failures to safe customer error codes.

Invoice reads do not require CSRF because they are GET reads, but they still
require explicit allowed Origin validation and private no-store cache headers.

## Safety

Invoice responses must not contain:

- API credentials;
- raw invoice storage locations;
- filesystem paths;
- PDF bytes;
- tax provider payloads;
- product keys;
- delivery capabilities;
- ciphertext, nonces or wrapped keys;
- customer/order data outside the authenticated owned order.

## Audit

Successful metadata reads produce `CUSTOMER_INVOICE_METADATA_VIEWED`.
Unavailable owned orders may still produce a successful read with
`status=NOT_AVAILABLE`. Wrong-owner, unknown and unclaimed order attempts
produce `CUSTOMER_INVOICE_METADATA_DENIED` without revealing which case
occurred.

Audit metadata contains safe IDs, reason codes, invoice status and the boolean
download availability only.

## Production Gates

- PRODUCTION INVOICE PDF GENERATION ENABLED: NO
- TAX/LEGAL ACCOUNTING INTEGRATION ENABLED: NO
- PRODUCTION CUSTOMER ACCOUNT HTTP EXPOSED: NO
- WOOCOMMERCE INVOICE ADAPTER CONNECTED: NO
- REAL PRODUCT KEY REVEAL ENABLED BY INVOICE READS: NO
