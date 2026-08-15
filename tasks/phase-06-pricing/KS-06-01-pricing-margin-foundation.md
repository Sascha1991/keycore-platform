# KS-06-01 - Pricing & Margin Foundation

Risk: HIGH

Human approval: Review/merge required.

## Scope

Build the supplier-neutral foundation that turns eligible acquisition offers into safe customer sell-price quotes behind the existing storefront price boundary.

Included:

- deterministic integer-minor-unit pricing calculations;
- versioned global pricing policy;
- product-specific pricing overrides;
- manual sell-price override subject to hard safety floors;
- explicit FX and tax policy ports;
- known-fee modeling with fail-closed unknown-fee handling;
- deterministic rounding;
- multi-offer safe quote selection;
- durable PostgreSQL policy, override and snapshot persistence;
- safe audit metadata and reference-only recalculation payloads;
- documentation and implementation report.

## Out Of Scope

- admin frontend or public admin HTTP API;
- checkout, payments, procurement, fulfillment or key retrieval;
- GAMIVO;
- live FX provider;
- production VAT/legal assumptions;
- live WooCommerce calls;
- KS-06-02 or later tasks.

## Acceptance Criteria

- Pricing never publishes a quote when policy, cost, fee, FX or tax inputs are missing or unsafe.
- All money math uses integer minor units and avoids floating point business calculations.
- Markup and margin formulas are tested separately.
- Product overrides inherit unspecified global fields.
- Manual prices override business target pricing but cannot bypass hard safety floors.
- Storefront integration returns only customer price or no price.
- PostgreSQL migration is reversible and persists policies, overrides and snapshots.
- Optimistic version conflicts fail safely.
- Queue payloads and audit metadata contain no credentials, product keys, raw supplier payloads or supplier costs.
- A synthetic 50,000-offer pricing evaluation is covered without external HTTP.
- Existing quality gates remain green.
