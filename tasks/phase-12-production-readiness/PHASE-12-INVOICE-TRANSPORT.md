# PHASE_12_INVOICE_TRANSPORT - Secure Synthetic Invoice Document Access

## Scope

Connect the existing owner-filtered customer invoice application boundary to
the KeyRaNo staging account through the signed WordPress bridge. The task uses
one deterministic synthetic PDF fixture and does not implement production
invoice generation, tax policy, accounting-provider integration or legal
invoice approval.

## Dependencies

- Base: `PHASE_12_CUSTOMER_CHECKOUT_INTEGRATION` / PR #47.
- Reuses KS-08-06 invoice metadata and ownership checks.
- Does not duplicate `PHASE_12_ACCOUNT_TRANSPORT`; after PR #48 merged, the
  invoice branch composes alongside its Guest Claim code from `main`.

## Acceptance Criteria

- [x] An authenticated mapped owner can request the available synthetic invoice
      from an owned purchase.
- [x] Authorization is repeated in `CustomerInvoiceAccessService` before any
      document provider is invoked.
- [x] Anonymous, unmapped, wrong-owner, unknown, mismatched and unavailable
      resources fail closed without existence disclosure.
- [x] The browser cannot supply invoice IDs, filenames, provider URLs, storage
      keys or paths.
- [x] The bridge request is exact-schema, HMAC authenticated, same-origin and
      CSRF verified.
- [x] The signed bridge response allows only bounded `application/pdf` bytes.
- [x] WordPress serves a fixed safe filename with private/no-store and nosniff
      headers and never exposes a provider redirect or public static file.
- [x] Repeat reads are deterministic and read-only.
- [x] Provider and PostgreSQL outages fail closed with generic responses.
- [x] Tests cover ownership, tampering, malformed content, response bounds,
      secret absence, deterministic repeat access and failure behavior.
- [x] UAT-012 and the invoice step of UAT-018 become technically executable but
      remain human `PENDING` until safe evidence is recorded.

## Exclusions

- Production invoices, VAT/tax certification and accounting providers.
- Live Stripe, Kinguin, procurement or fulfillment.
- Real customers, addresses, invoice records, credentials or Product Keys.
- Human approval of UAT-012, UAT-018, KS-11-07 or `SECURITY-READINESS`.

## Subsequent Human Result

The product owner confirmed UAT-018 `PASS` on 2026-09-01 after the secure
invoice correction. This later human result does not alter the implementation
task's original approval boundary and does not approve KS-11-07,
`SECURITY-READINESS`, production invoices or production release.
