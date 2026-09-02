# KeyRaNo Account Integration

The plugin adds native WooCommerce account endpoints:

- `meine-kaeufe` for owner-filtered purchase history;
- `kauf-details/<OrderId>` for safe status, invoice and activation metadata;
- `kauf-hinzufuegen` for the guest-claim shell.

For an owned purchase whose sanitized invoice state is `AVAILABLE` with
`downloadAvailable=true`, the detail page adds `Rechnung herunterladen`. The
POST action uses an order-bound WordPress nonce and exact-origin check. KeyCore
then repeats owner authorization through `CustomerInvoiceAccessService`; the
OrderId is a lookup input and never ownership authority.

The staging response is a deterministic synthetic PDF with a fixed safe
filename. Unavailable, foreign and unknown invoices share the same public
unavailable behavior, while backend outages use a generic temporary failure.
No invoice ID, path, provider URL or Product Key is exposed.

WordPress authentication supplies presentation context only. The plugin reads a
controlled immutable CustomerId mapping and signs it together with the current
WordPress user ID. The bridge independently checks that pair, creates an
authenticated KeyCore principal and calls `CustomerAccountService`. URL OrderId
values are inputs to the owner-filtered lookup, never authority.

Anonymous users, missing mappings, cross-owner IDs and unknown resources fail
closed. Purchase lists and details contain metadata only and never trigger
decryption.

Purchase status labels and the no-purchases state are presentation-only,
account-scoped components. Their explicit dark backgrounds, light text and
purple borders prevent WooCommerce or theme defaults from turning them into
low-contrast light surfaces; status values and empty-state behavior remain
unchanged.

The guest-claim form intentionally remains non-mutating. Connecting the
one-time, verified-same-email claim handler requires a dedicated browser adapter;
order ID or email alone will not be accepted merely to make the shell functional.
