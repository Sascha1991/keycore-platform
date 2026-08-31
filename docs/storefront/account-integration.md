# KeyRaNo Account Integration

The plugin adds native WooCommerce account endpoints:

- `meine-kaeufe` for owner-filtered purchase history;
- `kauf-details/<OrderId>` for safe status, invoice and activation metadata;
- `kauf-hinzufuegen` for the guest-claim shell.

WordPress authentication supplies presentation context only. The plugin reads a
controlled immutable CustomerId mapping and signs it together with the current
WordPress user ID. The bridge independently checks that pair, creates an
authenticated KeyCore principal and calls `CustomerAccountService`. URL OrderId
values are inputs to the owner-filtered lookup, never authority.

Anonymous users, missing mappings, cross-owner IDs and unknown resources fail
closed. Purchase lists and details contain metadata only and never trigger
decryption.

The guest-claim form intentionally remains non-mutating. Connecting the
one-time, verified-same-email claim handler requires a dedicated browser adapter;
order ID or email alone will not be accepted merely to make the shell functional.
