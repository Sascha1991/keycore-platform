# Human UAT Record - 2026-09-08 - Payment Terminal States

## Recorded Result

The KeyRaNo product owner completed UAT-009 on hosted staging using only
synthetic payment outcomes. This record preserves the supplied browser and
database observations without recording order identifiers, credentials,
Product Keys or other sensitive material.

## Synthetic Failure

The registered-customer checkout using `Synthetische Zahlung (Fehler)` showed:

- `Zahlung fehlgeschlagen`;
- `Es wurde keine Bestellung erfüllt und kein Produktschlüssel bereitgestellt.`;
- `Zurück zum Warenkorb`; and
- no visible `Erneut versuchen` same-order action.

A hard browser refresh preserved the same terminal result. Database verification
of the latest synthetic failed attempt showed `status=FAILED`,
`payment_status=FAILED`, `procurement_status=NOT_STARTED` and
`fulfillment_status=NOT_STARTED`, with zero fulfillment operations and zero
claim challenges.

## Synthetic Cancellation

The separate checkout using `Synthetische Zahlung (Abbruch)` showed:

- `Zahlung abgebrochen`;
- the same explicit no-fulfillment/no-key statement;
- `Zurück zum Warenkorb`; and
- no visible `Erneut versuchen` same-order action.

A hard browser refresh preserved the same terminal result. Database verification
of the latest synthetic cancelled attempt showed `status=CANCELLED`,
`payment_status=CANCELLED`, `procurement_status=NOT_STARTED` and
`fulfillment_status=NOT_STARTED`, with zero fulfillment operations and zero
claim challenges.

The terminal orders remained unfulfilled and created no procurement, Product
Key authority or Guest Claim challenge.

Result: `PASS`.

## Gate Boundaries

- Human `PASS` results: 9 of 18.
- KS-11-07: incomplete; nine scenarios remain pending or not executable.
- Human acceptance: `IN_REVIEW`.
- Human approval: `NOT_APPROVED`.
- `SECURITY-READINESS`: `NOT_APPROVED`.
- Production approval: not granted.
- No real payment, supplier purchase, Product Key, production credential or
  production deployment was used.

The review date is normalized to `2026-09-08T00:00:00Z` in the machine-readable
results.
