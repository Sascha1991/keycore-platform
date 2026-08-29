# End-to-End Acceptance Suite

## Boundary

KS-11-02 tests the highest complete boundary currently present in KeyCore:
transport-neutral application services, their authority ports and repositories.
The supplemental `E2E-PG-001` scenario uses the real PostgreSQL repositories on
a clean migrated database. The WordPress/WooCommerce layer remains a staging
skeleton, so this suite does not fabricate a browser storefront. Browser and
human workflow acceptance remains KS-11-07.

Real components include pricing locks, order orchestration and history,
`StripePaymentService`, fraud policy/manual review, customer identity and guest
claim, support, invoice access, AES-256-GCM product-key encryption and the
PostgreSQL persistence implementations. Synthetic implementations provide the
payment provider, webhook verifier, trusted authority evidence, captured email
delivery and isolated in-memory repositories where a scenario is not the
PostgreSQL coherence test. Supplier ambiguity is driven through the real
supplier-neutral procurement and reconciliation service with deterministic
synthetic supplier ports. Secure retrieval uses synthetic confirmed evidence
for the supported supplier identifier and a counting retrieval port; no
Kinguin adapter or external network is used.

## Scenarios

| ID         | Name                         | Principal proof                                                                                                                   |
| ---------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| E2E-001    | ACCOUNT_PURCHASE_SUCCESS     | Locked price, idempotent order, verified payment webhook, fraud approval, fulfillment, ownership and encrypted synthetic material |
| E2E-002    | GUEST_PURCHASE_ACCOUNT_CLAIM | Matching verified account plus one-time code; wrong identity/code and replay denied                                               |
| E2E-003    | DELAYED_FULFILLMENT          | Truthful pending state followed by deterministic completion                                                                       |
| E2E-004    | SUPPLIER_FAILURE             | Captured payment preserved with no fabricated fulfillment                                                                         |
| E2E-005    | SUPPLIER_AMBIGUOUS           | One ambiguous dispatch, original-supplier reconciliation, no fallback/re-dispatch, duplicate procurement, fulfillment or key      |
| E2E-006    | PAYMENT_FAILURE              | Verified failure webhook blocks procurement                                                                                       |
| E2E-007    | FRAUD_REVIEW                 | Review blocks, stale evidence fails and current approval clears                                                                   |
| E2E-008    | FRAUD_DENY                   | Policy denial remains fail-closed                                                                                                 |
| E2E-009    | REFUND                       | Provider-neutral refund state and optimistic replay safety                                                                        |
| E2E-010    | SUPPORT                      | Exact-order ownership and trusted structured resolution                                                                           |
| E2E-011    | REPLAY_IDEMPOTENCY           | Checkout and verified payment webhook replay are idempotent                                                                       |
| E2E-012    | EMERGENCY_CONTROLS           | Six real application boundaries deny paused work; unavailable controls fail closed and payment truth still reconciles             |
| E2E-013    | EMAIL_SAFETY                 | Current captured message contract omits key and unsafe fields                                                                     |
| E2E-014    | INVOICE_ACCESS               | Exact owner access and cross-customer denial                                                                                      |
| E2E-015    | LEAKAGE_CANARY               | Synthetic sensitive marker stays outside safe surfaces                                                                            |
| E2E-PG-001 | POSTGRES_COHERENT_PURCHASE   | One migrated PostgreSQL transaction history across order, ownership and support aggregates                                        |

## Isolation And Safety

All identifiers, customer addresses, payment objects and key material are
synthetic. The suite uses an injected clock and deterministic state transitions;
it has no sleeps or external availability dependency. PostgreSQL is ephemeral
in CI. Redis is not needed by these synchronous acceptance paths and remains
covered by the existing queue integration tests; Redis-loss recovery belongs to
KS-11-06.

The synthetic key canary is passed only to the established encryption function.
Assertions inspect safe surfaces without placing the canary in assertion diffs.
The reporter uses an allowlist and refuses protected fulfillment/order IDs,
canary prefixes, credentials, claim material, ciphertext and wrapped keys.

## Evidence

`npm run e2e:acceptance` writes:

- `artifacts/e2e-acceptance/acceptance-evidence.json`
- `artifacts/e2e-acceptance/acceptance-summary.md`

Generated evidence is ignored by Git and uploaded by GitHub Actions as
`ks-11-02-e2e-acceptance-evidence` with 14-day retention. It contains only suite
identity, commit/environment identity, adapter names, stable scenario IDs,
status and duration.

## Known Limits

- Refund coverage ends at the existing provider-neutral order boundary; it does
  not claim a production Stripe refund integration.
- Email coverage validates the current delivery contract, not rendered
  production templates or appearance.
- Invoice coverage validates authorization and metadata, not legal or tax
  approval. `TAX-INVOICE` remains a human gate.
- Supplier failure remains an authoritative order outcome. Supplier ambiguity
  exercises the real procurement/reconciliation application boundary with
  deterministic synthetic ports. Neither calls Kinguin nor claims a sandbox
  procurement campaign.
- The dedicated scale, concurrent replay, security assessment, recovery drill
  and human UAT remain KS-11-03 through KS-11-07.
