# Controlled Live Procurement

KS-07-03c introduces the first controlled Kinguin live procurement path. It is
critical-risk functionality because it can send a real supplier order mutation.
The path is isolated from normal customer procurement and exists only for a
single human-approved `CONTROLLED_VERIFICATION` purchase.

## Safety Model

Real Kinguin procurement remains disabled by default. A Kinguin API key or
`KEYCORE_ALLOW_KINGUIN_LIVE_READONLY=true` never enables mutation. The live
execution command additionally requires
`KEYCORE_KINGUIN_CONTROLLED_MUTATION_MODE=CONTROLLED_VERIFICATION_ONE_TIME`,
a durable approval ID and the matching one-time execution token.

The normal customer procurement gates remain unchanged: customer procurement
still requires captured payment, approved risk, safe profitability, supplier
routing, execution lease ownership and reconciliation handling. Controlled
verification does not create fake Stripe evidence and does not masquerade as a
customer order.

## Approval Manifest

`controlled_procurement_approvals` stores the durable approval manifest:

- approval ID;
- mode `CONTROLLED_VERIFICATION`;
- supplier `kinguin`;
- exact SupplierProductId and SupplierOfferId;
- quantity `1`;
- exact current acquisition amount and currency;
- maximum acquisition amount and currency;
- purchase request fingerprint;
- generated `orderExternalId`;
- status and dispatch state;
- hashed execution token;
- expiry and lifecycle timestamps.

Approval TTL defaults to `300000` ms, five minutes. Operators may set
`KINGUIN_CONTROLLED_APPROVAL_TTL_MS` explicitly. Expired approvals cannot be
claimed.

## Price And Fingerprint Binding

For the first live verification, the actual supplier price is part of the
request fingerprint. Any price change, even a decrease or an increase still
below the maximum, requires a new approval. The maximum acquisition amount is a
defense-in-depth check and cannot authorize currency substitution.

The fingerprint includes:

- operation version;
- SupplierId;
- SupplierProductId;
- SupplierOfferId;
- quantity;
- currency;
- supplier price minor units;
- `orderExternalId`;
- exact Kinguin order payload identity.

## One-Time Token

Preparation generates a high-entropy one-time execution token and prints it
once. The database stores only `sha256(token)`. The token is never stored in
plaintext, audited, queued, logged or committed.

Execution requires the approval ID and token. Claiming is atomic in PostgreSQL.
At most one caller can move an `APPROVED` and `NOT_DISPATCHED` approval to
`CONSUMED` and `CLAIMED`.

## Dispatch Rule

The service performs final read-only preflight first. If the preflight passes,
it atomically claims the approval, then durably marks `DISPATCH_STARTED`, then
sends `POST /v2/order`.

No PostgreSQL transaction is held across HTTP. If a crash happens after claim,
the approval is not reusable automatically. If a crash or network ambiguity
happens after dispatch, the state is `AMBIGUOUS` and must reconcile.

## Transport

Read-only preparation and reconciliation use GET-only Kinguin access. The
controlled mutation transport exposes only the exact order-create operation:

`POST /v2/order`

It blocks other methods, other paths, key retrieval, key return, webhook
mutation and redirects. POST redirects are not followed or replayed.

The mutation timeout defaults to `10000` ms and can be set through
`KINGUIN_CONTROLLED_ORDER_TIMEOUT_MS`. A timeout after dispatch is ambiguous,
not retryable.

## Commands

Candidate listing is read-only:

```sh
npm run kinguin:list-live-test-candidates
```

Preparation is read-only and requires explicit product and offer IDs:

```sh
npm run kinguin:prepare-live-procurement -- --product-id <id> --offer-id <id> --max-minor <eur-minor-units>
```

The output includes the approval ID, product, offer, quantity, current amount,
maximum amount, currency, request fingerprint, expiry, `orderExternalId`, and
the one-time token. It states `NO PURCHASE HAS BEEN SENT.`

Execution is the only mutating command:

```sh
npm run kinguin:execute-approved-procurement -- <approvalId> <executionToken>
```

This command must be run only after PR review, green CI and explicit human
selection of the exact product, offer and maximum purchase amount.

Reconciliation is read-only:

```sh
npm run kinguin:reconcile-live-procurement -- <approvalId>
```

It never creates an order and never retrieves keys.

## Outcomes

Successful order creation persists `PROCUREMENT_CONFIRMED` with approval ID,
`orderExternalId`, external Kinguin order ID, supplier status, response
fingerprint and timestamp. It then stops.

Definitive supplier rejection persists `PROCUREMENT_REJECTED` and does not
reuse the approval.

Timeout, connection reset, malformed possible-success responses, local
persistence failure after remote success, and crash-after-dispatch scenarios are
`AMBIGUOUS`. KeyCore never resends the POST automatically. Operators reconcile
using documented safe Kinguin lookup by known supplier order ID or
`orderExternalId`; the system does not guess by product, price or timestamp.

## Forbidden Data

Controlled procurement must not store or output:

- API keys;
- raw `X-Api-Key` headers;
- execution tokens after preparation output;
- product keys;
- raw supplier responses;
- customer payment data.

Audit metadata uses only safe references and lifecycle status.
