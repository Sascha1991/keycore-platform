# PHASE_12_INVOICE_TRANSPORT Implementation Report

## Result

Implemented an owner-only synthetic invoice download for the isolated KeyRaNo
staging account. The branch starts from PR #47 because its account detail
projection and signed bridge are sufficient; PR #48 Guest Claim behavior is
unrelated and was not copied into this branch.

## Architecture And Security

The implementation reuses `CustomerInvoiceAccessService`, authenticated
customer principals, `CustomerAccountReadRepository`, audit events and PR #47's
signed bridge. `getInvoiceDocument()` repeats the exact owner lookup immediately
before provider access and validates invoice state, content type and byte bounds.

`SyntheticStagingInvoiceDocumentProvider` recognizes exactly one complete
synthetic order/customer/invoice fixture and renders a deterministic minimal
PDF. It contains no address, Product Key, claim material or provider data and
labels itself non-legally-valid staging material.

The browser posts only an OrderId through a per-order nonce and exact same-origin
check. WordPress signs the mapped identity, validates the signed response and
serves `keyrano-rechnung.pdf` with private/no-store and nosniff headers. It
cannot choose an invoice ID, filename, storage path, provider URL or customer.
Wrong-owner, unknown and mismatched resources share the safe unavailable result.

Successful reads audit `CUSTOMER_INVOICE_DOCUMENT_VIEWED`; denials audit
`CUSTOMER_INVOICE_DOCUMENT_DENIED`. Audit metadata excludes document content,
invoice reference, customer data and secrets.

## Changes

Changed the customer invoice application service, staging adapter/runtime,
WordPress bridge/account/plugin/template/test files and current invoice,
storefront, staging and UAT documentation. Added the synthetic document adapter,
strict PHP document decoder, safe failure template, task and report. No migration
or production business behavior was added.

## Validation

- Focused invoice/storefront and customer invoice tests: 20 passed.
- PHP 8.3 syntax: all plugin files passed; deterministic adapter passed.
- Relevant PostgreSQL account/staging/E2E integration: 6 passed across four
  files using an isolated PostgreSQL 16.10 container, then removed.
- E2E acceptance: 16 passed.
- Security assessment: 60 passed, 345 intentionally filtered/skipped.
- `npm run check`: 754 passed, 127 skipped; formatting, lint, typecheck and
  secret scan passed.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- Staging Compose configuration, UAT validator and `git diff --check`: passed.

## Gates And Limitations

- UAT-002 remains `PASS`.
- UAT-015 remains `PENDING`; PR #48 carries its separate Guest Claim transport
  and still requires human evidence.
- UAT-012 and only the invoice portion of UAT-018 are technically executable;
  no human result is fabricated and UAT-018 remains `PENDING`.
- Composed procurement/fulfillment and coherent final evidence still block
  UAT-018.
- KS-11-07 remains incomplete/unapproved.
- `SECURITY-READINESS` remains `NOT_APPROVED`.
- Production invoice, legal/tax and provider readiness are not claimed.
