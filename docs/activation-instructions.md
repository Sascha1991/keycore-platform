# Activation Instructions

KS-08-06 adds the authoritative activation-instruction foundation for future
KeyRaNo customer account surfaces. It provides curated, safe instructions only
when structured KeyCore metadata identifies a supported platform and
instruction code.

Public customer copy uses KeyRaNo:

- KeyRaNo — Rapid Access. No Waiting.
- Dein Key. Direkt. Ohne Warten.

Internal service, package, audit and repository names remain KeyCore.

## Source Of Truth

Activation instructions are authoritative only when the customer account
projection contains structured activation metadata:

- platform;
- instruction code;
- source `STRUCTURED`.

Product title text, supplier free text, WooCommerce metadata, customer request
fields and inferred keywords are not authoritative. If structured metadata is
missing, title-only or unknown, the customer response is
`GENERIC_SAFE_ACTIVATION` with `status=NOT_AVAILABLE`.

## Registry

`CustomerActivationInstructionsService` resolves structured metadata through a
curated registry. KS-08-06 includes a Steam activation document for
`STEAM_ACTIVATION_CODE` and validates registry entries before they can be used.

Registry validation rejects:

- unsafe instruction codes;
- empty or oversized titles;
- control characters or HTML-like text;
- empty or oversized step lists;
- non-HTTPS help URLs;
- help URLs outside explicitly trusted hosts.

## Transport Contract

Future route:

```text
GET /v1/customer/orders/{orderId}/activation-instructions
```

The transport-neutral handler:

- requires a valid customer session resolved through KS-07-07;
- rejects request body fields and query parameters;
- accepts only the path `orderId` as lookup context;
- does not accept platform overrides or instruction-code overrides;
- returns `Cache-Control: private, no-store`;
- maps wrong-owner, unknown and legacy/unclaimed orders to
  `RESOURCE_NOT_AVAILABLE`.

Activation-instruction reads are GET reads and do not require CSRF, but they do
require allowed Origin validation and private no-store cache headers.

## Safety

Activation-instruction reads do not decrypt, retrieve, email, reveal or mark
Product Keys delivered. Responses must not include Product Keys, supplier
payloads, delivery capabilities, ciphertext, nonces, wrapped keys, customer
session data or arbitrary supplier/storefront free text.

## Audit

Successful reads produce `CUSTOMER_ACTIVATION_INSTRUCTIONS_VIEWED`. Missing or
title-only structured metadata still returns a safe customer response and uses
reason `CUSTOMER_ACTIVATION_INSTRUCTIONS_NOT_AVAILABLE`. Wrong-owner, unknown
and unclaimed order attempts produce
`CUSTOMER_ACTIVATION_INSTRUCTIONS_DENIED`.

## Production Gates

- PRODUCTION CUSTOMER ACCOUNT HTTP EXPOSED: NO
- WOOCOMMERCE ACTIVATION UI CONNECTED: NO
- SUPPLIER FREE-TEXT INSTRUCTIONS TRUSTED: NO
- PRODUCT TITLE INFERENCE TRUSTED: NO
- REAL PRODUCT KEY REVEAL ENABLED BY INSTRUCTION READS: NO
