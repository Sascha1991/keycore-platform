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
- The product owner subsequently confirmed UAT-018 `PASS` on 2026-09-01 after
  the secure invoice correction. The supplied result is recorded without
  inventing screenshots or expanding its synthetic staging scope.
- KS-11-07 remains incomplete/unapproved.
- `SECURITY-READINESS` remains `NOT_APPROVED`.
- Production invoice, legal/tax and provider readiness are not claimed.

## Purchase Detail UI Follow-up

The WordPress purchase-detail template now presents the existing safe account
projection as a dark responsive KeyRaNo surface. It adds breadcrumbs, a
four-column desktop status summary, German date and minor-unit price formatting,
and separate Product Key and invoice sections. Tablet uses a two-by-two summary;
mobile uses one column, full-width actions and a wrapped two-column account
navigation without horizontal overflow.

The change is presentation-only. Pending invoices render no download form;
available invoices retain the existing POST action and dedicated `_wpnonce`.
The reveal form is unchanged and Product Key content is never rendered into the
initial purchase HTML. `CustomerInvoiceAccessService`, ownership checks, HMAC,
same-origin validation, response headers, PDF transport and fail-closed behavior
were not modified.

Safe visual evidence was captured from the running synthetic staging stack:

- `docs/screenshots/phase-12-invoice-transport/purchase-detail-desktop-available.png`
- `docs/screenshots/phase-12-invoice-transport/purchase-detail-mobile-pending.png`

The mobile capture verifies a 390 px viewport without horizontal overflow. The
pending fixture exposes neither an invoice-download nor a reveal action. Neither
capture contains Product Key content, credentials, customer email, tokens or
internal invoice identifiers.

## Account Surface UI Follow-up

`Meine Käufe`, `Kauf hinzufügen` and native WooCommerce `Kontodetails` now use
the purchase-detail page's dark KeyRaNo account surface. Shared presentation
values cover the background, cards, borders, 16 px radius, purple actions,
status badges, typography, spacing, focus states and responsive breakpoints.
The existing left account navigation is retained with a clear active state.

The purchase overview renders the existing owner-filtered projection as wide
cards with German dates, minor-unit totals, mapped customer-safe statuses and
the existing detail route. `Key verfügbar` appears only when the existing list
projection positively supplies `fulfillmentAvailable`; Product Key content is
never rendered. Empty and backend-unavailable states use generic dark cards.
A live local outage check returned only the generic unavailable message without
technical details or identifiers.

`Kauf hinzufügen` remains an explicitly unavailable, fail-closed shell because
the secure Guest Claim browser integration is outside this branch. Its visual
controls are disabled and it has no form, request action, Claim Code, nonce,
HMAC or client-side authority. No unsupported claim behavior was fabricated.

`Kontodetails` keeps WooCommerce's original POST form, nonce, validation,
password fields, show/hide controls and save handler. Plugin hooks add only the
page and form section headings; CSS presents the native controls as a dark card.
Desktop places first and last name side by side, while mobile stacks every field
and uses a full-width save action.

Safe synthetic staging screenshots:

- `docs/screenshots/phase-12-invoice-transport/account-purchases-desktop.png`
- `docs/screenshots/phase-12-invoice-transport/account-purchases-mobile.png`
- `docs/screenshots/phase-12-invoice-transport/account-add-purchase-desktop.png`
- `docs/screenshots/phase-12-invoice-transport/account-add-purchase-mobile.png`
- `docs/screenshots/phase-12-invoice-transport/account-details-desktop.png`
- `docs/screenshots/phase-12-invoice-transport/account-details-mobile.png`

Desktop staging checks used a 1440 px viewport; mobile checks used 390 px. All
three pages had equal document client and scroll widths, so no horizontal
overflow was present. The native password visibility control changed the input
type from password to text without submitting the form. The existing available
purchase detail retained one POST reveal form and one POST invoice form, while
its initial HTML contained no Product Key.

Validation for this follow-up: PHP 8.3 syntax and the deterministic WordPress
adapter passed; 91 focused Account, Claim, Invoice, Reveal, delivery and staging
adapter tests passed; `npm run check` passed with 754 tests and 127 intentional
skips; npm audit reported zero vulnerabilities; Secret Scan, UAT validator and
`git diff --check` passed. Relevant PostgreSQL account and order persistence
finished with 13 passing tests; an initial combined run crossed one existing
five-second test timeout by 12 ms, then the complete order file passed 12/12 on
its immediate isolated rerun without a code, timeout or schema change. UAT-018
remains `PASS`, UAT-015 is unchanged, KS-11-07 remains incomplete/unapproved and
`SECURITY-READINESS` remains `NOT_APPROVED`. No production approval is
introduced.
