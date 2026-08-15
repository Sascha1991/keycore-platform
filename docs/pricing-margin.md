# Pricing & Margin Foundation

KS-06-01 introduces supplier-neutral pricing behind the storefront price boundary. Supplier adapters and routing provide eligible acquisition offers; pricing turns those offers into internal `SellPriceQuote` records and exposes only a customer sell price through `StorefrontPriceProvider`.

## Money

Pricing uses `Money` in integer minor units, for example EUR 10.99 as `1099`. Business-critical calculations avoid floating point arithmetic. Currency is explicit on every money value.

## Acquisition Cost

`AcquisitionCostInput` models base supplier price plus known fixed and percentage fees. Pricing does not assume that a supplier offer price is the complete cost. If a required fee is unknown, the quote is blocked with `UNKNOWN_SUPPLIER_FEE`.

## Currency And FX

Same-currency quotes require no FX boundary. Cross-currency quotes require `ExchangeRatePort` with a versioned quote. Missing, invalid or stale FX blocks pricing. KS-06-01 includes deterministic synthetic FX tests only; no live FX provider is implemented.

## Tax Boundary

Tax/VAT is represented by `TaxPolicyPort`. Unknown treatment returns `REVIEW_REQUIRED` and is not treated as zero tax. The fixture tax policy in tests is not legal or tax validation.

Before production, German/EU digital-goods VAT, marketplace/supplier invoice treatment and gross/net assumptions must be validated and configured. Until then, uncertain production tax treatment must fail closed.

## Policy And Overrides

The active global policy uses `pricing-policy-v1` and supports:

- enabled/disabled state;
- markup basis points;
- optional target margin basis points;
- fixed markup;
- minimum absolute profit;
- minimum sell price;
- rounding policy;
- optional quote TTL;
- actor and reason metadata for manual changes.

Product overrides are durable per `ProductId` and selectively override global fields. Omitted fields inherit the active global policy. Product pricing can be disabled independently.

Manual sell price is separate from markup/margin policy. It overrides the target formula but remains subject to known cost, known fees, known tax, currency validity, minimum profit and minimum sell price.

## Precedence

Pricing applies deterministic precedence:

1. hard system, data, currency, fee and tax safety constraints;
2. active product manual sell price;
3. active product pricing overrides;
4. active global pricing policy;
5. no valid configuration means blocked pricing.

Hard safety floors always win over business targets and manual prices.

## Margin, Markup And Rounding

Markup is `(sellPrice - cost) / cost`.

Margin is `(sellPrice - cost) / sellPrice`.

Configured rounding is deterministic. `MINOR_UNIT_UP` leaves integer minor-unit prices unchanged. `PSYCHOLOGICAL_ENDING` rounds upward to the configured minor-unit ending and must never reduce the price below the hard floor.

## Quote Selection

Each eligible offer receives an internal quote. Blocked or review-required quotes are excluded from customer-facing selection. The default selection picks the lowest safe sell price and breaks ties by `OfferId` for deterministic behavior. Supplier identity and acquisition costs are not exposed through the storefront price provider.

## Persistence

Migration `007_pricing_margin_foundation` adds:

- `pricing_policies`;
- `product_pricing_overrides`;
- `product_price_snapshots`.

Repositories use optimistic version checks for manual policy and override changes. Snapshots are idempotent by `(product_id, offer_id, source_fingerprint)` so duplicate recalculation does not create duplicate authoritative explanations.

## Events And Audit

Pricing recalculation payloads contain only safe references: `ProductId`, `CorrelationId` and reason. Configuration changes can request storefront re-evaluation but do not call WooCommerce directly.

Audit events use `PRICING_*` event types and safe metadata such as status, reason code, policy version and price fingerprint. Generic audit metadata must not contain supplier credentials, product keys, raw supplier payloads or supplier acquisition cost details.

## Limitations

- No admin UI or public admin API is implemented.
- No live FX provider is implemented.
- No production VAT configuration is asserted.
- No checkout, payment, procurement, fulfillment, live WooCommerce or GAMIVO behavior is implemented.
